import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { dinheiro, type Money } from './money.js'
import { type Result } from './result.js'
import {
  descontoPercentual,
  descontoDeValor,
  estimarComDesconto,
  type Desconto,
} from './desconto.js'

const brl = (c: bigint): Money => dinheiro(c, 'BRL')

/**
 * Desempacota um `Result` ou falha o teste com o erro dentro da mensagem.
 *
 * `throw r.erro` seria mais curto e lança um objeto puro: o `only-throw-error`
 * reprova, e com razão — o rastro de pilha de um objeto lançado não diz de onde
 * ele veio, que é a única coisa que se quer quando um teste quebra.
 */
function exigir<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error('Result de falha onde o teste esperava sucesso: ' + JSON.stringify(r.erro))
  return r.valor
}

/** Preços plausíveis: de um centavo a dez mil reais. */
const precoArb = fc.bigInt({ min: 1n, max: 1_000_000n }).map(brl)

/** Todo desconto válido: 0,01% a 100%, ou uma quantia positiva. */
const descontoArb: fc.Arbitrary<Desconto> = fc.oneof(
  fc.integer({ min: 1, max: 10_000 }).map((pb) => exigir(descontoPercentual(pb))),
  fc.bigInt({ min: 1n, max: 2_000_000n }).map((c) => exigir(descontoDeValor(brl(c)))),
)

describe('construir um desconto', () => {
  it('percentual vive em pontos-base inteiros, e nunca em fração', () => {
    // 15% é `1500`. A alternativa — `0.15` — traria ponto flutuante para dois
    // passos de distância do preço, que é exatamente o que a regra 1 proíbe.
    const r = descontoPercentual(1500)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.valor).toEqual({ especie: 'percentual', pontosBase: 1500 })
  })

  it('zero por cento não é desconto, é ausência de desconto', () => {
    // Aceitar `0` criaria uma linha de desconto que não desconta: um cupom na
    // Stripe, uma linha na auditoria, e nenhum centavo a menos. A recusa é
    // aqui porque a tela não é o lugar de decidir o que é um desconto.
    const r = descontoPercentual(0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.erro.tipo).toBe('percentual-fora-de-faixa')
  })

  it('acima de cem por cento é recusado — a D2 da ADR 0025', () => {
    expect(descontoPercentual(10_001).ok).toBe(false)
    expect(descontoPercentual(10_000).ok).toBe(true)
  })

  it('pontos-base fracionários são recusados', () => {
    // `1500.5` é 15,005%, que a Stripe não representa. Aceitá-lo daria uma
    // estimativa nossa que nenhum cupom consegue reproduzir.
    expect(descontoPercentual(1500.5).ok).toBe(false)
  })

  it('desconto de valor precisa ser positivo', () => {
    expect(descontoDeValor(brl(0n)).ok).toBe(false)
    expect(descontoDeValor(brl(-100n)).ok).toBe(false)
    expect(descontoDeValor(brl(100n)).ok).toBe(true)
  })
})

describe('estimar o preço com desconto', () => {
  it('o caso do ADR: 15% sobre R$ 199,90', () => {
    // 15% de 19990 é 2998,5 centavos. **Meio centavo.** A regra 3 exige que o
    // arredondamento seja explícito e declarado: meio para cima, como a Stripe.
    // Desconto 2999, final 16991.
    const d = exigir(descontoPercentual(1500))
    const e = exigir(estimarComDesconto(brl(19990n), d))
    expect(e.desconto.centavos).toBe(2999n)
    expect(e.final.centavos).toBe(16991n)
  })

  it('cem por cento zera, e não passa disso', () => {
    const d = exigir(descontoPercentual(10_000))
    const e = exigir(estimarComDesconto(brl(19990n), d))
    expect(e.final.centavos).toBe(0n)
    expect(e.desconto.centavos).toBe(19990n)
  })

  it('**valor fixo maior que o preço para em zero, e o desconto reportado encolhe junto**', () => {
    // Um cupom de R$ 100,00 sobre um preço de R$ 35,00 desconta R$ 35,00, não
    // R$ 100,00. Reportar o valor nominal do cupom faria `preço − desconto`
    // dar −R$ 65,00 em qualquer tela que refizesse a conta.
    const d = exigir(descontoDeValor(brl(10_000n)))
    const e = exigir(estimarComDesconto(brl(3500n), d))
    expect(e.final.centavos).toBe(0n)
    expect(e.desconto.centavos).toBe(3500n)
  })

  it('moeda diferente é erro, nunca conversão silenciosa', () => {
    const d = exigir(descontoDeValor(dinheiro(1000n, 'USD')))
    const e = estimarComDesconto(brl(19990n), d)
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.erro.tipo).toBe('moedas-divergentes')
  })

  it('preço negativo não é preço', () => {
    const d = exigir(descontoPercentual(1000))
    expect(estimarComDesconto(brl(-100n), d).ok).toBe(false)
  })
})

describe('as propriedades — obrigatórias, é dinheiro', () => {
  it('o final nunca é negativo e nunca excede o preço', () => {
    fc.assert(
      fc.property(precoArb, descontoArb, (preco, d) => {
        const e = exigir(estimarComDesconto(preco, d))
        expect(e.final.centavos).toBeGreaterThanOrEqual(0n)
        expect(e.final.centavos).toBeLessThanOrEqual(preco.centavos)
      }),
    )
  })

  it('**preço = final + desconto, exatamente, para qualquer entrada**', () => {
    // A propriedade da soma, a mesma que `ratear` tem de provar. Sem ela, o
    // arredondamento do percentual pode fabricar ou sumir com um centavo, e o
    // lugar onde isso aparece é a fatura de alguém.
    fc.assert(
      fc.property(precoArb, descontoArb, (preco, d) => {
        const e = exigir(estimarComDesconto(preco, d))
        expect(e.final.centavos + e.desconto.centavos).toBe(preco.centavos)
      }),
    )
  })

  it('desconto percentual maior nunca produz preço final maior', () => {
    fc.assert(
      fc.property(
        precoArb,
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        (preco, a, b) => {
          const [menor, maior] = a <= b ? [a, b] : [b, a]
          const em = exigir(estimarComDesconto(preco, exigir(descontoPercentual(menor))))
          const eM = exigir(estimarComDesconto(preco, exigir(descontoPercentual(maior))))
          expect(eM.final.centavos).toBeLessThanOrEqual(em.final.centavos)
        },
      ),
    )
  })

  it('**cupom maior nunca produz preço final maior — inclusive passando do preço**', () => {
    // Esta é a metade que importa, e a faixa do gerador é deliberada: `2 ×
    // preco` garante que **o clamp seja atravessado** dentro do teste.
    //
    // A propriedade da soma não pega o erro que mora aqui. Um clamp escrito
    // como `if (bruto > preco) bruto = 0n` — que é a leitura errada plausível
    // de "o cupom não cabe" — mantém a soma exata (`0 + preco = preco`) e
    // mantém o final dentro da faixa (`0 <= preco <= preco`). As duas outras
    // propriedades passam. O que ele quebra é só isto: um cupom de R$ 100,00
    // cobrando **mais** que um de R$ 50,00 sobre um preço de R$ 35,00.
    fc.assert(
      fc.property(
        precoArb,
        fc.bigInt({ min: 1n, max: 2_000_000n }),
        fc.bigInt({ min: 1n, max: 2_000_000n }),
        (preco, a, b) => {
          const [menor, maior] = a <= b ? [a, b] : [b, a]
          const em = exigir(estimarComDesconto(preco, exigir(descontoDeValor(brl(menor)))))
          const eM = exigir(estimarComDesconto(preco, exigir(descontoDeValor(brl(maior)))))
          expect(eM.final.centavos).toBeLessThanOrEqual(em.final.centavos)
        },
      ),
    )
  })

  it('a moeda atravessa intacta', () => {
    fc.assert(
      fc.property(precoArb, descontoArb, (preco, d) => {
        const e = exigir(estimarComDesconto(preco, d))
        expect(e.final.moeda).toBe('BRL')
        expect(e.desconto.moeda).toBe('BRL')
      }),
    )
  })
})
