import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { criarAplicacao } from '../src/aplicacao.js'
import { autenticadorDeSessao } from '../src/autenticacao/autenticador.js'
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
  /** Requisição autenticada. Sem `usuario` não vai token; sem `tenant`, sem espaço. */
  pedir(opcoes: {
    metodo: string
    url: string
    usuario?: string
    tenant?: string
    corpo?: unknown
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

  const app = await criarAplicacao(pool, autenticadorDeSessao(pool))
  await app.init()

  const tokens = new Map<string, string>()
  for (const usuario of [USUARIO_A, USUARIO_B]) {
    const token = randomBytes(32).toString('hex')
    const hash = createHash('sha256').update(token, 'utf8').digest()
    await banco.cliente.query(
      `INSERT INTO sessoes (usuario_id, familia_id, refresh_hash, plataforma,
                            expira_em, expira_absoluto_em)
       VALUES ($1, gen_random_uuid(), $2, 'web', now() + interval '14 days',
               now() + interval '30 days')`,
      [usuario, hash],
    )
    tokens.set(usuario, token)
  }

  return {
    banco,
    app,
    pedir(opcoes) {
      const cabecalhos: Record<string, string> = {}
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
      await banco.encerrar()
    },
  }
}
