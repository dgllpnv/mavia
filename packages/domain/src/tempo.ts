import { falha, ok, type Result } from './result.js'

/**
 * Tempo e competência.
 *
 * Três regras governam tudo o que está aqui (`CLAUDE.md` §2, regras 7 a 9;
 * `CONTEXT.md`, seção Tempo e competência):
 *
 * 1. Instante é UTC; o dia e o mês de um instante são lidos **no fuso do
 *    tenant**, nunca do UTC nu.
 * 2. Toda janela é semiaberta, `[inicio, fim)`. Sem exceção — inclusive a
 *    janela da fatura.
 * 3. Nunca offset fixo. Sempre a zona IANA: o Brasil já teve horário de
 *    verão e pode voltar a ter.
 */

/**
 * Hoje toda `Data civil` do sistema é interpretada em São Paulo, e o esquema
 * tem `CHECK` para nenhum código escrever a zona literal. O fuso é parâmetro
 * mesmo assim, para que o dia em que existir um segundo fuso não exija
 * reescrever este módulo.
 */
export const FUSO_PADRAO = 'America/Sao_Paulo'

/** Um dia do calendário. Não é instante — ver `CONTEXT.md`, Data civil. */
export interface DataCivil {
  readonly ano: number
  readonly mes: number
  readonly dia: number
}

/** O mês ao qual um número é atribuído. Persistido como `DATE` no dia 1. */
export interface Competencia {
  readonly ano: number
  readonly mes: number
}

/** Intervalo semiaberto `[inicio, fim)`, em instantes UTC. */
export interface Janela {
  readonly inicio: Date
  readonly fim: Date
}

export type ErroDeCompetencia = {
  readonly tipo: 'mes-invalido'
  readonly mes: number
}

interface RelogioDeParede {
  readonly ano: number
  readonly mes: number
  readonly dia: number
  readonly hora: number
  readonly minuto: number
  readonly segundo: number
}

// Construir Intl.DateTimeFormat é caro e estes objetos são imutáveis.
const formatadores = new Map<string, Intl.DateTimeFormat>()

function formatador(fuso: string): Intl.DateTimeFormat {
  const existente = formatadores.get(fuso)
  if (existente !== undefined) return existente
  const novo = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    // h23 e não hour12:false: sem isso, a meia-noite sai como hora 24.
    hourCycle: 'h23',
  })
  formatadores.set(fuso, novo)
  return novo
}

/** O relógio de parede que um observador no fuso veria naquele instante. */
function relogioDeParede(instante: Date, fuso: string): RelogioDeParede {
  const campos: Record<string, number> = {}
  for (const parte of formatador(fuso).formatToParts(instante)) {
    if (parte.type !== 'literal') campos[parte.type] = Number(parte.value)
  }
  return {
    ano: campos['year'] ?? 0,
    mes: campos['month'] ?? 0,
    dia: campos['day'] ?? 0,
    hora: campos['hour'] ?? 0,
    minuto: campos['minute'] ?? 0,
    segundo: campos['second'] ?? 0,
  }
}

function comoSeFosseUtc(p: RelogioDeParede): number {
  return Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo)
}

/** Deslocamento do fuso naquele instante. Varia com o horário de verão. */
function deslocamentoMs(instante: Date, fuso: string): number {
  return comoSeFosseUtc(relogioDeParede(instante, fuso)) - instante.getTime()
}

function mesmoRelogio(a: RelogioDeParede, b: RelogioDeParede): boolean {
  return (
    a.ano === b.ano &&
    a.mes === b.mes &&
    a.dia === b.dia &&
    a.hora === b.hora &&
    a.minuto === b.minuto &&
    a.segundo === b.segundo
  )
}

/**
 * Converte relógio de parede em instante.
 *
 * Duas passadas: a primeira estima o deslocamento, a segunda corrige quando a
 * estimativa cai do outro lado de uma transição de horário de verão.
 *
 * Quando o horário local **não existe** — no dia em que o relógio pula da
 * meia-noite para 01h, o que já aconteceu no Brasil — a segunda passada não
 * reproduz o relógio pedido. Nesse caso resolvemos **para frente**, devolvendo
 * o primeiro instante após o salto. É determinístico, e mantém o dia civil
 * pedido, que é o que a janela precisa.
 */
function instanteDoRelogio(parede: RelogioDeParede, fuso: string): Date {
  const alvo = comoSeFosseUtc(parede)
  const primeira = alvo - deslocamentoMs(new Date(alvo), fuso)
  const segunda = alvo - deslocamentoMs(new Date(primeira), fuso)
  if (mesmoRelogio(relogioDeParede(new Date(segunda), fuso), parede)) {
    return new Date(segunda)
  }
  return new Date(primeira)
}

export function dataCivilDe(instante: Date, fuso: string = FUSO_PADRAO): DataCivil {
  const p = relogioDeParede(instante, fuso)
  return { ano: p.ano, mes: p.mes, dia: p.dia }
}

export function competenciaDe(instante: Date, fuso: string = FUSO_PADRAO): Competencia {
  const p = relogioDeParede(instante, fuso)
  return { ano: p.ano, mes: p.mes }
}

export function competencia(ano: number, mes: number): Result<Competencia, ErroDeCompetencia> {
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) {
    return falha({ tipo: 'mes-invalido', mes })
  }
  return ok({ ano, mes })
}

export function competenciaSeguinte(c: Competencia): Competencia {
  return c.mes === 12 ? { ano: c.ano + 1, mes: 1 } : { ano: c.ano, mes: c.mes + 1 }
}

/**
 * O mês anterior. Existe como função porque estava reescrito à mão em três
 * lugares — e "menos um mês" com a virada de ano é justamente o tipo de conta
 * que a quarta cópia erra.
 */
export function competenciaAnterior(c: Competencia): Competencia {
  return c.mes === 1 ? { ano: c.ano - 1, mes: 12 } : { ano: c.ano, mes: c.mes - 1 }
}

/** O instante da meia-noite daquele dia civil, no fuso. */
export function inicioDoDiaCivil(data: DataCivil, fuso: string = FUSO_PADRAO): Date {
  return instanteDoRelogio(
    { ano: data.ano, mes: data.mes, dia: data.dia, hora: 0, minuto: 0, segundo: 0 },
    fuso,
  )
}

/**
 * A janela de uma competência: da meia-noite do dia 1 até a meia-noite do dia
 * 1 do mês seguinte, exclusiva.
 *
 * Como as duas bordas saem da mesma função, janelas consecutivas encostam por
 * igualdade — `fim(k) === inicio(k+1)` — e a contiguidade é verificável sem
 * recorrer a "o instante seguinte".
 */
export function janelaDaCompetencia(c: Competencia, fuso: string = FUSO_PADRAO): Janela {
  const seguinte = competenciaSeguinte(c)
  return {
    inicio: inicioDoDiaCivil({ ano: c.ano, mes: c.mes, dia: 1 }, fuso),
    fim: inicioDoDiaCivil({ ano: seguinte.ano, mes: seguinte.mes, dia: 1 }, fuso),
  }
}

/** `inicio <= instante < fim`. A borda direita pertence à janela seguinte. */
export function contem(janela: Janela, instante: Date): boolean {
  const t = instante.getTime()
  return t >= janela.inicio.getTime() && t < janela.fim.getTime()
}

export function formatarDataCivil(data: DataCivil): string {
  const mes = String(data.mes).padStart(2, '0')
  const dia = String(data.dia).padStart(2, '0')
  return `${String(data.ano).padStart(4, '0')}-${mes}-${dia}`
}
