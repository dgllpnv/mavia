import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import { cotasVigentes, DIAS_DE_GRACA, plano as planoDoCatalogo, PLANOS, podeEscrever, preco, transicao, type CodigoDoPlano, type EstadoDaAssinatura, type EventoDaAssinatura, type Intervalo, fimEfetivo } from '@mavia/domain'
import { z } from 'zod'
import type { FastifyRequest } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { AutorizacaoGuard } from '../autorizacao/autorizacao.guard.js'
import { POOL } from '../contas/contas.controller.js'
import { comTenant, comUsuario, contextoDeUsuario, contextoDoTenant } from '../tenancy/tenancy.js'

/**
 * Plano e cobrança.
 *
 * ## O que este arquivo faz, e o que ele **não** faz
 *
 * Faz: o estado da assinatura, a contagem de cotas, a máquina de transições e o
 * webhook idempotente. Tudo isso é testável sem a Stripe, e está testado.
 *
 * Não faz: falar com a Stripe. A criação da sessão de checkout precisa de chave
 * de API, que é do dono do produto — está declarado na pendência P-14. O que
 * existe aqui é o **outro lado**: o que acontece quando a Stripe avisa. Quando
 * a chave existir, o que falta é uma chamada HTTP; o estado já sabe reagir.
 *
 * ## O webhook é reenviado, sempre
 *
 * A Stripe entrega **ao menos uma vez**, fora de ordem, e repete quando a nossa
 * resposta demora. Duas defesas, e as duas têm teste:
 *
 * 1. **`eventos_de_cobranca.id` é o id do evento na Stripe.** Reenviar o mesmo
 *    evento é um conflito de chave primária, e conflito significa "já tratei".
 * 2. **A máquina recusa o que não se aplica.** Um `payment_failed` que chega
 *    depois de o cliente já ter pago não encontra transição a partir de `ativa`
 *    para... — encontra, e por isso o registro guarda a transição aplicada, para
 *    que a ordem trocada seja auditável em vez de invisível.
 */

interface Assinatura {
  readonly estado: EstadoDaAssinatura
  readonly plano: CodigoDoPlano
  readonly intervalo: Intervalo
  /**
   * **O fim efetivo do direito de uso**, não o do ciclo de cobrança.
   *
   * O nome fica: é o que a tela lê, e o que ela precisa mostrar é até quando a
   * pessoa pode usar. O do ciclo vai ao lado, para quem precisa distinguir os
   * dois — a tela de cobrança mostra a data de renovação, a de plano mostra até
   * quando vale.
   */
  readonly periodoFim: string
  readonly periodoFimDoCiclo: string
  readonly cortesiaAte: string | null
  readonly gracaAte: string | null
  readonly precoCentavos: string
  readonly podeEscrever: boolean
  readonly cotas: { pessoas: number; espacos: number; anexosBytes: number; conexoes: number }
  readonly uso: { pessoas: number; espacos: number }
}

@Controller('v1/cobranca')
@UseGuards(AutorizacaoGuard)
export class CobrancaController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  private contexto(req: FastifyRequest) {
    const a = req.autenticado
    if (!a) throw new BadRequestException('Contexto ausente.')
    // O `papel` acompanha para a autorização da rota, e **não** entra na
    // unidade de trabalho: `contextoDoTenant` recebe só o que a transação
    // precisa. Antes da marca, passar o `Autenticado` inteiro a `comTenant`
    // compilava — e é essa mesma frouxidão estrutural que deixaria um
    // contexto de administração entrar no caminho do cliente.
    return { ...contextoDoTenant(a.usuarioId, a.tenantId), papel: a.papel }
  }

  /**
   * O plano do espaço, as cotas e o uso.
   *
   * **Visível a todos os papéis**, e é deliberado: um membro que esbarra numa
   * cota precisa entender por que o botão recusou, e a mensagem nomeia a cota e
   * a contagem. O que ele nunca vê é preço pago, meio de pagamento e documento
   * fiscal — e nenhum dos três está nesta resposta.
   */
  @Get()
  async ver(@Req() req: FastifyRequest): Promise<Assinatura> {
    const ctx = this.contexto(req)
    return comTenant(this.pool, ctx, (c) => lerAssinatura(c, ctx.tenantId))
  }

  /**
   * Trocar de plano.
   *
   * **Upgrade é imediato; downgrade fica para o fim do período pago.** O spec
   * §6.2 é explícito, e a razão é simples: o cliente comprou aquele período
   * inteiro. Cortar no meio seria vender doze meses e entregar sete.
   *
   * Sem a Stripe, esta rota registra a intenção e move o estado local. A
   * cobrança em si é a P-14.
   *
   * ## P-17 — o que esta rota prometia e não cumpria
   *
   * O ramo do downgrade devolvia `{ aplicadoEm: 'fim_do_periodo' }` e **não
   * escrevia nada**. O comentário dizia "registra a intenção"; a intenção não
   * ia a lugar nenhum, e a data chegava sem que nada acontecesse. Nunca.
   *
   * Agora ela grava em `trocas_agendadas`, devolve a data que gravou, e o job
   * de `trocas-agendadas.ts` a cumpre.
   */
  @Post('plano')
  @HttpCode(200)
  async trocarPlano(
    @Req() req: FastifyRequest,
    @Body() corpo: unknown,
  ): Promise<{ aplicadoEm: 'agora' | 'fim_do_periodo'; plano: string; aplicadoEmData?: string }> {
    const ctx = this.contexto(req)

    const analise = z
      .object({
        plano: z.enum(['pessoal', 'familia', 'negocio']),
        intervalo: z.enum(['mensal', 'anual']).default('mensal'),
      })
      .safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    return comTenant(this.pool, ctx, async (c) => {
      const atual = await lerAssinatura(c, ctx.tenantId)
      // Só `descendo` importa: subir e ficar no mesmo lugar seguem o mesmo
      // caminho — cancelar a descida agendada e aplicar na hora.
      const descendo = ORDEM[d.plano] < ORDEM[atual.plano]

      if (descendo && atual.estado !== 'teste') {
        // Downgrade não corta no meio: o cliente comprou o período inteiro.
        //
        // `atual.periodoFim` **já é** `fimEfetivo(periodo_fim, cortesia_ate)`.
        // Usar `periodo_fim` cru rebaixaria antes do fim de uma cortesia que
        // alguém concedeu de propósito — o achado F-12 num caminho novo.
        //
        // A data é **congelada aqui**. Recalculá-la no job leria um
        // `periodo_fim` que o webhook move a cada fatura, e a troca andaria
        // para frente sozinha, mês após mês, sem nunca chegar.
        // Pedir de novo substitui: fecha a pendente e agenda a nova. O índice
        // parcial recusaria a segunda linha de qualquer forma — cancelar antes
        // é o que transforma a recusa do banco numa substituição intencional.
        await this.cancelarPendente(c, ctx.tenantId)

        const nova = await c.query<{ aplicar_em: Date }>(
          `INSERT INTO trocas_agendadas
             (tenant_id, plano, intervalo, plano_anterior, intervalo_anterior,
              aplicar_em, pedida_por)
           VALUES ($1, $2, $3::intervalo_de_cobranca, $4, $5::intervalo_de_cobranca, $6, $7)
           RETURNING aplicar_em`,
          [
            ctx.tenantId,
            d.plano,
            d.intervalo,
            atual.plano,
            atual.intervalo,
            atual.periodoFim,
            ctx.usuarioId,
          ],
        )
        return {
          aplicadoEm: 'fim_do_periodo' as const,
          plano: d.plano,
          aplicadoEmData: nova.rows[0]?.aplicar_em.toISOString() ?? atual.periodoFim,
        }
      }

      // Subir de plano — ou voltar para o que já se tem — **desfaz a descida
      // agendada**. Sem isto, o cliente que se arrepende e sobe é derrubado de
      // volta pelo job no fim do período, desfazendo uma compra que ele fez
      // depois. O plano some sozinho e ninguém consegue explicar por quê.
      await this.cancelarPendente(c, ctx.tenantId)

      if (d.plano === atual.plano && d.intervalo === atual.intervalo) {
        // Nada a mudar: era só o cancelamento acima. **Comparar plano e
        // intervalo**, e não `!subindo` — a primeira versão usava `!subindo`,
        // que também é verdade para uma descida legítima em `teste`, e o
        // espaço em teste saía daqui respondendo "agora" sem escrever nada.
        // O mesmo defeito P-17, reintroduzido três linhas abaixo da correção.
        return { aplicadoEm: 'agora' as const, plano: d.plano }
      }

      await c.query(
        // `origem_da_ultima_escrita`: toda escrita em `assinaturas` diz quem a
        // fez. O job de reconciliação com a Stripe trata divergência como
        // incidente e corrige **pela Stripe** — sem esta marca ele desfaria a
        // troca que o próprio cliente pediu. Achado F-15.
        `UPDATE assinaturas SET plano = $2, intervalo = $3::intervalo_de_cobranca,
                                origem_da_ultima_escrita = 'cliente',
                                atualizado_em = now()
          WHERE tenant_id = $1`,
        [ctx.tenantId, d.plano, d.intervalo],
      )
      return { aplicadoEm: 'agora' as const, plano: d.plano }
    })
  }

  /**
   * Desistir da troca agendada.
   *
   * Sem id no caminho: cancela **a pendente do meu espaço**, e o índice parcial
   * garante que há no máximo uma. Um id na URL seria uma segunda fonte de
   * verdade sobre de quem é a linha — exatamente o veto 10 do `sistema.md`.
   */
  @Delete('plano/agendado')
  @HttpCode(200)
  async cancelarTrocaAgendada(@Req() req: FastifyRequest): Promise<{ cancelada: true }> {
    const ctx = this.contexto(req)
    return comTenant(this.pool, ctx, async (c) => {
      const linhas = await this.cancelarPendente(c, ctx.tenantId)
      if (linhas === 0) throw new NotFoundException('Não há troca de plano agendada.')
      return { cancelada: true as const }
    })
  }

  /**
   * Cancela a troca pendente do espaço, se houver. Devolve quantas fechou.
   *
   * `cancelada_em` e nunca `DELETE` — regra 17. "Ele já tinha pedido para
   * descer antes?" é a primeira pergunta de qualquer conversa de cancelamento,
   * e uma linha apagada não responde.
   *
   * O `WHERE` repete `tenant_id` mesmo debaixo da RLS. Não é redundância
   * defensiva: o `id` não entra aqui, então sem o tenant o `UPDATE` alcançaria
   * a linha pendente de quem estivesse na mesma transação. A RLS é a rede
   * embaixo, e a rede não é o piso.
   */
  private async cancelarPendente(c: PoolClient, tenantId: string): Promise<number> {
    const r = await c.query(
      `UPDATE trocas_agendadas SET cancelada_em = now()
        WHERE tenant_id = $1 AND aplicada_em IS NULL AND cancelada_em IS NULL`,
      [tenantId],
    )
    return r.rowCount ?? 0
  }
}

/**
 * O webhook da Stripe.
 *
 * **Pública por assinatura criptográfica, e não por sessão.** Quem chama é a
 * Stripe, que não tem conta na Mavia. A autenticação é o HMAC do corpo com o
 * segredo compartilhado, verificado em **tempo constante** — comparar assinatura
 * com `===` vaza, byte a byte, quanto do prefixo estava certo.
 */
@Controller('v1/cobranca/webhook')
export class WebhookController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Post()
  @HttpCode(200)
  async receber(@Req() req: FastifyRequest): Promise<{ tratado: boolean }> {
    const assinatura = req.headers['stripe-signature']
    const bruto = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body)

    if (!this.assinaturaConfere(bruto, typeof assinatura === 'string' ? assinatura : '')) {
      // 400 e não 401: a Stripe trata 4xx como "não reenviar", e é o que
      // queremos para um corpo que não é dela.
      throw new BadRequestException('Assinatura inválida.')
    }

    const evento = z
      .object({
        id: z.string().min(1).max(200),
        type: z.string().min(1).max(120),
        data: z.object({ object: z.record(z.unknown()) }),
      })
      .safeParse(req.body)
    if (!evento.success) throw new BadRequestException('Evento em formato desconhecido.')

    const { id, type, data } = evento.data

    /**
     * O id da assinatura, e **só quando ele é uma string**.
     *
     * A Stripe devolve `subscription` como id ou como **objeto expandido**,
     * conforme o que foi pedido na criação do evento. Um `String(objeto)` daria
     * `[object Object]` — e todas as assinaturas do mundo passariam a colidir
     * na mesma chave, num caminho que decide o estado de cobrança de clientes.
     * O lint encontrou; o defeito só apareceria com um evento expandido.
     */
    const texto = (valor: unknown): string | null =>
      typeof valor === 'string' && valor.length > 0 ? valor : null

    const alvo = data.object as { subscription?: unknown; id?: unknown }
    const subscription = texto(alvo.subscription) ?? texto(alvo.id) ?? ''

    return comUsuario(this.pool, contextoDeUsuario(SEM_USUARIO), async (c) => {
      // Defesa 1: o id do evento é a chave primária. Reenvio é conflito, e
      // conflito significa "já tratei".
      //
      // Pela função, e não pela tabela: `eventos_de_cobranca` ganhou RLS na
      // migration 0028, e `mavia_app` não tem acesso direto a ela. O corpo cru
      // do evento carrega e-mail, id de assinatura e valores, e a defesa
      // anterior era "nenhuma rota lê essa tabela" — filtro na aplicação como
      // única camada, que é o que a regra 16 recusa.
      const novo = await c.query<{ registrar_evento_de_cobranca: boolean }>(
        'SELECT auth.registrar_evento_de_cobranca($1,$2,$3::jsonb)',
        [id, type, JSON.stringify(req.body)],
      )
      if (novo.rows[0]?.registrar_evento_de_cobranca !== true) return { tratado: false }

      const gatilho = EVENTOS[type]
      if (!gatilho || subscription === '') {
        await c.query('SELECT auth.concluir_evento_de_cobranca($1)', [id])
        return { tratado: false }
      }

      const atual = await c.query<{ id_do_tenant: string; estado_atual: EstadoDaAssinatura }>(
        'SELECT * FROM auth.assinatura_por_stripe($1)',
        [subscription],
      )
      const linha = atual.rows[0]
      if (!linha) {
        await c.query('SELECT auth.concluir_evento_de_cobranca($1)', [id])
        return { tratado: false }
      }

      // Defesa 2: a máquina recusa o que não se aplica. Um evento fora de ordem
      // não "conserta" o estado — ele fica registrado como não aplicado, e a
      // desordem vira auditável em vez de invisível.
      const destino = transicao(linha.estado_atual, gatilho)

      if (destino !== null) {
        await c.query('SELECT * FROM auth.aplicar_estado_da_assinatura($1,$2::estado_da_assinatura,$3,$4)', [
          subscription,
          destino,
          destino === 'em_atraso'
            ? new Date(Date.now() + DIAS_DE_GRACA * 86_400_000)
            : null,
          fimDoPeriodo(data.object),
        ])
      }

      await c.query('SELECT auth.concluir_evento_de_cobranca($1,$2,$3)', [
        id,
        linha.id_do_tenant,
        destino,
      ])

      return { tratado: destino !== null }
    })
  }

  /**
   * HMAC-SHA256 do corpo cru, em tempo constante.
   *
   * O corpo **cru**, e não o objeto reserializado: `JSON.stringify` reordena
   * chaves e muda espaçamento, e a assinatura da Stripe é sobre os bytes que
   * ela mandou. Reserializar faz toda assinatura legítima falhar.
   */
  private assinaturaConfere(bruto: string, cabecalho: string): boolean {
    const segredo = process.env['STRIPE_WEBHOOK_SECRET']
    // Sem segredo configurado, nenhuma assinatura confere. **Nunca** o
    // contrário: um webhook aberto porque a variável não foi definida é uma
    // rota que qualquer um usa para mudar o estado de cobrança de um cliente.
    if (!segredo) return false

    const partes = new Map(
      cabecalho.split(',').map((p) => {
        const i = p.indexOf('=')
        return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const
      }),
    )
    const t = partes.get('t')
    const v1 = partes.get('v1')
    if (!t || !v1) return false

    const esperado = createHmac('sha256', segredo).update(`${t}.${bruto}`, 'utf8').digest('hex')
    const a = Buffer.from(esperado, 'utf8')
    const b = Buffer.from(v1, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  }
}

/**
 * Os eventos da Stripe que nos interessam, e o gatilho de cada um.
 *
 * Lista fechada: um evento que não está aqui é registrado e ignorado. A Stripe
 * manda dezenas de tipos, e reagir ao que não se entende é como um `checkout`
 * incompleto vira uma assinatura ativa.
 */
const EVENTOS: Readonly<Record<string, EventoDaAssinatura>> = {
  'customer.subscription.created': 'assinou',
  'invoice.payment_succeeded': 'pagamento_recuperado',
  'invoice.payment_failed': 'pagamento_falhou',
  'customer.subscription.deleted': 'cancelou',
}

const ORDEM: Record<CodigoDoPlano, number> = { pessoal: 1, familia: 2, negocio: 3 }
const SEM_USUARIO = '00000000-0000-0000-0000-000000000000'

function fimDoPeriodo(objeto: Record<string, unknown>): Date | null {
  const bruto = objeto['current_period_end']
  return typeof bruto === 'number' ? new Date(bruto * 1000) : null
}

/**
 * O estado da assinatura, com cotas e uso.
 *
 * Exportada porque o guardião de cota precisa exatamente disto, e recalcular
 * noutro lugar produziria duas contagens que divergem — a da tela dizendo que
 * cabe mais uma pessoa e a da escrita dizendo que não.
 */
export async function lerAssinatura(c: PoolClient, tenantId: string): Promise<Assinatura> {
  const r = await c.query<{
    estado: EstadoDaAssinatura
    plano: string
    intervalo: Intervalo
    periodo_fim: Date
    cortesia_ate: Date | null
    graca_ate: Date | null
  }>(
    `SELECT estado, plano, intervalo, periodo_fim, cortesia_ate, graca_ate
       FROM assinaturas WHERE tenant_id = $1`,
    [tenantId],
  )
  const linha = r.rows[0]
  if (!linha) throw new BadRequestException('Este espaço não tem assinatura.')

  const codigo = (planoDoCatalogo(linha.plano)?.codigo ?? 'pessoal')
  const cotas = cotasVigentes(linha.estado, codigo)

  const uso = await c.query<{ pessoas: string; espacos: string }>(
    `SELECT
       ((SELECT count(*) FROM tenant_usuarios
          WHERE tenant_id = $1 AND removido_em IS NULL)
        + (SELECT count(*) FROM convites
            WHERE tenant_id = $1 AND aceito_em IS NULL AND revogado_em IS NULL
              AND expira_em > now()))::text AS pessoas,
       (SELECT count(*) FROM tenant_usuarios tu
          WHERE tu.usuario_id IN (SELECT usuario_id FROM tenant_usuarios
                                   WHERE tenant_id = $1 AND papel = 'proprietario'
                                     AND removido_em IS NULL)
            AND tu.papel = 'proprietario' AND tu.removido_em IS NULL)::text AS espacos`,
    [tenantId],
  )

  return {
    estado: linha.estado,
    plano: codigo,
    intervalo: linha.intervalo,
    /**
     * **O fim efetivo, e não `periodo_fim`.**
     *
     * `periodo_fim` é do ciclo de cobrança e pertence à Stripe; `cortesia_ate`
     * é o tempo que o operador concedeu. Lendo o primeiro, a tela do cliente
     * continuava dizendo "seu teste vai até 08/09" **depois** de o operador ter
     * prorrogado — e o operador desligava o telefone tendo prometido uma coisa
     * que a tela contradizia.
     *
     * A função `fimEfetivo` existia desde o ticket 08 e **não tinha um único
     * chamador**: a metade que decide se a cortesia vale alguma coisa estava
     * escrita e desligada. Achado FC-3.
     */
    periodoFim: fimEfetivo(linha.periodo_fim, linha.cortesia_ate).toISOString(),
    /** O do ciclo de cobrança, para quem precisa distinguir os dois. */
    periodoFimDoCiclo: linha.periodo_fim.toISOString(),
    cortesiaAte: linha.cortesia_ate?.toISOString() ?? null,
    gracaAte: linha.graca_ate?.toISOString() ?? null,
    precoCentavos: preco(codigo, linha.intervalo).centavos.toString(),
    podeEscrever: podeEscrever(linha.estado),
    cotas,
    uso: { pessoas: Number(uso.rows[0]!.pessoas), espacos: Number(uso.rows[0]!.espacos) },
  }
}

/**
 * A cota de pessoas, conferida **no servidor e na mesma transação**.
 *
 * "Cota conferida na UI é conveniência; cota conferida só na UI é defeito"
 * — spec §3. A mensagem nomeia a cota e a contagem, porque um membro que
 * esbarra nela precisa entender por que o botão recusou.
 */
export async function exigirCotaDePessoas(c: PoolClient, tenantId: string): Promise<void> {
  const a = await lerAssinatura(c, tenantId)
  if (a.uso.pessoas < a.cotas.pessoas) return

  throw new BadRequestException(
    `Seu plano ${PLANOS[a.plano].nome} comporta ${a.cotas.pessoas} pessoas, e o espaço já tem ${a.uso.pessoas} ` +
      '(membros e convites pendentes contam). Troque de plano ou revogue um convite.',
  )
}
