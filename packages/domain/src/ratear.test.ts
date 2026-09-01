import { describe, expect, it } from 'vitest'
import { dinheiro, type Money } from './money.js'
import { ratear } from './ratear.js'

// Regras que estes testes protegem:
//   CLAUDE.md §2, regra 3
//   docs/adr/0005-dinheiro-centavos-partida-dobrada.md
//   docs/validacao/auditoria-financeira-spec.md (o achado das duas regras)

const brl = (centavos: bigint): Money => dinheiro(centavos, 'BRL')
const centavosDe = (partes: readonly Money[]): bigint[] => partes.map((p) => p.centavos)

describe('ratear', () => {
  it('divide em partes iguais quando a divisão é exata', () => {
    const resultado = ratear(brl(9000n), 3)

    expect(resultado.ok && centavosDe(resultado.valor)).toEqual([3000n, 3000n, 3000n])
  })

  it('distribui o resto uma unidade por parte, nas primeiras', () => {
    // R$ 100,00 em 3x: resto 1, vai só para a primeira parcela
    const resultado = ratear(brl(10000n), 3)

    expect(resultado.ok && centavosDe(resultado.valor)).toEqual([3334n, 3333n, 3333n])
  })

  it('é o contraexemplo da auditoria: R$ 100,00 em 7x não põe todo o resto na primeira', () => {
    // A regra rejeitada produziria [1432, 1428, 1428, 1428, 1428, 1428, 1428].
    // As duas somam 10000; só a distribuição as distingue.
    const resultado = ratear(brl(10000n), 7)

    expect(resultado.ok && centavosDe(resultado.valor)).toEqual([
      1429n, 1429n, 1429n, 1429n, 1428n, 1428n, 1428n,
    ])
  })

  it('coincide com a regra rejeitada em 3x, que é por isso que o erro passou despercebido', () => {
    const resultado = ratear(brl(10000n), 3)
    const regraRejeitada = [3334n, 3333n, 3333n] // "todo o resto na primeira"

    expect(resultado.ok && centavosDe(resultado.valor)).toEqual(regraRejeitada)
  })

  it('opera sobre a magnitude e reaplica o sinal', () => {
    // Truncamento direto de negativo daria [-3332, -3333, -3335], que também soma -10000.
    const resultado = ratear(brl(-10000n), 3)

    expect(resultado.ok && centavosDe(resultado.valor)).toEqual([-3334n, -3333n, -3333n])
  })

  it('devolve partes de valor zero quando a magnitude é menor que o número de partes', () => {
    // Para o value object isto é correto. Quem recusa R$ 0,01 em 3x é o
    // GrupoDeParcelamento, porque Lancamento exige valor diferente de zero.
    const resultado = ratear(brl(1n), 3)

    expect(resultado.ok && centavosDe(resultado.valor)).toEqual([1n, 0n, 0n])
  })

  it('preserva a moeda em todas as partes', () => {
    const resultado = ratear(dinheiro(10000n, 'USD'), 3)

    expect(resultado.ok && resultado.valor.every((p) => p.moeda === 'USD')).toBe(true)
  })

  it('divide zero em partes de zero', () => {
    const resultado = ratear(brl(0n), 4)

    expect(resultado.ok && centavosDe(resultado.valor)).toEqual([0n, 0n, 0n, 0n])
  })

  it('em uma parte devolve o total intacto', () => {
    const resultado = ratear(brl(1116n), 1)

    expect(resultado.ok && centavosDe(resultado.valor)).toEqual([1116n])
  })

  it('recusa zero partes', () => {
    const resultado = ratear(brl(10000n), 0)

    expect(resultado.ok).toBe(false)
    if (resultado.ok) return
    expect(resultado.erro).toEqual({ tipo: 'partes-invalidas', partes: 0 })
  })

  it('recusa número negativo de partes', () => {
    expect(ratear(brl(10000n), -3).ok).toBe(false)
  })

  it('recusa número fracionário de partes', () => {
    expect(ratear(brl(10000n), 2.5).ok).toBe(false)
  })
})
