import type { Categoria, Conta, Fatura, Lancamento, Resumo } from '@mavia/contracts'

/**
 * O cliente da API — o único lugar do web que sabe falar HTTP.
 *
 * Duas coisas ele carrega sempre, e nenhuma tela precisa lembrar:
 *
 * 1. `credentials: 'same-origin'`, para o cookie `HttpOnly` da sessão viajar.
 *    O token nunca passa pelo JavaScript — nem aqui.
 * 2. `X-Mavia-Tenant`, **explícito**. A API responde 400 quando ele falta,
 *    inclusive para quem tem um espaço só (decisão D9): escolha implícita fica
 *    errada no dia em que a pessoa aceita um segundo convite, e nesse dia
 *    ninguém lembra de procurar aqui.
 *
 * A URL é relativa. O `rewrite` do Next põe a API na mesma origem, o que evita
 * CORS e mantém a topologia local igual à de produção.
 */

export class ErroDaApi extends Error {
  constructor(
    readonly status: number,
    mensagem: string,
  ) {
    super(mensagem)
    this.name = 'ErroDaApi'
  }
}

/** Sessão ausente ou expirada. A interface reage levando para a entrada. */
export class SemSessao extends ErroDaApi {
  constructor() {
    super(401, 'Sua sessão expirou. Entre de novo.')
    this.name = 'SemSessao'
  }
}

interface Opcoes {
  readonly metodo?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  readonly corpo?: unknown
  readonly tenantId?: string
}

export async function chamar<T>(caminho: string, opcoes: Opcoes = {}): Promise<T> {
  const cabecalhos: Record<string, string> = {}
  if (opcoes.corpo !== undefined) cabecalhos['content-type'] = 'application/json'
  if (opcoes.tenantId) cabecalhos['x-mavia-tenant'] = opcoes.tenantId

  const r = await fetch(`/api/v1${caminho}`, {
    method: opcoes.metodo ?? 'GET',
    headers: cabecalhos,
    credentials: 'same-origin',
    ...(opcoes.corpo !== undefined ? { body: JSON.stringify(opcoes.corpo) } : {}),
  })

  if (r.status === 204) return undefined as T

  const texto = await r.text()
  const dados: unknown = texto ? JSON.parse(texto) : null

  /**
   * 401 significa duas coisas diferentes, e confundi-las mostra a frase errada
   * na hora errada.
   *
   * Numa rota autenticada é "sua sessão acabou", e a interface leva para a
   * entrada. Em `POST /sessoes` é "esta credencial não serve" — e mostrar
   * "sua sessão expirou" a quem está justamente tentando entrar é dizer que o
   * problema é outro. A mensagem do servidor é uma só, de propósito; o que
   * varia é qual das duas situações estamos tratando.
   */
  if (r.status === 401) {
    if (caminho === '/sessoes' && opcoes.metodo === 'POST') {
      throw new ErroDaApi(401, mensagemDoErro(dados) ?? 'E-mail ou senha inválidos.')
    }
    throw new SemSessao()
  }

  if (!r.ok) {
    throw new ErroDaApi(r.status, mensagemDoErro(dados) ?? 'Não foi possível concluir.')
  }
  return dados as T
}

/**
 * O Nest devolve `message` como string ou como lista de strings, dependendo de
 * quantas validações falharam. Tratar só um dos dois faz metade dos erros de
 * formulário virar "Não foi possível concluir" — que não ajuda ninguém.
 */
function mensagemDoErro(dados: unknown): string | null {
  if (typeof dados !== 'object' || dados === null) return null
  const m = (dados as { message?: unknown }).message
  if (typeof m === 'string') return m
  if (Array.isArray(m)) return m.filter((i) => typeof i === 'string').join(' ')
  return null
}

// ---------------------------------------------------------------------------
// As chamadas, nomeadas
// ---------------------------------------------------------------------------

export interface Espaco {
  readonly id: string
  readonly nome: string
  readonly papel: 'proprietario' | 'membro' | 'visualizador'
}

export interface Eu {
  readonly usuario: { readonly id: string; readonly nome: string; readonly email: string }
  readonly tenants: readonly Espaco[]
}

export const api = {
  entrar: (email: string, senha: string) =>
    chamar<Eu>('/sessoes', {
      metodo: 'POST',
      // `web` e não `mobile`: é o que faz a API devolver o token em cookie
      // `HttpOnly` em vez de no corpo.
      corpo: { email, senha, plataforma: 'web' },
    }),

  eu: () => chamar<Eu>('/eu'),

  sair: () => chamar<void>('/sessoes/atual', { metodo: 'DELETE' }),

  contas: (tenantId: string) => chamar<{ itens: Conta[] }>('/contas', { tenantId }),

  /**
   * A árvore inteira, numa chamada. Ela é pequena e muda raramente; uma
   * consulta por linha do extrato daria 16 requisições para 15 lançamentos.
   */
  categorias: (tenantId: string) => chamar<{ itens: Categoria[] }>('/categorias', { tenantId }),

  cartoes: (tenantId: string) =>
    chamar<{ itens: { id: string; nome: string; limiteCentavos: string; closingDay: number; dueDay: number }[] }>(
      '/cartoes',
      { tenantId },
    ),

  faturas: (tenantId: string, cartaoId: string) =>
    chamar<{ itens: Fatura[] }>(`/cartoes/${cartaoId}/faturas`, { tenantId }),

  lancamentos: (tenantId: string, janela: Janela) =>
    chamar<{ itens: Lancamento[] }>(
      `/lancamentos?de=${encodeURIComponent(janela.de)}&ate=${encodeURIComponent(janela.ate)}`,
      { tenantId },
    ),

  /**
   * O eixo é **obrigatório e explícito** em toda chamada de resumo.
   *
   * A API recusa a omissão de propósito: `realizado` não significa a mesma
   * coisa nos dois eixos, e um padrão silencioso aqui seria o caminho de volta
   * para o defeito RP-4, agora escondido no cliente.
   */
  resumo: (
    tenantId: string,
    janela: Janela,
    eixo: 'caixa' | 'competencia',
    /** Recorta numa conta só. Ausente, soma o espaço inteiro. */
    contaId?: string,
  ) => {
    const busca = new URLSearchParams({ de: janela.de, ate: janela.ate, eixo })
    if (contaId) busca.set('contaId', contaId)
    return chamar<Resumo>(`/lancamentos/resumo?${busca.toString()}`, { tenantId })
  },
}

export interface Janela {
  /** Instante ISO. A janela é semiaberta: `[de, ate)`. */
  readonly de: string
  readonly ate: string
}
