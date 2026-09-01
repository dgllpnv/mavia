import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  comoApp,
  semearDoisTenants,
  subirPostgres,
  TENANT_A,
  TENANT_B,
  USUARIO_A,
  type BancoDeTeste,
} from './postgres.js'

/**
 * Isolamento entre clientes — a prova do ADR 0004.
 *
 * Contra Postgres real, com as migrations reais. A afirmação sob teste não é
 * "a aplicação filtra por tenant", e sim "o banco recusa a consulta que
 * esqueceu de filtrar".
 */

let banco: BancoDeTeste

beforeAll(async () => {
  banco = await subirPostgres()
  await semearDoisTenants(banco.cliente)
})

afterAll(async () => {
  await banco?.encerrar()
})

describe('isolamento entre tenants', () => {
  it('um tenant enxerga apenas as próprias contas', async () => {
    const nomes = await comoApp(banco.cliente, { tenantId: TENANT_A }, async () => {
      const r = await banco.cliente.query<{ nome: string }>('SELECT nome FROM contas')
      return r.rows.map((l) => l.nome)
    })

    expect(nomes).toEqual(['Conta da Ana'])
  })

  it('o outro tenant enxerga apenas as dele', async () => {
    const nomes = await comoApp(banco.cliente, { tenantId: TENANT_B }, async () => {
      const r = await banco.cliente.query<{ nome: string }>('SELECT nome FROM contas')
      return r.rows.map((l) => l.nome)
    })

    expect(nomes).toEqual(['Conta do Bruno'])
  })

  it('sem contexto de tenant, nenhuma linha é visível', async () => {
    // Zero linhas, nunca todas. Esta é a diferença entre falhar fechado e
    // vazar a base inteira quando alguém esquece o filtro.
    const total = await comoApp(banco.cliente, {}, async () => {
      const r = await banco.cliente.query<{ n: string }>('SELECT count(*) AS n FROM contas')
      return Number(r.rows[0]?.n ?? -1)
    })

    expect(total).toBe(0)
  })

  it('não vaza entre requisições que reaproveitam a mesma conexão', async () => {
    // O cenário real de um pool: a mesma conexão física serve clientes
    // diferentes em sequência. Foi aqui que o bug do current_setting apareceu.
    const primeira = await comoApp(banco.cliente, { tenantId: TENANT_A }, async () => {
      const r = await banco.cliente.query<{ n: string }>('SELECT count(*) AS n FROM contas')
      return Number(r.rows[0]?.n)
    })

    const semContexto = await comoApp(banco.cliente, {}, async () => {
      const r = await banco.cliente.query<{ n: string }>('SELECT count(*) AS n FROM contas')
      return Number(r.rows[0]?.n)
    })

    const segunda = await comoApp(banco.cliente, { tenantId: TENANT_B }, async () => {
      const r = await banco.cliente.query<{ nome: string }>('SELECT nome FROM contas')
      return r.rows.map((l) => l.nome)
    })

    expect(primeira).toBe(1)
    expect(semContexto).toBe(0) // e não um erro de cast de uuid vazio
    expect(segunda).toEqual(['Conta do Bruno'])
  })
})

describe('escrita cruzada', () => {
  it('recusa gravar linha de outro tenant', async () => {
    await expect(
      comoApp(banco.cliente, { tenantId: TENANT_A }, async () => {
        await banco.cliente.query('INSERT INTO contas (tenant_id, nome) VALUES ($1, $2)', [
          TENANT_B,
          'Invasora',
        ])
      }),
    ).rejects.toThrow(/row-level security/i)
  })

  it('recusa apagar linha de outro tenant, e a linha continua lá', async () => {
    const apagadas = await comoApp(banco.cliente, { tenantId: TENANT_A }, async () => {
      const r = await banco.cliente.query('DELETE FROM contas WHERE tenant_id = $1', [TENANT_B])
      return r.rowCount
    })

    // A RLS não deixa a linha nem ser vista, então o DELETE não encontra nada:
    // zero linhas afetadas, sem erro. Silencioso, e é o comportamento correto.
    expect(apagadas).toBe(0)

    const aindaExiste = await comoApp(banco.cliente, { tenantId: TENANT_B }, async () => {
      const r = await banco.cliente.query<{ n: string }>('SELECT count(*) AS n FROM contas')
      return Number(r.rows[0]?.n)
    })
    expect(aindaExiste).toBe(1)
  })
})

describe('o papel da aplicação não tem privilégio demais', () => {
  it('mavia_app não tem BYPASSRLS', async () => {
    const r = await banco.cliente.query<{ rolbypassrls: boolean }>(
      'SELECT rolbypassrls FROM pg_roles WHERE rolname = $1',
      ['mavia_app'],
    )

    expect(r.rows[0]?.rolbypassrls).toBe(false)
  })

  it('toda tabela de negócio tem RLS habilitada e forçada', async () => {
    const r = await banco.cliente.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname IN ('contas', 'tenants', 'usuarios', 'tenant_usuarios')`,
    )

    expect(r.rows).toHaveLength(4)
    for (const tabela of r.rows) {
      expect({ [tabela.relname]: tabela.relrowsecurity }).toEqual({ [tabela.relname]: true })
      // FORCE também: sem ele o dono da tabela ignora as policies, e o dono é
      // quem roda as migrations.
      expect({ [tabela.relname]: tabela.relforcerowsecurity }).toEqual({ [tabela.relname]: true })
    }
  })
})

describe('resolução de tenant — etapa 3', () => {
  it('o usuário enxerga o próprio vínculo usando só app.usuario_id', async () => {
    // A consulta que decide se o tenant pedido pertence ao usuário roda
    // ANTES de app.tenant_id existir. Se a policy exigisse tenant_id, a
    // resolução seria impossível e alguém a contornaria com BYPASSRLS.
    const papeis = await comoApp(banco.cliente, { usuarioId: USUARIO_A }, async () => {
      const r = await banco.cliente.query<{ tenant_id: string; papel: string }>(
        'SELECT tenant_id, papel FROM tenant_usuarios',
      )
      return r.rows
    })

    expect(papeis).toEqual([{ tenant_id: TENANT_A, papel: 'proprietario' }])
  })

  it('um usuário não enxerga o vínculo de outro', async () => {
    const papeis = await comoApp(banco.cliente, { usuarioId: USUARIO_A }, async () => {
      const r = await banco.cliente.query('SELECT 1 FROM tenant_usuarios WHERE tenant_id = $1', [
        TENANT_B,
      ])
      return r.rowCount
    })

    expect(papeis).toBe(0)
  })
})

describe('migrations', () => {
  it('aplicar de novo não repete nada', async () => {
    const { aplicarMigrations } = await import('../src/db/migrar.js')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

    const resultado = await aplicarMigrations(banco.cliente, dir)

    expect(resultado.aplicadas).toEqual([])
    expect(resultado.jaEstavam.length).toBeGreaterThan(0)
  })
})

/**
 * LACUNA CONHECIDA — criação de tenant (cadastro).
 *
 * `mavia_app` não tem `INSERT` em `tenants`, `usuarios` nem `tenant_usuarios`,
 * então o fluxo de cadastro não funciona sob o papel da requisição. Isso foi
 * descoberto testando, não projetado.
 *
 * Não resolvo aqui de propósito: dar `INSERT` em `tenants` a `mavia_app`
 * significa que qualquer requisição autenticada cria tenants, o que exige
 * limite de taxa e uma decisão de produto. Cadastro merece a própria fatia,
 * com o `especialista-seguranca-appsec` no gate — e não ser desenhado como
 * efeito colateral de uma migration de tenancy.
 *
 * Até lá, quem cria tenant é um caminho privilegiado, como o seed destes
 * testes.
 */
