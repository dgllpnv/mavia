import { describe, expect, it } from 'vitest'
import { dinheiro, ehZero, negar, sinalDe, somar, somarLista, subtrair } from './money.js'

// Regras que estes testes protegem:
//   CLAUDE.md §2, regras 1, 2 e 6
//   docs/adr/0005-dinheiro-centavos-partida-dobrada.md

describe('dinheiro', () => {
  it('guarda o valor em centavos inteiros e a moeda', () => {
    const quantia = dinheiro(1116n, 'BRL')

    expect(quantia.centavos).toBe(1116n)
    expect(quantia.moeda).toBe('BRL')
  })

  it('aceita valor negativo, porque despesa é negativa no próprio valor', () => {
    expect(dinheiro(-1116n, 'BRL').centavos).toBe(-1116n)
  })
})

describe('somar', () => {
  it('soma duas quantias da mesma moeda', () => {
    const resultado = somar(dinheiro(1000n, 'BRL'), dinheiro(116n, 'BRL'))

    expect(resultado.ok).toBe(true)
    if (!resultado.ok) return
    expect(resultado.valor.centavos).toBe(1116n)
    expect(resultado.valor.moeda).toBe('BRL')
  })

  it('recusa somar moedas diferentes em vez de converter em silêncio', () => {
    const resultado = somar(dinheiro(1000n, 'BRL'), dinheiro(1000n, 'USD'))

    expect(resultado.ok).toBe(false)
    if (resultado.ok) return
    expect(resultado.erro).toEqual({ tipo: 'moedas-divergentes', esquerda: 'BRL', direita: 'USD' })
  })

  it('somar despesa com receita dá o líquido, sem nenhum condicional no chamador', () => {
    const resultado = somar(dinheiro(-30000n, 'BRL'), dinheiro(720000n, 'BRL'))

    expect(resultado.ok && resultado.valor.centavos).toBe(690000n)
  })
})

describe('subtrair', () => {
  it('subtrai duas quantias da mesma moeda', () => {
    const resultado = subtrair(dinheiro(1116n, 'BRL'), dinheiro(116n, 'BRL'))

    expect(resultado.ok && resultado.valor.centavos).toBe(1000n)
  })

  it('recusa subtrair moedas diferentes', () => {
    expect(subtrair(dinheiro(1n, 'BRL'), dinheiro(1n, 'EUR')).ok).toBe(false)
  })
})

describe('negar', () => {
  it('inverte o sinal preservando a moeda', () => {
    const invertido = negar(dinheiro(1116n, 'BRL'))

    expect(invertido.centavos).toBe(-1116n)
    expect(invertido.moeda).toBe('BRL')
  })

  it('negar zero continua zero, sem zero negativo', () => {
    expect(negar(dinheiro(0n, 'BRL')).centavos).toBe(0n)
  })
})

describe('somarLista', () => {
  it('soma uma lista inteira e devolve o líquido', () => {
    const lancamentos = [
      dinheiro(720000n, 'BRL'),
      dinheiro(-31640n, 'BRL'),
      dinheiro(-2490n, 'BRL'),
      dinheiro(-14900n, 'BRL'),
    ]

    const resultado = somarLista(lancamentos, 'BRL')

    expect(resultado.ok && resultado.valor.centavos).toBe(670970n)
  })

  it('lista vazia soma zero na moeda informada', () => {
    const resultado = somarLista([], 'BRL')

    expect(resultado.ok && resultado.valor.centavos).toBe(0n)
  })

  it('recusa a lista inteira se qualquer parcela estiver em outra moeda', () => {
    const resultado = somarLista([dinheiro(100n, 'BRL'), dinheiro(100n, 'USD')], 'BRL')

    expect(resultado.ok).toBe(false)
  })
})

describe('sinalDe', () => {
  it('classifica despesa, receita e zero', () => {
    expect(sinalDe(dinheiro(-1n, 'BRL'))).toBe(-1)
    expect(sinalDe(dinheiro(1n, 'BRL'))).toBe(1)
    expect(sinalDe(dinheiro(0n, 'BRL'))).toBe(0)
  })
})

describe('ehZero', () => {
  it('reconhece a quantia nula', () => {
    expect(ehZero(dinheiro(0n, 'BRL'))).toBe(true)
    expect(ehZero(dinheiro(-1n, 'BRL'))).toBe(false)
  })
})
