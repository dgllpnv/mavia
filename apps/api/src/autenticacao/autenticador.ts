import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import type { Autenticado } from '../autorizacao/autorizacao.guard.js'
import { comUsuario, resolverTenant } from '../tenancy/tenancy.js'
import { tokenDoCookie } from './cookie.js'

/**
 * Autenticação de requisição — a resolução em quatro etapas do
 * `docs/arquitetura/sistema.md` §3.9, achado A-03.
 *
 * É uma função nomeada, e não um middleware genérico, porque este é o ponto
 * cego canônico de um SaaS multi-tenant: o lugar onde se decide de qual
 * cliente é a requisição. Escondê-lo num middleware anônimo é como se ele não
 * precisasse de revisão.
 */

/**
 * A sessão, **sem** espaço escolhido.
 *
 * Existe separada de `Autenticado` porque há rotas legítimas que não têm
 * espaço: `GET /v1/eu` é justamente a pergunta "quais espaços eu tenho", e
 * exigir a resposta como cabeçalho da pergunta seria circular.
 */
export interface SessaoAtiva {
  readonly sessaoId: string
  readonly usuarioId: string
}

export interface ResultadoDaAutenticacao {
  readonly sessao: SessaoAtiva | null
  /** Preenchido só quando a rota pede espaço e o vínculo existe. */
  readonly autenticado: Autenticado | null
}

export type Autenticador = (
  req: FastifyRequest,
  opcoes: { readonly exigeTenant: boolean },
) => Promise<ResultadoDaAutenticacao>

declare module 'fastify' {
  interface FastifyRequest {
    sessao?: SessaoAtiva
  }
}

export class TenantNaoInformado extends Error {
  constructor() {
    super('Informe o espaço em X-Mavia-Tenant.')
    this.name = 'TenantNaoInformado'
  }
}

export class TenantNaoPertence extends Error {
  constructor() {
    super('Você não tem acesso a este espaço.')
    this.name = 'TenantNaoPertence'
  }
}

/** O token viaja em claro; no banco vive só o hash. */
function hashDoToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

/**
 * O token, do cabeçalho ou do cookie.
 *
 * `Authorization` primeiro porque é o caminho do mobile, que não tem cookie
 * jar. No web o token viaja em cookie `HttpOnly` e nunca passa pelo JavaScript
 * da página — é a diferença entre um XSS que rouba a sessão e um que não.
 */
function tokenDaRequisicao(req: FastifyRequest): string | null {
  const cabecalho = req.headers.authorization
  if (typeof cabecalho === 'string') {
    const [esquema, valor] = cabecalho.split(' ')
    if (esquema?.toLowerCase() === 'bearer' && valor) return valor
  }
  return tokenDoCookie(req.headers.cookie)
}

export function autenticadorDeSessao(pool: Pool): Autenticador {
  return async (req, opcoes) => {
    // Etapa 1 — quem é o usuário, a partir do token.
    const token = tokenDaRequisicao(req)
    if (!token) return VAZIO

    const sessao = await comUsuario(pool, { usuarioId: SEM_USUARIO }, async (cliente) => {
      const r = await cliente.query<{
        sessao_id: string
        usuario_id: string
        expira_em: Date
        expira_absoluto_em: Date
        revogada_em: Date | null
      }>('SELECT * FROM auth.resolver_sessao($1)', [hashDoToken(token)])
      return r.rows[0] ?? null
    })

    if (!sessao || sessao.revogada_em !== null) return VAZIO

    const agora = Date.now()
    if (sessao.expira_em.getTime() <= agora) return VAZIO
    // Teto absoluto: uma sessão renovada indefinidamente é uma sessão eterna.
    if (sessao.expira_absoluto_em.getTime() <= agora) return VAZIO

    const ativa: SessaoAtiva = { sessaoId: sessao.sessao_id, usuarioId: sessao.usuario_id }
    // Rota sem espaço para em quem é o usuário. Ir adiante exigiria o
    // cabeçalho de tenant em `GET /v1/eu`, que é a rota que existe para
    // descobrir quais tenants pedir.
    if (!opcoes.exigeTenant) return { sessao: ativa, autenticado: null }

    // Etapa 2 e 3 — o tenant é pedido explicitamente, e o pertencimento é
    // consultado sob a policy de `app.usuario_id`, antes de `app.tenant_id`
    // existir.
    const pedido = req.headers['x-mavia-tenant']
    if (typeof pedido !== 'string' || pedido === '') {
      // 400 mesmo com um tenant só. A escolha implícita do primeiro fica
      // errada no dia em que a pessoa aceita um segundo convite — e nesse dia
      // ninguém lembra de procurar aqui.
      throw new TenantNaoInformado()
    }

    const pertencimento = await resolverTenant(pool, sessao.usuario_id, pedido)
    // Etapa 4 — se e somente se houver vínculo.
    if (!pertencimento) throw new TenantNaoPertence()

    return {
      sessao: ativa,
      autenticado: {
        usuarioId: sessao.usuario_id,
        tenantId: pertencimento.tenantId,
        papel: pertencimento.papel,
      },
    }
  }
}

const VAZIO: ResultadoDaAutenticacao = { sessao: null, autenticado: null }

/**
 * A resolução de sessão precisa de uma transação, mas ainda não sabemos quem é
 * o usuário — é justamente o que estamos descobrindo. A função de resolução é
 * `SECURITY DEFINER` e não depende do contexto; este UUID nulo existe só para
 * satisfazer a assinatura da unidade de trabalho sem inventar um usuário.
 */
const SEM_USUARIO = '00000000-0000-0000-0000-000000000000'
