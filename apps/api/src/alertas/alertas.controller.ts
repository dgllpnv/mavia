import { BadRequestException, Controller, Get, Inject, Req, UseGuards } from '@nestjs/common'
import type { Alerta } from '@mavia/contracts'
import { atingiu, competenciaDe, dataCivilDe, formatarDataCivil } from '@mavia/domain'
import type { FastifyRequest } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { AutorizacaoGuard } from '../autorizacao/autorizacao.guard.js'
import { POOL } from '../contas/contas.controller.js'
import { objetivosDoEspaco } from '../objetivos/objetivos.controller.js'
import { planejamentosComRealizado } from '../planejamentos/planejamentos.controller.js'
import { comTenant, contextoDoTenant } from '../tenancy/tenancy.js'

/**
 * A central de alertas.
 *
 * **Derivada, como o saldo.** Não há tabela de notificações, e a ausência é uma
 * escolha: uma tabela precisaria ser mantida em sincronia com o estado que ela
 * descreve, e um alerta de "teto estourado" que sobrevive ao estorno que
 * desestourou o teto é pior do que nenhum alerta.
 *
 * Os percentuais vêm de cada `Planejamento`, e o cálculo vem do **mesmo**
 * `consumoBp` que a tela exibe: `atingiu`, no domínio. Formatá-lo de outro
 * número faria a tela dizer 79% enquanto o sino anuncia o alerta de 80%.
 *
 * ## O que esta rota não faz
 *
 * Não entrega nada fora da sessão. Quem não abrir o app não é avisado, e um
 * teto estourado no dia 20 é notícia no dia 20. A entrega por e-mail ou push
 * depende de um canal que ainda não existe — pendência P-9.
 */
@Controller('v1/alertas')
@UseGuards(AutorizacaoGuard)
export class AlertasController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Get()
  async listar(@Req() req: FastifyRequest): Promise<{ itens: Alerta[] }> {
    const a = req.autenticado
    if (!a) throw new BadRequestException('Contexto ausente.')
    const ctx = contextoDoTenant(a.usuarioId, a.tenantId)

    const itens = await comTenant(this.pool, ctx, async (c) => [
      ...(await this.doPlanejamento(c, ctx.tenantId)),
      ...(await this.dosObjetivos(c, ctx.tenantId)),
      ...(await this.doQueVenceu(c, ctx.tenantId)),
    ])

    // Urgente primeiro. A ordem é a única hierarquia que uma lista tem, e quem
    // abre o sino quer o que está pegando fogo.
    const peso = { urgente: 0, atencao: 1, informacao: 2 } as const
    return { itens: itens.sort((x, y) => peso[x.severidade] - peso[y.severidade]) }
  }

  /**
   * Teto atingido e piso não atingido, no mês corrente.
   *
   * Só o mês corrente: um teto estourado em março não é notícia em setembro, e
   * uma lista que acumula meses passados nunca esvazia — o sino com número
   * permanente deixa de ser lido.
   */
  private async doPlanejamento(c: PoolClient, tenantId: string): Promise<Alerta[]> {
    const mes = competenciaDe(new Date())
    const competencia = `${mes.ano}-${String(mes.mes).padStart(2, '0')}-01`

    const itens = await planejamentosComRealizado(c, tenantId, competencia)
    const alertas: Alerta[] = []

    for (const p of itens) {
      // O maior limiar já cruzado, e só ele. Anunciar 80% e 100% do mesmo teto
      // no mesmo instante são duas linhas dizendo a mesma coisa.
      const cruzados = p.alertasPercentuais.filter((pc) => atingiu(p.consumoBp, pc))
      const limiar = cruzados.length > 0 ? Math.max(...cruzados) : null
      if (limiar === null) continue

      const escopo = p.categoriaId === null ? 'de todas as categorias' : 'de uma categoria'
      const percentual = (p.consumoBp / 100).toLocaleString('pt-BR', {
        minimumFractionDigits: p.consumoBp % 100 === 0 ? 0 : 1,
        maximumFractionDigits: p.consumoBp % 100 === 0 ? 0 : 1,
      })

      if (p.natureza === 'teto') {
        alertas.push({
          tipo: 'teto',
          severidade: p.estado === 'fora_do_planejado' ? 'urgente' : 'atencao',
          titulo:
            p.estado === 'fora_do_planejado'
              ? `Teto ${escopo} estourado`
              : `Teto ${escopo} em ${percentual}%`,
          detalhe: `Você atingiu ${limiar}% do que planejou gastar neste mês.`,
          destino: '/planejamento',
          chave: `teto:${p.id}:${limiar}`,
        })
      } else if (p.estado === 'dentro_do_planejado' || p.estado === 'no_planejado') {
        // Num piso, cruzar o limiar é **boa** notícia: a receita chegou.
        alertas.push({
          tipo: 'piso',
          severidade: 'informacao',
          titulo: `Piso ${escopo} alcançado`,
          detalhe: `A receita planejada para este mês já entrou (${percentual}%).`,
          destino: '/planejamento',
          chave: `piso:${p.id}:${limiar}`,
        })
      }
    }

    return alertas
  }

  private async dosObjetivos(c: PoolClient, tenantId: string): Promise<Alerta[]> {
    const objetivos = await objetivosDoEspaco(c, tenantId)

    return objetivos.flatMap((o): Alerta[] => {
      if (o.estado === 'vencido') {
        // O domínio emite `ObjetivoVencido` e **nada acontece** com o dinheiro:
        // não exclui, não estende, não gera lançamento. O aviso é o evento.
        return [
          {
            tipo: 'objetivo_vencido',
            severidade: 'atencao',
            titulo: `"${o.nome}" venceu sem atingir o alvo`,
            detalhe:
              'O prazo passou. O objetivo continua inteiro, com o quanto você juntou — estenda o prazo ou arquive.',
            destino: '/objetivos',
            chave: `objetivo-vencido:${o.id}`,
          },
        ]
      }
      if (o.estado === 'concluido' && o.consumoBp >= 10_000) {
        return [
          {
            tipo: 'objetivo_concluido',
            severidade: 'informacao',
            titulo: `"${o.nome}" alcançou o alvo`,
            detalhe: 'Atingir foi um fato com data: um resgate depois disso não desfaz.',
            destino: '/objetivos',
            chave: `objetivo-concluido:${o.id}`,
          },
        ]
      }
      return []
    })
  }

  /**
   * O que venceu e não foi pago: lançamentos de conta com data no passado e sem
   * compensação, e faturas vencidas.
   *
   * É o banner de atraso que o Organizze põe no topo do extrato, e que a
   * auditoria do épico 4 registrou como falta (I-4). Aqui ele vive no sino, com
   * os outros avisos, em vez de ocupar altura permanente na tela.
   */
  private async doQueVenceu(c: PoolClient, tenantId: string): Promise<Alerta[]> {
    const alertas: Alerta[] = []

    const atrasados = await c.query<{ n: string; mais_antigo: Date }>(
      `SELECT count(*)::text AS n, min(posted_at) AS mais_antigo
         FROM lancamentos
        WHERE tenant_id = $1 AND deleted_at IS NULL
          AND conta_id IS NOT NULL
          AND settled_at IS NULL
          AND posted_at < now()
          -- Transferência não vence: as duas pernas somam zero, e cobrar uma
          -- delas seria cobrar um movimento interno.
          AND transfer_group_id IS NULL`,
      [tenantId],
    )
    const linha = atrasados.rows[0]
    const quantos = Number(linha?.n ?? '0')

    if (quantos > 0 && linha?.mais_antigo) {
      alertas.push({
        tipo: 'lancamento_em_atraso',
        severidade: 'urgente',
        titulo: quantos === 1 ? '1 lançamento em atraso' : `${quantos} lançamentos em atraso`,
        detalhe: `A data já passou e o dinheiro não se moveu. O mais antigo é de ${formatarDataCivil(dataCivilDe(linha.mais_antigo))}.`,
        destino: '/lancamentos',
        chave: `atraso:${quantos}`,
      })
    }

    const faturas = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM faturas
        WHERE tenant_id = $1 AND deleted_at IS NULL
          AND estado <> 'paga'
          AND data_vencimento < current_date`,
      [tenantId],
    )
    const vencidas = Number(faturas.rows[0]?.n ?? '0')

    if (vencidas > 0) {
      alertas.push({
        tipo: 'fatura_vencida',
        severidade: 'urgente',
        titulo: vencidas === 1 ? '1 fatura vencida' : `${vencidas} faturas vencidas`,
        detalhe: 'O vencimento passou e o pagamento não foi registrado.',
        destino: '/cartoes',
        chave: `fatura-vencida:${vencidas}`,
      })
    }

    return alertas
  }
}
