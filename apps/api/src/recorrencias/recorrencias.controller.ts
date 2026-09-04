import {
  BadRequestException,
  Body,
  ConflictException,
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
  zAlterarRecorrencia,
  zCriarRecorrencia,
  type Recorrencia,
} from '@mavia/contracts'
import {
  competenciaDe,
  formatarDataCivil,
  proximaOcorrencia,
  type Competencia,
  type RegraDeRecorrencia,
} from '@mavia/domain'
import type { FastifyRequest } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { AutorizacaoGuard } from '../autorizacao/autorizacao.guard.js'
import { POOL } from '../contas/contas.controller.js'
import { comTenant, contextoDoTenant } from '../tenancy/tenancy.js'
import { limparFuturoPendente, materializarRecorrencia } from './materializar.js'

/**
 * Recorrencia — a regra que gera lançamentos repetidos.
 *
 * ## O horizonte, e o job que ainda não existe
 *
 * O `CONTEXT.md` diz que "um job materializa as ocorrências dentro de um
 * horizonte". O job precisa de agendador, o agendador precisa de Redis, e o
 * Redis é do épico 5. Enquanto isso a materialização acontece **na escrita**:
 * criar ou alterar uma regra materializa doze meses à frente.
 *
 * A consequência é declarada, e não escondida: sem o job, o horizonte não anda
 * sozinho. Uma regra criada hoje tem ocorrências até o mesmo mês do ano que vem
 * e para de produzir depois disso, até que alguém a edite ou chame
 * `POST /v1/recorrencias/materializar` — que existe justamente para ser o ponto
 * de entrada do job quando ele existir. Ver a pendência P-8.
 *
 * ## Idempotência
 *
 * A identidade de uma ocorrência é `(tenant, recorrencia, competência)`, e o
 * índice único do banco é quem a garante. Materializar duas vezes o mesmo mês
 * não duplica nada — o que permite chamar o materializador sem medo, quantas
 * vezes for.
 */
@Controller('v1/recorrencias')
@UseGuards(AutorizacaoGuard)
export class RecorrenciasController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  private contexto(req: FastifyRequest) {
    const a = req.autenticado
    if (!a) throw new BadRequestException('Contexto ausente.')
    return contextoDoTenant(a.usuarioId, a.tenantId)
  }

  @Get()
  async listar(@Req() req: FastifyRequest): Promise<{ itens: Recorrencia[] }> {
    const ctx = this.contexto(req)
    const itens = await comTenant(this.pool, ctx, (c) => this.carregar(c, ctx.tenantId))
    return { itens }
  }

  @Post()
  @HttpCode(201)
  async criar(@Req() req: FastifyRequest, @Body() corpo: unknown): Promise<Recorrencia> {
    const ctx = this.contexto(req)
    const analise = zCriarRecorrencia.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    try {
      return await comTenant(this.pool, ctx, async (c) => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO recorrencias (tenant_id, conta_id, cartao_id, categoria_id,
                                     valor_centavos, descricao, dia_do_mes, intervalo_meses,
                                     inicio, fim, criado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::date,$11)
           RETURNING id`,
          [
            ctx.tenantId,
            d.contaId ?? null,
            d.cartaoId ?? null,
            d.categoriaId,
            d.valorCentavos,
            d.descricao,
            d.diaDoMes,
            d.intervaloMeses,
            `${d.inicio}-01`,
            d.fim ? `${d.fim}-01` : null,
            ctx.usuarioId,
          ],
        )
        const id = r.rows[0]?.id
        if (!id) throw new ConflictException('Não foi possível criar a recorrência.')

        await materializarRecorrencia(c, ctx, id)

        const criada = (await this.carregar(c, ctx.tenantId, id))[0]
        if (!criada) throw new ConflictException('Não foi possível ler a recorrência criada.')
        return criada
      })
    } catch (erro) {
      throw this.traduzir(erro)
    }
  }

  /**
   * Alterar a regra.
   *
   * **Não reescreve o passado.** As ocorrências já materializadas com
   * `posted_at` no passado ficam exatamente como estão — elas são fatos que a
   * pessoa já viu, e possivelmente já conciliou. O que a alteração desfaz são
   * as ocorrências **futuras e ainda não compensadas**, que são previsão; elas
   * são recriadas pela regra nova.
   */
  @Patch(':id')
  async alterar(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() corpo: unknown,
  ): Promise<Recorrencia> {
    const ctx = this.contexto(req)
    const analise = zAlterarRecorrencia.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    try {
      return await comTenant(this.pool, ctx, async (c) => {
        const r = await c.query<{ id: string }>(
          `UPDATE recorrencias
              SET valor_centavos = coalesce($3, valor_centavos),
                  descricao = coalesce($4, descricao),
                  dia_do_mes = coalesce($5, dia_do_mes),
                  intervalo_meses = coalesce($6, intervalo_meses),
                  fim = CASE WHEN $7::boolean THEN $8::date ELSE fim END,
                  pausada_em = CASE
                    WHEN $9::boolean IS NULL THEN pausada_em
                    WHEN $9::boolean THEN coalesce(pausada_em, now())
                    ELSE NULL END,
                  atualizado_em = now()
            WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
            RETURNING id`,
          [
            ctx.tenantId,
            id,
            d.valorCentavos ?? null,
            d.descricao ?? null,
            d.diaDoMes ?? null,
            d.intervaloMeses ?? null,
            d.fim !== undefined,
            // `AAAA-MM` na borda, dia 1 no banco — a mesma convenção da
            // competência em todo o sistema. Sem o dia, o `::date` recusa.
            d.fim ? `${d.fim}-01` : null,
            d.pausada ?? null,
          ],
        )
        if (!r.rows[0]) throw new NotFoundException('Recorrência não encontrada.')

        await limparFuturoPendente(c, ctx.tenantId, id)
        await materializarRecorrencia(c, ctx, id)

        const atual = (await this.carregar(c, ctx.tenantId, id))[0]
        if (!atual) throw new NotFoundException('Recorrência não encontrada.')
        return atual
      })
    } catch (erro) {
      throw this.traduzir(erro)
    }
  }

  @Delete(':id')
  @HttpCode(204)
  async excluir(@Req() req: FastifyRequest, @Param('id') id: string): Promise<void> {
    const ctx = this.contexto(req)
    const apagou = await comTenant(this.pool, ctx, async (c) => {
      // O passado fica. Excluir a regra não apaga o aluguel que já foi pago.
      await limparFuturoPendente(c, ctx.tenantId, id)
      const r = await c.query(
        `UPDATE recorrencias SET deleted_at = now()
          WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [ctx.tenantId, id],
      )
      return (r.rowCount ?? 0) > 0
    })
    if (!apagou) throw new NotFoundException('Recorrência não encontrada.')
  }

  /**
   * Avançar o horizonte de todas as regras do espaço.
   *
   * É o ponto de entrada do job agendado que ainda não existe (P-8). Como a
   * materialização é idempotente pela identidade da ocorrência, chamar isto de
   * novo não duplica nada.
   */
  @Post('materializar')
  @HttpCode(200)
  async materializarTudo(@Req() req: FastifyRequest): Promise<{ criadas: number }> {
    const ctx = this.contexto(req)

    const criadas = await comTenant(this.pool, ctx, async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM recorrencias
          WHERE tenant_id = $1 AND deleted_at IS NULL AND pausada_em IS NULL`,
        [ctx.tenantId],
      )
      let total = 0
      for (const linha of r.rows) total += await materializarRecorrencia(c, ctx, linha.id)
      return total
    })

    return { criadas }
  }

  private async carregar(
    c: PoolClient,
    tenantId: string,
    apenasId?: string,
  ): Promise<Recorrencia[]> {
    const r = await c.query<{
      id: string
      conta_id: string | null
      cartao_id: string | null
      categoria_id: string
      valor_centavos: string
      descricao: string
      dia_do_mes: number
      intervalo_meses: number
      inicio: Date
      fim: Date | null
      pausada_em: Date | null
      materializadas: string
    }>(
      `SELECT r.id, r.conta_id, r.cartao_id, r.categoria_id, r.valor_centavos::text,
              r.descricao, r.dia_do_mes, r.intervalo_meses, r.inicio, r.fim, r.pausada_em,
              (SELECT count(*) FROM lancamentos l
                WHERE l.tenant_id = r.tenant_id AND l.recorrencia_id = r.id
                  AND l.deleted_at IS NULL)::text AS materializadas
         FROM recorrencias r
        WHERE r.tenant_id = $1 AND r.deleted_at IS NULL
          AND ($2::uuid IS NULL OR r.id = $2)
        ORDER BY r.pausada_em NULLS FIRST, r.dia_do_mes, r.descricao`,
      [tenantId, apenasId ?? null],
    )

    const agora = competenciaDe(new Date())

    return r.rows.map((l): Recorrencia => {
      const regra: RegraDeRecorrencia = {
        diaDoMes: l.dia_do_mes,
        intervaloMeses: l.intervalo_meses,
        inicio: competenciaDaData(l.inicio),
        fim: l.fim === null ? null : competenciaDaData(l.fim),
      }
      const proxima = proximaOcorrencia(regra, agora)

      return {
        id: l.id,
        contaId: l.conta_id,
        cartaoId: l.cartao_id,
        categoriaId: l.categoria_id,
        valorCentavos: l.valor_centavos,
        descricao: l.descricao,
        diaDoMes: l.dia_do_mes,
        intervaloMeses: l.intervalo_meses,
        inicio: diaCivil(l.inicio).slice(0, 7),
        fim: l.fim === null ? null : diaCivil(l.fim).slice(0, 7),
        pausada: l.pausada_em !== null,
        // Uma regra pausada não tem próxima ocorrência a anunciar: dizer "10/04"
        // ao lado de "pausada" seria a tela se contradizendo.
        proximaOcorrencia:
          l.pausada_em !== null || proxima === null ? null : formatarDataCivil(proxima.data),
        materializadas: Number(l.materializadas),
      }
    })
  }

  private traduzir(erro: unknown): Error {
    if (erro instanceof NotFoundException || erro instanceof BadRequestException) return erro

    const t = String((erro as { message?: string }).message ?? '')

    if (t.includes('DESPESA_TEM_VALOR_NEGATIVO'))
      return new BadRequestException('Despesa se informa com valor negativo.')
    if (t.includes('RECEITA_TEM_VALOR_POSITIVO'))
      return new BadRequestException('Receita se informa com valor positivo.')
    if (t.includes('CARTAO_NAO_RECEBE_RECEITA'))
      return new BadRequestException(
        'Cartão registra dívida: uma recorrência de receita precisa de uma conta.',
      )
    if (t.includes('CATEGORIA_NAO_ANALITICA'))
      return new BadRequestException('Esta categoria não recebe recorrência.')
    if (t.includes('CATEGORIA_INEXISTENTE'))
      return new BadRequestException('Categoria não encontrada.')
    if (t.includes('fim_nao_precede_inicio'))
      return new BadRequestException('O fim da recorrência não pode vir antes do início.')
    if (t.includes('valor_nao_zero'))
      return new BadRequestException('O valor de uma recorrência não pode ser zero.')

    return erro as Error
  }
}

function doisDigitos(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Coluna `DATE` volta do driver como `Date` à meia-noite **UTC**: o dia já é
 * civil e só precisa ser lido de volta. Convertê-la de fuso a jogaria para o
 * dia anterior.
 */
function diaCivil(d: Date): string {
  return `${d.getUTCFullYear()}-${doisDigitos(d.getUTCMonth() + 1)}-${doisDigitos(d.getUTCDate())}`
}

function competenciaDaData(d: Date): Competencia {
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1 }
}
