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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import {
  zCriarEstorno,
  zCriarLancamento,
  zCriarTransferencia,
  type Lancamento,
  type Resumo,
} from '@mavia/contracts'
import { resumoDoPeriodo } from '@mavia/domain'
import type { FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { baldesDoPeriodo } from '../agregacao/agregacao.js'
import { AutorizacaoGuard } from '../autorizacao/autorizacao.guard.js'
import { POOL } from '../contas/contas.controller.js'
import { comTenant } from '../tenancy/tenancy.js'
import * as repositorio from './lancamentos.repositorio.js'

@Controller('v1/lancamentos')
@UseGuards(AutorizacaoGuard)
export class LancamentosController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  private contexto(req: FastifyRequest) {
    const a = req.autenticado
    if (!a) throw new BadRequestException('Contexto ausente.')
    return { usuarioId: a.usuarioId, tenantId: a.tenantId }
  }

  /** Janela semiaberta `[de, ate)`, como toda janela do domínio. */
  private janela(query: Record<string, unknown>): { de: Date; ate: Date } {
    const de = new Date(String(query['de'] ?? ''))
    const ate = new Date(String(query['ate'] ?? ''))
    if (Number.isNaN(de.getTime()) || Number.isNaN(ate.getTime())) {
      throw new BadRequestException('Informe o período em `de` e `ate`, em ISO 8601.')
    }
    if (ate.getTime() <= de.getTime()) {
      throw new BadRequestException('O fim do período precisa ser posterior ao início.')
    }
    return { de, ate }
  }

  @Get()
  async listar(
    @Req() req: FastifyRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<{ itens: Lancamento[] }> {
    const ctx = this.contexto(req)
    const janela = this.janela(query)
    const agora = new Date()
    const itens = await comTenant(this.pool, ctx, (c) =>
      repositorio.listar(c, ctx.tenantId, janela, agora),
    )
    return { itens }
  }

  /**
   * O resumo do período — os sete baldes e os dois totais.
   *
   * Passa pelo módulo de agregação, como toda soma monetária do sistema. É a
   * rota onde a igualdade "somar todas as páginas dá o resumo" vale, porque a
   * soma acontece sobre o recorte inteiro e não sobre a página.
   */
  @Get('resumo')
  async resumo(
    @Req() req: FastifyRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<Resumo> {
    const ctx = this.contexto(req)
    const janela = this.janela(query)
    const contaId = typeof query['contaId'] === 'string' ? query['contaId'] : undefined

    // O eixo é obrigatório, sem padrão. "Toda agregação nomeia o eixo"
    // (`CONTEXT.md`) vale também na borda: um padrão silencioso aqui seria o
    // caminho de volta para o defeito RP-4, agora escondido no cliente.
    const eixo = query['eixo']
    if (eixo !== 'caixa' && eixo !== 'competencia') {
      throw new BadRequestException(
        'Informe `eixo=caixa` para saldo, ou `eixo=competencia` para relatório.',
      )
    }

    const baldes = await comTenant(this.pool, ctx, (c) =>
      baldesDoPeriodo(c, {
        eixo,
        tenantId: ctx.tenantId,
        de: janela.de,
        ate: janela.ate,
        ...(contaId ? { contaId } : {}),
        moeda: 'BRL',
        agora: new Date(),
      }),
    )

    const r = resumoDoPeriodo(baldes)
    if (!r.ok) throw new ConflictException('Não foi possível somar o período.')

    const c = (m: { centavos: bigint }) => m.centavos.toString()
    return {
      saldoAnterior: c(r.valor.saldoAnterior),
      receitaRealizada: c(r.valor.receitaRealizada),
      receitaPrevista: c(r.valor.receitaPrevista),
      despesaRealizada: c(r.valor.despesaRealizada),
      despesaPrevista: c(r.valor.despesaPrevista),
      transferenciaLiquidaRealizada: c(r.valor.transferenciaLiquidaRealizada),
      transferenciaLiquidaPrevista: c(r.valor.transferenciaLiquidaPrevista),
      saldo: c(r.valor.saldo),
      projetado: c(r.valor.projetado),
    }
  }

  @Get(':id')
  async porId(@Req() req: FastifyRequest, @Param('id') id: string): Promise<Lancamento> {
    const ctx = this.contexto(req)
    const l = await comTenant(this.pool, ctx, (c) =>
      repositorio.buscarPorId(c, ctx.tenantId, id, new Date()),
    )
    if (!l) throw new NotFoundException('Lançamento não encontrado.')
    return l
  }

  @Post()
  @HttpCode(201)
  async criar(@Req() req: FastifyRequest, @Body() corpo: unknown): Promise<Lancamento> {
    const ctx = this.contexto(req)
    const analise = zCriarLancamento.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))

    try {
      return await comTenant(this.pool, ctx, (c) =>
        repositorio.criar(c, ctx.tenantId, ctx.usuarioId, analise.data, new Date()),
      )
    } catch (erro) {
      throw this.traduzir(erro)
    }
  }

  /**
   * A transferência é criada **inteira**, com as duas pernas, ou não é criada.
   * Não existe rota que crie uma perna.
   */
  @Post('transferencias')
  @HttpCode(201)
  async transferir(
    @Req() req: FastifyRequest,
    @Body() corpo: unknown,
  ): Promise<{ pernas: Lancamento[] }> {
    const ctx = this.contexto(req)
    const analise = zCriarTransferencia.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))

    try {
      const pernas = await comTenant(this.pool, ctx, (c) =>
        repositorio.criarTransferencia(c, ctx.tenantId, ctx.usuarioId, analise.data, new Date()),
      )
      return { pernas }
    } catch (erro) {
      throw this.traduzir(erro)
    }
  }

  @Post(':id/estornos')
  @HttpCode(201)
  async estornar(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() corpo: unknown,
  ): Promise<Lancamento> {
    const ctx = this.contexto(req)
    const analise = zCriarEstorno.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))

    try {
      return await comTenant(this.pool, ctx, (c) =>
        repositorio.estornar(c, ctx.tenantId, ctx.usuarioId, id, analise.data, new Date()),
      )
    } catch (erro) {
      throw this.traduzir(erro)
    }
  }

  /**
   * Traduz erro de domínio e de banco para status HTTP.
   *
   * As mensagens do gatilho são nomeadas de propósito: elas viram texto que o
   * usuário entende, em vez de "violação de restrição" com nome de tabela.
   */
  private traduzir(erro: unknown): Error {
    if (erro instanceof repositorio.ContaInexistente) return new NotFoundException(erro.message)
    if (erro instanceof repositorio.LancamentoInexistente)
      return new NotFoundException(erro.message)
    if (erro instanceof repositorio.EstornoExcedeOriginal)
      return new ConflictException(erro.message)

    const texto = String((erro as { message?: string }).message ?? '')
    if (texto.includes('DESPESA_TEM_SINAL_NEGATIVO'))
      return new BadRequestException('Categoria de despesa exige valor negativo.')
    if (texto.includes('RECEITA_TEM_SINAL_POSITIVO'))
      return new BadRequestException('Categoria de receita exige valor positivo.')
    if (texto.includes('CATEGORIA_NAO_ANALITICA'))
      return new BadRequestException('Escolha uma subcategoria — categorias-mãe não recebem lançamento.')
    if (texto.includes('TRANSFERENCIA_ENTRE_CONTAS_DISTINTAS'))
      return new BadRequestException('Origem e destino precisam ser contas diferentes.')
    if (texto.includes('valor_nao_zero'))
      return new BadRequestException('O valor não pode ser zero.')

    return erro as Error
  }
}
