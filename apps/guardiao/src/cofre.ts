import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  desembrulhar,
  embrulhar,
  gerarDek as novaDek,
  zerar,
  type Contexto,
} from '@mavia/guardiao'

/**
 * O cofre — a KEK em memória, e as cinco propriedades do ADR 0018 D3.2.
 *
 * **Os campos e os métodos internos usam `#`, e não `private`.** O `private` do
 * TypeScript é apagado na compilação: os métodos ficam no protótipo, e
 * `(cofre as any).kekPara(1)` devolveria a KEK em tempo de execução. Foi um
 * teste de superfície que encontrou isso — ele lista o protótipo e exige que
 * nada com "kek" no nome esteja lá.
 *
 * Separado do transporte de propósito: o que decide se um desembrulho acontece
 * não deve depender de socket, de JSON nem de processo. Assim ele é testável
 * sem subir nada, e é.
 *
 * ## As cinco propriedades, e onde cada uma está
 *
 * | # | Propriedade | Onde |
 * |---|---|---|
 * | 1 | nenhuma operação devolve KEK | **não existe** método que a devolva |
 * | 2 | sem porta TCP | no transporte (`servidor.ts`) |
 * | 3 | teto de desembrulho **sela** o cofre e alerta | aqui |
 * | 4 | todo desembrulho é registrado fora do Postgres | aqui, via `aoRegistrar` |
 * | 5 | `reenvelopar` para a DEK não transitar na rotação | aqui |
 *
 * A propriedade 1 não é uma verificação: é a **ausência** de um método. Um
 * `exportarKek()` que existisse "só para o teste" seria a porta que o incidente
 * usa.
 */

/**
 * Teto de desembrulhos por hora.
 *
 * Dimensionado ao uso legítimo: uma conexão sincroniza no máximo seis vezes por
 * dia, e o produto não tem mil conexões. Um pedido de desembrulho em massa é o
 * padrão de quem comprometeu a API e quer levar tudo — e é isso que este número
 * converte de "improvável" em "limitado e detectado".
 */
const TETO_POR_HORA = 500

const UMA_HORA_MS = 60 * 60 * 1000

export interface Registro {
  readonly em: string
  readonly operacao: string
  readonly proposito: string
  readonly tenantId: string
  readonly recursoId: string
  readonly kekVersao: number
  readonly desfecho: 'ok' | 'recusado' | 'selado'
}

export class CofreSelado extends Error {
  constructor(motivo: string) {
    super(`O guardião está selado: ${motivo}`)
    this.name = 'CofreSelado'
  }
}

export interface OpcoesDoCofre {
  /** Chamado a cada operação sobre material. Escreve fora do Postgres. */
  aoRegistrar(registro: Registro): void
  /** Chamado quando o teto é estourado. É o alarme do operador. */
  aoAlarmar(mensagem: string): void
  readonly tetoPorHora?: number
}

export class Cofre {
  /**
   * As KEKs, por versão. Mais de uma durante a janela de rotação: a antiga
   * desembrulha, a nova embrulha.
   */
  readonly #keks = new Map<number, Buffer>()
  #versaoDeEscrita: number | null = null
  #pepper: Buffer | null = null

  #desembrulhosNaJanela = 0
  #janelaComecouEm = Date.now()
  #seladoPorAbuso = false
  readonly #opcoes: OpcoesDoCofre

  constructor(opcoes: OpcoesDoCofre) {
    this.#opcoes = opcoes
  }

  /**
   * Desselar: a KEK entra aqui, e **só aqui**.
   *
   * Opção B do D3.3: a chave vive em memória, carregada no boot por um
   * desselamento manual. A consequência operacional é assumida e está no
   * runbook — todo reboot da VPS exige desselamento, e enquanto o cofre estiver
   * selado a sincronização bancária não funciona (o resto do produto sim).
   */
  desselar(versao: number, kek: Buffer): void {
    if (kek.length !== 32) throw new Error('A KEK precisa ter 32 bytes.')
    if (!Number.isInteger(versao) || versao < 1) throw new Error('Versão de KEK inválida.')

    this.#keks.set(versao, Buffer.from(kek))
    // A **maior** versão passa a ser a de escrita. Durante a rotação as duas
    // ficam carregadas, e embrulhar sempre usa a mais nova.
    this.#versaoDeEscrita = Math.max(this.#versaoDeEscrita ?? 0, versao)

    // O pepper do `ip_hash` é derivado da KEK, e não uma segunda chave a
    // guardar: um segredo a menos para desselar é um segredo a menos para
    // perder.
    this.#pepper = createHmac('sha256', kek).update('pepper:ip_hash', 'utf8').digest()
  }

  /** Selar de volta. Usado no alarme e no desligamento. */
  selar(): void {
    for (const kek of this.#keks.values()) zerar(kek)
    this.#keks.clear()
    if (this.#pepper) zerar(this.#pepper)
    this.#pepper = null
    this.#versaoDeEscrita = null
  }

  get selado(): boolean {
    return this.#versaoDeEscrita === null
  }

  get kekVersaoAtual(): number | null {
    return this.#versaoDeEscrita
  }

  /**
   * Uma DEK nova, já envelopada.
   *
   * A DEK **nasce aqui**, com o CSPRNG do guardião, e não na aplicação: uma DEK
   * gerada no processo que também interpreta entrada de usuário nasce num
   * espaço de memória mais exposto do que precisa.
   */
  gerarDek(contexto: Contexto): { dek: Buffer; dekCifrada: Buffer; kekVersao: number } {
    const kek = this.#kekDeEscrita()
    const dek = novaDek()
    const versao = this.#versaoDeEscrita!

    const dekCifrada = embrulhar(kek, { ...contexto, kekVersao: versao }, dek)
    this.#registrar('gerarDek', { ...contexto, kekVersao: versao }, 'ok')

    return { dek, dekCifrada, kekVersao: versao }
  }

  envelopar(contexto: Contexto, dek: Buffer): { dekCifrada: Buffer; kekVersao: number } {
    const kek = this.#kekDeEscrita()
    const versao = this.#versaoDeEscrita!

    const dekCifrada = embrulhar(kek, { ...contexto, kekVersao: versao }, dek)
    this.#registrar('envelopar', { ...contexto, kekVersao: versao }, 'ok')

    return { dekCifrada, kekVersao: versao }
  }

  /**
   * O caminho quente, e o único com teto.
   *
   * Embrulhar em massa não é sinal de nada — quem escreve credencial já tem a
   * credencial. **Desembrulhar** em massa é o padrão de quem comprometeu a API
   * e quer levar tudo, e é por isso que o teto vale só aqui.
   */
  desenvelopar(contexto: Contexto, dekCifrada: Buffer): Buffer {
    const kek = this.#kekPara(contexto.kekVersao)
    this.#contarDesembrulho(contexto)

    try {
      const dek = desembrulhar(kek, contexto, dekCifrada)
      this.#registrar('desenvelopar', contexto, 'ok')
      return dek
    } catch (erro) {
      this.#registrar('desenvelopar', contexto, 'recusado')
      throw erro
    }
  }

  /**
   * Rotação — a DEK **não sai**.
   *
   * Entra um envelope da versão antiga e sai um da nova. A aplicação nunca vê a
   * DEK durante a rotação, e o ciphertext das credenciais não é tocado: só a
   * DEK muda de envelope.
   */
  reenvelopar(contexto: Contexto, dekCifrada: Buffer, versaoDestino: number): Buffer {
    const kekOrigem = this.#kekPara(contexto.kekVersao)
    const kekDestino = this.#kekPara(versaoDestino)
    this.#contarDesembrulho(contexto)

    const dek = desembrulhar(kekOrigem, contexto, dekCifrada)
    try {
      const novo = embrulhar(kekDestino, { ...contexto, kekVersao: versaoDestino }, dek)
      this.#registrar('reenvelopar', contexto, 'ok')
      return novo
    } finally {
      // A DEK viveu dentro deste método e morre aqui.
      zerar(dek)
    }
  }

  /**
   * O pepper do `ip_hash` — achado A-39.
   *
   * O HMAC acontece **aqui**, e a chave não sai: sem isso, o pepper seria mais
   * um segredo a guardar na aplicação, e a razão de o `ip_hash` existir é
   * justamente que o IP não deve ser reversível a partir do banco.
   */
  hmac(proposito: string, dados: Buffer): Buffer {
    if (this.selado || !this.#pepper) throw new CofreSelado('desselamento pendente')
    return createHmac('sha256', this.#pepper).update(`${proposito}:`, 'utf8').update(dados).digest()
  }

  // -------------------------------------------------------------------------

  #kekDeEscrita(): Buffer {
    if (this.selado) throw new CofreSelado('desselamento pendente')
    return this.#keks.get(this.#versaoDeEscrita!)!
  }

  #kekPara(versao: number): Buffer {
    if (this.selado) throw new CofreSelado('desselamento pendente')
    const kek = this.#keks.get(versao)
    if (!kek) {
      throw new CofreSelado(
        `a KEK versão ${versao} não está carregada — é a janela de rotação, e ela precisa ser desselada`,
      )
    }
    return kek
  }

  /**
   * O teto, e o que acontece ao estourá-lo.
   *
   * **Sela o cofre.** Não recusa a operação e segue: sela. Um pedido de
   * desembrulho em massa já significa que alguém está dentro, e continuar
   * atendendo os quinhentos seguintes seria entregar o resto enquanto o alarme
   * toca.
   */
  #contarDesembrulho(contexto: Contexto): void {
    if (this.#seladoPorAbuso) throw new CofreSelado('teto de desembrulho estourado')

    const agora = Date.now()
    if (agora - this.#janelaComecouEm >= UMA_HORA_MS) {
      this.#janelaComecouEm = agora
      this.#desembrulhosNaJanela = 0
    }

    this.#desembrulhosNaJanela++
    const teto = this.#opcoes.tetoPorHora ?? TETO_POR_HORA

    if (this.#desembrulhosNaJanela > teto) {
      this.#seladoPorAbuso = true
      this.#registrar('desenvelopar', contexto, 'selado')
      this.selar()
      this.#opcoes.aoAlarmar(
        `Teto de ${teto} desembrulhos por hora estourado. O guardião foi selado e ` +
          'a sincronização bancária parou. Isto é o padrão de quem comprometeu a API — ' +
          'investigue antes de desselar.',
      )
      throw new CofreSelado('teto de desembrulho estourado')
    }
  }

  /**
   * O registro, fora do Postgres.
   *
   * Fora de propósito: se o incidente for no banco, um log dentro dele é um log
   * que o atacante edita. É o insumo do art. 48 da LGPD quando o incidente for
   * neste ativo.
   *
   * Registra **quem foi tocado**, e nunca o material: nem DEK, nem ciphertext,
   * nem chave.
   */
  #registrar(operacao: string, contexto: Contexto, desfecho: Registro['desfecho']): void {
    this.#opcoes.aoRegistrar({
      em: new Date().toISOString(),
      operacao,
      proposito: contexto.proposito,
      tenantId: contexto.tenantId,
      recursoId: contexto.recursoId,
      kekVersao: contexto.kekVersao,
      desfecho,
    })
  }
}

/** Uma KEK nova, para o provisionamento. 256 bits de CSPRNG. */
export function gerarKek(): Buffer {
  return randomBytes(32)
}

/** Comparação em tempo constante, para o desselamento conferir um dígito. */
export function iguaisEmTempoConstante(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}
