import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import { zAlterarCategoria, zCriarCategoria, type Categoria } from '@mavia/contracts'
import type { FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { AutorizacaoGuard } from '../autorizacao/autorizacao.guard.js'
import { POOL } from '../contas/contas.controller.js'
import { comTenant, contextoDoTenant } from '../tenancy/tenancy.js'
import * as escrita from './categorias.escrita.js'

/**
 * A árvore de categorias do espaço, inteira, numa chamada.
 *
 * **Sem paginação, de propósito.** A árvore tem dois níveis e dezenas de nós,
 * não milhares; paginá-la faria toda tela que mostra lançamento ter de juntar
 * páginas antes de conseguir escrever um nome. Se um dia um espaço tiver
 * categorias demais para uma resposta, o problema é o limite de categorias,
 * não o formato desta rota.
 */
@Controller('v1/categorias')
@UseGuards(AutorizacaoGuard)
export class CategoriasController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  private contexto(req: FastifyRequest) {
    const a = req.autenticado
    if (!a) throw new BadRequestException('Contexto ausente.')
    return contextoDoTenant(a.usuarioId, a.tenantId)
  }

  @Get()
  async listar(@Req() req: FastifyRequest): Promise<{ itens: Categoria[] }> {
    const ctx = this.contexto(req)

    const itens = await comTenant(this.pool, ctx, async (c) => {
      const r = await c.query<{
        id: string
        parent_id: string | null
        nivel: number
        nome: string
        natureza: Categoria['natureza']
        analitica: boolean
        sistema: boolean
        cor: string | null
        arquivada_em: Date | null
      }>(
        `SELECT id, parent_id, nivel, nome, natureza, analitica, sistema, cor,
                arquivada_em
           FROM categorias
          WHERE tenant_id = $1 AND deleted_at IS NULL
          -- Arquivada **entra**: lançamento antigo aponta para ela, e sem o
          -- nome a linha do extrato ficaria órfã. Quem esconde do seletor é o
          -- cliente, que tem a bandeira para isso.
          --
          -- Mãe antes de filha, e por nome dentro do nível: é a ordem em que a
          -- árvore se desenha, e evita que o cliente tenha de reordenar.
          ORDER BY nivel, nome`,
        [ctx.tenantId],
      )
      return r.rows.map(
        (l): Categoria => ({
          id: l.id,
          parentId: l.parent_id,
          nivel: l.nivel as Categoria['nivel'],
          nome: l.nome,
          natureza: l.natureza,
          analitica: l.analitica,
          arquivada: l.arquivada_em !== null,
          sistema: l.sistema,
          cor: l.cor,
        }),
      )
    })

    return { itens }
  }

  @Post()
  @HttpCode(201)
  async criar(@Req() req: FastifyRequest, @Body() corpo: unknown): Promise<Categoria> {
    const ctx = this.contexto(req)
    const analise = zCriarCategoria.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))

    return comTenant(this.pool, ctx, (c) =>
      escrita.criar(c, ctx.tenantId, {
        nome: analise.data.nome,
        natureza: analise.data.natureza,
        ...(analise.data.parentId ? { parentId: analise.data.parentId } : {}),
      }),
    )
  }

  @Patch(':id')
  async alterar(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() corpo: unknown,
  ): Promise<Categoria> {
    const ctx = this.contexto(req)
    const analise = zAlterarCategoria.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))

    return comTenant(this.pool, ctx, (c) =>
      escrita.alterar(c, ctx.tenantId, id, {
        ...(analise.data.nome !== undefined ? { nome: analise.data.nome } : {}),
        ...(analise.data.natureza !== undefined ? { natureza: analise.data.natureza } : {}),
      }),
    )
  }

  /**
   * Arquiva. Não existe rota que apague categoria — lançamento antigo aponta
   * para ela, e apagá-la deixaria a linha do extrato sem nome.
   */
  @Delete(':id')
  @HttpCode(204)
  async arquivar(@Req() req: FastifyRequest, @Param('id') id: string): Promise<void> {
    const ctx = this.contexto(req)
    await comTenant(this.pool, ctx, (c) => escrita.arquivar(c, ctx.tenantId, id))
  }
}
