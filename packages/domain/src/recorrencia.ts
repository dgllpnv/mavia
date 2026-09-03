import { ancorarDiaNoMes } from './fatura.js'
import type { Competencia, DataCivil } from './tempo.js'

/**
 * Recorrencia — a regra que gera lançamentos repetidos: salário, aluguel,
 * assinatura.
 *
 * **Guarda a regra, não as ocorrências.** Um job materializa o que cabe num
 * horizonte; este módulo diz *o que* a regra produz, e é puro. Ver `CONTEXT.md`,
 * verbete **Recorrencia**.
 *
 * A ancoragem de dia do mês é a mesma do parcelamento e da fatura, e vem do
 * mesmo lugar: `ancorarDiaNoMes`. A regra estava reescrita em quatro pontos do
 * sistema antes de virar termo do glossário — e regra reescrita quatro vezes
 * diverge na quinta.
 */

export interface RegraDeRecorrencia {
  /** 1 a 31. Dia 31 em fevereiro é ancorado, nunca transborda. */
  readonly diaDoMes: number
  /**
   * Distância entre ocorrências, em meses. 1 é mensal, 12 é anual.
   *
   * O `CONTEXT.md` define a ancoragem por dia do mês e não fixa a cadência; o
   * intervalo em meses é a generalização que **reaproveita a mesma ancoragem**
   * em vez de introduzir uma segunda regra de data. Semanal ficaria de fora por
   * isso mesmo: exigiria outra ancoragem, e outra ancoragem exige decisão de
   * produto.
   */
  readonly intervaloMeses: number
  /** Primeira competência em que a regra produz. */
  readonly inicio: Competencia
  /** Última competência, **inclusive**. Nulo é perpétua. */
  readonly fim: Competencia | null
}

export interface Ocorrencia {
  /**
   * O mês da ocorrência — e a **identidade** dela, junto de tenant e regra.
   *
   * A data não entra na chave: alterar `dia_do_mes` reposiciona as ocorrências
   * futuras dentro do mesmo mês. Com a data na chave, a alteração faria o job
   * materializar tudo de novo, e o mês ganharia uma segunda ocorrência da mesma
   * regra.
   */
  readonly competencia: Competencia
  readonly data: DataCivil
}

/** Meses decorridos de `a` até `b`. Negativo se `b` precede `a`. */
function distanciaEmMeses(a: Competencia, b: Competencia): number {
  return (b.ano - a.ano) * 12 + (b.mes - a.mes)
}

function avancar(c: Competencia, meses: number): Competencia {
  const total = c.ano * 12 + (c.mes - 1) + meses
  return { ano: Math.floor(total / 12), mes: (total % 12) + 1 }
}

function validar(regra: RegraDeRecorrencia): void {
  if (!Number.isInteger(regra.diaDoMes) || regra.diaDoMes < 1 || regra.diaDoMes > 31) {
    throw new Error(`Dia do mês fora de 1..31: ${regra.diaDoMes}.`)
  }
  if (!Number.isInteger(regra.intervaloMeses) || regra.intervaloMeses < 1) {
    throw new Error(`Intervalo de recorrência menor que um mês: ${regra.intervaloMeses}.`)
  }
}

/**
 * As ocorrências da regra entre duas competências, **ambas inclusive**.
 *
 * Inclusivas nas duas pontas, e não semiabertas: competência é um mês discreto,
 * não um instante. A janela semiaberta do `CLAUDE.md` §2.7 governa comparação de
 * instantes, onde a borda é ambígua; aqui a borda é "o mês de dezembro entra ou
 * não", e a resposta é sim.
 *
 * **A fase vem do início da regra, nunca do horizonte.** Listar a partir de
 * fevereiro não converte uma bimestral de janeiro numa bimestral de fevereiro —
 * seria a mesma classe de erro que arrastar o ajuste de dia.
 */
export function ocorrencias(
  regra: RegraDeRecorrencia,
  de: Competencia,
  ate: Competencia,
): Ocorrencia[] {
  validar(regra)

  const fim = regra.fim === null ? ate : (distanciaEmMeses(regra.fim, ate) > 0 ? regra.fim : ate)
  if (distanciaEmMeses(de, fim) < 0) return []

  // O primeiro múltiplo do intervalo que alcança o horizonte. Arredondar para
  // cima aqui é o que preserva a fase.
  const doInicioAoPedido = distanciaEmMeses(regra.inicio, de)
  const primeiroPasso =
    doInicioAoPedido <= 0 ? 0 : Math.ceil(doInicioAoPedido / regra.intervaloMeses)

  const saida: Ocorrencia[] = []
  for (let passo = primeiroPasso; ; passo++) {
    const competencia = avancar(regra.inicio, passo * regra.intervaloMeses)
    if (distanciaEmMeses(competencia, fim) < 0) break

    saida.push({
      competencia,
      data: ancorarDiaNoMes(competencia.ano, competencia.mes, regra.diaDoMes),
    })
  }

  return saida
}

/**
 * A primeira ocorrência a partir de uma competência, ou `null` se a regra já
 * terminou. É o que a tela usa para dizer "próximo em 10/04".
 */
export function proximaOcorrencia(
  regra: RegraDeRecorrencia,
  aPartirDe: Competencia,
): Ocorrencia | null {
  validar(regra)

  const limite = regra.fim ?? avancar(aPartirDe, 12 * regra.intervaloMeses)
  return ocorrencias(regra, aPartirDe, limite)[0] ?? null
}
