import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import {
  zAlterarPlanejamento,
  zCopiarPlanejamentos,
  zCriarPlanejamento,
  type Planejamento,
  type PlanejamentosDoMes,
} from '@mavia/contracts'
import {
  consumoEmBp,
  dinheiro,
  estadoDoPlanejamento,
  naturezaDoValor,
  totalPlanejado,
} from '@mavia/domain'
import type { FastifyRequest } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { AutorizacaoGuard } from '../autorizacao/autorizacao.guard.js'
import { POOL } from '../contas/contas.controller.js'
import { comTenant } from '../tenancy/tenancy.js'

/**
 * Planejamento — teto de despesa e piso de receita, por competência.
 *
 * A rota de listagem devolve o **realizado já apurado**, e não só os valores
 * planejados. Deixar a apuração para o cliente exigiria que cada consumidor —
 * web, mobile, um relatório futuro — reimplementasse a regra de escopo e de
 * natureza, e a regra é sutil o bastante para que as implementações divergissem.
 */
@Controller('v1/planejamentos')
@UseGuards(AutorizacaoGuard)
export class PlanejamentosController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  private contexto(req: FastifyRequest) {
    const a = req.autenticado
    if (!a) throw new BadRequestException('Contexto ausente.')
    return { usuarioId: a.usuarioId, tenantId: a.tenantId }
  }

  /** `AAAA-MM` na entrada, dia 1 no banco. A competência é o mês. */
  private competencia(texto: unknown): string {
    if (typeof texto !== 'string' || !/^\d{4}-\d{2}$/.test(texto)) {
      throw new BadRequestException('Informe a competência em `AAAA-MM`.')
    }
    return `${texto}-01`
  }

  @Get()
  async listar(
    @Req() req: FastifyRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<PlanejamentosDoMes> {
    const ctx = this.contexto(req)
    const competencia = this.competencia(query['competencia'])

    return comTenant(this.pool, ctx, async (c) => {
      const linhas = await this.carregarComRealizado(c, ctx.tenantId, competencia)
      const arvore = await this.arvoreDeCategorias(c, ctx.tenantId)

      const total = totalPlanejado(
        linhas.map((l) => ({
          categoriaId: l.categoriaId,
          valor: dinheiro(BigInt(l.valorCentavos), 'BRL'),
        })),
        arvore,
      )

      return {
        itens: linhas,
        totalPlanejado: {
          teto: total.teto.centavos.toString(),
          piso: total.piso.centavos.toString(),
        },
      }
    })
  }

  @Post()
  @HttpCode(201)
  async criar(@Req() req: FastifyRequest, @Body() corpo: unknown): Promise<Planejamento> {
    const ctx = this.contexto(req)
    const analise = zCriarPlanejamento.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    try {
      return await comTenant(this.pool, ctx, async (c) => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO planejamentos (tenant_id, competencia, categoria_id, valor_centavos,
                                      alertas_percentuais, criado_por)
           VALUES ($1, $2::date, $3, $4, coalesce($5::smallint[], ARRAY[80,100]::smallint[]), $6)
           RETURNING id`,
          [
            ctx.tenantId,
            this.competencia(d.competencia),
            d.categoriaId ?? null,
            d.valorCentavos,
            d.alertasPercentuais ?? null,
            ctx.usuarioId,
          ],
        )
        const id = r.rows[0]?.id
        if (!id) throw new ConflictException('Não foi possível criar o planejamento.')

        const itens = await this.carregarComRealizado(
          c,
          ctx.tenantId,
          this.competencia(d.competencia),
          id,
        )
        const criado = itens[0]
        if (!criado) throw new ConflictException('Não foi possível ler o planejamento criado.')
        return criado
      })
    } catch (erro) {
      throw this.traduzir(erro)
    }
  }

  @Patch(':id')
  async alterar(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() corpo: unknown,
  ): Promise<Planejamento> {
    const ctx = this.contexto(req)
    const analise = zAlterarPlanejamento.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    try {
      return await comTenant(this.pool, ctx, async (c) => {
        const r = await c.query<{ competencia: Date }>(
          `UPDATE planejamentos
              SET valor_centavos = coalesce($3, valor_centavos),
                  alertas_percentuais = coalesce($4::smallint[], alertas_percentuais),
                  atualizado_em = now()
            WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
            RETURNING competencia`,
          [ctx.tenantId, id, d.valorCentavos ?? null, d.alertasPercentuais ?? null],
        )
        const linha = r.rows[0]
        if (!linha) throw new NotFoundException('Planejamento não encontrado.')

        const itens = await this.carregarComRealizado(
          c,
          ctx.tenantId,
          diaCivil(linha.competencia),
          id,
        )
        const atual = itens[0]
        if (!atual) throw new NotFoundException('Planejamento não encontrado.')
        return atual
      })
    } catch (erro) {
      throw this.traduzir(erro)
    }
  }

  /**
   * Copiar de um mês para outro.
   *
   * O "copiar os últimos definidos" que existe porque o planejamento é
   * **mensal e não perpétuo**. A idempotência mora na função de banco, junto da
   * identidade que ela precisa comparar — inclusive o global, cuja
   * `categoria_id` nula não é encontrada por `=`.
   */
  @Post('copiar')
  @HttpCode(201)
  async copiar(
    @Req() req: FastifyRequest,
    @Body() corpo: unknown,
  ): Promise<{ copiados: number }> {
    const ctx = this.contexto(req)
    const analise = zCopiarPlanejamentos.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    if (d.de === d.para) {
      throw new BadRequestException('Origem e destino precisam ser meses diferentes.')
    }

    const copiados = await comTenant(this.pool, ctx, async (c) => {
      const r = await c.query<{ copiar_planejamentos: number }>(
        'SELECT copiar_planejamentos($1, $2::date, $3::date, $4) AS copiar_planejamentos',
        [ctx.tenantId, this.competencia(d.de), this.competencia(d.para), ctx.usuarioId],
      )
      return r.rows[0]?.copiar_planejamentos ?? 0
    })

    return { copiados }
  }

  /**
   * Os planejamentos do mês, com o realizado de cada um.
   *
   * **O realizado é somado por natureza da Categoria, e não pelo sinal do
   * lançamento.** É o que faz o teto global existir: somando líquido, R$ 10.000
   * gastos sob teto de R$ 3.000, com R$ 20.000 de salário, dariam
   * `+1.000.000 >= −300.000` — dentro do planejado para qualquer pessoa com
   * superávit. E é por natureza da categoria, não por sinal, porque um estorno
   * de salário é negativo e é receita: ele não pode consumir teto de despesa.
   *
   * **O escopo agrega para baixo.** Um planejamento de raiz soma a raiz e as
   * filhas; o global soma tudo daquela natureza. O mesmo lançamento conta nos
   * dois, e é isso mesmo — o sub-teto é um recorte legítimo do teto maior.
   *
   * Transferência e categoria não analítica ficam de fora por construção.
   */
  private async carregarComRealizado(
    c: PoolClient,
    tenantId: string,
    competencia: string,
    apenasId?: string,
  ): Promise<Planejamento[]> {
    const r = await c.query<{
      id: string
      competencia: Date
      categoria_id: string | null
      valor_centavos: string
      alertas_percentuais: number[]
      realizado: string
    }>(
      `WITH p AS (
         SELECT id, competencia, categoria_id, valor_centavos, alertas_percentuais,
                (valor_centavos < 0) AS eh_teto
           FROM planejamentos
          WHERE tenant_id = $1 AND competencia = $2::date AND deleted_at IS NULL
            AND ($3::uuid IS NULL OR id = $3)
       )
       SELECT p.id, p.competencia, p.categoria_id, p.valor_centavos, p.alertas_percentuais,
              coalesce((
                SELECT sum(l.valor_centavos)
                  FROM lancamentos l
                  JOIN categorias cat
                    ON cat.id = l.categoria_id AND cat.tenant_id = l.tenant_id
                 WHERE l.tenant_id = $1
                   AND l.deleted_at IS NULL
                   -- Transferência nunca entra: ela não é receita nem despesa.
                   AND l.transfer_group_id IS NULL
                   -- Categoria não analítica fica fora de todo planejamento.
                   AND cat.analitica
                   -- A partição é por **natureza da categoria**, e não pelo
                   -- sinal do lançamento.
                   AND cat.natureza = CASE WHEN p.eh_teto THEN 'despesa'::natureza_de_categoria
                                           ELSE 'receita'::natureza_de_categoria END
                   -- Base temporal "data da parcela": o realizado de um
                   -- planejamento usa sempre posted_at, independentemente da
                   -- preferência de relatório do usuário.
                   AND l.posted_at >= p.competencia::timestamptz
                   AND l.posted_at < (p.competencia + interval '1 month')::timestamptz
                   -- O escopo agrega para baixo: a raiz soma as filhas, e o
                   -- global soma tudo.
                   AND (p.categoria_id IS NULL
                        OR cat.id = p.categoria_id
                        OR cat.parent_id = p.categoria_id)
              ), 0)::text AS realizado
         FROM p
        ORDER BY p.categoria_id NULLS FIRST, p.valor_centavos`,
      [tenantId, competencia, apenasId ?? null],
    )

    return r.rows.map((l): Planejamento => {
      const valor = dinheiro(BigInt(l.valor_centavos), 'BRL')
      const realizado = dinheiro(BigInt(l.realizado), 'BRL')

      return {
        id: l.id,
        competencia: diaCivil(l.competencia).slice(0, 7),
        categoriaId: l.categoria_id,
        valorCentavos: l.valor_centavos,
        realizadoCentavos: l.realizado,
        natureza: naturezaDoValor(valor),
        // Derivados no domínio, nunca em SQL: a razão truncada e o terceiro
        // estado são exatamente onde a versão anterior errou, e a regra existe
        // testada num lugar só.
        consumoBp: consumoEmBp(realizado, valor),
        estado: estadoDoPlanejamento(realizado, valor),
        alertasPercentuais: l.alertas_percentuais,
      }
    })
  }

  /** categoria → mãe. Só o que a precedência precisa. */
  private async arvoreDeCategorias(
    c: PoolClient,
    tenantId: string,
  ): Promise<Map<string, string | null>> {
    const r = await c.query<{ id: string; parent_id: string | null }>(
      'SELECT id, parent_id FROM categorias WHERE tenant_id = $1 AND deleted_at IS NULL',
      [tenantId],
    )
    return new Map(r.rows.map((l) => [l.id, l.parent_id]))
  }

  private traduzir(erro: unknown): Error {
    if (erro instanceof NotFoundException || erro instanceof BadRequestException) return erro

    const t = String((erro as { message?: string }).message ?? '')

    if (t.includes('planejamento_por_categoria') || t.includes('planejamento_global')) {
      return new ConflictException(
        'Já existe um planejamento deste tipo para esta categoria neste mês. ' +
          'Edite o que existe em vez de criar outro.',
      )
    }
    if (t.includes('TETO_DE_DESPESA_TEM_VALOR_NEGATIVO'))
      return new BadRequestException('Teto de despesa se informa com valor negativo.')
    if (t.includes('PISO_DE_RECEITA_TEM_VALOR_POSITIVO'))
      return new BadRequestException('Piso de receita se informa com valor positivo.')
    if (t.includes('CATEGORIA_NAO_ANALITICA_NAO_SE_PLANEJA'))
      return new BadRequestException(
        'Esta categoria não entra em planejamento: ela registra correção de saldo, não gasto.',
      )
    if (t.includes('CATEGORIA_INEXISTENTE'))
      return new BadRequestException('Categoria não encontrada.')
    if (t.includes('ALERTA_FORA_DO_INTERVALO'))
      return new BadRequestException('Os alertas precisam estar entre 1% e 1000%.')
    if (t.includes('valor_nao_zero'))
      return new BadRequestException('O valor do planejamento não pode ser zero.')

    return erro as Error
  }
}

/**
 * Coluna `DATE` volta do driver como `Date` à meia-noite **UTC**: o dia já é
 * civil e só precisa ser lido de volta. Convertê-la de fuso a jogaria para o
 * dia anterior.
 */
function diaCivil(d: Date): string {
  const doisDigitos = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${doisDigitos(d.getUTCMonth() + 1)}-${doisDigitos(d.getUTCDate())}`
}
