import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'
import { aplicarMigrations } from '../src/db/migrar.js'

/**
 * Postgres real, efêmero, por execução de suíte.
 *
 * RLS não pode ser mockada: um mock de RLS testa o mock (ADR 0004). Estes
 * testes sobem um Postgres de verdade, aplicam as migrations reais e exercitam
 * as policies como o banco de produção as executará.
 *
 * O container é próprio da suíte e não toca o ambiente local do `mavia.bat`.
 */

const AQUI = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(AQUI, '..', 'migrations')

export interface BancoDeTeste {
  readonly cliente: Client
  encerrar(): Promise<void>
}

export async function subirPostgres(): Promise<BancoDeTeste> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:17-alpine')
    // UTC no banco, como em produção: um banco em horário local mascararia
    // bug de fuso justamente nos testes que deveriam pegá-lo.
    .withEnvironment({ TZ: 'UTC', PGTZ: 'UTC' })
    .start()

  const cliente = new Client({ connectionString: container.getConnectionUri() })
  await cliente.connect()
  await aplicarMigrations(cliente, MIGRATIONS)

  return {
    cliente,
    async encerrar() {
      await cliente.end()
      await container.stop()
    },
  }
}

/** Ids fixos: o teste fica legível, e a falha aponta para o tenant certo. */
export const TENANT_A = '11111111-1111-1111-1111-111111111111'
export const TENANT_B = '22222222-2222-2222-2222-222222222222'
export const USUARIO_A = 'aaaaaaaa-0000-0000-0000-00000000000a'
export const USUARIO_B = 'bbbbbbbb-0000-0000-0000-00000000000b'

/**
 * Semeia dois tenants completos e isolados.
 *
 * Roda como superusuário de propósito: em produção quem cria tenant é um
 * caminho privilegiado, não o papel `mavia_app` da requisição. Ver a lacuna
 * registrada no fim de `rls.test.ts`.
 */
export async function semearDoisTenants(cliente: Client): Promise<void> {
  await cliente.query(
    `INSERT INTO tenants (id, nome) VALUES ($1, 'Família A'), ($2, 'Família B')`,
    [TENANT_A, TENANT_B],
  )
  await cliente.query(
    `INSERT INTO usuarios (id, email, nome)
     VALUES ($1, 'ana@exemplo.com', 'Ana'), ($2, 'bruno@exemplo.com', 'Bruno')`,
    [USUARIO_A, USUARIO_B],
  )
  await cliente.query(
    `INSERT INTO tenant_usuarios (tenant_id, usuario_id, papel)
     VALUES ($1, $2, 'proprietario'), ($3, $4, 'proprietario')`,
    [TENANT_A, USUARIO_A, TENANT_B, USUARIO_B],
  )
  await cliente.query(
    `INSERT INTO contas (tenant_id, nome) VALUES ($1, 'Conta da Ana'), ($2, 'Conta do Bruno')`,
    [TENANT_A, TENANT_B],
  )
}

/**
 * Executa uma unidade de trabalho como `mavia_app`, com o contexto de tenant
 * definido por `SET LOCAL` — que é como a aplicação fará.
 *
 * `SET LOCAL` e não `SET`: o valor morre com a transação. Numa conexão de
 * pool, `SET` vazaria o contexto de um cliente para o próximo.
 */
export async function comoApp<T>(
  cliente: Client,
  contexto: { tenantId?: string; usuarioId?: string },
  trabalho: () => Promise<T>,
): Promise<T> {
  await cliente.query('BEGIN')
  try {
    await cliente.query('SET LOCAL ROLE mavia_app')
    if (contexto.usuarioId !== undefined) {
      await cliente.query('SELECT set_config($1, $2, true)', ['app.usuario_id', contexto.usuarioId])
    }
    if (contexto.tenantId !== undefined) {
      await cliente.query('SELECT set_config($1, $2, true)', ['app.tenant_id', contexto.tenantId])
    }
    const resultado = await trabalho()
    await cliente.query('COMMIT')
    return resultado
  } catch (erro) {
    await cliente.query('ROLLBACK')
    throw erro
  }
}
