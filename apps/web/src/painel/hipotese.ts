import type { MotivoDeAcesso } from '@mavia/contracts'

/**
 * A hipótese declarada antes do acesso.
 *
 * **É normativo, e não desenho de fluxo:** o motivo e a referência são pedidos
 * *antes* de abrir o espaço de um cliente, não depois (spec §9, ticket 12). A
 * API responde 400 sem os dois cabeçalhos, e a mesma instrução que registra a
 * hipótese é a que efetiva o acesso — `admin.abrir_espaco` grava a linha e
 * define `app.tenant_id` juntas.
 *
 * A consequência para a interface é que **nenhuma tela do espaço de um cliente
 * pode consultar nada antes de a hipótese existir**. Não é um formulário que
 * aparece depois de a página carregar: é o portão da página.
 */

/** Lista fechada, e é a mesma da API. "Curiosidade" não tem valor de enum. */
export const MOTIVOS: readonly (readonly [MotivoDeAcesso, string, string])[] = [
  ['chamado', 'chamado de suporte', 'o cliente pediu ajuda e há um chamado aberto'],
  ['incidente', 'incidente', 'algo quebrou e este espaço está no escopo da apuração'],
  ['defeito', 'defeito relatado', 'reproduzir um defeito que só aparece neste espaço'],
  ['ordem_judicial', 'ordem judicial', 'determinação com número de processo'],
]

export interface Hipotese {
  readonly motivo: MotivoDeAcesso
  readonly referencia: string
}

/** O comprimento que a API aceita em `x-mavia-referencia`, depois do `trim`. */
export const REFERENCIA_MINIMA = 3
export const REFERENCIA_MAXIMA = 80

/**
 * Valida a referência **do jeito que a API valida**: `trim` primeiro, medida
 * depois.
 *
 * A ordem importa. `zAbertura` faz `z.string().trim().min(3).max(80)`, e o
 * `trim` do Zod roda antes das medidas. Uma interface que medisse a string crua
 * aceitaria `'  a  '` — cinco caracteres — e receberia 400 do servidor com uma
 * mensagem genérica, num formulário que acabou de dizer que estava tudo certo.
 */
export function referenciaNormalizada(bruta: string): string {
  return bruta.trim()
}

export function referenciaValida(bruta: string): boolean {
  const t = referenciaNormalizada(bruta)
  return t.length >= REFERENCIA_MINIMA && t.length <= REFERENCIA_MAXIMA
}

/**
 * Monta a hipótese, ou devolve `null` se ela não serve.
 *
 * `null` e não exceção: o formulário desabilita o botão, e um estado inválido
 * de digitação não é evento excepcional.
 */
export function hipoteseDe(motivo: MotivoDeAcesso, referenciaBruta: string): Hipotese | null {
  if (!referenciaValida(referenciaBruta)) return null
  return { motivo, referencia: referenciaNormalizada(referenciaBruta) }
}

/**
 * Os dois cabeçalhos, e é o único lugar do painel que os escreve.
 *
 * Espalhá-los pelas chamadas faria a próxima rota nascer sem eles — e a rota
 * sem eles não é um erro visível: é um 400 com mensagem de validação, que se
 * parece com "o formulário está errado".
 */
export function cabecalhosDaHipotese(h: Hipotese): Record<string, string> {
  return {
    'x-mavia-motivo': h.motivo,
    'x-mavia-referencia': h.referencia,
  }
}

/**
 * O que fica registrado, em português, para a tela do portão.
 *
 * **A frase enumera o que a linha de auditoria de fato contém**, e o texto vive
 * aqui, e não dentro do JSX, para que uma mudança na projeção de
 * `admin.ler_registro` quebre um teste em vez de deixar uma promessa velha na
 * tela.
 *
 * ## Por que ela **não** promete a contagem de registros consultados
 *
 * Porque hoje ela não existe para estas telas. `admin.abrir_espaco` — a função
 * que grava a linha de cada leitura do espaço de um cliente — **não recebe nem
 * escreve `auditoria.registros`** (`0032_funcoes_de_admin.sql`), e o
 * controlador não tem como completá-la depois: `auditoria` não aceita `UPDATE`
 * de ninguém.
 *
 * Verificado no banco local: as linhas `buscou` (a listagem, por
 * `admin.listar_clientes`) e a de `ler_registro` trazem a contagem; toda linha
 * `leu` das quatro telas de cliente traz `NULL`. O spec promete *"com rota e
 * contagem"* na §8, e essa metade está em aberto — é ticket de API, não de tela.
 *
 * Escrever aqui que a contagem é registrada seria a interface afirmando um
 * controle que não existe, que é pior do que não ter o controle.
 */
export const O_QUE_FICA_REGISTRADO =
  'Fica registrado: o seu nome, o instante, o motivo, a referência que você ' +
  'escrever e cada tela que você abrir. O registro é permanente e não pode ser ' +
  'editado por ninguém, inclusive por você.'
