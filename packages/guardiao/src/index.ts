/**
 * `@mavia/guardiao` — o envelope e o protocolo do guardião de chaves.
 *
 * Duas metades, e a separação é a decisão:
 *
 * - **`envelope`** é criptografia pura. Recebe chave, recebe AAD, devolve
 *   bytes. Usada pelo processo do guardião *e* pela aplicação, que cifra a
 *   credencial com a DEK que o guardião desembrulhou.
 * - **`protocolo`** é a conversa com o processo. A aplicação nunca vê a KEK; ela
 *   pede DEK e recebe DEK.
 */
export {
  aadDe,
  desembrulhar,
  embrulhar,
  EnvelopeInvalido,
  gerarDek,
  iguais,
  kekVersaoDe,
  zerar,
  SEM_TENANT,
  VERSAO_DO_FORMATO,
  type Contexto,
  type Proposito,
} from './envelope.js'

export {
  type Pedido,
  type Resposta,
  type Operacao,
} from './protocolo.js'
