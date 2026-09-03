import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, TENANT_B, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * Cobrança.
 *
 * As duas propriedades que sustentam o épico:
 *
 * - **o webhook é reenviado**, e reenviar não pode mudar nada duas vezes;
 * - **a cota é conferida no servidor**, na mesma transação da criação. Cota
 *   conferida só na tela é defeito.
 */

let api: ApiDeTeste

const SEGREDO = 'whsec_teste_da_mavia'
const DE_A = { usuario: USUARIO_A, tenant: TENANT_A }
const pedir = (metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, corpo?: unknown) =>
  api.pedir({ metodo, url, ...DE_A, ...(corpo === undefined ? {} : { corpo }) })

/**
 * Um evento da Stripe, assinado como ela assina.
 *
 * O corpo é montado com **espaçamento próprio**, de propósito: assim ele não
 * coincide com `JSON.stringify` do objeto parseado, e a verificação só passa se
 * o servidor guardar de fato os bytes crus. Com o corpo compacto, este teste
 * passaria mesmo com a implementação errada.
 */
function evento(id: string, type: string, subscription: string) {
  const corpo = JSON.stringify(
    {
      id,
      type,
      data: { object: { subscription, current_period_end: 1_800_000_000 } },
    },
    null,
    1,
  )
  const t = Math.floor(Date.now() / 1000)
  const v1 = createHmac('sha256', SEGREDO).update(`${t}.${corpo}`, 'utf8').digest('hex')
  return { corpo, cabecalho: `t=${t},v1=${v1}` }
}

const enviarWebhook = (id: string, type: string, subscription = 'sub_teste') => {
  const e = evento(id, type, subscription)
  return api.app.inject({
    method: 'POST',
    url: '/v1/cobranca/webhook',
    headers: { 'stripe-signature': e.cabecalho, 'content-type': 'application/json' },
    payload: e.corpo,
  })
}

beforeAll(async () => {
  process.env['STRIPE_WEBHOOK_SECRET'] = SEGREDO
  api = await subirApi()

  await api.banco.cliente.query(
    `UPDATE assinaturas SET stripe_subscription_id = 'sub_teste' WHERE tenant_id = $1`,
    [TENANT_A],
  )
}, 180_000)

afterAll(async () => {
  await api?.encerrar()
  delete process.env['STRIPE_WEBHOOK_SECRET']
})

describe('o estado do espaço', () => {
  it('todo espaço nasce em teste, com as cotas do Família', async () => {
    const r = await pedir('GET', '/v1/cobranca')

    expect(r.statusCode).toBe(200)
    expect(r.json().estado).toBe('teste')
    // Quem testa precisa poder convidar a família, senão o teste não exercita o
    // produto que a pessoa está avaliando.
    expect(r.json().cotas.pessoas).toBe(5)
    expect(r.json().podeEscrever).toBe(true)
  })

  it('**a resposta não traz preço pago, cartão nem documento fiscal**', async () => {
    // A matriz é explícita: o membro vê plano e cota, e nunca esses três.
    const texto = (await pedir('GET', '/v1/cobranca')).body

    expect(texto).not.toContain('stripe_customer')
    expect(texto).not.toContain('cartao')
    expect(texto).not.toContain('cpf')
  })

  it('o uso conta membros **e** convites pendentes', async () => {
    const antes = (await pedir('GET', '/v1/cobranca')).json().uso.pessoas

    const r = await pedir('POST', '/v1/membros/convites', {
      email: 'conta-na-cota@exemplo.com',
      papel: 'membro',
    })
    expect(r.statusCode).toBe(201)

    const depois = (await pedir('GET', '/v1/cobranca')).json().uso.pessoas
    expect(depois).toBe(antes + 1)
  })
})

describe('a cota, conferida no servidor', () => {
  it('**estourar a cota recusa, e a mensagem nomeia a cota e a contagem**', async () => {
    // O espaço está em teste (cota de 5). Enche até estourar.
    for (let i = 0; i < 10; i++) {
      const r = await pedir('POST', '/v1/membros/convites', {
        email: `pessoa${i}@exemplo.com`,
        papel: 'visualizador',
      })
      if (r.statusCode === 400) {
        expect(r.json().message).toContain('comporta 5 pessoas')
        expect(r.json().message).toContain('convites pendentes contam')
        return
      }
      expect(r.statusCode).toBe(201)
    }
    throw new Error('a cota não foi aplicada')
  })
})

describe('o webhook, que é reenviado sempre', () => {
  it('recusa corpo sem assinatura válida', async () => {
    const r = await api.app.inject({
      method: 'POST',
      url: '/v1/cobranca/webhook',
      headers: { 'stripe-signature': 't=1,v1=deadbeef', 'content-type': 'application/json' },
      payload: JSON.stringify({ id: 'evt_falso', type: 'invoice.payment_failed', data: { object: {} } }),
    })

    expect(r.statusCode).toBe(400)
  })

  it('recusa sem assinatura nenhuma', async () => {
    const r = await api.app.inject({
      method: 'POST',
      url: '/v1/cobranca/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: 'evt_sem', type: 'x', data: { object: {} } }),
    })

    expect(r.statusCode).toBe(400)
  })

  it('aplica a transição', async () => {
    await api.banco.cliente.query(
      `UPDATE assinaturas SET estado = 'ativa' WHERE tenant_id = $1`,
      [TENANT_A],
    )

    const r = await enviarWebhook('evt_falha_1', 'invoice.payment_failed')

    expect(r.statusCode).toBe(200)
    expect(r.json().tratado).toBe(true)

    const estado = await api.banco.cliente.query<{ estado: string; graca_ate: Date | null }>(
      'SELECT estado, graca_ate FROM assinaturas WHERE tenant_id = $1',
      [TENANT_A],
    )
    expect(estado.rows[0]!.estado).toBe('em_atraso')
    // Catorze dias de graça, e o produto **inteiro** continua funcionando.
    expect(estado.rows[0]!.graca_ate).not.toBeNull()
  })

  it('**em atraso não bloqueia nada**', async () => {
    // Bloquear no instante em que o cartão falha é a forma mais comum de perder
    // um cliente que queria ficar.
    const r = await pedir('GET', '/v1/cobranca')

    expect(r.json().estado).toBe('em_atraso')
    expect(r.json().podeEscrever).toBe(true)
  })

  it('**o mesmo evento, reenviado, não faz nada de novo**', async () => {
    const r = await enviarWebhook('evt_falha_1', 'invoice.payment_failed')

    expect(r.statusCode).toBe(200)
    expect(r.json().tratado).toBe(false)
  })

  it('**um evento fora de ordem não conserta o estado — fica registrado**', async () => {
    // A Stripe entrega fora de ordem. Um `subscription.created` chegando depois
    // não pode reativar quem está em atraso, e a recusa precisa ser auditável
    // em vez de invisível.
    const r = await enviarWebhook('evt_criada_tarde', 'customer.subscription.created')

    expect(r.json().tratado).toBe(false)

    const registro = await api.banco.cliente.query<{ transicao: string | null }>(
      'SELECT transicao FROM eventos_de_cobranca WHERE id = $1',
      ['evt_criada_tarde'],
    )
    expect(registro.rows[0]!.transicao).toBeNull()

    const estado = await api.banco.cliente.query<{ estado: string }>(
      'SELECT estado FROM assinaturas WHERE tenant_id = $1',
      [TENANT_A],
    )
    expect(estado.rows[0]!.estado).toBe('em_atraso')
  })

  it('o pagamento recuperado devolve o espaço a ativa', async () => {
    const r = await enviarWebhook('evt_pago_1', 'invoice.payment_succeeded')

    expect(r.json().tratado).toBe(true)

    const estado = await api.banco.cliente.query<{ estado: string; graca_ate: Date | null }>(
      'SELECT estado, graca_ate FROM assinaturas WHERE tenant_id = $1',
      [TENANT_A],
    )
    expect(estado.rows[0]!.estado).toBe('ativa')
    // A data de graça some junto: uma data sobrando num estado ativo faria um
    // job expirar quem está pagando.
    expect(estado.rows[0]!.graca_ate).toBeNull()
  })

  it('evento de tipo desconhecido é registrado e ignorado', async () => {
    // Reagir ao que não se entende é como um checkout incompleto vira uma
    // assinatura ativa.
    const r = await enviarWebhook('evt_estranho', 'customer.discount.created')

    expect(r.statusCode).toBe(200)
    expect(r.json().tratado).toBe(false)
  })
})

describe('trocar de plano', () => {
  it('subir vale agora', async () => {
    const r = await pedir('POST', '/v1/cobranca/plano', { plano: 'negocio' })

    expect(r.json()).toMatchObject({ aplicadoEm: 'agora', plano: 'negocio' })
    expect((await pedir('GET', '/v1/cobranca')).json().cotas.pessoas).toBe(10)
  })

  it('**descer espera o fim do período pago**', async () => {
    // O cliente comprou aquele período inteiro. Cortar no meio seria vender
    // doze meses e entregar sete.
    const r = await pedir('POST', '/v1/cobranca/plano', { plano: 'pessoal' })

    expect(r.json().aplicadoEm).toBe('fim_do_periodo')
    expect((await pedir('GET', '/v1/cobranca')).json().plano).toBe('negocio')
  })

  it('o preço vem do catálogo, e é o decidido', async () => {
    expect((await pedir('GET', '/v1/cobranca')).json().precoCentavos).toBe('9900')
  })
})

describe('a matriz', () => {
  it('ler é de todos; trocar de plano é do dono', async () => {
    const { pode } = await import('../src/autorizacao/politica-acesso.js')

    expect(pode({ metodo: 'GET', caminho: '/v1/cobranca' }, 'visualizador')).toBe(true)
    expect(pode({ metodo: 'POST', caminho: '/v1/cobranca/plano' }, 'membro')).toBe(false)
    expect(pode({ metodo: 'POST', caminho: '/v1/cobranca/plano' }, 'proprietario')).toBe(true)
  })

  it('a assinatura de um espaço não aparece no outro', async () => {
    const r = await api.pedir({
      metodo: 'GET',
      url: '/v1/cobranca',
      usuario: USUARIO_B,
      tenant: TENANT_B,
    })

    expect(r.statusCode).toBe(200)
    expect(r.json().plano).toBe('pessoal')
  })
})
