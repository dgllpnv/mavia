import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common'
import type { Categoria } from '@mavia/contracts'
import type { PoolClient } from 'pg'

/**
 * Escrita de categoria.
 *
 * Três regras que a interface conseguiria pedir e o produto não deve fazer, e
 * cada uma existe por uma razão que só aparece meses depois:
 *
 * 1. **A árvore tem dois níveis.** Uma neta é representável no banco (`parent_id`
 *    é auto-referência), e o `CHECK` de nível a barra. Aqui a recusa vem antes,
 *    com uma frase.
 * 2. **Natureza é herdada, nunca escolhida na filha.** Uma filha de despesa que
 *    fosse receita faria a soma da árvore misturar os dois sinais no mesmo galho,
 *    e o relatório de categoria deixaria de fechar com o rodapé.
 * 3. **Natureza não muda depois que há lançamento.** O gatilho
 *    `lancamento_coerente` confere o sinal na hora de gravar o lançamento — e
 *    ninguém revisita os antigos. Trocar a natureza deixaria para trás uma
 *    coleção de lançamentos cujo sinal discorda da própria categoria.
 */

export interface DadosDeCategoria {
  readonly nome: string
  readonly natureza: Categoria['natureza']
  readonly parentId?: string | undefined
}

interface Linha {
  readonly id: string
  readonly parent_id: string | null
  readonly nivel: number
  readonly nome: string
  readonly natureza: Categoria['natureza']
  readonly analitica: boolean
  readonly sistema: boolean
  readonly cor: string | null
  readonly arquivada_em: Date | null
}

const COLUNAS = `id, parent_id, nivel, nome, natureza, analitica, sistema, cor, arquivada_em`

export function paraContrato(l: Linha): Categoria {
  return {
    id: l.id,
    parentId: l.parent_id,
    nivel: l.nivel as Categoria['nivel'],
    nome: l.nome,
    natureza: l.natureza,
    analitica: l.analitica,
    arquivada: l.arquivada_em !== null,
    sistema: l.sistema,
    cor: l.cor,
  }
}

export async function criar(
  c: PoolClient,
  tenantId: string,
  dados: DadosDeCategoria,
): Promise<Categoria> {
  let nivel = 1
  let natureza = dados.natureza

  if (dados.parentId) {
    const mae = await carregar(c, tenantId, dados.parentId)

    if (mae.nivel !== 1) {
      throw new BadRequestException(
        'A árvore de categorias tem dois níveis. Escolha uma categoria-mãe, ' +
          'ou crie esta como categoria própria.',
      )
    }

    nivel = 2
    // Herdada da mãe, e o que veio no corpo é ignorado: ver a regra 2 acima.
    natureza = mae.natureza
  }

  const r = await c.query<Linha>(
    `INSERT INTO categorias (tenant_id, parent_id, nivel, nome, natureza)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING ${COLUNAS}`,
    [tenantId, dados.parentId ?? null, nivel, dados.nome, natureza],
  )
  const l = r.rows[0]
  if (!l) throw new ConflictException('Não foi possível criar a categoria.')
  return paraContrato(l)
}

export interface AlteracaoDeCategoria {
  readonly nome?: string | undefined
  readonly natureza?: Categoria['natureza'] | undefined
}

export async function alterar(
  c: PoolClient,
  tenantId: string,
  id: string,
  dados: AlteracaoDeCategoria,
): Promise<Categoria> {
  const atual = await carregar(c, tenantId, id)

  if (dados.natureza && dados.natureza !== atual.natureza) {
    if (atual.sistema) {
      throw new ConflictException('Categoria de sistema não muda de natureza.')
    }

    const usada = await c.query(
      `SELECT 1 FROM lancamentos
        WHERE tenant_id = $1 AND categoria_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [tenantId, id],
    )
    if (usada.rowCount) {
      throw new ConflictException(
        'Esta categoria já tem lançamento. Trocar a natureza deixaria para trás ' +
          'lançamentos cujo sinal discorda dela — crie uma categoria nova.',
      )
    }

    // A filha acompanha a mãe: manter as duas naturezas diferentes é o estado
    // que a regra 2 existe para impedir.
    await c.query(
      `UPDATE categorias SET natureza = $3, atualizado_em = now()
        WHERE tenant_id = $1 AND parent_id = $2 AND deleted_at IS NULL`,
      [tenantId, id, dados.natureza],
    )
  }

  const r = await c.query<Linha>(
    `UPDATE categorias
        SET nome = coalesce($3, nome),
            natureza = coalesce($4, natureza),
            atualizado_em = now()
      WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
      RETURNING ${COLUNAS}`,
    [tenantId, id, dados.nome ?? null, dados.natureza ?? null],
  )
  const l = r.rows[0]
  if (!l) throw new NotFoundException('Categoria não encontrada.')
  return paraContrato(l)
}

/**
 * Arquivar, e **nunca** apagar.
 *
 * Lançamento antigo aponta para a categoria; apagá-la deixaria a linha do
 * extrato sem nome, e o relatório do ano passado com um buraco. Arquivada, ela
 * sai do seletor e continua no dicionário.
 *
 * Categoria de sistema não se arquiva: `Sem categoria` é o destino do importado
 * que a categorização não soube classificar, e sem ela a importação não teria
 * onde pôr o que não entendeu.
 */
export async function arquivar(c: PoolClient, tenantId: string, id: string): Promise<void> {
  const atual = await carregar(c, tenantId, id)

  if (atual.sistema) {
    throw new ConflictException(
      'Esta categoria é do sistema e não pode ser arquivada — ela é o destino ' +
        'do que chega sem classificação.',
    )
  }

  await c.query(
    `UPDATE categorias SET arquivada_em = now(), atualizado_em = now()
      WHERE tenant_id = $1 AND (id = $2 OR parent_id = $2) AND arquivada_em IS NULL`,
    [tenantId, id],
  )
}

/**
 * 404 e não 403 quando a categoria é de outro espaço: dizer "existe, mas não é
 * sua" já entrega a existência de uma categoria de outro cliente. A RLS é quem
 * faz a linha não aparecer; aqui só se traduz a ausência.
 */
async function carregar(c: PoolClient, tenantId: string, id: string): Promise<Linha> {
  const r = await c.query<Linha>(
    `SELECT ${COLUNAS} FROM categorias
      WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [tenantId, id],
  )
  const l = r.rows[0]
  if (!l) throw new NotFoundException('Categoria não encontrada.')
  return l
}
