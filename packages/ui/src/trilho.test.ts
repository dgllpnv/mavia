import { dinheiro } from '@mavia/domain'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { geometriaDoTrilho } from './trilho.js'

/**
 * O trilho — `docs/design/direcao-visual.md` §1.
 *
 * A geometria é código puro e testada como tal, porque ela é a única coisa do
 * elemento-assinatura que pode estar **errada**. O resto é CSS: se o trilho
 * ficar 2px mais fino ninguém perde dinheiro, mas uma carga de 140% desenhada
 * como 100% esconde um estouro de orçamento, e é isso que o usuário abriu o
 * produto para ver.
 */

const brl = (c: bigint) => dinheiro(c, 'BRL')

describe('geometriaDoTrilho', () => {
  it('metade do previsto realizado ocupa metade do trilho', () => {
    const g = geometriaDoTrilho({ realizado: brl(-50000n), previsto: brl(-100000n) })

    expect(g).toMatchObject({ carga: 0.5, marca: 1, estouro: 0 })
  })

  it('realizado igual ao previsto encosta a carga na marca', () => {
    const g = geometriaDoTrilho({ realizado: brl(-100000n), previsto: brl(-100000n) })

    expect(g).toMatchObject({ carga: 1, marca: 1, estouro: 0 })
  })

  it('estouro recua a marca e mede o excedente', () => {
    // R$ 1.250 realizados sobre R$ 1.000 previstos. O trilho passa a valer
    // 1.250, a marca fica em 80%, e o quinto final é o estouro hachurado.
    const g = geometriaDoTrilho({ realizado: brl(-125000n), previsto: brl(-100000n) })

    expect(g.carga).toBe(1)
    expect(g.marca).toBe(0.8)
    expect(g.estouro).toBeCloseTo(0.2, 10)
    expect(g.excedente?.centavos).toBe(-25000n)
  })

  it('sem estouro não existe excedente para rotular', () => {
    expect(geometriaDoTrilho({ realizado: brl(-50000n), previsto: brl(-100000n) }).excedente).toBe(
      null,
    )
  })

  it('despesa carrega da direita para a esquerda; receita, ao contrário', () => {
    // O segundo canal da §3.5: a direção codifica o sinal sem gastar cor.
    expect(geometriaDoTrilho({ realizado: brl(-1n), previsto: brl(-100n) }).direcao).toBe('direita')
    expect(geometriaDoTrilho({ realizado: brl(1n), previsto: brl(100n) }).direcao).toBe('esquerda')
  })

  it('a direção vem do previsto, que é o denominador', () => {
    // Um mês de despesas que começou com um estorno tem realizado positivo. A
    // direção não pode virar por causa da primeira linha do mês.
    expect(geometriaDoTrilho({ realizado: brl(5000n), previsto: brl(-100000n) }).direcao).toBe(
      'direita',
    )
  })

  it('previsto zero não divide por zero', () => {
    // Mês sem nada previsto e R$ 300 gastos. É estouro de 100% de nada — o
    // trilho enche, a marca fica na origem, e nada vira NaN.
    const g = geometriaDoTrilho({ realizado: brl(-30000n), previsto: brl(0n) })

    expect(g.carga).toBe(1)
    expect(g.marca).toBe(0)
    expect(g.estouro).toBe(1)
  })

  it('tudo zero é um trilho vazio, não um trilho cheio', () => {
    const g = geometriaDoTrilho({ realizado: brl(0n), previsto: brl(0n) })

    expect(g).toMatchObject({ carga: 0, marca: 0, estouro: 0 })
  })

  it('realizado de sinal contrário ao previsto não desenha carga negativa', () => {
    // Previsto R$ 1.000 de despesa, realizado R$ 200 de receita (estornos além
    // dos gastos). Carga negativa viraria uma barra desenhada para fora da
    // caixa; o honesto é carga zero e o número ao lado dizendo o que houve.
    const g = geometriaDoTrilho({ realizado: brl(20000n), previsto: brl(-100000n) })

    expect(g.carga).toBe(0)
    expect(g.estouro).toBe(0)
  })

  it('recusa comparar moedas diferentes', () => {
    // Regra 2: somar ou comparar moedas distintas lança, nunca converte em
    // silêncio. Um trilho é uma razão entre dois valores.
    expect(() =>
      geometriaDoTrilho({ realizado: dinheiro(100n, 'USD'), previsto: dinheiro(100n, 'BRL') }),
    ).toThrow(/moeda/i)
  })
})

describe('propriedades do trilho', () => {
  const centavos = fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n })

  it('toda proporção fica entre 0 e 1 — nada vaza para fora da caixa', () => {
    fc.assert(
      fc.property(centavos, centavos, (r, p) => {
        const g = geometriaDoTrilho({ realizado: brl(r), previsto: brl(p) })

        for (const v of [g.carga, g.marca, g.estouro]) {
          expect(Number.isFinite(v)).toBe(true)
          expect(v).toBeGreaterThanOrEqual(0)
          expect(v).toBeLessThanOrEqual(1)
        }
      }),
      { numRuns: 2000 },
    )
  })

  it('a marca só recua da ponta quando há estouro, e nunca por outro motivo', () => {
    // A propriedade que amarra as três medidas entre si. Sem ela, um erro de
    // sinal poderia recuar a marca num mês sem estouro nenhum — e o usuário
    // leria "gastei menos que o previsto" olhando para um trilho que diz o
    // contrário.
    fc.assert(
      fc.property(centavos, centavos, (r, p) => {
        const g = geometriaDoTrilho({ realizado: brl(r), previsto: brl(p) })

        if (g.estouro === 0) expect(g.marca === 1 || g.marca === 0).toBe(true)
        else expect(g.marca).toBeLessThan(1)
      }),
      { numRuns: 2000 },
    )
  })
})
