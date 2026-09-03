import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, TENANT_B, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * Recorrencia contra Postgres real.
 *
 * O que estes testes travam é a idempotência da materialização — a propriedade
 * que permite chamar o materializador quantas vezes for — e o par de regras que
 * a edição precisa respeitar: **reposiciona o futuro, não reescreve o passado**.
 */

let api: ApiDeTeste
let conta = ''
let cartao = ''
let despesa = ''
let receita = ''
let ajusteDeSaldo = ''

const DE = { usuario: USUARIO_A, tenant: TENANT_A }

const pedir = (metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, corpo?: unknown) =>
  api.pedir({ metodo, url, ...DE, ...(corpo === undefined ? {} : { corpo }) })

/** A competência de hoje, apurada pelo servidor. */
const competenciaAtual = () => new Date().toISOString().slice(0, 7)

beforeAll(async () => {
  api = await subirApi()

  const contas = await pedir('GET', '/v1/contas')
  conta = contas.json().itens[0].id

  const cats = (await pedir('GET', '/v1/categorias')).json().itens
  despesa = cats.find((c: { natureza: string; analitica: boolean }) => c.natureza === 'despesa' && c.analitica).id
  receita = cats.find((c: { natureza: string; analitica: boolean }) => c.natureza === 'receita' && c.analitica).id
  ajusteDeSaldo = cats.find(
    (c: { nome: string; natureza: string }) => c.nome === 'Ajuste de saldo' && c.natureza === 'despesa',
  ).id

  const c = await pedir('POST', '/v1/cartoes', {
    nome: 'Cartão da assinatura',
    closingDay: 20,
    dueDay: 28,
    contaPagamentoId: conta,
  })
  cartao = c.json().id
}, 180_000)

afterAll(async () => {
  await api?.encerrar()
})

const criar = (corpo: Record<string, unknown>) =>
  pedir('POST', '/v1/recorrencias', {
    contaId: conta,
    categoriaId: despesa,
    valorCentavos: '-150000',
    descricao: 'Aluguel',
    diaDoMes: 10,
    inicio: competenciaAtual(),
    ...corpo,
  })

describe('criar e materializar', () => {
  it('doze meses à frente, um lançamento por mês', async () => {
    const r = await criar({ descricao: 'Aluguel do teste' })

    expect(r.statusCode).toBe(201)
    // Do mês corrente ao mesmo mês do ano seguinte: 13 competências.
    expect(r.json().materializadas).toBe(13)
    expect(r.json().proximaOcorrencia).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('**materializar de novo não duplica nada**', async () => {
    // A identidade da ocorrência é `(tenant, recorrencia, competência)`, e o
    // índice único é quem a garante. Sem ela, cada chamada do job somaria mais
    // um aluguel a cada mês do horizonte.
    const antes = (await pedir('GET', '/v1/recorrencias')).json().itens
    const total = antes.reduce((s: number, r: { materializadas: number }) => s + r.materializadas, 0)

    const r = await pedir('POST', '/v1/recorrencias/materializar')

    expect(r.statusCode).toBe(200)
    expect(r.json().criadas).toBe(0)

    const depois = (await pedir('GET', '/v1/recorrencias')).json().itens
    expect(depois.reduce((s: number, r: { materializadas: number }) => s + r.materializadas, 0)).toBe(total)
  })

  it('**nunca materializa o passado**', async () => {
    // Uma regra que começa há um ano, criada hoje, não inventa doze lançamentos
    // que a pessoa nunca teve.
    const hoje = new Date()
    const anoPassado = `${hoje.getUTCFullYear() - 1}-${String(hoje.getUTCMonth() + 1).padStart(2, '0')}`

    const r = await criar({ descricao: 'Começou ano passado', inicio: anoPassado })

    expect(r.json().materializadas).toBe(13)
  })

  it('a ocorrência nasce pendente: `settled_at` só é escrito quando o dinheiro se move', async () => {
    const r = await criar({ descricao: 'Pendente por natureza' })
    const id = r.json().id

    const janela = new Date()
    const lancamentos = await pedir(
      'GET',
      `/v1/lancamentos?de=${new Date(janela.getFullYear(), janela.getMonth(), 1).toISOString()}` +
        `&ate=${new Date(janela.getFullYear(), janela.getMonth() + 2, 1).toISOString()}`,
    )
    const daRegra = lancamentos
      .json()
      .itens.filter((l: { descricao: string }) => l.descricao === 'Pendente por natureza')

    expect(daRegra.length).toBeGreaterThan(0)
    for (const l of daRegra) expect(l.settledAt).toBeNull()
    expect(id).toBeTruthy()
  })

  it('recusa sinal em desacordo com a natureza da categoria', async () => {
    const r = await criar({ categoriaId: receita, valorCentavos: '-1000' })

    expect(r.statusCode).toBe(400)
  })

  it('recusa categoria não analítica', async () => {
    const r = await criar({ categoriaId: ajusteDeSaldo })

    expect(r.statusCode).toBe(400)
  })

  it('recusa conta e cartão ao mesmo tempo', async () => {
    const r = await criar({ cartaoId: cartao })

    expect(r.statusCode).toBe(400)
  })
})

describe('assinatura no cartão', () => {
  it('**entra pela mesma porta da compra, e cai na fatura certa**', async () => {
    // Um segundo caminho de inserção teria de reimplementar a escolha da
    // fatura, e é justamente essa escolha que erra em silêncio.
    const r = await pedir('POST', '/v1/recorrencias', {
      cartaoId: cartao,
      categoriaId: despesa,
      valorCentavos: '-4990',
      descricao: 'Assinatura',
      diaDoMes: 5,
      inicio: competenciaAtual(),
    })

    expect(r.statusCode).toBe(201)
    expect(r.json().materializadas).toBe(13)
    expect(r.json().contaId).toBeNull()

    const faturas = await pedir('GET', `/v1/cartoes/${cartao}/faturas`)
    expect(faturas.json().itens.length).toBeGreaterThan(0)
  })

  it('recorrência de receita no cartão é recusada', async () => {
    // Cartão registra dívida. Uma receita ali não é um fato possível.
    const r = await pedir('POST', '/v1/recorrencias', {
      cartaoId: cartao,
      categoriaId: receita,
      valorCentavos: '100000',
      descricao: 'Salário no cartão',
      diaDoMes: 5,
      inicio: competenciaAtual(),
    })

    expect(r.statusCode).toBe(400)
  })
})

describe('editar a regra', () => {
  let id = ''

  beforeAll(async () => {
    const r = await criar({ descricao: 'Vai mudar', diaDoMes: 15 })
    id = r.json().id
  })

  it('mudar o dia reposiciona as ocorrências futuras sem duplicá-las', async () => {
    const antes = (await pedir('GET', '/v1/recorrencias')).json().itens.find(
      (r: { id: string }) => r.id === id,
    ).materializadas

    const r = await pedir('PATCH', `/v1/recorrencias/${id}`, { diaDoMes: 25 })

    expect(r.statusCode).toBe(200)
    expect(r.json().diaDoMes).toBe(25)
    // O mesmo número de ocorrências: a competência é a identidade, e ela não
    // mudou. Com a data na chave, cada mês teria ganhado uma segunda linha.
    expect(r.json().materializadas).toBe(antes)
  })

  it('pausar para de produzir, e o que existe fica', async () => {
    const antes = (await pedir('GET', '/v1/recorrencias')).json().itens.find(
      (r: { id: string }) => r.id === id,
    ).materializadas

    const r = await pedir('PATCH', `/v1/recorrencias/${id}`, { pausada: true })

    expect(r.json().pausada).toBe(true)
    // Pausada não anuncia próxima ocorrência: dizer uma data ao lado de
    // "pausada" seria a tela se contradizendo.
    expect(r.json().proximaOcorrencia).toBeNull()
    // O futuro pendente foi retirado; o que sobra é o mês corrente, que já
    // aconteceu ou está acontecendo.
    expect(r.json().materializadas).toBeLessThan(antes)
  })

  it('despausar volta a produzir', async () => {
    const r = await pedir('PATCH', `/v1/recorrencias/${id}`, { pausada: false })

    expect(r.json().pausada).toBe(false)
    expect(r.json().proximaOcorrencia).not.toBeNull()
    expect(r.json().materializadas).toBe(13)
  })

  it('encerrar com `fim` para no mês certo', async () => {
    const hoje = new Date()
    const daquiADois = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() + 2, 1))
    const fim = daquiADois.toISOString().slice(0, 7)

    const r = await pedir('PATCH', `/v1/recorrencias/${id}`, { fim })

    expect(r.json().fim).toBe(fim)
    // Mês corrente + 2 = três competências.
    expect(r.json().materializadas).toBe(3)
  })
})

describe('excluir', () => {
  const doMesCorrente = () => {
    const hoje = new Date()
    return {
      de: new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 1)).toISOString(),
      ate: new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() + 1, 1)).toISOString(),
    }
  }

  const noExtrato = async (descricao: string) => {
    const { de, ate } = doMesCorrente()
    const r = await pedir('GET', `/v1/lancamentos?de=${de}&ate=${ate}`)
    return r.json().itens.filter((l: { descricao: string }) => l.descricao === descricao)
  }

  it('**apaga o futuro pendente e preserva o que já aconteceu**', async () => {
    // Dia 1: a ocorrência deste mês tem `posted_at` no passado. É fato — a
    // pessoa pode já tê-lo conciliado —, e apagá-lo por causa de uma exclusão
    // de regra faria o extrato mentir sobre um mês que ela já leu.
    const criada = await criar({ descricao: 'Some a regra, fica o fato', diaDoMes: 1 })
    const id = criada.json().id

    expect(await noExtrato('Some a regra, fica o fato')).toHaveLength(1)

    expect((await pedir('DELETE', `/v1/recorrencias/${id}`)).statusCode).toBe(204)

    const itens = (await pedir('GET', '/v1/recorrencias')).json().itens
    expect(itens.find((r: { id: string }) => r.id === id)).toBeUndefined()

    // A ocorrência do dia 1 continua lá. As doze futuras, não.
    expect(await noExtrato('Some a regra, fica o fato')).toHaveLength(1)
  })
})

describe('isolamento e acesso', () => {
  it('a recorrência de um espaço não aparece no outro', async () => {
    const r = await api.pedir({
      metodo: 'GET',
      url: '/v1/recorrencias',
      usuario: USUARIO_B,
      tenant: TENANT_B,
    })

    expect(r.statusCode).toBe(200)
    expect(r.json().itens).toEqual([])
  })

  it('visualizador lê e não escreve', async () => {
    const { pode } = await import('../src/autorizacao/politica-acesso.js')

    expect(pode({ metodo: 'GET', caminho: '/v1/recorrencias' }, 'visualizador')).toBe(true)
    expect(pode({ metodo: 'POST', caminho: '/v1/recorrencias' }, 'visualizador')).toBe(false)
    expect(pode({ metodo: 'POST', caminho: '/v1/recorrencias/materializar' }, 'membro')).toBe(true)
  })
})
