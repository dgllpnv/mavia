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

/**
 * ## Os contextos são marcados, e por quê
 *
 * Os cinco contextos têm a **mesma forma estrutural** — um ou dois `string`. Sem
 * marca, o TypeScript os considera intercambiáveis, e passar o contexto de
 * administração para `comTenant` compilaria: a rota do painel rodaria como
 * `mavia_app`, com DML completo sobre o razão do cliente cujo `app.tenant_id`
 * ela acabou de assumir. É o defeito que a v2 do spec não conseguia impedir.
 *
 * A marca é apagada na compilação e **não custa nada em tempo de execução**.
 * Ela também não é uma trava de segurança: `as unknown as ContextoDoTenant`
 * compila, e o `CLAUDE.md` §6 permite `as` com justificativa. Quem impede o
 * vazamento é a topologia — pool próprio, papel próprio, sem parentesco. A
 * marca impede o **engano**; o privilégio impede o **ato**.
 *
 * Por isso cada contexto tem **uma** fábrica e nenhuma outra: um `as` espalhado
 * por treze controladores seria treze lugares onde a marca vira decoração.
 */
declare const especie: unique symbol

type Marcado<E extends string> = { readonly [especie]: E }

export type ContextoDoTenant = Readonly<{
  usuarioId: string
  tenantId: string
}> &
  Marcado<'tenant'>

/** Contexto de quem está autenticado mas ainda não escolheu tenant (etapa 2). */
export type ContextoDeUsuario = Readonly<{ usuarioId: string }> & Marcado<'usuario'>

/**
 * O operador do painel, **sem espaço nenhum aberto**.
 *
 * É o contexto da listagem de clientes e da resolução de concessão — as duas
 * coisas que acontecem antes de existir um espaço. Ele nunca alcança `comTenant`.
 */
export type ContextoDeOperador = Readonly<{ usuarioId: string }> & Marcado<'operador'>

/**
 * Um espaço de cliente aberto **em leitura** por um operador.
 *
 * Só `admin.abrir_espaco` produz isto, e a produção é o mesmo ato que grava a
 * linha de auditoria (spec §1.6). Um contexto destes na mão significa que o
 * registro já existe.
 */
export type ContextoDeAdmin = Readonly<{
  usuarioId: string
  tenantId: string
}> &
  Marcado<'admin'>

/**
 * Um espaço de cliente aberto **para escrita de contrato**.
 *
 * Marca distinta da de leitura de propósito: são pools diferentes, papéis
 * diferentes e classes de auditoria diferentes. Se os dois compartilhassem a
 * marca, o caminho de leitura habilitaria uma escrita em compilação — e o
 * `permission denied` só apareceria em tempo de execução, na madrugada.
 */
export type ContextoDeAdminEscrita = Readonly<{
  usuarioId: string
  tenantId: string
}> &
  Marcado<'admin-escrita'>

/**
 * As fábricas. Cada `as` abaixo é o **único** do seu tipo em todo o repositório,
 * e é o que o `CLAUDE.md` §6 pede quando exige justificativa para um `as`: a
 * marca não existe em tempo de execução, então alguém precisa afirmá-la, e é
 * melhor que seja aqui, uma vez, sob comentário, do que em treze controladores.
 */
export function contextoDoTenant(usuarioId: string, tenantId: string): ContextoDoTenant {
  return { usuarioId, tenantId } as ContextoDoTenant
}

export function contextoDeUsuario(usuarioId: string): ContextoDeUsuario {
  return { usuarioId } as ContextoDeUsuario
}

export function contextoDeOperador(usuarioId: string): ContextoDeOperador {
  return { usuarioId } as ContextoDeOperador
}

/**
 * **Chamada apenas por `admin.abrir_espaco`** (ticket 05), depois de a função
 * ter gravado a auditoria e definido o GUC na mesma instrução. Chamá-la de
 * outro lugar produz um contexto sem registro correspondente — que é
 * exatamente a divergência "auditou A, efetivou B" que o spec §1.6 fecha.
 */
export function contextoDeAdmin(usuarioId: string, tenantId: string): ContextoDeAdmin {
  return { usuarioId, tenantId } as ContextoDeAdmin
}

/** Irmã da anterior, para `admin.abrir_espaco_para_escrita`. */
export function contextoDeAdminEscrita(
  usuarioId: string,
  tenantId: string,
): ContextoDeAdminEscrita {
  return { usuarioId, tenantId } as ContextoDeAdminEscrita
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
    cliente.release()
    return resultado
  } catch (erro) {
    // `release(erro)` **destrói** a conexão em vez de devolvê-la ao pool.
    //
    // O `finally` anterior a devolvia em qualquer caso, inclusive quando o
    // próprio `ROLLBACK` falhava — e uma conexão que não desfez a transação
    // carrega `SET LOCAL ROLE` e os GUCs da requisição que morreu. A próxima
    // requisição a pegaria com o contexto de outra pessoa. Custa uma conexão
    // nova; a alternativa custa um vazamento entre clientes.
    try {
      await cliente.query('ROLLBACK')
      cliente.release()
    } catch (falhaAoDesfazer) {
      cliente.release(falhaAoDesfazer as Error)
    }
    throw erro
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
  return comUsuario(pool, contextoDeUsuario(usuarioId), async (cliente) => {
    const r = await cliente.query<{ tenant_id: string; papel: Pertencimento['papel'] }>(
      'SELECT tenant_id, papel FROM tenant_usuarios WHERE tenant_id = $1',
      [tenantPedido],
    )
    const linha = r.rows[0]
    return linha ? { tenantId: linha.tenant_id, papel: linha.papel } : null
  })
}


// ---------------------------------------------------------------------------
// O painel de administração — ADR 0024 D2 e D3, spec §1.1 e §1.4
// ---------------------------------------------------------------------------
//
// As três funções abaixo usam **pools próprios**, autenticados diretamente
// como os papéis do painel. Não é `SET ROLE` a partir do pool do cliente, e a
// razão está medida contra Postgres 17:
//
//     BEGIN; SET LOCAL ROLE leitor; UPDATE t SET v=99;              -- denied
//     BEGIN; SET LOCAL ROLE leitor; RESET ROLE; UPDATE t SET v=99;  -- UPDATE 1
//
// Uma instrução desfaz a trava. Com papel próprio e sem parentesco com
// `mavia_app`, `RESET ROLE` aterrissa em quem não escreve.
//
// **O `SET LOCAL ROLE` continua sendo emitido, e é redundante de propósito.**
// A conexão já está autenticada como o papel certo. Ele existe para que o pool
// **errado** falhe: `comTenant` recebendo o pool do painel morre em
// `SET LOCAL ROLE mavia_app` com `permission denied to set role`, e o inverso
// também. Remover a instrução "redundante" faz o pool trocado passar a
// funcionar em silêncio, com o papel errado. É verificação de coerência, não
// sobra — spec §1.4, achado S3-10.

/**
 * O operador, sem espaço aberto. Listagem de clientes e resolução de concessão.
 *
 * Define `app.usuario_id` e **zera `app.tenant_id` explicitamente**: numa
 * conexão de pool reaproveitada, o valor da requisição anterior sobrevive ao
 * `SET LOCAL` da transação que terminou apenas se alguém o tiver definido com
 * `SET`. Zerar é barato e remove a classe inteira de dúvida.
 */
export async function comAdmin<T>(
  poolDoPainel: Pool,
  contexto: ContextoDeOperador,
  trabalho: (cliente: PoolClient) => Promise<T>,
): Promise<T> {
  if (!contexto.usuarioId) throw new ContextoAusente('app.usuario_id')

  return emTransacao(
    poolDoPainel,
    'mavia_admin',
    async (cliente) => {
      await cliente.query('SELECT set_config($1, $2, true)', ['app.usuario_id', contexto.usuarioId])
      await cliente.query('SELECT set_config($1, $2, true)', ['app.tenant_id', ''])
    },
    trabalho,
  )
}

/**
 * Um espaço de cliente aberto em leitura. **Nunca produz um `Autenticado`** —
 * ADR 0024 D2 — e por isso os controladores do cliente não conseguem servi-lo.
 */
export async function comTenantDeAdmin<T>(
  poolDoPainel: Pool,
  contexto: ContextoDeAdmin,
  trabalho: (cliente: PoolClient) => Promise<T>,
): Promise<T> {
  if (!contexto.usuarioId) throw new ContextoAusente('app.usuario_id')
  if (!contexto.tenantId) throw new ContextoAusente('app.tenant_id')

  return emTransacao(
    poolDoPainel,
    'mavia_admin',
    async (cliente) => {
      await cliente.query('SELECT set_config($1, $2, true)', ['app.usuario_id', contexto.usuarioId])
      await cliente.query('SELECT set_config($1, $2, true)', ['app.tenant_id', contexto.tenantId])
    },
    trabalho,
  )
}

/**
 * Um espaço aberto para escrita de contrato. Pool **e** papel distintos do de
 * leitura: `mavia_admin` não é membro de `mavia_admin_escrita`, então esta
 * função recebendo o pool de leitura morre no `SET LOCAL ROLE`.
 */
export async function comTenantDeAdminEscrita<T>(
  poolDeEscrita: Pool,
  contexto: ContextoDeAdminEscrita,
  trabalho: (cliente: PoolClient) => Promise<T>,
): Promise<T> {
  if (!contexto.usuarioId) throw new ContextoAusente('app.usuario_id')
  if (!contexto.tenantId) throw new ContextoAusente('app.tenant_id')

  return emTransacao(
    poolDeEscrita,
    'mavia_admin_escrita',
    async (cliente) => {
      await cliente.query('SELECT set_config($1, $2, true)', ['app.usuario_id', contexto.usuarioId])
      await cliente.query('SELECT set_config($1, $2, true)', ['app.tenant_id', contexto.tenantId])
    },
    trabalho,
  )
}
