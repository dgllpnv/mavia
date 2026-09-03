import { connect, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import {
  desembrulhar,
  embrulhar,
  zerar,
  type Contexto,
  type Pedido,
  type Resposta,
} from '@mavia/guardiao'

/**
 * O cliente do guardião — o lado da API do ADR 0018.
 *
 * A API **não tem a KEK**. Ela pede uma DEK, cifra a credencial com ela, guarda
 * o envelope no banco e joga a DEK fora. Quando precisar ler, manda o envelope
 * de volta e recebe a DEK por alguns milissegundos.
 *
 * ## Por que o cliente é fino e a decisão está do outro lado
 *
 * Tudo que decide — teto de desembrulho, registro fora do Postgres, recusa
 * quando selado — vive no processo do guardião, e não aqui. Um cliente que
 * "cacheasse a DEK para não incomodar o guardião" desfaria as propriedades 3 e
 * 4 da ADR sozinho, e é exatamente a otimização que parece razoável. **Não
 * existe cache de DEK neste arquivo, e não deve passar a existir.**
 *
 * ## Quando o guardião não está configurado
 *
 * `MAVIA_GUARDIAO_SOCKET` ausente é um estado legítimo: hoje o produto não tem
 * agregador ligado (ADR 0003 — a porta de receita não foi atingida), e o resto
 * da API funciona sem guardião nenhum. O que **não** é legítimo é degradar em
 * silêncio: qualquer operação sobre segredo lança `GuardiaoIndisponivel`, e o
 * chamador traduz para 503. Cifrar com uma chave de desenvolvimento porque o
 * socket não respondeu seria pior do que não cifrar — daria a aparência.
 */

export class GuardiaoIndisponivel extends Error {
  constructor(motivo: string) {
    super(`O guardião de chaves não atendeu: ${motivo}`)
    this.name = 'GuardiaoIndisponivel'
  }
}

/** Um pedido que não voltou neste prazo é uma falha, e não uma espera. */
const PRAZO_MS = 3_000

/**
 * São **dois** envelopes, e só um deles rotaciona.
 *
 * O envelope da DEK é feito pela KEK, dentro do guardião, e carrega a versão de
 * KEK real — é ele que `reenvelopar` troca. O envelope do segredo é feito pela
 * DEK, aqui, e a "versão" dele é a da DEK, que é 1 e não muda: trocar a DEK
 * exigiria recifrar o segredo, e `reenvelopar` existe precisamente para que a
 * rotação de KEK não precise disso.
 *
 * Carimbar a versão de KEK no envelope do segredo — que foi a primeira versão
 * deste arquivo — faria toda rotação invalidar todo ciphertext do sistema, e o
 * erro só apareceria na primeira leitura depois da rotação. Um teste de rotação
 * o encontrou; sem ele, um incidente encontraria.
 *
 * Nada se perde no AAD: quem impede o transplante de linha é o par
 * propósito/tenant/recurso, e ele continua lá, nos dois envelopes.
 */
const VERSAO_DA_DEK = 1

export interface OpcoesDoCliente {
  readonly caminho?: string | undefined
  readonly prazoMs?: number
}

export class ClienteDoGuardiao {
  readonly #caminho: string | undefined
  readonly #prazoMs: number

  constructor(opcoes: OpcoesDoCliente = {}) {
    this.#caminho = opcoes.caminho ?? process.env['MAVIA_GUARDIAO_SOCKET']
    this.#prazoMs = opcoes.prazoMs ?? PRAZO_MS
  }

  get configurado(): boolean {
    return typeof this.#caminho === 'string' && this.#caminho !== ''
  }

  /** O guardião está desselado? Usado pelo `/saude` e pelo runbook do boot. */
  async estado(): Promise<{ configurado: boolean; selado: boolean; kekVersao: number | null }> {
    if (!this.configurado) return { configurado: false, selado: true, kekVersao: null }

    try {
      const r = await this.#conversar({ id: randomUUID(), operacao: 'estado' })
      return {
        configurado: true,
        selado: r.selado !== false,
        kekVersao: r.kekVersaoAtual ?? null,
      }
    } catch {
      // Não atender é, para quem pergunta, indistinguível de estar selado: nos
      // dois casos a sincronização bancária não funciona.
      return { configurado: true, selado: true, kekVersao: null }
    }
  }

  /**
   * Cifrar um segredo novo.
   *
   * Devolve o que vai para o banco — **as duas colunas juntas**, porque separá-las
   * é como se perde a chave: um `UPDATE` que grave `credenciais_cifradas` sem
   * gravar `dek_cifrada` produz ciphertext eternamente ilegível, e o erro só
   * aparece na primeira leitura, semanas depois.
   */
  async cifrar(
    contexto: Omit<Contexto, 'kekVersao'>,
    claro: Buffer,
  ): Promise<{ cifrado: Buffer; dekCifrada: Buffer; kekVersao: number }> {
    const r = await this.#exigir({
      id: randomUUID(),
      operacao: 'gerarDek',
      contexto: { ...contexto, kekVersao: 0 },
    })

    const dek = base64(r.dek, 'DEK')
    try {
      return {
        cifrado: embrulhar(dek, { ...contexto, kekVersao: VERSAO_DA_DEK }, claro),
        dekCifrada: base64(r.material, 'envelope'),
        kekVersao: r.kekVersao!,
      }
    } finally {
      // A DEK viveu o tempo de uma cifragem.
      zerar(dek)
    }
  }

  /**
   * Decifrar.
   *
   * O `usar` recebe o texto claro e devolve o que dele se extrai. O segredo não
   * é *devolvido*: fica no escopo do callback e é zerado ao sair, inclusive
   * quando o callback lança. Devolver um `Buffer` deixaria a decisão de zerá-lo
   * com o chamador, e o chamador esquece.
   */
  async usarSegredo<T>(
    contexto: Contexto,
    dekCifrada: Buffer,
    cifrado: Buffer,
    usar: (claro: Buffer) => T | Promise<T>,
  ): Promise<T> {
    const r = await this.#exigir({
      id: randomUUID(),
      operacao: 'desenvelopar',
      contexto,
      material: dekCifrada.toString('base64'),
    })

    const dek = base64(r.dek, 'DEK')
    let claro: Buffer | null = null
    try {
      // O `contexto.kekVersao` que chegou é o da linha do banco, e serve ao
      // desembrulho da DEK, acima. O segredo foi selado pela DEK.
      claro = desembrulhar(dek, { ...contexto, kekVersao: VERSAO_DA_DEK }, cifrado)
      return await usar(claro)
    } finally {
      zerar(dek)
      if (claro) zerar(claro)
    }
  }

  /**
   * Rotação de KEK — a DEK não transita.
   *
   * Sai o envelope novo e o ciphertext da credencial **não é tocado**: rotacionar
   * a KEK não decifra segredo nenhum, e é isso que torna a rotação uma operação
   * de rotina em vez de um evento de risco.
   */
  async reenvelopar(contexto: Contexto, dekCifrada: Buffer, versaoDestino: number): Promise<Buffer> {
    const r = await this.#exigir({
      id: randomUUID(),
      operacao: 'reenvelopar',
      contexto,
      material: dekCifrada.toString('base64'),
      kekVersaoDestino: versaoDestino,
    })
    return base64(r.material, 'envelope')
  }

  /**
   * O `ip_hash` — achado A-39.
   *
   * O pepper não sai do guardião. Sem isso o hash seria reversível por quem
   * tivesse o banco e a chave da aplicação, e o IP voltaria a ser dado pessoal
   * legível — que é precisamente o que o `ip_hash` existe para evitar.
   */
  async hash(proposito: string, dados: Buffer): Promise<Buffer> {
    const r = await this.#exigir({
      id: randomUUID(),
      operacao: 'hmac',
      proposito,
      material: dados.toString('base64'),
    })
    return base64(r.material, 'hash')
  }

  // -------------------------------------------------------------------------

  async #exigir(pedido: Pedido) {
    if (!this.configurado) throw new GuardiaoIndisponivel('não configurado nesta instalação')
    return this.#conversar(pedido)
  }

  /**
   * Uma conexão por pedido.
   *
   * Socket local, sem handshake: o custo é de microssegundos, e a alternativa —
   * um socket persistente com mapa de pendências por id — traz reconexão,
   * pedidos órfãos e um estado a mais para errar. Só valeria a pena num volume
   * que o produto não tem: uma conexão sincroniza seis vezes por dia.
   */
  #conversar(pedido: Pedido): Promise<Extract<Resposta, { ok: true }>> {
    const caminho = this.#caminho!

    return new Promise((resolver, rejeitar) => {
      const socket: Socket = connect(caminho)
      let acumulado = ''
      let encerrado = false

      const fim = (erro: Error | null, resposta?: Extract<Resposta, { ok: true }>) => {
        if (encerrado) return
        encerrado = true
        clearTimeout(relogio)
        socket.destroy()
        if (erro) rejeitar(erro)
        else resolver(resposta!)
      }

      const relogio = setTimeout(
        () => fim(new GuardiaoIndisponivel('prazo esgotado')),
        this.#prazoMs,
      )

      socket.on('connect', () => socket.write(`${JSON.stringify(pedido)}\n`))
      socket.on('error', (e) => fim(new GuardiaoIndisponivel(e.message)))
      socket.on('close', () => fim(new GuardiaoIndisponivel('conexão fechada sem resposta')))

      socket.on('data', (pedaco) => {
        acumulado += pedaco.toString('utf8')
        const quebra = acumulado.indexOf('\n')
        if (quebra < 0) return

        let resposta: Resposta
        try {
          resposta = JSON.parse(acumulado.slice(0, quebra)) as Resposta
        } catch {
          fim(new GuardiaoIndisponivel('resposta ilegível'))
          return
        }

        if (!resposta.ok) fim(new GuardiaoIndisponivel(resposta.erro))
        else fim(null, resposta)
      })
    })
  }
}

function base64(valor: string | undefined, o_que: string): Buffer {
  if (typeof valor !== 'string') {
    throw new GuardiaoIndisponivel(`resposta sem ${o_que}`)
  }
  return Buffer.from(valor, 'base64')
}

/** O símbolo de injeção. Uma instância por processo. */
export const GUARDIAO = Symbol('GUARDIAO')
