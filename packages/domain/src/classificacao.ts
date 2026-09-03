/**
 * Categorização automática — `CONTEXT.md`, verbete **Categorizacao
 * automatica**:
 *
 * > Atribuição de Categoria a um Lancamento por regra do Usuario, histórico do
 * > Tenant ou modelo. **Sempre reversível, sempre com o motivo visível.**
 *
 * As duas garantias da frase são o desenho inteiro deste módulo:
 *
 * - **motivo visível** — toda classificação devolve uma frase que explica de
 *   onde ela veio, em português, para o usuário e não para o log. Uma sugestão
 *   sem explicação é uma sugestão que ninguém consegue contestar;
 * - **reversível** — este módulo nunca escreve nada. Ele propõe; quem grava é a
 *   borda, e o que ela grava carrega a marca de ter sido automático.
 *
 * ## Sem modelo externo, sem treinar com dado de cliente
 *
 * Decisão do dono do produto. O que existe aqui é **regra escrita pela pessoa**
 * e **histórico do próprio espaço** — nada sai do tenant, nada vira corpus, e
 * não há terceiro na cadeia. A consequência honesta é que o sistema não
 * classifica nada no primeiro mês de uso, e a interface diz isso em vez de
 * inventar.
 */

export type TipoDeRegra = 'igual' | 'comeca_com' | 'contem'

export interface RegraDoUsuario {
  readonly id: string
  readonly tipo: TipoDeRegra
  /** O texto que a pessoa escreveu. Comparado sobre a assinatura, não o cru. */
  readonly padrao: string
  readonly categoriaId: string
  /** Menor vem primeiro. Empate resolve pela regra mais específica. */
  readonly prioridade: number
}

/** Quantas vezes o espaço já classificou uma assinatura numa categoria. */
export interface Historico {
  readonly assinatura: string
  readonly categoriaId: string
  readonly vezes: number
}

export interface Classificacao {
  readonly categoriaId: string
  /** Frase em português, para a tela. Nunca um código. */
  readonly motivo: string
  readonly origem: 'regra' | 'historico'
  readonly confianca: number
}

/**
 * Quantas vezes a mesma assinatura precisa ter caído na mesma categoria para
 * que o histórico valha como classificação.
 *
 * Duas, e não uma: uma vez é um evento, e classificar pela primeira ocorrência
 * faria um erro de classificação se propagar para sempre a partir de si mesmo.
 */
export const REPETICOES_MINIMAS = 2

/** Abaixo disto, nada é sugerido. */
export const PISO_DE_CONFIANCA = 60

/**
 * A assinatura de uma descrição bancária.
 *
 * Extratos repetem o estabelecimento e variam o resto: `MERCADO SAO JOSE 0912`,
 * `MERCADO SAO JOSE 1014`, `MERCADO SAO JOSE*PARC 2/3`. A assinatura é o que
 * sobra depois de remover o que varia — número, data, sufixo de parcela — e é
 * ela que o histórico indexa.
 *
 * **Números somem inteiros, e não só os longos.** Um filtro por comprimento
 * deixaria `LOJA 5` e `LOJA 7` como assinaturas distintas, e o histórico nunca
 * acumularia repetição suficiente para aprender nada.
 */
export function assinatura(descricao: string): string {
  return descricao
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // `12/03`, `2/3`, `12-03-2026`: datas e parcelas.
    .replace(/\d+\s*[/-]\s*\d+([/-]\d+)?/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((p) => p.length > 1)
    .join(' ')
    .trim()
}

/**
 * A classificação proposta, ou `null`.
 *
 * **Regra vence histórico, sempre.** Quem escreveu a regra decidiu; o histórico
 * é inferência. Inverter a ordem faria o sistema discordar de uma instrução
 * explícita, que é a forma mais rápida de perder a confiança de quem usa.
 */
export function classificar(
  descricao: string,
  regras: readonly RegraDoUsuario[],
  historico: readonly Historico[],
): Classificacao | null {
  const alvo = assinatura(descricao)
  if (alvo === '') return null

  const daRegra = aplicarRegras(alvo, regras)
  if (daRegra) return daRegra

  return doHistorico(alvo, historico)
}

function aplicarRegras(
  alvo: string,
  regras: readonly RegraDoUsuario[],
): Classificacao | null {
  const casadas = regras
    .map((r) => ({ regra: r, padrao: assinatura(r.padrao) }))
    .filter((r) => r.padrao !== '' && casa(alvo, r.padrao, r.regra.tipo))
    .sort((a, b) => {
      if (a.regra.prioridade !== b.regra.prioridade) {
        return a.regra.prioridade - b.regra.prioridade
      }
      // Empate: **a mais específica ganha**. "mercado sao jose" é mais
      // informativa que "mercado", e quem escreveu as duas quis a exceção.
      return b.padrao.length - a.padrao.length
    })

  const melhor = casadas[0]
  if (!melhor) return null

  return {
    categoriaId: melhor.regra.categoriaId,
    origem: 'regra',
    // Regra é instrução, não palpite: confiança máxima por definição.
    confianca: 100,
    motivo: `Pela sua regra: descrição ${rotuloDoTipo(melhor.regra.tipo)} "${melhor.regra.padrao}".`,
  }
}

function casa(alvo: string, padrao: string, tipo: TipoDeRegra): boolean {
  if (tipo === 'igual') return alvo === padrao
  if (tipo === 'comeca_com') return alvo.startsWith(padrao)
  return alvo.includes(padrao)
}

function rotuloDoTipo(tipo: TipoDeRegra): string {
  if (tipo === 'igual') return 'é exatamente'
  if (tipo === 'comeca_com') return 'começa com'
  return 'contém'
}

/**
 * O histórico do próprio espaço.
 *
 * Só a assinatura **exata**: casar por prefixo ou por parte aqui espalharia a
 * classificação de "MERCADO SAO JOSE" para todo "MERCADO", e o usuário veria
 * uma decisão que ele não consegue explicar. Quem quer o comportamento amplo
 * escreve uma regra — e aí a decisão é dele, com o motivo escrito por ele.
 */
function doHistorico(alvo: string, historico: readonly Historico[]): Classificacao | null {
  const daAssinatura = historico.filter((h) => h.assinatura === alvo)
  if (daAssinatura.length === 0) return null

  const total = daAssinatura.reduce((s, h) => s + h.vezes, 0)
  const [melhor, segundo] = [...daAssinatura].sort((a, b) => b.vezes - a.vezes)

  if (!melhor || melhor.vezes < REPETICOES_MINIMAS) return null

  // A confiança é a **concordância** do histórico, e não o volume: dez
  // ocorrências divididas cinco a cinco não sabem nada, e três iguais sabem.
  const concordancia = melhor.vezes / total
  const confianca = Math.round(concordancia * 100)
  if (confianca < PISO_DE_CONFIANCA) return null

  // Empate exato entre duas categorias não decide, mesmo com muitas
  // ocorrências.
  if (segundo && segundo.vezes === melhor.vezes) return null

  return {
    categoriaId: melhor.categoriaId,
    origem: 'historico',
    confianca,
    motivo:
      melhor.vezes === total
        ? `Você classificou assim as ${melhor.vezes} vezes anteriores.`
        : `Você classificou assim ${melhor.vezes} de ${total} vezes anteriores.`,
  }
}
