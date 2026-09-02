import { describe, expect, it } from 'vitest'
import { dinheiro } from './money.js'
import { faturaAlvo } from './fatura.js'
import { gerarParcelas } from './parcelamento.js'
import { dataCivilDe, formatarDataCivil } from './tempo.js'

/**
 * Parcelamento — `docs/adr/0007` §2 e ADR 0005.
 *
 * Duas regras que a soma não detecta: a distribuição do resto, e a ancoragem
 * de dia do mês sem arrastar o ajuste.
 */

const brl = (c: bigint) => dinheiro(c, 'BRL')
const emSaoPaulo = (dia: string) => new Date(`${dia}T15:00:00Z`) // 12h em SP
const datas = (r: { ok: true; valor: { postedAt: Date }[] } | { ok: false }) =>
  r.ok ? r.valor.map((p) => formatarDataCivil(dataCivilDe(p.postedAt))) : []
const valores = (r: { ok: true; valor: { valor: { centavos: bigint } }[] } | { ok: false }) =>
  r.ok ? r.valor.map((p) => p.valor.centavos) : []

describe('gerarParcelas — valores', () => {
  it('divide igualmente quando a divisão é exata', () => {
    const r = gerarParcelas(brl(-9000n), 3, emSaoPaulo('2026-03-10'))

    expect(valores(r)).toEqual([-3000n, -3000n, -3000n])
  })

  it('distribui o resto nas primeiras parcelas, uma unidade por parcela', () => {
    // R$ 100,00 em 7x. A regra rejeitada daria −1432 na primeira e −1428 nas
    // demais; as duas somam −10000, e só a distribuição as distingue.
    const r = gerarParcelas(brl(-10000n), 7, emSaoPaulo('2026-03-10'))

    expect(valores(r)).toEqual([-1429n, -1429n, -1429n, -1429n, -1428n, -1428n, -1428n])
  })

  it('a soma das parcelas é exatamente o valor da compra', () => {
    for (const [total, n] of [
      [-10000n, 3],
      [-10000n, 7],
      [-99999n, 12],
      [-1n, 1],
      [-123457n, 11],
    ] as const) {
      const r = gerarParcelas(brl(total), n, emSaoPaulo('2026-03-10'))
      expect(valores(r).reduce((a, b) => a + b, 0n)).toBe(total)
    }
  })

  it('preserva o sinal: compra parcelada gera parcelas negativas', () => {
    // `valor_total` carrega o sinal do domínio. Guardá-lo como magnitude
    // positiva faria a invariante `Σ filhos = valor_total` falhar invertida —
    // num teste que ninguém suspeitaria de estar errado.
    const r = gerarParcelas(brl(-10000n), 3, emSaoPaulo('2026-03-10'))

    expect(valores(r).every((v) => v < 0n)).toBe(true)
  })

  it('recusa parcelamento indivisível', () => {
    // R$ 0,01 em 3x produziria duas parcelas de valor zero, que `Lancamento`
    // proíbe. Gerar menos parcelas do que o usuário pediu mentiria sobre o
    // parcelamento; relaxar `valor ≠ 0` abriria lançamento nulo no sistema todo.
    const r = gerarParcelas(brl(-1n), 3, emSaoPaulo('2026-03-10'))

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.erro.tipo).toBe('parcelamento-indivisivel')
  })

  it('aceita exatamente um centavo por parcela', () => {
    const r = gerarParcelas(brl(-3n), 3, emSaoPaulo('2026-03-10'))

    expect(valores(r)).toEqual([-1n, -1n, -1n])
  })

  it('recusa número de parcelas inválido', () => {
    expect(gerarParcelas(brl(-10000n), 0, emSaoPaulo('2026-03-10')).ok).toBe(false)
    expect(gerarParcelas(brl(-10000n), -3, emSaoPaulo('2026-03-10')).ok).toBe(false)
    expect(gerarParcelas(brl(-10000n), 2.5, emSaoPaulo('2026-03-10')).ok).toBe(false)
  })
})

describe('gerarParcelas — datas', () => {
  it('a primeira parcela é na data da compra', () => {
    const r = gerarParcelas(brl(-30000n), 3, emSaoPaulo('2026-03-10'))

    expect(datas(r)[0]).toBe('2026-03-10')
  })

  it('cada parcela avança um mês', () => {
    const r = gerarParcelas(brl(-30000n), 3, emSaoPaulo('2026-03-10'))

    expect(datas(r)).toEqual(['2026-03-10', '2026-04-10', '2026-05-10'])
  })

  it('31 de janeiro em 3x não arrasta o ajuste de fevereiro', () => {
    // O caso que o `arquiteto-dominio-financeiro` vetou explicitamente:
    // 31/jan, 28/fev, **31**/mar — nunca 28/mar.
    const r = gerarParcelas(brl(-30000n), 3, emSaoPaulo('2026-01-31'))

    expect(datas(r)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31'])
  })

  it('respeita o ano bissexto no meio do parcelamento', () => {
    const r = gerarParcelas(brl(-30000n), 3, emSaoPaulo('2028-01-31'))

    expect(datas(r)).toEqual(['2028-01-31', '2028-02-29', '2028-03-31'])
  })

  it('vira o ano', () => {
    const r = gerarParcelas(brl(-30000n), 3, emSaoPaulo('2026-11-15'))

    expect(datas(r)).toEqual(['2026-11-15', '2026-12-15', '2027-01-15'])
  })

  it('29 de fevereiro em 12x volta a 29 no bissexto seguinte', () => {
    // Compra em 29/02/2028; a parcela 12 é em janeiro de 2029, e a de
    // fevereiro de 2029 (não bissexto) encolhe para 28.
    const r = gerarParcelas(brl(-120000n), 13, emSaoPaulo('2028-02-29'))
    const d = datas(r)

    expect(d[0]).toBe('2028-02-29')
    expect(d[12]).toBe('2029-02-28')
  })

  it('parcelamento longo mantém o dia sempre que o mês permite', () => {
    const r = gerarParcelas(brl(-360000n), 12, emSaoPaulo('2026-01-31'))
    const d = datas(r)

    // Só os meses curtos encolhem; os de 31 dias voltam ao 31.
    expect(d[0]).toBe('2026-01-31')
    expect(d[1]).toBe('2026-02-28')
    expect(d[2]).toBe('2026-03-31')
    expect(d[3]).toBe('2026-04-30')
    expect(d[4]).toBe('2026-05-31')
  })
})

describe('gerarParcelas — numeração', () => {
  it('numera de 1 a N, com o total em cada parcela', () => {
    const r = gerarParcelas(brl(-30000n), 3, emSaoPaulo('2026-03-10'))

    expect(r.ok && r.valor.map((p) => `${p.numero}/${p.total}`)).toEqual(['1/3', '2/3', '3/3'])
  })

  it('em uma parcela, devolve o total intacto', () => {
    const r = gerarParcelas(brl(-10000n), 1, emSaoPaulo('2026-03-10'))

    expect(valores(r)).toEqual([-10000n])
    expect(r.ok && r.valor[0]?.numero).toBe(1)
  })
})

describe('CT-2 — as parcelas caem em faturas consecutivas', () => {
  const fecha30 = { closingDay: 30, dueDay: 10 }

  it('12x nunca colide, mesmo com fechamento perto do fim do mês', () => {
    // O contraexemplo da auditoria: compra em 31/01 num cartão que fecha dia
    // 30. Derivando a fatura da data da parcela, a 1 (31/jan) e a 2 (28/fev)
    // caíam ambas em fevereiro — 12 parcelas em 7 faturas, uma cobrando o
    // dobro e outra nada.
    const r = gerarParcelas(brl(-120000n), 12, emSaoPaulo('2026-01-31'), fecha30)
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const faturas = r.valor.map((p) => `${p.mesDeFechamentoDaFatura.ano}-${p.mesDeFechamentoDaFatura.mes}`)
    expect(new Set(faturas).size).toBe(12)
  })

  it('as faturas são consecutivas, uma por parcela', () => {
    const r = gerarParcelas(brl(-30000n), 3, emSaoPaulo('2026-01-31'), fecha30)
    if (!r.ok) return

    const faturas = r.valor.map((p) => p.mesDeFechamentoDaFatura)
    for (let i = 1; i < faturas.length; i++) {
      const anterior = faturas[i - 1]!
      const atual = faturas[i]!
      const distancia = (atual.ano - anterior.ano) * 12 + (atual.mes - anterior.mes)
      expect(distancia).toBe(1)
    }
  })

  it('a primeira parcela cai na fatura da compra', () => {
    const compra = emSaoPaulo('2026-03-10')
    const r = gerarParcelas(brl(-30000n), 3, compra, fecha30)
    if (!r.ok) return

    expect(r.valor[0]?.mesDeFechamentoDaFatura).toEqual(faturaAlvo(fecha30, compra))
  })

  it('sem ciclo, a competência é a do mês da compra — parcelamento em conta', () => {
    const r = gerarParcelas(brl(-30000n), 3, emSaoPaulo('2026-03-10'))
    if (!r.ok) return

    expect(r.valor.map((p) => p.mesDeFechamentoDaFatura.mes)).toEqual([3, 4, 5])
  })

  it('nenhum fechamento de 1 a 31 produz colisão em 24x', () => {
    // A propriedade que fecha o buraco inteiro, em vez do caso conhecido.
    for (let closingDay = 1; closingDay <= 31; closingDay++) {
      const r = gerarParcelas(brl(-240000n), 24, emSaoPaulo('2026-01-31'), {
        closingDay,
        dueDay: 10,
      })
      if (!r.ok) continue
      const faturas = r.valor.map((p) => `${p.mesDeFechamentoDaFatura.ano}-${p.mesDeFechamentoDaFatura.mes}`)
      expect(new Set(faturas).size).toBe(24)
    }
  })
})
