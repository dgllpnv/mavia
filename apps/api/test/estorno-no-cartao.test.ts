import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, USUARIO_A } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * Estorno de compra no cartão — [ADR 0023](../../../docs/adr/0023-estorno-de-compra-no-cartao.md).
 *
 * A rota `POST /v1/lancamentos/:id/estornos` funcionava para lançamento de
 * conta e devolvia erro para compra de cartão. A causa imediata era banal — o
 * `INSERT` juntava com `contas` para descobrir a moeda, e compra de cartão tem
 * `cartao_id`, não `conta_id`, então o `SELECT` devolvia zero linhas.
 *
 * O que faltava de verdade não era código, era a decisão: **em qual fatura o
 * crédito entra.** O ADR 0023 respondeu — na fatura cuja janela contém o
 * `posted_at` do estorno, que é a regra 10 do `CLAUDE.md` aplicada sem
 * exceção nenhuma. Não há segundo caminho de colocação de lançamento em
 * fatura, e é isso que estes testes travam.
 *
 * As duas propriedades que doem se quebrarem:
 *
 * 1. **`settled_at` nulo.** Quem move o dinheiro de um lançamento de cartão é
 *    o pagamento da fatura, nunca a linha. Um crédito com `settled_at`
 *    preenchido no ato entra no realizado antes de a fatura ser paga — e, se a
 *    fatura for de um mês futuro, no realizado de um mês que não chegou.
 * 2. **Fatura fechada não é reescrita.** O crédito anda para a frente até a
 *    primeira fatura que ainda recebe, pelo mesmo caminho de qualquer compra.
 */

let api: ApiDeTeste
let cartaoId = ''
let categoriaId = ''

/** 10/03/2026. Cartão fecha dia 25 → mês de fechamento março. */
const COMPRA = '2026-03-10T15:00:00.000Z'

/** 12/05/2026 — o reembolso que chega dois meses depois, o caso do ADR. */
const REEMBOLSO_TARDIO = '2026-05-12T15:00:00.000Z'

/** 14/03/2026 — reembolso na mesma janela, o caso comum. */
const REEMBOLSO_NA_JANELA = '2026-03-14T15:00:00.000Z'

/** Magnitude em centavos; o helper aplica o sinal de despesa (regra 6). */
async function comprar(magnitude: string, postedAt: string): Promise<string> {
  const r = await api.pedir({
    metodo: 'POST',
    url: `/v1/cartoes/${cartaoId}/compras`,
    usuario: USUARIO_A,
    tenant: TENANT_A,
    corpo: {
      categoriaId,
      valorCentavos: `-${magnitude}`,
      postedAt,
      descricao: 'Compra',
      parcelas: 1,
    },
  })
  expect(r.statusCode).toBe(201)
  return r.json().itens[0].id
}

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
      nome: 'Cartão dos estornos',
      limiteCentavos: '5000000',
      closingDay: 25,
      dueDay: 5,
      contaPagamentoId: contas.json().itens[0].id,
    },
  })
  cartaoId = r.json().id
}, 120_000)

afterAll(async () => {
  await api.encerrar()
})

describe('estorno de compra no cartão', () => {
  it('**existe** — a rota deixa de recusar compra de cartão', async () => {
    const compra = await comprar('50000', COMPRA)

    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/lancamentos/${compra}/estornos`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { valorCentavos: '50000', postedAt: REEMBOLSO_NA_JANELA, descricao: 'Reembolso' },
    })

    expect(r.statusCode).toBe(201)
  })

  it('**herda a moeda do cartão**, e não de uma conta que não existe', async () => {
    const compra = await comprar('12345', COMPRA)

    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/lancamentos/${compra}/estornos`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { valorCentavos: '12345', postedAt: REEMBOLSO_NA_JANELA },
    })

    expect(r.statusCode).toBe(201)
    expect(r.json().moeda).toBe('BRL')
  })

  it('**nasce com `settled_at` nulo** — quem move o dinheiro é o pagamento da fatura', async () => {
    const compra = await comprar('30000', COMPRA)

    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/lancamentos/${compra}/estornos`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { valorCentavos: '30000', postedAt: REEMBOLSO_NA_JANELA },
    })
    expect(r.statusCode).toBe(201)

    const linha = await api.banco.cliente.query<{ settled_at: Date | null; cartao_id: string }>(
      `SELECT settled_at, cartao_id FROM lancamentos WHERE tenant_id = $1 AND id = $2`,
      [TENANT_A, r.json().id],
    )
    expect(linha.rows[0]!.settled_at).toBeNull()
    expect(linha.rows[0]!.cartao_id).toBe(cartaoId)
  })

  it('**cai na fatura do seu próprio `posted_at`**, não na da compra original', async () => {
    const compra = await comprar('80000', COMPRA)

    const original = await api.banco.cliente.query<{ fatura_id: string }>(
      `SELECT fatura_id FROM lancamentos WHERE tenant_id = $1 AND id = $2`,
      [TENANT_A, compra],
    )

    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/lancamentos/${compra}/estornos`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { valorCentavos: '80000', postedAt: REEMBOLSO_TARDIO },
    })
    expect(r.statusCode).toBe(201)

    const estorno = await api.banco.cliente.query<{ fatura_id: string }>(
      `SELECT fatura_id FROM lancamentos WHERE tenant_id = $1 AND id = $2`,
      [TENANT_A, r.json().id],
    )

    // A propriedade do ADR 0023 D2: a fatura de março é um fato consumado.
    expect(estorno.rows[0]!.fatura_id).not.toBe(original.rows[0]!.fatura_id)

    const competencias = await api.banco.cliente.query<{ competencia: string; id: string }>(
      `SELECT id, to_char(periodo_inicio AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') AS competencia
         FROM faturas WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [TENANT_A, [original.rows[0]!.fatura_id, estorno.rows[0]!.fatura_id]],
    )
    const janelaDo = (id: string) => competencias.rows.find((c) => c.id === id)!.competencia
    // Compra em 10/03 → janela que começa em fevereiro (fecha 25).
    // Reembolso em 12/05 → janela que começa em abril. Duas janelas distintas.
    expect(janelaDo(estorno.rows[0]!.fatura_id) > janelaDo(original.rows[0]!.fatura_id)).toBe(true)
  })

  it('**o caso comum coincide sozinho** — reembolso na mesma janela, mesma fatura', async () => {
    const compra = await comprar('20000', COMPRA)

    const original = await api.banco.cliente.query<{ fatura_id: string }>(
      `SELECT fatura_id FROM lancamentos WHERE tenant_id = $1 AND id = $2`,
      [TENANT_A, compra],
    )

    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/lancamentos/${compra}/estornos`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { valorCentavos: '20000', postedAt: REEMBOLSO_NA_JANELA },
    })
    expect(r.statusCode).toBe(201)

    const estorno = await api.banco.cliente.query<{ fatura_id: string }>(
      `SELECT fatura_id FROM lancamentos WHERE tenant_id = $1 AND id = $2`,
      [TENANT_A, r.json().id],
    )

    // O teste da decisão: quando as duas leituras coincidem, elas coincidem
    // sem regra especial nenhuma. O total da fatura já sai líquido.
    expect(estorno.rows[0]!.fatura_id).toBe(original.rows[0]!.fatura_id)
  })

  it('**tem sinal invertido** — o crédito é positivo contra a despesa negativa', async () => {
    const compra = await comprar('45000', COMPRA)

    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/lancamentos/${compra}/estornos`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { valorCentavos: '45000', postedAt: REEMBOLSO_NA_JANELA },
    })
    expect(r.statusCode).toBe(201)
    expect(BigInt(r.json().valorCentavos)).toBe(45000n)
  })

  it('**o teto continua valendo** — não se estorna mais do que se comprou', async () => {
    const compra = await comprar('10000', COMPRA)

    const primeiro = await api.pedir({
      metodo: 'POST',
      url: `/v1/lancamentos/${compra}/estornos`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { valorCentavos: '6000', postedAt: REEMBOLSO_NA_JANELA },
    })
    expect(primeiro.statusCode).toBe(201)

    const excedente = await api.pedir({
      metodo: 'POST',
      url: `/v1/lancamentos/${compra}/estornos`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { valorCentavos: '5000', postedAt: REEMBOLSO_NA_JANELA },
    })
    // 409, e não 422: é o que a rota já respondia antes deste trabalho, e
    // mudar o contrato de um erro existente não é assunto do ADR 0023.
    expect(excedente.statusCode).toBe(409)
  })

  it('**mantém o vínculo analítico** — é ele que paga a leitura que a decisão adiou', async () => {
    const compra = await comprar('70000', COMPRA)

    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/lancamentos/${compra}/estornos`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { valorCentavos: '70000', postedAt: REEMBOLSO_TARDIO },
    })
    expect(r.statusCode).toBe(201)

    const linha = await api.banco.cliente.query<{ estorno_de_lancamento_id: string }>(
      `SELECT estorno_de_lancamento_id FROM lancamentos WHERE tenant_id = $1 AND id = $2`,
      [TENANT_A, r.json().id],
    )
    expect(linha.rows[0]!.estorno_de_lancamento_id).toBe(compra)
  })

  it('**recusa crédito anterior à compra** — não descreve nada real (ADR 0023 D6)', async () => {
    const compra = await comprar('15000', COMPRA)

    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/lancamentos/${compra}/estornos`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { valorCentavos: '15000', postedAt: '2026-03-01T15:00:00.000Z' },
    })

    expect(r.statusCode).toBe(400)
  })
})

describe('estorno de lançamento de conta — o que não pode ter regredido', () => {
  it('continua com `settled_at` preenchido, porque ali o dinheiro voltou mesmo', async () => {
    const contas = await api.pedir({
      metodo: 'GET',
      url: '/v1/contas',
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })

    const despesa = await api.pedir({
      metodo: 'POST',
      url: '/v1/lancamentos',
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: {
        contaId: contas.json().itens[0].id,
        categoriaId,
        valorCentavos: '-9000',
        postedAt: COMPRA,
        settledAt: COMPRA,
        descricao: 'Despesa na conta',
      },
    })
    expect(despesa.statusCode).toBe(201)

    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/lancamentos/${despesa.json().id}/estornos`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { valorCentavos: '9000', postedAt: REEMBOLSO_NA_JANELA },
    })
    expect(r.statusCode).toBe(201)

    const linha = await api.banco.cliente.query<{ settled_at: Date | null; fatura_id: string }>(
      `SELECT settled_at, fatura_id FROM lancamentos WHERE tenant_id = $1 AND id = $2`,
      [TENANT_A, r.json().id],
    )
    expect(linha.rows[0]!.settled_at).not.toBeNull()
    expect(linha.rows[0]!.fatura_id).toBeNull()
  })
})
