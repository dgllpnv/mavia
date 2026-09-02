import { describe, expect, it } from 'vitest'
import { dinheiro } from './money.js'
import { estornar, estornoAcumulado, saldoDoOriginal } from './estorno.js'

/**
 * Estorno — desfazer sem editar o original.
 *
 * O fato aconteceu e depois foi desfeito, e as duas coisas ficam registradas
 * (`CONTEXT.md`, Estorno). Editar o original destruiria a primeira metade da
 * verdade.
 */

const brl = (c: bigint) => dinheiro(c, 'BRL')

describe('estornar', () => {
  it('devolve valor de sinal oposto ao original', () => {
    const r = estornar(brl(-10000n), brl(10000n), [])

    expect(r.ok && r.valor.centavos).toBe(10000n)
  })

  it('aceita estorno parcial', () => {
    const r = estornar(brl(-10000n), brl(3000n), [])

    expect(r.ok && r.valor.centavos).toBe(3000n)
  })

  it('estorna uma receita com valor negativo', () => {
    const r = estornar(brl(720000n), brl(720000n), [])

    expect(r.ok && r.valor.centavos).toBe(-720000n)
  })

  it('recusa estorno maior que o original', () => {
    const r = estornar(brl(-10000n), brl(10001n), [])

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.erro.tipo).toBe('estorno-excede-original')
  })

  it('recusa quando a soma dos estornos passa do original', () => {
    // R$ 100,00 já estornado em R$ 70,00: só sobram R$ 30,00.
    const r = estornar(brl(-10000n), brl(3001n), [brl(7000n)])

    expect(r.ok).toBe(false)
  })

  it('aceita exatamente o que falta para completar o original', () => {
    const r = estornar(brl(-10000n), brl(3000n), [brl(7000n)])

    expect(r.ok && r.valor.centavos).toBe(3000n)
  })

  it('recusa valor zero — estorno de nada não é evento', () => {
    expect(estornar(brl(-10000n), brl(0n), []).ok).toBe(false)
  })

  it('recusa valor negativo: a magnitude é sempre positiva, o sinal é derivado', () => {
    // Deixar o chamador escolher o sinal permitiria um "estorno" que soma na
    // mesma direção do original e dobra a despesa.
    expect(estornar(brl(-10000n), brl(-3000n), []).ok).toBe(false)
  })

  it('recusa moeda diferente do original', () => {
    expect(estornar(brl(-10000n), dinheiro(1000n, 'USD'), []).ok).toBe(false)
  })
})

describe('estornoAcumulado', () => {
  it('soma as magnitudes já estornadas', () => {
    const r = estornoAcumulado([brl(3000n), brl(2000n)], 'BRL')

    expect(r.ok && r.valor.centavos).toBe(5000n)
  })

  it('sem estornos, é zero', () => {
    const r = estornoAcumulado([], 'BRL')

    expect(r.ok && r.valor.centavos).toBe(0n)
  })
})

describe('saldoDoOriginal', () => {
  it('o par original mais estorno total soma zero', () => {
    // É esta soma-zero que faz o estorno não inflar nem deflacionar relatório:
    // as duas linhas coexistem e se anulam.
    const r = saldoDoOriginal(brl(-10000n), [brl(10000n)])

    expect(r.ok && r.valor.centavos).toBe(0n)
  })

  it('estorno parcial deixa o restante', () => {
    const r = saldoDoOriginal(brl(-10000n), [brl(3000n)])

    expect(r.ok && r.valor.centavos).toBe(-7000n)
  })

  it('sem estorno, o original permanece inteiro', () => {
    const r = saldoDoOriginal(brl(-10000n), [])

    expect(r.ok && r.valor.centavos).toBe(-10000n)
  })
})
