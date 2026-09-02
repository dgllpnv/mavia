import { BALDES, type Balde } from './balde.js'
import { dinheiro, somarLista, type ErroMonetario, type Money } from './money.js'
import { ok, type Result } from './result.js'

/**
 * Saldo, status e o resumo do período.
 *
 * `Saldo` e `Realizado` respondem perguntas diferentes, e confundi-las é o
 * erro que faz a tela mentir (`CONTEXT.md`, Realizado):
 *
 * - **Saldo** conta só `efetivado` — dinheiro que **se moveu**.
 * - **Realizado** conta `efetivado` + `pendente` — o que **aconteceu**, movido
 *   ou não. Uma compra de cartão da fatura aberta está no Realizado do mês e
 *   não no Saldo.
 */

export type StatusDeLancamento = 'previsto' | 'pendente' | 'efetivado'

export interface MarcasDeTempo {
  /** Competência: quando o fato econômico aconteceu. */
  readonly postedAt: Date
  /** Compensação: quando o dinheiro se moveu. Nulo enquanto não se moveu. */
  readonly settledAt: Date | null
}

/**
 * O status é **derivado**, nunca coluna. Persistir um enum ao lado das datas
 * que o determinam é estado inválido representável: bastaria alguém gravar
 * `efetivado` sem `settled_at` para o saldo passar a divergir em silêncio.
 */
export function statusDeLancamento(marcas: MarcasDeTempo, agora: Date): StatusDeLancamento {
  // O fato manda sobre a previsão: compensado é efetivado mesmo que a
  // competência declarada esteja no futuro.
  if (marcas.settledAt !== null) return 'efetivado'
  // Fronteira fechada à esquerda. Sem fixar isso, um lançamento no instante
  // exato mudaria de balde conforme o relógio de quem consulta.
  return marcas.postedAt.getTime() <= agora.getTime() ? 'pendente' : 'previsto'
}

/** Aconteceu, movido ou não. */
export function ehRealizado(marcas: MarcasDeTempo, agora: Date): boolean {
  return statusDeLancamento(marcas, agora) !== 'previsto'
}

/** Moveu dinheiro. É isto, e só isto, que entra no Saldo. */
export function ehEfetivado(marcas: MarcasDeTempo, agora: Date): boolean {
  return statusDeLancamento(marcas, agora) === 'efetivado'
}

/**
 * O resumo, **indexado pelo enum de baldes**.
 *
 * Não são campos soltos, e a diferença não é estilo: com campos nomeados à
 * mão, `baldeDe` seria exaustiva e o resumo continuaria podendo esquecer um
 * balde — que é exatamente o defeito que a exaustividade existe para impedir.
 * Indexando por `Balde`, acrescentar um valor ao enum quebra o typecheck em
 * todos os lugares que constroem um resumo (ADR 0022, emenda 2).
 */
export interface Valores {
  readonly realizada: Money
  readonly prevista: Money
}

export interface BaldesDoPeriodo {
  readonly saldoAnterior: Money
  readonly baldes: Readonly<Record<Balde, Valores>>
}

export interface ResumoDoPeriodo extends BaldesDoPeriodo {
  /** Anterior + tudo que foi realizado. É o que o usuário tem. */
  readonly saldo: Money
  /** Saldo + tudo que está previsto. É o que ele terá se nada mudar. */
  readonly projetado: Money
}

/**
 * Interpreta os baldes que a agregação somou no banco.
 *
 * A soma acontece em SQL sobre `BIGINT` — a página não é o período, e somar em
 * JavaScript daria o total da página em vez do total do recorte. O que
 * acontece aqui é interpretação, não aritmética de agregação.
 *
 * A identidade do rodapé deixa de ser uma verificação e passa a **decorrer da
 * exaustividade**: o saldo é o anterior mais todos os baldes, e não há como
 * esquecer um sem o compilador reclamar.
 */
export function resumoDoPeriodo(
  entrada: BaldesDoPeriodo,
): Result<ResumoDoPeriodo, ErroMonetario> {
  const moeda = entrada.saldoAnterior.moeda

  const realizado = somarLista(
    [entrada.saldoAnterior, ...BALDES.map((b) => entrada.baldes[b].realizada)],
    moeda,
  )
  if (!realizado.ok) return realizado

  const projetado = somarLista(
    [realizado.valor, ...BALDES.map((b) => entrada.baldes[b].prevista)],
    moeda,
  )
  if (!projetado.ok) return projetado

  return ok({ ...entrada, saldo: realizado.valor, projetado: projetado.valor })
}

/** Saldo de uma conta a partir dos lançamentos que já se moveram. */
export function saldoDerivado(
  saldoInicial: Money,
  movimentos: readonly { readonly valor: Money; readonly marcas: MarcasDeTempo }[],
  agora: Date,
): Result<Money, ErroMonetario> {
  const efetivados = movimentos.filter((m) => ehEfetivado(m.marcas, agora)).map((m) => m.valor)
  return somarLista([saldoInicial, ...efetivados], saldoInicial.moeda)
}

/** Saldo geral: soma só as contas que o usuário mandou incluir. */
export function saldoGeral(
  contas: readonly { readonly saldo: Money; readonly incluirNoSaldoGeral: boolean }[],
  moeda: Money['moeda'],
): Result<Money, ErroMonetario> {
  const incluidas = contas.filter((c) => c.incluirNoSaldoGeral).map((c) => c.saldo)
  return incluidas.length === 0 ? ok(dinheiro(0n, moeda)) : somarLista(incluidas, moeda)
}
