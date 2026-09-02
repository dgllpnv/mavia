import { dinheiro, negar, sinalDe, somarLista, type Moeda, type Money } from './money.js'
import { falha, ok, type Result } from './result.js'

/**
 * Estorno — desfazer sem editar o original.
 *
 * O original aconteceu e depois foi desfeito, e **as duas coisas ficam
 * registradas**. Editar o original destruiria a primeira metade da verdade, e
 * é justamente o que um extrato financeiro não pode fazer.
 *
 * Três regras que a tabela sozinha não expressa, porque valem **entre linhas**:
 * sinal oposto ao original; magnitude acumulada nunca maior que a do original;
 * e o par original + estorno total somando zero.
 */

export type ErroDeEstorno =
  | { readonly tipo: 'estorno-excede-original'; readonly disponivel: bigint }
  | { readonly tipo: 'valor-invalido'; readonly motivo: 'zero' | 'negativo' }
  | { readonly tipo: 'moedas-divergentes'; readonly esquerda: Moeda; readonly direita: Moeda }

function magnitude(m: Money): bigint {
  return m.centavos < 0n ? -m.centavos : m.centavos
}

/** Quanto do original já foi desfeito. Sempre positivo. */
export function estornoAcumulado(
  estornosAnteriores: readonly Money[],
  moeda: Moeda,
): Result<Money, ErroDeEstorno> {
  for (const e of estornosAnteriores) {
    if (e.moeda !== moeda) {
      return falha({ tipo: 'moedas-divergentes', esquerda: moeda, direita: e.moeda })
    }
  }
  const total = estornosAnteriores.reduce((acc, e) => acc + magnitude(e), 0n)
  return ok(dinheiro(total, moeda))
}

/**
 * Produz o valor do lançamento de estorno.
 *
 * `valorAEstornar` é **magnitude**, sempre positiva: o sinal é derivado do
 * original, nunca escolhido pelo chamador. Deixar o chamador escolher
 * permitiria um "estorno" que soma na mesma direção e dobra a despesa.
 */
export function estornar(
  original: Money,
  valorAEstornar: Money,
  estornosAnteriores: readonly Money[],
): Result<Money, ErroDeEstorno> {
  if (valorAEstornar.moeda !== original.moeda) {
    return falha({
      tipo: 'moedas-divergentes',
      esquerda: original.moeda,
      direita: valorAEstornar.moeda,
    })
  }
  if (valorAEstornar.centavos === 0n) {
    return falha({ tipo: 'valor-invalido', motivo: 'zero' })
  }
  if (valorAEstornar.centavos < 0n) {
    return falha({ tipo: 'valor-invalido', motivo: 'negativo' })
  }

  const acumulado = estornoAcumulado(estornosAnteriores, original.moeda)
  if (!acumulado.ok) return acumulado

  const disponivel = magnitude(original) - acumulado.valor.centavos
  if (valorAEstornar.centavos > disponivel) {
    return falha({ tipo: 'estorno-excede-original', disponivel })
  }

  // Sinal oposto ao original. Original negativo (despesa) devolve positivo.
  const sinal = sinalDe(original)
  const valor = dinheiro(valorAEstornar.centavos, original.moeda)
  return ok(sinal < 0 ? valor : negar(valor))
}

/**
 * O que resta do original depois dos estornos.
 *
 * É esta soma que faz o estorno não inflar nem deflacionar relatório: as duas
 * linhas coexistem no extrato e se anulam na agregação.
 */
export function saldoDoOriginal(
  original: Money,
  estornos: readonly Money[],
): Result<Money, ErroDeEstorno> {
  const acumulado = estornoAcumulado(estornos, original.moeda)
  if (!acumulado.ok) return acumulado

  const restante =
    sinalDe(original) < 0
      ? original.centavos + acumulado.valor.centavos
      : original.centavos - acumulado.valor.centavos

  const soma = somarLista([dinheiro(restante, original.moeda)], original.moeda)
  return soma.ok
    ? ok(soma.valor)
    : falha({ tipo: 'moedas-divergentes', esquerda: original.moeda, direita: original.moeda })
}
