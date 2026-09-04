import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { subirPostgres, TENANT_A, USUARIO_A, type BancoDeTeste } from './postgres.js'

/**
 * A `auditoria` — ticket 03.
 *
 * É o log em que todo o resto do épico se apoia, e até hoje **ele não existia**:
 * `retencao-e-eliminacao.md` §4.3 o especificava, três migrations o citavam em
 * comentário, e não havia `CREATE TABLE auditoria` em lugar nenhum. Junto com
 * ele faltavam `retencao_execucoes` e `eliminacoes_journal` — achado O-2 do
 * gate de LGPD, e a razão de a primeira migration do épico não rodar.
 *
 * ## A promessa, com os limites ditos antes
 *
 * A imutabilidade vale contra `mavia_app`, contra os quatro papéis do painel e
 * **contra o dono da tabela**, para DML. Ela **não** vale contra DDL: `DETACH
 * PARTITION` mais `DROP TABLE` apaga um mês sem disparar gatilho de linha nem
 * de statement. E não vale contra quem tem o servidor.
 *
 * Estes testes medem o que ela **de fato** entrega. Não há asserção de "o log é
 * imutável" — há asserções de quem exatamente é barrado, e de que o único
 * caminho que apaga exige as três condições juntas.
 */

let banco: BancoDeTeste

const OS_CINCO = [
  'mavia_app',
  'mavia_admin',
  'mavia_admin_escrita',
  'mavia_admin_contrato',
  'mavia_admin_definer',
] as const

/** Grava uma linha por um caminho privilegiado, para ter o que tentar alterar. */
async function semearLinha(extra: Record<string, unknown> = {}): Promise<string> {
  const r = await banco.cliente.query<{ id: string }>(
    `INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, acao, classe,
                            motivo, referencia)
     VALUES ($1, $2, $3, 'tenant', 'abriu', $4, $5, $6)
     RETURNING id`,
    [
      extra['tenant_id'] === null ? null : (extra['tenant_id'] ?? TENANT_A),
      USUARIO_A,
      extra['ator_tipo'] ?? 'operador',
      extra['classe'] ?? 'leitura_em_massa',
      extra['motivo'] ?? 'chamado',
      extra['referencia'] ?? 'CH-1234',
    ],
  )
  return r.rows[0]!.id
}

beforeAll(async () => {
  banco = await subirPostgres()
}, 120_000)

afterAll(async () => {
  await banco?.encerrar()
})

describe('as duas tabelas que a política especificava e ninguém construiu', () => {
  it('`retencao_execucoes` e `eliminacoes_journal` existem', async () => {
    const r = await banco.cliente.query<{ relname: string }>(
      `SELECT relname FROM pg_class
        WHERE relname IN ('retencao_execucoes','eliminacoes_journal') ORDER BY 1`,
    )
    expect(r.rows.map((l) => l.relname)).toEqual(['eliminacoes_journal', 'retencao_execucoes'])
  })

  it('**`retencao_execucoes` não tem `tenant_id`** — por isso não entra na conta do R-08', async () => {
    const r = await banco.cliente.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'retencao_execucoes' AND column_name = 'tenant_id'`,
    )
    expect(r.rowCount).toBe(0)
  })
})

describe('quem pode gravar, e quem não pode alterar', () => {
  it('**os cinco papéis têm `INSERT`**, e nenhum deles tem `UPDATE`, `DELETE` ou `TRUNCATE`', async () => {
    for (const papel of OS_CINCO) {
      const ins = await banco.cliente.query<{ ok: boolean }>(
        `SELECT has_table_privilege($1, 'auditoria', 'INSERT') AS ok`,
        [papel],
      )
      expect(ins.rows[0]!.ok, `INSERT de ${papel}`).toBe(true)

      for (const proibido of ['UPDATE', 'DELETE', 'TRUNCATE']) {
        const r = await banco.cliente.query<{ ok: boolean }>(
          `SELECT has_table_privilege($1, 'auditoria', $2) AS ok`,
          [papel, proibido],
        )
        expect(r.rows[0]!.ok, `${proibido} de ${papel}`).toBe(false)
      }
    }
  })

  it('**`mavia_eliminacao` é a exceção declarada** — `DELETE`, e só ele', async () => {
    // O teste enumera os cinco acima, e não "todos os papéis", exatamente para
    // que esta exceção seja nomeada em vez de escondida por um filtro.
    const r = await banco.cliente.query<{ del: boolean; upd: boolean }>(
      `SELECT has_table_privilege('mavia_eliminacao','auditoria','DELETE') AS del,
              has_table_privilege('mavia_eliminacao','auditoria','UPDATE') AS upd`,
    )
    expect(r.rows[0]!.del).toBe(true)
    expect(r.rows[0]!.upd).toBe(false)
  })

  it('**`mavia_eliminacao` lê `retencao_execucoes`** — sem isso o gatilho recusa a si mesmo', async () => {
    // Achado S3-3(c). O gatilho é `plpgsql` sem `SECURITY DEFINER`, roda como o
    // invocador, e o `EXISTS` dele lê essa tabela. Sem o `GRANT`, o `EXISTS`
    // levanta `permission denied` e o `DELETE` que a isenção existe para
    // permitir morre no próprio gatilho que o autoriza.
    const r = await banco.cliente.query<{ ok: boolean }>(
      `SELECT has_table_privilege('mavia_eliminacao','retencao_execucoes','SELECT') AS ok`,
    )
    expect(r.rows[0]!.ok).toBe(true)
  })

  it('`mavia_eliminacao` não tem `BYPASSRLS` nem lê tabela de negócio', async () => {
    const r = await banco.cliente.query<{ bypass: boolean; le: boolean }>(
      `SELECT rolbypassrls AS bypass,
              has_any_column_privilege('mavia_eliminacao','lancamentos','SELECT') AS le
         FROM pg_roles WHERE rolname = 'mavia_eliminacao'`,
    )
    expect(r.rows[0]!.bypass).toBe(false)
    expect(r.rows[0]!.le).toBe(false)
  })

  it('**nenhum papel de conexão do painel lê `auditoria`**', async () => {
    // `mavia_admin` e `mavia_admin_escrita` são conexões: uma rota alcança as
    // duas. Elas gravam e não leem — a leitura do registro é por projeção.
    for (const papel of ['mavia_admin', 'mavia_admin_escrita', 'mavia_admin_contrato']) {
      const r = await banco.cliente.query<{ ok: boolean }>(
        `SELECT has_any_column_privilege($1, 'auditoria', 'SELECT') AS ok`,
        [papel],
      )
      expect(r.rows[0]!.ok, `SELECT de ${papel}`).toBe(false)
    }
  })

  it('**o dono da projeção lê, e por coluna** — sem os dois campos vetados', async () => {
    // `mavia_admin_definer` é dono de função, não conexão: ele não é alcançável
    // por `SET ROLE` a partir de papel nenhum de rota. Ele **precisa** ler para
    // projetar — e lê por coluna, sem `ip_hash` nem `user_agent_hash`.
    //
    // A projeção sozinha não bastaria: *poder ler* e *devolver* são coisas
    // diferentes, e a distância entre elas é o espaço onde a próxima versão da
    // função os incluiria sem que nenhuma trava reclamasse.
    const podeAlgo = await banco.cliente.query<{ ok: boolean }>(
      `SELECT has_any_column_privilege('mavia_admin_definer','auditoria','SELECT') AS ok`,
    )
    expect(podeAlgo.rows[0]!.ok).toBe(true)

    for (const coluna of ['ip_hash', 'user_agent_hash']) {
      const r = await banco.cliente.query<{ ok: boolean }>(
        `SELECT has_column_privilege('mavia_admin_definer','auditoria',$1,'SELECT') AS ok`,
        [coluna],
      )
      expect(r.rows[0]!.ok, coluna).toBe(false)
    }
  })
})

describe('o gatilho barra DML — inclusive o do dono', () => {
  it('**`UPDATE` e `DELETE` do dono levam `AUDITORIA_IMUTAVEL`**', async () => {
    // A conexão do teste é do superusuário, que é mais forte que o dono. Se ela
    // é barrada, o dono também é — e o `REVOKE` sozinho jamais barraria nenhum
    // dos dois.
    const id = await semearLinha()

    await expect(
      banco.cliente.query(`UPDATE auditoria SET acao = 'mexido' WHERE id = $1`, [id]),
    ).rejects.toThrow(/AUDITORIA_IMUTAVEL/)

    await expect(banco.cliente.query(`DELETE FROM auditoria WHERE id = $1`, [id])).rejects.toThrow(
      /AUDITORIA_IMUTAVEL/,
    )
  })

  it('**`TRUNCATE` também** — é privilégio separado, e o `REVOKE` sozinho o deixaria passar', async () => {
    await semearLinha()
    await expect(banco.cliente.query('TRUNCATE auditoria')).rejects.toThrow(/AUDITORIA_IMUTAVEL/)
  })

  it('e vale **na partição que o job criou**, não só no pai', async () => {
    // Uma partição nova não herda o `REVOKE` do pai, e quem a cria vira dona
    // dela. Sem repetir grants e gatilho a cada partição, o mês seguinte nasce
    // mutável e ninguém percebe.
    const nome = await banco.cliente.query<{ n: string }>(
      `SELECT garantir_particao_de_auditoria((date_trunc('month', now()) + INTERVAL '30 month')::date) AS n`,
    )
    const particao = nome.rows[0]!.n

    const gatilhos = await banco.cliente.query<{ n: string }>(
      `SELECT tgname AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = $1 AND NOT t.tgisinternal ORDER BY 1`,
      [particao],
    )
    expect(gatilhos.rows.map((l) => l.n)).toEqual([
      `${particao}_imutavel`,
      `${particao}_sem_truncate`,
    ])
  })
})

describe('a isenção — três condições, e nenhuma sozinha basta', () => {
  async function tentarApagar(comGuc: string | null, execucaoValida: boolean): Promise<string> {
    const id = await semearLinha()
    let execucao: string | null = null

    if (execucaoValida) {
      const r = await banco.cliente.query<{ id: string }>(
        `INSERT INTO retencao_execucoes (classe, versao_politica)
         VALUES ('eliminacao_de_espaco', 'v1') RETURNING id`,
      )
      execucao = r.rows[0]!.id
    }

    try {
      await banco.cliente.query('BEGIN')
      await banco.cliente.query('SET LOCAL ROLE mavia_eliminacao')
      const guc = comGuc === 'valida' ? execucao : comGuc
      if (guc !== null) {
        await banco.cliente.query(`SELECT set_config('app.eliminacao_execucao_id', $1, true)`, [guc])
      }
      await banco.cliente.query('DELETE FROM auditoria WHERE id = $1', [id])
      await banco.cliente.query('COMMIT')
      return 'apagou'
    } catch (erro) {
      await banco.cliente.query('ROLLBACK')
      return String((erro as Error).message)
    }
  }

  it('**sem o GUC** — barrado', async () => {
    expect(await tentarApagar(null, true)).toMatch(/AUDITORIA_IMUTAVEL/)
  })

  it('**com o GUC, sem a linha em `retencao_execucoes`** — barrado', async () => {
    // O GUC aponta para uma execução que não existe. É o caminho de quem
    // descobriu o nome da variável e achou que bastava.
    expect(await tentarApagar('00000000-0000-0000-0000-000000000000', false)).toMatch(
      /AUDITORIA_IMUTAVEL/,
    )
  })

  it('**as três juntas apagam** — e é o único caminho que apaga', async () => {
    expect(await tentarApagar('valida', true)).toBe('apagou')
  })

  it('**nenhum papel do painel alcança `mavia_eliminacao`**', async () => {
    for (const papel of ['mavia_app', 'mavia_admin', 'mavia_admin_escrita']) {
      await banco.cliente.query('BEGIN')
      await banco.cliente.query(`SET LOCAL SESSION AUTHORIZATION ${papel}`)
      await expect(
        banco.cliente.query('SET ROLE mavia_eliminacao'),
        papel,
      ).rejects.toThrow(/permission denied to set role|must be (a )?member/i)
      await banco.cliente.query('ROLLBACK')
    }
  })
})

describe('as três linhas que o padrão de policy recusaria', () => {
  it('**`tenant_id` nulo** — conceder e revogar admin não pertencem a espaço nenhum', async () => {
    const id = await semearLinha({ tenant_id: null, ator_tipo: 'sistema', classe: 'operacao_interna', motivo: null, referencia: null })
    expect(id).toBeTruthy()
  })

  it('**sem `app.tenant_id` definido** — é a busca da listagem', async () => {
    await banco.cliente.query('BEGIN')
    await banco.cliente.query(`SELECT set_config('app.tenant_id', '', true)`)
    const r = await banco.cliente.query(
      `INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, acao, classe, motivo, referencia)
       VALUES (NULL, $1, 'operador', 'busca', 'buscou', 'leitura_em_massa', 'chamado', 'CH-9')`,
      [USUARIO_A],
    )
    await banco.cliente.query('COMMIT')
    expect(r.rowCount).toBe(1)
  })

  it('**vários tenants numa instrução só** — é o `INSERT … SELECT` da saída de partição', async () => {
    const r = await banco.cliente.query(
      `INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, acao, classe, motivo, referencia)
       SELECT t, $1, 'operador', 'lote', 'moveu', 'leitura_em_massa', 'defeito', 'BUG-1'
         FROM unnest(ARRAY[$2::uuid, NULL::uuid]) AS t`,
      [USUARIO_A, TENANT_A],
    )
    expect(r.rowCount).toBe(2)
  })
})

describe('o que a lista fechada e as constraints removem', () => {
  it('**um motivo fora do enum não entra**', async () => {
    await expect(
      banco.cliente.query(
        `INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, acao, classe, motivo, referencia)
         VALUES ($1, $2, 'operador', 'tenant', 'abriu', 'leitura_em_massa', 'curiosidade', 'X')`,
        [TENANT_A, USUARIO_A],
      ),
    ).rejects.toThrow(/invalid input value for enum/i)
  })

  it('**operador sem motivo declarado não entra**', async () => {
    await expect(
      banco.cliente.query(
        `INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, acao, classe)
         VALUES ($1, $2, 'operador', 'tenant', 'abriu', 'leitura_em_massa')`,
        [TENANT_A, USUARIO_A],
      ),
    ).rejects.toThrow(/operador_declara_motivo/)
  })

  it('**motivo sem referência não entra** — hipótese que ninguém confere não é hipótese', async () => {
    await expect(
      banco.cliente.query(
        `INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, acao, classe, motivo)
         VALUES ($1, $2, 'operador', 'tenant', 'abriu', 'leitura_em_massa', 'chamado')`,
        [TENANT_A, USUARIO_A],
      ),
    ).rejects.toThrow(/motivo_tem_referencia/)
  })
})

describe('o job de partições', () => {
  it('**é idempotente** — duas execuções no mesmo mês não criam nada e não falham', async () => {
    const mes = `(date_trunc('month', now()) + INTERVAL '40 month')::date`
    const a = await banco.cliente.query<{ n: string }>(
      `SELECT garantir_particao_de_auditoria(${mes}) AS n`,
    )
    const b = await banco.cliente.query<{ n: string }>(
      `SELECT garantir_particao_de_auditoria(${mes}) AS n`,
    )
    expect(a.rows[0]!.n).toBe(b.rows[0]!.n)
  })

  it('**a pista tem pelo menos 24 meses à frente**', async () => {
    // Sem `DEFAULT` de propósito: ela é armadilha, não rede. Assim que recebe
    // uma linha de um mês futuro, o `ATTACH` daquele mês falha, e sair de lá
    // exige mover linhas sob pressão, com o gatilho de imutabilidade no
    // caminho. Um `INSERT` sem partição falha alto e claro; um estado do qual
    // só se sai com manutenção, não.
    const r = await banco.cliente.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_inherits i
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'auditoria'`,
    )
    expect(Number(r.rows[0]!.n)).toBeGreaterThanOrEqual(24)
  })

  it('**não existe partição `DEFAULT`**', async () => {
    const r = await banco.cliente.query(
      `SELECT 1 FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'auditoria'
          AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'`,
    )
    expect(r.rowCount).toBe(0)
  })
})
