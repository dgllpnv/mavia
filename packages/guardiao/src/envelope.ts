import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * O envelope — AES-256-GCM com dado autenticado adicional.
 *
 * Implementa o ADR 0018, D1 e D2. É o **único** lugar do sistema que cifra
 * segredo, e é puro: recebe chave, recebe AAD, devolve bytes. Não sabe onde a
 * KEK mora, não sabe o que é uma conexão, e não faz I/O.
 *
 * ## O formato do blob
 *
 * ```
 * versao_formato(1) || kek_versao(2, big-endian) || nonce(12) || ciphertext || tag(16)
 * ```
 *
 * Autodescritivo e versionado. `versao_formato` permite trocar de algoritmo sem
 * migração destrutiva; `kek_versao` viaja no blob **e** numa coluna — no blob
 * para que o material seja recuperável isoladamente, na coluna para que a
 * rotação seja indexável.
 *
 * ## O AAD, e o que ele impede
 *
 * Sem dado autenticado adicional, quem tiver escrita no banco copia o blob de
 * uma conexão para outra — inclusive de um tenant para outro — e o desembrulho
 * funciona normalmente. O envelope protegeria contra leitura e **não** contra
 * substituição.
 *
 * ```
 * AAD = versao_formato || 0x00 || proposito || 0x00 || tenant_id || 0x00 || recurso_id || 0x00 || kek_versao
 * ```
 *
 * O AAD é **reconstruído do contexto** no desembrulho, nunca lido do blob. Um
 * blob movido para outra linha falha a autenticação porque o AAD reconstruído
 * não bate — e falha com erro, não com decifragem silenciosa.
 */

/** Um byte. Trocar de algoritmo é incrementá-lo, não migrar dado. */
export const VERSAO_DO_FORMATO = 1

const TAMANHO_DA_CHAVE = 32
const TAMANHO_DO_NONCE = 12
const TAMANHO_DA_TAG = 16
const CABECALHO = 3

/**
 * O propósito é um **enum fechado** — ADR 0018 D2.
 *
 * Fechado porque ele entra no AAD: um propósito novo criado à revelia produziria
 * blobs que o resto do sistema não sabe desembrulhar, e a descoberta seria no
 * dia do incidente.
 */
export type Proposito = 'conexao.credenciais' | 'usuario.mfa'

/**
 * `usuarios` é global e não tem tenant (achado A-17). O UUID nulo ocupa o lugar
 * para que o AAD tenha sempre a mesma forma — um AAD de tamanho variável por
 * propósito seria mais uma coisa a errar.
 */
export const SEM_TENANT = '00000000-0000-0000-0000-000000000000'

export interface Contexto {
  readonly proposito: Proposito
  readonly tenantId: string
  readonly recursoId: string
  readonly kekVersao: number
}

export class EnvelopeInvalido extends Error {
  constructor(motivo: string) {
    super(`Envelope inválido: ${motivo}`)
    this.name = 'EnvelopeInvalido'
  }
}

/**
 * O AAD, reconstruído do contexto.
 *
 * Separadores `0x00` entre os campos, e não concatenação simples: sem eles,
 * `("ab", "c")` e `("a", "bc")` produzem o mesmo AAD, e dois recursos distintos
 * passariam a aceitar o blob um do outro.
 */
export function aadDe(contexto: Contexto): Buffer {
  const kekVersao = Buffer.alloc(2)
  kekVersao.writeUInt16BE(contexto.kekVersao)

  return Buffer.concat([
    Buffer.from([VERSAO_DO_FORMATO]),
    Buffer.from([0]),
    Buffer.from(contexto.proposito, 'utf8'),
    Buffer.from([0]),
    Buffer.from(contexto.tenantId, 'utf8'),
    Buffer.from([0]),
    Buffer.from(contexto.recursoId, 'utf8'),
    Buffer.from([0]),
    kekVersao,
  ])
}

/**
 * Cifra.
 *
 * O nonce é **96 bits aleatórios por operação**, de CSPRNG. Nunca contador,
 * nunca derivado do id da linha: em GCM, repetir nonce com a mesma chave não
 * degrada a segurança — ela desaparece, e o atacante recupera o XOR dos dois
 * textos claros e forja mensagens.
 */
export function embrulhar(chave: Buffer, contexto: Contexto, claro: Buffer): Buffer {
  exigirChave(chave)
  exigirVersao(contexto.kekVersao)

  const nonce = randomBytes(TAMANHO_DO_NONCE)
  const cifrador = createCipheriv('aes-256-gcm', chave, nonce)
  cifrador.setAAD(aadDe(contexto))

  const cifrado = Buffer.concat([cifrador.update(claro), cifrador.final()])
  const tag = cifrador.getAuthTag()

  const cabecalho = Buffer.alloc(CABECALHO)
  cabecalho.writeUInt8(VERSAO_DO_FORMATO, 0)
  cabecalho.writeUInt16BE(contexto.kekVersao, 1)

  return Buffer.concat([cabecalho, nonce, cifrado, tag])
}

/**
 * Decifra, e **falha** quando qualquer coisa não bate.
 *
 * A versão de KEK vem do contexto de quem chama, e o blob traz a dele: se as
 * duas divergirem, o desembrulho é recusado antes de tentar. Sem essa
 * conferência, um blob da versão antiga apresentado com o contexto da versão
 * nova falharia na tag — o que dá o mesmo desfecho, mas com uma mensagem que
 * não diz o que aconteceu.
 */
export function desembrulhar(chave: Buffer, contexto: Contexto, blob: Buffer): Buffer {
  exigirChave(chave)

  if (blob.length < CABECALHO + TAMANHO_DO_NONCE + TAMANHO_DA_TAG) {
    throw new EnvelopeInvalido('curto demais para conter nonce e tag')
  }

  const versaoDoFormato = blob.readUInt8(0)
  if (versaoDoFormato !== VERSAO_DO_FORMATO) {
    throw new EnvelopeInvalido(`formato ${versaoDoFormato} desconhecido`)
  }

  const kekVersaoDoBlob = blob.readUInt16BE(1)
  if (kekVersaoDoBlob !== contexto.kekVersao) {
    throw new EnvelopeInvalido(
      `este blob foi selado com a KEK ${kekVersaoDoBlob}, e o contexto pede a ${contexto.kekVersao}`,
    )
  }

  const nonce = blob.subarray(CABECALHO, CABECALHO + TAMANHO_DO_NONCE)
  const tag = blob.subarray(blob.length - TAMANHO_DA_TAG)
  const cifrado = blob.subarray(CABECALHO + TAMANHO_DO_NONCE, blob.length - TAMANHO_DA_TAG)

  const decifrador = createDecipheriv('aes-256-gcm', chave, nonce)
  decifrador.setAAD(aadDe(contexto))
  decifrador.setAuthTag(tag)

  try {
    return Buffer.concat([decifrador.update(cifrado), decifrador.final()])
  } catch {
    // A mensagem **não** distingue "chave errada" de "AAD errado" de "blob
    // adulterado". As três significam a mesma coisa para quem chama — este
    // material não é seu — e distingui-las seria um oráculo.
    throw new EnvelopeInvalido('não autenticado')
  }
}

/** A versão de KEK que selou um blob, sem decifrar nada. Para a rotação. */
export function kekVersaoDe(blob: Buffer): number {
  if (blob.length < CABECALHO) throw new EnvelopeInvalido('curto demais para ter cabeçalho')
  return blob.readUInt16BE(1)
}

/** Uma DEK nova. 256 bits de CSPRNG, e nada mais. */
export function gerarDek(): Buffer {
  return randomBytes(TAMANHO_DA_CHAVE)
}

/**
 * Apaga uma chave da memória.
 *
 * Não é garantia — o coletor de lixo do V8 pode ter copiado o buffer antes —,
 * mas reduz a janela em que a chave aparece num dump de memória. Chamar isto é
 * barato; não chamar é deixar material vivo por tempo indeterminado.
 */
export function zerar(chave: Buffer): void {
  chave.fill(0)
}

/** Comparação em tempo constante, para quando um segredo for comparado. */
export function iguais(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

function exigirChave(chave: Buffer): void {
  if (chave.length !== TAMANHO_DA_CHAVE) {
    throw new EnvelopeInvalido(`a chave tem ${chave.length} bytes, e precisa ter 32`)
  }
}

function exigirVersao(versao: number): void {
  if (!Number.isInteger(versao) || versao < 1 || versao > 0xffff) {
    throw new EnvelopeInvalido(`versão de KEK fora de 1..65535: ${versao}`)
  }
}
