import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { semearDoisTenants, subirPostgres, USUARIO_A, USUARIO_B, type BancoDeTeste } from './postgres.js'
import { comAdmin, contextoDeOperador } from '../src/tenancy/tenancy.js'

/**
 * Quem é administrador — ticket 04.
 *
 * A tabela é **append-only**: conceder → revogar → conceder de novo são três
 * linhas, e a história inteira sobrevive. Uma coluna booleana responderia
 * "quem é admin agora" e perderia "quem era admin em março" no instante em que
 * alguém fosse revogado — que é exatamente o instante em que a pergunta passa
 * a importar.
 *
 * ## O que estes testes protegem, em ordem de peso
 *
 * 1. A invariante de dois operadores é **do banco**, avaliada por instrução, e
 *    não tem escape hatch nenhum.
 * 2. A policy do painel é **estreita**: um operador vê a própria concessão e
 *    nenhuma outra. Uma policy ampla entregaria, numa conexão sem segundo
 *    fator, a lista de todos os operadores da Mavia.
 * 3. Nenhuma policy de `tenants`, `usuarios` ou `tenant_usuarios` conhece esta
 *    tabela — senão o operador navegaria o espaço do cliente pela interface do
 *    **cliente**, sem uma linha de auditoria.
 */

let banco: BancoDeTeste

/** Três usuários extras, para exercitar a contagem sem depender da semente. */
const OPERADORES = [
  'cccccccc-0000-0000-0000-00000000000c',
  'dddddddd-0000-0000-0000-00000000000d',
  'eeeeeeee-0000-0000-0000-00000000000e',
] as const

async function limparConcessoes(): Promise<void> {
  await banco.cliente.query('DELETE FROM concessoes_de_admin')
}

async function conceder(usuario: string): Promise<string> {
  const r = await banco.cliente.query<{ id: string }>('SELECT admin.conceder($1, $2) AS id', [
    usuario,
    USUARIO_A,
  ])
  return r.rows[0]!.id
}

beforeAll(async () => {
  banco = await subirPostgres()
  await semearDoisTenants(banco.cliente)
  for (const [i, id] of OPERADORES.entries()) {
    await banco.cliente.query(
      `INSERT INTO usuarios (id, email, nome) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [id, `operador${i}@mavia.test`, `Operador ${i}`],
    )
  }
}, 120_000)

afterAll(async () => {
  await banco?.encerrar()
})

describe('a invariante de dois operadores ativos', () => {
  it('**a primeira concessão passa** — o gatilho é só de `UPDATE`, e isso é declarado', async () => {
    // Cobrir `INSERT` exigiria uma isenção para o bootstrap, e isenção é
    // exatamente o escape hatch que a imutabilidade da auditoria foi escrita
    // para fechar. O gatilho impede **cair** para um; não impede **operar**
    // com um, e a diferença está escrita na migration.
    await limparConcessoes()
    const id = await conceder(OPERADORES[0])
    expect(id).toBeTruthy()
  })

  it('**revogar a penúltima é recusado pelo banco**', async () => {
    await limparConcessoes()
    await conceder(OPERADORES[0])
    await conceder(OPERADORES[1])

    await expect(
      banco.cliente.query('SELECT admin.revogar($1, $2)', [OPERADORES[0], USUARIO_A]),
    ).rejects.toThrow(/ADMINS_ATIVOS_INSUFICIENTES/)
  })

  it('com três ativas, revogar uma passa', async () => {
    await limparConcessoes()
    for (const o of OPERADORES) await conceder(o)

    await banco.cliente.query('SELECT admin.revogar($1, $2)', [OPERADORES[2], USUARIO_A])
    const r = await banco.cliente.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM concessoes_de_admin WHERE revogada_em IS NULL`,
    )
    expect(r.rows[0]!.n).toBe('2')
  })

  it('**duas revogações no mesmo `UPDATE` são barradas juntas**', async () => {
    // Linha a linha as duas passariam: a primeira porque a segunda ainda estava
    // ativa, a segunda porque a primeira já não estava — e a base terminaria
    // com um operador só, com as duas aprovadas. É a razão de o gatilho ser
    // `FOR EACH STATEMENT`, e é o precedente de `0024_compartilhamento.sql`.
    await limparConcessoes()
    for (const o of OPERADORES) await conceder(o)

    await expect(
      banco.cliente.query(
        `UPDATE concessoes_de_admin SET revogada_em = now(), revogada_por = $1
          WHERE usuario_id = ANY($2) AND revogada_em IS NULL`,
        [USUARIO_A, [OPERADORES[0], OPERADORES[1]]],
      ),
    ).rejects.toThrow(/ADMINS_ATIVOS_INSUFICIENTES/)
  })

  it('um `UPDATE` que não revoga ninguém não é barrado pela contagem', async () => {
    // Uma instrução que mexe noutra coluna não deve morrer por uma contagem que
    // ela não alterou. Sem esta guarda, qualquer manutenção futura na tabela
    // esbarraria na invariante sem ter nada a ver com ela.
    await limparConcessoes()
    await conceder(OPERADORES[0])
    const r = await banco.cliente.query(
      `UPDATE concessoes_de_admin SET concedida_em = concedida_em WHERE revogada_em IS NULL`,
    )
    expect(r.rowCount).toBe(1)
  })
})

describe('a policy do painel é estreita', () => {
  it('**um operador não enxerga a concessão de outro**', async () => {
    await limparConcessoes()
    await conceder(OPERADORES[0])
    await conceder(OPERADORES[1])

    const pool = await banco.poolComo('mavia_admin')
    const vistas = await comAdmin(pool, contextoDeOperador(OPERADORES[0]), async (c) => {
      const r = await c.query<{ usuario_id: string }>('SELECT usuario_id FROM concessoes_de_admin')
      return r.rows.map((l) => l.usuario_id)
    })

    expect(vistas).toEqual([OPERADORES[0]])
  })

  it('quem não tem concessão não enxerga nada', async () => {
    const pool = await banco.poolComo('mavia_admin')
    const vistas = await comAdmin(pool, contextoDeOperador(USUARIO_B), async (c) => {
      const r = await c.query('SELECT usuario_id FROM concessoes_de_admin')
      return r.rowCount
    })
    expect(vistas).toBe(0)
  })
})

describe('a proibição que contém a exceção', () => {
  it('**nenhuma policy de `tenants`, `usuarios` ou `tenant_usuarios` conhece a tabela**', async () => {
    // É a trava que impede o caminho mais perigoso do épico: uma policy que
    // reconhecesse administrador faria o operador navegar o espaço do cliente
    // pela interface **do cliente**, com `resolverTenant` funcionando
    // normalmente e **sem uma linha de auditoria** — porque aquele caminho não
    // passa por `admin.abrir_espaco`.
    const r = await banco.cliente.query<{ tablename: string; policyname: string }>(
      `SELECT tablename, policyname FROM pg_policies
        WHERE tablename IN ('tenants','usuarios','tenant_usuarios')
          AND (coalesce(qual,'') LIKE '%concessoes_de_admin%'
            OR coalesce(with_check,'') LIKE '%concessoes_de_admin%')`,
    )
    expect(r.rows).toEqual([])
  })

  it('a tabela **não tem `tenant_id`** — ela prova acesso à base, não a um espaço', async () => {
    const r = await banco.cliente.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'concessoes_de_admin' AND column_name = 'tenant_id'`,
    )
    expect(r.rowCount).toBe(0)
  })
})

describe('conceder e revogar deixam rastro', () => {
  it('**cada uma grava uma linha de auditoria com `tenant_id` nulo**', async () => {
    // Sem isto, o provisionamento seria por construção uma concessão **sem
    // registro**: a única operação que cria um operador aconteceria fora do log
    // que existe para vigiar operadores.
    // **Este teste mede pela borda, e não limpando** — porque limpar é
    // impossível: a primeira versão dele começava com um `DELETE FROM
    // auditoria` e levou `AUDITORIA_IMUTAVEL`. O gatilho barrou o próprio
    // teste que existe para verificar o log, o que é exatamente o
    // comportamento correto.
    //
    // Um log que o teste consegue limpar é um log que a aplicação consegue
    // limpar.
    await limparConcessoes()
    const marca = await banco.cliente.query<{ t: string }>('SELECT now()::text AS t')

    await conceder(OPERADORES[0])
    await conceder(OPERADORES[1])
    await conceder(OPERADORES[2])
    await banco.cliente.query('SELECT admin.revogar($1, $2)', [OPERADORES[2], USUARIO_A])

    const r = await banco.cliente.query<{ acao: string; tenant_id: string | null }>(
      `SELECT acao, tenant_id FROM auditoria
        WHERE entidade = 'concessao_de_admin' AND ocorrido_em > $1::timestamptz
        ORDER BY ocorrido_em, acao`,
      [marca.rows[0]!.t],
    )
    expect(r.rows.map((l) => l.acao)).toEqual(['concedeu', 'concedeu', 'concedeu', 'revogou'])
    for (const linha of r.rows) expect(linha.tenant_id).toBeNull()
  })

  it('e essa linha é **invisível ao cliente**, para qualquer espaço', async () => {
    const pool = await banco.poolComo('mavia_app')
    const { TENANT_A } = await import('./postgres.js')
    const cliente = await pool.connect()
    try {
      await cliente.query('BEGIN')
      await cliente.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A])
      const r = await cliente.query(
        `SELECT 1 FROM auditoria WHERE entidade = 'concessao_de_admin'`,
      )
      await cliente.query('COMMIT')
      expect(r.rowCount).toBe(0)
    } finally {
      cliente.release()
    }
  })

  it('**guardar o e-mail no ato** — a FK sozinha perderia a identidade', async () => {
    // `usuarios` é apagada fisicamente quando o titular exerce o art. 18 VI.
    // Sem esta cópia, eliminar a conta de um ex-operador transformaria a
    // história de acesso dele num UUID sem dono.
    await limparConcessoes()
    await conceder(OPERADORES[0])
    const r = await banco.cliente.query<{ email_no_ato: string }>(
      'SELECT email_no_ato FROM concessoes_de_admin',
    )
    expect(r.rows[0]!.email_no_ato).toBe('operador0@mavia.test')
  })
})
