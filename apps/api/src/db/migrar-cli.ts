import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { aplicarMigrations } from './migrar.js'

/**
 * `pnpm db:migrate` — aplica as migrations no banco local.
 *
 * Conecta como **`mavia_migrate`**, nunca como superusuário. Rodar migration
 * com superusuário faz tudo passar, e passar assim esconde exatamente os erros
 * de permissão que aparecem no primeiro deploy: foi assim que descobrimos que
 * o papel precisava de `CREATEROLE` e de `CREATE` na base.
 */

const AQUI = dirname(fileURLToPath(import.meta.url))

/**
 * Onde estão os arquivos de migration.
 *
 * Dois lugares, e o primeiro é o de produção: no bundle, este arquivo vive em
 * `/app/migrar.js` e as migrations em `/app/migrations` — um diretório **irmão**.
 * No workspace, o fonte está em `src/db/` e as migrations dois níveis acima.
 *
 * O mesmo cuidado do executável do parser, e pela mesma razão: um caminho
 * relativo que só vale no workspace transforma o passo de migration do deploy
 * num "nada a aplicar" silencioso — o pior desfecho possível, porque o deploy
 * segue e a aplicação sobe contra um banco sem esquema.
 */
const MIGRATIONS =
  process.env['MAVIA_MIGRATIONS'] ??
  (existsSync(join(AQUI, 'migrations'))
    ? join(AQUI, 'migrations')
    : join(AQUI, '..', '..', 'migrations'))

const URL_PADRAO = 'postgres://mavia_migrate:mavia_local_dev@127.0.0.1:4732/mavia'

async function principal(): Promise<void> {
  const cliente = new Client({
    connectionString: process.env['DATABASE_URL_MIGRATE'] ?? URL_PADRAO,
  })
  await cliente.connect()

  try {
    console.log(`migrations em ${MIGRATIONS}`)
    const r = await aplicarMigrations(cliente, MIGRATIONS)
    // **Zero migrations é erro, não sucesso.** Um diretório vazio ou errado faz
    // `aplicarMigrations` devolver nada a aplicar e nada já aplicado — e o
    // deploy seguiria, subindo a aplicação contra um banco sem esquema.
    if (r.aplicadas.length === 0 && r.jaEstavam.length === 0) {
      throw new Error(`nenhuma migration encontrada em ${MIGRATIONS}`)
    }
    for (const nome of r.aplicadas) console.log(`aplicada  ${nome}`)
    console.log(
      r.aplicadas.length === 0
        ? `nada a aplicar — ${r.jaEstavam.length} migrations já estavam no banco`
        : `${r.aplicadas.length} aplicada(s), ${r.jaEstavam.length} já estavam`,
    )
  } finally {
    await cliente.end()
  }
}

principal().catch((erro: unknown) => {
  console.error(String((erro as Error).message))
  process.exitCode = 1
})
