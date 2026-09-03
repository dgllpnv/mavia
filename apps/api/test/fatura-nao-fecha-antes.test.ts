import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, USUARIO_A } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * Uma fatura não fecha antes da data de fechamento, e um pagamento não
 * antecede as compras que ele paga.
 *
 * **Como isto foi descoberto:** clicando em "fechar a fatura" na tela, num dia
 * 2, numa fatura que fecha dia 25 e já continha compras dos dias 12 e 14. O
 * fechamento passou. O pagamento em seguida devolveu 500 — o banco recusou
 * `settled_at < posted_at` pela restrição `compensacao_nao_antecede_competencia`,
 * que é a que impede compensar antes de acontecer.
 *
 * A restrição estava certa. O que faltava era a regra acima dela: **quem
 * fecha uma fatura é o calendário, não o usuário.** Fechar antes da data cria
 * uma fatura que já contém compras posteriores ao próprio fechamento, e empurra
 * para o mês seguinte todas as compras que ainda cairiam no ciclo — em silêncio.
 */

let api: ApiDeTeste
let cartaoId = ''
let categoriaId = ''
let contaId = ''

const COMPRA_PASSADA = '2026-06-10T15:00:00.000Z'

/** Um ciclo que ainda não fechou na data de hoje (2026-09-02). */
const CICLO_FUTURO = { ano: 2026, mes: 12 }

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
      nome: 'Cartão do fechamento',
      limiteCentavos: '5000000',
      closingDay: 25,
      dueDay: 5,
      contaPagamentoId: contaId,
    },
  })
  cartaoId = cartao.json().id
}, 180_000)

afterAll(async () => {
  await api?.encerrar()
})

const comprar = (corpo: Record<string, unknown>) =>
  api.pedir({
    metodo: 'POST',
    url: `/v1/cartoes/${cartaoId}/compras`,
    usuario: USUARIO_A,
    tenant: TENANT_A,
    corpo: { categoriaId, ...corpo },
  })

const abrirFatura = (competencia: { ano: number; mes: number }) =>
  api.pedir({
    metodo: 'POST',
    url: `/v1/cartoes/${cartaoId}/faturas`,
    usuario: USUARIO_A,
    tenant: TENANT_A,
    corpo: competencia,
  })

const fechar = (faturaId: string) =>
  api.pedir({
    metodo: 'POST',
    url: `/v1/cartoes/faturas/${faturaId}/fechar`,
    usuario: USUARIO_A,
    tenant: TENANT_A,
  })

describe('fechar antes da data', () => {
  it('recusa, com 409 e uma frase que diz quando ela fecha', async () => {
    const fatura = await abrirFatura(CICLO_FUTURO)
    expect(fatura.statusCode).toBe(201)

    const r = await fechar(fatura.json().id)

    expect(r.statusCode).toBe(409)
    expect(String(r.json().message)).toMatch(/ainda não fechou|fecha em/i)
  })

  it('a fatura continua aberta e continua recebendo compra', async () => {
    // A consequência de fechar cedo que ninguém veria: as compras seguintes do
    // ciclo seriam empurradas para o mês seguinte, em silêncio.
    const faturas = await api.pedir({
      metodo: 'GET',
      url: `/v1/cartoes/${cartaoId}/faturas`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })
    const dezembro = faturas
      .json()
      .itens.find((f: { competencia: string }) => f.competencia.startsWith('2027-01'))

    expect(dezembro?.estado).toBe('aberta')
  })
})

describe('fechar no dia ou depois', () => {
  let faturaId = ''

  it('fecha e trava o total', async () => {
    const compra = await comprar({
      valorCentavos: '-31500',
      postedAt: COMPRA_PASSADA,
      descricao: 'Compra de junho',
    })
    expect(compra.statusCode).toBe(201)
    faturaId = compra.json().itens[0].faturaId

    const r = await fechar(faturaId)

    expect(r.statusCode).toBe(200)
    expect(r.json().totalCentavos).toBe('-31500')
  })

  it('o pagamento anterior à compra é recusado com nome, e não com 500', async () => {
    // O caso residual: mesmo com o fechamento na data certa, alguém pode
    // informar uma data de pagamento anterior a uma compra do ciclo. Antes, o
    // banco devolvia violação de restrição e a API traduzia para 500.
    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/cartoes/faturas/${faturaId}/pagamentos`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: {
        valorCentavos: '31500',
        // Antes da compra, que é de 10/06.
        pagoEm: '2026-06-01T15:00:00.000Z',
        contaId,
      },
    })

    expect(r.statusCode).toBe(400)
    expect(String(r.json().message)).toMatch(/antes|anterior/i)
  })

  it('o pagamento posterior à compra é aceito e quita a fatura', async () => {
    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/cartoes/faturas/${faturaId}/pagamentos`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { valorCentavos: '31500', pagoEm: '2026-07-05T15:00:00.000Z', contaId },
    })

    expect(r.statusCode).toBe(201)
    expect(r.json().estado).toBe('paga')
  })

  it('o pagamento é transferência: não entra na despesa do mês', async () => {
    // A regra 12 atravessando a pilha. As compras já entraram na soma do mês em
    // que aconteceram; contar o pagamento como gasto contaria duas vezes.
    const r = await api.pedir({
      metodo: 'GET',
      url: '/v1/lancamentos/resumo?de=2026-07-01T03:00:00.000Z&ate=2026-08-01T03:00:00.000Z&eixo=competencia',
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })

    expect(r.json().despesaRealizada).toBe('0')
    expect(r.json().despesaPrevista).toBe('0')
    // Ele aparece na linha própria, neutra, e as duas pernas se anulam.
    expect(r.json().transferenciaLiquidaRealizada).toBe('0')
  })
})
