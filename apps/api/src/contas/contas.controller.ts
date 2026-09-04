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
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import { zCriarConta, type Conta, type ListaDeContas } from '@mavia/contracts'
import type { FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { AutorizacaoGuard } from '../autorizacao/autorizacao.guard.js'
import { comTenant, contextoDoTenant } from '../tenancy/tenancy.js'
import * as repositorio from './contas.repositorio.js'

export const POOL = Symbol('POOL')

@Controller('v1/contas')
@UseGuards(AutorizacaoGuard)
export class ContasController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  private contexto(req: FastifyRequest) {
    const a = req.autenticado
    if (!a) throw new BadRequestException('Contexto ausente.')
    return contextoDoTenant(a.usuarioId, a.tenantId)
  }

  @Get()
  async listar(@Req() req: FastifyRequest): Promise<ListaDeContas> {
    const ctx = this.contexto(req)
    const itens = await comTenant(this.pool, ctx, (c) => repositorio.listar(c, ctx.tenantId))
    return { itens }
  }

  @Get(':id')
  async porId(@Req() req: FastifyRequest, @Param('id') id: string): Promise<Conta> {
    const ctx = this.contexto(req)
    const conta = await comTenant(this.pool, ctx, (c) =>
      repositorio.buscarPorId(c, ctx.tenantId, id),
    )
    // 404 e não 403: dizer "existe, mas não é sua" já entrega a existência de
    // um recurso de outro cliente.
    if (!conta) throw new NotFoundException('Conta não encontrada.')
    return conta
  }

  @Post()
  @HttpCode(201)
  async criar(@Req() req: FastifyRequest, @Body() corpo: unknown): Promise<Conta> {
    const ctx = this.contexto(req)
    // Validação na borda, com o schema de `packages/contracts`. Nada entra no
    // domínio sem parse (`CLAUDE.md` §6).
    const analise = zCriarConta.safeParse(corpo)
    if (!analise.success) {
      throw new BadRequestException(analise.error.issues.map((i) => i.message))
    }
    return comTenant(this.pool, ctx, (c) => repositorio.criar(c, ctx.tenantId, analise.data))
  }

  @Delete(':id')
  @HttpCode(204)
  async arquivar(@Req() req: FastifyRequest, @Param('id') id: string): Promise<void> {
    const ctx = this.contexto(req)
    let ok: boolean
    try {
      ok = await comTenant(this.pool, ctx, (c) => repositorio.arquivar(c, ctx.tenantId, id))
    } catch (erro) {
      // Um Objetivo ancorado bloqueia a exclusão da Conta (ADR 0009,
      // invariante 10). A mensagem **nomeia** o objetivo: "não é possível
      // excluir" sem dizer o quê deixa a pessoa procurando o que a segura.
      const t = String((erro as { message?: string }).message ?? '')
      const objetivo = /CONTA_TEM_OBJETIVO: (.+)$/m.exec(t)?.[1]
      if (objetivo) {
        throw new ConflictException(
          `Esta conta está ancorada no objetivo "${objetivo.trim()}". ` +
            'Exclua o objetivo antes — o progresso dele é o saldo desta conta.',
        )
      }
      throw erro
    }
    if (!ok) throw new NotFoundException('Conta não encontrada.')
  }
}
