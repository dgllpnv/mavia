import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  competenciaDe,
  competenciaSeguinte,
  contem,
  dataCivilDe,
  formatarDataCivil,
  inicioDoDiaCivil,
  janelaDaCompetencia,
  type Competencia,
} from './tempo.js'

/**
 * A faixa cobre 2015 a 2035 de propósito: o Brasil teve horário de verão até
 * 2019, então este intervalo contém transições reais. Testar só datas futuras
 * esconderia justamente a classe de bug que estas propriedades existem para
 * pegar.
 */
const instantes = fc.date({
  min: new Date('2015-01-01T00:00:00Z'),
  max: new Date('2035-12-31T23:59:59Z'),
  noInvalidDate: true,
})

const competencias: fc.Arbitrary<Competencia> = fc
  .tuple(fc.integer({ min: 2015, max: 2035 }), fc.integer({ min: 1, max: 12 }))
  .map(([ano, mes]) => ({ ano, mes }))

describe('competência e janela — invariantes', () => {
  it('todo instante cai dentro da janela da própria competência', () => {
    // A invariante central deste módulo. Um erro de fuso — ler o mês do UTC
    // nu, ou usar offset fixo — quebra esta propriedade em algum instante
    // perto da virada do mês, que é exatamente onde ninguém testa à mão.
    fc.assert(
      fc.property(instantes, (instante) => {
        const janela = janelaDaCompetencia(competenciaDe(instante))
        expect(contem(janela, instante)).toBe(true)
      }),
    )
  })

  it('nenhum instante cai na janela de outra competência', () => {
    fc.assert(
      fc.property(instantes, (instante) => {
        const propria = competenciaDe(instante)
        const anterior = janelaDaCompetencia(
          propria.mes === 1
            ? { ano: propria.ano - 1, mes: 12 }
            : { ano: propria.ano, mes: propria.mes - 1 },
        )
        const seguinte = janelaDaCompetencia(competenciaSeguinte(propria))
        expect(contem(anterior, instante)).toBe(false)
        expect(contem(seguinte, instante)).toBe(false)
      }),
    )
  })

  it('janelas consecutivas encostam exatamente, sem buraco nem sobreposição', () => {
    fc.assert(
      fc.property(competencias, (c) => {
        const atual = janelaDaCompetencia(c)
        const proxima = janelaDaCompetencia(competenciaSeguinte(c))
        expect(atual.fim.getTime()).toBe(proxima.inicio.getTime())
      }),
    )
  })

  it('a janela nunca é vazia nem invertida', () => {
    fc.assert(
      fc.property(competencias, (c) => {
        const janela = janelaDaCompetencia(c)
        expect(janela.fim.getTime() > janela.inicio.getTime()).toBe(true)
      }),
    )
  })

  it('o início da janela é sempre o dia 1 da competência, no fuso', () => {
    fc.assert(
      fc.property(competencias, (c) => {
        const civil = dataCivilDe(janelaDaCompetencia(c).inicio)
        expect(civil).toEqual({ ano: c.ano, mes: c.mes, dia: 1 })
      }),
    )
  })

  it('a duração de um mês está entre 28 e 31 dias, com folga para transições', () => {
    // Não fixamos o número exato: horário de verão faz o mês da transição
    // ter uma hora a mais ou a menos, e é correto que tenha.
    fc.assert(
      fc.property(competencias, (c) => {
        const janela = janelaDaCompetencia(c)
        const horas = (janela.fim.getTime() - janela.inicio.getTime()) / 3_600_000
        expect(horas >= 27 * 24 && horas <= 32 * 24).toBe(true)
      }),
    )
  })
})

describe('data civil — invariantes', () => {
  it('o dia civil da meia-noite de um dia é o próprio dia', () => {
    // Sobrevive ao dia em que a meia-noite local não existiu: a resolução
    // para frente preserva o dia civil pedido.
    fc.assert(
      fc.property(
        fc.integer({ min: 2015, max: 2035 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        (ano, mes, dia) => {
          expect(dataCivilDe(inicioDoDiaCivil({ ano, mes, dia }))).toEqual({ ano, mes, dia })
        },
      ),
    )
  })

  it('formata sempre com dez caracteres, no formato AAAA-MM-DD', () => {
    fc.assert(
      fc.property(instantes, (instante) => {
        const texto = formatarDataCivil(dataCivilDe(instante))
        expect(texto).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      }),
    )
  })
})

describe('competenciaSeguinte — invariantes', () => {
  it('doze avanços somam exatamente um ano, e o mês volta ao mesmo', () => {
    fc.assert(
      fc.property(competencias, (c) => {
        let atual = c
        for (let i = 0; i < 12; i++) atual = competenciaSeguinte(atual)
        expect(atual).toEqual({ ano: c.ano + 1, mes: c.mes })
      }),
    )
  })

  it('o mês resultante está sempre entre 1 e 12', () => {
    fc.assert(
      fc.property(competencias, (c) => {
        const seguinte = competenciaSeguinte(c)
        expect(seguinte.mes >= 1 && seguinte.mes <= 12).toBe(true)
      }),
    )
  })
})
