import { randomBytes } from 'node:crypto'
import type Redis from 'ioredis'

/**
 * O estado de uma tentativa de login pelo Google — `spec-autenticacao.md` §1.
 *
 * Três segredos de 256 bits que precisam sobreviver ao redirecionamento, e
 * **exatamente uma vez**:
 *
 * | | Contra o quê |
 * |---|---|
 * | `state` | CSRF no retorno: alguém entrega à vítima um retorno de autorização da conta *dele* |
 * | `nonce` | replay de `id_token` capturado noutra sessão |
 * | `verifier` (PKCE) | quem intercepta o código não consegue trocá-lo por token |
 *
 * ## Por que no servidor, e não num cookie
 *
 * Um cookie assinado carregando o `verifier` funciona e é tentador — não exige
 * Redis. Mas o `state` precisa ser de **uso único**, e uso único é uma
 * propriedade que só existe onde há estado compartilhado: um cookie pode ser
 * apresentado dez vezes, e o servidor não tem como saber. O consumo aqui é
 * atômico (`GETDEL`), e a segunda apresentação do mesmo `state` não encontra
 * nada.
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
   * Para onde voltar depois de entrar. Vem da nossa própria interface e é
   * validado como caminho relativo **antes** de entrar aqui: um `destino`
   * absoluto transformaria o login num redirecionador aberto.
   */
  readonly destino: string
}

export class EstadoDoOauth {
  constructor(private readonly redis: Redis) {}

  /** Abre uma tentativa e devolve os três segredos. */
  async abrir(destino: string): Promise<TentativaDeEntrada> {
    const tentativa: TentativaDeEntrada = {
      state: randomBytes(32).toString('hex'),
      nonce: randomBytes(32).toString('hex'),
      verifier: randomBytes(32).toString('base64url'),
      destino,
    }

    await this.redis.set(
      chave(tentativa.state),
      JSON.stringify({
        nonce: tentativa.nonce,
        verifier: tentativa.verifier,
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
  async consumir(state: string): Promise<TentativaDeEntrada | null> {
    if (!/^[0-9a-f]{64}$/.test(state)) return null

    const bruto = await this.redis.getdel(chave(state))
    if (!bruto) return null

    try {
      const d = JSON.parse(bruto) as { nonce: string; verifier: string; destino: string }
      return { state, nonce: d.nonce, verifier: d.verifier, destino: d.destino }
    } catch {
      return null
    }
  }
}

/** O símbolo de injeção. */
export const ESTADO_OAUTH = Symbol('ESTADO_OAUTH')
