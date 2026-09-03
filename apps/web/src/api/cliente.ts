import type {
  Categoria,
  Conta,
  Fatura,
  Lancamento,
  PlanejamentosDoMes,
  Resumo,
} from '@mavia/contracts'

/**
 * O cliente da API — o único lugar do web que sabe falar HTTP.
 *
 * Três coisas ele carrega sempre, e nenhuma tela precisa lembrar:
 *
 * 1. o **access token**, em `Authorization`. Ele vive numa variável de módulo,
 *    dura quinze minutos e some ao recarregar a página;
 * 2. `credentials: 'same-origin'`, para o cookie `HttpOnly` do **refresh**
 *    viajar nas rotas de sessão. Esse cookie nunca passa pelo JavaScript;
 * 3. `X-Mavia-Tenant`, **explícito**. A API responde 400 quando ele falta,
 *    inclusive para quem tem um espaço só (decisão D9): escolha implícita fica
 *    errada no dia em que a pessoa aceita um segundo convite, e nesse dia
 *    ninguém lembra de procurar aqui.
 *
 * A URL é relativa. O `rewrite` do Next põe a API na mesma origem, o que evita
 * CORS e mantém a topologia local igual à de produção.
 *
 * ## Por que o access token mora em memória
 *
 * `localStorage` sobrevive à aba, ao reinício do navegador e a qualquer script
 * que a página venha a carregar. Uma variável de módulo morre com a página.
 * Um XSS continua roubando quinze minutos — não semanas —, e o refresh, que é
 * o que vale semanas, ele não alcança: está num cookie `HttpOnly`.
 */

/**
 * O access token corrente. Deliberadamente **não** persistido.
 *
 * Ao recarregar a página ele some, e a primeira chamada renova pelo cookie —
 * um ida e volta a mais no carregamento, em troca de a credencial não existir
 * em nenhum lugar que sobreviva à aba.
 */
let acesso: string | null = null

/**
 * A renovação em curso, quando há uma.
 *
 * Sem isto, dez consultas do TanStack Query recebendo 401 ao mesmo tempo
 * disparariam dez rotações concorrentes — e a rotação é destrutiva: a segunda
 * apresentaria um refresh que a primeira acabou de consumir, o que o servidor
 * lê, corretamente, como **reuso**. O usuário seria deslogado por segurança
 * por ter aberto o app com o token vencido.
 */
let renovacaoEmCurso: Promise<boolean> | null = null

export function guardarAcesso(token: string | null): void {
  acesso = token
}

/**
 * Renova o access token pelo cookie de refresh. Devolve se conseguiu.
 *
 * Uma renovação por vez, compartilhada por todos os chamadores.
 */
export async function renovarAcesso(): Promise<boolean> {
  renovacaoEmCurso ??= (async () => {
    try {
      const r = await fetch('/api/v1/sessoes/renovar', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-mavia-client': 'web' },
      })
      if (!r.ok) {
        acesso = null
        return false
      }
      const dados = (await r.json()) as { acesso?: string }
      acesso = dados.acesso ?? null
      return acesso !== null
    } catch {
      acesso = null
      return false
    } finally {
      renovacaoEmCurso = null
    }
  })()

  return renovacaoEmCurso
}

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
  let r = await enviar(caminho, opcoes)

  /**
   * 401 numa rota autenticada é a coisa mais comum do mundo neste desenho: o
   * access dura quinze minutos. Renovar e repetir **uma** vez é o caminho
   * normal, não o de exceção.
   *
   * Uma repetição só, e nunca em `/sessoes`: repetir um login recusado
   * multiplicaria as tentativas contra o limite do servidor, e o usuário
   * levaria um 429 por ter errado a senha uma vez.
   */
  if (r.status === 401 && !caminho.startsWith('/sessoes')) {
    if (await renovarAcesso()) r = await enviar(caminho, opcoes)
  }

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

function enviar(caminho: string, opcoes: Opcoes): Promise<Response> {
  const cabecalhos: Record<string, string> = {}
  if (opcoes.corpo !== undefined) cabecalhos['content-type'] = 'application/json'
  if (opcoes.tenantId) cabecalhos['x-mavia-tenant'] = opcoes.tenantId
  if (acesso) cabecalhos['authorization'] = `Bearer ${acesso}`

  return fetch(`/api/v1${caminho}`, {
    method: opcoes.metodo ?? 'GET',
    headers: cabecalhos,
    credentials: 'same-origin',
    ...(opcoes.corpo !== undefined ? { body: JSON.stringify(opcoes.corpo) } : {}),
  })
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
  async entrar(email: string, senha: string): Promise<Eu> {
    const r = await chamar<Eu & { acesso: string }>('/sessoes', {
      metodo: 'POST',
      // `web` e não `mobile`: é o que faz a API mandar o **refresh** em cookie
      // `HttpOnly` em vez de no corpo. O access vem no corpo nas duas.
      corpo: { email, senha, plataforma: 'web' },
    })
    guardarAcesso(r.acesso)
    return r
  },

  /**
   * As quatro rotas de credencial. Nenhuma delas exige sessão — quem cadastra
   * não tem conta, e quem recupera não tem senha.
   *
   * `cadastrar` e `recuperar` devolvem **a mesma coisa** tenha o endereço uma
   * conta ou não. A interface repete essa frase e não tenta ser mais útil: ser
   * mais útil aqui é enumerar a base de clientes.
   */
  cadastrar: (dados: { email: string; nome: string; senha: string; espaco?: string }) =>
    chamar<{ mensagem: string }>('/cadastro', { metodo: 'POST', corpo: dados }),

  /**
   * O nome do espaço **não** viaja aqui: ele foi guardado junto do cadastro
   * pendente. Quem abre o link vem de um e-mail, possivelmente noutro aparelho,
   * e não tem como saber o que foi digitado no formulário.
   */
  async confirmarCadastro(token: string): Promise<Eu> {
    const r = await chamar<Eu & { acesso: string }>('/cadastro/confirmar', {
      metodo: 'POST',
      corpo: { token, plataforma: 'web' },
    })
    guardarAcesso(r.acesso)
    return r
  },

  recuperarSenha: (email: string) =>
    chamar<{ mensagem: string }>('/senha/recuperar', { metodo: 'POST', corpo: { email } }),

  redefinirSenha: (token: string, senha: string) =>
    chamar<{ sessoesEncerradas: number }>('/senha/redefinir', {
      metodo: 'POST',
      corpo: { token, senha },
    }),

  /**
   * Quem sou eu — e, no primeiro carregamento da página, também o gatilho da
   * renovação: sem access em memória, `chamar` leva 401, renova pelo cookie e
   * repete. É por isso que esta rota é a primeira que a aplicação faz.
   */
  eu: () => chamar<Eu>('/eu'),

  async sair(): Promise<void> {
    await chamar<void>('/sessoes/atual', { metodo: 'DELETE' })
    guardarAcesso(null)
  },

  contas: (tenantId: string) => chamar<{ itens: Conta[] }>('/contas', { tenantId }),

  /**
   * A árvore inteira, numa chamada. Ela é pequena e muda raramente; uma
   * consulta por linha do extrato daria 16 requisições para 15 lançamentos.
   */
  categorias: (tenantId: string) => chamar<{ itens: Categoria[] }>('/categorias', { tenantId }),

  /**
   * Os planejamentos de um mês, com o **realizado já apurado**.
   *
   * A apuração é do servidor: a regra de escopo (raiz agrega filhas, global
   * agrega tudo) e a de natureza (por `Categoria.natureza`, nunca pelo sinal do
   * lançamento) são sutis o bastante para que web e mobile divergissem ao
   * reimplementá-las.
   */
  planejamentos: (tenantId: string, competencia: string) =>
    chamar<PlanejamentosDoMes>(`/planejamentos?competencia=${competencia}`, { tenantId }),

  cartoes: (tenantId: string) =>
    chamar<{ itens: { id: string; nome: string; limiteCentavos: string; closingDay: number; dueDay: number }[] }>(
      '/cartoes',
      { tenantId },
    ),

  faturas: (tenantId: string, cartaoId: string) =>
    chamar<{ itens: Fatura[] }>(`/cartoes/${cartaoId}/faturas`, { tenantId }),

  /**
   * Os lançamentos de uma fatura, sem janela de tempo.
   *
   * A fatura **é** a janela. Um parcelamento põe na fatura de dezembro uma
   * parcela com `posted_at` de maio, e filtrar por período aqui esconderia
   * justamente as parcelas que compõem o total.
   */
  lancamentosDaFatura: (tenantId: string, faturaId: string) =>
    chamar<{ itens: Lancamento[] }>(`/lancamentos?faturaId=${faturaId}`, { tenantId }),

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
