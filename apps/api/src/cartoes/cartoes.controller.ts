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
import {
  zCriarCartao,
  zCriarCompraNoCartao,
  zPagarFatura,
  type Cartao,
  type CompraNoCartao,
  type Fatura,
} from '@mavia/contracts'
import { faturaAlvo, type Competencia } from '@mavia/domain'
import type { FastifyRequest } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { AutorizacaoGuard } from '../autorizacao/autorizacao.guard.js'
import { POOL } from '../contas/contas.controller.js'
import { comTenant, contextoDoTenant } from '../tenancy/tenancy.js'
import { abrirFatura, registrarCompra, type CartaoDaCompra } from './compras.js'

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

/**
 * As mensagens nomeadas do banco carregam o dado útil depois de `: `.
 * Sem ele, "esta fatura ainda não fechou" não diz quando, e a pessoa fica sem
 * saber se é amanhã ou daqui a três semanas.
 */
function depoisDosDoisPontos(mensagem: string): string {
  const partes = mensagem.split(': ')
  return partes.length > 1 ? partes[partes.length - 1]!.trim() : 'uma data futura'
}

/**
 * Colunas `DATE` voltam do driver como `Date` à meia-noite **UTC**: o dia já é
 * civil e só precisa ser lido de volta. Formatá-las com o conversor de fuso as
 * jogaria para o dia anterior.
 *
 * O caminho de escrita é o oposto e mora em `compras.ts`: lá o valor é um
 * instante, e `toISOString().slice(0,10)` lia o dia em UTC — gravando 26 num
 * cartão que fecha dia 25. Ressalva 1 da auditoria do épico 3.
 */
const diaCivil = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`

@Controller('v1/cartoes')
@UseGuards(AutorizacaoGuard)
export class CartoesController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  private contexto(req: FastifyRequest) {
    const a = req.autenticado
    if (!a) throw new BadRequestException('Contexto ausente.')
    return contextoDoTenant(a.usuarioId, a.tenantId)
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
      return r.rows.map((l) => this.paraContrato(l))
    })
    return { itens }
  }

  /**
   * Abre a fatura de um mês de fechamento, se ainda não existir.
   *
   * A janela vem do domínio, por `abrirFatura`. Aritmética de ciclo escrita
   * aqui seria a segunda implementação da regra, e a divergência entre as duas
   * só apareceria no mês seguinte, como compra que some.
   */
  @Post(':id/faturas')
  @HttpCode(201)
  async abrirFaturaDoCiclo(
    @Req() req: FastifyRequest,
    @Param('id') cartaoId: string,
    @Body() corpo: unknown,
  ): Promise<Fatura> {
    const ctx = this.contexto(req)
    const mesDeFechamento = this.mesDeFechamentoDoCorpo(corpo)

    return comTenant(this.pool, ctx, async (c) => {
      const cartao = await this.carregarCartao(c, ctx.tenantId, cartaoId)

      // Uma implementação só da janela e do vencimento, compartilhada com a
      // compra. Duas divergiriam, e a divergência só apareceria num extrato.
      const antes = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM faturas
          WHERE tenant_id = $1 AND cartao_id = $2 AND deleted_at IS NULL`,
        [ctx.tenantId, cartaoId],
      )
      const id = await abrirFatura(c, ctx.tenantId, cartao, mesDeFechamento)
      const depois = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM faturas
          WHERE tenant_id = $1 AND cartao_id = $2 AND deleted_at IS NULL`,
        [ctx.tenantId, cartaoId],
      )
      // A rota explícita é idempotente-hostil de propósito: quem pede para
      // abrir uma fatura que já existe está enganado sobre o estado, e um 201
      // silencioso esconderia isso. A compra, que abre por conveniência, não
      // passa por aqui.
      if (antes.rows[0]!.n === depois.rows[0]!.n) {
        throw new ConflictException('Esta fatura já existe.')
      }

      const r = await c.query<LinhaFatura>(
        `SELECT id, cartao_id, competencia, data_fechamento, data_vencimento,
                estado, total_centavos, pago_centavos
           FROM faturas WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, id],
      )
      return this.paraContrato(r.rows[0]!)
    })
  }

  /**
   * Compra no cartão, à vista ou parcelada.
   *
   * Uma requisição, N lançamentos, N faturas — abertas por conveniência se
   * ainda não existirem, porque ninguém abre fatura à mão. Tudo numa transação:
   * seis parcelas de doze é pior do que compra nenhuma.
   */
  @Post(':id/compras')
  @HttpCode(201)
  async comprar(
    @Req() req: FastifyRequest,
    @Param('id') cartaoId: string,
    @Body() corpo: unknown,
  ): Promise<CompraNoCartao> {
    const ctx = this.contexto(req)
    const analise = zCriarCompraNoCartao.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))

    try {
      return await comTenant(this.pool, ctx, async (c) => {
        const cartao = await this.carregarCartao(c, ctx.tenantId, cartaoId)
        return registrarCompra(c, ctx, cartao, analise.data)
      })
    } catch (erro) {
      throw this.traduzir(erro)
    }
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

  /**
   * `{ ano, mes }` é o **mês de fechamento**, não a competência: a competência
   * de uma fatura é o mês do vencimento, e num ciclo 25/5 os dois diferem.
   */
  private mesDeFechamentoDoCorpo(corpo: unknown): Competencia {
    const c = corpo as { ano?: unknown; mes?: unknown }
    const ano = Number(c?.ano)
    const mes = Number(c?.mes)
    if (!Number.isInteger(ano) || !Number.isInteger(mes) || mes < 1 || mes > 12) {
      throw new BadRequestException('Informe `ano` e `mes` do fechamento da fatura.')
    }
    return { ano, mes }
  }

  private async carregarCartao(
    c: PoolClient,
    tenantId: string,
    cartaoId: string,
  ): Promise<CartaoDaCompra> {
    const r = await c.query<{
      id: string
      closing_day: number
      due_day: number
      conta_pagamento_id: string | null
      moeda: Cartao['moeda']
    }>(
      `SELECT id, closing_day, due_day, conta_pagamento_id, moeda FROM cartoes
        WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [tenantId, cartaoId],
    )
    const l = r.rows[0]
    // 404 e não 403: dizer "existe, mas não é seu" já entrega a existência do
    // cartão de outro cliente. A RLS é quem faz a linha não aparecer.
    if (!l) throw new NotFoundException('Cartão não encontrado.')
    return {
      id: l.id,
      closingDay: l.closing_day,
      dueDay: l.due_day,
      contaPagamentoId: l.conta_pagamento_id,
      moeda: l.moeda,
    }
  }

  /** Uma tradução só de `LinhaFatura` para o contrato. */
  private paraContrato(l: LinhaFatura): Fatura {
    return {
      id: l.id,
      cartaoId: l.cartao_id,
      competencia: diaCivil(l.competencia),
      dataFechamento: diaCivil(l.data_fechamento),
      dataVencimento: diaCivil(l.data_vencimento),
      estado: l.estado,
      totalCentavos: l.total_centavos,
      pagoCentavos: l.pago_centavos,
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
    // As mensagens carregam a data depois de `:` — ela vai para a frase, porque
    // "ainda não fechou" sem dizer quando não ajuda ninguém a decidir o que fazer.
    if (t.includes('FATURA_AINDA_NAO_FECHOU')) {
      return new ConflictException(
        `Esta fatura fecha em ${depoisDosDoisPontos(t)} — quem fecha uma fatura é o ` +
          'ciclo do cartão, não um botão. Antes disso, ela ainda recebe compras.',
      )
    }
    if (t.includes('PAGAMENTO_ANTES_DA_COMPRA')) {
      return new BadRequestException(
        `O pagamento não pode ser anterior à última compra da fatura, de ${depoisDosDoisPontos(t)}.`,
      )
    }
    if (t.includes('FATURA_CREDORA_NAO_SE_PAGA')) {
      return new ConflictException(
        'Esta fatura está a seu favor: o cartão é que deve. O saldo entra como ' +
          'crédito na próxima fatura, e não há o que pagar.',
      )
    }
    if (t.includes('PAGAMENTO_NAO_ACONTECE_NO_FUTURO'))
      return new BadRequestException('O pagamento não pode ter data futura.')
    if (t.includes('PAGAMENTO_TEM_MAGNITUDE_POSITIVA'))
      return new BadRequestException('Informe o valor pago.')
    // As mesmas restrições de `lancamentos`: uma compra de cartão é um
    // lançamento, e o usuário merece a mesma frase nas duas rotas.
    if (t.includes('DESPESA_TEM_SINAL_NEGATIVO'))
      return new BadRequestException('Categoria de despesa exige valor negativo.')
    if (t.includes('RECEITA_TEM_SINAL_POSITIVO'))
      return new BadRequestException('Categoria de receita exige valor positivo.')
    if (t.includes('CATEGORIA_NAO_ANALITICA'))
      return new BadRequestException(
        'Escolha uma subcategoria — categorias-mãe não recebem lançamento.',
      )
    if (t.includes('valor_nao_zero')) return new BadRequestException('O valor não pode ser zero.')
    if (t.includes('FATURA_FECHADA_NAO_RECEBE'))
      return new ConflictException('Esta fatura já fechou e não recebe lançamento novo.')
    return erro as Error
  }
}

export { faturaAlvo }
