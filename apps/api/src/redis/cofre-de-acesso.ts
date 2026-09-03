import { createHash, randomBytes } from 'node:crypto'
import type Redis from 'ioredis'

/**
 * O cofre do access token.
 *
 * **Redis é a autoridade do access; Postgres é a autoridade do refresh.**
 * Perder o Redis não desloga ninguém: os clientes renovam pelo refresh, em
 * silêncio. Perder o Postgres é incidente de banco, não de sessão. Ver
 * `docs/produto/spec-autenticacao.md` §4.1.
 *
 * ## Por que opaco, e não JWT
 *
 * A matriz de acesso exige que revogar todas as sessões tenha efeito em menos
 * de 60 segundos **mesmo com access token válido em circulação**. Um JWT
 * auto-contido só cumpre isso com uma lista de revogação consultada a cada
 * requisição — que é exatamente uma busca em Redis, o mesmo custo do token
 * opaco, com um formato a mais para versionar e um punhado de claims a mais
 * para vazar. Com token opaco a revogação é **imediata**, e o token não carrega
 * nada sobre quem o porta.
 *
 * ## O índice reverso, e por que ele existe
 *
 * Resolver um token é o caminho quente: acontece em **toda** requisição, e
 * precisa ser um `GET` só. Revogar é raro. Por isso a sessão mantém um conjunto
 * dos hashes que emitiu — revogar percorre o conjunto e apaga, e a resolução
 * não paga nada por isso.
 *
 * A alternativa — marcar a sessão como revogada e conferir a marca a cada
 * requisição — inverteria o custo: duas idas ao Redis no caminho quente para
 * economizar uma escrita no caminho frio.
 */

/** 15 minutos. Um XSS rouba quinze minutos; não rouba semanas. */
export const VIDA_DO_ACESSO_EM_SEGUNDOS = 15 * 60

export interface DonoDoAcesso {
  readonly sessaoId: string
  readonly usuarioId: string
}

/** O token viaja em claro; no cofre vive só o hash. */
function hashDo(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

const chaveDoToken = (hash: string) => `sess:${hash}`
const chaveDaSessao = (sessaoId: string) => `acessos:${sessaoId}`

export class CofreDeAcesso {
  constructor(private readonly redis: Redis) {}

  /**
   * Emite um access token para uma sessão.
   *
   * 256 bits de CSPRNG, sem estrutura. Um token com estrutura é um token que
   * alguém vai tentar decodificar.
   */
  async emitir(dono: DonoDoAcesso): Promise<string> {
    const token = randomBytes(32).toString('hex')
    const hash = hashDo(token)

    await this.redis
      .multi()
      .set(chaveDoToken(hash), JSON.stringify(dono), 'EX', VIDA_DO_ACESSO_EM_SEGUNDOS)
      .sadd(chaveDaSessao(dono.sessaoId), hash)
      // O índice reverso expira sozinho: sem TTL ele cresceria para sempre com
      // hashes de tokens que já não existem.
      .expire(chaveDaSessao(dono.sessaoId), VIDA_DO_ACESSO_EM_SEGUNDOS)
      .exec()

    return token
  }

  /** O caminho quente: um `GET`, sem transação e sem segunda consulta. */
  async resolver(token: string): Promise<DonoDoAcesso | null> {
    if (!/^[0-9a-f]{64}$/.test(token)) return null

    const bruto = await this.redis.get(chaveDoToken(hashDo(token)))
    if (bruto === null) return null

    try {
      const dono = JSON.parse(bruto) as DonoDoAcesso
      // Desconfiar do próprio cofre: um valor corrompido não pode virar uma
      // sessão com `undefined` no lugar do usuário.
      if (typeof dono.sessaoId !== 'string' || typeof dono.usuarioId !== 'string') return null
      return dono
    } catch {
      return null
    }
  }

  /**
   * Revoga **todos** os access tokens de uma sessão, imediatamente.
   *
   * Chamada no logout, na rotação do refresh e na detecção de reuso. Depois
   * dela, um token em circulação vale zero — é o requisito que dispensou o JWT.
   */
  async revogarSessao(sessaoId: string): Promise<void> {
    const chave = chaveDaSessao(sessaoId)
    const hashes = await this.redis.smembers(chave)

    const multi = this.redis.multi()
    for (const hash of hashes) multi.del(chaveDoToken(hash))
    multi.del(chave)
    await multi.exec()
  }

  async revogarSessoes(sessoes: readonly string[]): Promise<void> {
    for (const id of sessoes) await this.revogarSessao(id)
  }
}
