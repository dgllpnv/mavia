import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { dinheiro } from './money.js'
import {
  atingiuOAlvo,
  consumoDoObjetivoEmBp,
  estadoDoObjetivo,
  prazoValido,
  progressoAncorado,
  progressoPorAportes,
} from './objetivo.js'

const brl = (c: bigint) => dinheiro(c, 'BRL')

describe('progresso ancorado', () => {
  it('é a variação do saldo desde o marco', () => {
    // "Viagem" criada quando a poupança tinha R$ 2.000; hoje tem R$ 5.000.
    expect(progressoAncorado(brl(500000n), brl(200000n))).toEqual(brl(300000n))
  })

  it('resgate abaixo do marco dá progresso negativo, e isso é permitido', () => {
    // A barra da tela trava em 0%; o domínio devolve o número real.
    expect(progressoAncorado(brl(150000n), brl(200000n))).toEqual(brl(-50000n))
  })

  it('moeda divergente lança, não converte', () => {
    expect(() => progressoAncorado(brl(1n), dinheiro(1n, 'USD'))).toThrow()
  })
})

describe('progresso por aportes', () => {
  it('soma com o sinal do domínio: o resgate subtrai sem nenhum `if`', () => {
    // A perna positiva de uma transferência soma; a negativa, um resgate,
    // subtrai. É o dividendo do ADR 0005.
    const aportes = [brl(100000n), brl(50000n), brl(-30000n)]

    expect(progressoPorAportes(aportes, 'BRL')).toEqual(brl(120000n))
  })

  it('sem aporte nenhum, progresso zero — e a moeda vem do objetivo', () => {
    expect(progressoPorAportes([], 'BRL')).toEqual(brl(0n))
  })

  it('moeda divergente lança', () => {
    expect(() => progressoPorAportes([dinheiro(1n, 'USD')], 'BRL')).toThrow()
  })
})

describe('atingir o alvo', () => {
  it('exatamente o alvo atinge', () => {
    expect(atingiuOAlvo(brl(1200000n), brl(1200000n))).toBe(true)
  })

  it('um centavo a menos não atinge', () => {
    expect(atingiuOAlvo(brl(1199999n), brl(1200000n))).toBe(false)
  })

  it('passar do alvo atinge', () => {
    expect(atingiuOAlvo(brl(1500000n), brl(1200000n))).toBe(true)
  })
})

describe('consumo em basis points', () => {
  it('R$ 15.000 de R$ 12.000 é 125%, e não 100%', () => {
    // Invariante 7: o progresso não é limitado ao alvo. Travar a barra é
    // decisão de UI; o domínio devolve o número real.
    expect(consumoDoObjetivoEmBp(brl(1500000n), brl(1200000n))).toBe(12500)
  })

  it('progresso negativo devolve bp negativo', () => {
    expect(consumoDoObjetivoEmBp(brl(-50000n), brl(1000000n))).toBe(-500)
  })

  it('alvo zero ou negativo é estado impossível, e lança', () => {
    // `valor_alvo > 0` é invariante do banco. Se chegou aqui, alguém a furou.
    expect(() => consumoDoObjetivoEmBp(brl(1n), brl(0n))).toThrow()
    expect(() => consumoDoObjetivoEmBp(brl(1n), brl(-1n))).toThrow()
  })
})

describe('estado', () => {
  const hoje = { ano: 2026, mes: 9, dia: 2 }
  const agora = new Date('2026-09-02T12:00:00.000Z')

  it('concluído vence prazo vencido', () => {
    // Um objetivo concluído em julho cujo prazo era agosto continua concluído.
    const estado = estadoDoObjetivo(
      { concluidoEm: agora, prazo: { ano: 2026, mes: 8, dia: 31 } },
      hoje,
    )

    expect(estado).toBe('concluido')
  })

  it('prazo no passado sem conclusão é vencido', () => {
    expect(
      estadoDoObjetivo({ concluidoEm: null, prazo: { ano: 2026, mes: 9, dia: 1 } }, hoje),
    ).toBe('vencido')
  })

  it('**o prazo que vence hoje ainda é ativo**', () => {
    // `prazo < hoje`, e não `<=`. O último dia conta, e o dia é apurado em
    // America/Sao_Paulo — em UTC, o dia 2 às 21h já seria o dia 3.
    expect(
      estadoDoObjetivo({ concluidoEm: null, prazo: { ano: 2026, mes: 9, dia: 2 } }, hoje),
    ).toBe('ativo')
  })

  it('sem prazo nunca vence', () => {
    // A reserva de emergência, que não tem data e não deve inventar uma.
    expect(estadoDoObjetivo({ concluidoEm: null, prazo: null }, hoje)).toBe('ativo')
  })
})

describe('validade do prazo na escrita', () => {
  const hoje = { ano: 2026, mes: 9, dia: 2 }

  it('hoje é válido', () => {
    expect(prazoValido({ ano: 2026, mes: 9, dia: 2 }, hoje)).toBe(true)
  })

  it('ontem não é', () => {
    expect(prazoValido({ ano: 2026, mes: 9, dia: 1 }, hoje)).toBe(false)
  })

  it('dezembro do ano que vem é', () => {
    expect(prazoValido({ ano: 2027, mes: 12, dia: 31 }, hoje)).toBe(true)
  })
})

describe('propriedades', () => {
  const money = fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }).map(brl)
  const alvo = fc.bigInt({ min: 1n, max: 10n ** 12n }).map(brl)

  it('atingir o alvo equivale a consumo >= 10000 bp', () => {
    // Aqui a equivalência **vale**, e vale porque `valor_alvo > 0` sempre.
    // No Planejamento ela só valia para teto: com valor negativo a divisão
    // inverte a desigualdade. É a mesma aritmética; o que muda é a garantia
    // de sinal, e é ela que dispensa o `if`.
    fc.assert(
      fc.property(money, alvo, (progresso, valorAlvo) => {
        expect(atingiuOAlvo(progresso, valorAlvo)).toBe(
          consumoDoObjetivoEmBp(progresso, valorAlvo) >= 10000,
        )
      }),
    )
  })

  it('o progresso ancorado é sempre saldo − marco, inclusive negativo', () => {
    fc.assert(
      fc.property(money, money, (saldo, marco) => {
        const p = progressoAncorado(saldo, marco)
        expect(p.centavos).toBe(saldo.centavos - marco.centavos)
      }),
    )
  })

  it('a ordem dos aportes não muda o progresso', () => {
    fc.assert(
      fc.property(fc.array(money, { maxLength: 40 }), (aportes) => {
        const invertidos = [...aportes].reverse()
        expect(progressoPorAportes(invertidos, 'BRL')).toEqual(
          progressoPorAportes(aportes, 'BRL'),
        )
      }),
    )
  })
})
