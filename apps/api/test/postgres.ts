import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client, Pool } from 'pg'
import { aplicarMigrations } from '../src/db/migrar.js'

/**
 * Postgres real, efêmero, por execução de suíte.
 *
 * RLS não pode ser mockada: um mock de RLS testa o mock (ADR 0004). Estes
 * testes sobem um Postgres de verdade, aplicam as migrations reais e exercitam
 * as policies como o banco de produção as executará.
 *
 * **As migrations rodam como `mavia_migrate`, não como superusuário.** Isso não
 * é preciosismo: rodando como superusuário, tudo passa — e passar assim esconde
 * exatamente os erros de permissão que aparecem no primeiro deploy. Rodar como
 * o papel real já revelou dois requisitos que nenhum documento de arquitetura
 * mencionava: `CREATEROLE` e `CREATE` na base.
 *
 * O container é próprio da suíte e não toca o ambiente local do `mavia.bat`.
 */

const AQUI = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(AQUI, '..', 'migrations')
const BOOTSTRAP = join(AQUI, '..', '..', '..', 'infra', 'bootstrap-papeis.sql')

const SENHA_MIGRATE = 'mavia_local_dev'

export interface BancoDeTeste {
  /** Conexão de superusuário. Usada só para semear, como um caminho privilegiado faria. */
  readonly cliente: Client
  /**
   * Abre um `Pool` autenticado **como um papel específico**.
   *
   * Existe para o painel de administração, cuja propriedade central é que a
   * separação leitura/escrita é por **autenticação** e não por instrução
   * (ADR 0024 D3). Um teste que use sempre a conexão de superusuário mede o
   * privilégio do superusuário — que é todo — e afirma o contrário do que quer.
   */
  poolComo(papel: string): Promise<Pool>
  encerrar(): Promise<void>
}

/**
 * A senha dos papéis provisionados no harness. Vale só dentro do container
 * descartável que o Testcontainers derruba ao fim da suíte.
 */
const SENHA_DE_TESTE = 'mavia_teste'

export async function subirPostgres(): Promise<BancoDeTeste> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:17-alpine')
    // UTC no banco, como em produção: um banco em horário local mascararia
    // bug de fuso justamente nos testes que deveriam pegá-lo.
    .withEnvironment({ TZ: 'UTC', PGTZ: 'UTC' })
    .start()

  const superusuario = new Client({ connectionString: container.getConnectionUri() })
  await superusuario.connect()

  // Papéis que em produção nascem fora das migrations, provisionados pelo SRE.
  await superusuario.query(await readFile(BOOTSTRAP, 'utf8'))

  // A partir daqui, o papel real. Se faltar um privilégio, o teste falha aqui
  // e não no dia do deploy.
  const migrador = new Client({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: 'mavia_migrate',
    password: SENHA_MIGRATE,
  })
  await migrador.connect()
  await aplicarMigrations(migrador, MIGRATIONS)
  await migrador.end()

  // Os papéis de conexão do painel nascem `NOLOGIN` na migration — condição
  // C-9. Aqui recebem credencial pelo mesmo caminho que o SRE usa em produção
  // e a semente usa no ambiente local: **provisionamento**, nunca migration.
  //
  // `mavia_admin_contrato` e `mavia_admin_definer` continuam sem `LOGIN`, de
  // propósito: são donos de função, não conexão.
  // O provisionamento acontece em `poolComo`, sob demanda — ver ali o porquê.

  const pools: Pool[] = []

  return {
    cliente: superusuario,
    async poolComo(papel: string) {
      // Provisiona sob demanda, em vez de depender de quem provisionou antes.
      // Cada arquivo de teste tem o próprio container, então não há colisão —
      // e o teste deixa de quebrar quando outro arquivo muda a senha que usa.
      await superusuario.query(`ALTER ROLE ${papel} LOGIN PASSWORD '${SENHA_DE_TESTE}'`)
      const pool = new Pool({
        host: container.getHost(),
        port: container.getPort(),
        database: container.getDatabase(),
        user: papel,
        password: SENHA_DE_TESTE,
        max: 2,
      })
      pools.push(pool)
      return pool
    },
    async encerrar() {
      await Promise.all(pools.map((p) => p.end()))
      await superusuario.end()
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
 * Roda como superusuário de propósito: em produção quem cria tenant é o caminho
 * privilegiado do cadastro (`auth.*`, migration 0004), não o papel `mavia_app`
 * da requisição.
 */
export async function semearDoisTenants(cliente: Client): Promise<void> {
  await cliente.query(
    `INSERT INTO tenants (id, nome) VALUES ($1, 'Família A'), ($2, 'Família B')`,
    [TENANT_A, TENANT_B],
  )
  await cliente.query(
    `INSERT INTO usuarios (id, email, nome, email_verificado_em)
     VALUES ($1, 'ana@exemplo.com', 'Ana', now()), ($2, 'bruno@exemplo.com', 'Bruno', now())`,
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
  return comoPapel(cliente, 'mavia_app', contexto, trabalho)
}

/** Idem, para qualquer papel — usado para provar o que cada um NÃO pode. */
export async function comoPapel<T>(
  cliente: Client,
  papel: string,
  contexto: { tenantId?: string; usuarioId?: string },
  trabalho: () => Promise<T>,
): Promise<T> {
  await cliente.query('BEGIN')
  try {
    await cliente.query(`SET LOCAL ROLE ${papel}`)
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
