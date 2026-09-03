import { lerCsv, lerOfx, type MapaDeColunas, type Resultado } from '@mavia/parser'

/**
 * `BankSyncProvider` — a interface única por onde **todo** dado bancário entra,
 * e por onde todo acesso a dado bancário é encerrado.
 *
 * Regra 14 do `CLAUDE.md`, ADR 0003 e ADR 0019: nenhum código de aplicação
 * conhece "Pluggy", "Belvo" ou "OFX". Conhece esta interface, e mais nada.
 *
 * A regra parecia cerimônia enquanto só existiam dois adapters de arquivo. Ela
 * deixou de parecer quando a revogação chegou: `DELETE /conexoes/:id` tem três
 * fases, prazo duro e uma taxonomia de falha, e nada disso pode ramificar sobre
 * o nome do provider. O que decide é a **ficha** do adapter, declarada uma vez,
 * aqui.
 *
 * ## O que a interface promete
 *
 * `buscar` devolve `RegistroBruto[]` e nada mais. `revogar` fala com o terceiro
 * e devolve um valor. **Nenhum dos dois toca no banco, conhece `tenancy` ou
 * lança** — persistir estado é do orquestrador, que é um só. É o que mantém o
 * módulo profundo e o adapter substituível.
 */

export interface Origem {
  /** Conteúdo do arquivo, já decodificado para texto. */
  readonly conteudo: string
  /** Mapeamento manual de colunas, quando o CSV não tem cabeçalho conhecido. */
  readonly mapa?: MapaDeColunas
}

/**
 * Como o adapter guarda credencial — ADR 0018 §D0.
 *
 * `sem-credencial` não quer dizer "sem segurança": quer dizer que **não existe
 * segredo nosso a proteger**. O titular digitou a senha no fluxo do próprio
 * agregador, e o que guardamos é um `item_id` opaco que sozinho não abre nada.
 * A distinção decide se a linha de `conexoes` tem envelope ou não, e portanto
 * se o crypto-shred da revogação tem o que destruir.
 */
export type ModeloDeCredencial = 'sem-credencial' | 'credencial-por-conexao'

/**
 * O que `revogar` consegue fazer lá fora.
 *
 * `nao-aplicavel` é a resposta honesta de quem nunca teve acesso continuado: um
 * arquivo OFX foi um ato único do titular, e não há sessão para encerrar.
 * Fingir que há produziria um job que retenta para sempre contra ninguém.
 */
export type RevogacaoRemota = 'sem-segredo' | 'exige-segredo-do-titular' | 'nao-aplicavel'

export type MotivoDaRevogacao =
  | 'titular'
  | 'expiracao'
  | 'reconsentimento'
  | 'eliminacao_espaco'
  | 'eliminacao_titular'

/**
 * O descritor da revogação. **Não carrega material cifrado** e não é a linha de
 * `conexoes`: o adapter recebe o que precisa para falar com o terceiro, e nada
 * do que o banco guarda.
 */
export interface AlvoRevogacao {
  readonly tenantId: string
  readonly conexaoId: string
  readonly provider: string
  /** Id do recurso na origem. `null` quando o adapter não tem um. */
  readonly externalId: string | null
  readonly motivo: MotivoDaRevogacao
  /** Estável entre tentativas: `revogacao:${conexaoId}`. */
  readonly chaveIdempotencia: string
  readonly tentativa: number
  /**
   * Presente **somente** para adapter com `modeloDeCredencial:
   * 'credencial-por-conexao'`. Vive em memória, decifrado dentro da transação
   * de revogação e zerado depois. Nunca é persistido, nunca entra em payload de
   * job, nunca é relido do banco — o banco já não o tem.
   */
  readonly segredo?: Buffer
}

export interface OpcoesRevogacao {
  readonly sinal: AbortSignal
  readonly prazoMs: number
}

export type CodigoRevogacao =
  | 'timeout'
  | 'rede'
  | 'limite'
  | 'indisponivel'
  | 'nao_autorizado'
  | 'recurso_alheio'
  | 'contrato_encerrado'

export type ResultadoRevogacao =
  | { readonly estado: 'revogado'; readonly em: Date; readonly referencia?: string }
  | { readonly estado: 'ja_revogado'; readonly em?: Date }
  | { readonly estado: 'nao_aplicavel'; readonly motivo: string }
  | {
      readonly estado: 'falha_temporaria'
      readonly codigo: CodigoRevogacao
      readonly tentarApos?: Date
    }
  | {
      readonly estado: 'falha_permanente'
      readonly codigo: CodigoRevogacao
      readonly detalhe: string
    }

export interface BankSyncProvider {
  /** Rótulo persistido em `importacoes.provider` e em `conexoes.provider`. */
  readonly nome: string
  readonly modeloDeCredencial: ModeloDeCredencial
  readonly revogacaoRemota: RevogacaoRemota

  buscar(origem: Origem): Promise<Resultado> | Resultado

  /**
   * Encerrar o acesso do lado de lá.
   *
   * **Total**: não lança para nenhum caso enumerado. Uma exceção que escape é
   * tratada pelo chamador como `falha_temporaria`, mas o adapter que a aciona
   * reprova a suíte de contrato — a defesa existe para o incidente, não para
   * ser o caminho normal.
   */
  revogar(alvo: AlvoRevogacao, opcoes: OpcoesRevogacao): Promise<ResultadoRevogacao>
}

/**
 * Os adapters de arquivo.
 *
 * Ambos delegam a `@mavia/parser`, que **não tem dependências**: é o pacote
 * escrito para caber no processo filho descartável que o `sistema.md` §2.6
 * exige. Aqui só se dá nome ao que ele faz.
 *
 * Os dois revogam **sem tocar em rede**. O acesso foi o titular entregar um
 * arquivo, uma vez; não há sessão para encerrar. O que precisa sumir é o
 * payload bruto, e disso cuida a Fase 3 do orquestrador — não o adapter.
 */
const OFX: BankSyncProvider = {
  nome: 'ofx-import',
  modeloDeCredencial: 'sem-credencial',
  revogacaoRemota: 'nao-aplicavel',
  buscar: (origem) => lerOfx(origem.conteudo),
  revogar: async () => semAcessoContinuado('importação de arquivo OFX'),
}

const CSV: BankSyncProvider = {
  nome: 'csv-import',
  modeloDeCredencial: 'sem-credencial',
  revogacaoRemota: 'nao-aplicavel',
  buscar: (origem) => lerCsv(origem.conteudo, origem.mapa),
  revogar: async () => semAcessoContinuado('importação de arquivo CSV'),
}

/**
 * O rótulo do titular sobre lançamentos que ele mesmo digitou.
 *
 * Existe para que "conexão" seja um conceito único na tela: uma conta manual e
 * uma conta conectada aparecem na mesma lista, com o mesmo botão de encerrar, e
 * o que muda é o que acontece quando ele é apertado.
 */
const MANUAL: BankSyncProvider = {
  nome: 'manual',
  modeloDeCredencial: 'sem-credencial',
  revogacaoRemota: 'nao-aplicavel',
  // Não existe arquivo a ler: o que este adapter "traz" já está no banco,
  // digitado pelo titular.
  buscar: () => ({ registros: [], problemas: [] }),
  revogar: async () => semAcessoContinuado('conexão local, sem acesso externo'),
}

function semAcessoContinuado(motivo: string): ResultadoRevogacao {
  return { estado: 'nao_aplicavel', motivo }
}

/**
 * O registro.
 *
 * `registrarAdapter` **recusa** adapter sem ficha (ADR 0019 §D1, regra 4).
 * Declaração ausente não entra no registro, e o adapter simplesmente não
 * existe para o produto. É como o §D0 do ADR 0018 deixa de ser esquecido: não
 * há caminho em que um adapter novo nasça sem dizer se guarda segredo.
 */
const REGISTRO = new Map<string, BankSyncProvider>()

export class AdapterInvalido extends Error {
  constructor(nome: string, o_que: string) {
    super(`O adapter "${nome}" não declarou ${o_que}. Adapter sem ficha não entra no registro.`)
    this.name = 'AdapterInvalido'
  }
}

export function registrarAdapter(adapter: BankSyncProvider): void {
  if (!adapter.nome) throw new AdapterInvalido('(sem nome)', 'nome')
  if (!adapter.modeloDeCredencial) throw new AdapterInvalido(adapter.nome, 'modeloDeCredencial')
  if (!adapter.revogacaoRemota) throw new AdapterInvalido(adapter.nome, 'revogacaoRemota')
  if (typeof adapter.revogar !== 'function') throw new AdapterInvalido(adapter.nome, 'revogar')

  // Um adapter que não tem acesso continuado a encerrar não pode exigir
  // segredo para encerrá-lo: a combinação não descreve nada real, e produziria
  // uma Fase 2 pedindo ao guardião uma credencial que a Fase 1 não guardou.
  if (adapter.revogacaoRemota === 'exige-segredo-do-titular' &&
      adapter.modeloDeCredencial === 'sem-credencial') {
    throw new AdapterInvalido(adapter.nome, 'uma ficha coerente: exige segredo e não guarda nenhum')
  }

  REGISTRO.set(adapter.nome, adapter)
}

for (const adapter of [OFX, CSV, MANUAL]) registrarAdapter(adapter)

export function provider(nome: string): BankSyncProvider | null {
  return REGISTRO.get(nome) ?? null
}

/** Os adapters registrados. É o insumo da suíte de contrato (ADR 0019 §D8). */
export function adaptersRegistrados(): readonly BankSyncProvider[] {
  return [...REGISTRO.values()]
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
