import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, TENANT_B, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * O que a listagem de lançamentos precisa carregar, e por quê.
 *
 * Três telas dependem de campos que a resposta não trazia:
 *
 * - a **fatura** precisa listar os lançamentos dela, com `3/6` na linha;
 * - o **terceiro eixo de filtro** do extrato separa por origem — manual,
 *   parcelado, importado — e nenhum dos três era derivável da resposta;
 * - o **estorno** precisa saber quanto do original ainda resta.
 *
 * Sem esses campos, a interface só teria dois caminhos, e os dois são ruins:
 * inventar a informação, ou fazer uma requisição por linha.
 */

let api: ApiDeTeste
let cartaoId = ''
let contaId = ''
let categoriaId = ''

const COMPRA = '2026-05-12T15:00:00.000Z'
const JANELA = 'de=2026-05-01T03:00:00.000Z&ate=2026-06-01T03:00:00.000Z'

beforeAll(async () => {
  api = await subirApi()

  const cat = await api.banco.cliente.query<{ id: string }>(
    `SELECT id FROM categorias
      WHERE tenant_id = $1 AND nome = 'Sem categoria' AND natureza = 'despesa'`,
    [TENANT_A],
  )
  categoriaId = cat.rows[0]!.id

  const contas = await api.pedir({
    metodo: 'GET',
    url: '/v1/contas',
    usuario: USUARIO_A,
    tenant: TENANT_A,
  })
  contaId = contas.json().itens[0].id

  const cartao = await api.pedir({
    metodo: 'POST',
    url: '/v1/cartoes',
    usuario: USUARIO_A,
    tenant: TENANT_A,
    corpo: {
      nome: 'Cartão da listagem',
      limiteCentavos: '5000000',
      closingDay: 25,
      dueDay: 5,
      contaPagamentoId: contaId,
    },
  })
  cartaoId = cartao.json().id

  await api.pedir({
    metodo: 'POST',
    url: `/v1/cartoes/${cartaoId}/compras`,
    usuario: USUARIO_A,
    tenant: TENANT_A,
    corpo: {
      categoriaId,
      valorCentavos: '-60000',
      postedAt: COMPRA,
      parcelas: 6,
      descricao: 'Bicicleta',
    },
  })

  await api.pedir({
    metodo: 'POST',
    url: `/v1/cartoes/${cartaoId}/compras`,
    usuario: USUARIO_A,
    tenant: TENANT_A,
    corpo: {
      categoriaId,
      valorCentavos: '-4500',
      postedAt: COMPRA,
      descricao: 'Café à vista',
    },
  })

  await api.pedir({
    metodo: 'POST',
    url: '/v1/lancamentos',
    usuario: USUARIO_A,
    tenant: TENANT_A,
    corpo: {
      contaId,
      categoriaId,
      valorCentavos: '-9900',
      postedAt: COMPRA,
      compensado: true,
      descricao: 'Livro',
    },
  })
}, 180_000)

afterAll(async () => {
  await api?.encerrar()
})

const listar = (busca: string) =>
  api.pedir({
    metodo: 'GET',
    url: `/v1/lancamentos?${busca}`,
    usuario: USUARIO_A,
    tenant: TENANT_A,
  })

describe('os campos que faltavam na listagem', () => {
  it('a parcela diz o número e o total, para a linha mostrar "1/6"', async () => {
    const itens = (await listar(JANELA)).json().itens
    const parcela = itens.find((l: { descricao: string }) => l.descricao.startsWith('Bicicleta'))

    expect(parcela).toMatchObject({ installmentNumero: 1, installmentTotal: 6 })
    expect(parcela.installmentGroupId).toEqual(expect.any(String))
  })

  it('o lançamento de conta não finge ser parcela', async () => {
    // Nulo, e não `1/1`: um "1/1" no extrato afirma um parcelamento que não
    // existe, e o usuário procuraria as outras parcelas.
    const itens = (await listar(JANELA)).json().itens
    const livro = itens.find((l: { descricao: string }) => l.descricao === 'Livro')

    expect(livro.installmentGroupId).toBeNull()
    expect(livro.installmentNumero).toBeNull()
    expect(livro.installmentTotal).toBeNull()
  })

  it('o lançamento de cartão aponta o cartão e a fatura', async () => {
    const itens = (await listar(JANELA)).json().itens
    const parcela = itens.find((l: { descricao: string }) => l.descricao.startsWith('Bicicleta'))
    const livro = itens.find((l: { descricao: string }) => l.descricao === 'Livro')

    expect(parcela.cartaoId).toBe(cartaoId)
    expect(parcela.faturaId).toEqual(expect.any(String))
    // Conta e cartão se excluem: `uma_origem_de_dinheiro` é `CHECK` no banco, e
    // a resposta reflete isso em vez de inventar um dos dois.
    expect(parcela.contaId).toBeNull()
    expect(livro.cartaoId).toBeNull()
    expect(livro.faturaId).toBeNull()
  })

  it('a origem distingue o que foi digitado do que veio de outro lugar', async () => {
    // O terceiro eixo de filtro do extrato. `lancamento_origem` tem cinco
    // valores no banco — e **não** são os mesmos de `origem_do_dado`, que é o
    // enum de `contas`. Reusar um tipo para os dois é como o contrato passou a
    // prometer `conectado` num campo onde ele não existe.
    const itens = (await listar(JANELA)).json().itens

    for (const l of itens) {
      expect(['manual', 'importado', 'recorrencia', 'parcelamento', 'ajuste']).toContain(l.origem)
    }
  })

  it('a parcela nasce com origem `parcelamento`, e não `manual`', async () => {
    // Sem isto a coluna existe e não significa nada: o filtro por origem não
    // teria como separar o que foi parcelado, e o usuário veria "parcelado" numa
    // lista que devolve tudo.
    const itens = (await listar(JANELA)).json().itens
    const parcela = itens.find((l: { descricao: string }) => l.descricao.startsWith('Bicicleta'))
    const livro = itens.find((l: { descricao: string }) => l.descricao === 'Livro')

    expect(parcela.origem).toBe('parcelamento')
    expect(livro.origem).toBe('manual')
  })

  it('compra à vista no cartão não é parcelamento', async () => {
    // "1/1" não é parcelamento, e marcar como tal poria compras à vista no
    // filtro de parceladas — onde a pessoa procura compromisso futuro.
    const itens = (await listar(JANELA)).json().itens
    const avista = itens.find((l: { descricao: string }) => l.descricao === 'Café à vista')

    expect(avista.origem).toBe('manual')
    expect(avista.installmentGroupId).toBeNull()
  })
})

describe('listar os lançamentos de uma fatura', () => {
  it('devolve só os daquela fatura, com a numeração da parcela', async () => {
    // A tela de fatura precisa disto. Sem a rota, ela mostraria o total e mais
    // nada — que é exatamente a fatura-como-linha-de-saldo que a direção visual
    // recusa.
    const faturas = await api.pedir({
      metodo: 'GET',
      url: `/v1/cartoes/${cartaoId}/faturas`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })
    const primeira = faturas
      .json()
      .itens.slice()
      .sort((a: { competencia: string }, b: { competencia: string }) =>
        a.competencia < b.competencia ? -1 : 1,
      )[0]

    const r = await listar(`faturaId=${primeira.id}`)

    expect(r.statusCode).toBe(200)
    // A primeira fatura recebe a parcela 1 **e** a compra à vista do mesmo
    // ciclo — que é a composição real de uma fatura, e não uma coisa só.
    expect(r.json().itens).toHaveLength(2)
    expect(r.json().itens).toContainEqual(
      expect.objectContaining({
        descricao: 'Bicicleta 1/6',
        installmentNumero: 1,
        installmentTotal: 6,
        faturaId: primeira.id,
      }),
    )
    expect(r.json().itens).toContainEqual(
      expect.objectContaining({ descricao: 'Café à vista', installmentNumero: null }),
    )
  })

  it('a soma dos lançamentos da fatura é o total dela', async () => {
    // A invariante que a tela exibe lado a lado: se as duas divergirem, o
    // usuário vê uma lista que não fecha com o número em cima dela.
    const faturas = await api.pedir({
      metodo: 'GET',
      url: `/v1/cartoes/${cartaoId}/faturas`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })

    for (const f of faturas.json().itens) {
      const itens = (await listar(`faturaId=${f.id}`)).json().itens
      const soma = itens.reduce(
        (a: bigint, l: { valorCentavos: string }) => a + BigInt(l.valorCentavos),
        0n,
      )
      expect(soma.toString()).toBe(f.totalCentavos)
    }
  })

  it('a fatura de outro tenant devolve lista vazia, não erro', async () => {
    // Vazio e não 404: a rota é de listagem, e o filtro é do tenant. Um 404
    // aqui diria "esta fatura existe em algum lugar".
    const faturas = await api.pedir({
      metodo: 'GET',
      url: `/v1/cartoes/${cartaoId}/faturas`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })
    const alheia = faturas.json().itens[0].id

    const r = await api.pedir({
      metodo: 'GET',
      url: `/v1/lancamentos?faturaId=${alheia}`,
      usuario: USUARIO_B,
      tenant: TENANT_B,
    })

    expect(r.statusCode).toBe(200)
    expect(r.json().itens).toEqual([])
  })

  it('sem `faturaId` a janela continua obrigatória', async () => {
    // O filtro por fatura dispensa a janela porque a fatura **é** a janela.
    // Sem ele, pedir o extrato inteiro sem período traria a base toda.
    const r = await api.pedir({
      metodo: 'GET',
      url: '/v1/lancamentos',
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })

    expect(r.statusCode).toBe(400)
  })
})
