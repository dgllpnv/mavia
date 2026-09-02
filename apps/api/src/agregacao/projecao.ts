import { dinheiro, type Moeda, type Money } from '@mavia/domain'
import type { PoolClient } from 'pg'

/**
 * Projeção do eixo caixa — "quanto haverá na conta".
 *
 * Soma **duas** fontes, e nenhuma delas é lançamento de cartão:
 *
 * 1. Lançamentos de `Conta` — realizados por `settled_at`, futuros por
 *    `posted_at`.
 * 2. `Fatura`s não pagas, pelo **saldo devedor**, na data de vencimento,
 *    debitando a conta que as paga.
 *
 * Uma compra de cartão não tira dinheiro de conta nenhuma; quem tira é a
 * fatura. Projetar por lançamento de cartão seria mais caro e **errado**: o
 * lançamento não tem `conta_id`, exigiria um segundo salto pelo cartão, e daria
 * a conta errada sempre que a fatura fosse paga por outra (ADR 0007).
 */

export interface FiltroDeProjecao {
  readonly tenantId: string
  readonly ate: Date
  readonly contaId?: string
  readonly moeda: Moeda
}

/**
 * A fatura contribui com **`total + pago`**, não com o total.
 *
 * O total é negativo (é dívida) e o pago é positivo, então a soma é o que
 * ainda falta sair. Usar o total faria um pagamento parcial de R$ 60,00 numa
 * fatura de R$ 100,00 continuar projetando os R$ 100,00 inteiros — a parte já
 * paga contada duas vezes: uma na perna de débito que já saiu da conta, outra
 * na fatura.
 *
 * Quando a fatura é quitada, `total + pago` chega a zero e ela sai da projeção
 * sozinha — no mesmo instante em que a perna de débito passa a representá-la.
 * É a invariante que impede a dupla contagem, e ela decorre da aritmética em
 * vez de depender de um `if` sobre o estado.
 */
const SQL_PROJECAO = `
  SELECT (
    -- 1. O que já se moveu, mais o saldo inicial das contas no escopo.
    coalesce((SELECT sum(c.saldo_inicial_centavos) FROM contas c
               WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
                 AND ($3::uuid IS NULL OR c.id = $3)), 0)
    +
    coalesce((SELECT sum(l.valor_centavos) FROM lancamentos l
               WHERE l.tenant_id = $1 AND l.deleted_at IS NULL
                 AND l.conta_id IS NOT NULL
                 AND l.settled_at IS NOT NULL
                 AND ($3::uuid IS NULL OR l.conta_id = $3)), 0)
    +
    -- 2. O que ainda vai se mover até a data: agendados de conta.
    coalesce((SELECT sum(l.valor_centavos) FROM lancamentos l
               WHERE l.tenant_id = $1 AND l.deleted_at IS NULL
                 AND l.conta_id IS NOT NULL
                 AND l.settled_at IS NULL
                 AND l.posted_at <= $2
                 AND ($3::uuid IS NULL OR l.conta_id = $3)), 0)
    +
    -- 3. As faturas que vencem até a data, pelo saldo devedor.
    coalesce((SELECT sum(f.total_centavos + f.pago_centavos) FROM faturas f
               WHERE f.tenant_id = $1 AND f.deleted_at IS NULL
                 AND f.estado <> 'paga'
                 AND f.data_vencimento <= $2::date
                 AND ($3::uuid IS NULL OR f.conta_pagamento_id = $3)), 0)
  )::text AS projetado
`

export async function projetarCaixa(
  cliente: PoolClient,
  filtro: FiltroDeProjecao,
): Promise<Money> {
  const r = await cliente.query<{ projetado: string }>(SQL_PROJECAO, [
    filtro.tenantId,
    filtro.ate,
    filtro.contaId ?? null,
  ])
  return dinheiro(BigInt(r.rows[0]?.projetado ?? '0'), filtro.moeda)
}

/**
 * Saldo geral: soma as contas marcadas para entrar, e **desconta as faturas em
 * aberto** que elas pagam.
 *
 * O cartão não tem saldo para incluir — ele acumula dívida. A dívida aparece
 * aqui, na conta que vai pagá-la, que é onde ela de fato vai doer.
 */
export async function saldoGeralDoTenant(
  cliente: PoolClient,
  tenantId: string,
  moeda: Moeda,
): Promise<{ saldo: Money; faturasEmAberto: Money }> {
  const r = await cliente.query<{ saldo: string; faturas: string }>(
    `SELECT
       coalesce((SELECT sum(c.saldo_inicial_centavos
                            + coalesce((SELECT sum(l.valor_centavos) FROM lancamentos l
                                         WHERE l.conta_id = c.id AND l.tenant_id = c.tenant_id
                                           AND l.deleted_at IS NULL AND l.settled_at IS NOT NULL), 0))
                  FROM contas c
                 WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
                   AND c.incluir_no_saldo_geral), 0)::text AS saldo,
       coalesce((SELECT sum(f.total_centavos + f.pago_centavos) FROM faturas f
                  JOIN contas c ON c.id = f.conta_pagamento_id AND c.tenant_id = f.tenant_id
                 WHERE f.tenant_id = $1 AND f.deleted_at IS NULL
                   AND f.estado <> 'paga'
                   AND c.incluir_no_saldo_geral AND c.deleted_at IS NULL), 0)::text AS faturas`,
    [tenantId],
  )
  const l = r.rows[0]
  return {
    saldo: dinheiro(BigInt(l?.saldo ?? '0'), moeda),
    faturasEmAberto: dinheiro(BigInt(l?.faturas ?? '0'), moeda),
  }
}
