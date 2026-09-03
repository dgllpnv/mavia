import type { FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import type { Autenticado } from '../autorizacao/autorizacao.guard.js'
import type { CofreDeAcesso } from '../redis/cofre-de-acesso.js'
import { resolverTenant } from '../tenancy/tenancy.js'

/**
 * Autenticação de requisição — a resolução em quatro etapas do
 * `docs/arquitetura/sistema.md` §3.9, achado A-03.
 *
 * É uma função nomeada, e não um middleware genérico, porque este é o ponto
 * cego canônico de um SaaS multi-tenant: o lugar onde se decide de qual
 * cliente é a requisição. Escondê-lo num middleware anônimo é como se ele não
 * precisasse de revisão.
 *
 * ## O token que ele aceita
 *
 * **Só o access token**, sempre em `Authorization: Bearer`, resolvido no Redis.
 * O refresh **não** autentica requisição: ele vale semanas, e uma credencial de
 * semanas aceita em toda rota é a mesma coisa que não ter expiração. O refresh
 * só é aceito nas rotas de sessão, que o consomem e o rotacionam.
 *
 * O cookie também deixou de autenticar por aqui pelo mesmo motivo: o que viaja
 * nele é o refresh.
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

function tokenDaRequisicao(req: FastifyRequest): string | null {
  const cabecalho = req.headers.authorization
  if (typeof cabecalho !== 'string') return null

  const [esquema, valor] = cabecalho.split(' ')
  if (esquema?.toLowerCase() !== 'bearer' || !valor) return null
  return valor
}

export function autenticadorDeSessao(pool: Pool, cofre: CofreDeAcesso): Autenticador {
  return async (req, opcoes) => {
    // Etapa 1 — quem é o usuário, a partir do access token. Uma ida ao Redis,
    // sem tocar no Postgres: o caminho quente de toda requisição.
    const token = tokenDaRequisicao(req)
    if (!token) return VAZIO

    const dono = await cofre.resolver(token)
    if (!dono) return VAZIO

    const ativa: SessaoAtiva = { sessaoId: dono.sessaoId, usuarioId: dono.usuarioId }
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

    const pertencimento = await resolverTenant(pool, dono.usuarioId, pedido)
    // Etapa 4 — se e somente se houver vínculo.
    if (!pertencimento) throw new TenantNaoPertence()

    return {
      sessao: ativa,
      autenticado: {
        usuarioId: dono.usuarioId,
        tenantId: pertencimento.tenantId,
        papel: pertencimento.papel,
      },
    }
  }
}

const VAZIO: ResultadoDaAutenticacao = { sessao: null, autenticado: null }
