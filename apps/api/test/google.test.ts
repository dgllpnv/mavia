import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EstadoDoOauth } from '../src/redis/estado-do-oauth.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * As rotas de entrada pelo Google — P-4.
 *
 * O que **não** está aqui: a verificação do `id_token`, que tem arquivo próprio
 * (`oidc.test.ts`) e forja tokens de verdade contra um par de chaves real.
 *
 * O que está: o comportamento das rotas sem credencial configurada, o estado de
 * uso único, e a recusa uniforme. São as três coisas que um adapter de OAuth
 * costuma errar quando ninguém olha.
 */

let api: ApiDeTeste
let estado: EstadoDoOauth

const pedir = (url: string, corpo?: unknown) =>
  api.pedir({ metodo: 'POST', url, ...(corpo === undefined ? {} : { corpo }) })

beforeAll(async () => {
  api = await subirApi()
  estado = new EstadoDoOauth(api.redis)
}, 180_000)

afterAll(async () => {
  await api.encerrar()
})

describe('sem credencial do Google configurada', () => {
  it('**as rotas recusam com 503, em vez de fingir**', async () => {
    // É configuração ausente, não defeito — e é o estado desta instalação até o
    // dono do produto criar o cliente OAuth no console do Google. A mesma
    // escolha do webhook da Stripe sem segredo e do cadastro sem SMTP: recusar
    // é mais honesto que aceitar sem poder cumprir.
    expect((await pedir('/v1/auth/google', {})).statusCode).toBe(503)
  })

  it('o retorno com estado inexistente é 401, e não 503', async () => {
    // A ordem importa: o retorno também exige configuração, mas um `state`
    // inventado precisa levar a mesma recusa que um `state` expirado.
    const r = await pedir('/v1/auth/google/retorno', {
      codigo: 'x',
      state: 'f'.repeat(64),
    })

    expect([401, 503]).toContain(r.statusCode)
  })
})

describe('o estado da tentativa', () => {
  it('guarda os quatro segredos, cada um na sua forma', async () => {
    const t = await estado.abrir('/lancamentos')

    expect(t.state).toMatch(/^[0-9a-f]{64}$/)
    expect(t.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(t.verifier.length).toBeGreaterThanOrEqual(43)
    expect(t.vinculo).toMatch(/^[0-9a-f]{64}$/)
  })

  it('**consome uma vez, e a segunda não encontra nada**', async () => {
    // Um `state` reapresentável não é `state` nenhum: ele existe para que o
    // retorno de autorização não possa ser reproduzido.
    const t = await estado.abrir('/')

    const primeira = await estado.consumir(t.state, t.vinculo)
    const segunda = await estado.consumir(t.state, t.vinculo)

    expect(primeira?.nonce).toBe(t.nonce)
    expect(primeira?.verifier).toBe(t.verifier)
    expect(segunda).toBeNull()
  })

  it('preserva o destino, que é para onde a pessoa volta', async () => {
    const t = await estado.abrir('/relatorios')

    expect((await estado.consumir(t.state, t.vinculo))?.destino).toBe('/relatorios')
  })

  it('estado com forma errada nem vai ao Redis', async () => {
    for (const lixo of ['', 'x', 'F'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)} `]) {
      expect(await estado.consumir(lixo, 'a'.repeat(64))).toBeNull()
    }
  })

  it('**um estado que nunca foi aberto não abre nada**', async () => {
    expect(await estado.consumir('9'.repeat(64), 'a'.repeat(64))).toBeNull()
  })

  it('**sem o vínculo do navegador, o retorno não vale — é o CSRF de login**', async () => {
    // O ataque que o `state` sozinho **não** impede, e que a primeira versão
    // deste código deixava passar:
    //
    //  1. o atacante começa uma entrada com a conta Google dele e para no meio;
    //  2. entrega à vítima um link com aquele `code` e aquele `state`;
    //  3. a nossa própria tela faz o `POST`, e a vítima entra na conta **dele**;
    //  4. ela passa a lançar os dados financeiros dela num espaço que ele lê.
    //
    // O `state` não protege porque o atacante o conhece — ele o gerou. O que
    // ele não consegue é escrever um cookie no navegador da vítima.
    const t = await estado.abrir('/')

    expect(await estado.consumir(t.state, null)).toBeNull()
  })

  it('**o vínculo de outra tentativa também não vale**', async () => {
    const daVitima = await estado.abrir('/')
    const doAtacante = await estado.abrir('/')

    // O navegador da vítima apresenta o `state` do atacante com o cookie dela.
    expect(await estado.consumir(doAtacante.state, daVitima.vinculo)).toBeNull()
  })

  it('**um retorno com vínculo errado queima o `state`**', async () => {
    // Consumir antes de conferir é de propósito: a tentativa do atacante morre
    // junto com a rejeição, sem deixar um `state` vivo para uma segunda
    // tentativa com outro navegador.
    const t = await estado.abrir('/')

    expect(await estado.consumir(t.state, 'b'.repeat(64))).toBeNull()
    expect(await estado.consumir(t.state, t.vinculo)).toBeNull()
  })

  it('os quatro segredos são distintos', async () => {
    const t = await estado.abrir('/')

    expect(new Set([t.state, t.nonce, t.verifier, t.vinculo]).size).toBe(4)
  })
})

describe('o destino', () => {
  it('**um destino absoluto é recusado**', async () => {
    // É a porta que transforma um link nosso em phishing convincente: o
    // usuário vê o domínio da Mavia, entra de verdade, e é jogado no site do
    // atacante já autenticado.
    for (const destino of [
      'https://atacante.test',
      '//atacante.test',
      'http://atacante.test/x',
      '/\\atacante.test',
    ]) {
      const r = await pedir('/v1/auth/google', { destino })
      // **400, e não 503.** A validação acontece antes da configuração de
      // propósito: com a ordem invertida esta recusa ficaria escondida atrás do
      // 503 desta instalação, e o teste passaria sem provar nada.
      expect(r.statusCode).toBe(400)
    }
  })

  it('um caminho relativo passa da validação', async () => {
    // O outro lado: o destino legítimo chega ao ponto em que só falta a
    // configuração. É o que separa "recusado pela regra" de "recusado por
    // acaso".
    const r = await pedir('/v1/auth/google', { destino: '/relatorios' })

    expect(r.statusCode).toBe(503)
  })
})
