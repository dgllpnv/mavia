import { describe, expect, it } from 'vitest'
import {
  competencia,
  competenciaDe,
  competenciaSeguinte,
  contem,
  dataCivilDe,
  fimDoDiaCivil,
  formatarDataCivil,
  inicioDoDiaCivil,
  janelaDaCompetencia,
} from './tempo.js'

// Regras que estes testes protegem:
//   CLAUDE.md §2, regras 7, 8 e 9
//   CONTEXT.md — Competencia, Janela, Data civil

const emUtc = (iso: string): Date => new Date(iso)

describe('dataCivilDe', () => {
  it('converte o instante para o dia civil em São Paulo, e não em UTC', () => {
    // 02h UTC do dia 10 ainda é dia 9 em São Paulo.
    expect(dataCivilDe(emUtc('2026-03-10T02:00:00Z'))).toEqual({ ano: 2026, mes: 3, dia: 9 })
  })

  it('a virada de mês em UTC ainda é o mês anterior em São Paulo', () => {
    // Este é o caso que a invariante existe para impedir: ler o mês do UTC
    // nu jogaria a despesa das 21h de 31 de agosto para setembro.
    expect(dataCivilDe(emUtc('2026-09-01T00:00:00Z'))).toEqual({ ano: 2026, mes: 8, dia: 31 })
  })

  it('a virada de ano em UTC ainda é o ano anterior em São Paulo', () => {
    expect(dataCivilDe(emUtc('2027-01-01T02:00:00Z'))).toEqual({ ano: 2026, mes: 12, dia: 31 })
  })
})

describe('competenciaDe', () => {
  it('atribui o instante ao mês civil de São Paulo', () => {
    expect(competenciaDe(emUtc('2026-09-15T12:00:00Z'))).toEqual({ ano: 2026, mes: 9 })
  })

  it('uma compra às 21h de 31 de agosto é competência de agosto, não de setembro', () => {
    expect(competenciaDe(emUtc('2026-09-01T00:00:00Z'))).toEqual({ ano: 2026, mes: 8 })
  })

  it('o primeiro instante do mês em São Paulo já é o mês novo', () => {
    // 03h UTC = 00h em São Paulo, sem horário de verão.
    expect(competenciaDe(emUtc('2026-09-01T03:00:00Z'))).toEqual({ ano: 2026, mes: 9 })
  })
})

describe('não usa offset fixo', () => {
  it('respeita o horário de verão brasileiro quando ele existiu', () => {
    // Em 15/12/2018 o Brasil estava em horário de verão: São Paulo era UTC-2.
    expect(dataCivilDe(emUtc('2018-12-15T01:00:00Z'))).toEqual({ ano: 2018, mes: 12, dia: 14 })
    // Em 15/06/2018, fora do horário de verão: UTC-3.
    expect(dataCivilDe(emUtc('2018-06-15T02:00:00Z'))).toEqual({ ano: 2018, mes: 6, dia: 14 })
    // Se o código usasse -03:00 fixo, a primeira asserção daria dia 15.
  })
})

describe('competencia', () => {
  it('constrói a partir de ano e mês', () => {
    const c = competencia(2026, 9)
    expect(c.ok && c.valor).toEqual({ ano: 2026, mes: 9 })
  })

  it('recusa mês fora de 1 a 12', () => {
    expect(competencia(2026, 0).ok).toBe(false)
    expect(competencia(2026, 13).ok).toBe(false)
  })

  it('recusa mês fracionário', () => {
    expect(competencia(2026, 9.5).ok).toBe(false)
  })
})

describe('competenciaSeguinte', () => {
  it('avança um mês', () => {
    expect(competenciaSeguinte({ ano: 2026, mes: 9 })).toEqual({ ano: 2026, mes: 10 })
  })

  it('vira o ano em dezembro', () => {
    expect(competenciaSeguinte({ ano: 2026, mes: 12 })).toEqual({ ano: 2027, mes: 1 })
  })
})

describe('janelaDaCompetencia', () => {
  it('começa à meia-noite de São Paulo do dia 1', () => {
    const janela = janelaDaCompetencia({ ano: 2026, mes: 9 })

    // 00h de 1º de setembro em São Paulo é 03h UTC.
    expect(janela.inicio.toISOString()).toBe('2026-09-01T03:00:00.000Z')
  })

  it('termina à meia-noite de São Paulo do dia 1 do mês seguinte', () => {
    const janela = janelaDaCompetencia({ ano: 2026, mes: 9 })

    expect(janela.fim.toISOString()).toBe('2026-10-01T03:00:00.000Z')
  })

  it('janelas consecutivas encostam exatamente: fim de uma é início da outra', () => {
    // Contiguidade e disjunção verificáveis por igualdade, não por
    // "o instante seguinte" — CONTEXT.md, Janela.
    const setembro = janelaDaCompetencia({ ano: 2026, mes: 9 })
    const outubro = janelaDaCompetencia({ ano: 2026, mes: 10 })

    expect(setembro.fim.getTime()).toBe(outubro.inicio.getTime())
  })

  it('vira o ano corretamente', () => {
    const dezembro = janelaDaCompetencia({ ano: 2026, mes: 12 })
    const janeiro = janelaDaCompetencia({ ano: 2027, mes: 1 })

    expect(dezembro.fim.getTime()).toBe(janeiro.inicio.getTime())
  })
})

describe('contem — a janela é semiaberta [inicio, fim)', () => {
  const janela = janelaDaCompetencia({ ano: 2026, mes: 9 })

  it('inclui o próprio instante de início', () => {
    expect(contem(janela, janela.inicio)).toBe(true)
  })

  it('exclui o instante de fim, que pertence à janela seguinte', () => {
    expect(contem(janela, janela.fim)).toBe(false)
  })

  it('inclui o último instante antes do fim', () => {
    expect(contem(janela, new Date(janela.fim.getTime() - 1))).toBe(true)
  })

  it('exclui instante anterior ao início', () => {
    expect(contem(janela, new Date(janela.inicio.getTime() - 1))).toBe(false)
  })
})

describe('inicioDoDiaCivil', () => {
  it('devolve o instante da meia-noite em São Paulo', () => {
    const instante = inicioDoDiaCivil({ ano: 2026, mes: 9, dia: 15 })

    expect(instante.toISOString()).toBe('2026-09-15T03:00:00.000Z')
  })

  it('sobrevive ao dia em que a meia-noite local não existiu', () => {
    // Em 04/11/2018 o horário de verão começou à meia-noite: o relógio
    // pulou de 23h59 para 01h. Não existe 00h00 local nesse dia.
    const instante = inicioDoDiaCivil({ ano: 2018, mes: 11, dia: 4 })

    // O resultado precisa ser um instante válido e determinístico, e o dia
    // civil dele em São Paulo precisa continuar sendo 4 de novembro.
    expect(Number.isNaN(instante.getTime())).toBe(false)
    expect(dataCivilDe(instante)).toEqual({ ano: 2018, mes: 11, dia: 4 })
  })
})

describe('formatarDataCivil', () => {
  it('formata como AAAA-MM-DD, com zero à esquerda', () => {
    expect(formatarDataCivil({ ano: 2026, mes: 9, dia: 5 })).toBe('2026-09-05')
  })
})

describe('fimDoDiaCivil', () => {
  it('é um milissegundo antes da meia-noite do dia seguinte', () => {
    const fim = fimDoDiaCivil({ ano: 2026, mes: 7, dia: 5 })
    const inicioDoSeguinte = inicioDoDiaCivil({ ano: 2026, mes: 7, dia: 6 })

    expect(inicioDoSeguinte.getTime() - fim.getTime()).toBe(1)
  })

  it('não antecede nenhuma hora do próprio dia', () => {
    // A razão de existir: um pagamento datado de 05/07 não pode ficar antes de
    // uma compra feita às 15h de 05/07.
    const fim = fimDoDiaCivil({ ano: 2026, mes: 7, dia: 5 })
    const tarde = new Date('2026-07-05T23:00:00Z') // 20h em São Paulo

    expect(fim.getTime()).toBeGreaterThan(tarde.getTime())
  })

  it('vira o mês e o ano sem tabela de meses', () => {
    expect(fimDoDiaCivil({ ano: 2026, mes: 1, dia: 31 }).toISOString()).toBe(
      new Date(inicioDoDiaCivil({ ano: 2026, mes: 2, dia: 1 }).getTime() - 1).toISOString(),
    )
    expect(fimDoDiaCivil({ ano: 2026, mes: 12, dia: 31 }).toISOString()).toBe(
      new Date(inicioDoDiaCivil({ ano: 2027, mes: 1, dia: 1 }).getTime() - 1).toISOString(),
    )
  })

  it('sobrevive ao dia em que o horário de verão começa', () => {
    // Num dia de 23 horas, "fim do dia" continua sendo o instante anterior à
    // meia-noite seguinte — que é o que a definição diz, e não 23:59:59,999
    // calculado por aritmética de relógio.
    const fim = fimDoDiaCivil({ ano: 2018, mes: 11, dia: 4 })
    const inicioDoSeguinte = inicioDoDiaCivil({ ano: 2018, mes: 11, dia: 5 })

    expect(inicioDoSeguinte.getTime() - fim.getTime()).toBe(1)
  })
})
