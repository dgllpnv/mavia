import { incluiNoSaldoGeralPorPadrao, type Conta, type CriarConta } from '@mavia/contracts'
import type { PoolClient } from 'pg'

/**
 * Repositório de contas.
 *
 * Toda consulta filtra por `tenant_id` **além** da RLS. Isso não é redundância
 * inútil: é a segunda camada da regra 16 do `CLAUDE.md`. A primeira camada é o
 * banco, e ela pode falhar em silêncio se alguém esquecer o `SET LOCAL`.
 */

interface LinhaDeConta {
  readonly id: string
  readonly nome: string
  readonly tipo: Conta['tipo']
  readonly origem: Conta['origem']
  readonly saldo_inicial_centavos: string
  readonly moeda: Conta['moeda']
  readonly incluir_no_saldo_geral: boolean
  readonly criado_em: Date
}

function paraContrato(linha: LinhaDeConta): Conta {
  return {
    id: linha.id,
    nome: linha.nome,
    tipo: linha.tipo,
    origem: linha.origem,
    // O driver já devolve BIGINT como string, que é exatamente o que o
    // contrato transporta. Converter para number aqui perderia precisão.
    saldoInicialCentavos: linha.saldo_inicial_centavos,
    moeda: linha.moeda,
    incluirNoSaldoGeral: linha.incluir_no_saldo_geral,
    criadoEm: linha.criado_em.toISOString(),
  }
}

const COLUNAS = `id, nome, tipo, origem, saldo_inicial_centavos, moeda,
                 incluir_no_saldo_geral, criado_em`

export async function listar(cliente: PoolClient, tenantId: string): Promise<Conta[]> {
  const r = await cliente.query<LinhaDeConta>(
    `SELECT ${COLUNAS} FROM contas
      WHERE tenant_id = $1 AND deleted_at IS NULL
      ORDER BY nome`,
    [tenantId],
  )
  return r.rows.map(paraContrato)
}

export async function buscarPorId(
  cliente: PoolClient,
  tenantId: string,
  id: string,
): Promise<Conta | null> {
  const r = await cliente.query<LinhaDeConta>(
    `SELECT ${COLUNAS} FROM contas
      WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [tenantId, id],
  )
  const linha = r.rows[0]
  return linha ? paraContrato(linha) : null
}

export async function criar(
  cliente: PoolClient,
  tenantId: string,
  dados: CriarConta,
): Promise<Conta> {
  const r = await cliente.query<LinhaDeConta>(
    `INSERT INTO contas (tenant_id, nome, tipo, saldo_inicial_centavos, moeda,
                         incluir_no_saldo_geral)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${COLUNAS}`,
    [
      tenantId,
      dados.nome,
      dados.tipo,
      dados.saldoInicialCentavos,
      dados.moeda,
      dados.incluirNoSaldoGeral ?? incluiNoSaldoGeralPorPadrao(dados.tipo),
    ],
  )
  const linha = r.rows[0]
  // A RLS recusaria a linha antes disso; chegar aqui sem retorno seria bug.
  if (!linha) throw new Error('INSERT em contas não devolveu linha')
  return paraContrato(linha)
}

/** Soft delete: dado financeiro não some (`CLAUDE.md` §2, regra 17). */
export async function arquivar(
  cliente: PoolClient,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const r = await cliente.query(
    `UPDATE contas SET deleted_at = now(), atualizado_em = now()
      WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [tenantId, id],
  )
  return (r.rowCount ?? 0) > 0
}
