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
const MIGRATIONS = join(AQUI, '..', '..', 'migrations')

const URL_PADRAO = 'postgres://mavia_migrate:mavia_local_dev@127.0.0.1:4732/mavia'

async function principal(): Promise<void> {
  const cliente = new Client({
    connectionString: process.env['DATABASE_URL_MIGRATE'] ?? URL_PADRAO,
  })
  await cliente.connect()

  try {
    const r = await aplicarMigrations(cliente, MIGRATIONS)
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
