import { falha, ok, type Result } from './result.js'

/**
 * Money — o value object monetário do sistema.
 *
 * Centavos inteiros (`bigint`) mais moeda ISO 4217. Imutável. Toda aritmética
 * monetária passa por aqui, inclusive a que acaba virando `SUM` no banco.
 *
 * Ver `docs/adr/0005-dinheiro-centavos-partida-dobrada.md` e `CLAUDE.md` §2.
 */

/**
 * A moeda é um tipo fechado, não uma string validada em runtime: estado
 * inválido irrepresentável em vez de erro capturado. Acrescentar moeda é
 * acrescentar um membro aqui.
 */
export type Moeda = 'BRL' | 'USD' | 'EUR'

export interface Money {
  readonly centavos: bigint
  readonly moeda: Moeda
}

export type ErroMonetario = {
  readonly tipo: 'moedas-divergentes'
  readonly esquerda: Moeda
  readonly direita: Moeda
}

/**
 * Construção é total: não existe `Money` inválido a ser recusado. O sinal
 * vive no valor — despesa é negativa, receita é positiva — e não num enum
 * de tipo à parte (`CLAUDE.md` §2, regra 6).
 */
export function dinheiro(centavos: bigint, moeda: Moeda): Money {
  return { centavos, moeda }
}

export function somar(a: Money, b: Money): Result<Money, ErroMonetario> {
  if (a.moeda !== b.moeda) {
    return falha({ tipo: 'moedas-divergentes', esquerda: a.moeda, direita: b.moeda })
  }
  return ok(dinheiro(a.centavos + b.centavos, a.moeda))
}

export function subtrair(a: Money, b: Money): Result<Money, ErroMonetario> {
  return somar(a, negar(b))
}

/** `bigint` não tem zero negativo, então negar zero devolve zero. */
export function negar(quantia: Money): Money {
  return dinheiro(-quantia.centavos, quantia.moeda)
}

/**
 * A moeda é parâmetro, e não inferida do primeiro elemento, para que a lista
 * vazia tenha resposta e para que uma lista inteira em moeda errada falhe em
 * vez de adotar silenciosamente a moeda de quem veio primeiro.
 */
export function somarLista(
  quantias: readonly Money[],
  moeda: Moeda,
): Result<Money, ErroMonetario> {
  let total = 0n
  for (const quantia of quantias) {
    if (quantia.moeda !== moeda) {
      return falha({ tipo: 'moedas-divergentes', esquerda: moeda, direita: quantia.moeda })
    }
    total += quantia.centavos
  }
  return ok(dinheiro(total, moeda))
}

export function sinalDe(quantia: Money): -1 | 0 | 1 {
  if (quantia.centavos < 0n) return -1
  if (quantia.centavos > 0n) return 1
  return 0
}

export function ehZero(quantia: Money): boolean {
  return quantia.centavos === 0n
}
