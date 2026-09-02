import type { Pool, PoolClient } from 'pg'

/**
 * Tenancy — o ponto de entrada único para tocar o banco.
 *
 * `docs/arquitetura/sistema.md` §3.9: `app.usuario_id` e `app.tenant_id` são
 * definidos **juntos**, por `SET LOCAL`, aqui e em nenhum outro lugar. A
 * unidade de trabalho **falha** se o contexto exigido estiver ausente — e falha
 * antes de tocar o banco, com uma mensagem que diz o que faltou.
 *
 * O teste da deleção: apagar este módulo obrigaria todo módulo da API a
 * configurar o contexto por conta própria, e o primeiro que esquecesse abriria
 * um vazamento silencioso. É a alavancagem máxima do sistema.
 */

export interface ContextoDoTenant {
  readonly usuarioId: string
  readonly tenantId: string
}

/** Contexto de quem está autenticado mas ainda não escolheu tenant (etapa 2). */
export interface ContextoDeUsuario {
  readonly usuarioId: string
}

export class ContextoAusente extends Error {
  constructor(oQueFaltou: string) {
    super(
      `Unidade de trabalho aberta sem ${oQueFaltou}. ` +
        'Toda consulta precisa de contexto — sem ele a RLS esconde tudo e o ' +
        'sintoma vira "sumiram meus dados" em vez de um erro claro.',
    )
    this.name = 'ContextoAusente'
  }
}

async function emTransacao<T>(
  pool: Pool,
  papel: string,
  configurar: (cliente: PoolClient) => Promise<void>,
  trabalho: (cliente: PoolClient) => Promise<T>,
): Promise<T> {
  const cliente = await pool.connect()
  try {
    await cliente.query('BEGIN')
    // `SET LOCAL`, nunca `SET`: o valor morre no fim da transação. Numa
    // conexão de pool, `SET` vazaria o contexto de um cliente para o próximo.
    await cliente.query(`SET LOCAL ROLE ${papel}`)
    await configurar(cliente)
    const resultado = await trabalho(cliente)
    await cliente.query('COMMIT')
    return resultado
  } catch (erro) {
    await cliente.query('ROLLBACK')
    throw erro
  } finally {
    cliente.release()
  }
}

/**
 * Unidade de trabalho com tenant resolvido. É o caminho de 99% das rotas.
 */
export async function comTenant<T>(
  pool: Pool,
  contexto: ContextoDoTenant,
  trabalho: (cliente: PoolClient) => Promise<T>,
): Promise<T> {
  if (!contexto.usuarioId) throw new ContextoAusente('app.usuario_id')
  if (!contexto.tenantId) throw new ContextoAusente('app.tenant_id')

  return emTransacao(
    pool,
    'mavia_app',
    async (cliente) => {
      await cliente.query('SELECT set_config($1, $2, true)', [
        'app.usuario_id',
        contexto.usuarioId,
      ])
      await cliente.query('SELECT set_config($1, $2, true)', ['app.tenant_id', contexto.tenantId])
    },
    trabalho,
  )
}

/**
 * Unidade de trabalho **sem** tenant — a etapa 2 da resolução em quatro etapas.
 *
 * Existe só para consultar o pertencimento do usuário antes de saber qual
 * tenant é o dele. Nenhuma rota de recurso usa isto: uma consulta de negócio
 * aberta assim enxergaria zero linhas, e o sintoma seria "sumiram meus dados".
 */
export async function comUsuario<T>(
  pool: Pool,
  contexto: ContextoDeUsuario,
  trabalho: (cliente: PoolClient) => Promise<T>,
): Promise<T> {
  if (!contexto.usuarioId) throw new ContextoAusente('app.usuario_id')

  return emTransacao(
    pool,
    'mavia_app',
    async (cliente) => {
      await cliente.query('SELECT set_config($1, $2, true)', [
        'app.usuario_id',
        contexto.usuarioId,
      ])
    },
    trabalho,
  )
}

export interface Pertencimento {
  readonly tenantId: string
  readonly papel: 'proprietario' | 'membro' | 'visualizador'
}

/**
 * A resolução de tenant em quatro etapas (`sistema.md` §3.9, achado A-03).
 *
 * O ponto cego canônico de um SaaS multi-tenant, por isso é uma função nomeada
 * e não um middleware genérico: a consulta de pertencimento roda sob a policy
 * de `app.usuario_id`, **antes** de `app.tenant_id` existir. Se ela devolver
 * vazio, não há troca de contexto — nunca se assume o primeiro tenant.
 */
export async function resolverTenant(
  pool: Pool,
  usuarioId: string,
  tenantPedido: string,
): Promise<Pertencimento | null> {
  return comUsuario(pool, { usuarioId }, async (cliente) => {
    const r = await cliente.query<{ tenant_id: string; papel: Pertencimento['papel'] }>(
      'SELECT tenant_id, papel FROM tenant_usuarios WHERE tenant_id = $1',
      [tenantPedido],
    )
    const linha = r.rows[0]
    return linha ? { tenantId: linha.tenant_id, papel: linha.papel } : null
  })
}
