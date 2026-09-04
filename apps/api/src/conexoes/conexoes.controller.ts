import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Delete,
  Req,
  UseGuards,
} from '@nestjs/common'
import { zCriarConexao, type Conexao, type Revogacao } from '@mavia/contracts'
import type { FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { AutorizacaoGuard } from '../autorizacao/autorizacao.guard.js'
import { POOL } from '../contas/contas.controller.js'
import { GUARDIAO, type ClienteDoGuardiao } from '../guardiao/cliente.js'
import { comTenant, contextoDoTenant } from '../tenancy/tenancy.js'
import { provider } from './provider.js'
import { ConexaoInexistente, revogarConexao } from './revogacao.js'

/**
 * Conexões — a origem do dado bancário, e o fim dela.
 *
 * **Nenhum agregador está ligado.** A porta de receita do ADR 0003 não foi
 * atingida: o custo por conexão de um Pluggy só se paga com assinatura
 * recorrente em volume, e a Mavia não tem esse volume. O que existe aqui são as
 * conexões de arquivo e a manual, e a máquina completa de consentimento e
 * revogação em volta delas.
 *
 * Construir a máquina agora, e não junto com o primeiro agregador, é a decisão
 * do ADR 0018 §D0 e do ADR 0019: uma conexão criada contra um esquema sem
 * `dek_cifrada` guarda credencial em claro, e uma revogada contra um esquema sem
 * `revogacao_remota` mente ao titular. Os dois erros são irreversíveis depois do
 * primeiro usuário, e nenhum dos dois é visível em teste.
 */
@Controller('v1/conexoes')
@UseGuards(AutorizacaoGuard)
export class ConexoesController {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(GUARDIAO) private readonly guardiao: ClienteDoGuardiao,
  ) {}

  private contexto(req: FastifyRequest) {
    const a = req.autenticado
    if (!a) throw new BadRequestException('Contexto ausente.')
    return contextoDoTenant(a.usuarioId, a.tenantId)
  }

  @Get()
  async listar(@Req() req: FastifyRequest): Promise<{ itens: Conexao[] }> {
    const ctx = this.contexto(req)

    const itens = await comTenant(this.pool, ctx, async (c) => {
      const r = await c.query<{
        id: string
        provider: string
        apelido: string
        instituicao: string | null
        status: Conexao['status']
        criado_em: Date
        sincronizada_em: Date | null
        revogada_em: Date | null
        revogacao_remota: Conexao['revogacaoNoProvedor']
        lancamentos: string
      }>(
        `SELECT c.id, c.provider, c.apelido, c.instituicao, c.status, c.criado_em,
                c.sincronizada_em, c.revogada_em, c.revogacao_remota,
                contar_lancamentos(c.id) AS lancamentos
           FROM conexoes c
          WHERE c.deleted_at IS NULL
          ORDER BY c.criado_em DESC`,
      )

      return r.rows.map((l) => ({
        id: l.id,
        provider: l.provider,
        apelido: l.apelido,
        instituicao: l.instituicao,
        status: l.status,
        criadaEm: l.criado_em.toISOString(),
        sincronizadaEm: l.sincronizada_em?.toISOString() ?? null,
        revogadaEm: l.revogada_em?.toISOString() ?? null,
        revogacaoNoProvedor: l.revogacao_remota,
        lancamentos: Number(l.lancamentos),
      }))
    })

    return { itens }
  }

  /**
   * Criar a conexão e o consentimento **na mesma transação**.
   *
   * Separá-los produziria uma conexão viva sem prova de que alguém autorizou —
   * e é a prova, não a conexão, que responde à autoridade quando ela pergunta
   * por que os dados foram coletados.
   */
  @Post()
  @HttpCode(201)
  async criar(@Req() req: FastifyRequest, @Body() corpo: unknown): Promise<Conexao> {
    const ctx = this.contexto(req)
    const analise = zCriarConexao.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    const adapter = provider(d.provider)
    if (!adapter) {
      throw new BadRequestException(
        `Não existe adapter "${d.provider}". Conexão sem adapter é conexão que ninguém sabe revogar.`,
      )
    }

    // O IP entra hasheado com o pepper do guardião (achado A-39). Se o guardião
    // estiver selado, o consentimento é registrado **sem** o hash: a prova de
    // que o titular consentiu não pode depender do estado do cofre.
    const ipHash = await this.hashDoIp(req)

    return comTenant(this.pool, ctx, async (c) => {
      const nova = await c.query<{ id: string; criado_em: Date }>(
        `INSERT INTO conexoes (tenant_id, provider, apelido, instituicao, escopo, criado_por)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, criado_em`,
        [ctx.tenantId, d.provider, d.apelido, d.instituicao ?? null, JSON.stringify(d.escopo), ctx.usuarioId],
      )
      const conexao = nova.rows[0]!

      await c.query(
        `INSERT INTO consentimentos
           (tenant_id, conexao_id, usuario_id, termos_versao, escopo, finalidade, ip_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          ctx.tenantId,
          conexao.id,
          ctx.usuarioId,
          d.termosVersao,
          JSON.stringify(d.escopo),
          d.finalidade,
          ipHash,
        ],
      )

      return {
        id: conexao.id,
        provider: d.provider,
        apelido: d.apelido,
        instituicao: d.instituicao ?? null,
        status: 'ativa' as const,
        criadaEm: conexao.criado_em.toISOString(),
        sincronizadaEm: null,
        revogadaEm: null,
        revogacaoNoProvedor: null,
        lancamentos: 0,
      }
    })
  }

  /**
   * A revogação — três fases, e **dois fatos na resposta**.
   *
   * "Revogada" descreve o que a Mavia fez: destruiu a credencial, e isso é
   * incondicional e já aconteceu quando esta resposta sai.
   * `revogacaoNoProvedor` descreve o que sabemos do outro lado, que pode ser
   * "ainda não sei". Fundir os dois numa palavra só seria mentir na metade dos
   * casos, e a metade em que se mente é justamente a que importa.
   */
  @Delete(':id')
  async revogar(@Req() req: FastifyRequest, @Param('id') id: string): Promise<Revogacao> {
    const ctx = this.contexto(req)

    try {
      const desfecho = await revogarConexao(
        { pool: this.pool, guardiao: this.guardiao, adapter: provider },
        ctx,
        id,
        'titular',
      )

      return {
        status: 'revogada',
        credencialDestruida: true,
        revogacaoNoProvedor: desfecho.revogacaoNoProvedor,
        lancamentosMantidos: desfecho.lancamentosMantidos,
      }
    } catch (erro) {
      if (erro instanceof ConexaoInexistente) throw new NotFoundException('Conexão não encontrada.')
      throw erro
    }
  }

  private async hashDoIp(req: FastifyRequest): Promise<Buffer | null> {
    if (!this.guardiao.configurado) return null
    try {
      return await this.guardiao.hash('ip', Buffer.from(req.ip ?? '', 'utf8'))
    } catch {
      return null
    }
  }
}
