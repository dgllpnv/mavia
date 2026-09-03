import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import Redis from 'ioredis'
import { RedisContainer } from '@testcontainers/redis'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { criarAplicacao } from '../src/aplicacao.js'
import { autenticadorDeSessao } from '../src/autenticacao/autenticador.js'
import { CofreDeAcesso } from '../src/redis/cofre-de-acesso.js'
import { LimiteDeTentativas } from '../src/redis/limite-de-tentativas.js'
import type { Mensageiro, Mensagem } from '../src/mensageiro/mensageiro.js'
import { semearDoisTenants, subirPostgres, USUARIO_A, USUARIO_B, type BancoDeTeste } from './postgres.js'

/**
 * Sobe a aplicação HTTP real sobre um Postgres real, com dois tenants semeados
 * e uma sessão por usuário.
 *
 * A conexão da aplicação é `mavia_app`, nunca o superusuário: é o papel que
 * responde requisição em produção, e é o único sobre o qual a RLS de fato
 * incide. Testar pela conexão privilegiada provaria apenas que o SQL compila.
 */

export interface ApiDeTeste {
  readonly banco: BancoDeTeste
  readonly app: NestFastifyApplication
  /** Exposto para os testes de sessão, que precisam olhar dentro do cofre. */
  readonly redis: Redis
  /** O refresh emitido para cada usuário na semeadura. */
  readonly refresh: ReadonlyMap<string, string>
  /**
   * As mensagens que teriam saído.
   *
   * Um mensageiro que **guarda** em vez de enviar, e não um que descarta: o
   * token do link é a credencial inteira, e o fluxo de cadastro só é testável
   * de ponta a ponta se o teste puder abrir a caixa. Um duplo que devolvesse
   * sucesso e jogasse fora deixaria a metade que importa sem prova.
   */
  readonly caixaDeEntrada: Mensagem[]
  /** Requisição autenticada. Sem `usuario` não vai token; sem `tenant`, sem espaço. */
  pedir(opcoes: {
    metodo: string
    url: string
    usuario?: string
    tenant?: string
    corpo?: unknown
    /** Cabeçalhos extras — `Idempotency-Key`, por exemplo. */
    cabecalhos?: Record<string, string>
  }): ReturnType<NestFastifyApplication['inject']>
  encerrar(): Promise<void>
}

export async function subirApi(): Promise<ApiDeTeste> {
  const banco = await subirPostgres()
  await semearDoisTenants(banco.cliente)

  // `mavia_app` nasce NOLOGIN na migration — quem concede credencial é o
  // provisionamento do ambiente, não a migration. Aqui fazemos o que o SRE faz.
  await banco.cliente.query(`ALTER ROLE mavia_app LOGIN PASSWORD 'mavia_local_dev'`)

  const conexao = banco.cliente as unknown as { connectionParameters: Record<string, unknown> }
  const pool = new Pool({
    host: conexao.connectionParameters['host'] as string,
    port: conexao.connectionParameters['port'] as number,
    database: conexao.connectionParameters['database'] as string,
    user: 'mavia_app',
    password: 'mavia_local_dev',
  })

  // **Redis de verdade, num contêiner.** O cofre do access token é a peça que
  // decide se uma requisição entra; provar isso contra um dublê provaria que o
  // dublê funciona. É a mesma razão de o Postgres ser real: RLS não se mocka, e
  // expiração de chave também não.
  const redisContainer = await new RedisContainer('redis:7-alpine').start()
  const redis = new Redis(redisContainer.getConnectionUrl(), { maxRetriesPerRequest: null })

  const cofre = new CofreDeAcesso(redis)
  const limite = new LimiteDeTentativas(redis, 'pepper-de-teste-suficientemente-longo')

  const caixaDeEntrada: Mensagem[] = []
  const mensageiro: Mensageiro = {
    configurado: true,
    enviar: async (m) => {
      caixaDeEntrada.push(m)
    },
  }

  const app = await criarAplicacao(
    pool,
    autenticadorDeSessao(pool, cofre),
    cofre,
    limite,
    mensageiro,
  )
  await app.init()

  // Uma sessão por usuário: refresh no Postgres, access no cofre. Exatamente o
  // que o login produz — o arreio não inventa um caminho de autenticação que a
  // aplicação não tem.
  const tokens = new Map<string, string>()
  const refresh = new Map<string, string>()
  for (const usuario of [USUARIO_A, USUARIO_B]) {
    const token = randomBytes(32).toString('hex')
    const hash = createHash('sha256').update(token, 'utf8').digest()
    const r = await banco.cliente.query<{ id: string }>(
      `INSERT INTO sessoes (usuario_id, familia_id, refresh_hash, plataforma,
                            expira_em, expira_absoluto_em)
       VALUES ($1, gen_random_uuid(), $2, 'web', now() + interval '14 days',
               now() + interval '30 days')
       RETURNING id`,
      [usuario, hash],
    )
    refresh.set(usuario, token)
    tokens.set(usuario, await cofre.emitir({ sessaoId: r.rows[0]!.id, usuarioId: usuario }))
  }

  return {
    banco,
    app,
    redis,
    refresh,
    caixaDeEntrada,
    pedir(opcoes) {
      const cabecalhos: Record<string, string> = { ...(opcoes.cabecalhos ?? {}) }
      if (opcoes.usuario) cabecalhos['authorization'] = `Bearer ${tokens.get(opcoes.usuario)}`
      if (opcoes.tenant) cabecalhos['x-mavia-tenant'] = opcoes.tenant
      return app.inject({
        method: opcoes.metodo as 'GET',
        url: opcoes.url,
        headers: cabecalhos,
        ...(opcoes.corpo !== undefined ? { payload: opcoes.corpo as object } : {}),
      })
    },
    async encerrar() {
      await app.close()
      await pool.end()
      redis.disconnect()
      await redisContainer.stop()
      await banco.encerrar()
    },
  }
}
