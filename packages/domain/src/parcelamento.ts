import { ancorarDiaNoMes } from './fatura.js'
import type { Money } from './money.js'
import { ratear } from './ratear.js'
import { falha, ok, type Result } from './result.js'
import { dataCivilDe, inicioDoDiaCivil } from './tempo.js'

/**
 * Parcelamento — `docs/adr/0007` §2 e ADR 0005.
 *
 * Gera N lançamentos futuros a partir de uma compra. Nunca um lançamento único
 * "12x": cada parcela é um fato próprio, com sua data e sua fatura.
 */

export interface Parcela {
  readonly numero: number
  readonly total: number
  readonly valor: Money
  /** Competência da parcela — é ela que decide a fatura. */
  readonly postedAt: Date
}

export type ErroDeParcelamento =
  | { readonly tipo: 'parcelas-invalidas'; readonly parcelas: number }
  /** `|total| < N` produziria parcela de valor zero, que `Lancamento` proíbe. */
  | { readonly tipo: 'parcelamento-indivisivel'; readonly minimoEmCentavos: bigint }

export function gerarParcelas(
  valorTotal: Money,
  parcelas: number,
  dataCompra: Date,
): Result<Parcela[], ErroDeParcelamento> {
  if (!Number.isInteger(parcelas) || parcelas < 1) {
    return falha({ tipo: 'parcelas-invalidas', parcelas })
  }

  const magnitude = valorTotal.centavos < 0n ? -valorTotal.centavos : valorTotal.centavos
  if (magnitude < BigInt(parcelas)) {
    // Recusar é a única saída honesta. Gerar menos parcelas do que o usuário
    // pediu mente sobre o parcelamento; relaxar `valor ≠ 0` abriria lançamento
    // de valor zero em todo o sistema.
    return falha({ tipo: 'parcelamento-indivisivel', minimoEmCentavos: BigInt(parcelas) })
  }

  // O rateio é o do ADR 0005: resto nas primeiras, uma unidade por parte, e o
  // sinal preservado. Reimplementar a divisão aqui criaria uma segunda regra.
  const partes = ratear(valorTotal, parcelas)
  if (!partes.ok) return falha({ tipo: 'parcelas-invalidas', parcelas })

  const compra = dataCivilDe(dataCompra)

  return ok(
    partes.valor.map((valor, i) => ({
      numero: i + 1,
      total: parcelas,
      valor,
      postedAt: dataDaParcela(compra, i),
    })),
  )
}

/**
 * A data da parcela k: `k-1` meses após a compra, com ancoragem de dia do mês.
 *
 * O ajuste do mês curto **não é arrastado**: a conta parte sempre do dia da
 * compra, nunca do dia da parcela anterior. Compra em 31/jan em 3x dá
 * 31/jan, 28/fev, 31 de março — e não 28 de março.
 *
 * Arrastar seria o resultado natural de somar um mês à parcela anterior, que é
 * como quase todo mundo escreve isso na primeira tentativa.
 */
function dataDaParcela(compra: { ano: number; mes: number; dia: number }, deslocamento: number): Date {
  const mesAbsoluto = compra.mes - 1 + deslocamento
  const ano = compra.ano + Math.floor(mesAbsoluto / 12)
  const mes = (mesAbsoluto % 12) + 1

  return inicioDoDiaCivil(ancorarDiaNoMes(ano, mes, compra.dia))
}
