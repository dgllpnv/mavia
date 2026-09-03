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

describe('o que conta como local', () => {
  it('**um parâmetro na string de conexão não faz um banco remoto virar local**', async () => {
    // A versão anterior procurava `127.0.0.1` como substring em qualquer lugar
    // da URL. Bastava um parâmetro para a trava inteira cair — e a semente
    // reescreveria a credencial da API do banco de produção.
    const disfarcado = 'postgres://mavia:x@banco-de-producao.invalid:5432/mavia?opcao=127.0.0.1'
    const r = await semear({ DATABASE_URL_SEED: disfarcado, SENHA_DEMO: '' })

    expect(r.codigo).not.toBe(0)
    expect(r.saida).toContain('repositório público')
  }, 60_000)

  it('uma URL ilegível conta como remota', async () => {
    // Recusar o que não se entende é o único desfecho seguro para uma trava.
    const r = await semear({ DATABASE_URL_SEED: 'isto não é uma URL', SENHA_DEMO: '' })

    expect(r.codigo).not.toBe(0)
    expect(r.saida).toContain('repositório público')
  }, 60_000)
})

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

  it('**não provisiona papel de banco fora do local**', async () => {
    // A lição mais cara desta sessão: a semente fazia
    // `ALTER ROLE mavia_app PASSWORD 'mavia_local_dev'` sempre. Contra a VPS,
    // isso reescreveu a credencial da API com uma senha do repositório público,
    // e o login de produção passou a responder 500.
    const { readFileSync } = await import('node:fs')
    const fonte = readFileSync(SEMENTE, 'utf8')
    const linha = fonte.indexOf('ALTER ROLE mavia_app')

    expect(linha).toBeGreaterThan(0)
    // A instrução precisa estar dentro de um `if (ehLocal)`.
    expect(fonte.slice(Math.max(0, linha - 400), linha)).toContain('if (ehLocal)')
  })

  it('com senha própria, a trava sai da frente', async () => {
    // O outro lado: informada uma senha que não está publicada, o perigo
    // descrito deixa de existir e a semente segue — até falhar por não achar o
    // banco, que é o próximo obstáculo honesto.
    const r = await semear({ DATABASE_URL_SEED: REMOTO, SENHA_DEMO: 'uma senha que ninguem publicou' })

    expect(r.saida).not.toContain('repositório público')
    expect(r.saida).toMatch(/ENOTFOUND|EAI_AGAIN|getaddrinfo|banco-que-nao-existe/i)
  }, 60_000)
})
