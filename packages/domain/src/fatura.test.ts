import { describe, expect, it } from 'vitest'
import { ancorarDiaNoMes, faturaAlvo, janelaDaFatura, vencimentoDaFatura } from './fatura.js'
import { contem, dataCivilDe, formatarDataCivil } from './tempo.js'

/**
 * O ciclo de fatura — `docs/adr/0007-bases-temporais-do-cartao.md`.
 *
 * A parte mais difícil do domínio: uma compra acontece num dia e sai do bolso
 * noutro, e errar a janela cobra o cliente duas vezes ou não cobra nunca.
 */

const emUtc = (iso: string) => new Date(iso)
const ciclo = (closingDay: number, dueDay: number) => ({ closingDay, dueDay })

describe('ancorarDiaNoMes', () => {
  it('devolve o próprio dia quando o mês o tem', () => {
    expect(formatarDataCivil(ancorarDiaNoMes(2026, 3, 31))).toBe('2026-03-31')
  })

  it('encolhe para o último dia do mês curto', () => {
    expect(formatarDataCivil(ancorarDiaNoMes(2026, 2, 31))).toBe('2026-02-28')
  })

  it('respeita o ano bissexto', () => {
    expect(formatarDataCivil(ancorarDiaNoMes(2028, 2, 31))).toBe('2028-02-29')
  })

  it('trata abril, que tem trinta dias', () => {
    expect(formatarDataCivil(ancorarDiaNoMes(2026, 4, 31))).toBe('2026-04-30')
  })
})

describe('janelaDaFatura', () => {
  it('vai da meia-noite seguinte a um fechamento até a meia-noite seguinte ao próximo', () => {
    // Fecha dia 25. A fatura de outubro cobre 26/set 00h até 26/out 00h,
    // em São Paulo — que em UTC é 03h.
    const j = janelaDaFatura(ciclo(25, 5), { ano: 2026, mes: 10 })

    expect(j.inicio.toISOString()).toBe('2026-09-26T03:00:00.000Z')
    expect(j.fim.toISOString()).toBe('2026-10-26T03:00:00.000Z')
  })

  it('janelas consecutivas encostam exatamente, sem buraco nem sobreposição', () => {
    // A razão de a janela ser semiaberta. Com `(inicio, fim]` e datas civis,
    // o dia 26/set ficaria fora de ambas as faturas, ou o dia 25 cairia em
    // duas — e a compra seria cobrada duas vezes.
    const outubro = janelaDaFatura(ciclo(25, 5), { ano: 2026, mes: 10 })
    const novembro = janelaDaFatura(ciclo(25, 5), { ano: 2026, mes: 11 })

    expect(outubro.fim.getTime()).toBe(novembro.inicio.getTime())
  })

  it('encolhe o fechamento no mês curto sem arrastar o ajuste', () => {
    // Fecha dia 31: em fevereiro fecha dia 28, e em março volta a fechar 31.
    const marco = janelaDaFatura(ciclo(31, 10), { ano: 2026, mes: 3 })
    const abril = janelaDaFatura(ciclo(31, 10), { ano: 2026, mes: 4 })

    // A janela de março começa depois do fechamento de fevereiro (dia 28).
    expect(formatarDataCivil(dataCivilDe(marco.inicio))).toBe('2026-03-01')
    // E a de abril começa depois do fechamento de março (dia 31).
    expect(formatarDataCivil(dataCivilDe(abril.inicio))).toBe('2026-04-01')
  })
})

describe('faturaAlvo — em qual fatura a compra cai', () => {
  const c = ciclo(25, 5)

  it('compra no meio do ciclo cai na fatura do ciclo', () => {
    // 10/out está entre 26/set e 26/out: fatura de outubro.
    expect(faturaAlvo(c, emUtc('2026-10-10T15:00:00Z'))).toEqual({ ano: 2026, mes: 10 })
  })

  it('compra NO DIA do fechamento cai na fatura que fecha naquele dia', () => {
    // A regra 10 diz "compras APÓS o fechamento caem na seguinte", e o dia do
    // fechamento não é após o fechamento.
    expect(faturaAlvo(c, emUtc('2026-10-25T12:00:00Z'))).toEqual({ ano: 2026, mes: 10 })
  })

  it('compra às 23h59 do dia do fechamento ainda cai na fatura que fecha', () => {
    // 23h59 de 25/out em São Paulo é 02h59 de 26/out em UTC.
    expect(faturaAlvo(c, emUtc('2026-10-26T02:59:00Z'))).toEqual({ ano: 2026, mes: 10 })
  })

  it('compra no dia seguinte ao fechamento cai na fatura seguinte', () => {
    expect(faturaAlvo(c, emUtc('2026-10-26T12:00:00Z'))).toEqual({ ano: 2026, mes: 11 })
  })

  it('a compra sempre cai numa fatura cuja janela a contém', () => {
    // A propriedade que amarra as duas funções: se elas divergirem, existe
    // compra que some ou que é cobrada duas vezes.
    for (const iso of [
      '2026-01-01T03:00:00Z',
      '2026-02-28T23:00:00Z',
      '2026-10-25T12:00:00Z',
      '2026-10-26T03:00:00Z',
      '2026-12-31T23:59:00Z',
    ]) {
      const instante = emUtc(iso)
      const alvo = faturaAlvo(c, instante)
      expect(contem(janelaDaFatura(c, alvo), instante)).toBe(true)
    }
  })
})

describe('vencimentoDaFatura', () => {
  it('vence no mês da competência quando o vencimento é depois do fechamento', () => {
    // Fecha 25, vence 5: o vencimento cai no mês SEGUINTE ao do fechamento.
    // A fatura de outubro fecha em 25/out e vence em 05/nov.
    expect(formatarDataCivil(vencimentoDaFatura(ciclo(25, 5), { ano: 2026, mes: 10 }))).toBe(
      '2026-11-05',
    )
  })

  it('vence no mesmo mês quando o dia do vencimento é posterior ao do fechamento', () => {
    // Fecha 5, vence 15: fecha em 05/out e vence em 15/out.
    expect(formatarDataCivil(vencimentoDaFatura(ciclo(5, 15), { ano: 2026, mes: 10 }))).toBe(
      '2026-10-15',
    )
  })

  it('encolhe o vencimento no mês curto', () => {
    // Fecha 20, vence 31: a fatura de fevereiro vence em 28/fev.
    expect(formatarDataCivil(vencimentoDaFatura(ciclo(20, 31), { ano: 2026, mes: 2 }))).toBe(
      '2026-02-28',
    )
  })

  it('vencimento no mesmo dia do fechamento cai no mês seguinte', () => {
    // Fechar e vencer no mesmo dia significaria pagar antes de saber o total.
    expect(formatarDataCivil(vencimentoDaFatura(ciclo(10, 10), { ano: 2026, mes: 10 }))).toBe(
      '2026-11-10',
    )
  })

  it('o vencimento é sempre posterior ao fechamento', () => {
    for (const [fecha, vence] of [
      [1, 2],
      [25, 5],
      [15, 15],
      [31, 1],
      [5, 28],
    ] as const) {
      const competencia = { ano: 2026, mes: 6 }
      const janela = janelaDaFatura(ciclo(fecha, vence), competencia)
      const venc = vencimentoDaFatura(ciclo(fecha, vence), competencia)
      // O fim da janela é a meia-noite seguinte ao fechamento; o vencimento
      // nunca pode ser anterior a ele.
      expect(venc.ano * 10000 + venc.mes * 100 + venc.dia).toBeGreaterThanOrEqual(
        Number(formatarDataCivil(dataCivilDe(janela.fim)).replaceAll('-', '')),
      )
    }
  })
})
