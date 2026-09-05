import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EstadoDoOauth } from '../src/redis/estado-do-oauth.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * A amarração do PKCE — **o defeito que derrubou a entrada pelo Google em
 * produção, e que treze testes não pegaram**.
 *
 * ## O que estava errado
 *
 * `google.controller` fazia, em duas linhas seguidas:
 *
 *     const pkce = gerarPkce()
 *     const tentativa = await this.estado.abrir(destino)
 *
 * `gerarPkce()` produz um par `(verifier, challenge)` e o controlador mandava
 * **o `challenge` desse par** para o Google. O `verifier` dele era descartado
 * ali mesmo. O que ia para o Redis — e voltava na hora de trocar o código — era
 * o `tentativa.verifier`, gerado de forma independente dentro de `abrir()`.
 *
 * Dois verificadores diferentes. O Google respondia, invariavelmente:
 *
 *     {"error": "invalid_grant", "error_description": "Invalid code verifier."}
 *
 * **A entrada pelo Google nunca funcionou.** Não é uma regressão; é um caminho
 * que nunca foi exercido de ponta a ponta.
 *
 * ## Por que os testes existentes não viram
 *
 * `google.test.ts` cobre a instalação **sem** credencial (503), o uso único do
 * `state` e a uniformidade da recusa. `oidc.test.ts` cobre `gerarPkce()`
 * isoladamente — e ele está correto: o par que ele devolve **casa**. O defeito
 * mora na costura entre os dois módulos, e nenhum teste olhava para a costura.
 *
 * A propriedade que faltava é esta, e ela é de uma linha:
 *
 *     o `code_challenge` que sai na URL é o hash do `verifier` que fica guardado
 *
 * Sem ela, qualquer refatoração que separe a geração do armazenamento
 * reintroduz o mesmo defeito, e o sintoma só aparece contra o Google de verdade.
 */

let api: ApiDeTeste
let estado: EstadoDoOauth

/** O que o Google calcula para conferir: `base64url(sha256(verifier))`. */
const desafioEsperado = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url')

beforeAll(async () => {
  // Lidas no construtor do controlador, então precisam existir antes de subir.
  process.env['GOOGLE_CLIENT_ID'] = 'teste.apps.googleusercontent.com'
  process.env['GOOGLE_CLIENT_SECRET'] = 'GOCSPX-teste'
  process.env['GOOGLE_REDIRECT_URI'] = 'https://exemplo.test/entrar/google'
  api = await subirApi()
  estado = new EstadoDoOauth(api.redis)
}, 180_000)

afterAll(async () => {
  delete process.env['GOOGLE_CLIENT_ID']
  delete process.env['GOOGLE_CLIENT_SECRET']
  delete process.env['GOOGLE_REDIRECT_URI']
  await api.encerrar()
})

/** Começa uma entrada e devolve a URL mais o vínculo que foi para o cookie. */
async function iniciar() {
  const r = await api.pedir({ metodo: 'POST', url: '/v1/auth/google', corpo: {} })
  expect(r.statusCode).toBe(200)

  const cookie = r.headers['set-cookie']
  const bruto = Array.isArray(cookie) ? cookie.join(';') : String(cookie ?? '')
  const vinculo = /oauth=([0-9a-f]{64})/.exec(bruto)?.[1] ?? null

  return { url: new URL(r.json<{ url: string }>().url), vinculo }
}

describe('o PKCE que sai e o que fica guardado', () => {
  it('**o `code_challenge` da URL é o hash do `verifier` guardado**', async () => {
    const { url, vinculo } = await iniciar()

    const state = url.searchParams.get('state')
    const challenge = url.searchParams.get('code_challenge')
    expect(state).toBeTruthy()
    expect(challenge).toBeTruthy()

    // `consumir` é o mesmo caminho que o retorno usa. Pegar a chave do Redis à
    // mão provaria o que está gravado; usar `consumir` prova o que a rota de
    // retorno **recebe**, que é o que importa.
    const tentativa = await estado.consumir(state!, vinculo)
    expect(tentativa).not.toBeNull()

    expect(challenge).toBe(desafioEsperado(tentativa!.verifier))
  })

  it('o método é S256, e nunca `plain`', async () => {
    // `plain` manda o verificador na própria URL, que vai para o histórico do
    // navegador e para o log de qualquer proxy no caminho.
    const { url } = await iniciar()
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('duas entradas seguidas não compartilham verificador nem desafio', async () => {
    const a = await iniciar()
    const b = await iniciar()

    expect(a.url.searchParams.get('code_challenge')).not.toBe(
      b.url.searchParams.get('code_challenge'),
    )

    const ta = await estado.consumir(a.url.searchParams.get('state')!, a.vinculo)
    const tb = await estado.consumir(b.url.searchParams.get('state')!, b.vinculo)
    expect(ta!.verifier).not.toBe(tb!.verifier)

    // E cada um casa com o **seu** desafio — não basta serem diferentes.
    expect(a.url.searchParams.get('code_challenge')).toBe(desafioEsperado(ta!.verifier))
    expect(b.url.searchParams.get('code_challenge')).toBe(desafioEsperado(tb!.verifier))
  })

  it('o `nonce` da URL é o que ficou guardado', async () => {
    // Mesma classe de defeito, outro campo: o `nonce` é conferido dentro do
    // `id_token`, e um desencontro aqui só apareceria contra o Google de
    // verdade — depois de a troca do código já ter dado certo.
    const { url, vinculo } = await iniciar()
    const tentativa = await estado.consumir(url.searchParams.get('state')!, vinculo)
    expect(url.searchParams.get('nonce')).toBe(tentativa!.nonce)
  })
})
