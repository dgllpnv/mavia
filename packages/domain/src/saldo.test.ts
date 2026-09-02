import { describe, expect, it } from 'vitest'
import { dinheiro } from './money.js'
import {
  ehRealizado,
  resumoDoPeriodo,
  statusDeLancamento,
  type BaldesDoPeriodo,
} from './saldo.js'

/**
 * Saldo, status e o resumo do período.
 *
 * Duas perguntas diferentes que a UI precisa rotular separadamente
 * (`CONTEXT.md`, Realizado):
 *   Saldo     — só o que **se moveu** (efetivado).
 *   Realizado — o que **aconteceu**, movido ou não (efetivado + pendente).
 */

const brl = (c: bigint) => dinheiro(c, 'BRL')
const t = (iso: string) => new Date(iso)
const AGORA = t('2026-09-15T12:00:00Z')

describe('statusDeLancamento', () => {
  it('efetivado quando compensou', () => {
    expect(
      statusDeLancamento({ postedAt: t('2026-09-10T00:00:00Z'), settledAt: t('2026-09-11T00:00:00Z') }, AGORA),
    ).toBe('efetivado')
  })

  it('pendente quando já aconteceu mas não compensou', () => {
    expect(
      statusDeLancamento({ postedAt: t('2026-09-10T00:00:00Z'), settledAt: null }, AGORA),
    ).toBe('pendente')
  })

  it('previsto quando ainda não aconteceu', () => {
    expect(
      statusDeLancamento({ postedAt: t('2026-09-20T00:00:00Z'), settledAt: null }, AGORA),
    ).toBe('previsto')
  })

  it('o instante exato de agora já aconteceu', () => {
    // A fronteira é fechada à esquerda. Sem decidir isso, um lançamento no
    // segundo exato muda de balde conforme o relógio da consulta.
    expect(statusDeLancamento({ postedAt: AGORA, settledAt: null }, AGORA)).toBe('pendente')
  })

  it('compensado é efetivado mesmo com competência futura', () => {
    // O banco pode compensar antes da competência declarada; o fato manda.
    expect(
      statusDeLancamento({ postedAt: t('2026-09-20T00:00:00Z'), settledAt: t('2026-09-14T00:00:00Z') }, AGORA),
    ).toBe('efetivado')
  })
})

describe('ehRealizado', () => {
  it('efetivado e pendente contam; previsto não', () => {
    const efetivado = { postedAt: t('2026-09-10T00:00:00Z'), settledAt: t('2026-09-11T00:00:00Z') }
    const pendente = { postedAt: t('2026-09-10T00:00:00Z'), settledAt: null }
    const previsto = { postedAt: t('2026-09-20T00:00:00Z'), settledAt: null }

    expect(ehRealizado(efetivado, AGORA)).toBe(true)
    expect(ehRealizado(pendente, AGORA)).toBe(true)
    expect(ehRealizado(previsto, AGORA)).toBe(false)
  })
})

const zerado: BaldesDoPeriodo = {
  saldoAnterior: brl(0n),
  receitaRealizada: brl(0n),
  receitaPrevista: brl(0n),
  despesaRealizada: brl(0n),
  despesaPrevista: brl(0n),
  transferenciaLiquidaRealizada: brl(0n),
  transferenciaLiquidaPrevista: brl(0n),
}

describe('resumoDoPeriodo', () => {
  it('soma os baldes realizados no saldo, e os previstos no projetado', () => {
    // Saldo anterior R$ 1.000,00; recebeu R$ 200,00; gastou R$ 50,00.
    // Ainda vai receber R$ 30,00 e gastar R$ 10,00.
    const r = resumoDoPeriodo({
      ...zerado,
      saldoAnterior: brl(100000n),
      receitaRealizada: brl(20000n),
      despesaRealizada: brl(-5000n),
      receitaPrevista: brl(3000n),
      despesaPrevista: brl(-1000n),
    })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.valor.saldo.centavos).toBe(115000n) // 1000 + 200 − 50
    expect(r.valor.projetado.centavos).toBe(117000n) // + 30 − 10
  })

  it('a transferência entra no saldo da conta filtrada e nunca em receita ou despesa', () => {
    // O defeito B1: filtrando por uma conta, o rodapé mostrava R$ 1.000,00
    // quando o real era R$ 700,00, porque a transferência de R$ 300,00 saía
    // da soma e continuava na lista.
    const r = resumoDoPeriodo({
      ...zerado,
      saldoAnterior: brl(100000n),
      transferenciaLiquidaRealizada: brl(-30000n),
    })

    expect(r.ok && r.valor.saldo.centavos).toBe(70000n)
  })

  it('a identidade fecha: anterior + receita + despesa + transferência = saldo', () => {
    const baldes: BaldesDoPeriodo = {
      ...zerado,
      saldoAnterior: brl(121200n),
      receitaRealizada: brl(720000n),
      despesaRealizada: brl(-49030n),
      transferenciaLiquidaRealizada: brl(-50000n),
    }

    const r = resumoDoPeriodo(baldes)
    if (!r.ok) return

    const soma =
      baldes.saldoAnterior.centavos +
      baldes.receitaRealizada.centavos +
      baldes.despesaRealizada.centavos +
      baldes.transferenciaLiquidaRealizada.centavos

    expect(r.valor.saldo.centavos).toBe(soma)
  })

  it('período sem movimento devolve o saldo anterior intacto', () => {
    const r = resumoDoPeriodo({ ...zerado, saldoAnterior: brl(42n) })

    expect(r.ok && r.valor.saldo.centavos).toBe(42n)
    expect(r.ok && r.valor.projetado.centavos).toBe(42n)
  })

  it('recusa baldes em moedas diferentes em vez de somar', () => {
    const r = resumoDoPeriodo({ ...zerado, receitaRealizada: dinheiro(100n, 'USD') })

    expect(r.ok).toBe(false)
  })

  it('o projetado nunca é menor que o saldo quando só há receita prevista', () => {
    const r = resumoDoPeriodo({ ...zerado, receitaPrevista: brl(500n) })

    expect(r.ok && r.valor.projetado.centavos > r.valor.saldo.centavos).toBe(true)
  })
})
