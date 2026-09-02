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
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import { zCriarCartao, zPagarFatura, type Cartao, type Fatura } from '@mavia/contracts'
import { faturaAlvo, janelaDaFatura, vencimentoDaFatura, type Competencia } from '@mavia/domain'
import type { FastifyRequest } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { AutorizacaoGuard } from '../autorizacao/autorizacao.guard.js'
import { POOL } from '../contas/contas.controller.js'
import { comTenant } from '../tenancy/tenancy.js'

interface LinhaCartao {
  readonly id: string
  readonly nome: string
  readonly limite_centavos: string
  readonly closing_day: number
  readonly due_day: number
  readonly conta_pagamento_id: string | null
  readonly moeda: Cartao['moeda']
}

interface LinhaFatura {
  readonly id: string
  readonly cartao_id: string
  readonly competencia: Date
  readonly data_fechamento: Date
  readonly data_vencimento: Date
  readonly estado: Fatura['estado']
  readonly total_centavos: string
  readonly pago_centavos: string
}

const dia = (d: Date): string => d.toISOString().slice(0, 10)

@Controller('v1/cartoes')
@UseGuards(AutorizacaoGuard)
export class CartoesController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  private contexto(req: FastifyRequest) {
    const a = req.autenticado
    if (!a) throw new BadRequestException('Contexto ausente.')
    return { usuarioId: a.usuarioId, tenantId: a.tenantId }
  }

  @Get()
  async listar(@Req() req: FastifyRequest): Promise<{ itens: Cartao[] }> {
    const ctx = this.contexto(req)
    const itens = await comTenant(this.pool, ctx, async (c) => {
      const r = await c.query<LinhaCartao>(
        `SELECT id, nome, limite_centavos, closing_day, due_day, conta_pagamento_id, moeda
           FROM cartoes WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY nome`,
        [ctx.tenantId],
      )
      return r.rows.map((l) => ({
        id: l.id,
        nome: l.nome,
        limiteCentavos: l.limite_centavos,
        closingDay: l.closing_day,
        dueDay: l.due_day,
        contaPagamentoId: l.conta_pagamento_id,
        moeda: l.moeda,
      }))
    })
    return { itens }
  }

  @Post()
  @HttpCode(201)
  async criar(@Req() req: FastifyRequest, @Body() corpo: unknown): Promise<Cartao> {
    const ctx = this.contexto(req)
    const analise = zCriarCartao.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    return comTenant(this.pool, ctx, async (c) => {
      const r = await c.query<LinhaCartao>(
        `INSERT INTO cartoes (tenant_id, nome, limite_centavos, closing_day, due_day,
                              conta_pagamento_id, moeda)
         VALUES ($1,$2,$3,$4,$5,$6,'BRL')
         RETURNING id, nome, limite_centavos, closing_day, due_day, conta_pagamento_id, moeda`,
        [
          ctx.tenantId,
          d.nome,
          d.limiteCentavos,
          d.closingDay,
          d.dueDay,
          d.contaPagamentoId ?? null,
        ],
      )
      const l = r.rows[0]
      if (!l) throw new ConflictException('Não foi possível criar o cartão.')
      return {
        id: l.id,
        nome: l.nome,
        limiteCentavos: l.limite_centavos,
        closingDay: l.closing_day,
        dueDay: l.due_day,
        contaPagamentoId: l.conta_pagamento_id,
        moeda: l.moeda,
      }
    })
  }

  @Get(':id/faturas')
  async faturas(
    @Req() req: FastifyRequest,
    @Param('id') cartaoId: string,
  ): Promise<{ itens: Fatura[] }> {
    const ctx = this.contexto(req)
    const itens = await comTenant(this.pool, ctx, async (c) => {
      const r = await c.query<LinhaFatura>(
        `SELECT id, cartao_id, competencia, data_fechamento, data_vencimento,
                estado, total_centavos, pago_centavos
           FROM faturas
          WHERE tenant_id = $1 AND cartao_id = $2 AND deleted_at IS NULL
          ORDER BY competencia DESC`,
        [ctx.tenantId, cartaoId],
      )
      return r.rows.map(
        (l): Fatura => ({
          id: l.id,
          cartaoId: l.cartao_id,
          competencia: dia(l.competencia),
          dataFechamento: dia(l.data_fechamento),
          dataVencimento: dia(l.data_vencimento),
          estado: l.estado,
          totalCentavos: l.total_centavos,
          pagoCentavos: l.pago_centavos,
        }),
      )
    })
    return { itens }
  }

  /**
   * Abre a fatura de uma competência, se ainda não existir.
   *
   * A janela vem do domínio — `janelaDaFatura` —, e não de aritmética escrita
   * aqui. Se as duas divergissem, existiria compra que some ou que é cobrada
   * duas vezes, e a divergência só apareceria no mês seguinte.
   */
  @Post(':id/faturas')
  @HttpCode(201)
  async abrirFatura(
    @Req() req: FastifyRequest,
    @Param('id') cartaoId: string,
    @Body() corpo: unknown,
  ): Promise<Fatura> {
    const ctx = this.contexto(req)
    const competencia = this.competenciaDoCorpo(corpo)

    return comTenant(this.pool, ctx, async (c) => {
      const cartao = await this.carregarCartao(c, ctx.tenantId, cartaoId)
      const janela = janelaDaFatura(cartao, competencia)
      const venc = vencimentoDaFatura(cartao, competencia)
      const fecha = new Date(janela.fim.getTime() - 1)

      const r = await c.query<LinhaFatura>(
        `INSERT INTO faturas (tenant_id, cartao_id, periodo_inicio, periodo_fim,
                              data_fechamento, data_vencimento, competencia, conta_pagamento_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING
         RETURNING id, cartao_id, competencia, data_fechamento, data_vencimento,
                   estado, total_centavos, pago_centavos`,
        [
          ctx.tenantId,
          cartaoId,
          janela.inicio,
          janela.fim,
          dia(fecha),
          `${venc.ano}-${String(venc.mes).padStart(2, '0')}-${String(venc.dia).padStart(2, '0')}`,
          `${venc.ano}-${String(venc.mes).padStart(2, '0')}-01`,
          cartao.contaPagamentoId,
        ],
      )
      const l = r.rows[0]
      if (!l) throw new ConflictException('Esta fatura já existe.')
      return {
        id: l.id,
        cartaoId: l.cartao_id,
        competencia: dia(l.competencia),
        dataFechamento: dia(l.data_fechamento),
        dataVencimento: dia(l.data_vencimento),
        estado: l.estado,
        totalCentavos: l.total_centavos,
        pagoCentavos: l.pago_centavos,
      }
    })
  }

  @Post('faturas/:faturaId/fechar')
  @HttpCode(200)
  async fechar(
    @Req() req: FastifyRequest,
    @Param('faturaId') faturaId: string,
  ): Promise<{ totalCentavos: string }> {
    const ctx = this.contexto(req)
    try {
      const total = await comTenant(this.pool, ctx, async (c) => {
        const r = await c.query<{ total: string }>('SELECT fechar_fatura($1,$2)::text AS total', [
          ctx.tenantId,
          faturaId,
        ])
        return r.rows[0]?.total ?? '0'
      })
      return { totalCentavos: total }
    } catch (erro) {
      throw this.traduzir(erro)
    }
  }

  /**
   * Pagar a fatura é **uma transferência**, não uma despesa.
   *
   * Contá-la como despesa duplicaria o gasto do mês — o erro clássico desta
   * categoria de produto. As duas pernas nascem juntas, e a do cartão nunca
   * aponta para a fatura: se apontasse, zeraria o total dela.
   */
  @Post('faturas/:faturaId/pagamentos')
  @HttpCode(201)
  async pagar(
    @Req() req: FastifyRequest,
    @Param('faturaId') faturaId: string,
    @Body() corpo: unknown,
  ): Promise<{ estado: Fatura['estado'] }> {
    const ctx = this.contexto(req)
    const analise = zPagarFatura.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data
    const quando = new Date(d.pagoEm)

    try {
      const estado = await comTenant(this.pool, ctx, async (c) => {
        const fatura = await c.query<{ cartao_id: string; conta_pagamento_id: string | null }>(
          `SELECT cartao_id, conta_pagamento_id FROM faturas
            WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [ctx.tenantId, faturaId],
        )
        const f = fatura.rows[0]
        if (!f) throw new NotFoundException('Fatura não encontrada.')

        const contaId = d.contaId ?? f.conta_pagamento_id
        if (!contaId) {
          throw new BadRequestException('Informe a conta que paga esta fatura.')
        }

        // O vínculo pagamento ↔ fatura é `transferencias.fatura_id`, e só ele.
        const g = await c.query<{ id: string }>(
          `INSERT INTO transferencias (tenant_id, tipo, fatura_id, descricao, criado_por)
           VALUES ($1,'pagamento_fatura',$2,'Pagamento de fatura',$3) RETURNING id`,
          [ctx.tenantId, faturaId, ctx.usuarioId],
        )
        const grupo = g.rows[0]?.id
        if (!grupo) throw new ConflictException('Não foi possível registrar o pagamento.')

        const magnitude = BigInt(d.valorCentavos)
        await c.query(
          `INSERT INTO lancamentos (tenant_id, conta_id, valor_centavos, moeda, posted_at,
                                    settled_at, descricao, transfer_group_id, criado_por)
           VALUES ($1,$2,$3,'BRL',$4,$4,'Pagamento de fatura',$5,$6)`,
          [ctx.tenantId, contaId, (-magnitude).toString(), quando, grupo, ctx.usuarioId],
        )
        await c.query(
          `INSERT INTO lancamentos (tenant_id, cartao_id, valor_centavos, moeda, posted_at,
                                    settled_at, descricao, transfer_group_id, criado_por)
           VALUES ($1,$2,$3,'BRL',$4,$4,'Pagamento de fatura',$5,$6)`,
          [ctx.tenantId, f.cartao_id, magnitude.toString(), quando, grupo, ctx.usuarioId],
        )

        const r = await c.query<{ estado: Fatura['estado'] }>(
          'SELECT registrar_pagamento_de_fatura($1,$2,$3,$4) AS estado',
          [ctx.tenantId, faturaId, d.valorCentavos, quando],
        )
        return r.rows[0]!.estado
      })
      return { estado }
    } catch (erro) {
      throw this.traduzir(erro)
    }
  }

  private competenciaDoCorpo(corpo: unknown): Competencia {
    const c = corpo as { ano?: unknown; mes?: unknown }
    const ano = Number(c?.ano)
    const mes = Number(c?.mes)
    if (!Number.isInteger(ano) || !Number.isInteger(mes) || mes < 1 || mes > 12) {
      throw new BadRequestException('Informe `ano` e `mes` da competência.')
    }
    return { ano, mes }
  }

  private async carregarCartao(
    c: PoolClient,
    tenantId: string,
    cartaoId: string,
  ): Promise<{ closingDay: number; dueDay: number; contaPagamentoId: string | null }> {
    const r = await c.query<{
      closing_day: number
      due_day: number
      conta_pagamento_id: string | null
    }>(
      `SELECT closing_day, due_day, conta_pagamento_id FROM cartoes
        WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [tenantId, cartaoId],
    )
    const l = r.rows[0]
    if (!l) throw new NotFoundException('Cartão não encontrado.')
    return {
      closingDay: l.closing_day,
      dueDay: l.due_day,
      contaPagamentoId: l.conta_pagamento_id,
    }
  }

  /** Traduz as mensagens nomeadas do banco para texto que o usuário entende. */
  private traduzir(erro: unknown): Error {
    if (erro instanceof NotFoundException || erro instanceof BadRequestException) return erro

    const t = String((erro as { message?: string }).message ?? '')
    if (t.includes('FATURA_JA_FECHADA')) return new ConflictException('Esta fatura já foi fechada.')
    if (t.includes('FATURA_AINDA_ABERTA'))
      return new ConflictException('Feche a fatura antes de registrar o pagamento.')
    if (t.includes('FATURA_JA_PAGA')) return new ConflictException('Esta fatura já está paga.')
    if (t.includes('PAGAMENTO_EXCEDE_A_FATURA'))
      return new BadRequestException('O pagamento passa do valor da fatura.')
    if (t.includes('FATURA_INEXISTENTE')) return new NotFoundException('Fatura não encontrada.')
    if (t.includes('FATURA_FECHADA_NAO_RECEBE'))
      return new ConflictException('Esta fatura já fechou e não recebe lançamento novo.')
    return erro as Error
  }
}

export { faturaAlvo }
