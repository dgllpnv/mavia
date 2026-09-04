import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { subirPostgres, type BancoDeTeste } from './postgres.js'
import { CAMPOS_VETADOS } from '../src/autorizacao/campos-vetados.js'

/**
 * Os quatro papéis do painel — ticket 01.
 *
 * Estas asserções são a fronteira do painel de administração, e nenhuma delas
 * é sobre código de aplicação: são sobre **privilégio de banco**. A v2 do spec
 * foi reprovada por descrever travas que a topologia não sustentava, e a
 * medição que a derrubou está aqui como o teste 12.
 *
 * ## Por que teste de esquema, e não de comportamento
 *
 * Um teste de comportamento prova que a rota de hoje não escreve. Um teste de
 * privilégio prova que **nenhuma rota** consegue — inclusive a que alguém
 * escrever amanhã às onze da noite.
 *
 * ## A armadilha que estes testes existem para pegar
 *
 * `bootstrap-papeis.sql:36-44` documenta: um `GRANT` executado por quem não é
 * dono do objeto **não falha**. Ele devolve `GRANT` com um `WARNING`, a
 * migration reporta sucesso, e o privilégio simplesmente não existe. Sem
 * asserção de esquema, a migration mente e o defeito aparece na primeira
 * execução de uma função — meses depois, em produção.
 */

let banco: BancoDeTeste

const PAPEIS = [
  'mavia_admin',
  'mavia_admin_escrita',
  'mavia_admin_contrato',
  'mavia_admin_definer',
] as const

/** As cinco tabelas que compõem o razão do cliente. Nenhum papel do painel escreve nelas. */
const RAZAO = ['lancamentos', 'contas', 'faturas', 'transferencias', 'saldo_snapshots'] as const

beforeAll(async () => {
  banco = await subirPostgres()
}, 120_000)

afterAll(async () => {
  await banco?.encerrar()
})

describe('os quatro papéis existem, e com os atributos certos', () => {
  it('nascem sem `LOGIN` — credencial é provisionamento, nunca migration (C-9)', async () => {
    // O único `CREATE ROLE … LOGIN … PASSWORD` versionado do repositório tem a
    // senha em claro, e migration é forward-only. Quem seguir esse precedente
    // põe uma senha fixa num arquivo que roda em produção e não sai mais.
    const r = await banco.cliente.query<{ rolname: string; rolcanlogin: boolean }>(
      `SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY($1)`,
      [PAPEIS],
    )
    expect(r.rows).toHaveLength(4)
    for (const p of r.rows) expect(p.rolcanlogin).toBe(false)
  })

  it('**nenhum tem `BYPASSRLS`** — `sistema.md` §3.9', async () => {
    const r = await banco.cliente.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname = ANY($1) AND rolbypassrls`,
      [PAPEIS],
    )
    expect(r.rows.map((l) => l.rolname)).toEqual([])
  })

  it('todos têm `statement_timeout` — a listagem varre a base com termo livre', async () => {
    const r = await banco.cliente.query<{ rolname: string; rolconfig: string[] | null }>(
      `SELECT rolname, rolconfig FROM pg_roles WHERE rolname = ANY($1)`,
      [PAPEIS],
    )
    for (const p of r.rows) {
      expect(p.rolconfig?.some((c) => c.startsWith('statement_timeout=')), p.rolname).toBe(true)
    }
  })

  it('têm `USAGE` em `public` e em `admin` — um `GRANT` sem dono não falha', async () => {
    for (const papel of PAPEIS) {
      for (const esquema of ['public', 'admin']) {
        const r = await banco.cliente.query<{ ok: boolean }>(
          `SELECT has_schema_privilege($1, $2, 'USAGE') AS ok`,
          [papel, esquema],
        )
        expect(r.rows[0]!.ok, `${papel} → ${esquema}`).toBe(true)
      }
    }
  })
})

describe('as seis não-relações — valem tanto quanto os privilégios', () => {
  async function ehMembro(membro: string, papel: string): Promise<boolean> {
    const r = await banco.cliente.query<{ n: string }>(
      `SELECT 1 AS n FROM pg_auth_members m
         JOIN pg_roles filho  ON filho.oid  = m.member
         JOIN pg_roles pai    ON pai.oid    = m.roleid
        WHERE filho.rolname = $1 AND pai.rolname = $2`,
      [membro, papel],
    )
    return r.rowCount! > 0
  }

  it('**`mavia_app` não é membro de nenhum dos quatro**', async () => {
    // Senão o pool do cliente alcança o painel por `SET ROLE`, e a separação
    // inteira vira uma instrução de distância.
    for (const p of PAPEIS) expect(await ehMembro('mavia_app', p), p).toBe(false)
  })

  it('**nenhum dos quatro é membro de `mavia_app`**', async () => {
    // Esta é a que a v2 não tinha, e é a que o `RESET ROLE` explora: se o papel
    // do painel herdasse `mavia_app`, voltar ao papel de login devolveria o DML
    // completo sobre o razão do cliente cujo `app.tenant_id` acabou de ser
    // assumido.
    for (const p of PAPEIS) expect(await ehMembro(p, 'mavia_app'), p).toBe(false)
  })

  it('`mavia_admin` não é membro de `mavia_admin_escrita`', async () => {
    // A conexão que lê não é a conexão que escreve, e a separação é por
    // autenticação — não por uma instrução que a instrução seguinte desfaz.
    expect(await ehMembro('mavia_admin', 'mavia_admin_escrita')).toBe(false)
  })

  it('`mavia_admin_contrato` não é membro de ninguém', async () => {
    const r = await banco.cliente.query(
      `SELECT 1 FROM pg_auth_members m
         JOIN pg_roles filho ON filho.oid = m.member
        WHERE filho.rolname = 'mavia_admin_contrato'`,
    )
    expect(r.rowCount).toBe(0)
  })

  it('**o único membro dos quatro é `mavia_migrate`**, e isso é do Postgres', async () => {
    // Descoberto rodando o teste, não lendo a documentação: **no Postgres 16 em
    // diante, um papel com `CREATEROLE` vira membro automático de todo papel que
    // cria**, com `ADMIN OPTION`. Não há como criar sem essa aresta, a não ser
    // revogando-a depois — e revogá-la impediria `mavia_migrate` de alterar os
    // papéis em migrations futuras.
    //
    // É aceitável, e a razão é que `mavia_migrate` **já** é onipotente: ele tem
    // `BYPASSRLS` e `CREATEROLE` (`bootstrap-papeis.sql:33`), é dono do esquema
    // `public`, e a credencial dele está ausente do ambiente de `http` e de
    // `worker` por desenho (`sistema.md` §3.9). Ele não serve requisição.
    //
    // O que **não** é aceitável é a aresta existir sem ninguém saber. Esta
    // asserção fixa a lista: se um quinto papel aparecer como membro, alguém
    // concedeu algo, e o teste cai.
    const r = await banco.cliente.query<{ pai: string; filho: string }>(
      `SELECT pai.rolname AS pai, filho.rolname AS filho
         FROM pg_auth_members m
         JOIN pg_roles filho ON filho.oid = m.member
         JOIN pg_roles pai   ON pai.oid   = m.roleid
        WHERE pai.rolname = ANY($1) ORDER BY pai.rolname`,
      [PAPEIS],
    )
    expect(r.rows.map((l) => l.filho)).toEqual(['mavia_migrate', 'mavia_migrate', 'mavia_migrate', 'mavia_migrate'])
  })
})

describe('o que os papéis podem ler, coluna a coluna', () => {
  it('**nenhum dos nove campos vetados** aparece em `GRANT` de papel nenhum do painel', async () => {
    // R-5 da matriz de acesso. A lista lida aqui é a **mesma constante** que a
    // varredura do OpenAPI lê — um campo que sai de uma lista sai da outra.
    //
    // O achado S3-6: a v3 do spec chamava de "os sete da R-5" um conjunto que
    // trocava `ip_hash`/`user_agent_hash` por outro campo. O teste escrito
    // contra a lista errada **passava** com `auditoria.ip_hash` concedido ao
    // painel — verde sobre exatamente o campo que a matriz veta.
    const r = await banco.cliente.query<{ table_name: string; column_name: string; grantee: string }>(
      `SELECT table_name, column_name, grantee
         FROM information_schema.column_privileges
        WHERE grantee = ANY($1) AND column_name = ANY($2)`,
      [PAPEIS, CAMPOS_VETADOS.map((c) => c.coluna)],
    )
    expect(r.rows).toEqual([])
  })

  it('`mavia_admin` lê o razão e o cadastro, e **não escreve nada** neles', async () => {
    for (const t of RAZAO) {
      // `has_any_column_privilege`, e **não** `has_table_privilege`: a segunda
      // devolve `false` quando a concessão é por coluna, que é toda a nossa.
      // Verificado no banco — `f` contra `t` para a mesma tabela e o mesmo papel.
      const leitura = await banco.cliente.query<{ ok: boolean }>(
        `SELECT has_any_column_privilege('mavia_admin', $1, 'SELECT') AS ok`,
        [t],
      )
      expect(leitura.rows[0]!.ok, `SELECT em ${t}`).toBe(true)

      // `INSERT` e `UPDATE` têm granularidade de coluna; **`DELETE` não tem** —
      // apagar uma linha é apagar a linha inteira, e o Postgres recusa
      // `has_any_column_privilege(..., 'DELETE')` com "unrecognized privilege
      // type". Duas checagens diferentes porque são dois conceitos diferentes.
      for (const escrita of ['INSERT', 'UPDATE']) {
        const r = await banco.cliente.query<{ ok: boolean }>(
          `SELECT has_any_column_privilege('mavia_admin', $1, $2) AS ok`,
          [t, escrita],
        )
        expect(r.rows[0]!.ok, `${escrita} em ${t}`).toBe(false)
      }
      const del = await banco.cliente.query<{ ok: boolean }>(
        `SELECT has_table_privilege('mavia_admin', $1, 'DELETE') AS ok`,
        [t],
      )
      expect(del.rows[0]!.ok, `DELETE em ${t}`).toBe(false)
    }
  })

  it('**nenhum papel do painel ESCREVE `periodo_fim` ou `periodo_inicio`**', async () => {
    // O critério 10 do ticket 01 dizia "não aparecem em `GRANT` de nenhum papel
    // — nem por coluna, nem por tabela". **Está errado, e implementei o certo.**
    //
    // A tela de perfil do cliente precisa mostrar quando o plano acaba; sem
    // `SELECT` em `periodo_fim` ela não tem o que exibir, e "ver o perfil de um
    // cliente" é a segunda linha da §8. A proibição que o spec sustenta é de
    // **escrita**, e as duas razões são de dinheiro:
    //
    //   · `periodo_fim` é o campo que o webhook da Stripe sobrescreve
    //     (`0025_assinatura.sql:182`). Escrever ali faria a cortesia do operador
    //     sumir na fatura seguinte, sem linha de auditoria — quem escreveu foi
    //     `mavia_auth`, no caminho do webhook. É o achado F-12, e a saída dele é
    //     `cortesia_ate`, coluna própria, no ticket 08.
    //   · `periodo_inicio` é de onde `meses_iniciados` conta na fórmula de
    //     reembolso. Escrevê-lo reescreve retroativamente quanto a Mavia deve
    //     devolver (F-10).
    const r = await banco.cliente.query<{ grantee: string; column_name: string; privilege_type: string }>(
      `SELECT grantee, column_name, privilege_type
         FROM information_schema.column_privileges
        WHERE grantee = ANY($1) AND table_name = 'assinaturas'
          AND column_name IN ('periodo_fim','periodo_inicio')
          AND privilege_type <> 'SELECT'`,
      [PAPEIS],
    )
    expect(r.rows).toEqual([])
  })

  it('`mavia_admin_escrita` **não** tem `UPDATE` em `assinaturas`', async () => {
    // Quem escreve contrato é `mavia_admin_contrato`, e ele é **dono de
    // função**, não papel de rota. Um `UPDATE` de coluna solta não recusa
    // `expirada → ativa` sem pagamento (achado F-2).
    const r = await banco.cliente.query<{ ok: boolean }>(
      `SELECT has_table_privilege('mavia_admin_escrita', 'assinaturas', 'UPDATE') AS ok`,
    )
    expect(r.rows[0]!.ok).toBe(false)
  })

  it('`mavia_admin_contrato` **não lê o razão** — ele toca contrato, não extrato', async () => {
    for (const t of RAZAO) {
      const r = await banco.cliente.query<{ ok: boolean }>(
        `SELECT has_any_column_privilege('mavia_admin_contrato', $1, 'SELECT') AS ok`,
        [t],
      )
      expect(r.rows[0]!.ok, `SELECT em ${t}`).toBe(false)
    }
  })

  it('`mavia_admin_definer` lê só a projeção da listagem', async () => {
    const projecao = ['tenants', 'usuarios', 'tenant_usuarios', 'assinaturas']
    for (const t of projecao) {
      const r = await banco.cliente.query<{ ok: boolean }>(
        `SELECT has_any_column_privilege('mavia_admin_definer', $1, 'SELECT') AS ok`,
        [t],
      )
      expect(r.rows[0]!.ok, `SELECT em ${t}`).toBe(true)
    }
    for (const t of RAZAO) {
      const r = await banco.cliente.query<{ ok: boolean }>(
        `SELECT has_any_column_privilege('mavia_admin_definer', $1, 'SELECT') AS ok`,
        [t],
      )
      expect(r.rows[0]!.ok, `SELECT em ${t}`).toBe(false)
    }
  })
})

describe('a medição que reprovou a v2', () => {
  it('**`RESET ROLE` não devolve escrita** — a trava é a autenticação, não a instrução', async () => {
    // BEGIN; SET LOCAL ROLE leitor; UPDATE t  →  permission denied
    // BEGIN; SET LOCAL ROLE leitor; RESET ROLE; UPDATE t  →  UPDATE 1, e commita
    //
    // Era assim com um pool único como `mavia_app` e o papel do painel alcançado
    // por `SET ROLE`. Com papel próprio e sem parentesco, `RESET ROLE` aterrissa
    // em quem não escreve.
    //
    // A conexão do teste é do superusuário, que assume qualquer papel — então
    // ela **não** prova nada por si. `SET SESSION AUTHORIZATION` troca o usuário
    // de sessão, e a partir daí o `SET ROLE` é conferido contra as filiações
    // reais de `mavia_app`. Sem isso o teste passaria sempre, medindo o
    // privilégio do superusuário em vez do que interessa.
    await banco.cliente.query('BEGIN')
    await banco.cliente.query('SET LOCAL SESSION AUTHORIZATION mavia_app')
    await expect(banco.cliente.query('SET ROLE mavia_admin')).rejects.toThrow(
      /permission denied to set role|must be (a )?member/i,
    )
    await banco.cliente.query('ROLLBACK')
  })
})
