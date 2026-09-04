import { competenciaDe, dataCivilDe, FUSO_PADRAO } from '@mavia/domain'

/**
 * Datas na tela do painel — o único lugar do painel que formata tempo.
 *
 * Duas classes de campo chegam da API e **não podem ser tratadas do mesmo
 * jeito**. Confundi-las é o achado F-5 com outra roupa:
 *
 * | Campo | Tipo no banco | O que é | O que fazer |
 * |---|---|---|---|
 * | `recebido_em`, `criado_em`, `periodo_fim`, `ocorrido_em` | `TIMESTAMPTZ` | instante | converter para `America/Sao_Paulo` |
 * | `competencia` | `DATE` no dia 1 | **data civil** | ler os dígitos, **nunca** converter |
 *
 * Uma `DATE` do Postgres atravessa o driver como `Date` de JavaScript à
 * meia-noite do fuso do processo, e o `JSON.stringify` a emite em UTC. Se o
 * servidor da API roda em UTC, a competência de setembro chega como
 * `2026-09-01T00:00:00.000Z` — e passá-la por uma conversão para São Paulo a
 * devolve como **31 de agosto**. O mês da receita muda de lugar sozinho, que é
 * exatamente o defeito que a coluna gerada existe para impedir.
 */

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

/**
 * A hora do dia em `America/Sao_Paulo`.
 *
 * `Intl` aparece **aqui e em nenhum outro lugar do painel**: o domínio expõe o
 * dia civil (`dataCivilDe`) e não a hora, e a hora importa no registro de
 * auditoria — duas leituras do mesmo espaço às 09h02 e às 14h47 são fatos
 * diferentes, e uma lista só com a data não os distingue.
 *
 * `h23` e não `hour12: false`: em algumas implementações a segunda escreve
 * `24:00` para a meia-noite, e um registro carimbado às "24:07" faz o operador
 * duvidar do relógio inteiro.
 */
const HORA = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO_PADRAO,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function doisDigitos(n: number): string {
  return String(n).padStart(2, '0')
}

/** `dd/mm/aaaa` do instante, em `America/Sao_Paulo`. */
export function dataNaTela(instanteIso: string): string {
  const d = dataCivilDe(new Date(instanteIso))
  return `${doisDigitos(d.dia)}/${doisDigitos(d.mes)}/${d.ano}`
}

/** `dd/mm/aaaa hh:mm` do instante, em `America/Sao_Paulo`. */
export function dataEHoraNaTela(instanteIso: string): string {
  return `${dataNaTela(instanteIso)} ${HORA.format(new Date(instanteIso))}`
}

/**
 * A competência como **mês por extenso** — exigência da §9 do spec e do item 9
 * da auditoria do ticket.
 *
 * Lê `AAAA-MM` do começo da string e para. Aceita tanto `2026-09-01` quanto
 * `2026-09-01T00:00:00.000Z`, e as duas dão o mesmo mês, que é o ponto: a data
 * civil não tem fuso a aplicar.
 */
export function competenciaPorExtenso(dataCivil: string): string {
  const [ano, mes] = dataCivil.slice(0, 7).split('-')
  const indice = Number(mes) - 1
  const nome = MESES[indice]
  if (!nome || !ano) return dataCivil
  return `${nome} de ${ano}`
}

/**
 * A competência de um instante, no formato em que a coluna gerada a grava.
 *
 * Serve para comparar o rascunho de uma baixa com as baixas já registradas: a
 * do banco vem pronta, a do formulário precisa ser derivada de `recebido_em` —
 * e derivada **em São Paulo**, com `competenciaDe`, do domínio. Um recebimento
 * às 22h de 30 de setembro é 01 de outubro em UTC.
 */
export function competenciaDoInstante(instanteIso: string): string {
  const c = competenciaDe(new Date(instanteIso))
  return `${c.ano}-${doisDigitos(c.mes)}`
}

/** A chave de comparação de competência: `AAAA-MM`, venha de onde vier. */
export function chaveDeCompetencia(dataCivil: string): string {
  return dataCivil.slice(0, 7)
}

/**
 * Dias inteiros de `de` até `ate`, arredondando para cima.
 *
 * Usada só para o rótulo "faltam N dias" ao lado do fim efetivo. Decisão de
 * negócio nenhuma sai daqui: quem decide expiração é o servidor (regra 9), e
 * hoje nem isso existe — nenhum job expira nada (spec §8.4).
 */
export function diasEntre(de: Date, ate: Date): number {
  return Math.ceil((ate.getTime() - de.getTime()) / 86_400_000)
}
