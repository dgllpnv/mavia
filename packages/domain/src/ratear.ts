import { dinheiro, type Money } from './money.js'
import { falha, ok, type Result } from './result.js'

/**
 * Rateio — a divisão monetária do sistema.
 *
 * Regra única, válida para parcelamento e para divisão de despesa: a soma das
 * partes é **exatamente** igual ao total, e o resto em centavos é distribuído
 * **uma unidade por parte, nas primeiras partes**.
 *
 * A auditoria do spec encontrou uma segunda regra circulando — "todo o resto na
 * primeira parcela". As duas somam igual e coincidem sempre que o resto é 1,
 * que é o caso de R$ 100,00 em 3x, o exemplo usado em toda conferência à mão.
 * Elas divergem em R$ 0,03 na primeira parcela já em R$ 100,00 em 7x.
 *
 * Ver `docs/adr/0005-dinheiro-centavos-partida-dobrada.md`.
 */

export type ErroDeRateio = {
  readonly tipo: 'partes-invalidas'
  readonly partes: number
}

export function ratear(total: Money, partes: number): Result<Money[], ErroDeRateio> {
  if (!Number.isInteger(partes) || partes < 1) {
    return falha({ tipo: 'partes-invalidas', partes })
  }

  // Opera sobre a magnitude e reaplica o sinal no fim. Dividir o negativo
  // direto truncaria para o lado errado e produziria uma distribuição
  // diferente — que ainda somaria o total, e por isso passaria despercebida.
  const negativo = total.centavos < 0n
  const magnitude = negativo ? -total.centavos : total.centavos

  const n = BigInt(partes)
  const base = magnitude / n
  const resto = magnitude % n

  const resultado: Money[] = []
  for (let i = 0n; i < n; i++) {
    const centavos = i < resto ? base + 1n : base
    resultado.push(dinheiro(negativo ? -centavos : centavos, total.moeda))
  }

  return ok(resultado)
}
