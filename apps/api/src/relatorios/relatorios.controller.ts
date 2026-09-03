import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import { competencia as fazerCompetencia, janelaDaCompetencia } from '@mavia/domain'
import type { FastifyRequest } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { AutorizacaoGuard } from '../autorizacao/autorizacao.guard.js'
import { POOL } from '../contas/contas.controller.js'
import { comTenant } from '../tenancy/tenancy.js'

/**
 * Relatórios.
 *
 * ## A base temporal, e por que ela é parâmetro de todo relatório
 *
 * Um lançamento de cartão tem **três** referências de tempo (ADR 0007), e a
 * pergunta "quanto gastei em março" tem três respostas certas:
 *
 * | Base | A pergunta que responde |
 * |---|---|
 * | `data_compra` | quanto eu **decidi** gastar em março |
 * | `data_parcela` | quanto de março **pertence** a março (padrão) |
 * | `data_fatura` | quanto vai **sair do bolso** por causa de março |
 *
 * Nenhuma é "a certa": são perguntas diferentes. O que seria errado é a tela
 * mudar de base sem dizer, e é por isso que a base viaja explícita na resposta.
 *
 * ## Comparar dois períodos
 *
 * O servidor calcula **os dois lados**, e o cliente não escolhe base por lado.
 * É a invariante do `CONTEXT.md`: "dois períodos comparados entre si usam a
 * mesma regra de fronteira e a mesma `BaseTemporal` nos dois lados. Comparação
 * com fronteiras ou bases distintas produz variação inventada."
 *
 * Deixar o cliente montar as duas chamadas convidaria exatamente esse erro — e
 * a variação inventada aparece como uma queda de 30% que ninguém teve.
 */

type BaseTemporal = 'data_compra' | 'data_parcela' | 'data_fatura'

const BASES: readonly BaseTemporal[] = ['data_compra', 'data_parcela', 'data_fatura']

/**
 * A expressão de data de cada base.
 *
 * **Só afeta lançamento de cartão.** Um lançamento de conta tem uma data e
 * pronto; aplicar a base a ele inventaria uma diferença que o mundo não tem.
 */
function dataDaBase(base: BaseTemporal): string {
  if (base === 'data_compra') {
    // `COALESCE(grupo.data_compra, l.posted_at)`: compra à vista não tem grupo,
    // e a data da compra dela é o próprio `posted_at`.
    return `CASE WHEN l.cartao_id IS NULL THEN l.posted_at
                 ELSE coalesce(p.data_compra, l.posted_at) END`
  }
  if (base === 'data_fatura') {
    // A competência da fatura é o mês do **vencimento** — quando o dinheiro sai
    // do bolso.
    return `CASE WHEN l.cartao_id IS NULL THEN l.posted_at
                 ELSE coalesce(f.competencia::timestamptz, l.posted_at) END`
  }
  return 'l.posted_at'
}

const DE_LANCAMENTOS = `
  FROM lancamentos l
  LEFT JOIN parcelamentos p ON p.id = l.installment_group_id AND p.tenant_id = l.tenant_id
  LEFT JOIN faturas f ON f.id = l.fatura_id AND f.tenant_id = l.tenant_id
  JOIN categorias cat ON cat.id = l.categoria_id AND cat.tenant_id = l.tenant_id`

/**
 * O filtro comum a todo relatório.
 *
 * **Transferência fora, por construção** — regra 12b. E categoria não
 * analítica fora: `Ajuste de saldo` é correção de registro, e somá-la faria um
 * ajuste de −R$ 300 virar R$ 300 de despesa no gráfico.
 */
const SO_O_QUE_E_FATO = `
  l.tenant_id = $1
  AND l.deleted_at IS NULL
  AND l.transfer_group_id IS NULL
  AND cat.analitica`

interface Fatia {
  readonly categoriaId: string
  readonly nome: string
  readonly cor: string | null
  readonly totalCentavos: string
  /** Pontos-base do total da natureza. Inteiro, para não recalcular na tela. */
  readonly participacaoBp: number
}

interface Periodo {
  readonly competencia: string
  readonly receitaCentavos: string
  readonly despesaCentavos: string
}

@Controller('v1/relatorios')
@UseGuards(AutorizacaoGuard)
export class RelatoriosController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  private contexto(req: FastifyRequest) {
    const a = req.autenticado
    if (!a) throw new BadRequestException('Contexto ausente.')
    return { usuarioId: a.usuarioId, tenantId: a.tenantId }
  }

  private base(query: Record<string, unknown>): BaseTemporal {
    const bruta = query['base']
    if (bruta === undefined) return 'data_parcela'
    if (typeof bruta !== 'string' || !BASES.includes(bruta as BaseTemporal)) {
      throw new BadRequestException(
        `Base temporal desconhecida. Use uma de: ${BASES.join(', ')}.`,
      )
    }
    return bruta as BaseTemporal
  }

  private competencia(bruta: unknown, campo: string): { ano: number; mes: number } {
    if (typeof bruta !== 'string' || !/^\d{4}-\d{2}$/.test(bruta)) {
      throw new BadRequestException(`Informe ${campo} em \`AAAA-MM\`.`)
    }
    const [ano, mes] = bruta.split('-').map(Number)
    const c = fazerCompetencia(ano!, mes!)
    if (!c.ok) throw new BadRequestException(`Mês inválido em ${campo}.`)
    return c.valor
  }

  /**
   * Onde o dinheiro foi, por categoria-raiz, num mês.
   *
   * **Agrupa na raiz.** Um gráfico com trinta subcategorias não responde nada;
   * a pergunta "onde o dinheiro foi" é sobre Moradia e Alimentação, não sobre
   * "Alimentação › Padaria".
   */
  @Get('por-categoria')
  async porCategoria(
    @Req() req: FastifyRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<{ base: BaseTemporal; despesas: Fatia[]; receitas: Fatia[] }> {
    const ctx = this.contexto(req)
    const base = this.base(query)
    const c = this.competencia(query['competencia'], 'a competência')
    const janela = janelaDaCompetencia(c)

    return comTenant(this.pool, ctx, async (cliente) => {
      const linhas = await this.fatias(cliente, ctx.tenantId, base, janela)
      return {
        base,
        despesas: participacao(linhas.filter((l) => l.natureza === 'despesa')),
        receitas: participacao(linhas.filter((l) => l.natureza === 'receita')),
      }
    })
  }

  /**
   * A evolução mês a mês.
   *
   * Uma consulta só para todos os meses: doze consultas produziriam doze
   * fronteiras calculadas separadamente, e a chance de uma delas divergir na
   * virada do horário de verão não é zero.
   */
  @Get('evolucao')
  async evolucao(
    @Req() req: FastifyRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<{ base: BaseTemporal; meses: Periodo[] }> {
    const ctx = this.contexto(req)
    const base = this.base(query)
    const ate = this.competencia(query['ate'], 'o mês final')
    const quantos = Math.min(36, Math.max(2, Number(query['meses'] ?? 12)))

    const fim = janelaDaCompetencia(ate).fim
    const inicio = janelaDaCompetencia({
      ano: ate.ano + Math.floor((ate.mes - quantos) / 12),
      mes: ((((ate.mes - quantos) % 12) + 12) % 12) + 1,
    }).inicio

    const meses = await comTenant(this.pool, ctx, async (cliente) => {
      const r = await cliente.query<{
        competencia: string
        receita: string
        despesa: string
      }>(
        `SELECT to_char(date_trunc('month', (${dataDaBase(base)}) AT TIME ZONE 'America/Sao_Paulo'),
                        'YYYY-MM') AS competencia,
                coalesce(sum(l.valor_centavos) FILTER (WHERE cat.natureza = 'receita'), 0)::text AS receita,
                coalesce(sum(l.valor_centavos) FILTER (WHERE cat.natureza = 'despesa'), 0)::text AS despesa
         ${DE_LANCAMENTOS}
          WHERE ${SO_O_QUE_E_FATO}
            AND (${dataDaBase(base)}) >= $2 AND (${dataDaBase(base)}) < $3
          GROUP BY 1
          ORDER BY 1`,
        [ctx.tenantId, inicio, fim],
      )

      const porMes = new Map(r.rows.map((l) => [l.competencia, l]))

      // **Os meses sem movimento entram como zero.** Um gráfico que pula o mês
      // vazio comprime o eixo do tempo e faz três meses parecerem consecutivos
      // quando há um buraco de seis entre eles — a mentira mais fácil de contar
      // com uma série temporal.
      const saida: Periodo[] = []
      for (let i = quantos - 1; i >= 0; i--) {
        const total = ate.ano * 12 + (ate.mes - 1) - i
        const rotulo = `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
        const linha = porMes.get(rotulo)
        saida.push({
          competencia: rotulo,
          receitaCentavos: linha?.receita ?? '0',
          despesaCentavos: linha?.despesa ?? '0',
        })
      }
      return saida
    })

    return { base, meses }
  }

  /**
   * Dois meses, lado a lado.
   *
   * O servidor calcula os **dois** — o cliente não monta duas chamadas com
   * bases ou fronteiras diferentes. É a invariante do glossário, e o defeito que
   * ela evita aparece como uma queda de 30% que ninguém teve.
   */
  @Get('comparacao')
  async comparacao(
    @Req() req: FastifyRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<{
    base: BaseTemporal
    a: { competencia: string; despesas: Fatia[] }
    b: { competencia: string; despesas: Fatia[] }
    variacao: { categoriaId: string; nome: string; deltaCentavos: string }[]
  }> {
    const ctx = this.contexto(req)
    const base = this.base(query)
    const a = this.competencia(query['a'], 'o primeiro mês')
    const b = this.competencia(query['b'], 'o segundo mês')

    return comTenant(this.pool, ctx, async (cliente) => {
      const deA = await this.fatias(cliente, ctx.tenantId, base, janelaDaCompetencia(a))
      const deB = await this.fatias(cliente, ctx.tenantId, base, janelaDaCompetencia(b))

      const despesasA = participacao(deA.filter((l) => l.natureza === 'despesa'))
      const despesasB = participacao(deB.filter((l) => l.natureza === 'despesa'))

      // A variação inclui **quem sumiu**: uma categoria que existia em A e não
      // existe em B é a informação mais útil do relatório, e um `join` ingênuo
      // a perderia.
      const porCategoria = new Map<string, { nome: string; a: bigint; b: bigint }>()
      for (const f of despesasA) {
        porCategoria.set(f.categoriaId, { nome: f.nome, a: BigInt(f.totalCentavos), b: 0n })
      }
      for (const f of despesasB) {
        const atual = porCategoria.get(f.categoriaId)
        if (atual) atual.b = BigInt(f.totalCentavos)
        else porCategoria.set(f.categoriaId, { nome: f.nome, a: 0n, b: BigInt(f.totalCentavos) })
      }

      const variacao = [...porCategoria.entries()]
        .map(([categoriaId, v]) => ({
          categoriaId,
          nome: v.nome,
          deltaCentavos: (v.b - v.a).toString(),
        }))
        // Maior piora primeiro: despesa é negativa, então o delta mais negativo
        // é quem mais aumentou o gasto.
        .sort((x, y) => Number(BigInt(x.deltaCentavos) - BigInt(y.deltaCentavos)))

      return {
        base,
        a: { competencia: `${a.ano}-${String(a.mes).padStart(2, '0')}`, despesas: despesasA },
        b: { competencia: `${b.ano}-${String(b.mes).padStart(2, '0')}`, despesas: despesasB },
        variacao,
      }
    })
  }

  private async fatias(
    c: PoolClient,
    tenantId: string,
    base: BaseTemporal,
    janela: { inicio: Date; fim: Date },
  ): Promise<{ categoriaId: string; nome: string; cor: string | null; natureza: string; total: bigint }[]> {
    const data = dataDaBase(base)

    const r = await c.query<{
      categoria_id: string
      nome: string
      cor: string | null
      natureza: string
      total: string
    }>(
      `SELECT raiz.id AS categoria_id, raiz.nome, raiz.cor, raiz.natureza,
              sum(l.valor_centavos)::text AS total
       ${DE_LANCAMENTOS}
       -- A raiz da categoria: um gráfico com trinta subcategorias não responde
       -- nada. Sem pai, a própria categoria é a raiz.
       JOIN categorias raiz
         ON raiz.id = coalesce(cat.parent_id, cat.id) AND raiz.tenant_id = cat.tenant_id
        WHERE ${SO_O_QUE_E_FATO}
          AND (${data}) >= $2 AND (${data}) < $3
        GROUP BY raiz.id, raiz.nome, raiz.cor, raiz.natureza
        ORDER BY abs(sum(l.valor_centavos)) DESC`,
      [tenantId, janela.inicio, janela.fim],
    )

    return r.rows.map((l) => ({
      categoriaId: l.categoria_id,
      nome: l.nome,
      cor: l.cor,
      natureza: l.natureza,
      total: BigInt(l.total),
    }))
  }
}

/**
 * A participação de cada fatia, em pontos-base.
 *
 * Calculada aqui, e não na tela: dois clientes dividindo o mesmo número de
 * formas diferentes é como um gráfico e uma tabela passam a discordar sobre o
 * mesmo mês.
 */
function participacao(
  linhas: readonly { categoriaId: string; nome: string; cor: string | null; total: bigint }[],
): Fatia[] {
  const total = linhas.reduce((s, l) => s + (l.total < 0n ? -l.total : l.total), 0n)

  return linhas.map((l) => {
    const magnitude = l.total < 0n ? -l.total : l.total
    return {
      categoriaId: l.categoriaId,
      nome: l.nome,
      cor: l.cor,
      totalCentavos: l.total.toString(),
      participacaoBp: total === 0n ? 0 : Number((magnitude * 10_000n) / total),
    }
  })
}
