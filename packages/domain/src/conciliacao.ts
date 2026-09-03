import type { DataCivil } from './tempo.js'

/**
 * Conciliação — o casamento entre um lançamento **importado** e um que o
 * usuário digitou à mão.
 *
 * Ver `CONTEXT.md`, verbete **Conciliacao**. Duas frases governam tudo o que
 * está aqui:
 *
 * > Produz uma **sugestão**; o Usuario confirma. O sistema jamais apaga o
 * > registro do Usuario sozinho.
 *
 * > **Deduplicacao** nunca depende só da descrição.
 *
 * ## As três regras
 *
 * 1. **Valor exato, sempre.** Dinheiro é exato; um candidato com valor
 *    diferente é outro fato, por mais parecido que seja o resto. Não há
 *    tolerância, nem para um centavo.
 * 2. **A data tem folga, porque o mundo tem.** O que a pessoa digita no dia da
 *    compra o banco lança um a três dias depois. A folga é assimétrica de
 *    propósito: o registro manual costuma **anteceder** o do banco.
 * 3. **Empate não vira sugestão.** Dois candidatos igualmente bons significam
 *    que a informação disponível não decide — e uma sugestão errada que o
 *    usuário confirma no automático é pior do que nenhuma sugestão. O empate vai
 *    para o humano com os dois candidatos à vista.
 */

export interface Candidato {
  readonly id: string
  readonly centavos: bigint
  readonly data: DataCivil
  readonly descricao: string
  /** Já conciliado com outro importado: fora do jogo. */
  readonly jaConciliado: boolean
}

export interface Importado {
  readonly centavos: bigint
  readonly data: DataCivil
  readonly descricao: string
}

export interface Sugestao {
  readonly candidatoId: string
  /** 0 a 100. Só existe sugestão acima do piso. */
  readonly confianca: number
  readonly motivo: string
}

export interface OpcoesDeConciliacao {
  /** Dias que o registro manual pode **anteceder** o do banco. */
  readonly diasAntes?: number
  /** Dias que pode **suceder**. Menor: banco raramente lança adiantado. */
  readonly diasDepois?: number
}

const PADRAO = { diasAntes: 5, diasDepois: 2 } as const

/**
 * Piso de confiança. Abaixo dele não há sugestão — a conciliação some da tela e
 * o importado entra como lançamento novo, que é o desfecho seguro.
 */
export const PISO_DE_CONFIANCA = 55

/**
 * A distância mínima entre o primeiro e o segundo colocados para que o primeiro
 * seja sugerido. Empate técnico é empate.
 */
const MARGEM_MINIMA = 10

export function conciliar(
  importado: Importado,
  candidatos: readonly Candidato[],
  opcoes: OpcoesDeConciliacao = {},
): Sugestao | null {
  const diasAntes = opcoes.diasAntes ?? PADRAO.diasAntes
  const diasDepois = opcoes.diasDepois ?? PADRAO.diasDepois

  const pontuados = candidatos
    .filter((c) => !c.jaConciliado)
    // Regra 1: valor exato. Sem tolerância, nem de um centavo.
    .filter((c) => c.centavos === importado.centavos)
    .map((c) => ({ candidato: c, pontos: pontuar(importado, c, diasAntes, diasDepois) }))
    .filter((p) => p.pontos > 0)
    .sort((a, b) => b.pontos - a.pontos)

  const melhor = pontuados[0]
  if (!melhor || melhor.pontos < PISO_DE_CONFIANCA) return null

  const segundo = pontuados[1]
  // Regra 3: empate não vira sugestão.
  if (segundo && melhor.pontos - segundo.pontos < MARGEM_MINIMA) return null

  return {
    candidatoId: melhor.candidato.id,
    confianca: melhor.pontos,
    motivo: motivoDe(importado, melhor.candidato),
  }
}

/**
 * A pontuação.
 *
 * O valor já é obrigatório e por isso não pontua — pontuar o que é
 * pré-requisito só inflaria o número. O que decide é a distância de data, e a
 * descrição **desempata**: ela nunca sustenta um casamento sozinha, e por isso
 * vale no máximo um quarto do total.
 */
function pontuar(
  importado: Importado,
  candidato: Candidato,
  diasAntes: number,
  diasDepois: number,
): number {
  // **Positivo = o manual veio antes**, que é o caso comum: a pessoa digita no
  // dia da compra e o banco lança depois. Negativo é o inverso, e tem folga
  // menor porque banco raramente lança adiantado.
  const distancia = diasEntre(candidato.data, importado.data)
  if (distancia > diasAntes || distancia < -diasDepois) return 0

  // Decaimento linear de oito pontos por dia, e não proporcional à folga.
  // Proporcional punia demais: dois dias de diferença com valor exato é um
  // casamento forte no mundo real, e caía abaixo do piso.
  const porData = Math.max(0, 80 - 8 * Math.abs(distancia))

  // A descrição vale no máximo um quinto. Ela **desempata**; nunca sustenta o
  // casamento sozinha, e é isso que o glossário quer dizer com "deduplicação
  // nunca depende só da descrição".
  const porTexto = 20 * semelhanca(importado.descricao, candidato.descricao)

  return Math.round(porData + porTexto)
}

function motivoDe(importado: Importado, candidato: Candidato): string {
  const distancia = diasEntre(candidato.data, importado.data)
  if (distancia === 0) return 'Mesmo valor, mesmo dia.'
  const quando = distancia > 0 ? 'antes' : 'depois'
  return `Mesmo valor, lançado ${Math.abs(distancia)} dia(s) ${quando} do extrato.`
}

/** Dias de `a` até `b`. Positivo quando `a` é anterior a `b`. */
function diasEntre(a: DataCivil, b: DataCivil): number {
  const emDias = (d: DataCivil) => Date.UTC(d.ano, d.mes - 1, d.dia) / 86_400_000
  return emDias(b) - emDias(a)
}

/**
 * Palavras que aparecem em tudo e não distinguem nada.
 *
 * Lista, e **não** filtro por tamanho. Cortar tudo com até duas letras parecia
 * equivalente e não é: "MERCADO SP" e "MERCADO RJ" ficariam idênticos, e são
 * cidades diferentes. A sigla curta costuma ser justamente o que distingue.
 */
const VAZIAS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas',
  'e', 'a', 'o', 'as', 'os', 'com', 'por', 'para',
  'ltda', 'ltd', 'me', 'epp', 'eireli', 'cia',
])

/**
 * Semelhança de descrição, de 0 a 1, por palavras em comum.
 *
 * Nem Levenshtein nem trigramas: as descrições de banco são siglas e nomes de
 * estabelecimento em caixa alta, e o que de fato distingue duas delas é
 * compartilhar ou não uma palavra significativa. Uma métrica de caracteres
 * daria 0,6 para "MERCADO SP" e "MERCADO RJ".
 */
export function semelhanca(a: string, b: string): number {
  const palavras = (t: string): Set<string> =>
    new Set(
      t
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((p) => p !== '' && !VAZIAS.has(p)),
    )

  const pa = palavras(a)
  const pb = palavras(b)
  if (pa.size === 0 || pb.size === 0) return 0

  let comuns = 0
  for (const p of pa) if (pb.has(p)) comuns++

  // Jaccard: penaliza a descrição longa que contém a curta por acidente.
  return comuns / (pa.size + pb.size - comuns)
}
