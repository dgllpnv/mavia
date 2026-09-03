import { randomBytes } from 'node:crypto'
import type Redis from 'ioredis'

/**
 * O estado de uma tentativa de login pelo Google — `spec-autenticacao.md` §1.
 *
 * Quatro segredos de 256 bits que precisam sobreviver ao redirecionamento, e
 * **exatamente uma vez**:
 *
 * | | Contra o quê |
 * |---|---|
 * | `state` | correlaciona o retorno com a tentativa, e é de uso único |
 * | `vinculo` | **o CSRF de login**: o retorno só vale no navegador que começou |
 * | `nonce` | replay de `id_token` capturado noutra sessão |
 * | `verifier` (PKCE) | quem intercepta o código não consegue trocá-lo por token |
 *
 * ## Por que no servidor **e** num cookie
 *
 * Uso único é uma propriedade que só existe onde há estado compartilhado: um
 * cookie pode ser apresentado dez vezes e o servidor não tem como saber. Por
 * isso o consumo é atômico aqui (`GETDEL`).
 *
 * Mas **uso único não é proteção contra CSRF de login**, e a primeira versão
 * deste arquivo confundiu as duas coisas. O atacante que começa uma entrada com
 * a conta Google dele *conhece* o `state` — ele o gerou. Se ele entrega à
 * vítima um link com aquele `code` e aquele `state`, a nossa própria tela faz o
 * `POST`, e a vítima entra na conta do atacante e passa a lançar os dados
 * financeiros dela num espaço que ele lê.
 *
 * O que falta ao servidor é saber **qual navegador** começou. Daí o `vinculo`:
 * ele é escrito num cookie `__Host-` no início e conferido no retorno. O
 * navegador da vítima não tem o cookie do atacante, e o retorno é recusado.
 *
 * ## Por que dez minutos
 *
 * É o tempo de um humano ver a tela do Google, escolher a conta e, se
 * necessário, digitar a senha e o segundo fator. Mais que isso não é lentidão —
 * é uma aba esquecida aberta, e uma aba esquecida com um `state` vivo é uma
 * janela de ataque que ninguém está olhando.
 */

const VIDA_EM_SEGUNDOS = 10 * 60

const chave = (state: string) => `oauth:${state}`

export interface TentativaDeEntrada {
  readonly state: string
  readonly nonce: string
  readonly verifier: string
  /**
   * O que amarra a tentativa ao navegador. Vai num cookie `HttpOnly`, e o
   * `state` sozinho não substitui: o atacante conhece o `state`, e não tem como
   * escrever um cookie no navegador da vítima.
   */
  readonly vinculo: string
  /**
   * Para onde voltar depois de entrar. Vem da nossa própria interface e é
   * validado como caminho relativo **antes** de entrar aqui: um `destino`
   * absoluto transformaria o login num redirecionador aberto.
   */
  readonly destino: string
}

export class EstadoDoOauth {
  constructor(private readonly redis: Redis) {}

  /**
   * Abre uma tentativa e devolve os quatro segredos.
   *
   * O `vinculo` é o único que o chamador precisa **entregar ao navegador**, num
   * cookie. Os outros três ficam entre nós e o Google.
   */
  async abrir(destino: string): Promise<TentativaDeEntrada> {
    const tentativa: TentativaDeEntrada = {
      state: randomBytes(32).toString('hex'),
      nonce: randomBytes(32).toString('hex'),
      verifier: randomBytes(32).toString('base64url'),
      vinculo: randomBytes(32).toString('hex'),
      destino,
    }

    await this.redis.set(
      chave(tentativa.state),
      JSON.stringify({
        nonce: tentativa.nonce,
        verifier: tentativa.verifier,
        vinculo: tentativa.vinculo,
        destino: tentativa.destino,
      }),
      'EX',
      VIDA_EM_SEGUNDOS,
    )

    return tentativa
  }

  /**
   * Consome a tentativa. **Atômico, e uma vez só.**
   *
   * `GETDEL` e não `GET` seguido de `DEL`: entre os dois haveria uma janela em
   * que dois retornos simultâneos com o mesmo `state` seriam ambos aceitos — e
   * um `state` reutilizável não é `state` nenhum.
   */
  async consumir(state: string, vinculo: string | null): Promise<TentativaDeEntrada | null> {
    if (!/^[0-9a-f]{64}$/.test(state)) return null

    const bruto = await this.redis.getdel(chave(state))
    if (!bruto) return null

    let d: { nonce: string; verifier: string; vinculo?: string; destino: string }
    try {
      d = JSON.parse(bruto) as typeof d
    } catch {
      return null
    }

    // **Sem o vínculo, a tentativa não vale — e o `state` já foi consumido.**
    // Consumir antes de conferir é de propósito: um retorno com vínculo errado
    // é ataque, e a tentativa dele morre junto, sem deixar um `state` vivo para
    // uma segunda tentativa.
    if (typeof d.vinculo !== 'string' || vinculo === null || !iguais(d.vinculo, vinculo)) {
      return null
    }

    return { state, nonce: d.nonce, verifier: d.verifier, vinculo: d.vinculo, destino: d.destino }
  }
}

/** Comparação sem atalho de tempo — o vínculo é um segredo desta tentativa. */
function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diferenca = 0
  for (let i = 0; i < a.length; i++) diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diferenca === 0
}

/** O símbolo de injeção. */
export const ESTADO_OAUTH = Symbol('ESTADO_OAUTH')
