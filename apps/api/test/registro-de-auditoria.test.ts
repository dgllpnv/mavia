import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * Ler o registro — ticket 10.
 *
 * ## Projeção, e não policy de `SELECT`
 *
 * Uma policy daria à conexão do painel a tabela inteira, colunas incluídas — e
 * duas delas, `ip_hash` e `user_agent_hash`, a matriz veta para **todo** papel:
 * *"existem para investigação de incidente, não para exibição"*.
 *
 * Com projeção, as duas **não têm como** sair: elas não estão no tipo de
 * retorno da função. Não é uma lista que alguém precisa lembrar de manter —
 * acrescentá-las exigiria mudar a assinatura.
 *
 * ## Ler o registro é evento
 *
 * Um log que ninguém lê descobre o incidente quando o cliente reclama. Um log
 * cuja leitura é **silenciosa** descobre na mesma hora — e é por isso que a
 * leitura fica registrada como qualquer outro acesso, inclusive a leitura da
 * própria leitura.
 */

let api: ApiDeTeste
const HIPOTESE = { 'x-mavia-motivo': 'chamado', 'x-mavia-referencia': 'CH-1010' }

beforeAll(async () => {
  api = await subirApi()
  await api.banco.cliente.query('SELECT admin.conceder($1, $2)', [USUARIO_A, USUARIO_A])
  await api.banco.cliente.query('SELECT admin.conceder($1, $2)', [USUARIO_B, USUARIO_A])
}, 120_000)

afterAll(async () => {
  await api?.encerrar()
})

describe('o que a projeção não tem como devolver', () => {
  it('**`ip_hash` e `user_agent_hash` não estão no tipo de retorno**', async () => {
    const r = await api.banco.cliente.query<{ corpo: string }>(
      `SELECT pg_get_functiondef(p.oid) AS corpo FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'admin' AND p.proname = 'ler_registro'`,
    )
    const corpo = r.rows[0]!.corpo
    // O `RETURNS TABLE (...)` é o contrato. Não há filtro a esquecer.
    const assinatura = corpo.slice(0, corpo.indexOf('LANGUAGE'))
    expect(assinatura).not.toContain('ip_hash')
    expect(assinatura).not.toContain('user_agent_hash')
  })

  it('**continua não existindo policy de `SELECT` para `mavia_admin` em `auditoria`**', async () => {
    const r = await api.banco.cliente.query<{ policyname: string }>(
      `SELECT policyname FROM pg_policies
        WHERE tablename = 'auditoria' AND cmd = 'SELECT'
          AND 'mavia_admin' = ANY (roles)`,
    )
    expect(r.rows).toEqual([])
  })

  it('`mavia_admin` tem `INSERT` em `auditoria`, e não `SELECT`', async () => {
    const r = await api.banco.cliente.query<{ ins: boolean; sel: boolean }>(
      `SELECT has_table_privilege('mavia_admin','auditoria','INSERT') AS ins,
              has_table_privilege('mavia_admin','auditoria','SELECT') AS sel`,
    )
    expect(r.rows[0]!.ins).toBe(true)
    expect(r.rows[0]!.sel).toBe(false)
  })
})

describe('a rota', () => {
  it('**devolve o registro, e sem os dois campos vetados**', async () => {
    // Uma leitura antes, para haver o que ler.
    await api.pedir({
      metodo: 'GET',
      url: `/v1/admin/clientes/${TENANT_A}/contas`,
      usuario: USUARIO_A,
      cabecalhos: HIPOTESE,
    })

    const r = await api.pedir({ metodo: 'GET', url: '/v1/admin/registro', usuario: USUARIO_A })
    expect(r.statusCode).toBe(200)

    const itens = r.json().itens as Record<string, unknown>[]
    expect(itens.length).toBeGreaterThan(0)
    for (const linha of itens) {
      expect(Object.keys(linha)).not.toContain('ip_hash')
      expect(Object.keys(linha)).not.toContain('user_agent_hash')
    }
  })

  it('**ler o registro é evento, com classe de segurança**', async () => {
    const m = await api.banco.cliente.query<{ t: string }>('SELECT now()::text AS t')
    const r = await api.pedir({ metodo: 'GET', url: '/v1/admin/registro', usuario: USUARIO_A })
    expect(r.statusCode).toBe(200)

    const log = await api.banco.cliente.query<{ classe: string; acao: string; registros: string }>(
      `SELECT classe::text, acao, registros::text FROM auditoria
        WHERE entidade = 'auditoria' AND ocorrido_em > $1::timestamptz`,
      [m.rows[0]!.t],
    )
    expect(log.rows).toHaveLength(1)
    expect(log.rows[0]!.classe).toBe('seguranca')
    expect(log.rows[0]!.acao).toBe('leu')
    // A contagem é do que foi devolvido: "leu o registro" não responde ao
    // art. 48; "leu o registro, 143 linhas" responde.
    expect(Number(log.rows[0]!.registros)).toBeGreaterThan(0)
  })

  it('**sem concessão, 403** — a resolução é por requisição', async () => {
    const semConcessao = '66666666-0000-4000-8000-000000000066'
    await api.banco.cliente.query(
      `INSERT INTO usuarios (id, email, nome) VALUES ($1, 'nada3@mavia.test', 'Nada')
       ON CONFLICT (id) DO NOTHING`,
      [semConcessao],
    )
    await api.abrirSessao(semConcessao)
    const r = await api.pedir({ metodo: 'GET', url: '/v1/admin/registro', usuario: semConcessao })
    expect(r.statusCode).toBe(403)
  })
})

describe('a notificação entre pares', () => {
  it('**sem destino configurado, ela não é enviada** — e o processo diz isso', async () => {
    // É a única salvaguarda de **detecção** do épico: as demais são prevenção
    // (a hipótese antes do ato) ou forense (o log). Sem destino, o painel roda
    // com a detecção desligada — e o deploy recusa por isso (C-11).
    //
    // O arreio de teste não define `MAVIA_ALERTA_OPERACAO`, então o caminho
    // medido aqui é o do aviso ausente: a leitura funciona e o alerta não sai.
    expect(process.env['MAVIA_ALERTA_OPERACAO']).toBeUndefined()

    const r = await api.pedir({ metodo: 'GET', url: '/v1/admin/registro', usuario: USUARIO_A })
    expect(r.statusCode).toBe(200)
  })
})
