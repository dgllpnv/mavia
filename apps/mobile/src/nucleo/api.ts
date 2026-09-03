import * as SecureStore from 'expo-secure-store'

/**
 * O cliente HTTP do app.
 *
 * A diferença para o web é onde mora o refresh: aqui não há cookie jar, e ele
 * vai para o **Keychain (iOS) / Keystore (Android)** pelo `expo-secure-store` —
 * armazenamento respaldado por hardware, e não um arquivo do app.
 *
 * O access continua em memória, pelo mesmo motivo do web: ele dura quinze
 * minutos, e nada que dure quinze minutos precisa sobreviver ao processo.
 */

const CHAVE_DO_REFRESH = 'mavia.refresh'

let acesso: string | null = null
let renovacaoEmCurso: Promise<boolean> | null = null

/**
 * A URL da API.
 *
 * Sem valor embutido em produção: o binário da loja aponta para o domínio da
 * Mavia, e o de desenvolvimento para a máquina de quem está desenvolvendo. Um
 * `localhost` embutido no bundle é o tipo de coisa que vaza para a loja.
 */
export const BASE = process.env['EXPO_PUBLIC_API'] ?? 'http://127.0.0.1:4711/v1'

export class ErroDaApi extends Error {
  constructor(
    readonly status: number,
    mensagem: string,
  ) {
    super(mensagem)
    this.name = 'ErroDaApi'
  }
}

export async function guardarRefresh(token: string): Promise<void> {
  await SecureStore.setItemAsync(CHAVE_DO_REFRESH, token, {
    // Exige o dispositivo desbloqueado para ler. Um refresh legível com o
    // aparelho trancado anula o desbloqueio.
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  })
}

export async function esquecerRefresh(): Promise<void> {
  await SecureStore.deleteItemAsync(CHAVE_DO_REFRESH)
  acesso = null
}

export async function temSessaoGuardada(): Promise<boolean> {
  return (await SecureStore.getItemAsync(CHAVE_DO_REFRESH)) !== null
}

/**
 * Renova o access pelo refresh guardado. Uma renovação por vez.
 *
 * Sem a serialização, várias telas recebendo 401 ao mesmo tempo dispararíam
 * várias rotações concorrentes — e a rotação é destrutiva: a segunda
 * apresentaria um refresh que a primeira acabou de consumir, o que o servidor
 * lê, corretamente, como **reuso**, e a pessoa seria desconectada por segurança
 * por ter aberto o app com o token vencido.
 */
export async function renovar(): Promise<boolean> {
  renovacaoEmCurso ??= (async () => {
    try {
      const refresh = await SecureStore.getItemAsync(CHAVE_DO_REFRESH)
      if (!refresh) return false

      const r = await fetch(`${BASE}/sessoes/renovar`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mavia-client': 'mobile' },
        body: JSON.stringify({ refresh }),
      })

      if (!r.ok) {
        // 401 aqui é definitivo: o refresh não vale mais, e insistir só
        // dispararia a detecção de reuso.
        await esquecerRefresh()
        return false
      }

      const dados = (await r.json()) as { acesso: string; refresh: string }
      acesso = dados.acesso
      await guardarRefresh(dados.refresh)
      return true
    } catch {
      // Falha de rede não invalida o refresh: o app continua offline com o que
      // tem, e tenta de novo depois.
      return false
    } finally {
      renovacaoEmCurso = null
    }
  })()

  return renovacaoEmCurso
}

export interface Opcoes {
  readonly metodo?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  readonly corpo?: unknown
  readonly tenantId?: string
  /** `Idempotency-Key`. Vem da fila, e é a identidade da intenção. */
  readonly chave?: string
}

/**
 * Uma chamada, com renovação e uma repetição.
 *
 * Devolve a `Response` crua para que a fila possa distinguir "sem rede" de
 * "4xx" — a distinção que decide entre tentar de novo e pedir atenção.
 */
export async function enviar(caminho: string, opcoes: Opcoes = {}): Promise<Response> {
  const cabecalhos: Record<string, string> = { 'x-mavia-client': 'mobile' }
  if (opcoes.corpo !== undefined) cabecalhos['content-type'] = 'application/json'
  if (opcoes.tenantId) cabecalhos['x-mavia-tenant'] = opcoes.tenantId
  if (opcoes.chave) cabecalhos['idempotency-key'] = opcoes.chave
  if (acesso) cabecalhos['authorization'] = `Bearer ${acesso}`

  const requisicao = (): Promise<Response> =>
    fetch(`${BASE}${caminho}`, {
      method: opcoes.metodo ?? 'GET',
      headers: { ...cabecalhos, ...(acesso ? { authorization: `Bearer ${acesso}` } : {}) },
      ...(opcoes.corpo !== undefined ? { body: JSON.stringify(opcoes.corpo) } : {}),
    })

  let r = await requisicao()
  if (r.status === 401 && !caminho.startsWith('/sessoes')) {
    if (await renovar()) r = await requisicao()
  }
  return r
}

/** A mesma chamada, já convertida — para leitura, onde o erro é exceção. */
export async function chamar<T>(caminho: string, opcoes: Opcoes = {}): Promise<T> {
  const r = await enviar(caminho, opcoes)
  if (r.status === 204) return undefined as T

  const texto = await r.text()
  const dados: unknown = texto ? (JSON.parse(texto) as unknown) : null

  if (!r.ok) {
    const m = (dados as { message?: unknown } | null)?.message
    throw new ErroDaApi(
      r.status,
      typeof m === 'string' ? m : Array.isArray(m) ? m.join(' ') : 'Não foi possível concluir.',
    )
  }
  return dados as T
}

export interface Eu {
  readonly usuario: { readonly id: string; readonly nome: string; readonly email: string }
  readonly tenants: readonly { readonly id: string; readonly nome: string; readonly papel: string }[]
}

export async function entrar(email: string, senha: string): Promise<Eu> {
  const r = await fetch(`${BASE}/sessoes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mavia-client': 'mobile' },
    body: JSON.stringify({ email, senha, plataforma: 'mobile' }),
  })

  const dados = (await r.json()) as {
    acesso?: string
    refresh?: string
    message?: string
  } & Eu

  if (!r.ok || !dados.acesso || !dados.refresh) {
    throw new ErroDaApi(r.status, dados.message ?? 'E-mail ou senha inválidos.')
  }

  acesso = dados.acesso
  await guardarRefresh(dados.refresh)
  return dados
}

export async function sair(): Promise<void> {
  try {
    await enviar('/sessoes/atual', { metodo: 'DELETE' })
  } finally {
    // O local é limpo mesmo se o servidor não respondeu: quem tocou em "sair"
    // não pode continuar com sessão no aparelho porque a rede caiu.
    await esquecerRefresh()
  }
}
