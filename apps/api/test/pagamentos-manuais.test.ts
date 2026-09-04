import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, TENANT_B, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * Pagamentos manuais — ticket 07, achados F-1 a F-7 e F-14.
 *
 * ## O cenário
 *
 * Cliente com cartão recusado entra em `em_atraso`, com catorze dias de graça.
 * Liga, paga R$ 79,00 por Pix, o operador dá baixa. Na versão que o parecer
 * reprovou, **a assinatura não era tocada**: a Stripe continuava retentando, a
 * graça continuava correndo, e no 15º dia o cliente que pagou ficava bloqueado
 * — depois de o operador ter dito a ele que estava resolvido.
 *
 * Uma ação chamada "dar baixa em pagamento" que não dá baixa em nada é a
 * definição de número errado.
 */

let api: ApiDeTeste

const HIPOTESE = { 'x-mavia-motivo': 'chamado', 'x-mavia-referencia': 'CH-7001' }
let sequencia = 0

/** Uma referência única por chamada — o índice é sobre ela, e é o assunto do F-3. */
function referencia(): string {
  sequencia += 1
  return `E2E-PIX-${String(sequencia).padStart(6, '0')}`
}

async function baixa(tenant: string, corpo: Record<string, unknown>) {
  return api.pedir({
    metodo: 'POST',
    url: `/v1/admin/clientes/${tenant}/pagamentos`,
    usuario: USUARIO_A,
    cabecalhos: HIPOTESE,
    corpo: {
      valorCentavos: '7900',
      meio: 'pix',
      referenciaExterna: referencia(),
      recebidoEm: new Date(Date.now() - 3_600_000).toISOString(),
      ...corpo,
    },
  })
}

async function estadoDe(tenant: string): Promise<string> {
  const r = await api.banco.cliente.query<{ e: string }>(
    `SELECT estado::text AS e FROM assinaturas WHERE tenant_id = $1`,
    [tenant],
  )
  return r.rows[0]!.e
}

async function porEstado(tenant: string, valor: string, graca: boolean): Promise<void> {
  await api.banco.cliente.query(
    `UPDATE assinaturas SET estado = $2::estado_da_assinatura,
                            graca_ate = CASE WHEN $3 THEN now() + interval '14 days' END
      WHERE tenant_id = $1`,
    [tenant, valor, graca],
  )
}

beforeAll(async () => {
  api = await subirApi()
  await api.banco.cliente.query('SELECT admin.conceder($1, $2)', [USUARIO_A, USUARIO_A])
  await api.banco.cliente.query('SELECT admin.conceder($1, $2)', [USUARIO_B, USUARIO_A])

  for (const t of [TENANT_A, TENANT_B]) {
    await api.banco.cliente.query(
      `INSERT INTO assinaturas (tenant_id, estado, plano, intervalo, periodo_inicio,
                                periodo_fim, atualizado_em)
       VALUES ($1, 'ativa', 'familia', 'mensal', now() - interval '5 days',
               now() + interval '25 days', now() - interval '1 hour')
       ON CONFLICT (tenant_id) DO UPDATE SET estado = 'ativa'`,
      [t],
    )
  }
}, 120_000)

afterAll(async () => {
  await api?.encerrar()
})

describe('a baixa paga alguma coisa (F-1)', () => {
  it('**um cliente em atraso que paga volta a ficar ativo, e a graça é limpa**', async () => {
    await porEstado(TENANT_A, 'em_atraso', true)

    const r = await baixa(TENANT_A, {})
    expect(r.statusCode).toBe(201)
    expect(r.json().estado).toBe('ativa')
    expect(await estadoDe(TENANT_A)).toBe('ativa')

    const g = await api.banco.cliente.query<{ graca_ate: Date | null }>(
      `SELECT graca_ate FROM assinaturas WHERE tenant_id = $1`,
      [TENANT_A],
    )
    expect(g.rows[0]!.graca_ate).toBeNull()
  })

  it('**quem expirou NÃO reativa por baixa manual** — e este teste afirmava o contrário', async () => {
    // A versão anterior desta asserção dizia "quem expirou reativa", e estava
    // errada. `transicao('expirada', 'pagamento_recuperado')` é **`null`** no
    // domínio; a função reimplementava a máquina de estados num `CASE` em SQL,
    // a cópia divergiu do original nesse ponto, e o teste consagrou a
    // divergência.
    //
    // Com números: tenant `expirada` desde 10/06, `periodo_fim` em 10/06. Um
    // Pix de R$ 79,00 gravava `estado = 'ativa'` — e a função **não pode**
    // tocar `periodo_fim`, que está fora de todo `GRANT`. Setenta e nove reais
    // compravam acesso indefinido.
    //
    // Uma suíte verde não prova que o comportamento está certo; prova que ele é
    // o que alguém escreveu que deveria ser.
    await porEstado(TENANT_B, 'expirada', false)
    const r = await baixa(TENANT_B, {})
    expect(r.statusCode).toBe(400)
    expect(await estadoDe(TENANT_B)).toBe('expirada')
  })

  it('**quem está em teste também não** — pagar em teste é assinar, e assinar pede plano', async () => {
    // Registrar dinheiro que não muda contrato nenhum é pior do que recusar: o
    // cliente em teste que paga e continua em teste expira tendo pago.
    await porEstado(TENANT_B, 'teste', false)
    const r = await baixa(TENANT_B, {})
    expect(r.statusCode).toBe(400)
  })

  it('**quem já estava ativo não muda de estado** — não há o que recuperar', async () => {
    await porEstado(TENANT_A, 'ativa', false)
    await porEstado(TENANT_B, 'ativa', false)
    await porEstado(TENANT_A, 'ativa', false)
    const r = await baixa(TENANT_A, {})
    expect(r.statusCode).toBe(201)
    expect(r.json().estado).toBe('ativa')
  })
})

describe('a chave de idempotência (F-3)', () => {
  it('**a mesma referência duas vezes é recusada, com frase**', async () => {
    await porEstado(TENANT_A, 'ativa', false)
    await porEstado(TENANT_B, 'ativa', false)
    const ref = referencia()
    const primeira = await baixa(TENANT_A, { referenciaExterna: ref })
    expect(primeira.statusCode).toBe(201)

    const segunda = await baixa(TENANT_A, { referenciaExterna: ref })
    expect(segunda.statusCode).toBe(400)
    expect(segunda.body).toContain('já foi registrada')
  })

  it('a mesma referência em **outro cliente** passa — a chave é por espaço', async () => {
    await porEstado(TENANT_A, 'ativa', false)
    await porEstado(TENANT_B, 'ativa', false)
    const ref = referencia()
    expect((await baixa(TENANT_A, { referenciaExterna: ref })).statusCode).toBe(201)
    expect((await baixa(TENANT_B, { referenciaExterna: ref })).statusCode).toBe(201)
  })

  it('**referência curta demais é recusada** — inclusive para dinheiro em espécie', async () => {
    await porEstado(TENANT_A, 'ativa', false)
    await porEstado(TENANT_B, 'ativa', false)
    const r = await baixa(TENANT_A, { meio: 'dinheiro', referenciaExterna: 'ABC' })
    expect(r.statusCode).toBe(400)
  })

  it('**as baixas anteriores são visíveis antes do botão**', async () => {
    // Dar baixa sem ver as baixas anteriores é o cenário da duplicidade com
    // outra roupa: o índice recusa a repetição exata, e não a mesma quantia com
    // outra referência.
    const r = await api.pedir({
      metodo: 'GET',
      url: `/v1/admin/clientes/${TENANT_A}/pagamentos`,
      usuario: USUARIO_A,
      cabecalhos: HIPOTESE,
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().itens.length).toBeGreaterThan(0)
  })
})

describe('o dinheiro tem forma (F-5, F-6, F-7)', () => {
  it('**a competência é derivada, no dia 1, em São Paulo**', async () => {
    await porEstado(TENANT_A, 'ativa', false)
    await porEstado(TENANT_B, 'ativa', false)
    // **31 de agosto às 22h em São Paulo é 1º de setembro em UTC.** Uma
    // competência digitada, ou derivada sem converter, mudaria a receita de mês
    // — e a escrituração é obrigação legal.
    //
    // A data é do **passado**, e a primeira versão deste teste usava uma
    // futura: a recusa de recebimento no futuro pegou antes, o que está certo.
    // A fronteira de fuso é a mesma; o que muda é que agora ela é medível.
    const ref = referencia()
    const r = await baixa(TENANT_A, {
      referenciaExterna: ref,
      recebidoEm: '2026-09-01T01:00:00.000Z',
    })
    expect(r.statusCode).toBe(201)

    const linha = await api.banco.cliente.query<{ c: string }>(
      `SELECT to_char(competencia, 'YYYY-MM-DD') AS c FROM pagamentos_manuais WHERE id = $1`,
      [r.json().id],
    )
    expect(linha.rows[0]!.c).toBe('2026-08-01')
  })

  it('**o enum tem quatro valores** — `cortesia` e `ajuste` saíram (DP-38)', async () => {
    const r = await api.banco.cliente.query<{ v: string }>(
      `SELECT unnest(enum_range(NULL::meio_de_pagamento))::text AS v ORDER BY 1`,
    )
    expect(r.rows.map((l) => l.v)).toEqual(['boleto', 'dinheiro', 'pix', 'transferencia'])
  })

  it('**valor zero ou negativo é recusado**', async () => {
    await porEstado(TENANT_A, 'ativa', false)
    await porEstado(TENANT_B, 'ativa', false)
    expect((await baixa(TENANT_A, { valorCentavos: '0' })).statusCode).toBe(400)
  })

  it('**recebimento no futuro é recusado** — o dinheiro não entrou ainda', async () => {
    await porEstado(TENANT_A, 'ativa', false)
    await porEstado(TENANT_B, 'ativa', false)
    const r = await baixa(TENANT_A, {
      recebidoEm: new Date(Date.now() + 86_400_000).toISOString(),
    })
    expect(r.statusCode).toBe(400)
    expect(r.body).toContain('futuro')
  })

  it('`valor_centavos` é `BIGINT`, e a moeda é presa a `BRL`', async () => {
    const r = await api.banco.cliente.query<{ tipo: string }>(
      `SELECT data_type AS tipo FROM information_schema.columns
        WHERE table_name = 'pagamentos_manuais' AND column_name = 'valor_centavos'`,
    )
    expect(r.rows[0]!.tipo).toBe('bigint')

    await expect(
      api.banco.cliente.query(
        `INSERT INTO pagamentos_manuais (tenant_id, registrado_por, recebido_em,
                                         valor_centavos, moeda, meio, referencia_externa)
         VALUES ($1, $2, now(), 100, 'USD', 'pix', 'REF-USD-000')`,
        [TENANT_A, USUARIO_A],
      ),
    ).rejects.toThrow(/moeda/)
  })
})

describe('o que o cliente vê, e o que ele não vê (F-4)', () => {
  it('**`registrado_por` não sai para `mavia_app`** — por privilégio, não por filtro', async () => {
    const r = await api.banco.cliente.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE table_name = 'pagamentos_manuais' AND grantee = 'mavia_app'
          AND column_name = 'registrado_por'`,
    )
    expect(r.rows).toEqual([])
  })

  it('**e `mavia_app` consegue ler o resto** — sem isso a exportação nem abriria', async () => {
    // É o achado S3-3 repetido uma tabela adiante: policy sem `GRANT` não lê
    // nada. A v3.1 mandava exportar uma tabela que `mavia_app` não podia abrir.
    const r = await api.banco.cliente.query<{ ok: boolean }>(
      `SELECT has_any_column_privilege('mavia_app', 'pagamentos_manuais', 'SELECT') AS ok`,
    )
    expect(r.rows[0]!.ok).toBe(true)
  })
})

describe('o par de linhas, com o valor em claro (F-14)', () => {
  it('**a linha de efeito carrega `de → para`**, e a de intenção a correlação', async () => {
    await porEstado(TENANT_B, 'em_atraso', true)
    const m = await api.banco.cliente.query<{ t: string }>('SELECT now()::text AS t')

    const r = await baixa(TENANT_B, { valorCentavos: '9900' })
    expect(r.statusCode).toBe(201)

    const linhas = await api.banco.cliente.query<{
      acao: string
      correlacao: string
      de: { estado?: string } | null
      para: { estado?: string; valor_centavos?: number; referencia_sha256?: string } | null
    }>(
      `SELECT acao, correlacao, de, para FROM auditoria
        WHERE tenant_id = $1 AND ocorrido_em > $2::timestamptz ORDER BY ocorrido_em`,
      [TENANT_B, m.rows[0]!.t],
    )

    expect(linhas.rows).toHaveLength(2)
    expect(linhas.rows[0]!.correlacao).toBe(linhas.rows[1]!.correlacao)

    // **Em claro**, e não hasheado: a política diz "em claro apenas quando o
    // valor é o objeto da mudança", e dar baixa em pagamento é exatamente esse
    // caso. Hash e redação ficam para texto livre e PII.
    const efeito = linhas.rows[1]!
    expect(efeito.acao).toBe('deu_baixa')
    expect(efeito.de?.estado).toBe('em_atraso')
    expect(efeito.para?.estado).toBe('ativa')
    expect(efeito.para?.valor_centavos).toBe(9900)

    // **A referência entra hasheada.** É o end-to-end id do Pix do titular, que
    // a política classifica como dado pessoal. Em claro na auditoria, o mesmo
    // identificador existiria sob duas políticas de retenção diferentes — cinco
    // anos fiscais na tabela de pagamentos, outro regime no log.
    //
    // Estado, valor e moeda continuam em claro, e isso é autorizado por escrito:
    // "em claro apenas quando o valor é o objeto da mudança", e dar baixa em
    // pagamento é exatamente esse caso.
    expect(efeito.para?.referencia_sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})
