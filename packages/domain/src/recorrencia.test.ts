import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { ocorrencias, proximaOcorrencia, type RegraDeRecorrencia } from './recorrencia.js'

const mensal = (diaDoMes: number, inicio = { ano: 2026, mes: 1 }): RegraDeRecorrencia => ({
  diaDoMes,
  intervaloMeses: 1,
  inicio,
  fim: null,
})

describe('ancoragem do dia do mês', () => {
  it('**dia 31 vira 28 em fevereiro e volta a 31 em março**', () => {
    // A regra que estava reescrita em quatro lugares antes de virar termo do
    // glossário. O ajuste **não é arrastado**: fevereiro não contamina março.
    const r = ocorrencias(mensal(31), { ano: 2026, mes: 1 }, { ano: 2026, mes: 4 })

    expect(r.map((o) => o.data)).toEqual([
      { ano: 2026, mes: 1, dia: 31 },
      { ano: 2026, mes: 2, dia: 28 },
      { ano: 2026, mes: 3, dia: 31 },
      { ano: 2026, mes: 4, dia: 30 },
    ])
  })

  it('fevereiro de ano bissexto recebe 29', () => {
    const r = ocorrencias(mensal(31, { ano: 2028, mes: 2 }), { ano: 2028, mes: 2 }, { ano: 2028, mes: 2 })

    expect(r[0]?.data).toEqual({ ano: 2028, mes: 2, dia: 29 })
  })

  it('dia 1 nunca é ajustado', () => {
    const r = ocorrencias(mensal(1), { ano: 2026, mes: 1 }, { ano: 2026, mes: 3 })

    expect(r.map((o) => o.data.dia)).toEqual([1, 1, 1])
  })
})

describe('nunca pula, nunca transborda', () => {
  it('**todo mês do horizonte recebe exatamente uma ocorrência**', () => {
    // Pular faz o mês perder o lançamento e o teto ficar verde indevidamente.
    // Transbordar dá duas ocorrências ao mês seguinte e estoura o teto dele.
    const r = ocorrencias(mensal(31), { ano: 2026, mes: 1 }, { ano: 2026, mes: 12 })

    expect(r).toHaveLength(12)
    expect(r.map((o) => o.competencia.mes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })
})

describe('a identidade é a competência, e não a data', () => {
  it('mudar o dia da regra reposiciona a ocorrência dentro da mesma competência', () => {
    // Com a data na chave, alterar `dia_do_mes` faria o job materializar tudo
    // de novo — e o mês teria duas ocorrências da mesma regra.
    const antes = ocorrencias(mensal(5), { ano: 2026, mes: 3 }, { ano: 2026, mes: 3 })
    const depois = ocorrencias(mensal(20), { ano: 2026, mes: 3 }, { ano: 2026, mes: 3 })

    expect(antes[0]?.competencia).toEqual(depois[0]?.competencia)
    expect(antes[0]?.data.dia).not.toBe(depois[0]?.data.dia)
  })
})

describe('intervalo', () => {
  it('anual ocorre uma vez por ano, no mês de início', () => {
    const anual: RegraDeRecorrencia = {
      diaDoMes: 10,
      intervaloMeses: 12,
      inicio: { ano: 2026, mes: 3 },
      fim: null,
    }

    const r = ocorrencias(anual, { ano: 2026, mes: 1 }, { ano: 2028, mes: 12 })

    expect(r.map((o) => o.competencia)).toEqual([
      { ano: 2026, mes: 3 },
      { ano: 2027, mes: 3 },
      { ano: 2028, mes: 3 },
    ])
  })

  it('bimestral pula o mês intermediário, contado a partir do início', () => {
    const bimestral: RegraDeRecorrencia = {
      diaDoMes: 15,
      intervaloMeses: 2,
      inicio: { ano: 2026, mes: 1 },
      fim: null,
    }

    const r = ocorrencias(bimestral, { ano: 2026, mes: 1 }, { ano: 2026, mes: 6 })

    expect(r.map((o) => o.competencia.mes)).toEqual([1, 3, 5])
  })

  it('**o horizonte não desloca a fase**', () => {
    // Começar a listar em fevereiro não faz a bimestral de janeiro virar
    // fevereiro: a fase vem do início da regra, sempre.
    const bimestral: RegraDeRecorrencia = {
      diaDoMes: 15,
      intervaloMeses: 2,
      inicio: { ano: 2026, mes: 1 },
      fim: null,
    }

    const r = ocorrencias(bimestral, { ano: 2026, mes: 2 }, { ano: 2026, mes: 6 })

    expect(r.map((o) => o.competencia.mes)).toEqual([3, 5])
  })
})

describe('limites', () => {
  it('nada antes do início', () => {
    const r = ocorrencias(mensal(10, { ano: 2026, mes: 6 }), { ano: 2026, mes: 1 }, { ano: 2026, mes: 7 })

    expect(r.map((o) => o.competencia.mes)).toEqual([6, 7])
  })

  it('o fim é inclusivo: o mês do fim ainda ocorre', () => {
    const r = ocorrencias(
      { diaDoMes: 10, intervaloMeses: 1, inicio: { ano: 2026, mes: 1 }, fim: { ano: 2026, mes: 3 } },
      { ano: 2026, mes: 1 },
      { ano: 2026, mes: 12 },
    )

    expect(r.map((o) => o.competencia.mes)).toEqual([1, 2, 3])
  })

  it('horizonte invertido devolve lista vazia, e não lança', () => {
    expect(ocorrencias(mensal(10), { ano: 2026, mes: 5 }, { ano: 2026, mes: 2 })).toEqual([])
  })

  it('dia fora de 1..31 é recusado', () => {
    expect(() => ocorrencias(mensal(0), { ano: 2026, mes: 1 }, { ano: 2026, mes: 1 })).toThrow()
    expect(() => ocorrencias(mensal(32), { ano: 2026, mes: 1 }, { ano: 2026, mes: 1 })).toThrow()
  })

  it('intervalo menor que um mês é recusado', () => {
    const r: RegraDeRecorrencia = {
      diaDoMes: 1,
      intervaloMeses: 0,
      inicio: { ano: 2026, mes: 1 },
      fim: null,
    }

    expect(() => ocorrencias(r, { ano: 2026, mes: 1 }, { ano: 2026, mes: 3 })).toThrow()
  })
})

describe('próxima ocorrência', () => {
  it('a partir de uma competência, a próxima que a regra produz', () => {
    expect(proximaOcorrencia(mensal(10), { ano: 2026, mes: 4 })?.competencia).toEqual({
      ano: 2026,
      mes: 4,
    })
  })

  it('regra encerrada não tem próxima', () => {
    const encerrada: RegraDeRecorrencia = {
      diaDoMes: 10,
      intervaloMeses: 1,
      inicio: { ano: 2026, mes: 1 },
      fim: { ano: 2026, mes: 3 },
    }

    expect(proximaOcorrencia(encerrada, { ano: 2026, mes: 4 })).toBeNull()
  })
})

describe('propriedades', () => {
  const dia = fc.integer({ min: 1, max: 31 })
  const ano = fc.integer({ min: 2020, max: 2040 })
  const mes = fc.integer({ min: 1, max: 12 })

  it('a data de toda ocorrência cai no mês da sua competência', () => {
    // O que a palavra "transbordar" significa: 31 de fevereiro virando 3 de
    // março daria a março duas ocorrências e a fevereiro nenhuma.
    fc.assert(
      fc.property(dia, ano, mes, (d, a, m) => {
        const r = ocorrencias(mensal(d, { ano: a, mes: m }), { ano: a, mes: m }, { ano: a + 2, mes: m })

        for (const o of r) {
          expect(o.data.ano).toBe(o.competencia.ano)
          expect(o.data.mes).toBe(o.competencia.mes)
        }
      }),
    )
  })

  it('**o ajuste nunca é arrastado**: o dia é o da regra sempre que o mês o tem', () => {
    fc.assert(
      fc.property(dia, ano, (d, a) => {
        const r = ocorrencias(mensal(d, { ano: a, mes: 1 }), { ano: a, mes: 1 }, { ano: a, mes: 12 })

        for (const o of r) {
          const ultimoDia = new Date(Date.UTC(o.competencia.ano, o.competencia.mes, 0)).getUTCDate()
          expect(o.data.dia).toBe(Math.min(d, ultimoDia))
        }
      }),
    )
  })

  it('a competência de cada ocorrência é única', () => {
    // A identidade `(tenant, recorrencia, competencia)` só é chave se a regra
    // nunca produzir duas ocorrências no mesmo mês.
    fc.assert(
      fc.property(dia, fc.integer({ min: 1, max: 12 }), (d, intervalo) => {
        const r = ocorrencias(
          { diaDoMes: d, intervaloMeses: intervalo, inicio: { ano: 2026, mes: 1 }, fim: null },
          { ano: 2026, mes: 1 },
          { ano: 2030, mes: 12 },
        )

        const chaves = r.map((o) => `${o.competencia.ano}-${o.competencia.mes}`)
        expect(new Set(chaves).size).toBe(chaves.length)
      }),
    )
  })
})
