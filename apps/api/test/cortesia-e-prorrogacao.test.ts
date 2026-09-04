import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, TENANT_B, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * Cortesia e prorrogação — ticket 08, achados F-12, F-13, F-15 e F-16.
 *
 * ## O defeito que estas rotas existem para não repetir
 *
 * O operador concede sessenta dias por uma indisponibilidade empurrando
 * `periodo_fim`. Na fatura seguinte, o webhook grava
 * `periodo_fim = coalesce(p_periodo_fim, periodo_fim)` — e **os sessenta dias
 * somem, sem uma linha de auditoria**, porque quem escreveu foi `mavia_auth`,
 * no caminho do webhook, e ninguém compara.
 *
 * O cliente vê uma data encolher sozinha na tela dele.
 *
 * Daí `cortesia_ate` ser coluna própria, `periodo_fim` continuar fora de todo
 * `GRANT` do painel, e `fimEfetivo` ser a leitura normativa.
 */

let api: ApiDeTeste

const HIPOTESE = { 'x-mavia-motivo': 'chamado', 'x-mavia-referencia': 'CH-9001' }

async function estado(tenant: string, valor: string): Promise<void> {
  await api.banco.cliente.query(`UPDATE assinaturas SET estado = $2::estado_da_assinatura WHERE tenant_id = $1`, [
    tenant,
    valor,
  ])
}

async function assinatura(tenant: string) {
  const r = await api.banco.cliente.query<{
    cortesia_ate: Date | null
    periodo_fim: Date
    origem: string
    atualizado_em: Date
  }>(
    `SELECT cortesia_ate, periodo_fim, origem_da_ultima_escrita AS origem, atualizado_em
       FROM assinaturas WHERE tenant_id = $1`,
    [tenant],
  )
  return r.rows[0]!
}

beforeAll(async () => {
  api = await subirApi()
  await api.banco.cliente.query('SELECT admin.conceder($1, $2)', [USUARIO_A, USUARIO_A])
  await api.banco.cliente.query('SELECT admin.conceder($1, $2)', [USUARIO_B, USUARIO_A])

  // A semente dos dois tenants é anterior à `0025` e não passa pelo gatilho que
  // cria a assinatura. Criamos aqui, explicitamente — o que este arquivo mede é
  // o que o painel faz **com** uma assinatura, não como ela nasce.
  for (const t of [TENANT_A, TENANT_B]) {
    await api.banco.cliente.query(
      `INSERT INTO assinaturas (tenant_id, estado, plano, intervalo, periodo_inicio,
                                periodo_fim, atualizado_em)
       VALUES ($1, 'ativa', 'familia', 'mensal', now() - interval '5 days',
               now() + interval '25 days', now() - interval '1 hour')
       ON CONFLICT (tenant_id) DO UPDATE
         SET estado = 'ativa', periodo_inicio = excluded.periodo_inicio,
             periodo_fim = excluded.periodo_fim, cortesia_ate = NULL`,
      [t],
    )
    // `atualizado_em` explicitamente no passado: o gatilho é de `UPDATE`, e uma
    // linha que nasce com ela nula tornaria a asserção sobre o gatilho
    // impossível de escrever — mediria "deixou de ser nula" em vez de "andou".
    await api.banco.cliente.query(
      `UPDATE assinaturas SET atualizado_em = now() - interval '1 hour' WHERE tenant_id = $1`,
      [t],
    )
  }
}, 120_000)

afterAll(async () => {
  await api?.encerrar()
})

describe('o campo que o webhook sobrescreve continua fora do alcance', () => {
  it('**nenhum papel do painel escreve `periodo_fim`**', async () => {
    const r = await api.banco.cliente.query<{ grantee: string }>(
      `SELECT grantee FROM information_schema.column_privileges
        WHERE table_name = 'assinaturas' AND column_name IN ('periodo_fim','periodo_inicio')
          AND privilege_type <> 'SELECT'
          AND grantee LIKE 'mavia_admin%'`,
    )
    expect(r.rows).toEqual([])
  })

  it('**`atualizado_em` é escrita por gatilho**, não por quem lembrar (F-16)', async () => {
    const antes = await assinatura(TENANT_A)
    // Um `UPDATE` que **não** menciona `atualizado_em`. Sem o gatilho, ela
    // ficaria parada, e a linha exportada ao cliente diria que a assinatura
    // dele não muda desde a última fatura.
    await api.banco.cliente.query(
      `UPDATE assinaturas SET origem_da_ultima_escrita = 'sistema' WHERE tenant_id = $1`,
      [TENANT_A],
    )
    const depois = await assinatura(TENANT_A)
    expect(depois.atualizado_em.getTime()).toBeGreaterThan(antes.atualizado_em.getTime())
  })
})

describe('conceder cortesia', () => {
  it('**estende sem tocar `periodo_fim`**, e marca a origem', async () => {
    await estado(TENANT_A, 'ativa')
    const antes = await assinatura(TENANT_A)

    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/admin/clientes/${TENANT_A}/cortesia`,
      usuario: USUARIO_A,
      cabecalhos: HIPOTESE,
      corpo: { dias: 30, razao: 'indisponibilidade de 4h em 12/09' },
    })
    expect(r.statusCode).toBe(201)

    const depois = await assinatura(TENANT_A)
    expect(depois.periodo_fim.getTime()).toBe(antes.periodo_fim.getTime())
    expect(depois.cortesia_ate).not.toBeNull()
    expect(depois.origem).toBe('painel')
  })

  it('**acumula sobre a cortesia anterior**, não sobre `periodo_fim`', async () => {
    // Sem isso, duas chamadas de 30 dias dariam 30 — e o operador repetiria a
    // operação achando que a primeira não pegou.
    const antes = await assinatura(TENANT_A)
    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/admin/clientes/${TENANT_A}/cortesia`,
      usuario: USUARIO_A,
      cabecalhos: HIPOTESE,
      corpo: { dias: 20, razao: 'segunda indisponibilidade' },
    })
    expect(r.statusCode).toBe(201)
    const depois = await assinatura(TENANT_A)
    expect(depois.cortesia_ate!.getTime()).toBeGreaterThan(antes.cortesia_ate!.getTime())
  })

  it('**o teto acumulado de sessenta dias é do banco**, e recusa com frase', async () => {
    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/admin/clientes/${TENANT_A}/cortesia`,
      usuario: USUARIO_A,
      cabecalhos: HIPOTESE,
      corpo: { dias: 30, razao: 'terceira, que passa do teto' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.body).toContain('sessenta dias')
  })

  it('**sem razão, recusa** — cortesia sem motivo escrito é indistinguível de favor', async () => {
    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/admin/clientes/${TENANT_B}/cortesia`,
      usuario: USUARIO_A,
      cabecalhos: HIPOTESE,
      corpo: { dias: 5 },
    })
    expect(r.statusCode).toBe(400)
  })

  it('**estado `expirada` não recebe cortesia**', async () => {
    await estado(TENANT_B, 'expirada')
    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/admin/clientes/${TENANT_B}/cortesia`,
      usuario: USUARIO_A,
      cabecalhos: HIPOTESE,
      corpo: { dias: 5, razao: 'tentativa em expirada' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.body).toContain('não recebe cortesia')
  })
})

describe('prorrogar o teste', () => {
  it('**uma vez por espaço, no máximo sete dias**', async () => {
    await estado(TENANT_B, 'teste')
    await api.banco.cliente.query(`UPDATE assinaturas SET cortesia_ate = NULL WHERE tenant_id = $1`, [
      TENANT_B,
    ])

    const primeira = await api.pedir({
      metodo: 'POST',
      url: `/v1/admin/clientes/${TENANT_B}/teste/prorrogar`,
      usuario: USUARIO_A,
      cabecalhos: HIPOTESE,
      corpo: { dias: 7, razao: 'cliente pediu mais tempo' },
    })
    expect(primeira.statusCode).toBe(201)

    const segunda = await api.pedir({
      metodo: 'POST',
      url: `/v1/admin/clientes/${TENANT_B}/teste/prorrogar`,
      usuario: USUARIO_A,
      cabecalhos: HIPOTESE,
      corpo: { dias: 3, razao: 'de novo' },
    })
    expect(segunda.statusCode).toBe(400)
    expect(segunda.body).toContain('já foi prorrogado')
  })

  it('**mais de sete dias é recusado** — é o prazo da DP-15, e não mais que ele', async () => {
    await estado(TENANT_A, 'teste')
    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/admin/clientes/${TENANT_A}/teste/prorrogar`,
      usuario: USUARIO_A,
      cabecalhos: HIPOTESE,
      corpo: { dias: 30, razao: 'muito tempo' },
    })
    expect(r.statusCode).toBe(400)
  })

  it('**quem não está em teste não tem teste a prorrogar**', async () => {
    await estado(TENANT_A, 'ativa')
    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/admin/clientes/${TENANT_A}/teste/prorrogar`,
      usuario: USUARIO_A,
      cabecalhos: HIPOTESE,
      corpo: { dias: 3, razao: 'tentativa em ativa' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.body).toContain('em teste')
  })
})

describe('o par de linhas que a regra 18 exige', () => {
  it('**intenção e efeito, ligadas pela correlação** (F-14)', async () => {
    // `auditoria` não aceita `UPDATE` de ninguém: a linha da intenção existe
    // **antes** de o valor novo existir, e nunca pode ser completada depois.
    // Por isso o `de → para` precisa de uma segunda linha — e a segunda precisa
    // dizer de qual primeira ela é.
    await estado(TENANT_B, 'ativa')
    await api.banco.cliente.query(`UPDATE assinaturas SET cortesia_ate = NULL WHERE tenant_id = $1`, [
      TENANT_B,
    ])
    const m = await api.banco.cliente.query<{ t: string }>('SELECT now()::text AS t')

    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/admin/clientes/${TENANT_B}/cortesia`,
      usuario: USUARIO_A,
      cabecalhos: HIPOTESE,
      corpo: { dias: 10, razao: 'compensação' },
    })
    expect(r.statusCode).toBe(201)

    const linhas = await api.banco.cliente.query<{
      acao: string
      classe: string
      correlacao: string
      de: unknown
      para: { razao_hash?: string; razao_comprimento?: number } | null
    }>(
      `SELECT acao, classe::text, correlacao, de, para FROM auditoria
        WHERE tenant_id = $1 AND ocorrido_em > $2::timestamptz ORDER BY ocorrido_em`,
      [TENANT_B, m.rows[0]!.t],
    )

    expect(linhas.rows).toHaveLength(2)
    const [intencao, efeito] = linhas.rows
    // A mesma correlação nas duas — é ela que permite afirmar que o par existe.
    expect(intencao!.correlacao).toBe(efeito!.correlacao)
    // As duas são escrita financeira; a segunda carrega o de → para.
    expect(intencao!.classe).toBe('escrita_financeira')
    expect(efeito!.acao).toBe('concedeu_cortesia')
    // **A razão entra hasheada.** É texto livre de até 280 caracteres escrito
    // pelo operador, e a política manda gravar campo livre como
    // `{ hash, comprimento }` — é a mesma narrativa que o campo `referencia`
    // foi endurecido para não receber, entrando pela porta ao lado.
    expect(efeito!.para?.razao_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(efeito!.para?.razao_comprimento).toBeGreaterThan(0)
  })
})

describe('quem escreveu por último', () => {
  it('**o webhook marca `stripe`**, e é o que impede o job de desfazer o painel', async () => {
    // Achado F-15: toda escrita legítima do painel é, por construção, uma
    // divergência contra a Stripe. Sem esta coluna, o job de reconciliação
    // desfaria o ato do operador e mandaria ao cliente um e-mail dizendo que o
    // acesso foi reduzido — por uma mudança que a Mavia fez e desfez.
    await api.banco.cliente.query(
      `UPDATE assinaturas SET stripe_subscription_id = 'sub_teste_origem' WHERE tenant_id = $1`,
      [TENANT_A],
    )
    await api.banco.cliente.query(
      `SELECT auth.aplicar_estado_da_assinatura('sub_teste_origem', 'ativa'::estado_da_assinatura, NULL, now() + interval '30 days')`,
    )
    expect((await assinatura(TENANT_A)).origem).toBe('stripe')
  })
})
