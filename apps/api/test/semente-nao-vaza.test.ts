import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

/**
 * A trava da semente — o que ela protege é a **senha publicada**, não o
 * endereço do banco.
 *
 * `mavia-demonstracao` está no repositório público. Semear com ela um banco
 * alcançável pela internet significa que qualquer pessoa que leia o repositório
 * entra na instância. Os dados são fictícios e nunca foram o risco; a conta é
 * real e é todo o risco.
 *
 * Este arquivo executa a semente **de verdade**, como processo, contra uma URL
 * remota inventada. Ele nunca chega a conectar: a recusa acontece antes, e é
 * exatamente isso que se quer provar.
 */

const executar = promisify(execFile)
const SEMENTE = fileURLToPath(new URL('../src/db/semear.ts', import.meta.url))

/** Roda a semente e devolve o que ela escreveu, sem lançar. */
async function semear(env: NodeJS.ProcessEnv): Promise<{ codigo: number; saida: string }> {
  try {
    const r = await executar(process.execPath, ['--import', 'tsx', SEMENTE], {
      env: { ...process.env, ...env },
    })
    return { codigo: 0, saida: `${r.stdout}${r.stderr}` }
  } catch (erro) {
    const e = erro as { code?: number; stdout?: string; stderr?: string }
    return { codigo: e.code ?? 1, saida: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/** Um banco que não existe. A recusa precisa vir antes de qualquer conexão. */
const REMOTO = 'postgres://mavia:x@banco-que-nao-existe.invalid:5432/mavia'

describe('a semente contra um banco remoto', () => {
  it('**recusa quando a senha é a que está no repositório**', async () => {
    const r = await semear({ DATABASE_URL_SEED: REMOTO, SENHA_DEMO: '' })

    expect(r.codigo).not.toBe(0)
    expect(r.saida).toContain('repositório público')
  }, 60_000)

  it('**a recusa acontece antes de conectar**', async () => {
    // Se ela tentasse conectar primeiro, o erro seria de DNS — e a trava
    // passaria a depender de o banco estar inalcançável, que é sorte e não
    // proteção.
    const r = await semear({ DATABASE_URL_SEED: REMOTO, SENHA_DEMO: '' })

    expect(r.saida).not.toMatch(/ENOTFOUND|EAI_AGAIN|getaddrinfo/i)
  }, 60_000)

  it('com senha própria, a trava sai da frente', async () => {
    // O outro lado: informada uma senha que não está publicada, o perigo
    // descrito deixa de existir e a semente segue — até falhar por não achar o
    // banco, que é o próximo obstáculo honesto.
    const r = await semear({ DATABASE_URL_SEED: REMOTO, SENHA_DEMO: 'uma senha que ninguem publicou' })

    expect(r.saida).not.toContain('repositório público')
    expect(r.saida).toMatch(/ENOTFOUND|EAI_AGAIN|getaddrinfo|banco-que-nao-existe/i)
  }, 60_000)
})
