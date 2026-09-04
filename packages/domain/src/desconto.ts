import { dinheiro, type Moeda, type Money } from './money.js'
import { falha, ok, type Result } from './result.js'

/**
 * Desconto sobre o preço de um plano — **ADR 0025 D1**.
 *
 * ## O que este módulo NÃO faz, e é o ponto dele
 *
 * Ele **não calcula quanto o cliente paga**. Quem cobra é a Stripe, sobre um
 * `Coupon` que ela mesma aplica, e o valor final chega pelo webhook (DP-39).
 * Um número nosso apresentado como o valor cobrado seria a segunda verdade que
 * a DP-39 existe para impedir.
 *
 * O que ele produz é **estimativa para a tela**, e a tela a rotula como tal:
 * *"≈ R$ 169,92 · valor final confirmado pela Stripe"*. Estimativa não é
 * desculpa para ser aproximada — é a razão de as propriedades abaixo serem
 * obrigatórias. Uma estimativa que erra por um centavo é uma estimativa que o
 * operador usa para conferir a fatura e conclui que a fatura está errada.
 *
 * ## Pontos-base, e por que não `0.15`
 *
 * O percentual vive em **pontos-base inteiros**: 15% é `1500`, 7,5% é `750`.
 * A alternativa óbvia, `0.15`, traria ponto flutuante para dois passos de
 * distância de uma `Money` — e `19990 * 0.15` é `2998.4999999999995` em IEEE
 * 754. A regra 1 do `CLAUDE.md` não fala só do valor: fala de perto dele.
 *
 * ## O arredondamento, declarado como a regra 3 exige
 *
 * 15% de R$ 199,90 é 2998,5 centavos — **meio centavo**, e nenhuma escolha é
 * neutra. Arredondamos **o desconto**, meio para cima, que é o que a Stripe
 * faz. E arredondamos o desconto, e não o preço final, para que a subtração
 * feche exatamente: `final = preco − desconto`, sempre, por construção e não
 * por sorte. É a mesma disciplina de `ratear` — a soma das partes é o todo.
 */

export type Desconto =
  | { readonly especie: 'percentual'; readonly pontosBase: number }
  | { readonly especie: 'valor'; readonly quantia: Money }

export type ErroDeDesconto =
  | { readonly tipo: 'percentual-fora-de-faixa'; readonly recebido: number }
  | { readonly tipo: 'valor-nao-positivo'; readonly recebido: bigint }
  | { readonly tipo: 'preco-nao-positivo'; readonly recebido: bigint }
  | { readonly tipo: 'moedas-divergentes'; readonly preco: Moeda; readonly desconto: Moeda }

/** 100% em pontos-base. O teto da ADR 0025 D2: desconto acima disso é recusado. */
const CEM_POR_CENTO = 10_000

export function descontoPercentual(pontosBase: number): Result<Desconto, ErroDeDesconto> {
  // `Number.isInteger` e não `% 1`: `1500.5 % 1` é `0.5`, mas `NaN % 1` é
  // `NaN`, que não é `!== 0` de forma útil em toda leitura.
  if (!Number.isInteger(pontosBase) || pontosBase < 1 || pontosBase > CEM_POR_CENTO) {
    return falha({ tipo: 'percentual-fora-de-faixa', recebido: pontosBase })
  }
  return ok({ especie: 'percentual', pontosBase })
}

export function descontoDeValor(quantia: Money): Result<Desconto, ErroDeDesconto> {
  if (quantia.centavos <= 0n) {
    return falha({ tipo: 'valor-nao-positivo', recebido: quantia.centavos })
  }
  return ok({ especie: 'valor', quantia })
}

export interface Estimativa {
  /** O que sai do preço. **Já limitado ao preço** — ver a nota abaixo. */
  readonly desconto: Money
  /** `preco − desconto`. Nunca negativo. */
  readonly final: Money
}

export function estimarComDesconto(
  preco: Money,
  desconto: Desconto,
): Result<Estimativa, ErroDeDesconto> {
  if (preco.centavos <= 0n) {
    return falha({ tipo: 'preco-nao-positivo', recebido: preco.centavos })
  }

  let bruto: bigint
  if (desconto.especie === 'percentual') {
    // Meio para cima sobre inteiros positivos: somar metade do divisor antes de
    // dividir. `BigInt` trunca em direção a zero, o que sobre positivo é piso —
    // e `piso(x + 0,5)` é exatamente arredondar meio para cima.
    bruto = (preco.centavos * BigInt(desconto.pontosBase) + 5000n) / 10000n
  } else {
    if (desconto.quantia.moeda !== preco.moeda) {
      return falha({
        tipo: 'moedas-divergentes',
        preco: preco.moeda,
        desconto: desconto.quantia.moeda,
      })
    }
    bruto = desconto.quantia.centavos
  }

  // Um cupom de R$ 100,00 sobre um preço de R$ 35,00 desconta R$ 35,00. O valor
  // **reportado** encolhe junto com o efeito: devolver os R$ 100,00 nominais
  // faria `preco − desconto` dar −R$ 65,00 em qualquer tela que refizesse a
  // conta, e alguma tela sempre refaz.
  const efetivo = bruto > preco.centavos ? preco.centavos : bruto

  return ok({
    desconto: dinheiro(efetivo, preco.moeda),
    final: dinheiro(preco.centavos - efetivo, preco.moeda),
  })
}
