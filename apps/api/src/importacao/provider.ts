import { lerCsv, lerOfx, type MapaDeColunas, type Resultado } from '@mavia/parser'

/**
 * `BankSyncProvider` — a interface única por onde **todo** dado bancário entra.
 *
 * Regra 14 do `CLAUDE.md` e ADR 0003: nenhum código de aplicação conhece
 * "Pluggy", "Belvo" ou "OFX". Conhece esta interface, e mais nada.
 *
 * A regra parece cerimônia enquanto só existem dois adapters de arquivo. Ela
 * deixa de parecer no épico 12: um agregador traz credencial bancária, consenso
 * versionado, revogação em três fases e um custo por conexão. Se o código de
 * importação souber o nome do provider hoje, esse conhecimento estará espalhado
 * por vinte arquivos quando o agregador chegar — e cada um deles vai precisar
 * aprender sobre consentimento.
 *
 * ## O que a interface promete
 *
 * Devolver `RegistroBruto[]` e nada mais. Nenhum adapter cria `Lancamento`,
 * decide categoria, ou toca no banco. Isso é do orquestrador, que é um só.
 */

export interface Origem {
  /** Conteúdo do arquivo, já decodificado para texto. */
  readonly conteudo: string
  /** Mapeamento manual de colunas, quando o CSV não tem cabeçalho conhecido. */
  readonly mapa?: MapaDeColunas
}

export interface BankSyncProvider {
  /** Rótulo persistido em `importacoes.provider`. Só para tela e auditoria. */
  readonly nome: string
  buscar(origem: Origem): Promise<Resultado> | Resultado
}

/**
 * Os adapters de arquivo.
 *
 * Ambos delegam a `@mavia/parser`, que **não tem dependências**: é o pacote
 * escrito para caber no processo filho descartável que o `sistema.md` §2.6
 * exige. Aqui só se dá nome ao que ele faz.
 */
const OFX: BankSyncProvider = {
  nome: 'ofx-import',
  buscar: (origem) => lerOfx(origem.conteudo),
}

const CSV: BankSyncProvider = {
  nome: 'csv-import',
  buscar: (origem) => lerCsv(origem.conteudo, origem.mapa),
}

const REGISTRO: ReadonlyMap<string, BankSyncProvider> = new Map([
  [OFX.nome, OFX],
  [CSV.nome, CSV],
])

export function provider(nome: string): BankSyncProvider | null {
  return REGISTRO.get(nome) ?? null
}

/**
 * O provider pelo conteúdo, quando o cliente não disse qual é.
 *
 * Detecção por **marca do formato**, nunca por extensão: `.txt` com OFX dentro é
 * comum, e `.ofx` com CSV dentro acontece. A extensão é o que o usuário
 * renomeou; o conteúdo é o que o banco escreveu.
 */
export function detectar(conteudo: string): BankSyncProvider {
  const inicio = conteudo.slice(0, 2000).toUpperCase()
  return inicio.includes('<OFX') || inicio.includes('OFXHEADER') ? OFX : CSV
}
