import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Client } from 'pg'

/**
 * Aplicador de migrations.
 *
 * Forward-only e transacional: cada arquivo roda dentro da própria transação e
 * é registrado no mesmo commit. Se o SQL falhar, nada daquele arquivo fica —
 * não existe migration pela metade.
 *
 * O registro é o que torna a operação idempotente: rodar duas vezes aplica uma.
 */

const LEDGER = `
  CREATE TABLE IF NOT EXISTS migrations_aplicadas (
    nome        TEXT PRIMARY KEY,
    aplicada_em TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`

export interface ResultadoDaMigracao {
  readonly aplicadas: readonly string[]
  readonly jaEstavam: readonly string[]
}

export async function aplicarMigrations(
  cliente: Client,
  diretorio: string,
): Promise<ResultadoDaMigracao> {
  await cliente.query(LEDGER)

  const arquivos = (await readdir(diretorio)).filter((n) => n.endsWith('.sql')).sort()

  const aplicadas: string[] = []
  const jaEstavam: string[] = []

  for (const nome of arquivos) {
    const { rowCount } = await cliente.query(
      'SELECT 1 FROM migrations_aplicadas WHERE nome = $1',
      [nome],
    )
    if (rowCount !== null && rowCount > 0) {
      jaEstavam.push(nome)
      continue
    }

    const sql = await readFile(join(diretorio, nome), 'utf8')
    await cliente.query('BEGIN')
    try {
      await cliente.query(sql)
      await cliente.query('INSERT INTO migrations_aplicadas (nome) VALUES ($1)', [nome])
      await cliente.query('COMMIT')
      aplicadas.push(nome)
    } catch (erro) {
      await cliente.query('ROLLBACK')
      throw new Error(`Migration ${nome} falhou: ${(erro as Error).message}`, { cause: erro })
    }
  }

  return { aplicadas, jaEstavam }
}
