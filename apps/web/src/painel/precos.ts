import type { PrecoVigente } from '@mavia/contracts'
import { preco, type CodigoDoPlano, type Intervalo } from '@mavia/domain'

/**
 * O preço-base na tela — **ADR 0025 D2**.
 *
 * ## A tabela é append-only, e a tela precisa mostrar isso
 *
 * Trocar o preço do Pessoal mensal **cria uma linha**; a anterior permanece,
 * porque assinaturas apontam para ela. Não existe `UPDATE` a executar: nenhum
 * papel do painel tem o privilégio, e a retroatividade fica irrepresentável, e
 * não desencorajada. Uma tela que dissesse "editar preço" descreveria uma
 * operação que o banco não oferece.
 *
 * ## Duas origens para o mesmo número, e confundi-las mentiria
 *
 * `precos_vigentes` **nasce vazia**, de propósito (migration `0043`): semeá-la
 * com os seis valores da DP-41 criaria uma duplicata do catálogo em código, e
 * no dia em que alguém editasse um dos lados o sistema teria duas respostas
 * para "quanto custa o Pessoal".
 *
 * Enquanto o par não tem linha, quem vale é o **catálogo** — `preco()` de
 * `@mavia/domain`, a origem da D2. A tela nomeia a origem de cada número em vez
 * de mostrar um traço: um travessão na coluna de preço faria o operador
 * concluir que o plano não tem preço, e ele tem.
 *
 * ## O que este módulo não faz
 *
 * Não conta assinaturas afetadas. Esse número vem de `admin.criar_preco`, é
 * sempre zero, e a ADR exige que a tela o mostre **vindo do servidor** — uma
 * contagem que a interface afirma é uma contagem que ninguém conferiu.
 */

export const PARES: readonly (readonly [CodigoDoPlano, Intervalo])[] = [
  ['pessoal', 'mensal'],
  ['pessoal', 'anual'],
  ['familia', 'mensal'],
  ['familia', 'anual'],
  ['negocio', 'mensal'],
  ['negocio', 'anual'],
]

/** Os três códigos, na ordem em que a tela os oferece. */
export const CODIGOS: readonly CodigoDoPlano[] = ['pessoal', 'familia', 'negocio']

export const NOME_DO_PLANO: Readonly<Record<CodigoDoPlano, string>> = {
  pessoal: 'Pessoal',
  familia: 'Família',
  negocio: 'Negócio',
}

/**
 * O código do plano, quando a string vinda do banco é um dos três.
 *
 * `assinaturas.plano` e `precos_vigentes.plano` são `TEXT`: um plano retirado do
 * catálogo continuaria escrito lá, e tratá-lo como código válido faria
 * `preco()` procurar um plano que não existe. Devolver `null` é o que permite à
 * tela dizer "não sei o preço deste plano" em vez de mostrar um número errado.
 */
export function codigoDoPlano(bruto: string | null): CodigoDoPlano | null {
  // `find` sobre a lista, e **não** `bruto in NOME_DO_PLANO`: o `in` percorre a
  // cadeia de protótipos, e `'constructor' in {}` é verdadeiro. Uma string vinda
  // de coluna de texto passaria por código de plano.
  return CODIGOS.find((c) => c === bruto) ?? null
}

export interface PrecoEmVigor {
  readonly plano: CodigoDoPlano
  readonly intervalo: Intervalo
  /** Centavos como string. Nunca `number`: a regra 1 não fala do que cabe. */
  readonly centavos: string
  /** `tabela` quando alguém já trocou; `catalogo` enquanto ninguém trocou. */
  readonly origem: 'tabela' | 'catalogo'
  /** A linha que decide, quando a origem é a tabela. */
  readonly linha: PrecoVigente | null
}

/**
 * O par de uma linha, como chave.
 *
 * `plano` chega como `string` do contrato — a coluna é `TEXT` no banco, e um
 * plano retirado do catálogo continuaria tendo histórico. Comparar por string
 * é o que mantém a linha órfã visível no histórico em vez de sumida.
 */
function ehDoPar(linha: PrecoVigente, plano: CodigoDoPlano, intervalo: Intervalo): boolean {
  return linha.plano === plano && linha.intervalo === intervalo
}

/**
 * O histórico de um par, do mais recente para o mais antigo.
 *
 * A ordenação é refeita aqui, e não herdada da rota: a tela trata a primeira
 * linha como "a que vale", e depender do `ORDER BY` de outro arquivo faria uma
 * mudança lá inverter o significado desta tela sem quebrar teste nenhum.
 */
export function historicoDoPar(
  historico: readonly PrecoVigente[],
  plano: CodigoDoPlano,
  intervalo: Intervalo,
): PrecoVigente[] {
  return historico
    .filter((l) => ehDoPar(l, plano, intervalo))
    .slice()
    .sort((a, b) => new Date(b.vigente_desde).getTime() - new Date(a.vigente_desde).getTime())
}

/**
 * O que vale agora para um par.
 *
 * **`vigente_desde <= agora`**, como a função `preco_vigente` do banco. Hoje o
 * `INSERT` usa `DEFAULT now()` e uma linha futura não tem como nascer; repetir
 * o recorte aqui é o que impede a tela de divergir do servidor no dia em que um
 * preço agendado passar a existir.
 */
export function precoEmVigor(
  historico: readonly PrecoVigente[],
  plano: CodigoDoPlano,
  intervalo: Intervalo,
  agora: Date,
): PrecoEmVigor {
  const linha =
    historicoDoPar(historico, plano, intervalo).find(
      (l) => new Date(l.vigente_desde).getTime() <= agora.getTime(),
    ) ?? null

  if (linha) {
    return { plano, intervalo, centavos: linha.valor_centavos, origem: 'tabela', linha }
  }

  return {
    plano,
    intervalo,
    centavos: String(preco(plano, intervalo).centavos),
    origem: 'catalogo',
    linha: null,
  }
}

export function precosEmVigor(historico: readonly PrecoVigente[], agora: Date): PrecoEmVigor[] {
  return PARES.map(([plano, intervalo]) => precoEmVigor(historico, plano, intervalo, agora))
}

/**
 * O que a troca digitada faz, antes de ela ser enviada.
 *
 * As quatro classes existem porque as consequências são diferentes, e duas
 * delas seriam invisíveis sem esta camada:
 *
 * | Classe | O que acontece |
 * |---|---|
 * | `sem-valor` | não há o que enviar |
 * | `igual-ao-vigente` | `admin.criar_preco` recusa com `PRECO_INALTERADO` |
 * | `igual-a-origem` | o servidor **aceita**, e o preço praticado não muda |
 * | `muda` | o preço praticado passa a ser outro |
 *
 * `igual-a-origem` é a que quase escapou. A função do banco compara com
 * `preco_vigente()`, que devolve `NULL` quando o par não tem linha — então
 * gravar exatamente o valor do catálogo **passa**, cria uma linha e não muda
 * preço nenhum. Bloquear seria a tela recusando o que o servidor aceita; calar
 * deixaria o operador achar que mudou algo. A tela avisa e deixa seguir.
 */
export type ClasseDaTroca = 'sem-valor' | 'igual-ao-vigente' | 'igual-a-origem' | 'muda'

export interface AvaliacaoDaTroca {
  readonly classe: ClasseDaTroca
  readonly atual: PrecoEmVigor
  readonly podeEnviar: boolean
}

export function avaliarTroca(
  historico: readonly PrecoVigente[],
  plano: CodigoDoPlano,
  intervalo: Intervalo,
  centavosDigitados: string,
  agora: Date,
): AvaliacaoDaTroca {
  const atual = precoEmVigor(historico, plano, intervalo, agora)
  const novo = paraCentavos(centavosDigitados)

  if (novo <= 0n) return { classe: 'sem-valor', atual, podeEnviar: false }
  if (novo !== paraCentavos(atual.centavos)) return { classe: 'muda', atual, podeEnviar: true }

  return atual.origem === 'tabela'
    ? { classe: 'igual-ao-vigente', atual, podeEnviar: false }
    : { classe: 'igual-a-origem', atual, podeEnviar: true }
}

/**
 * Centavos como inteiro, e nunca como texto.
 *
 * `'03900'` e `'3900'` são o mesmo preço e strings diferentes. Comparar texto
 * faria a tela deixar passar uma troca que o banco recusa — e a mensagem que o
 * operador leria seria a de uma restrição violada.
 */
function paraCentavos(bruto: string): bigint {
  try {
    return BigInt(bruto || '0')
  } catch {
    return 0n
  }
}

/** O mínimo do `CHECK` de `precos_vigentes.motivo`, e do Zod da rota. */
export const MOTIVO_MINIMO = 8
export const MOTIVO_MAXIMO = 280

export function motivoValido(bruto: string): boolean {
  const t = bruto.trim()
  return t.length >= MOTIVO_MINIMO && t.length <= MOTIVO_MAXIMO
}

/**
 * O que trocar o preço faz, dito antes do botão.
 *
 * Carrega as duas metades da D2: a escrita é uma criação, e quem já contratou
 * não é tocado. A contagem que prova a segunda metade vem do servidor, depois
 * de gravar — não daqui.
 */
export const O_QUE_A_TROCA_FAZ =
  'Trocar o preço cria uma linha nova e mantém a anterior: é a anterior que as ' +
  'assinaturas já contratadas continuam apontando. Não existe instrução que ' +
  'altere uma linha de preço, em papel nenhum do painel.'

/** O que a troca **não** faz. O engano clássico é achar que ela reajusta a base. */
export const O_QUE_A_TROCA_NAO_FAZ =
  'Nenhum cliente que já paga tem o valor alterado por esta operação. O preço ' +
  'novo vale para contratações futuras; migrar quem já assinou é operação ' +
  'comunicada, com aviso prévio, e não existe neste painel.'
