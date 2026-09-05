import { createHash, createPublicKey, createVerify, type JsonWebKey } from 'node:crypto'

/**
 * OpenID Connect com o Google — `spec-autenticacao.md` §1 e §2. Pendência P-4.
 *
 * **A verificação do `id_token` é feita aqui, à mão, e a razão é a mesma do
 * mensageiro:** o que este arquivo precisa fazer é pequeno e exato, e uma
 * biblioteca de JOSE traz um universo de algoritmos, formatos e modos que o
 * produto não usa — dentro do processo que tem a `DATABASE_URL`. A superfície
 * de um verificador que aceita um algoritmo é menor que a de um que aceita
 * quinze.
 *
 * ## O que é recusado antes de qualquer criptografia
 *
 * `alg: none` e `HS256` são recusados **pelo cabeçalho**, antes de a assinatura
 * ser sequer olhada. São os dois ataques clássicos contra verificador de JWT: o
 * primeiro pede para não verificar nada; o segundo pede para verificar um HMAC
 * usando a chave *pública* como segredo — e a chave pública é pública. Um
 * verificador que só descobre o algoritmo depois de tentar já perdeu.
 *
 * ## O que este arquivo nunca faz
 *
 * Não confia no `email` do token sem `email_verified`. Não aceita `iss`
 * parecido. Não pede a JWKS a cada login — e também não a guarda para sempre,
 * porque o Google rotaciona as chaves.
 */

export const ISSUER_DO_GOOGLE = 'https://accounts.google.com'
const AUTORIZACAO = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = 'https://oauth2.googleapis.com/token'
const JWKS = 'https://www.googleapis.com/oauth2/v3/certs'

/** Tolerância de relógio. O spec fixa "≤ 5 min", e este é o teto. */
const TOLERANCIA_S = 5 * 60

export class EntradaFederadaInvalida extends Error {
  constructor(readonly motivoInterno: string) {
    // A mensagem que o usuário lê é sempre a mesma. O motivo fica no campo, e
    // vai para o log do operador — nunca para a resposta.
    super('Não foi possível entrar com o Google.')
    this.name = 'EntradaFederadaInvalida'
  }
}

export interface ConfiguracaoDoGoogle {
  readonly clientId: string
  readonly clientSecret: string
  /** Precisa bater byte a byte com o registrado no console do Google. */
  readonly redirectUri: string
}

export function googleDoAmbiente(): ConfiguracaoDoGoogle | null {
  const clientId = process.env['GOOGLE_CLIENT_ID']
  const clientSecret = process.env['GOOGLE_CLIENT_SECRET']
  if (!clientId || !clientSecret) return null

  const base = process.env['MAVIA_URL_PUBLICA'] ?? 'http://127.0.0.1:4710'
  return {
    clientId,
    clientSecret,
    redirectUri: process.env['GOOGLE_REDIRECT_URI'] ?? `${base}/entrar/google`,
  }
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/**
 * O desafio PKCE de um verificador — **S256**, e nunca `plain`.
 *
 * `plain` manda o verificador na própria URL de autorização, que vai para o
 * histórico do navegador, para o `Referer` e para o log de qualquer proxy no
 * caminho. Com S256 o que trafega é o hash, e quem o intercepta não consegue
 * trocar o código por token.
 *
 * ## Por que não existe mais um `gerarPkce()`
 *
 * Existia, e devolvia o par `(verifier, challenge)` de uma vez. A forma era
 * inocente e o uso não: o controlador chamava `gerarPkce()`, mandava o
 * `challenge` ao Google e **descartava o `verifier`** — porque quem guardava um
 * verificador era outro módulo, que gerava o dele. Dois verificadores, e o
 * Google recusava toda troca com `Invalid code verifier`.
 *
 * Uma função que devolve duas coisas convida a usar uma e esquecer a outra.
 * Esta recebe o verificador que **já existe** e devolve o desafio dele, então
 * não há segundo verificador para esquecer. Ver `google-pkce.test.ts`.
 */
export function desafioDe(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest())
}

/**
 * A URL de autorização.
 *
 * **Recebe o `verifier`, não o `challenge`** — e é a trava que impede o defeito
 * acima de voltar. Enquanto o desafio era um parâmetro, era possível passar um
 * que não correspondia ao verificador guardado, e nada além do Google reclamava.
 * Calculando-o aqui dentro, a única forma de errar é guardar um verificador
 * diferente do que se passou, e é isso que o teste afirma.
 */
export function urlDeAutorizacao(
  cfg: ConfiguracaoDoGoogle,
  p: { state: string; nonce: string; verifier: string },
): string {
  const url = new URL(AUTORIZACAO)
  url.searchParams.set('client_id', cfg.clientId)
  url.searchParams.set('redirect_uri', cfg.redirectUri)
  url.searchParams.set('response_type', 'code')
  // `openid email profile` e nada mais. Cada escopo a mais é um dado a mais que
  // passamos a receber, e a LGPD chama isso de minimização.
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', p.state)
  url.searchParams.set('nonce', p.nonce)
  url.searchParams.set('code_challenge', desafioDe(p.verifier))
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

// ---------------------------------------------------------------------------
// A troca do código
// ---------------------------------------------------------------------------

export interface IdentidadeDoGoogle {
  readonly issuer: string
  readonly subject: string
  readonly email: string
  readonly emailVerificado: boolean
  readonly nome: string
}

/**
 * Troca o código pelo `id_token` e o verifica.
 *
 * O `access_token` do Google é **descartado** de propósito: a Mavia não chama
 * API nenhuma do Google, e guardar um token que não se usa é guardar um segredo
 * para vazar depois.
 */
export async function trocarCodigo(
  cfg: ConfiguracaoDoGoogle,
  codigo: string,
  verifier: string,
  nonceEsperado: string,
  buscar: typeof fetch = fetch,
): Promise<IdentidadeDoGoogle> {
  const corpo = new URLSearchParams({
    code: codigo,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  })

  const resposta = await buscar(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: corpo.toString(),
    signal: AbortSignal.timeout(10_000),
  })

  if (!resposta.ok) {
    // **O corpo entra na mensagem, e o corpo é seguro.**
    //
    // A versão anterior dizia só `troca recusada: 400` — que é a informação
    // inútil de um erro: diz que falhou e não diz nada sobre o quê. Um 400 do
    // Google pode ser `invalid_client` (segredo errado), `invalid_grant`
    // (código reusado, expirado, ou `code_verifier` que não bate) ou
    // `redirect_uri_mismatch`, e as três correções são diferentes. Sem o corpo,
    // a única saída é adivinhar em produção.
    //
    // A regra 20 proíbe PII e valor em log. Não há nem um nem outro aqui: a
    // resposta de erro do endpoint de token do Google é `{"error": "...",
    // "error_description": "..."}`, dois campos de diagnóstico. **O código e o
    // segredo não voltam na resposta** — só foram enviados —, então nada do que
    // se lê aqui é credencial.
    //
    // O corte em 300 é contra um corpo inesperado: um proxy no caminho pode
    // devolver uma página inteira de HTML, e ela não ajuda ninguém no log.
    const detalhe = await resposta.text().catch(() => '')
    throw new EntradaFederadaInvalida(
      `troca recusada: ${resposta.status} ${detalhe.slice(0, 300)}`,
    )
  }

  const dados = (await resposta.json()) as { id_token?: unknown }
  if (typeof dados.id_token !== 'string') throw new EntradaFederadaInvalida('sem id_token')

  return verificarIdToken(dados.id_token, cfg.clientId, nonceEsperado, buscar)
}

// ---------------------------------------------------------------------------
// A verificação
// ---------------------------------------------------------------------------

interface Cabecalho {
  readonly alg?: unknown
  readonly kid?: unknown
}

interface Reivindicacoes {
  readonly iss?: unknown
  readonly aud?: unknown
  readonly sub?: unknown
  readonly exp?: unknown
  readonly iat?: unknown
  readonly nonce?: unknown
  readonly email?: unknown
  readonly email_verified?: unknown
  readonly name?: unknown
}

export async function verificarIdToken(
  token: string,
  clientId: string,
  nonceEsperado: string,
  buscar: typeof fetch = fetch,
  agora: number = Math.floor(Date.now() / 1000),
): Promise<IdentidadeDoGoogle> {
  const partes = token.split('.')
  if (partes.length !== 3) throw new EntradaFederadaInvalida('token malformado')
  const [cabecalhoB64, corpoB64, assinaturaB64] = partes as [string, string, string]

  const cabecalho = ler<Cabecalho>(cabecalhoB64, 'cabeçalho')

  // **Antes da criptografia, e não durante.** `none` pede para não verificar;
  // `HS256` pede para verificar um HMAC com a chave pública como segredo — e a
  // chave pública é pública. Aceitar "o algoritmo que o token declarar" é o
  // defeito clássico de verificador de JWT.
  if (cabecalho.alg !== 'RS256') throw new EntradaFederadaInvalida(`alg recusado: ${String(cabecalho.alg)}`)
  if (typeof cabecalho.kid !== 'string') throw new EntradaFederadaInvalida('sem kid')

  const jwk = await chavePara(cabecalho.kid, buscar)
  const chave = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' })

  const verificador = createVerify('RSA-SHA256')
  verificador.update(`${cabecalhoB64}.${corpoB64}`)
  if (!verificador.verify(chave, Buffer.from(assinaturaB64, 'base64url'))) {
    throw new EntradaFederadaInvalida('assinatura inválida')
  }

  const c = ler<Reivindicacoes>(corpoB64, 'corpo')

  // `iss` **exatamente**. Um `endsWith('google.com')` aceitaria
  // `accounts.google.com.atacante.net`.
  if (c.iss !== ISSUER_DO_GOOGLE) throw new EntradaFederadaInvalida('issuer inesperado')

  // `aud` pode vir como string ou array. Um token emitido para **outro**
  // cliente é criptograficamente válido e não vale nada para nós.
  const audiencias = Array.isArray(c.aud) ? c.aud : [c.aud]
  if (!audiencias.includes(clientId)) throw new EntradaFederadaInvalida('audiência inesperada')

  if (typeof c.exp !== 'number' || c.exp + TOLERANCIA_S < agora) {
    throw new EntradaFederadaInvalida('token expirado')
  }
  if (typeof c.iat !== 'number' || c.iat - TOLERANCIA_S > agora) {
    throw new EntradaFederadaInvalida('token do futuro')
  }

  // O `nonce` é o que amarra **este** token a **esta** tentativa de login. Sem
  // ele, um `id_token` capturado de outra sessão seria aceito.
  if (typeof c.nonce !== 'string' || !iguais(c.nonce, nonceEsperado)) {
    throw new EntradaFederadaInvalida('nonce não confere')
  }

  if (typeof c.sub !== 'string' || c.sub === '') throw new EntradaFederadaInvalida('sem subject')

  return {
    issuer: ISSUER_DO_GOOGLE,
    subject: c.sub,
    email: typeof c.email === 'string' ? c.email : '',
    // Ausente conta como `false` — é o que a matriz de identidade assume, e é o
    // que faz o caso C2 tratar e-mail não verificado como e-mail **ausente**.
    emailVerificado: c.email_verified === true,
    nome: typeof c.name === 'string' && c.name.trim() !== '' ? c.name.trim() : 'Sem nome',
  }
}

// ---------------------------------------------------------------------------
// A JWKS
// ---------------------------------------------------------------------------

/**
 * O cache das chaves públicas.
 *
 * Buscar a cada login daria uma ida à internet no caminho quente e um ponto de
 * falha externo em cada entrada. Nunca buscar quebraria no dia da rotação — e o
 * Google rotaciona. O meio-termo: cache curto, e **uma releitura forçada quando
 * o `kid` não é conhecido**, que é exatamente o sintoma de uma rotação recente.
 */
const VIDA_DO_CACHE_MS = 60 * 60 * 1000

let cache: { chaves: Map<string, unknown>; em: number } | null = null

async function chavePara(kid: string, buscar: typeof fetch): Promise<unknown> {
  const vencido = !cache || Date.now() - cache.em > VIDA_DO_CACHE_MS

  if (!vencido && cache!.chaves.has(kid)) return cache!.chaves.get(kid)

  const chaves = await baixarJwks(buscar)
  cache = { chaves, em: Date.now() }

  const chave = chaves.get(kid)
  if (!chave) throw new EntradaFederadaInvalida('kid desconhecido')
  return chave
}

async function baixarJwks(buscar: typeof fetch): Promise<Map<string, unknown>> {
  const r = await buscar(JWKS, { signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new EntradaFederadaInvalida(`JWKS indisponível: ${r.status}`)

  const corpo = (await r.json()) as { keys?: unknown }
  if (!Array.isArray(corpo.keys)) throw new EntradaFederadaInvalida('JWKS em formato inesperado')

  const chaves = new Map<string, unknown>()
  for (const k of corpo.keys) {
    const jwk = k as { kid?: unknown; kty?: unknown; alg?: unknown }
    // Só RSA, e só o que a verificação usa. Uma chave EC no conjunto não é
    // problema; aceitá-la seria abrir um caminho que não existe hoje.
    if (typeof jwk.kid === 'string' && jwk.kty === 'RSA') chaves.set(jwk.kid, k)
  }
  return chaves
}

/** Só para os testes: a rotação de chave precisa de um cache limpo. */
export function esquecerJwks(): void {
  cache = null
}

// ---------------------------------------------------------------------------

function ler<T>(parte: string, o_que: string): T {
  try {
    return JSON.parse(Buffer.from(parte, 'base64url').toString('utf8')) as T
  } catch {
    throw new EntradaFederadaInvalida(`${o_que} ilegível`)
  }
}

function base64url(b: Buffer): string {
  return b.toString('base64url')
}

/** Comparação sem atalho de tempo. O `nonce` é um segredo desta tentativa. */
function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diferenca = 0
  for (let i = 0; i < a.length; i++) diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diferenca === 0
}
