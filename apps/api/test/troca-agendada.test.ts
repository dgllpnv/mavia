import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { comoApp, TENANT_A, TENANT_B, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * P-17 — a troca agendada que a tela prometia e ninguém cumpria.
 *
 * O defeito: `POST /v1/cobranca/plano` com um plano menor devolvia
 * `{ aplicadoEm: 'fim_do_periodo' }` e **não escrevia nada**. A data chegava e
 * nada acontecia. O cliente seguia pagando o plano caro para sempre.
 *
 * Os testes abaixo cobrem as duas metades — registrar a intenção e cumpri-la —
 * e as três formas de desfazê-la, que é onde os defeitos moram.
 */

let api: ApiDeTeste

const DE_A = { usuario: USUARIO_A, tenant: TENANT_A }
const DE_B = { usuario: USUARIO_B, tenant: TENANT_B }

const pedir = (metodo: 'GET' | 'POST' | 'DELETE', url: string, corpo?: unknown, de = DE_A) =>
  api.pedir({ metodo, url, ...de, ...(corpo === undefined ? {} : { corpo }) })

interface LinhaDeTroca {
  plano: string
  intervalo: string
  plano_anterior: string
  aplicar_em: Date
  avisada_em: Date | null
  aplicada_em: Date | null
  cancelada_em: Date | null
}

/** As linhas de troca de um espaço, da mais nova para a mais velha. */
async function trocas(tenant = TENANT_A, usuario = USUARIO_A): Promise<LinhaDeTroca[]> {
  const r = await comoApp(
    api.banco.cliente,
    { tenantId: tenant, usuarioId: usuario },
    () =>
      api.banco.cliente.query<LinhaDeTroca>(
        `SELECT plano, intervalo, plano_anterior, aplicar_em, avisada_em, aplicada_em, cancelada_em
           FROM trocas_agendadas ORDER BY pedida_em DESC`,
      ),
  )
  return r.rows
}

/** O plano vigente, lido do banco e não da resposta da rota. */
async function planoNoBanco(tenant = TENANT_A): Promise<string | undefined> {
  const r = await comoApp(api.banco.cliente, { tenantId: tenant, usuarioId: USUARIO_A }, () =>
    api.banco.cliente.query<{ plano: string }>(
      'SELECT plano FROM assinaturas WHERE tenant_id = $1',
      [tenant],
    ),
  )
  return r.rows[0]?.plano
}

/** Põe o espaço num estado pagante, com período e cortesia controlados. */
async function assinaturaEm(
  plano: string,
  opcoes: { periodoFim: string; cortesiaAte?: string | null; tenant?: string } ,
) {
  const tenant = opcoes.tenant ?? TENANT_A
  await api.banco.cliente.query(
    `UPDATE assinaturas
        SET estado = 'ativa', plano = $2, intervalo = 'mensal',
            periodo_inicio = now() - interval '1 day',
            periodo_fim = $3::timestamptz,
            cortesia_ate = $4::timestamptz
      WHERE tenant_id = $1`,
    [tenant, plano, opcoes.periodoFim, opcoes.cortesiaAte ?? null],
  )
}

beforeAll(async () => {
  api = await subirApi()
})

afterAll(async () => {
  await api.encerrar()
})

beforeEach(async () => {
  await api.banco.cliente.query('DELETE FROM trocas_agendadas')
})

describe('pedir para descer de plano', () => {
  it('**registra a intenção — o defeito P-17**', async () => {
    // O teste que não existia. Antes da correção, a rota respondia
    // `fim_do_periodo` com zero linhas no banco.
    await assinaturaEm('negocio', { periodoFim: '2026-12-01T03:00:00Z' })

    const r = await pedir('POST', '/v1/cobranca/plano', { plano: 'pessoal' })

    expect(r.statusCode).toBe(200)
    expect(r.json().aplicadoEm).toBe('fim_do_periodo')

    const linhas = await trocas()
    expect(linhas).toHaveLength(1)
    expect(linhas[0]?.plano).toBe('pessoal')
    expect(linhas[0]?.plano_anterior).toBe('negocio')
    expect(await planoNoBanco()).toBe('negocio')
  })

  it('a resposta devolve a data, e é a mesma que foi gravada', async () => {
    // Uma data na tela que não é a data no banco é o mesmo defeito com outra
    // roupa: a promessa continua sendo descumprida, só que por um dia.
    await assinaturaEm('negocio', { periodoFim: '2026-12-01T03:00:00Z' })

    const r = await pedir('POST', '/v1/cobranca/plano', { plano: 'familia' })

    const linhas = await trocas()
    expect(new Date(String(r.json().aplicadoEmData)).toISOString()).toBe(
      new Date(String(linhas[0]?.aplicar_em)).toISOString(),
    )
  })

  it('**a cortesia adia a troca — o F-12 num caminho novo**', async () => {
    // O operador concedeu sessenta dias por uma indisponibilidade. O cliente
    // comprou o direito de usar até lá. Rebaixar em `periodo_fim` tiraria dele
    // a cortesia que alguém deu de propósito.
    await assinaturaEm('negocio', {
      periodoFim: '2026-10-01T03:00:00Z',
      cortesiaAte: '2026-12-01T03:00:00Z',
    })

    await pedir('POST', '/v1/cobranca/plano', { plano: 'pessoal' })

    const linhas = await trocas()
    expect(new Date(String(linhas[0]?.aplicar_em)).toISOString()).toBe('2026-12-01T03:00:00.000Z')
  })

  it('pedir de novo substitui, e não empilha', async () => {
    await assinaturaEm('negocio', { periodoFim: '2026-12-01T03:00:00Z' })

    await pedir('POST', '/v1/cobranca/plano', { plano: 'pessoal' })
    await pedir('POST', '/v1/cobranca/plano', { plano: 'familia' })

    const linhas = await trocas()
    const pendentes = linhas.filter((l) => !l.aplicada_em && !l.cancelada_em)
    expect(pendentes).toHaveLength(1)
    expect(pendentes[0]?.plano).toBe('familia')
  })

  it('**subir de plano cancela a descida agendada**', async () => {
    // Sem isto: o cliente agenda a descida, se arrepende e sobe, e no fim do
    // período o job o derruba de volta — desfazendo uma compra que ele fez
    // depois. O plano some sozinho e ninguém consegue explicar por quê.
    await assinaturaEm('negocio', { periodoFim: '2026-12-01T03:00:00Z' })
    await pedir('POST', '/v1/cobranca/plano', { plano: 'pessoal' })

    const r = await pedir('POST', '/v1/cobranca/plano', { plano: 'negocio' })

    expect(r.json().aplicadoEm).toBe('agora')
    const linhas = await trocas()
    expect(linhas.filter((l) => !l.cancelada_em)).toHaveLength(0)
  })

  it('voltar ao plano atual cancela a troca, e não agenda uma troca para o mesmo lugar', async () => {
    await assinaturaEm('negocio', { periodoFim: '2026-12-01T03:00:00Z' })
    await pedir('POST', '/v1/cobranca/plano', { plano: 'pessoal' })

    await pedir('POST', '/v1/cobranca/plano', { plano: 'negocio' })

    expect((await trocas()).filter((l) => !l.cancelada_em)).toHaveLength(0)
    expect(await planoNoBanco()).toBe('negocio')
  })

  it('em teste, descer aplica na hora — não há período pago a respeitar', async () => {
    await api.banco.cliente.query(
      `UPDATE assinaturas SET estado = 'teste', plano = 'negocio' WHERE tenant_id = $1`,
      [TENANT_A],
    )

    const r = await pedir('POST', '/v1/cobranca/plano', { plano: 'pessoal' })

    expect(r.json().aplicadoEm).toBe('agora')
    expect(await planoNoBanco()).toBe('pessoal')
    expect(await trocas()).toHaveLength(0)
  })
})

describe('cancelar a troca agendada', () => {
  it('cancela, e a linha fica — nunca some', async () => {
    await assinaturaEm('negocio', { periodoFim: '2026-12-01T03:00:00Z' })
    await pedir('POST', '/v1/cobranca/plano', { plano: 'pessoal' })

    const r = await pedir('DELETE', '/v1/cobranca/plano/agendado')

    expect(r.statusCode).toBe(200)
    const linhas = await trocas()
    expect(linhas).toHaveLength(1)
    expect(linhas[0]?.cancelada_em).not.toBeNull()
  })

  it('cancelar sem nada agendado é 404, e não um sucesso silencioso', async () => {
    await assinaturaEm('negocio', { periodoFim: '2026-12-01T03:00:00Z' })
    expect((await pedir('DELETE', '/v1/cobranca/plano/agendado')).statusCode).toBe(404)
  })
})

describe('o job que cumpre a promessa', () => {
  it('**aplica quando a data chega**', async () => {
    await assinaturaEm('negocio', { periodoFim: '2026-12-01T03:00:00Z' })
    await pedir('POST', '/v1/cobranca/plano', { plano: 'pessoal' })
    // A data no passado é o que o job vê no dia seguinte ao vencimento.
    await api.banco.cliente.query(
      `UPDATE trocas_agendadas SET aplicar_em = now() - interval '1 hour'`,
    )

    expect(await api.aplicarTrocasAgendadas()).toBe(1)

    expect(await planoNoBanco()).toBe('pessoal')
    expect((await trocas())[0]?.aplicada_em).not.toBeNull()
  })

  it('**não aplica antes da data** — o teste que impede o job de roubar o período pago', async () => {
    await assinaturaEm('negocio', { periodoFim: '2026-12-01T03:00:00Z' })
    await pedir('POST', '/v1/cobranca/plano', { plano: 'pessoal' })

    expect(await api.aplicarTrocasAgendadas()).toBe(0)
    expect(await planoNoBanco()).toBe('negocio')
  })

  it('rodar duas vezes aplica uma vez — idempotência', async () => {
    await assinaturaEm('negocio', { periodoFim: '2026-12-01T03:00:00Z' })
    await pedir('POST', '/v1/cobranca/plano', { plano: 'pessoal' })
    await api.banco.cliente.query(
      `UPDATE trocas_agendadas SET aplicar_em = now() - interval '1 hour'`,
    )

    expect(await api.aplicarTrocasAgendadas()).toBe(1)
    expect(await api.aplicarTrocasAgendadas()).toBe(0)
  })

  it('não aplica o que foi cancelado', async () => {
    await assinaturaEm('negocio', { periodoFim: '2026-12-01T03:00:00Z' })
    await pedir('POST', '/v1/cobranca/plano', { plano: 'pessoal' })
    await pedir('DELETE', '/v1/cobranca/plano/agendado')
    await api.banco.cliente.query(
      `UPDATE trocas_agendadas SET aplicar_em = now() - interval '1 hour'`,
    )

    expect(await api.aplicarTrocasAgendadas()).toBe(0)
    expect(await planoNoBanco()).toBe('negocio')
  })

  it('**a escrita do job diz que foi o sistema, e não o cliente**', async () => {
    // `origem_da_ultima_escrita` é o que impede o job de reconciliação com a
    // Stripe de tratar esta troca como divergência e desfazê-la. Achado F-15.
    await assinaturaEm('negocio', { periodoFim: '2026-12-01T03:00:00Z' })
    await pedir('POST', '/v1/cobranca/plano', { plano: 'pessoal' })
    await api.banco.cliente.query(
      `UPDATE trocas_agendadas SET aplicar_em = now() - interval '1 hour'`,
    )

    await api.aplicarTrocasAgendadas()

    const r = await comoApp(
      api.banco.cliente,
      { tenantId: TENANT_A, usuarioId: USUARIO_A },
      () =>
        api.banco.cliente.query<{ origem_da_ultima_escrita: string }>(
          'SELECT origem_da_ultima_escrita FROM assinaturas WHERE tenant_id = $1',
          [TENANT_A],
        ),
    )
    expect(r.rows[0]?.origem_da_ultima_escrita).toBe('sistema')
  })
})

describe('o isolamento entre espaços', () => {
  it('a troca de um espaço não aparece no outro', async () => {
    await assinaturaEm('negocio', { periodoFim: '2026-12-01T03:00:00Z' })
    await pedir('POST', '/v1/cobranca/plano', { plano: 'pessoal' })

    expect(await trocas(TENANT_B)).toHaveLength(0)
  })

  it('**cancelar não alcança a troca do vizinho**', async () => {
    // A rota de cancelamento não recebe id: ela cancela "a pendente do meu
    // espaço". Se o `WHERE` esquecesse o tenant, o primeiro a cancelar
    // cancelaria a de outra pessoa — e a RLS é a rede que precisa estar aí
    // embaixo mesmo assim.
    await assinaturaEm('negocio', { periodoFim: '2026-12-01T03:00:00Z' })
    await assinaturaEm('negocio', { periodoFim: '2026-12-01T03:00:00Z', tenant: TENANT_B })
    await pedir('POST', '/v1/cobranca/plano', { plano: 'pessoal' })
    await pedir('POST', '/v1/cobranca/plano', { plano: 'pessoal' }, DE_B)

    await pedir('DELETE', '/v1/cobranca/plano/agendado')

    const doB = await trocas(TENANT_B, USUARIO_B)
    expect(doB).toHaveLength(1)
    expect(doB[0]?.cancelada_em).toBeNull()
  })
})
