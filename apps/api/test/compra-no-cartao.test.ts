import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, TENANT_B, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * Compra no cartão — a rota que faltava.
 *
 * A auditoria do épico 3 achou o buraco: `gerarParcelas` tinha vinte testes de
 * domínio e **nenhum chamador**. Regra testada que ninguém executa não protege
 * ninguém, e o formulário do épico 4 é quem finalmente a exercita.
 *
 * O que estes testes travam: a soma das parcelas bate no centavo, nenhuma
 * fatura recebe duas parcelas do mesmo parcelamento, e a compra não sai do
 * bolso no dia em que é feita.
 */

let api: ApiDeTeste
let cartaoId = ''
let categoriaId = ''

/**
 * 10/03/2026, meio-dia em São Paulo. Cartão fecha 25: mês de fechamento março.
 *
 * Data no **passado**, de propósito. Com data futura o lançamento é `previsto`,
 * e o teste do eixo competência passaria a significar outra coisa no dia em que
 * o relógio cruzasse a data — que é a pior espécie de teste frágil.
 */
const COMPRA = '2026-03-10T15:00:00.000Z'

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

  const r = await api.pedir({
    metodo: 'POST',
    url: '/v1/cartoes',
    usuario: USUARIO_A,
    tenant: TENANT_A,
    corpo: {
      nome: 'Cartão das compras',
      limiteCentavos: '5000000',
      closingDay: 25,
      dueDay: 5,
      contaPagamentoId: contas.json().itens[0].id,
    },
  })
  cartaoId = r.json().id
}, 120_000)

afterAll(async () => {
  await api?.encerrar()
})

function comprar(corpo: Record<string, unknown>, quem = { usuario: USUARIO_A, tenant: TENANT_A }) {
  return api.pedir({
    metodo: 'POST',
    url: `/v1/cartoes/${cartaoId}/compras`,
    usuario: quem.usuario,
    tenant: quem.tenant,
    corpo,
  })
}

describe('compra à vista', () => {
  it('cria uma parcela na fatura da competência, sem grupo de parcelamento', async () => {
    const r = await comprar({
      categoriaId,
      valorCentavos: '-8990',
      postedAt: COMPRA,
      descricao: 'Mercado',
    })

    expect(r.statusCode).toBe(201)
    // Um grupo de uma parcela seria uma linha em `parcelamentos` que não
    // parcela nada — e um "1/1" no extrato que o usuário não pediu.
    expect(r.json().parcelamentoId).toBeNull()
    expect(r.json().itens).toHaveLength(1)
    expect(r.json().itens[0]).toMatchObject({
      numero: 1,
      total: 1,
      valorCentavos: '-8990',
      // Fecha em 25/mar e vence em 05/abr: a **competência** da fatura é abril,
      // porque é o mês em que o usuário paga (`CONTEXT.md`). Março é o mês de
      // fechamento, e os dois nomes distintos existem por causa disto.
      competenciaDaFatura: '2026-04',
    })
  })

  it('abre a fatura que ainda não existia, em vez de recusar a compra', async () => {
    // Ninguém abre fatura à mão: a primeira compra do ciclo é que a cria. O
    // fechamento é lido no fuso do tenant — em UTC daria 26.
    const faturas = await api.pedir({
      metodo: 'GET',
      url: `/v1/cartoes/${cartaoId}/faturas`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })

    expect(faturas.json().itens).toHaveLength(1)
    expect(faturas.json().itens[0]).toMatchObject({
      estado: 'aberta',
      dataFechamento: '2026-03-25',
      dataVencimento: '2026-04-05',
      // O gatilho da 0013 mantém o total da fatura aberta em dia.
      totalCentavos: '-8990',
    })
  })
})

describe('compra parcelada', () => {
  let itens: { valorCentavos: string; faturaId: string; numero: number }[] = []

  it('12x gera 12 parcelas em 12 faturas distintas, somando exatamente o total', async () => {
    // R$ 1.000,00 em 12x não divide: 8333,33… A soma tem de bater no centavo, e
    // nenhuma fatura pode receber duas parcelas (CT-2 da auditoria).
    const r = await comprar({
      categoriaId,
      valorCentavos: '-100000',
      postedAt: COMPRA,
      parcelas: 12,
      descricao: 'Notebook',
    })

    expect(r.statusCode).toBe(201)
    expect(r.json().parcelamentoId).toEqual(expect.any(String))

    itens = r.json().itens
    expect(itens).toHaveLength(12)
    expect(itens.map((i) => i.numero)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(new Set(itens.map((i) => i.faturaId)).size).toBe(12)
  })

  it('a soma das parcelas é exatamente o valor da compra', () => {
    const soma = itens.reduce((a, i) => a + BigInt(i.valorCentavos), 0n)

    expect(soma.toString()).toBe('-100000')
  })

  it('nenhuma parcela difere de outra em mais de um centavo', () => {
    // A soma sozinha não distingue esta regra de "todo o resto na primeira
    // parcela" — que daria uma parcela de R$ 83,41 entre onze de R$ 83,33.
    const magnitudes = itens.map((i) => -BigInt(i.valorCentavos))
    const maior = magnitudes.reduce((a, b) => (b > a ? b : a))
    const menor = magnitudes.reduce((a, b) => (b < a ? b : a))

    expect(maior - menor).toBeLessThanOrEqual(1n)
  })

  it('as faturas são consecutivas a partir da competência da compra', async () => {
    const faturas = await api.pedir({
      metodo: 'GET',
      url: `/v1/cartoes/${cartaoId}/faturas`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })
    const competencias: string[] = faturas
      .json()
      .itens.map((f: { competencia: string }) => f.competencia.slice(0, 7))
      .sort()

    expect(competencias).toHaveLength(12)
    // Fechamentos de março/26 a fevereiro/27; competências de abril a março.
    expect(competencias[0]).toBe('2026-04')
    expect(competencias.at(-1)).toBe('2027-03')
  })
})

/**
 * CT-2 da auditoria, agora pela rota.
 *
 * O bloco acima **não** distingue as duas regras de atribuição: compra no dia
 * 10 num cartão que fecha dia 25 cai na mesma fatura pelos dois caminhos.
 * Trocar a atribuição por construção pela derivação de `postedAt` passava nele
 * inteiro — foi verificado quebrando a implementação de propósito.
 *
 * É preciso o caso que colide: fechamento perto do fim do mês e compra no
 * dia 31. Aí a parcela 1 (31/jan) e a parcela 2 (28/fev) caem ambas na janela
 * de fevereiro, e as doze parcelas terminam em sete faturas — uma cobrando o
 * dobro, outra cobrando nada.
 */
describe('CT-2 — parcelas não colidem quando o cartão fecha perto do fim do mês', () => {
  let cartaoQueFecha30 = ''

  beforeAll(async () => {
    const contas = await api.pedir({
      metodo: 'GET',
      url: '/v1/contas',
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })
    const r = await api.pedir({
      metodo: 'POST',
      url: '/v1/cartoes',
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: {
        nome: 'Cartão que fecha 30',
        limiteCentavos: '5000000',
        closingDay: 30,
        dueDay: 10,
        contaPagamentoId: contas.json().itens[0].id,
      },
    })
    cartaoQueFecha30 = r.json().id
  })

  it('12x comprado em 31/01 ocupa 12 faturas, e não 7', async () => {
    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/cartoes/${cartaoQueFecha30}/compras`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: {
        categoriaId,
        valorCentavos: '-120000',
        // 2025, e não 2026: as doze parcelas deste cartão não podem cair na
        // janela que o teste do eixo competência mede, ou um bloco passaria a
        // depender de o outro ter rodado antes.
        postedAt: '2025-01-31T15:00:00.000Z',
        parcelas: 12,
        descricao: 'Geladeira',
      },
    })

    expect(r.statusCode).toBe(201)
    const itens: { faturaId: string; postedAt: string }[] = r.json().itens
    expect(new Set(itens.map((i) => i.faturaId)).size).toBe(12)
  })

  it('e nenhuma fatura desse cartão cobra duas parcelas da mesma compra', async () => {
    // A verificação pelo outro lado: se a atribuição colidisse, alguma fatura
    // teria total de −R$ 20.000,00 em vez de −R$ 10.000,00.
    const r = await api.banco.cliente.query<{ n: string; total: string }>(
      `SELECT count(*)::text AS n, min(total_centavos)::text AS total
         FROM faturas WHERE tenant_id = $1 AND cartao_id = $2 AND deleted_at IS NULL`,
      [TENANT_A, cartaoQueFecha30],
    )

    expect(r.rows[0]!.n).toBe('12')
    expect(r.rows[0]!.total).toBe('-10000')
  })
})

describe('a compra de cartão não é saída de caixa', () => {
  const janela = 'de=2026-03-01T03:00:00.000Z&ate=2026-04-01T03:00:00.000Z'

  it('não aparece no eixo caixa — o dinheiro sai quando a fatura é paga', async () => {
    // Regra 8b. Se ela aparecesse aqui, o usuário veria o dinheiro sumir no dia
    // da compra e sumir de novo no dia do pagamento da fatura.
    const r = await api.pedir({
      metodo: 'GET',
      url: `/v1/lancamentos/resumo?${janela}&eixo=caixa`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })

    expect(r.json().despesaRealizada).toBe('0')
    expect(r.json().despesaPrevista).toBe('0')
  })

  it('aparece no eixo competência, porque o gasto aconteceu', async () => {
    // R$ 89,90 à vista mais a primeira parcela de R$ 83,34.
    const r = await api.pedir({
      metodo: 'GET',
      url: `/v1/lancamentos/resumo?${janela}&eixo=competencia`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })

    expect(r.json().despesaRealizada).toBe('-17324')
  })
})

describe('o que a rota recusa', () => {
  it('parcelamento indivisível: 400, e não parcela de valor zero', async () => {
    const r = await comprar({
      categoriaId,
      valorCentavos: '-2',
      postedAt: COMPRA,
      parcelas: 3,
      descricao: 'Dois centavos em três',
    })

    expect(r.statusCode).toBe(400)
  })

  it('sinal que discorda da natureza da categoria', async () => {
    const r = await comprar({
      categoriaId,
      valorCentavos: '5000',
      postedAt: COMPRA,
      descricao: 'Despesa positiva',
    })

    expect(r.statusCode).toBe(400)
  })

  it('cartão de outro tenant é 404, e não 403', async () => {
    // 404 de propósito: dizer "existe, mas não é seu" já entrega a existência
    // do cartão de outro cliente.
    const r = await comprar(
      { categoriaId, valorCentavos: '-5000', postedAt: COMPRA, descricao: 'Invasão' },
      { usuario: USUARIO_B, tenant: TENANT_B },
    )

    expect(r.statusCode).toBe(404)
  })

  it('visualizador não compra', async () => {
    const { pode } = await import('../src/autorizacao/politica-acesso.js')

    expect(pode({ metodo: 'POST', caminho: '/v1/cartoes/:id/compras' }, 'visualizador')).toBe(false)
    expect(pode({ metodo: 'POST', caminho: '/v1/cartoes/:id/compras' }, 'membro')).toBe(true)
  })
})

describe('atomicidade', () => {
  it('compra recusada não deixa lançamento nem fatura órfã', async () => {
    // Uma falha na parcela 7 não pode deixar 6 lançamentos e 6 faturas novas —
    // faturas que o usuário veria com valor pela metade.
    const contar = async (tabela: string) => {
      const r = await api.banco.cliente.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${tabela} WHERE tenant_id = $1`,
        [TENANT_A],
      )
      return r.rows[0]!.n
    }
    const antes = [await contar('lancamentos'), await contar('faturas')]

    const r = await comprar({
      categoriaId: '00000000-0000-0000-0000-000000000000',
      valorCentavos: '-60000',
      postedAt: '2029-06-10T15:00:00.000Z',
      parcelas: 6,
      descricao: 'Categoria que não existe',
    })
    expect(r.statusCode).toBeGreaterThanOrEqual(400)

    expect([await contar('lancamentos'), await contar('faturas')]).toEqual(antes)
  })
})
