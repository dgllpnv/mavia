import {
  competenciaAnterior,
  competenciaSeguinte,
  inicioDoDiaCivil,
  type Competencia,
  type DataCivil,
  type Janela,
} from './tempo.js'

/**
 * O ciclo de fatura do cartão.
 *
 * Implementa `docs/adr/0007-bases-temporais-do-cartao.md`. É a parte mais
 * difícil do domínio: uma compra acontece num dia e sai do bolso noutro, e
 * errar a janela cobra o cliente duas vezes ou não cobra nunca.
 */

export interface CicloDeFaturamento {
  /** Dia em que a fatura fecha. 1 a 31. */
  readonly closingDay: number
  /** Dia em que a fatura vence. 1 a 31. */
  readonly dueDay: number
}

/**
 * Ancoragem de dia do mês — termo do glossário.
 *
 * Dia 31 em fevereiro vira 28 (ou 29 em bissexto), e **o ajuste não é
 * arrastado**: o mês seguinte volta a usar o dia 31. Arrastar faria uma compra
 * em 31 de janeiro parcelada acabar toda no dia 28.
 *
 * A regra estava reescrita em quatro lugares do sistema antes de virar termo —
 * e regra reescrita quatro vezes diverge na quinta.
 */
export function ancorarDiaNoMes(ano: number, mes: number, dia: number): DataCivil {
  // Dia 0 do mês seguinte é o último dia deste mês, sem tabela de meses e sem
  // caso especial para bissexto.
  const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate()
  return { ano, mes, dia: Math.min(dia, ultimoDia) }
}

/**
 * A janela da fatura de um **mês de fechamento**: `[inicio, fim)`.
 *
 * `mesDeFechamento`, e não "competência": a competência de uma Fatura é o mês
 * do **vencimento** (`CONTEXT.md`), que num ciclo 25/5 é o mês seguinte. Uma
 * fatura que fecha em 25/mar tem competência abril. Chamar os dois de
 * competência já custou caro neste projeto uma vez, com `effective_at`.
 *
 * `fim` é a meia-noite do dia **seguinte** ao fechamento, no fuso. Isso é o que
 * faz uma compra no dia exato do fechamento, a qualquer hora, entrar na fatura
 * que fecha naquele dia — a regra 10 diz "compras **após** o fechamento caem na
 * seguinte", e o dia do fechamento não é após o fechamento.
 *
 * A forma semiaberta não é estilo: com `(inicio, fim]` sobre datas civis, o dia
 * seguinte ao fechamento fica fora de ambas as faturas, ou o dia do fechamento
 * cai em duas — e a compra é cobrada duas vezes.
 */
export function janelaDaFatura(
  ciclo: CicloDeFaturamento,
  mesDeFechamento: Competencia,
): Janela {
  return {
    inicio: diaSeguinteAoFechamento(ciclo, competenciaAnterior(mesDeFechamento)),
    fim: diaSeguinteAoFechamento(ciclo, mesDeFechamento),
  }
}

/** Meia-noite do dia seguinte ao fechamento daquele mês. */
function diaSeguinteAoFechamento(ciclo: CicloDeFaturamento, mes: Competencia): Date {
  const fechamento = ancorarDiaNoMes(mes.ano, mes.mes, ciclo.closingDay)
  const seguinte = new Date(Date.UTC(fechamento.ano, fechamento.mes - 1, fechamento.dia + 1))
  return inicioDoDiaCivil({
    ano: seguinte.getUTCFullYear(),
    mes: seguinte.getUTCMonth() + 1,
    dia: seguinte.getUTCDate(),
  })
}

/**
 * Em qual fatura uma compra cai.
 *
 * Derivada da janela, e não calculada por outro caminho: se as duas divergirem,
 * existe compra que some ou que é cobrada duas vezes. O teste amarra as duas.
 */
export function faturaAlvo(ciclo: CicloDeFaturamento, postedAt: Date): Competencia {
  // Começa pelo mês do próprio instante e caminha até achar a janela
  // que o contém. O laço percorre no máximo duas posições, porque a janela de
  // uma competência sempre cobre parte do mês anterior e parte do próprio.
  const emUtc = { ano: postedAt.getUTCFullYear(), mes: postedAt.getUTCMonth() + 1 }
  const candidatas: Competencia[] = [
    { ano: emUtc.mes === 1 ? emUtc.ano - 1 : emUtc.ano, mes: emUtc.mes === 1 ? 12 : emUtc.mes - 1 },
    emUtc,
    competenciaSeguinte(emUtc),
  ]

  for (const c of candidatas) {
    const j = janelaDaFatura(ciclo, c)
    if (postedAt.getTime() >= j.inicio.getTime() && postedAt.getTime() < j.fim.getTime()) {
      return c
    }
  }

  // Inalcançável: as janelas são contíguas e cobrem o contínuo. Se acontecer,
  // é defeito no cálculo da janela e não deve ser adivinhado.
  throw new Error(
    `Nenhuma fatura contém ${postedAt.toISOString()} no ciclo ${ciclo.closingDay}/${ciclo.dueDay}. ` +
      'As janelas deveriam ser contíguas — isto é defeito no ciclo, não entrada inválida.',
  )
}

/**
 * Quando a fatura vence.
 *
 * Se o dia do vencimento é menor **ou igual** ao do fechamento, o vencimento
 * cai no mês seguinte. Igual conta: fechar e vencer no mesmo dia significaria
 * pagar antes de saber o total.
 */
export function vencimentoDaFatura(
  ciclo: CicloDeFaturamento,
  mesDeFechamento: Competencia,
): DataCivil {
  const mesDoVencimento =
    ciclo.dueDay > ciclo.closingDay ? mesDeFechamento : competenciaSeguinte(mesDeFechamento)

  return ancorarDiaNoMes(mesDoVencimento.ano, mesDoVencimento.mes, ciclo.dueDay)
}
