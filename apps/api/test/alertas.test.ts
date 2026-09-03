import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, TENANT_B, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * A central de alertas.
 *
 * O que estes testes travam é a propriedade que justifica não haver tabela de
 * notificações: **resolver a causa faz o aviso sumir**. Um alerta armazenado
 * sobreviveria ao estorno que desestourou o teto, e um aviso que mente sobre o
 * estado é pior do que aviso nenhum.
 */

let api: ApiDeTeste
let conta = ''
let despesa = ''

const DE = { usuario: USUARIO_A, tenant: TENANT_A }
const pedir = (metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, corpo?: unknown) =>
  api.pedir({ metodo, url, ...DE, ...(corpo === undefined ? {} : { corpo }) })

const competenciaAtual = () => new Date().toISOString().slice(0, 7)

const alertas = async () => (await pedir('GET', '/v1/alertas')).json().itens as {
  tipo: string
  severidade: string
  titulo: string
  chave: string
}[]

beforeAll(async () => {
  api = await subirApi()

  const c = await pedir('POST', '/v1/contas', {
    nome: 'Conta dos alertas',
    tipo: 'corrente',
    saldoInicialCentavos: '0',
  })
  conta = c.json().id

  const cats = (await pedir('GET', '/v1/categorias')).json().itens
  despesa = cats.find(
    (x: { natureza: string; analitica: boolean }) => x.natureza === 'despesa' && x.analitica,
  ).id
}, 180_000)

afterAll(async () => {
  await api?.encerrar()
})

describe('teto', () => {
  let planejamento = ''

  it('não alerta enquanto o consumo está abaixo do limiar', async () => {
    const r = await pedir('POST', '/v1/planejamentos', {
      competencia: competenciaAtual(),
      categoriaId: despesa,
      valorCentavos: '-100000',
      alertasPercentuais: [80, 100],
    })
    planejamento = r.json().id

    expect(r.statusCode).toBe(201)
    const chaves = (await alertas()).map((a) => a.chave)
    expect(chaves.some((k) => k.startsWith(`teto:${planejamento}`))).toBe(false)
  })

  it('alerta ao cruzar 80%, e **só no maior limiar cruzado**', async () => {
    // Anunciar 80% e 100% do mesmo teto no mesmo instante são duas linhas
    // dizendo a mesma coisa.
    await pedir('POST', '/v1/lancamentos', {
      contaId: conta,
      categoriaId: despesa,
      valorCentavos: '-85000',
      postedAt: new Date().toISOString(),
      compensado: true,
      descricao: 'Consome o teto',
    })

    const doTeto = (await alertas()).filter((a) => a.chave.startsWith(`teto:${planejamento}`))

    expect(doTeto).toHaveLength(1)
    expect(doTeto[0]?.chave).toBe(`teto:${planejamento}:80`)
    expect(doTeto[0]?.severidade).toBe('atencao')
  })

  it('estourar o teto vira urgente', async () => {
    await pedir('POST', '/v1/lancamentos', {
      contaId: conta,
      categoriaId: despesa,
      valorCentavos: '-30000',
      postedAt: new Date().toISOString(),
      compensado: true,
      descricao: 'Estoura o teto',
    })

    const doTeto = (await alertas()).filter((a) => a.chave.startsWith(`teto:${planejamento}`))

    expect(doTeto).toHaveLength(1)
    expect(doTeto[0]?.chave).toBe(`teto:${planejamento}:100`)
    expect(doTeto[0]?.severidade).toBe('urgente')
  })

  it('**subir o teto faz o alerta sumir na hora**', async () => {
    // A propriedade que dispensa a tabela: o alerta é derivado, e some quando a
    // causa some. Armazenado, ele sobreviveria à correção.
    await pedir('PATCH', `/v1/planejamentos/${planejamento}`, { valorCentavos: '-500000' })

    const doTeto = (await alertas()).filter((a) => a.chave.startsWith(`teto:${planejamento}`))

    expect(doTeto).toHaveLength(0)
  })
})

describe('atraso', () => {
  it('lançamento com data passada e sem compensação é urgente', async () => {
    await pedir('POST', '/v1/lancamentos', {
      contaId: conta,
      categoriaId: despesa,
      valorCentavos: '-4200',
      postedAt: '2025-01-10T12:00:00.000Z',
      compensado: false,
      descricao: 'Ficou para trás',
    })

    const atraso = (await alertas()).find((a) => a.tipo === 'lancamento_em_atraso')

    expect(atraso).toBeDefined()
    expect(atraso?.severidade).toBe('urgente')
  })
})

describe('objetivo', () => {
  it('objetivo concluído é informação, não urgência', async () => {
    // Uma boa notícia não pode entrar na mesma fila do que está pegando fogo.
    const r = await pedir('POST', '/v1/objetivos', {
      nome: 'Já nasce feito',
      valorAlvoCentavos: '100',
      contaId: conta,
      saldoBaseCentavos: '-100000000',
    })
    expect(r.statusCode).toBe(201)

    const doObjetivo = (await alertas()).find((a) => a.tipo === 'objetivo_concluido')

    expect(doObjetivo).toBeDefined()
    expect(doObjetivo?.severidade).toBe('informacao')
  })
})

describe('ordem e isolamento', () => {
  it('urgente vem primeiro', async () => {
    const itens = await alertas()
    const peso = { urgente: 0, atencao: 1, informacao: 2 } as const

    const pesos = itens.map((a) => peso[a.severidade as keyof typeof peso])
    expect(pesos).toEqual([...pesos].sort((a, b) => a - b))
  })

  it('o alerta de um espaço não aparece no outro', async () => {
    const r = await api.pedir({
      metodo: 'GET',
      url: '/v1/alertas',
      usuario: USUARIO_B,
      tenant: TENANT_B,
    })

    expect(r.statusCode).toBe(200)
    expect(r.json().itens).toEqual([])
  })

  it('visualizador lê alertas', async () => {
    const { pode } = await import('../src/autorizacao/politica-acesso.js')

    expect(pode({ metodo: 'GET', caminho: '/v1/alertas' }, 'visualizador')).toBe(true)
  })
})
