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
  zAlterarObjetivo,
  zCriarObjetivo,
  zVincularAporte,
  type Objetivo,
} from '@mavia/contracts'
import {
  consumoDoObjetivoEmBp,
  dataCivilDe,
  dinheiro,
  estadoDoObjetivo,
  prazoValido,
} from '@mavia/domain'
import type { FastifyRequest } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { AutorizacaoGuard } from '../autorizacao/autorizacao.guard.js'
import { POOL } from '../contas/contas.controller.js'
import { comTenant } from '../tenancy/tenancy.js'

/**
 * Objetivo — acúmulo plurimensal com prazo.
 *
 * **Nenhuma rota aqui escreve em `lancamentos`.** Objetivo observa dinheiro que
 * se moveu; um objetivo que criasse lançamento para completar o alvo inventaria
 * patrimônio. Vincular um aporte grava uma linha em `aportes` e não toca em
 * nada do lançamento — nem valor, nem categoria, nem estado (invariante 12).
 *
 * `concluido_em` também não se escreve daqui. Quem grava é o gatilho do banco,
 * na transação que altera o progresso — ver a migration 0017.
 */
@Controller('v1/objetivos')
@UseGuards(AutorizacaoGuard)
export class ObjetivosController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  private contexto(req: FastifyRequest) {
    const a = req.autenticado
    if (!a) throw new BadRequestException('Contexto ausente.')
    return { usuarioId: a.usuarioId, tenantId: a.tenantId }
  }

  @Get()
  async listar(@Req() req: FastifyRequest): Promise<{ itens: Objetivo[] }> {
    const ctx = this.contexto(req)
    const itens = await comTenant(this.pool, ctx, (c) => this.carregar(c, ctx.tenantId))
    return { itens }
  }

  @Post()
  @HttpCode(201)
  async criar(@Req() req: FastifyRequest, @Body() corpo: unknown): Promise<Objetivo> {
    const ctx = this.contexto(req)
    const analise = zCriarObjetivo.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    if (BigInt(d.valorAlvoCentavos) <= 0n) {
      throw new BadRequestException('O alvo de um objetivo é um valor positivo.')
    }
    this.exigirPrazoFuturo(d.prazo)

    if (d.contaId == null && d.saldoBaseCentavos != null) {
      throw new BadRequestException(
        'Saldo base só existe em objetivo ancorado numa conta. Sem conta, o progresso é a soma dos aportes.',
      )
    }

    try {
      return await comTenant(this.pool, ctx, async (c) => {
        // O marco é capturado **aqui**, na criação, e persistido. Derivá-lo de
        // uma data faria o progresso mudar sozinho quando o passado fosse
        // completado por uma importação.
        const saldoBase =
          d.contaId == null
            ? null
            : (d.saldoBaseCentavos ?? (await this.saldoDaConta(c, ctx.tenantId, d.contaId)))

        const r = await c.query<{ id: string }>(
          `INSERT INTO objetivos (tenant_id, nome, valor_alvo_centavos, prazo, conta_id,
                                  saldo_base_centavos, criado_por)
           VALUES ($1, $2, $3, $4::date, $5, $6, $7)
           RETURNING id`,
          [
            ctx.tenantId,
            d.nome,
            d.valorAlvoCentavos,
            d.prazo ?? null,
            d.contaId ?? null,
            saldoBase,
            ctx.usuarioId,
          ],
        )
        const id = r.rows[0]?.id
        if (!id) throw new ConflictException('Não foi possível criar o objetivo.')

        // Um objetivo ancorado pode já nascer concluído — marco zero numa conta
        // que já tem o alvo. A travessia é do banco, então basta reavaliar.
        await c.query('SELECT reavaliar_objetivo($1, FALSE)', [id])

        const criado = (await this.carregar(c, ctx.tenantId, id))[0]
        if (!criado) throw new ConflictException('Não foi possível ler o objetivo criado.')
        return criado
      })
    } catch (erro) {
      throw this.traduzir(erro)
    }
  }

  /**
   * Alterar nome, alvo ou prazo.
   *
   * `conta_id` não está na lista: o modo de apuração é decidido na criação. O
   * banco também recusa, e a recusa lá é a que vale.
   */
  @Patch(':id')
  async alterar(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() corpo: unknown,
  ): Promise<Objetivo> {
    const ctx = this.contexto(req)
    const analise = zAlterarObjetivo.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    if (d.valorAlvoCentavos !== undefined && BigInt(d.valorAlvoCentavos) <= 0n) {
      throw new BadRequestException('O alvo de um objetivo é um valor positivo.')
    }
    if (d.prazo != null) this.exigirPrazoFuturo(d.prazo)

    try {
      return await comTenant(this.pool, ctx, async (c) => {
        const r = await c.query<{ id: string }>(
          `UPDATE objetivos
              SET nome = coalesce($3, nome),
                  valor_alvo_centavos = coalesce($4, valor_alvo_centavos),
                  prazo = CASE WHEN $5::boolean THEN $6::date ELSE prazo END,
                  atualizado_em = now()
            WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
            RETURNING id`,
          [
            ctx.tenantId,
            id,
            d.nome ?? null,
            d.valorAlvoCentavos ?? null,
            d.prazo !== undefined,
            d.prazo ?? null,
          ],
        )
        if (!r.rows[0]) throw new NotFoundException('Objetivo não encontrado.')

        // A travessia por redefinição do alvo é do gatilho `objetivo_alvo_mudou`,
        // que já disparou dentro do `UPDATE` acima. Aqui só se lê o resultado.
        const atual = (await this.carregar(c, ctx.tenantId, id))[0]
        if (!atual) throw new NotFoundException('Objetivo não encontrado.')
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
      // Os aportes vão junto: eles são o vínculo, não o dado. Os lançamentos
      // ficam exatamente como estavam.
      await c.query(
        `UPDATE aportes SET deleted_at = now()
          WHERE tenant_id = $1 AND objetivo_id = $2 AND deleted_at IS NULL`,
        [ctx.tenantId, id],
      )
      const r = await c.query(
        `UPDATE objetivos SET deleted_at = now()
          WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [ctx.tenantId, id],
      )
      return (r.rowCount ?? 0) > 0
    })
    if (!apagou) throw new NotFoundException('Objetivo não encontrado.')
  }

  /**
   * Vincular um lançamento como aporte.
   *
   * O progresso passa a incluí-lo **com o sinal do domínio**: a perna positiva
   * de uma transferência para a poupança soma, e um resgate subtrai. Sem `if` e
   * sem campo de tipo.
   */
  @Post(':id/aportes')
  @HttpCode(201)
  async vincular(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() corpo: unknown,
  ): Promise<Objetivo> {
    const ctx = this.contexto(req)
    const analise = zVincularAporte.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))

    try {
      return await comTenant(this.pool, ctx, async (c) => {
        await c.query(
          `INSERT INTO aportes (tenant_id, objetivo_id, lancamento_id, criado_por)
           VALUES ($1, $2, $3, $4)`,
          [ctx.tenantId, id, analise.data.lancamentoId, ctx.usuarioId],
        )
        const atual = (await this.carregar(c, ctx.tenantId, id))[0]
        if (!atual) throw new NotFoundException('Objetivo não encontrado.')
        return atual
      })
    } catch (erro) {
      throw this.traduzir(erro)
    }
  }

  @Delete(':id/aportes/:lancamentoId')
  async desvincular(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Param('lancamentoId') lancamentoId: string,
  ): Promise<Objetivo> {
    const ctx = this.contexto(req)

    return comTenant(this.pool, ctx, async (c) => {
      const r = await c.query(
        `UPDATE aportes SET deleted_at = now()
          WHERE tenant_id = $1 AND objetivo_id = $2 AND lancamento_id = $3 AND deleted_at IS NULL`,
        [ctx.tenantId, id, lancamentoId],
      )
      if ((r.rowCount ?? 0) === 0) throw new NotFoundException('Aporte não encontrado.')

      const atual = (await this.carregar(c, ctx.tenantId, id))[0]
      if (!atual) throw new NotFoundException('Objetivo não encontrado.')
      return atual
    })
  }

  /**
   * O prazo é validado **na escrita**, e só nela.
   *
   * Um objetivo cujo prazo passou pela passagem do tempo é `vencido`, não
   * inválido — validar na leitura tornaria impossível abrir a tela de um
   * objetivo antigo.
   */
  private exigirPrazoFuturo(prazo: string | null | undefined): void {
    if (prazo == null) return
    const partes = prazo.split('-').map(Number)
    const [ano, mes, dia] = partes
    if (ano === undefined || mes === undefined || dia === undefined) {
      throw new BadRequestException('Prazo inválido.')
    }
    // "Hoje" é data civil em America/Sao_Paulo, não instante: às 21h em UTC já
    // é o dia seguinte, e o prazo de hoje seria recusado.
    if (!prazoValido({ ano, mes, dia }, dataCivilDe(new Date()))) {
      throw new BadRequestException('O prazo de um objetivo não pode estar no passado.')
    }
  }

  private async saldoDaConta(c: PoolClient, tenantId: string, contaId: string): Promise<string> {
    const r = await c.query<{ saldo: string }>(
      `SELECT (coalesce(c.saldo_inicial_centavos, 0)
             + coalesce((SELECT sum(l.valor_centavos) FROM lancamentos l
                          WHERE l.tenant_id = c.tenant_id AND l.conta_id = c.id
                            AND l.deleted_at IS NULL AND l.settled_at IS NOT NULL), 0))::text
              AS saldo
         FROM contas c
        WHERE c.tenant_id = $1 AND c.id = $2 AND c.deleted_at IS NULL`,
      [tenantId, contaId],
    )
    const saldo = r.rows[0]?.saldo
    if (saldo === undefined) throw new BadRequestException('Conta não encontrada.')
    return saldo
  }

  /**
   * O progresso vem da **mesma** função de banco que o gatilho usa para decidir
   * a travessia. Calculá-lo de novo aqui, em SQL próprio, faria a tela e a
   * conclusão discordarem por um centavo em algum caso de borda — e a
   * discordância apareceria como um objetivo em 100% que nunca conclui.
   */
  private carregar(c: PoolClient, tenantId: string, apenasId?: string): Promise<Objetivo[]> {
    return objetivosDoEspaco(c, tenantId, apenasId)
  }

  private traduzir(erro: unknown): Error {
    if (erro instanceof NotFoundException || erro instanceof BadRequestException) return erro

    const t = String((erro as { message?: string }).message ?? '')

    if (t.includes('aporte_do_lancamento')) {
      return new ConflictException(
        'Este lançamento já está vinculado a um objetivo. Um lançamento pertence a no máximo um.',
      )
    }
    if (t.includes('OBJETIVO_ANCORADO_NAO_ACEITA_APORTE')) {
      return new BadRequestException(
        'Este objetivo é ancorado numa conta: o progresso já é o saldo dela, e aceitar aportes contaria o mesmo dinheiro duas vezes.',
      )
    }
    if (t.includes('LANCAMENTO_DE_CARTAO_NAO_E_APORTE')) {
      return new BadRequestException(
        'Compra no cartão não é aporte: o dinheiro ainda não saiu, e vai sair pela fatura.',
      )
    }
    if (t.includes('LANCAMENTO_INEXISTENTE'))
      return new BadRequestException('Lançamento não encontrado.')
    if (t.includes('OBJETIVO_INEXISTENTE')) return new NotFoundException('Objetivo não encontrado.')
    if (t.includes('CONTA_INEXISTENTE')) return new BadRequestException('Conta não encontrada.')
    if (t.includes('MOEDA_DIVERGENTE'))
      return new BadRequestException('A moeda do objetivo precisa ser a mesma da conta.')
    if (t.includes('MODO_DE_APURACAO_NAO_MUDA')) {
      return new BadRequestException(
        'A conta de um objetivo não muda depois de criado. Crie outro objetivo.',
      )
    }
    if (t.includes('alvo_positivo'))
      return new BadRequestException('O alvo de um objetivo é um valor positivo.')

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


/**
 * Os objetivos do espaço, com progresso, consumo e estado apurados.
 *
 * Função de módulo pelo mesmo motivo dos planejamentos: a central de alertas
 * precisa **deste** estado, e não de um recalculado ao lado.
 */

export async function objetivosDoEspaco(
  c: PoolClient,
  tenantId: string,
  apenasId?: string,
): Promise<Objetivo[]> {
  const r = await c.query<{
    id: string
    nome: string
    valor_alvo_centavos: string
    prazo: Date | null
    conta_id: string | null
    saldo_base_centavos: string | null
    concluido_em: Date | null
    progresso: string
    aportes: string
  }>(
    `SELECT o.id, o.nome, o.valor_alvo_centavos::text, o.prazo, o.conta_id,
            o.saldo_base_centavos::text, o.concluido_em,
            progresso_do_objetivo(o.*)::text AS progresso,
            (SELECT count(*) FROM aportes a
              WHERE a.tenant_id = o.tenant_id AND a.objetivo_id = o.id
                AND a.deleted_at IS NULL)::text AS aportes
       FROM objetivos o
      WHERE o.tenant_id = $1 AND o.deleted_at IS NULL
        AND ($2::uuid IS NULL OR o.id = $2)
      ORDER BY o.concluido_em NULLS FIRST, o.prazo NULLS LAST, o.criado_em`,
    [tenantId, apenasId ?? null],
  )

  const hoje = dataCivilDe(new Date())

  return r.rows.map((l): Objetivo => {
    const alvo = dinheiro(BigInt(l.valor_alvo_centavos), 'BRL')
    const progresso = dinheiro(BigInt(l.progresso), 'BRL')
    const prazo = l.prazo === null ? null : diaCivil(l.prazo)

    return {
      id: l.id,
      nome: l.nome,
      valorAlvoCentavos: l.valor_alvo_centavos,
      prazo,
      contaId: l.conta_id,
      saldoBaseCentavos: l.saldo_base_centavos,
      progressoCentavos: l.progresso,
      // Derivados no domínio, um lugar só. O estado tem precedência
      // (concluído > vencido > ativo) e o consumo não é limitado a 100%.
      consumoBp: consumoDoObjetivoEmBp(progresso, alvo),
      estado: estadoDoObjetivo(
        {
          concluidoEm: l.concluido_em,
          prazo:
            prazo === null
              ? null
              : (() => {
                  const [ano, mes, dia] = prazo.split('-').map(Number)
                  return { ano: ano ?? 0, mes: mes ?? 0, dia: dia ?? 0 }
                })(),
        },
        hoje,
      ),
      concluidoEm: l.concluido_em?.toISOString() ?? null,
      aportes: Number(l.aportes),
    }
  })
}
