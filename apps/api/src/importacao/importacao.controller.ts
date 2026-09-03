import { createHash } from 'node:crypto'
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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import { conciliar, type Candidato } from '@mavia/domain'
import type { RegistroBruto } from '@mavia/parser'
import { z } from 'zod'
import type { FastifyRequest } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { AutorizacaoGuard } from '../autorizacao/autorizacao.guard.js'
import { POOL } from '../contas/contas.controller.js'
import { comTenant } from '../tenancy/tenancy.js'
import { detectar, provider } from './provider.js'

/**
 * Importação de extrato.
 *
 * ## Três propriedades, e todas têm teste
 *
 * 1. **Reimportar não duplica.** A chave é `(tenant, provider, external_id)` —
 *    regra 13. O segundo envio do mesmo arquivo cria zero lançamentos e diz
 *    quantos já existiam.
 * 2. **Conciliação é sugestão.** Um registro do extrato que se parece com um
 *    lançamento digitado à mão **não** o substitui: nasce uma proposta que um
 *    humano confirma. O sistema jamais apaga o registro do usuário sozinho.
 * 3. **Desfazer devolve o mês ao que era.** Apaga os lançamentos que a
 *    importação criou, libera a chave de idempotência, e não toca no que a
 *    pessoa já tinha.
 *
 * ## O que ele não faz
 *
 * Não categoriza. O registro entra na categoria de sistema `Ajuste de saldo`?
 * **Não** — essa é não-analítica e sumiria dos relatórios. Entra numa categoria
 * de importação, analítica, que a pessoa reclassifica. Categorização automática
 * é o épico 7, e fingi-la aqui produziria classificações erradas sem motivo
 * visível, que é o oposto do que o glossário exige.
 */

const zImportar = z.object({
  contaId: z.string().uuid(),
  /** Conteúdo do arquivo. Texto: quem decodifica é o cliente. */
  conteudo: z.string().min(1).max(8 * 1024 * 1024),
  nomeDoArquivo: z.string().max(260).optional(),
  provider: z.enum(['ofx-import', 'csv-import']).optional(),
  mapa: z
    .object({
      data: z.number().int().min(0),
      descricao: z.number().int().min(0),
      valor: z.number().int().min(0).optional(),
      credito: z.number().int().min(0).optional(),
      debito: z.number().int().min(0).optional(),
    })
    .optional(),
})

interface ResumoDaImportacao {
  readonly id: string
  readonly provider: string
  readonly contaId: string
  readonly nomeDoArquivo: string | null
  readonly registros: number
  readonly criados: number
  readonly repetidos: number
  readonly sugestoes: number
  readonly problemas: readonly { linha: number; motivo: string; bruto: string }[]
  readonly criadoEm: string
  readonly desfeitaEm: string | null
}

@Controller('v1/importacoes')
@UseGuards(AutorizacaoGuard)
export class ImportacaoController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  private contexto(req: FastifyRequest) {
    const a = req.autenticado
    if (!a) throw new BadRequestException('Contexto ausente.')
    return { usuarioId: a.usuarioId, tenantId: a.tenantId }
  }

  @Get()
  async listar(@Req() req: FastifyRequest): Promise<{ itens: ResumoDaImportacao[] }> {
    const ctx = this.contexto(req)
    const itens = await comTenant(this.pool, ctx, (c) => this.carregar(c, ctx.tenantId))
    return { itens }
  }

  @Post()
  @HttpCode(201)
  async importar(@Req() req: FastifyRequest, @Body() corpo: unknown): Promise<ResumoDaImportacao> {
    const ctx = this.contexto(req)
    const analise = zImportar.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    // O adapter vem do nome ou do conteúdo — nunca da extensão do arquivo, que é
    // o que o usuário renomeou.
    const adapter = d.provider ? provider(d.provider) : detectar(d.conteudo)
    if (!adapter) throw new BadRequestException('Formato não suportado.')

    const lido = await adapter.buscar({
      conteudo: d.conteudo,
      ...(d.mapa === undefined ? {} : { mapa: d.mapa as never }),
    })

    return comTenant(this.pool, ctx, async (c) => {
      const conta = await c.query<{ moeda: string }>(
        'SELECT moeda FROM contas WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL',
        [ctx.tenantId, d.contaId],
      )
      const moedaDaConta = conta.rows[0]?.moeda
      if (!moedaDaConta) throw new NotFoundException('Conta não encontrada.')

      const arquivoHash = createHash('sha256').update(d.conteudo, 'utf8').digest()

      const criada = await c.query<{ id: string }>(
        `INSERT INTO importacoes (tenant_id, conta_id, provider, nome_do_arquivo,
                                  arquivo_hash, registros, problemas, criado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id`,
        [
          ctx.tenantId,
          d.contaId,
          adapter.nome,
          d.nomeDoArquivo ?? null,
          arquivoHash,
          lido.registros.length,
          JSON.stringify(lido.problemas),
          ctx.usuarioId,
        ],
      )
      const importacaoId = criada.rows[0]!.id

      let criados = 0
      let repetidos = 0
      let sugestoes = 0

      for (const registro of lido.registros) {
        // Moeda divergente é recusa, nunca conversão silenciosa (regra 2).
        if (registro.moeda !== moedaDaConta) {
          repetidos++
          continue
        }

        const brutoId = await this.gravarBruto(c, ctx, importacaoId, d.contaId, adapter.nome, registro)
        if (!brutoId) {
          // A chave já existia: este registro já entrou numa importação
          // anterior. É o desfecho **normal** de reimportar o mesmo extrato.
          repetidos++
          continue
        }

        const sugestao = await this.sugerir(c, ctx, d.contaId, registro, brutoId)
        if (sugestao) {
          sugestoes++
          // **Não cria lançamento.** A proposta é de casar com o que já existe;
          // criar agora e desfazer depois duplicaria o mês entre a sugestão e a
          // decisão.
          continue
        }

        await this.criarLancamento(c, ctx, {
          importacaoId,
          contaId: d.contaId,
          // A categoria é escolhida pelo **sinal do registro**. Um extrato tem
          // as duas naturezas — salário e mercado chegam no mesmo arquivo — e
          // mandar tudo para uma categoria de despesa faz o gatilho de
          // coerência recusar a receita e derrubar a importação inteira.
          categoriaId: await this.categoriaDeImportacao(
            c,
            ctx.tenantId,
            registro.centavos < 0n ? 'despesa' : 'receita',
          ),
          brutoId,
          registro,
          moeda: moedaDaConta,
        })
        criados++
      }

      await c.query(
        `UPDATE importacoes SET criados = $3, repetidos = $4 WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, importacaoId, criados, repetidos],
      )

      const resumo = (await this.carregar(c, ctx.tenantId, importacaoId))[0]
      if (!resumo) throw new NotFoundException('Importação não encontrada.')
      return { ...resumo, sugestoes }
    })
  }

  /**
   * Desfazer.
   *
   * Apaga os lançamentos que **esta** importação criou e libera a chave de
   * idempotência, para que o arquivo possa ser importado de novo. Não toca em
   * lançamento que a pessoa digitou, nem em conciliação já confirmada — desfazer
   * a importação não é desfazer a decisão de um humano.
   */
  @Post(':id/desfazer')
  @HttpCode(200)
  async desfazer(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<{ apagados: number }> {
    const ctx = this.contexto(req)

    return comTenant(this.pool, ctx, async (c) => {
      const importacao = await c.query<{ id: string; desfeita_em: Date | null }>(
        'SELECT id, desfeita_em FROM importacoes WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id],
      )
      const linha = importacao.rows[0]
      if (!linha) throw new NotFoundException('Importação não encontrada.')
      if (linha.desfeita_em) throw new BadRequestException('Esta importação já foi desfeita.')

      const apagados = await c.query(
        `UPDATE lancamentos SET deleted_at = now()
          WHERE tenant_id = $1 AND importacao_id = $2 AND deleted_at IS NULL`,
        [ctx.tenantId, id],
      )

      // Sugestões pendentes desta importação perdem o objeto: descartar é o
      // desfecho honesto, e mantém o índice de "uma sugestão viva por bruto"
      // livre para uma reimportação.
      await c.query(
        `UPDATE conciliacoes SET estado = 'descartada', decidido_em = now(), decidido_por = $3
          WHERE tenant_id = $1 AND estado = 'sugerida'
            AND bruto_id IN (SELECT id FROM lancamentos_brutos
                              WHERE tenant_id = $1 AND importacao_id = $2)`,
        [ctx.tenantId, id, ctx.usuarioId],
      )

      await c.query(
        `UPDATE lancamentos_brutos SET deleted_at = now()
          WHERE tenant_id = $1 AND importacao_id = $2 AND deleted_at IS NULL`,
        [ctx.tenantId, id],
      )

      await c.query('UPDATE importacoes SET desfeita_em = now() WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ])

      return { apagados: apagados.rowCount ?? 0 }
    })
  }

  // -------------------------------------------------------------------------

  /**
   * Grava o registro cru. Devolve `null` quando a chave já existia.
   *
   * A idempotência é do **banco**, pelo índice único: conferir antes e inserir
   * depois teria uma janela entre as duas operações, e duas importações
   * simultâneas do mesmo arquivo passariam pela janela.
   */
  private async gravarBruto(
    c: PoolClient,
    ctx: { tenantId: string },
    importacaoId: string,
    contaId: string,
    providerNome: string,
    r: RegistroBruto,
  ): Promise<string | null> {
    // O hash do conteúdo **normalizado**: valor, data e descrição. Não inclui o
    // texto bruto, que muda com espaçamento sem que o fato mude.
    const conteudoHash = createHash('sha256')
      .update(`${r.centavos}|${r.data.ano}-${r.data.mes}-${r.data.dia}|${r.descricao}`, 'utf8')
      .digest()

    const saida = await c.query<{ id: string }>(
      `INSERT INTO lancamentos_brutos
         (tenant_id, importacao_id, conta_id, provider, external_id, conteudo_hash,
          data, valor_centavos, moeda, descricao, tipo, bruto)
       VALUES ($1,$2,$3,$4,$5,$6,make_date($7,$8,$9),$10,$11,$12,$13,$14)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        ctx.tenantId,
        importacaoId,
        contaId,
        providerNome,
        r.externalId,
        conteudoHash,
        r.data.ano,
        r.data.mes,
        r.data.dia,
        r.centavos.toString(),
        r.moeda,
        r.descricao,
        r.tipo,
        r.bruto,
      ],
    )
    return saida.rows[0]?.id ?? null
  }

  /**
   * Procura um lançamento manual que este registro possa estar duplicando.
   *
   * A decisão é do domínio (`conciliar`), e não deste SQL: a regra de valor
   * exato, folga de data assimétrica e empate-não-sugere é sutil, e reescrevê-la
   * aqui criaria uma segunda versão que diverge da testada.
   */
  private async sugerir(
    c: PoolClient,
    ctx: { tenantId: string },
    contaId: string,
    r: RegistroBruto,
    brutoId: string,
  ): Promise<boolean> {
    const candidatos = await c.query<{
      id: string
      valor_centavos: string
      data: Date
      descricao: string
      ja_conciliado: boolean
    }>(
      `SELECT l.id, l.valor_centavos::text, l.posted_at::date AS data, l.descricao,
              EXISTS (SELECT 1 FROM conciliacoes cc
                       WHERE cc.tenant_id = l.tenant_id AND cc.lancamento_id = l.id
                         AND cc.estado = 'confirmada') AS ja_conciliado
         FROM lancamentos l
        WHERE l.tenant_id = $1
          AND l.conta_id = $2
          AND l.deleted_at IS NULL
          -- Só o que a pessoa digitou: casar dois importados entre si não é
          -- conciliação, é deduplicação, e essa a chave de origem já resolve.
          AND l.importacao_id IS NULL
          AND l.transfer_group_id IS NULL
          AND l.valor_centavos = $3
          AND l.posted_at >= (make_date($4,$5,$6) - interval '10 days')
          AND l.posted_at <  (make_date($4,$5,$6) + interval '10 days')`,
      [ctx.tenantId, contaId, r.centavos.toString(), r.data.ano, r.data.mes, r.data.dia],
    )

    const paraODominio: Candidato[] = candidatos.rows.map((l) => ({
      id: l.id,
      centavos: BigInt(l.valor_centavos),
      data: {
        ano: l.data.getUTCFullYear(),
        mes: l.data.getUTCMonth() + 1,
        dia: l.data.getUTCDate(),
      },
      descricao: l.descricao,
      jaConciliado: l.ja_conciliado,
    }))

    const sugestao = conciliar(
      { centavos: r.centavos, data: r.data, descricao: r.descricao },
      paraODominio,
    )
    if (!sugestao) return false

    await c.query(
      `INSERT INTO conciliacoes (tenant_id, bruto_id, lancamento_id, confianca, motivo)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [ctx.tenantId, brutoId, sugestao.candidatoId, sugestao.confianca, sugestao.motivo],
    )
    return true
  }

  private async criarLancamento(
    c: PoolClient,
    ctx: { tenantId: string; usuarioId: string },
    dados: {
      importacaoId: string
      contaId: string
      categoriaId: string
      brutoId: string
      registro: RegistroBruto
      moeda: string
    },
  ): Promise<void> {
    const { registro: r } = dados

    // `settled_at` preenchido: o extrato **é** o registro de que o dinheiro se
    // moveu. É o único lugar do sistema em que a compensação vem de fora, e
    // vem legitimamente — o banco está atestando o fato (regra 8).
    const criado = await c.query<{ id: string }>(
      `INSERT INTO lancamentos (tenant_id, conta_id, categoria_id, valor_centavos, moeda,
                                posted_at, settled_at, descricao, origem, criado_por,
                                importacao_id)
       VALUES ($1,$2,$3,$4,$5,
               make_date($6,$7,$8)::timestamptz, make_date($6,$7,$8)::timestamptz,
               $9,'importado',$10,$11)
       RETURNING id`,
      [
        ctx.tenantId,
        dados.contaId,
        dados.categoriaId,
        r.centavos.toString(),
        dados.moeda,
        r.data.ano,
        r.data.mes,
        r.data.dia,
        r.descricao,
        ctx.usuarioId,
        dados.importacaoId,
      ],
    )

    await c.query('UPDATE lancamentos_brutos SET lancamento_id = $3 WHERE tenant_id = $1 AND id = $2', [
      ctx.tenantId,
      dados.brutoId,
      criado.rows[0]!.id,
    ])
  }

  /**
   * A categoria em que o importado nasce — **uma por natureza**.
   *
   * Duas, e não uma: um extrato traz salário e mercado no mesmo arquivo, e a
   * categoria carrega natureza. Mandar a receita para uma categoria de despesa
   * faz o gatilho de coerência recusar a linha e derrubar a importação inteira —
   * foi exatamente o que aconteceu na primeira execução contra um extrato real,
   * e o teste não pegou porque todas as transações dele eram negativas.
   *
   * **Analítica**, e não `Ajuste de saldo`. A não-analítica sumiria de todo
   * relatório e de todo planejamento, e o mês importado apareceria vazio — o
   * defeito mais silencioso que esta rota poderia ter.
   */
  private async categoriaDeImportacao(
    c: PoolClient,
    tenantId: string,
    natureza: 'despesa' | 'receita',
  ): Promise<string> {
    const existente = await c.query<{ id: string }>(
      `SELECT id FROM categorias
        WHERE tenant_id = $1 AND nome = 'A classificar' AND natureza = $2::natureza_de_categoria
          AND deleted_at IS NULL`,
      [tenantId, natureza],
    )
    if (existente.rows[0]) return existente.rows[0].id

    const criada = await c.query<{ id: string }>(
      `INSERT INTO categorias (tenant_id, nivel, nome, natureza, analitica, sistema)
       VALUES ($1, 1, 'A classificar', $2::natureza_de_categoria, TRUE, TRUE)
       RETURNING id`,
      [tenantId, natureza],
    )
    return criada.rows[0]!.id
  }

  private async carregar(
    c: PoolClient,
    tenantId: string,
    apenasId?: string,
  ): Promise<ResumoDaImportacao[]> {
    const r = await c.query<{
      id: string
      provider: string
      conta_id: string
      nome_do_arquivo: string | null
      registros: number
      criados: number
      repetidos: number
      problemas: { linha: number; motivo: string; bruto: string }[]
      criado_em: Date
      desfeita_em: Date | null
      sugestoes: string
    }>(
      `SELECT i.*, (SELECT count(*) FROM conciliacoes cc
                      JOIN lancamentos_brutos b ON b.id = cc.bruto_id
                     WHERE b.importacao_id = i.id AND cc.estado = 'sugerida')::text AS sugestoes
         FROM importacoes i
        WHERE i.tenant_id = $1 AND ($2::uuid IS NULL OR i.id = $2)
        ORDER BY i.criado_em DESC`,
      [tenantId, apenasId ?? null],
    )

    return r.rows.map((l) => ({
      id: l.id,
      provider: l.provider,
      contaId: l.conta_id,
      nomeDoArquivo: l.nome_do_arquivo,
      registros: l.registros,
      criados: l.criados,
      repetidos: l.repetidos,
      sugestoes: Number(l.sugestoes),
      problemas: l.problemas,
      criadoEm: l.criado_em.toISOString(),
      desfeitaEm: l.desfeita_em?.toISOString() ?? null,
    }))
  }
}

/**
 * As conciliações pendentes, e as decisões sobre elas.
 *
 * Separado do controlador de importação porque o ciclo de vida é outro: a
 * importação acaba, e a fila de conciliação continua esperando alguém.
 */
@Controller('v1/conciliacoes')
@UseGuards(AutorizacaoGuard)
export class ConciliacoesController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  private contexto(req: FastifyRequest) {
    const a = req.autenticado
    if (!a) throw new BadRequestException('Contexto ausente.')
    return { usuarioId: a.usuarioId, tenantId: a.tenantId }
  }

  @Get()
  async listar(
    @Req() req: FastifyRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<{ itens: unknown[] }> {
    const ctx = this.contexto(req)
    const estado = typeof query['estado'] === 'string' ? query['estado'] : 'sugerida'

    const itens = await comTenant(this.pool, ctx, async (c) => {
      const r = await c.query<{
        id: string
        confianca: number
        motivo: string
        estado: string
        descricao_do_extrato: string
        data_do_extrato: Date
        valor_centavos: string
        lancamento_id: string
        descricao_manual: string
        data_manual: Date
      }>(
        `SELECT cc.id, cc.confianca, cc.motivo, cc.estado,
                b.descricao AS descricao_do_extrato, b.data AS data_do_extrato,
                b.valor_centavos::text AS valor_centavos,
                l.id AS lancamento_id, l.descricao AS descricao_manual,
                l.posted_at AS data_manual
           FROM conciliacoes cc
           JOIN lancamentos_brutos b ON b.id = cc.bruto_id AND b.tenant_id = cc.tenant_id
           JOIN lancamentos l ON l.id = cc.lancamento_id AND l.tenant_id = cc.tenant_id
          WHERE cc.tenant_id = $1 AND cc.estado = $2::estado_da_conciliacao
          ORDER BY cc.confianca DESC, b.data DESC`,
        [ctx.tenantId, estado],
      )

      // A tradução para camelCase acontece **aqui**, e não é estilo: devolver
      // `rows` cru vazaria o nome da coluna para o contrato, e renomear uma
      // coluna passaria a quebrar o cliente.
      return r.rows.map((l) => ({
        id: l.id,
        confianca: l.confianca,
        motivo: l.motivo,
        estado: l.estado,
        descricaoDoExtrato: l.descricao_do_extrato,
        dataDoExtrato: diaCivil(l.data_do_extrato),
        valorCentavos: l.valor_centavos,
        lancamentoId: l.lancamento_id,
        descricaoManual: l.descricao_manual,
        dataManual: l.data_manual.toISOString(),
      }))
    })

    return { itens }
  }

  /**
   * Confirmar: o lançamento manual **fica**, e passa a ser o registro do fato.
   *
   * O bruto aponta para ele e não vira lançamento novo. O que o servidor faz de
   * concreto é marcar o manual como compensado — o extrato acabou de atestar que
   * o dinheiro se moveu — e **nada mais**. Valor, categoria e descrição do
   * usuário permanecem: ele é a autoridade sobre o próprio registro.
   */
  @Post(':id/confirmar')
  @HttpCode(200)
  async confirmar(@Req() req: FastifyRequest, @Param('id') id: string): Promise<{ ok: true }> {
    const ctx = this.contexto(req)

    await comTenant(this.pool, ctx, async (c) => {
      const r = await c.query<{ bruto_id: string; lancamento_id: string }>(
        `UPDATE conciliacoes SET estado = 'confirmada', decidido_em = now(), decidido_por = $3
          WHERE tenant_id = $1 AND id = $2 AND estado = 'sugerida'
          RETURNING bruto_id, lancamento_id`,
        [ctx.tenantId, id, ctx.usuarioId],
      )
      const linha = r.rows[0]
      if (!linha) throw new NotFoundException('Sugestão não encontrada.')

      await c.query(
        'UPDATE lancamentos_brutos SET lancamento_id = $3 WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, linha.bruto_id, linha.lancamento_id],
      )

      await c.query(
        `UPDATE lancamentos
            SET settled_at = coalesce(settled_at, posted_at), atualizado_em = now()
          WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, linha.lancamento_id],
      )
    })

    return { ok: true }
  }

  /**
   * Descartar: não era a mesma coisa.
   *
   * O registro do extrato **vira lançamento**, porque é um fato que aconteceu e
   * que ainda não estava registrado. Descartar a sugestão não pode significar
   * descartar o dinheiro.
   */
  @Post(':id/descartar')
  @HttpCode(200)
  async descartar(@Req() req: FastifyRequest, @Param('id') id: string): Promise<{ criado: string }> {
    const ctx = this.contexto(req)

    return comTenant(this.pool, ctx, async (c) => {
      const r = await c.query<{ bruto_id: string }>(
        `UPDATE conciliacoes SET estado = 'descartada', decidido_em = now(), decidido_por = $3
          WHERE tenant_id = $1 AND id = $2 AND estado = 'sugerida'
          RETURNING bruto_id`,
        [ctx.tenantId, id, ctx.usuarioId],
      )
      const linha = r.rows[0]
      if (!linha) throw new NotFoundException('Sugestão não encontrada.')

      const bruto = await c.query<{
        importacao_id: string
        conta_id: string
        data: Date
        valor_centavos: string
        moeda: string
        descricao: string
      }>(
        `SELECT importacao_id, conta_id, data, valor_centavos::text, moeda, descricao
           FROM lancamentos_brutos WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, linha.bruto_id],
      )
      const b = bruto.rows[0]!

      // Pela natureza do valor, pelo mesmo motivo da importação.
      const categoria = await c.query<{ id: string }>(
        `SELECT id FROM categorias
          WHERE tenant_id = $1 AND nome = 'A classificar'
            AND natureza = $2::natureza_de_categoria AND deleted_at IS NULL`,
        [ctx.tenantId, BigInt(b.valor_centavos) < 0n ? 'despesa' : 'receita'],
      )

      const criado = await c.query<{ id: string }>(
        `INSERT INTO lancamentos (tenant_id, conta_id, categoria_id, valor_centavos, moeda,
                                  posted_at, settled_at, descricao, origem, criado_por,
                                  importacao_id)
         VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz,$7,'importado',$8,$9)
         RETURNING id`,
        [
          ctx.tenantId,
          b.conta_id,
          categoria.rows[0]!.id,
          b.valor_centavos,
          b.moeda,
          b.data,
          b.descricao,
          ctx.usuarioId,
          b.importacao_id,
        ],
      )

      await c.query(
        'UPDATE lancamentos_brutos SET lancamento_id = $3 WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, linha.bruto_id, criado.rows[0]!.id],
      )

      return { criado: criado.rows[0]!.id }
    })
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
