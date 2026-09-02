import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import type { Autenticado } from '../autorizacao/autorizacao.guard.js'
import { comUsuario, resolverTenant } from '../tenancy/tenancy.js'

/**
 * Autenticação de requisição — a resolução em quatro etapas do
 * `docs/arquitetura/sistema.md` §3.9, achado A-03.
 *
 * É uma função nomeada, e não um middleware genérico, porque este é o ponto
 * cego canônico de um SaaS multi-tenant: o lugar onde se decide de qual
 * cliente é a requisição. Escondê-lo num middleware anônimo é como se ele não
 * precisasse de revisão.
 */

export type Autenticador = (req: FastifyRequest) => Promise<Autenticado | null>

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

function tokenDoCabecalho(req: FastifyRequest): string | null {
  const cabecalho = req.headers.authorization
  if (typeof cabecalho !== 'string') return null
  const [esquema, valor] = cabecalho.split(' ')
  if (esquema?.toLowerCase() !== 'bearer' || !valor) return null
  return valor
}

export function autenticadorDeSessao(pool: Pool): Autenticador {
  return async (req) => {
    // Etapa 1 — quem é o usuário, a partir do token.
    const token = tokenDoCabecalho(req)
    if (!token) return null

    const sessao = await comUsuario(pool, { usuarioId: SEM_USUARIO }, async (cliente) => {
      const r = await cliente.query<{
        usuario_id: string
        expira_em: Date
        expira_absoluto_em: Date
        revogada_em: Date | null
      }>('SELECT * FROM auth.resolver_sessao($1)', [hashDoToken(token)])
      return r.rows[0] ?? null
    })

    if (!sessao || sessao.revogada_em !== null) return null

    const agora = Date.now()
    if (sessao.expira_em.getTime() <= agora) return null
    // Teto absoluto: uma sessão renovada indefinidamente é uma sessão eterna.
    if (sessao.expira_absoluto_em.getTime() <= agora) return null

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
      usuarioId: sessao.usuario_id,
      tenantId: pertencimento.tenantId,
      papel: pertencimento.papel,
    }
  }
}

/**
 * A resolução de sessão precisa de uma transação, mas ainda não sabemos quem é
 * o usuário — é justamente o que estamos descobrindo. A função de resolução é
 * `SECURITY DEFINER` e não depende do contexto; este UUID nulo existe só para
 * satisfazer a assinatura da unidade de trabalho sem inventar um usuário.
 */
const SEM_USUARIO = '00000000-0000-0000-0000-000000000000'
