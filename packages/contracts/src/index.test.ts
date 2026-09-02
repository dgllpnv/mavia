import { describe, expect, it } from 'vitest'
import { incluiNoSaldoGeralPorPadrao, zCentavos, zCriarConta } from './index.js'

/**
 * O contrato é a borda: nada entra no domínio sem passar por aqui.
 *
 * Estes testes guardam sobretudo a forma do dinheiro na rede, que é onde a
 * regra 1 do `CLAUDE.md` mais corre risco — no ponto em que o valor deixa de
 * ser `bigint` e vira JSON.
 */

describe('zCentavos — dinheiro na rede', () => {
  it('aceita inteiro em string, positivo e negativo', () => {
    expect(zCentavos.safeParse('0').success).toBe(true)
    expect(zCentavos.safeParse('150000').success).toBe(true)
    expect(zCentavos.safeParse('-1116').success).toBe(true)
  })

  it('aceita valor maior que o inteiro seguro do JavaScript', () => {
    // 2^53 centavos. É por isto que o transporte é string: `number` perderia
    // precisão silenciosamente, e o erro apareceria como centavo faltando.
    const grande = '9007199254740993'
    expect(zCentavos.safeParse(grande).success).toBe(true)
    expect(BigInt(grande).toString()).toBe(grande)
  })

  it('recusa número, porque number perde precisão', () => {
    expect(zCentavos.safeParse(150000).success).toBe(false)
  })

  it('recusa valor fracionário — centavo é a menor unidade', () => {
    expect(zCentavos.safeParse('10.50').success).toBe(false)
    expect(zCentavos.safeParse('10,50').success).toBe(false)
  })

  it('recusa separador de milhar e símbolo de moeda', () => {
    expect(zCentavos.safeParse('1.500').success).toBe(false)
    expect(zCentavos.safeParse('R$ 1500').success).toBe(false)
  })

  it('recusa vazio e texto', () => {
    expect(zCentavos.safeParse('').success).toBe(false)
    expect(zCentavos.safeParse('abc').success).toBe(false)
  })
})

describe('zCriarConta', () => {
  it('exige nome e apara espaços', () => {
    expect(zCriarConta.safeParse({ nome: '' }).success).toBe(false)
    expect(zCriarConta.safeParse({ nome: '   ' }).success).toBe(false)

    const r = zCriarConta.safeParse({ nome: '  Nubank  ' })
    expect(r.success && r.data.nome).toBe('Nubank')
  })

  it('aplica os padrões de tipo, saldo e moeda', () => {
    const r = zCriarConta.safeParse({ nome: 'Conta' })

    expect(r.success && r.data).toMatchObject({
      tipo: 'corrente',
      saldoInicialCentavos: '0',
      moeda: 'BRL',
    })
  })

  it('recusa tipo fora do conjunto conhecido', () => {
    expect(zCriarConta.safeParse({ nome: 'X', tipo: 'cripto' }).success).toBe(false)
  })

  it('deixa incluirNoSaldoGeral ausente, para o padrão do tipo decidir', () => {
    const r = zCriarConta.safeParse({ nome: 'X' })
    expect(r.success && 'incluirNoSaldoGeral' in r.data).toBe(false)
  })
})

describe('incluiNoSaldoGeralPorPadrao', () => {
  it('investimento nasce fora do saldo geral', () => {
    // Patrimônio investido inflando o número principal faz o número mentir
    // sobre quanto há disponível (`CONTEXT.md`, Conta).
    expect(incluiNoSaldoGeralPorPadrao('investimento')).toBe(false)
  })

  it('todos os demais nascem dentro', () => {
    for (const tipo of ['corrente', 'poupanca', 'dinheiro', 'digital', 'outra'] as const) {
      expect(incluiNoSaldoGeralPorPadrao(tipo)).toBe(true)
    }
  })
})
