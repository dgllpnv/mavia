import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, TENANT_B, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * Categorização automática contra Postgres real.
 *
 * O que estes testes travam são as duas garantias do glossário — "sempre
 * reversível, sempre com o motivo visível" — e a fronteira que as sustenta: o
 * sistema **nunca** reclassifica o que um humano decidiu.
 */

let api: ApiDeTeste
let conta = ''
let alimentacao = ''
let transporte = ''

const DE = { usuario: USUARIO_A, tenant: TENANT_A }
const pedir = (metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, corpo?: unknown) =>
  api.pedir({ metodo, url, ...DE, ...(corpo === undefined ? {} : { corpo }) })

const ofx = (transacoes: readonly { id: string; valor: string; memo: string }[]) => `
<OFX><CURDEF>BRL<BANKTRANLIST>
${transacoes
  .map(
    (t) => `<STMTTRN><TRNTYPE>${t.valor.startsWith('-') ? 'DEBIT' : 'CREDIT'}
<DTPOSTED>20260610<TRNAMT>${t.valor}<FITID>${t.id}<MEMO>${t.memo}</STMTTRN>`,
  )
  .join('\n')}
</BANKTRANLIST></OFX>`

const importar = (conteudo: string) =>
  pedir('POST', '/v1/importacoes', { contaId: conta, conteudo })

async function doExtrato(descricao: string) {
  const r = await pedir(
    'GET',
    '/v1/lancamentos?de=2026-06-01T00:00:00.000Z&ate=2026-07-01T00:00:00.000Z',
  )
  return r.json().itens.find((l: { descricao: string }) => l.descricao === descricao)
}

const criarCategoria = async (nome: string, natureza: 'despesa' | 'receita') => {
  const r = await pedir('POST', '/v1/categorias', { nome, natureza })
  return r.json().id as string
}

beforeAll(async () => {
  api = await subirApi()

  const contas = await pedir('GET', '/v1/contas')
  conta = contas.json().itens[0].id

  alimentacao = await criarCategoria('Alimentação', 'despesa')
  transporte = await criarCategoria('Transporte', 'despesa')
  // A categoria de receita precisa existir no espaço — a classificação escolhe
  // entre as da natureza certa —, mas nenhum caso deste arquivo referencia o id
  // dela. Guardá-lo numa variável que ninguém lê foi o que o lint encontrou.
  await criarCategoria('Salário', 'receita')
}, 180_000)

afterAll(async () => {
  await api?.encerrar()
})

describe('regra do usuário', () => {
  it('recusa padrão sem nenhuma palavra', async () => {
    // Números e pontuação são ignorados na comparação; um padrão que some é uma
    // regra morta, e criar uma regra morta é pior do que recusar.
    const r = await pedir('POST', '/v1/regras', {
      padrao: '123 456',
      categoriaId: alimentacao,
    })

    expect(r.statusCode).toBe(400)
  })

  it('recusa regra duplicada', async () => {
    expect((await pedir('POST', '/v1/regras', { padrao: 'mercado', categoriaId: alimentacao })).statusCode).toBe(201)
    expect((await pedir('POST', '/v1/regras', { padrao: 'mercado', categoriaId: transporte })).statusCode).toBe(400)
  })

  it('**a importação classifica pela regra, e grava o motivo em português**', async () => {
    await importar(ofx([{ id: 'R1', valor: '-45.00', memo: 'MERCADO SAO JOSE 0912' }]))

    const l = await doExtrato('MERCADO SAO JOSE 0912')

    expect(l.categoriaId).toBe(alimentacao)
    expect(l.classificacaoOrigem).toBe('regra')
    expect(l.classificacaoMotivo).toBe('Pela sua regra: descrição contém "mercado".')
  })

  it('**regra de natureza errada não é aplicada, e o lote não cai**', async () => {
    // Uma regra que manda receita para categoria de despesa faria o gatilho de
    // coerência recusar a linha — e uma regra malfeita derrubaria a importação
    // inteira, que é o oposto do que uma sugestão deveria custar.
    await pedir('POST', '/v1/regras', { padrao: 'salario', categoriaId: alimentacao })

    const r = await importar(ofx([{ id: 'R2', valor: '5000.00', memo: 'SALARIO EMPRESA' }]))

    expect(r.statusCode).toBe(201)
    expect(r.json().criados).toBe(1)

    const l = await doExtrato('SALARIO EMPRESA')
    expect(l.categoriaId).not.toBe(alimentacao)
    expect(l.classificacaoOrigem).toBeNull()
  })
})

describe('histórico do próprio espaço', () => {
  it('**não classifica com uma ocorrência só**', async () => {
    await pedir('POST', '/v1/lancamentos', {
      contaId: conta,
      categoriaId: transporte,
      valorCentavos: '-3000',
      postedAt: '2026-06-01T12:00:00.000Z',
      compensado: true,
      descricao: 'POSTO SHELL AV PAULISTA',
    })

    await importar(ofx([{ id: 'H1', valor: '-40.00', memo: 'POSTO SHELL AV PAULISTA 33' }]))

    const l = await doExtrato('POSTO SHELL AV PAULISTA 33')
    expect(l.classificacaoOrigem).toBeNull()
  })

  it('**com duas, aprende — e diz quantas vezes**', async () => {
    await pedir('POST', '/v1/lancamentos', {
      contaId: conta,
      categoriaId: transporte,
      valorCentavos: '-3500',
      postedAt: '2026-06-02T12:00:00.000Z',
      compensado: true,
      descricao: 'POSTO SHELL AV PAULISTA',
    })

    const r = await pedir('POST', '/v1/regras/aplicar')

    expect(r.statusCode).toBe(200)
    expect(r.json().classificados).toBeGreaterThan(0)

    const l = await doExtrato('POSTO SHELL AV PAULISTA 33')
    expect(l.categoriaId).toBe(transporte)
    expect(l.classificacaoOrigem).toBe('historico')
    expect(l.classificacaoMotivo).toContain('vezes anteriores')
  })

  it('**o sistema não aprende com o próprio palpite**', async () => {
    // Aprender da própria classificação é como um erro vira convicção: uma
    // sugestão errada se confirmaria sozinha na segunda ocorrência.
    await importar(ofx([{ id: 'H2', valor: '-41.00', memo: 'POSTO SHELL AV PAULISTA 44' }]))

    const contagem = await api.banco.cliente.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM lancamentos
        WHERE classificacao_origem = 'historico'
          AND assinatura_da_descricao(descricao) = 'posto shell av paulista'`,
    )

    // As classificadas automaticamente não entram no histórico; se entrassem, o
    // número de "vezes anteriores" cresceria sozinho a cada importação.
    const l = await doExtrato('POSTO SHELL AV PAULISTA 44')
    expect(l.classificacaoMotivo).toBe('Você classificou assim as 2 vezes anteriores.')
    expect(Number(contagem.rows[0]!.n)).toBeGreaterThan(0)
  })
})

describe('reversibilidade', () => {
  it('**trocar a categoria à mão apaga a marca de automático**', async () => {
    // A reversão fica **observável**, e não só possível: o lançamento deixa de
    // constar como classificado por regra porque deixou de ser.
    const l = await doExtrato('MERCADO SAO JOSE 0912')
    expect(l.classificacaoOrigem).toBe('regra')

    const r = await pedir('PATCH', `/v1/lancamentos/${l.id}`, { categoriaId: transporte })

    expect(r.statusCode).toBe(200)

    const depois = await doExtrato('MERCADO SAO JOSE 0912')
    expect(depois.categoriaId).toBe(transporte)
    expect(depois.classificacaoOrigem).toBeNull()
    expect(depois.classificacaoMotivo).toBeNull()
  })

  it('**aplicar não desfaz decisão humana**', async () => {
    // O lançamento acima foi movido para Transporte à mão, e a regra de
    // "mercado" continua apontando para Alimentação. Aplicar de novo não pode
    // trazê-lo de volta.
    await pedir('POST', '/v1/regras/aplicar')

    const depois = await doExtrato('MERCADO SAO JOSE 0912')
    expect(depois.categoriaId).toBe(transporte)
  })

  it('alterar só a descrição preserva a marca', async () => {
    await importar(ofx([{ id: 'REV1', valor: '-9.00', memo: 'MERCADO DA ESQUINA' }]))
    const l = await doExtrato('MERCADO DA ESQUINA')
    expect(l.classificacaoOrigem).toBe('regra')

    await pedir('PATCH', `/v1/lancamentos/${l.id}`, { descricao: 'Mercado da esquina' })

    const depois = await doExtrato('Mercado da esquina')
    expect(depois.classificacaoOrigem).toBe('regra')
  })
})

describe('isolamento e acesso', () => {
  it('a regra de um espaço não aparece no outro', async () => {
    const r = await api.pedir({
      metodo: 'GET',
      url: '/v1/regras',
      usuario: USUARIO_B,
      tenant: TENANT_B,
    })

    expect(r.json().itens).toEqual([])
  })

  it('não altera lançamento de outro espaço', async () => {
    const l = await doExtrato('Mercado da esquina')

    const r = await api.pedir({
      metodo: 'PATCH',
      url: `/v1/lancamentos/${l.id}`,
      usuario: USUARIO_B,
      tenant: TENANT_B,
      corpo: { descricao: 'invadido' },
    })

    expect(r.statusCode).toBe(404)
  })

  it('visualizador lê e não escreve', async () => {
    const { pode } = await import('../src/autorizacao/politica-acesso.js')

    expect(pode({ metodo: 'GET', caminho: '/v1/regras' }, 'visualizador')).toBe(true)
    expect(pode({ metodo: 'POST', caminho: '/v1/regras' }, 'visualizador')).toBe(false)
    expect(pode({ metodo: 'PATCH', caminho: '/v1/lancamentos/:id' }, 'visualizador')).toBe(false)
    expect(pode({ metodo: 'PATCH', caminho: '/v1/lancamentos/:id' }, 'membro')).toBe(true)
  })
})
