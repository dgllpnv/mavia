import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, USUARIO_A } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * `Idempotency-Key` — a fila offline reaplica **uma vez só**.
 *
 * O caso que este arquivo existe para travar não é o feliz: é o timeout depois
 * do commit. O servidor gravou a despesa, a resposta se perdeu, o app não sabe
 * de nada e reenvia. Sem idempotência, o mês ganha duas despesas iguais no
 * mesmo minuto — que é justamente o que ninguém percebe, porque parece erro de
 * digitação da própria pessoa.
 */

let api: ApiDeTeste
let conta = ''
let categoria = ''

const DE = { usuario: USUARIO_A, tenant: TENANT_A }

beforeAll(async () => {
  api = await subirApi()

  const contas = await api.pedir({ metodo: 'GET', url: '/v1/contas', ...DE })
  conta = contas.json().itens[0].id

  const cats = await api.pedir({ metodo: 'GET', url: '/v1/categorias', ...DE })
  categoria = cats
    .json()
    .itens.find((c: { natureza: string; analitica: boolean }) => c.natureza === 'despesa' && c.analitica).id
}, 180_000)

afterAll(async () => {
  await api?.encerrar()
})

const despesa = (descricao: string) => ({
  contaId: conta,
  categoriaId: categoria,
  valorCentavos: '-1234',
  postedAt: new Date().toISOString(),
  compensado: false,
  descricao,
})

/** O arreio já sabe autenticar; aqui só acrescentamos o cabeçalho. */
function pedirComChave(corpo: unknown, chave: string) {
  return api.pedir({
    metodo: 'POST',
    url: '/v1/lancamentos',
    ...DE,
    corpo,
    cabecalhos: { 'idempotency-key': chave },
  })
}

async function quantosCom(descricao: string): Promise<number> {
  const hoje = new Date()
  const de = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 1)).toISOString()
  const ate = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() + 1, 1)).toISOString()
  const r = await api.pedir({ metodo: 'GET', url: `/v1/lancamentos?de=${de}&ate=${ate}`, ...DE })
  return r.json().itens.filter((l: { descricao: string }) => l.descricao === descricao).length
}

describe('mesma chave, mesmo corpo', () => {
  it('**o segundo envio não cria nada, e devolve a mesma resposta**', async () => {
    const descricao = 'Café do metrô'
    const corpo = despesa(descricao)
    const chave = 'mutacao-do-app-1'

    const primeiro = await pedirComChave(corpo, chave)
    expect(primeiro.statusCode).toBe(201)

    const segundo = await pedirComChave(corpo, chave)

    // Mesmo status e mesmo corpo: para o app, a retentativa é indistinguível de
    // ter dado certo da primeira vez — que é exatamente o que ele precisa.
    expect(segundo.statusCode).toBe(201)
    expect(segundo.json().id).toBe(primeiro.json().id)

    expect(await quantosCom(descricao)).toBe(1)
  })

  it('cinco retentativas continuam sendo um lançamento', async () => {
    const descricao = 'Pão na padaria'
    const corpo = despesa(descricao)
    const chave = 'mutacao-do-app-2'

    for (let i = 0; i < 5; i++) {
      const r = await pedirComChave(corpo, chave)
      expect(r.statusCode).toBe(201)
    }

    expect(await quantosCom(descricao)).toBe(1)
  })
})

describe('mesma chave, corpo diferente', () => {
  it('**é conflito, e não repetição**', async () => {
    // Duas intenções distintas nasceram com a mesma identidade. Devolver a
    // primeira resposta esconderia a segunda para sempre — e o dinheiro dela
    // nunca entraria.
    const chave = 'mutacao-do-app-3'
    await pedirComChave(despesa('Primeira intenção'), chave)

    const r = await pedirComChave(despesa('Segunda intenção'), chave)

    expect(r.statusCode).toBe(409)
    expect(await quantosCom('Segunda intenção')).toBe(0)
  })
})

describe('sem chave', () => {
  it('dois envios iguais criam dois lançamentos', async () => {
    // O comportamento normal do HTTP, e ele tem de continuar: quem lança duas
    // vezes o mesmo café de propósito gastou duas vezes.
    const descricao = 'Dois cafés de propósito'
    await api.pedir({ metodo: 'POST', url: '/v1/lancamentos', ...DE, corpo: despesa(descricao) })
    await api.pedir({ metodo: 'POST', url: '/v1/lancamentos', ...DE, corpo: despesa(descricao) })

    expect(await quantosCom(descricao)).toBe(2)
  })
})

describe('a chave é por espaço', () => {
  it('a mesma chave noutra rota não devolve a resposta da primeira', async () => {
    // Um cliente com defeito reusando a chave de um lançamento num estorno
    // receberia de volta a resposta do lançamento — e acharia que estornou.
    const chave = 'mutacao-do-app-4'
    const criado = await pedirComChave(despesa('Para tentar reusar'), chave)

    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/lancamentos/${criado.json().id}/estornos`,
      ...DE,
      corpo: { valorCentavos: '1234', descricao: 'Estorno' },
      cabecalhos: { 'idempotency-key': chave },
    })

    expect(r.statusCode).toBe(409)
  })
})
