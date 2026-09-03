import type { Contexto } from './envelope.js'

/**
 * O protocolo do guardião — ADR 0018, D3.2.
 *
 * Cinco operações, e **nenhuma delas devolve material de KEK**. Não existe
 * `exportarKek()`, e a ausência é a propriedade 1 da ADR: a API pode
 * desembrulhar enquanto vive, e não pode levar a chave embora.
 *
 * Linha a linha em JSON sobre um socket local. Não é HTTP de propósito: HTTP
 * traz servidor, roteador e middleware — três coisas com histórico de bug de
 * parsing — para dentro do processo que guarda o ativo mais grave do sistema.
 */

export type Operacao =
  /** Nasce aqui, com o CSPRNG do guardião. Devolve a DEK e o envelope dela. */
  | 'gerarDek'
  | 'envelopar'
  | 'desenvelopar'
  /** Rotação. A DEK **não sai**: entra um envelope e sai outro. */
  | 'reenvelopar'
  /** Pepper de `ip_hash` (achado A-39). Nunca devolve a chave do HMAC. */
  | 'hmac'
  | 'estado'

export interface Pedido {
  readonly id: string
  readonly operacao: Operacao
  readonly contexto?: Contexto
  /** Base64. Material que entra: DEK a envelopar, envelope a abrir, dados a assinar. */
  readonly material?: string
  /** Só em `reenvelopar`. */
  readonly kekVersaoDestino?: number
  /** Só em `hmac`. */
  readonly proposito?: string
}

export type Resposta =
  | { readonly id: string; readonly ok: true; readonly material?: string; readonly dek?: string; readonly kekVersao?: number; readonly selado?: boolean; readonly kekVersaoAtual?: number }
  | { readonly id: string; readonly ok: false; readonly erro: string }
