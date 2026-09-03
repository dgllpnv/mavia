import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  EntradaFederadaInvalida,
  esquecerJwks,
  gerarPkce,
  ISSUER_DO_GOOGLE,
  urlDeAutorizacao,
  verificarIdToken,
} from '../src/autenticacao/oidc.js'

/**
 * A verificação do `id_token` — `spec-autenticacao.md` §1.
 *
 * Este arquivo **forja tokens**. É a única forma honesta de testar um
 * verificador: gerar um par de chaves de verdade, assinar reivindicações
 * escolhidas, e conferir o que é aceito e o que é recusado. Um duplo que
 * devolvesse "válido" provaria que o duplo funciona.
 *
 * Os casos que importam não são o caminho feliz. São `alg: none`, `HS256`
 * assinado com a chave pública, o token emitido para outro cliente, o `iss`
 * parecido, e o `nonce` de outra sessão — cada um deles é um login válido para
 * quem não deveria entrar.
 */

const CLIENT_ID = '1234.apps.googleusercontent.com'
const NONCE = 'a'.repeat(64)

const par = generateKeyPairSync('rsa', { modulusLength: 2048 })
const outroPar = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KID = 'chave-de-teste'

/** A JWKS que o Google devolveria, com a nossa chave dentro. */
function jwks(publica: KeyObject = par.publicKey, kid = KID) {
  const jwk = publica.export({ format: 'jwk' })
  return { keys: [{ ...jwk, kid, use: 'sig', alg: 'RS256' }] }
}

/** Um `fetch` que responde a JWKS e mais nada. */
function fetchDeJwks(corpo: unknown = jwks()): typeof fetch {
  return async () =>
    new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
}

const agora = Math.floor(Date.now() / 1000)

/**
 * Recusou **por este motivo**?
 *
 * A mensagem é sempre a mesma — é a decisão do spec, e a razão dela é que
 * distinguir "issuer errado" de "nonce errado" ensina a tentar de novo com o
 * campo certo. O motivo vive num campo separado, que vai para o log do
 * operador. Um teste que afirmasse sobre a mensagem estaria afirmando sobre a
 * parte que **não** distingue nada.
 */
async function recusaPor(f: () => Promise<unknown>, motivo: RegExp): Promise<void> {
  try {
    await f()
    expect.unreachable('deveria ter recusado')
  } catch (erro) {
    expect(erro).toBeInstanceOf(EntradaFederadaInvalida)
    expect((erro as EntradaFederadaInvalida).motivoInterno).toMatch(motivo)
  }
}

function assinar(
  reivindicacoes: Record<string, unknown>,
  opcoes: { alg?: string; kid?: string; chave?: KeyObject } = {},
): string {
  const cabecalho = { alg: opcoes.alg ?? 'RS256', kid: opcoes.kid ?? KID, typ: 'JWT' }
  const c = Buffer.from(JSON.stringify(cabecalho)).toString('base64url')
  const p = Buffer.from(JSON.stringify(reivindicacoes)).toString('base64url')

  const assinador = createSign('RSA-SHA256')
  assinador.update(`${c}.${p}`)
  const s = assinador.sign(opcoes.chave ?? par.privateKey).toString('base64url')

  return `${c}.${p}.${s}`
}

const validas = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER_DO_GOOGLE,
  aud: CLIENT_ID,
  sub: '110000000000000000001',
  exp: agora + 3600,
  iat: agora - 10,
  nonce: NONCE,
  email: 'ana@exemplo.test',
  email_verified: true,
  name: 'Ana',
  ...over,
})

beforeEach(() => esquecerJwks())

describe('o caminho feliz', () => {
  it('aceita um token bem formado e devolve a identidade', async () => {
    const id = await verificarIdToken(assinar(validas()), CLIENT_ID, NONCE, fetchDeJwks())

    expect(id).toEqual({
      issuer: ISSUER_DO_GOOGLE,
      subject: '110000000000000000001',
      email: 'ana@exemplo.test',
      emailVerificado: true,
      nome: 'Ana',
    })
  })

  it('`aud` como array também vale', async () => {
    const id = await verificarIdToken(
      assinar(validas({ aud: ['outro', CLIENT_ID] })),
      CLIENT_ID,
      NONCE,
      fetchDeJwks(),
    )

    expect(id.subject).toBe('110000000000000000001')
  })
})

describe('os dois ataques clássicos contra verificador de JWT', () => {
  it('**`alg: none` é recusado**', async () => {
    // Um token sem assinatura que pede para não ser verificado. Ele é recusado
    // **pelo cabeçalho**, antes de qualquer criptografia: um verificador que só
    // descobre o algoritmo depois de tentar já perdeu.
    const c = Buffer.from(JSON.stringify({ alg: 'none', kid: KID })).toString('base64url')
    const p = Buffer.from(JSON.stringify(validas())).toString('base64url')

    await recusaPor(
      () => verificarIdToken(`${c}.${p}.`, CLIENT_ID, NONCE, fetchDeJwks()),
      /alg recusado: none/,
    )
  })

  it('**`HS256` assinado com a chave pública é recusado**', async () => {
    // O ataque de confusão de algoritmo: o atacante assina um HMAC usando a
    // chave *pública* do Google como segredo — e a chave pública é pública.
    // Se o verificador aceitasse "o algoritmo que o token declarar", qualquer
    // pessoa emitiria um token válido para qualquer conta.
    const publicaPem = par.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const cabecalho = Buffer.from(JSON.stringify({ alg: 'HS256', kid: KID })).toString('base64url')
    const corpo = Buffer.from(JSON.stringify(validas())).toString('base64url')
    const hmac = createHash('sha256').update(`${cabecalho}.${corpo}${publicaPem}`).digest('base64url')

    await recusaPor(
      () => verificarIdToken(`${cabecalho}.${corpo}.${hmac}`, CLIENT_ID, NONCE, fetchDeJwks()),
      /alg recusado: HS256/,
    )
  })
})

describe('as reivindicações', () => {
  it('**`iss` é conferido exatamente**', async () => {
    // Um `endsWith('google.com')` aceitaria
    // `accounts.google.com.atacante.net` — e o domínio é registrável.
    for (const iss of [
      'https://accounts.google.com.atacante.net',
      'https://accounts.google.com/',
      'http://accounts.google.com',
      'accounts.google.com',
    ]) {
      await recusaPor(() => verificarIdToken(assinar(validas({ iss })), CLIENT_ID, NONCE, fetchDeJwks()), /issuer/)
    }
  })

  it('**um token emitido para outro cliente é recusado**', async () => {
    // Ele é criptograficamente válido, assinado pelo Google, e não vale nada
    // para nós: qualquer aplicativo do mundo poderia mandar o token dele.
    await recusaPor(() => verificarIdToken(assinar(validas({ aud: 'outro-app.apps.googleusercontent.com' })), CLIENT_ID, NONCE, fetchDeJwks()), /audiência/)
  })

  it('token expirado é recusado, mesmo dentro da tolerância mais generosa', async () => {
    await recusaPor(() => verificarIdToken(assinar(validas({ exp: agora - 3600 })), CLIENT_ID, NONCE, fetchDeJwks()), /expirado/)
  })

  it('token do futuro é recusado', async () => {
    await recusaPor(() => verificarIdToken(assinar(validas({ iat: agora + 3600 })), CLIENT_ID, NONCE, fetchDeJwks()), /futuro/)
  })

  it('**o `nonce` de outra sessão é recusado**', async () => {
    // É o que amarra este token a esta tentativa. Sem ele, um `id_token`
    // capturado noutra sessão entraria.
    await recusaPor(() => verificarIdToken(assinar(validas({ nonce: 'b'.repeat(64) })), CLIENT_ID, NONCE, fetchDeJwks()), /nonce/)
  })

  it('token sem `nonce` é recusado', async () => {
    const { nonce: _, ...sem } = validas()
    await recusaPor(() => verificarIdToken(assinar(sem), CLIENT_ID, NONCE, fetchDeJwks()), /nonce/)
  })

  it('**`email_verified` ausente conta como falso**', async () => {
    // É o que faz o caso C2 da matriz tratar e-mail não verificado como e-mail
    // **ausente** — e não como suspeito.
    const { email_verified: _, ...sem } = validas()
    const id = await verificarIdToken(assinar(sem), CLIENT_ID, NONCE, fetchDeJwks())

    expect(id.emailVerificado).toBe(false)
  })

  it('`email_verified` como a string "true" não conta', async () => {
    const id = await verificarIdToken(
      assinar(validas({ email_verified: 'true' })),
      CLIENT_ID,
      NONCE,
      fetchDeJwks(),
    )

    expect(id.emailVerificado).toBe(false)
  })
})

describe('a assinatura', () => {
  it('**a chave errada não abre**', async () => {
    await recusaPor(() => verificarIdToken(
        assinar(validas(), { chave: outroPar.privateKey }),
        CLIENT_ID,
        NONCE,
        fetchDeJwks(),
      ), /assinatura/)
  })

  it('mexer numa reivindicação derruba a assinatura', async () => {
    const token = assinar(validas())
    const [c, , s] = token.split('.')
    const adulterado = Buffer.from(JSON.stringify(validas({ sub: 'outro' }))).toString('base64url')

    await recusaPor(() => verificarIdToken(`${c}.${adulterado}.${s}`, CLIENT_ID, NONCE, fetchDeJwks()), /assinatura/)
  })

  it('`kid` desconhecido é recusado', async () => {
    await recusaPor(() => verificarIdToken(assinar(validas(), { kid: 'inventado' }), CLIENT_ID, NONCE, fetchDeJwks()), /kid/)
  })

  it('**a rotação de chave é absorvida**', async () => {
    // O Google rotaciona. Um cache eterno quebraria no dia; um cache nenhum
    // daria uma ida à internet em cada login. O sintoma da rotação é um `kid`
    // que o cache não tem, e é ele que dispara a releitura.
    const antigo = fetchDeJwks(jwks(par.publicKey, 'antiga'))
    await expect(
      verificarIdToken(assinar(validas(), { kid: 'antiga' }), CLIENT_ID, NONCE, antigo),
    ).resolves.toBeTruthy()

    // Agora o Google só publica a chave nova, e o token vem assinado por ela.
    const novo = fetchDeJwks(jwks(outroPar.publicKey, 'nova'))
    const id = await verificarIdToken(
      assinar(validas(), { kid: 'nova', chave: outroPar.privateKey }),
      CLIENT_ID,
      NONCE,
      novo,
    )

    expect(id.subject).toBe('110000000000000000001')
  })
})

describe('entradas malformadas', () => {
  it('nenhuma delas escapa do erro tipado', async () => {
    const lixo = ['', 'a', 'a.b', 'a.b.c.d', '...', 'não.é.jwt', Buffer.alloc(300).toString('hex')]

    for (const token of lixo) {
      await expect(
        verificarIdToken(token, CLIENT_ID, NONCE, fetchDeJwks()),
      ).rejects.toThrow(EntradaFederadaInvalida)
    }
  })

  it('**a mensagem que o usuário lê nunca conta o motivo**', async () => {
    // O motivo é para o log do operador. Dizer "issuer inesperado" a quem
    // tentou entrar é ensinar a tentar de novo com o issuer certo.
    try {
      await verificarIdToken(assinar(validas({ iss: 'x' })), CLIENT_ID, NONCE, fetchDeJwks())
      expect.unreachable()
    } catch (erro) {
      expect((erro as Error).message).toBe('Não foi possível entrar com o Google.')
      expect((erro as EntradaFederadaInvalida).motivoInterno).toBe('issuer inesperado')
    }
  })
})

describe('PKCE', () => {
  it('**o desafio é o SHA-256 do verificador, e não o verificador**', () => {
    // `plain` mandaria o verificador na própria URL de autorização — que vai
    // para o histórico, para o `Referer` e para o log de qualquer proxy.
    const { verifier, challenge } = gerarPkce()

    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(challenge).not.toBe(verifier)
  })

  it('cada tentativa tem um verificador diferente', () => {
    const vistos = new Set(Array.from({ length: 50 }, () => gerarPkce().verifier))
    expect(vistos.size).toBe(50)
  })

  it('a URL de autorização exige S256 e pede o mínimo', () => {
    const url = new URL(
      urlDeAutorizacao(
        { clientId: CLIENT_ID, clientSecret: 's', redirectUri: 'https://mavia.test/entrar/google' },
        { state: 'e', nonce: 'n', challenge: 'd' },
      ),
    )

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('response_type')).toBe('code')
    // Cada escopo a mais é um dado a mais que passamos a receber, e a LGPD
    // chama isso de minimização.
    expect(url.searchParams.get('scope')).toBe('openid email profile')
    // O `client_secret` nunca vai na URL de autorização — ela é visível.
    expect(url.toString()).not.toContain('client_secret')
  })
})
