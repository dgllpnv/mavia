import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import {
  semearDoisTenants,
  subirPostgres,
  TENANT_A,
  TENANT_B,
  USUARIO_A,
  USUARIO_B,
  type BancoDeTeste,
} from './postgres.js'
import { comAdmin, contextoDeOperador } from '../src/tenancy/tenancy.js'

/**
 * As funções do esquema `admin` — ticket 05.
 *
 * São os **três únicos lugares do sistema** onde um identificador vindo de uma
 * rota vira contexto de banco, e cada um grava a linha de auditoria antes de o
 * acesso existir.
 *
 * ## A lista fechada, e por que ela é uma constante e não um literal
 *
 * O spec institucionaliza: *"o esquema `admin` contém exatamente as oito
 * funções da §8.0"*. As oito nascem em cinco tickets diferentes, e uma
 * igualdade contra oito ficaria vermelha entre eles. `FUNCOES_DE_ADMIN` é
 * estendida de uma linha por ticket, e a igualdade vale em **todo ponto da
 * sequência** — uma função nova e não declarada derruba a suíte em qualquer um.
 *
 * É a saída B do achado S3-4: sem ela, a correção de `mavia_auth` recria a
 * mesma armadilha um esquema adiante, porque a segunda função de admin nasceria
 * herdando as policies amplas do dono.
 */

let banco: BancoDeTeste
let painel: Pool

/**
 * As funções de `admin` que existem **hoje**, com o dono de cada família.
 * Cada ticket seguinte acrescenta a sua linha aqui, junto com a função.
 */
const FUNCOES_DE_ADMIN: ReadonlyMap<
  string,
  'mavia_admin_definer' | 'mavia_admin_contrato' | 'mavia_migrate'
> = new Map([
  // Família de leitura — dono `mavia_admin_definer`.
  ['listar_clientes', 'mavia_admin_definer'],
  ['abrir_espaco', 'mavia_admin_definer'],
  ['abrir_espaco_para_escrita', 'mavia_admin_definer'],
  ['ler_registro', 'mavia_admin_definer'],
  ['tem_concessao_ativa', 'mavia_migrate'],
  // Família de contrato — dono `mavia_admin_contrato` (ticket 08).
  ['prorrogar_teste', 'mavia_admin_contrato'],
  ['conceder_cortesia', 'mavia_admin_contrato'],
  ['registrar_pagamento', 'mavia_admin_contrato'],
  ['estornar_baixa', 'mavia_admin_contrato'],
  ['cadastrar_cliente', 'mavia_admin_contrato'],
  // ADR 0025. `criar_preco` é a única que não recebe um tenant: preço de plano
  // é do produto, e ela grava auditoria com `tenant_id` nulo.
  ['criar_preco', 'mavia_admin_contrato'],
  ['conceder_desconto', 'mavia_admin_contrato'],
  ['revogar_desconto', 'mavia_admin_contrato'],
  // Provisionamento — não servem requisição, e por isso o dono é o de migration.
  ['conceder', 'mavia_migrate'],
  ['revogar', 'mavia_migrate'],
])

async function darConcessao(usuario: string): Promise<void> {
  await banco.cliente.query('SELECT admin.conceder($1, $2)', [usuario, USUARIO_A])
}

beforeAll(async () => {
  banco = await subirPostgres()
  await semearDoisTenants(banco.cliente)
  painel = await banco.poolComo('mavia_admin')
  // Duas concessões: a invariante do ticket 04 impede descer para uma.
  await darConcessao(USUARIO_A)
  await darConcessao(USUARIO_B)
}, 120_000)

afterAll(async () => {
  await banco?.encerrar()
})

describe('a lista fechada do esquema `admin`', () => {
  it('**contém exatamente as funções declaradas**, com o dono certo', async () => {
    const r = await banco.cliente.query<{ nome: string; dono: string }>(
      `SELECT p.proname AS nome, pg_get_userbyid(p.proowner) AS dono
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'admin' ORDER BY 1`,
    )
    const encontradas = new Map(r.rows.map((l) => [l.nome, l.dono]))
    expect([...encontradas.keys()].sort()).toEqual([...FUNCOES_DE_ADMIN.keys()].sort())
    for (const [nome, dono] of FUNCOES_DE_ADMIN) {
      expect(encontradas.get(nome), nome).toBe(dono)
    }
  })

  it('**nenhuma é de `mavia_auth`** — aqui a convenção do repositório é o exploit', async () => {
    // `mavia_auth` já lê `usuarios`, `tenants`, `tenant_usuarios`, `sessoes` e
    // `assinaturas` entre todos os espaços, com `USING (true)`. Uma função
    // escrita por alguém seguindo a convenção nasceria lendo a base inteira sem
    // violar nenhuma proibição escrita.
    const r = await banco.cliente.query<{ nome: string }>(
      `SELECT p.proname AS nome FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'admin' AND pg_get_userbyid(p.proowner) = 'mavia_auth'`,
    )
    expect(r.rows).toEqual([])
  })

  it('toda função de `admin` tem `search_path` fixado', async () => {
    const r = await banco.cliente.query<{ nome: string; cfg: string[] | null }>(
      `SELECT p.proname AS nome, p.proconfig AS cfg FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'admin'`,
    )
    for (const f of r.rows) {
      expect(f.cfg?.some((c) => c.startsWith('search_path=')), f.nome).toBe(true)
    }
  })

  it('**nenhuma escreve `plano` ou `intervalo`** — DP-40, e vale desde já', async () => {
    const r = await banco.cliente.query<{ nome: string; corpo: string }>(
      `SELECT p.proname AS nome, pg_get_functiondef(p.oid) AS corpo
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'admin'`,
    )
    for (const f of r.rows) {
      expect(f.corpo, f.nome).not.toMatch(/UPDATE\s+assinaturas\s+SET[^;]*\b(plano|intervalo)\b/i)
    }
  })

  it('**o `EXECUTE` é cruzado** — quem lê não abre para escrever, e vice-versa', async () => {
    const pares: [string, string, boolean][] = [
      ['mavia_admin', 'admin.abrir_espaco(uuid, motivo_de_acesso, text, text, text)', true],
      ['mavia_admin', 'admin.abrir_espaco_para_escrita(uuid, motivo_de_acesso, text, text, text)', false],
      ['mavia_admin_escrita', 'admin.abrir_espaco_para_escrita(uuid, motivo_de_acesso, text, text, text)', true],
      ['mavia_admin_escrita', 'admin.abrir_espaco(uuid, motivo_de_acesso, text, text, text)', false],
    ]
    for (const [papel, fn, esperado] of pares) {
      const r = await banco.cliente.query<{ ok: boolean }>(
        `SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`,
        [papel, fn],
      )
      expect(r.rows[0]!.ok, `${papel} → ${fn}`).toBe(esperado)
    }
  })
})

describe('a listagem — o teste que a v3 não teria passado', () => {
  it('**roda na primeira execução**, sem `permission denied` de nada', async () => {
    // A v3 falharia aqui por **três razões ao mesmo tempo**: o dono não teria
    // `SELECT` nas quatro tabelas da projeção, nem em `concessoes_de_admin`
    // para conferir a concessão, nem `INSERT` em `auditoria` para registrar a
    // busca. Foi o achado S3-3(a).
    const linhas = await comAdmin(painel, contextoDeOperador(USUARIO_A), async (c) => {
      const r = await c.query('SELECT * FROM admin.listar_clientes(NULL, 50)')
      return r.rows
    })
    expect(linhas.length).toBeGreaterThanOrEqual(2)
  })

  it('**sem concessão ativa devolve erro, não zero linhas**', async () => {
    // Vazio e erro são indistinguíveis para quem chama e completamente
    // diferentes para quem audita: vazio diz "não há clientes", erro diz "você
    // não deveria estar perguntando". É o critério de aceite da ADR 0024.
    const semConcessao = '99999999-0000-0000-0000-00000000009a'
    await banco.cliente.query(
      `INSERT INTO usuarios (id, email, nome) VALUES ($1, 'nada@mavia.test', 'Nada')
       ON CONFLICT (id) DO NOTHING`,
      [semConcessao],
    )
    await expect(
      comAdmin(painel, contextoDeOperador(semConcessao), async (c) =>
        c.query('SELECT * FROM admin.listar_clientes(NULL, 50)'),
      ),
    ).rejects.toThrow(/SEM_CONCESSAO_DE_ADMIN/)
  })

  it('**uma linha por busca, com o termo hasheado e a contagem**', async () => {
    const marca = await banco.cliente.query<{ t: string }>('SELECT now()::text AS t')

    const achados = await comAdmin(painel, contextoDeOperador(USUARIO_A), async (c) => {
      const r = await c.query('SELECT * FROM admin.listar_clientes($1, 50)', ['Ana'])
      return r.rows.length
    })

    const log = await banco.cliente.query<{ registros: string; de: { termo_sha256?: string } | null }>(
      `SELECT registros::text, de FROM auditoria
        WHERE entidade = 'cliente' AND acao = 'buscou' AND ocorrido_em > $1::timestamptz`,
      [marca.rows[0]!.t],
    )

    // Uma linha por **busca**, não uma por cliente listado.
    expect(log.rows).toHaveLength(1)
    expect(Number(log.rows[0]!.registros)).toBe(achados)
    // O termo entra hasheado: sem isso o log de acesso vira um segundo índice
    // de e-mails de clientes, que é o oposto do que ele existe para fazer.
    expect(log.rows[0]!.de?.termo_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(log.rows[0]!.de)).not.toContain('Ana')
  })

  it('**aspas e `%` são dados, não sintaxe** — parâmetro vinculado', async () => {
    const r = await comAdmin(painel, contextoDeOperador(USUARIO_A), async (c) => {
      const x = await c.query(`SELECT * FROM admin.listar_clientes($1, 50)`, [`%' OR '1'='1`])
      return x.rows.length
    })
    // O termo não casa com nada, e não vira SQL: se virasse, devolveria tudo.
    expect(r).toBe(0)
  })
})

describe('abrir o espaço — auditado e efetivado são o mesmo valor', () => {
  it('**deixa exatamente uma linha**, com motivo, referência, rota e o mesmo tenant', async () => {
    const marca = await banco.cliente.query<{ t: string }>('SELECT now()::text AS t')

    const contexto = await comAdmin(painel, contextoDeOperador(USUARIO_A), async (c) => {
      await c.query(`SELECT admin.abrir_espaco($1, 'chamado', 'CH-77', 'abriu', '/v1/admin/x')`, [
        TENANT_B,
      ])
      const r = await c.query<{ t: string }>(`SELECT current_setting('app.tenant_id') AS t`)
      return r.rows[0]!.t
    })

    // O identificador que virou `app.tenant_id` é o **mesmo** que foi para a
    // coluna da auditoria. Não há como auditar A e efetivar B: seria preciso
    // escrever duas expressões diferentes, e não há duas.
    expect(contexto).toBe(TENANT_B)

    const log = await banco.cliente.query<{
      tenant_id: string
      motivo: string
      referencia: string
      rota: string
      classe: string
    }>(
      `SELECT tenant_id, motivo::text, referencia, rota, classe::text FROM auditoria
        WHERE entidade = 'tenant' AND ocorrido_em > $1::timestamptz`,
      [marca.rows[0]!.t],
    )
    expect(log.rows).toHaveLength(1)
    expect(log.rows[0]).toMatchObject({
      tenant_id: TENANT_B,
      motivo: 'chamado',
      referencia: 'CH-77',
      rota: '/v1/admin/x',
      classe: 'leitura_em_massa',
    })
  })

  it('**a de escrita grava classe de escrita financeira**, não de leitura', async () => {
    const marca = await banco.cliente.query<{ t: string }>('SELECT now()::text AS t')
    const escrita = await banco.poolComo('mavia_admin_escrita')
    const cliente = await escrita.connect()
    try {
      await cliente.query('BEGIN')
      await cliente.query('SET LOCAL ROLE mavia_admin_escrita')
      await cliente.query(`SELECT set_config('app.usuario_id', $1, true)`, [USUARIO_A])
      await cliente.query(
        `SELECT admin.abrir_espaco_para_escrita($1, 'chamado', 'CH-88', 'baixou', '/v1/admin/y')`,
        [TENANT_A],
      )
      await cliente.query('COMMIT')
    } finally {
      cliente.release()
    }

    const log = await banco.cliente.query<{ classe: string; tenant_id: string }>(
      `SELECT classe::text, tenant_id FROM auditoria
        WHERE referencia = 'CH-88' AND ocorrido_em > $1::timestamptz`,
      [marca.rows[0]!.t],
    )
    expect(log.rows).toHaveLength(1)
    expect(log.rows[0]!.classe).toBe('escrita_financeira')
    expect(log.rows[0]!.tenant_id).toBe(TENANT_A)
  })

  it('**sem concessão, a abertura não acontece**', async () => {
    const semConcessao = '99999999-0000-0000-0000-00000000009b'
    await banco.cliente.query(
      `INSERT INTO usuarios (id, email, nome) VALUES ($1, 'nada2@mavia.test', 'Nada')
       ON CONFLICT (id) DO NOTHING`,
      [semConcessao],
    )
    await expect(
      comAdmin(painel, contextoDeOperador(semConcessao), async (c) =>
        c.query(`SELECT admin.abrir_espaco($1, 'chamado', 'CH-1', 'abriu', '/x')`, [TENANT_A]),
      ),
    ).rejects.toThrow(/SEM_CONCESSAO_DE_ADMIN/)
  })

  it('**motivo fora do enum recusa, e o espaço não abre**', async () => {
    await expect(
      comAdmin(painel, contextoDeOperador(USUARIO_A), async (c) =>
        c.query(`SELECT admin.abrir_espaco($1, 'curiosidade', 'CH-1', 'abriu', '/x')`, [TENANT_A]),
      ),
    ).rejects.toThrow(/invalid input value for enum/i)
  })

  it('**`mavia_admin` não alcança a função de escrita**', async () => {
    await expect(
      comAdmin(painel, contextoDeOperador(USUARIO_A), async (c) =>
        c.query(`SELECT admin.abrir_espaco_para_escrita($1, 'chamado', 'CH-1', 'x', '/x')`, [
          TENANT_A,
        ]),
      ),
    ).rejects.toThrow(/permission denied for function/i)
  })
})
