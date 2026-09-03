import { NotFoundException } from '@nestjs/common'
import {
  competenciaDe,
  inicioDoDiaCivil,
  ocorrencias,
  type Competencia,
  type RegraDeRecorrencia,
} from '@mavia/domain'
import type { PoolClient } from 'pg'
import { registrarCompra, type CartaoDaCompra } from '../cartoes/compras.js'

/**
 * A materialização de ocorrências de `Recorrencia`.
 *
 * Módulo próprio, e não método do controlador, porque **duas** portas chamam a
 * mesma coisa: a rota, quando alguém cria ou edita uma regra, e o job agendado,
 * que faz o horizonte andar sozinho. Duplicá-la faria a regra do horizonte
 * existir em dois lugares — e o segundo envelheceria em silêncio.
 */

/** Quantos meses à frente materializar. Um ano é o que cabe numa tela. */
const HORIZONTE_EM_MESES = 12

/**
 * Materializa as ocorrências que faltam, do mês corrente ao fim do horizonte.
 *
 * **Nunca materializa o passado.** Uma regra que começa em janeiro, criada em
 * setembro, não inventa oito lançamentos que a pessoa nunca teve. O mês
 * corrente entra: quem cadastra o aluguel no dia 15 com vencimento no dia 10
 * quer ver a parcela deste mês, e ela nasce pendente — `settled_at` só é
 * escrito quando o dinheiro se move.
 */
export async function materializarRecorrencia(
  c: PoolClient,
  ctx: { tenantId: string; usuarioId: string },
  id: string,
): Promise<number> {
  const r = await c.query<{
    conta_id: string | null
    cartao_id: string | null
    categoria_id: string
    valor_centavos: string
    moeda: string
    descricao: string
    dia_do_mes: number
    intervalo_meses: number
    inicio: Date
    fim: Date | null
    pausada_em: Date | null
  }>(
    `SELECT conta_id, cartao_id, categoria_id, valor_centavos::text, moeda, descricao,
            dia_do_mes, intervalo_meses, inicio, fim, pausada_em
       FROM recorrencias
      WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [ctx.tenantId, id],
  )
  const regraNoBanco = r.rows[0]
  if (!regraNoBanco || regraNoBanco.pausada_em !== null) return 0

  const regra: RegraDeRecorrencia = {
    diaDoMes: regraNoBanco.dia_do_mes,
    intervaloMeses: regraNoBanco.intervalo_meses,
    inicio: competenciaDaData(regraNoBanco.inicio),
    fim: regraNoBanco.fim === null ? null : competenciaDaData(regraNoBanco.fim),
  }

  // O horizonte é contado do **mês corrente**, e o dia de hoje vem do
  // servidor: data de negócio nunca vem do relógio do cliente.
  const agora = competenciaDe(new Date())
  const ate = avancar(agora, HORIZONTE_EM_MESES)

  let criadas = 0
  for (const o of ocorrencias(regra, agora, ate)) {
    const competencia = `${o.competencia.ano}-${doisDigitos(o.competencia.mes)}-01`

    // O índice único já impediria a duplicata; conferir antes evita abortar a
    // transação inteira por causa de um mês que já existia.
    const jaExiste = await c.query(
      `SELECT 1 FROM lancamentos
        WHERE tenant_id = $1 AND recorrencia_id = $2 AND recorrencia_competencia = $3::date
          AND deleted_at IS NULL`,
      [ctx.tenantId, id, competencia],
    )
    if ((jaExiste.rowCount ?? 0) > 0) continue

    const postedAt = inicioDoDiaCivil(o.data)

    if (regraNoBanco.cartao_id !== null) {
      const cartao = await cartaoDaRegra(c, ctx.tenantId, regraNoBanco.cartao_id)
      // Pela **mesma** porta da compra à vista: é ela que sabe qual fatura
      // recebe o lançamento, e essa escolha não pode existir em dois lugares.
      await registrarCompra(
        c,
        ctx,
        cartao,
        {
          categoriaId: regraNoBanco.categoria_id,
          valorCentavos: regraNoBanco.valor_centavos,
          parcelas: 1,
          postedAt: postedAt.toISOString(),
          descricao: regraNoBanco.descricao,
        },
        { recorrenciaId: id, competencia },
      )
    } else {
      await c.query(
        `INSERT INTO lancamentos (tenant_id, conta_id, categoria_id, valor_centavos, moeda,
                                  posted_at, descricao, origem, criado_por,
                                  recorrencia_id, recorrencia_competencia)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'recorrencia',$8,$9,$10::date)`,
        [
          ctx.tenantId,
          regraNoBanco.conta_id,
          regraNoBanco.categoria_id,
          regraNoBanco.valor_centavos,
          regraNoBanco.moeda,
          postedAt,
          regraNoBanco.descricao,
          ctx.usuarioId,
          id,
          competencia,
        ],
      )
    }
    criadas++
  }

  return criadas
}

/**
 * Apaga as ocorrências **futuras e não compensadas**.
 *
 * As duas condições importam. `posted_at` no futuro é previsão, e previsão a
 * regra pode redesenhar; `settled_at` nulo é dinheiro que não se moveu, e
 * dinheiro que se moveu não se apaga por causa de uma edição de regra — o
 * extrato mentiria sobre um fato.
 */
export async function limparFuturoPendente(
  c: PoolClient,
  tenantId: string,
  id: string,
): Promise<void> {
  await c.query(
    `UPDATE lancamentos SET deleted_at = now()
      WHERE tenant_id = $1 AND recorrencia_id = $2 AND deleted_at IS NULL
        AND settled_at IS NULL
        AND posted_at > now()`,
    [tenantId, id],
  )
}

async function cartaoDaRegra(
  c: PoolClient,
  tenantId: string,
  cartaoId: string,
): Promise<CartaoDaCompra> {
  const r = await c.query<{
    id: string
    moeda: CartaoDaCompra['moeda']
    closing_day: number
    due_day: number
    conta_pagamento_id: string | null
  }>(
    `SELECT id, moeda, closing_day, due_day, conta_pagamento_id
       FROM cartoes WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [tenantId, cartaoId],
  )
  const cartao = r.rows[0]
  if (!cartao) throw new NotFoundException('Cartão não encontrado.')
  return {
    id: cartao.id,
    moeda: cartao.moeda,
    closingDay: cartao.closing_day,
    dueDay: cartao.due_day,
    contaPagamentoId: cartao.conta_pagamento_id,
  }
}

function doisDigitos(n: number): string {
  return String(n).padStart(2, '0')
}

function avancar(c: Competencia, meses: number): Competencia {
  const total = c.ano * 12 + (c.mes - 1) + meses
  return { ano: Math.floor(total / 12), mes: (total % 12) + 1 }
}

function competenciaDaData(d: Date): Competencia {
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1 }
}
