import { describe, expect, it } from 'vitest'
import { dinheiro } from './money.js'
import { BALDES, type Balde } from './balde.js'
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

/** Monta um resumo indexado pelo enum, preenchendo o que não foi informado. */
const comBaldes = (
  saldoAnterior: bigint,
  parciais: Partial<Record<Balde, { realizada?: bigint; prevista?: bigint }>> = {},
): BaldesDoPeriodo => ({
  saldoAnterior: brl(saldoAnterior),
  baldes: Object.fromEntries(
    BALDES.map((b) => [
      b,
      {
        realizada: brl(parciais[b]?.realizada ?? 0n),
        prevista: brl(parciais[b]?.prevista ?? 0n),
      },
    ]),
  ) as Record<Balde, { realizada: ReturnType<typeof brl>; prevista: ReturnType<typeof brl> }>,
})

describe('resumoDoPeriodo', () => {
  it('soma os realizados no saldo, e os previstos no projetado', () => {
    // Saldo anterior R$ 1.000,00; recebeu R$ 200,00; gastou R$ 50,00.
    // Ainda vai receber R$ 30,00 e gastar R$ 10,00.
    const r = resumoDoPeriodo(
      comBaldes(100000n, {
        receita: { realizada: 20000n, prevista: 3000n },
        despesa: { realizada: -5000n, prevista: -1000n },
      }),
    )

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.valor.saldo.centavos).toBe(115000n) // 1000 + 200 − 50
    expect(r.valor.projetado.centavos).toBe(117000n) // + 30 − 10
  })

  it('a transferência entra no saldo da conta filtrada e nunca em receita ou despesa', () => {
    // O defeito B1: filtrando por uma conta, o rodapé mostrava R$ 1.000,00
    // quando o real era R$ 700,00, porque a transferência de R$ 300,00 saía
    // da soma e continuava na lista.
    const r = resumoDoPeriodo(comBaldes(100000n, { transferencia: { realizada: -30000n } }))

    expect(r.ok && r.valor.saldo.centavos).toBe(70000n)
  })

  it('o balde não analítico entra no saldo — é ele que faz a identidade fechar', () => {
    // "Ajuste de saldo" altera o saldo e não é gasto nem ganho. Sem balde
    // próprio, ele move o saldo sem aparecer no rodapé.
    const r = resumoDoPeriodo(comBaldes(100000n, { nao_analitica: { realizada: 5000n } }))

    expect(r.ok && r.valor.saldo.centavos).toBe(105000n)
  })

  it('a identidade decorre da exaustividade: anterior + todos os baldes = saldo', () => {
    const entrada = comBaldes(121200n, {
      receita: { realizada: 720000n },
      despesa: { realizada: -49030n },
      transferencia: { realizada: -50000n },
      nao_analitica: { realizada: 300n },
    })

    const r = resumoDoPeriodo(entrada)
    if (!r.ok) return

    const soma =
      entrada.saldoAnterior.centavos +
      BALDES.reduce((acc, b) => acc + entrada.baldes[b].realizada.centavos, 0n)

    expect(r.valor.saldo.centavos).toBe(soma)
  })

  it('período sem movimento devolve o saldo anterior intacto', () => {
    const r = resumoDoPeriodo(comBaldes(42n))

    expect(r.ok && r.valor.saldo.centavos).toBe(42n)
    expect(r.ok && r.valor.projetado.centavos).toBe(42n)
  })

  it('recusa baldes em moedas diferentes em vez de somar', () => {
    const base = comBaldes(0n)
    const r = resumoDoPeriodo({
      ...base,
      baldes: { ...base.baldes, receita: { realizada: dinheiro(100n, 'USD'), prevista: brl(0n) } },
    })

    expect(r.ok).toBe(false)
  })

  it('o projetado nunca é menor que o saldo quando só há receita prevista', () => {
    const r = resumoDoPeriodo(comBaldes(0n, { receita: { prevista: 500n } }))

    expect(r.ok && r.valor.projetado.centavos > r.valor.saldo.centavos).toBe(true)
  })
})
