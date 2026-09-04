import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import {
  assinatura,
  classificar,
  type Classificacao,
  type Historico,
  type RegraDoUsuario,
} from '@mavia/domain'
import { z } from 'zod'
import type { FastifyRequest } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { AutorizacaoGuard } from '../autorizacao/autorizacao.guard.js'
import { POOL } from '../contas/contas.controller.js'
import { comTenant, contextoDoTenant } from '../tenancy/tenancy.js'

/**
 * Categorização automática — as regras, e a reclassificação em lote.
 *
 * ## As duas garantias do glossário
 *
 * **Motivo visível.** Toda classificação automática grava a frase em português
 * que a explica, junto do lançamento. Não um identificador de regra: guardar o
 * identificador faria a explicação mudar quando a regra mudasse, e o lançamento
 * passaria a dizer que foi classificado por um motivo que não existia quando
 * ele foi classificado.
 *
 * **Reversível.** Trocar a categoria à mão limpa as duas colunas. O lançamento
 * deixa de constar como automático porque deixou de ser — e a reversão fica
 * observável, e não só possível.
 *
 * ## Sem modelo externo
 *
 * Decisão do dono do produto: regra escrita pela pessoa e histórico do próprio
 * espaço. Nada sai do tenant, nada vira corpus, não há terceiro na cadeia. A
 * consequência honesta é que o sistema não classifica nada no primeiro mês, e a
 * interface diz isso em vez de inventar.
 */

const zRegra = z.object({
  tipo: z.enum(['igual', 'comeca_com', 'contem']).default('contem'),
  padrao: z.string().trim().min(2).max(120),
  categoriaId: z.string().uuid(),
  prioridade: z.number().int().min(1).max(1000).optional(),
})

interface Regra {
  readonly id: string
  readonly tipo: 'igual' | 'comeca_com' | 'contem'
  readonly padrao: string
  readonly categoriaId: string
  readonly prioridade: number
}

@Controller('v1/regras')
@UseGuards(AutorizacaoGuard)
export class RegrasController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  private contexto(req: FastifyRequest) {
    const a = req.autenticado
    if (!a) throw new BadRequestException('Contexto ausente.')
    return contextoDoTenant(a.usuarioId, a.tenantId)
  }

  @Get()
  async listar(@Req() req: FastifyRequest): Promise<{ itens: Regra[] }> {
    const ctx = this.contexto(req)
    const itens = await comTenant(this.pool, ctx, (c) => lerRegras(c, ctx.tenantId))
    return { itens }
  }

  @Post()
  @HttpCode(201)
  async criar(@Req() req: FastifyRequest, @Body() corpo: unknown): Promise<Regra> {
    const ctx = this.contexto(req)
    const analise = zRegra.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    // Um padrão que a assinatura reduz a nada — "123 456" — nunca casaria com
    // coisa alguma. Recusar aqui é melhor do que criar uma regra morta.
    if (assinatura(d.padrao) === '') {
      throw new BadRequestException(
        'Este padrão não tem nenhuma palavra: números e pontuação são ignorados na comparação.',
      )
    }

    try {
      return await comTenant(this.pool, ctx, async (c) => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO regras_de_categorizacao
             (tenant_id, tipo, padrao, categoria_id, prioridade, criado_por)
           VALUES ($1,$2::tipo_de_regra,$3,$4,coalesce($5,100),$6)
           RETURNING id`,
          [ctx.tenantId, d.tipo, d.padrao, d.categoriaId, d.prioridade ?? null, ctx.usuarioId],
        )
        const criada = (await lerRegras(c, ctx.tenantId, r.rows[0]!.id))[0]
        if (!criada) throw new NotFoundException('Regra não encontrada.')
        return criada
      })
    } catch (erro) {
      const t = String((erro as { message?: string }).message ?? '')
      if (t.includes('regra_unica')) {
        throw new BadRequestException('Você já tem uma regra igual a esta.')
      }
      throw erro
    }
  }

  @Delete(':id')
  @HttpCode(204)
  async excluir(@Req() req: FastifyRequest, @Param('id') id: string): Promise<void> {
    const ctx = this.contexto(req)
    const apagou = await comTenant(this.pool, ctx, async (c) => {
      const r = await c.query(
        `UPDATE regras_de_categorizacao SET deleted_at = now()
          WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [ctx.tenantId, id],
      )
      return (r.rowCount ?? 0) > 0
    })
    if (!apagou) throw new NotFoundException('Regra não encontrada.')
  }

  /**
   * Aplicar as regras e o histórico ao que ainda não foi classificado.
   *
   * Só toca no que está em `A classificar` **e** não foi decidido por um
   * humano. Reclassificar o que a pessoa já categorizou seria desfazer a
   * decisão dela — e é justamente o que a garantia de reversibilidade proíbe.
   */
  @Post('aplicar')
  @HttpCode(200)
  async aplicar(@Req() req: FastifyRequest): Promise<{ classificados: number }> {
    const ctx = this.contexto(req)

    const classificados = await comTenant(this.pool, ctx, async (c) => {
      const regras = await lerRegras(c, ctx.tenantId)
      const pendentes = await c.query<{ id: string; descricao: string; valor_centavos: string }>(
        `SELECT l.id, l.descricao, l.valor_centavos::text
           FROM lancamentos l
           JOIN categorias cat ON cat.id = l.categoria_id AND cat.tenant_id = l.tenant_id
          WHERE l.tenant_id = $1 AND l.deleted_at IS NULL
            AND cat.nome = 'A classificar'
          ORDER BY l.posted_at DESC
          LIMIT 500`,
        [ctx.tenantId],
      )

      let total = 0
      for (const l of pendentes.rows) {
        const proposta = await propor(c, ctx.tenantId, l.descricao, regras)
        if (!proposta) continue

        // A categoria proposta tem de ter a natureza do valor: uma regra que
        // manda receita para categoria de despesa faz o gatilho recusar a
        // linha, e uma regra malfeita derrubaria o lote inteiro.
        const ok = await naturezaConfere(c, ctx.tenantId, proposta.categoriaId, BigInt(l.valor_centavos))
        if (!ok) continue

        await c.query(
          `UPDATE lancamentos
              SET categoria_id = $3, classificacao_origem = $4, classificacao_motivo = $5,
                  atualizado_em = now()
            WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, l.id, proposta.categoriaId, proposta.origem, proposta.motivo],
        )
        total++
      }
      return total
    })

    return { classificados }
  }
}

/**
 * Alterar um lançamento — hoje, a categoria e a descrição.
 *
 * **Faltava, e a falta era grave.** A importação cria lançamentos em
 * `A classificar`, e sem esta rota eles ficavam ali para sempre: não havia
 * nenhum caminho, em nenhuma tela, para mover um lançamento de categoria.
 */
@Controller('v1/lancamentos')
@UseGuards(AutorizacaoGuard)
export class AlterarLancamentoController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Patch(':id')
  async alterar(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() corpo: unknown,
  ): Promise<{ id: string; categoriaId: string | null; descricao: string }> {
    const a = req.autenticado
    if (!a) throw new BadRequestException('Contexto ausente.')
    const ctx = contextoDoTenant(a.usuarioId, a.tenantId)

    const analise = z
      .object({
        categoriaId: z.string().uuid().optional(),
        descricao: z.string().trim().min(1).max(140).optional(),
      })
      .refine((d) => d.categoriaId !== undefined || d.descricao !== undefined, {
        message: 'informe o que mudar',
      })
      .safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    return comTenant(this.pool, ctx, async (c) => {
      const r = await c.query<{ id: string; categoria_id: string | null; descricao: string }>(
        `UPDATE lancamentos
            SET categoria_id = coalesce($3, categoria_id),
                descricao = coalesce($4, descricao),
                -- **A reversão fica observável.** Trocar a categoria à mão apaga
                -- a marca de automático: o lançamento deixa de constar como
                -- classificado por regra porque deixou de ser.
                classificacao_origem = CASE WHEN $3::uuid IS NULL THEN classificacao_origem END,
                classificacao_motivo = CASE WHEN $3::uuid IS NULL THEN classificacao_motivo END,
                editado_manualmente = TRUE,
                atualizado_em = now()
          WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
            -- Perna de transferência não tem categoria, e dar uma a ela faria
            -- a transferência entrar em relatório de despesa (regra 12b).
            AND transfer_group_id IS NULL
          RETURNING id, categoria_id, descricao`,
        [ctx.tenantId, id, d.categoriaId ?? null, d.descricao ?? null],
      )
      const linha = r.rows[0]
      if (!linha) throw new NotFoundException('Lançamento não encontrado.')

      return { id: linha.id, categoriaId: linha.categoria_id, descricao: linha.descricao }
    })
  }
}

// ---------------------------------------------------------------------------

async function lerRegras(c: PoolClient, tenantId: string, apenasId?: string): Promise<Regra[]> {
  const r = await c.query<{
    id: string
    tipo: Regra['tipo']
    padrao: string
    categoria_id: string
    prioridade: number
  }>(
    `SELECT id, tipo, padrao, categoria_id, prioridade
       FROM regras_de_categorizacao
      WHERE tenant_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id = $2)
      ORDER BY prioridade, criado_em`,
    [tenantId, apenasId ?? null],
  )
  return r.rows.map((l) => ({
    id: l.id,
    tipo: l.tipo,
    padrao: l.padrao,
    categoriaId: l.categoria_id,
    prioridade: l.prioridade,
  }))
}

/**
 * A proposta para uma descrição.
 *
 * O histórico é buscado **por assinatura exata**, no banco, para não trazer o
 * extrato inteiro à memória a cada lançamento. A decisão continua sendo do
 * domínio: este SQL só junta os fatos.
 *
 * Exportada porque a importação também classifica, e as duas precisam usar a
 * mesma regra — duas implementações divergiriam no primeiro caso de borda.
 */
export async function propor(
  c: PoolClient,
  tenantId: string,
  descricao: string,
  regras: readonly RegraDoUsuario[],
): Promise<Classificacao | null> {
  const alvo = assinatura(descricao)
  if (alvo === '') return null

  const r = await c.query<{ categoria_id: string; vezes: string }>(
    `SELECT l.categoria_id, count(*)::text AS vezes
       FROM lancamentos l
       JOIN categorias cat ON cat.id = l.categoria_id AND cat.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1
        AND l.deleted_at IS NULL
        AND l.categoria_id IS NOT NULL
        -- O que a pessoa decidiu, e não o que o sistema propôs: aprender do
        -- próprio palpite é como um erro vira convicção.
        AND l.classificacao_origem IS NULL
        AND cat.nome <> 'A classificar'
        AND assinatura_da_descricao(l.descricao) = $2
      GROUP BY l.categoria_id`,
    [tenantId, alvo],
  )

  const historico: Historico[] = r.rows.map((l) => ({
    assinatura: alvo,
    categoriaId: l.categoria_id,
    vezes: Number(l.vezes),
  }))

  return classificar(descricao, regras, historico)
}

export async function naturezaConfere(
  c: PoolClient,
  tenantId: string,
  categoriaId: string,
  centavos: bigint,
): Promise<boolean> {
  const r = await c.query<{ natureza: string; analitica: boolean }>(
    'SELECT natureza, analitica FROM categorias WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL',
    [tenantId, categoriaId],
  )
  const cat = r.rows[0]
  if (!cat || !cat.analitica) return false
  return centavos < 0n ? cat.natureza === 'despesa' : cat.natureza === 'receita'
}

export { lerRegras }
