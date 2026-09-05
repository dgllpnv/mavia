import {
  competencia,
  competenciaAnterior,
  competenciaSeguinte,
  janelaDaCompetencia,
  type Competencia,
} from '@mavia/domain'
import type { Janela } from './cliente'

/**
 * O período que a tela mostra.
 *
 * A janela vem de `janelaDaCompetencia`, do domínio, e não de aritmética
 * escrita aqui. Ela é **semiaberta** — `[inicio, fim)` — com as bordas
 * calculadas em `America/Sao_Paulo` e comparadas como instantes UTC (regra 7).
 *
 * A tentação de escrever `new Date(ano, mes - 1, 1)` na interface é grande e
 * está errada de dois jeitos ao mesmo tempo: usa o fuso do navegador, que é o
 * relógio do cliente (regra 9), e produz janela fechada, que no primeiro
 * horário de verão faz um lançamento cair em dois meses ou em nenhum.
 */

export interface Periodo {
  readonly mes: Competencia
  readonly janela: Janela
  readonly rotulo: string
  /**
   * O mesmo período em três letras — `set 2026`.
   *
   * Existe por causa do celular, e a razão é medida: `setembro de 2026` ocupa
   * ~190px, e com as setas e a ação ao lado o cabeçalho do card passava a
   * ocupar **três linhas** antes do primeiro lançamento, numa tela de 844px.
   * Abreviar o mês devolve uma linha inteira ao conteúdo.
   *
   * É rótulo, nunca chave: nada compara, agrupa ou persiste por esta string.
   */
  readonly rotuloCurto: string
}

const MESES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
] as const

export function periodoDe(ano: number, mes: number): Periodo {
  const c = competencia(ano, mes)
  if (!c.ok) throw new Error(`Competência inválida: ${ano}-${mes}`)

  const janela = janelaDaCompetencia(c.valor)
  return {
    mes: c.valor,
    janela: { de: janela.inicio.toISOString(), ate: janela.fim.toISOString() },
    rotulo: `${MESES[c.valor.mes - 1]} de ${c.valor.ano}`,
    rotuloCurto: `${MESES[c.valor.mes - 1]?.slice(0, 3)} ${c.valor.ano}`,
  }
}

/** Reexportadas do domínio: a interface não reimplementa aritmética de mês. */
export { competenciaAnterior as mesAnterior, competenciaSeguinte as mesSeguinte }
