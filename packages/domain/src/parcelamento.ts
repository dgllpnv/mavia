import { ancorarDiaNoMes, faturaAlvo, type CicloDeFaturamento } from './fatura.js'
import type { Money } from './money.js'
import { ratear } from './ratear.js'
import { falha, ok, type Result } from './result.js'
import { competenciaSeguinte, dataCivilDe, inicioDoDiaCivil, type Competencia } from './tempo.js'

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
  /** Competência da parcela — a data que aparece no extrato. */
  readonly postedAt: Date
  /**
   * A fatura desta parcela, pelo **mês de fechamento**, atribuída por
   * construção.
   *
   * Mês de fechamento, e não competência: a competência de uma Fatura é o mês
   * do vencimento (`CONTEXT.md`), e num ciclo 25/5 os dois diferem.
   *
   * Não é derivada de `postedAt`: com `closingDay` perto do fim do mês, a
   * ancoragem de dia faz parcelas consecutivas caírem na mesma janela. Compra
   * em 31/01 num cartão que fecha dia 30, em 12x: a parcela 1 (31/jan) e a
   * parcela 2 (28/fev) caem **ambas** na fatura de fevereiro — e as 12
   * parcelas acabam em 7 faturas, com uma cobrando o dobro e outra nada.
   *
   * "12x" significa doze faturas. A atribuição é sequencial a partir da
   * fatura da compra, e é isso que o usuário espera e que o extrato mostra.
   */
  readonly mesDeFechamentoDaFatura: Competencia
}

export type ErroDeParcelamento =
  | { readonly tipo: 'parcelas-invalidas'; readonly parcelas: number }
  /** `|total| < N` produziria parcela de valor zero, que `Lancamento` proíbe. */
  | { readonly tipo: 'parcelamento-indivisivel'; readonly minimoEmCentavos: bigint }

export function gerarParcelas(
  valorTotal: Money,
  parcelas: number,
  dataCompra: Date,
  /** O ciclo do cartão. Ausente para parcelamento em conta, que não tem fatura. */
  ciclo?: CicloDeFaturamento,
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

  // A fatura da parcela 1 é a da compra; as seguintes são as consecutivas.
  // Derivar cada uma de `postedAt` colidiria — ver `mesDeFechamentoDaFatura`.
  let mes: Competencia = ciclo
    ? faturaAlvo(ciclo, dataCompra)
    : { ano: compra.ano, mes: compra.mes }

  const saida: Parcela[] = []
  for (const [i, valor] of partes.valor.entries()) {
    saida.push({
      numero: i + 1,
      total: parcelas,
      valor,
      postedAt: dataDaParcela(compra, i),
      mesDeFechamentoDaFatura: mes,
    })
    mes = competenciaSeguinte(mes)
  }
  return ok(saida)
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
