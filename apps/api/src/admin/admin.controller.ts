import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { MENSAGEIRO, type Mensageiro } from '../mensageiro/mensageiro.js'
import {
  comAdmin,
  comAdminEscrita,
  comTenantDeAdmin,
  comTenantDeAdminEscrita,
  contextoDeAdmin,
  contextoDeAdminEscrita,
  contextoDeOperador,
  contextoDeOperadorEscrita,
} from '../tenancy/tenancy.js'

export const POOL_DO_PAINEL = Symbol('POOL_DO_PAINEL')
export const POOL_DE_ESCRITA = Symbol('POOL_DE_ESCRITA')

/**
 * O alvo da abertura quando o espaço **ainda não existe** — o cadastro.
 *
 * `admin.abrir_espaco_para_escrita` exige um alvo, e no cadastro não há um: o
 * identificador nasce dentro da própria transação. Este UUID nulo é o alvo
 * declarado, e torna a linha de intenção distinguível de qualquer espaço real —
 * o que é melhor que usar o id do operador, que seria mentira, ou omitir a
 * abertura, que deixaria a única escrita do painel sem hipótese declarada.
 */
const ESPACO_A_CRIAR = '00000000-0000-0000-0000-000000000000'

/** Quebra de linha no corpo do aviso, nomeada para não virar `\n` solto. */
const NOVA_LINHA = String.fromCharCode(10)

/**
 * O painel de administração — rotas de leitura.
 *
 * ## Cada tela tem rota própria, e isso é a maior parte do orçamento do épico
 *
 * A alternativa — reusar os controladores do cliente — grava **uma** linha de
 * auditoria na abertura e **nenhuma** nas N leituras seguintes. A propriedade
 * central do épico ("não se toca o espaço de um cliente sem registrar") ficaria
 * verdadeira para a primeira requisição e falsa para todas as outras.
 *
 * Pior: reusar exigiria um `Autenticado` com o tenant do cliente, e a partir
 * daí **todos** os controladores existentes passariam a servir o operador —
 * cada um chamando `comTenant`, que roda como `mavia_app`, com DML completo
 * sobre o razão. É a ADR 0024 D2, e é a razão de nenhuma rota daqui produzir
 * um `Autenticado`.
 *
 * ## O que este controlador nunca chama
 *
 * `comTenant`, `comUsuario` e `resolverTenant`. Os três são o caminho do
 * cliente; o painel usa `comAdmin` e `comTenantDeAdmin`, com pool e papel
 * próprios. A separação é verificada em compilação — os contextos são tipos
 * distintos — e no banco: passar o pool errado morre no `SET LOCAL ROLE`.
 *
 * ## `app.usuario_id` é sempre o do operador
 *
 * Nunca o do titular. Personificar o cliente faria a policy `RESTRICTIVE` de
 * `usuarios` passar a autorizar `UPDATE … SET senha_hash` na linha dele — e a
 * consequência aceita é que as telas que dependem de "quem sou eu" não existem
 * no painel.
 */

/** As recusas nomeadas das funções de contrato, e o que elas dizem a quem opera. */
const RECUSAS: readonly (readonly [string, string])[] = [
  // O teto de sete dias caiu por decisão do dono (2026-09-05). O que sobrou é
  // guarda de digitação, e a mensagem diz isso — para o operador não procurar
  // uma política que não existe mais.
  ['PRORROGACAO_IMPLAUSIVEL', 'Dias entre 1 e 3650. Acima disso é engano de digitação.'],
  ['JA_E_OPERADOR', 'Essa pessoa já é operadora.'],
  [
    'SUPER_ATIVO_INSUFICIENTE',
    'Não dá para tirar o último superadministrador: sem ele, ninguém mais concede ' +
      'acesso ao painel. Promova outro antes.',
  ],
  ['NAO_E_OPERADOR', 'Essa pessoa não é operadora.'],
  ['USUARIO_INEXISTENTE', 'Ninguém com esse endereço tem conta. Ela precisa se cadastrar antes.'],
  [
    'ADMINS_ATIVOS_INSUFICIENTES',
    // A invariante da migration 0031. A mensagem nomeia o motivo, porque
    // "operação recusada" faria o operador tentar de novo.
    'Não dá para ficar com menos de dois operadores ativos: perder o acesso do ' +
      'único trancaria o painel, e o aviso entre pares não teria para quem ir.',
  ],
  ['CORTESIA_ALEM_DO_TETO', 'A cortesia vai no máximo a trinta dias por vez.'],
  ['CORTESIA_ACUMULADA_ALEM_DO_TETO', 'Este espaço já acumulou sessenta dias de cortesia no período.'],
  ['TESTE_JA_PRORROGADO', 'O teste deste espaço já foi prorrogado uma vez.'],
  ['ESTADO_NAO_PERMITE_PRORROGACAO', 'Só um espaço em teste tem teste a prorrogar.'],
  ['ESTADO_NAO_PERMITE_CORTESIA', 'Este estado da assinatura não recebe cortesia.'],
  ['ASSINATURA_INEXISTENTE', 'Este espaço não tem assinatura.'],
  ['RAZAO_AUSENTE', 'Escreva a razão: ela vai para o registro.'],
  ['VALOR_INVALIDO', 'O valor da baixa é positivo, em centavos.'],
  ['PRECO_INALTERADO', 'Este já é o preço vigente. Nada foi gravado.'],
  ['PLANO_INVALIDO', 'Informe o plano.'],
  ['MOTIVO_INSUFICIENTE', 'Escreva o motivo com pelo menos oito caracteres: ele vai para o registro.'],
  ['SEM_DESCONTO_ATIVO', 'Este espaço não tem desconto ativo para revogar.'],
  ['RECEBIMENTO_NO_FUTURO', 'A data do recebimento não pode estar no futuro.'],
  [
    'ESTADO_NAO_PERMITE_BAIXA',
    // Só `em_atraso` e `ativa` aceitam. `expirada` e `teste` recusam porque
    // registrar dinheiro que não muda contrato nenhum é pior do que recusar: o
    // cliente pagaria e continuaria expirando.
    'Este estado da assinatura não aceita baixa manual. Quem expirou contrata de novo; ' +
      'quem está em teste assina, e assinar pede plano e intervalo.',
  ],
  [
    'TRANSICAO_OBSOLETA',
    // A assinatura mudou entre a leitura e a escrita — tipicamente um webhook
    // da Stripe chegando no meio. Recusar é o certo: aplicar sobrescreveria uma
    // decisão mais recente que a nossa.
    'A assinatura mudou enquanto a baixa era registrada. Confira o estado e tente de novo.',
  ],
  ['BAIXA_INEXISTENTE', 'Esta baixa não existe ou já foi estornada.'],
  [
    'TITULAR_INEXISTENTE',
    // A função não cria identidade: ela vincula alguém que já tem conta.
    'Esta pessoa ainda não tem conta na Mavia. Peça a ela que se cadastre primeiro.',
  ],
  ['NOME_AUSENTE', 'Dê um nome ao espaço.'],
  // Os mesmos tetos da rota do cliente, com os mesmos nomes de exceção: o
  // painel **não é bypass** do limite que o produto cumpre (A-18, DP-26).
  ['TETO_DIARIO_DE_TENANTS', 'Este titular já criou três espaços nas últimas 24 horas.'],
  ['TETO_DE_TENANTS_ATIVOS', 'Este titular já tem dez espaços ativos.'],
  // O índice único da regra 13. A frase nomeia o que aconteceu, porque
  // "violação de restrição" faria o operador achar que o sistema quebrou
  // quando ele acabou de ser protegido de contar a mesma receita duas vezes.
  ['pagamento_manual_unico', 'Esta referência já foi registrada para este cliente.'],
]

const zBusca = z.object({
  q: z.string().trim().min(1).max(140).optional(),
  limite: z.coerce.number().int().min(1).max(200).default(50),
})

const zAbertura = z.object({
  /**
   * Lista fechada, e é o controle mais barato do épico: um valor fora dela não
   * entra no `INSERT`, e a mesma instrução que registra é a que efetiva o
   * acesso. "Curiosidade" não tem valor de enum.
   */
  motivo: z.enum(['chamado', 'incidente', 'defeito', 'ordem_judicial']),
  /**
   * Identificador, **nunca narrativa**. Ela aponta para um caso que existe em
   * outro lugar; não recebe a descrição do problema nem o que o cliente contou
   * por e-mail. Um campo de motivo que vira diário de atendimento recria dentro
   * do log de acesso o mesmo texto livre que a política passou o documento
   * inteiro tirando dele.
   */
  referencia: z.string().trim().min(3).max(80),
})

type Abertura = z.infer<typeof zAbertura>

/**
 * A baixa de pagamento.
 *
 * `referenciaExterna` é **obrigatória** e é a chave de idempotência da regra 13
 * — end-to-end id do Pix, número do comprovante, do boleto ou do recibo.
 * Inclusive para dinheiro em espécie: ali ela é o número do recibo que alguém
 * precisou emitir.
 *
 * Sem ela, dois operadores dão baixa no mesmo Pix em horas diferentes e a
 * escrituração soma o dobro do que entrou (achado F-3).
 */
const zBaixa = z.object({
  valorCentavos: z.string().regex(/^[1-9][0-9]*$/, 'o valor é positivo, em centavos'),
  meio: z.enum(['pix', 'transferencia', 'boleto', 'dinheiro']),
  referenciaExterna: z.string().trim().min(6).max(140),
  recebidoEm: z.string().datetime(),
  observacao: z.string().trim().max(1000).optional(),
})

/** A consulta ao registro de auditoria. */
const zRegistro = z.object({
  desde: z.string().datetime().optional(),
  tenantId: z.string().uuid().optional(),
  limite: z.coerce.number().int().min(1).max(500).default(100),
})

/**
 * O cadastro de um cliente novo.
 *
 * `titularId`, e **não** e-mail e senha: a função não cria identidade. Criar
 * conta é ato de quem vai ser dono dela, com credencial que só ele conhece — um
 * operador criando login para terceiro é um operador que conhece a senha de um
 * cliente.
 */
const zCadastro = z.object({
  titularId: z.string().uuid(),
  nome: z.string().trim().min(2).max(120),
})

/**
 * O corpo das duas escritas de tempo. `razao` é **obrigatória** e vai hasheada
 * para a linha de auditoria: uma cortesia sem motivo escrito é indistinguível
 * de um favor. O teto de dias é conferido **no banco** — aqui a validação só
 * evita uma ida ao Postgres para recusar o óbvio.
 */
const zTempoConcedido = z.object({
  dias: z.number().int().min(1).max(30),
  razao: z.string().trim().min(3).max(280),
})

/**
 * Prorrogar teste — **sem teto de política desde 2026-09-05**.
 *
 * O `max` de 3650 é guarda de digitação e não política: é a diferença entre
 * "trinta dias" e "trinta mil porque o zero grudou". A função no banco repete a
 * mesma faixa, e é ela que vale — esta validação existe para a mensagem chegar
 * ao operador em português em vez de como exceção do Postgres.
 */
const zProrrogacao = z.object({
  // A mensagem é escrita à mão porque a padrão do Zod — "Number must be less
  // than or equal to 3650" — descreve a regra e não o motivo dela. O operador
  // que a lê procura uma política de 3650 dias; o que existe é um limite contra
  // engano de digitação.
  dias: z
    .number()
    .int()
    .min(1)
    .max(3650, 'Dias entre 1 e 3650. Acima disso é engano de digitação.'),
  razao: z.string().trim().min(3).max(280),
})

/**
 * Conceder ou revogar operadora — **por e-mail, nunca por id**.
 *
 * Um UUID vindo do corpo de uma requisição é um identificador que o operador
 * não confere a olho: colar o errado torna administrador alguém que ele nem
 * sabe quem é. Um e-mail ele lê antes de clicar.
 */
const zOperador = z.object({
  email: z.string().trim().email().max(320),
  // `super` cria `super`, e é a saída sancionada do super único: sem ela, o
  // único caminho para trocar o superadministrador seria o servidor.
  nivel: z.enum(['operador', 'super']).default('operador'),
})

/**
 * Preço novo — ADR 0025 D2.
 *
 * `centavos` como **string** e não `number`: um preço anual de R$ 599,90 cabe
 * num `number`, e a regra 1 do `CLAUDE.md` não fala do que cabe. Dinheiro
 * atravessa o fio em decimal, é convertido para `bigint` na borda, e nenhum
 * caminho o transforma em ponto flutuante.
 */
const zPrecoNovo = z.object({
  plano: z.enum(['pessoal', 'familia', 'negocio']),
  intervalo: z.enum(['mensal', 'anual']),
  centavos: z.string().regex(/^[1-9][0-9]{0,11}$/, 'centavos: inteiro positivo, em texto'),
  motivo: z.string().trim().min(8).max(280),
})

/**
 * Desconto — ADR 0025 D1.
 *
 * `pontosBase` inteiro de 1 a 10000. `0.15` traria ponto flutuante para dois
 * passos de uma `Money`, e é o que `packages/domain/src/desconto.ts` recusa.
 *
 * O `superRefine` existe porque a combinação é o que importa: um corpo que
 * declara `percentual` **e** manda `centavos` é ambíguo, e o banco o recusaria
 * com `valor_combina_com_especie` — uma mensagem que o operador não entenderia.
 */
const zDesconto = z
  .object({
    especie: z.enum(['percentual', 'valor']),
    pontosBase: z.number().int().min(1).max(10_000).optional(),
    centavos: z.string().regex(/^[1-9][0-9]{0,11}$/).optional(),
    duracao: z.enum(['uma_vez', 'meses', 'sempre']),
    meses: z.number().int().min(1).max(120).optional(),
    motivo: z.string().trim().min(8).max(280),
  })
  .superRefine((d, ctx) => {
    const erro = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })
    if (d.especie === 'percentual' && d.pontosBase === undefined) erro('percentual pede pontosBase')
    if (d.especie === 'percentual' && d.centavos !== undefined) erro('percentual não leva centavos')
    if (d.especie === 'valor' && d.centavos === undefined) erro('valor pede centavos')
    if (d.especie === 'valor' && d.pontosBase !== undefined) erro('valor não leva pontosBase')
    if (d.duracao === 'meses' && d.meses === undefined) erro('duração em meses pede meses')
    if (d.duracao !== 'meses' && d.meses !== undefined) erro('meses só com duração em meses')
  })

const zMotivo = z.object({ motivo: z.string().trim().min(8).max(280) })

@Controller('v1/admin')
export class AdminController {
  constructor(
    @Inject(POOL_DO_PAINEL) private readonly pool: Pool,
    /**
     * **Terceira pool, e não a segunda.** `mavia_admin` não é membro de
     * `mavia_admin_escrita` (não-relação da §1.2), então a conexão de leitura
     * morre no `SET LOCAL ROLE` do caminho de escrita. A separação é por
     * autenticação, não por instrução — ADR 0024 D3.
     */
    @Inject(POOL_DE_ESCRITA) private readonly poolDeEscrita: Pool,
    @Inject(MENSAGEIRO) private readonly mensageiro: Mensageiro,
  ) {}

  /**
   * O operador da requisição.
   *
   * Vem de `req.sessao`, e **não** de `req.autenticado` — que é nulo aqui por
   * construção (`aplicacao.ts`, ao computar `exigeTenant`). Se um dia isto
   * passar a ler `req.autenticado`, o painel volta a depender do caminho do
   * cliente e a ADR 0024 D2 deixa de valer.
   */
  private operador(req: FastifyRequest): string {
    const s = req.sessao
    if (!s) throw new UnauthorizedException('Sessão ausente ou inválida.')
    return s.usuarioId
  }

  /** A hipótese vem no cabeçalho, e é pedida **antes** de o espaço abrir. */
  private hipotese(req: FastifyRequest): Abertura {
    const analise = zAbertura.safeParse({
      motivo: req.headers['x-mavia-motivo'],
      referencia: req.headers['x-mavia-referencia'],
    })
    if (!analise.success) {
      throw new BadRequestException(
        'Informe o motivo do acesso e a referência antes de abrir o espaço de um cliente.',
      )
    }
    return analise.data
  }

  @Get('clientes')
  async listar(@Req() req: FastifyRequest, @Query() consulta: unknown) {
    const analise = zBusca.safeParse(consulta)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))

    return this.traduzindoRecusa(async () =>
      comAdmin(this.pool, contextoDeOperador(this.operador(req)), async (c) => {
        const r = await c.query('SELECT * FROM admin.listar_clientes($1, $2)', [
          analise.data.q ?? null,
          analise.data.limite,
        ])
        return { itens: r.rows }
      }),
    )
  }

  @Post('clientes/:tenantId/abrir')
  @HttpCode(201)
  async abrir(@Req() req: FastifyRequest, @Param('tenantId') tenantId: string) {
    const { motivo, referencia } = this.hipotese(req)
    return this.traduzindoRecusa(async () => {
      const correlacao = await comAdmin(
        this.pool,
        contextoDeOperador(this.operador(req)),
        async (c) => this.abrirEspaco(c, tenantId, motivo, referencia, 'abriu', '/v1/admin/abrir'),
      )
      return { correlacao }
    })
  }

  @Get('clientes/:tenantId')
  async perfil(@Req() req: FastifyRequest, @Param('tenantId') tenantId: string) {
    return this.comEspacoAberto(req, tenantId, '/v1/admin/clientes/:tenantId', async (c) => {
      const r = await c.query(
        // `cortesia_ate` **e** `periodo_fim`, lado a lado. É o painel: ver os
        // dois é o ponto. Sem a primeira, o operador que acabou de conceder
        // trinta dias não tem como ver que concedeu — e repete a operação,
        // que é como a cortesia passava a valer zero (FC-2, FC-3).
        `SELECT t.id, t.nome, t.criado_em,
                a.plano::text AS plano, a.estado::text AS estado,
                a.periodo_fim, a.cortesia_ate, a.graca_ate,
                greatest(a.periodo_fim, coalesce(a.cortesia_ate, a.periodo_fim))
                  AS fim_efetivo
           FROM tenants t LEFT JOIN assinaturas a ON a.tenant_id = t.id
          WHERE t.id = $1`,
        [tenantId],
      )
      return { itens: r.rows }
    })
  }

  @Get('clientes/:tenantId/contas')
  async contas(@Req() req: FastifyRequest, @Param('tenantId') tenantId: string) {
    return this.comEspacoAberto(req, tenantId, '/v1/admin/clientes/:tenantId/contas', async (c) => {
      const r = await c.query(
        `SELECT id, nome, tipo, saldo_inicial_centavos::text, moeda, incluir_no_saldo_geral
           FROM contas WHERE deleted_at IS NULL ORDER BY nome`,
      )
      return { itens: r.rows }
    })
  }

  @Get('clientes/:tenantId/lancamentos')
  async lancamentos(@Req() req: FastifyRequest, @Param('tenantId') tenantId: string) {
    return this.comEspacoAberto(
      req,
      tenantId,
      '/v1/admin/clientes/:tenantId/lancamentos',
      async (c) => {
        const r = await c.query(
          `SELECT id, valor_centavos::text, moeda, posted_at, settled_at, descricao, origem
             FROM lancamentos WHERE deleted_at IS NULL
            ORDER BY posted_at DESC LIMIT 200`,
        )
        return { itens: r.rows }
      },
    )
  }

  /**
   * As baixas anteriores — e ela existe **por causa** do achado F-3.
   *
   * Dar baixa sem ver as baixas anteriores é o cenário da duplicidade com outra
   * roupa: o índice único recusa a repetição exata, e não recusa a mesma
   * quantia lançada com outra referência. A tela é o que faz o operador
   * perceber antes de o banco recusar.
   */
  @Get('clientes/:tenantId/pagamentos')
  async pagamentos(@Req() req: FastifyRequest, @Param('tenantId') tenantId: string) {
    return this.comEspacoAberto(
      req,
      tenantId,
      '/v1/admin/clientes/:tenantId/pagamentos',
      async (c) => {
        const r = await c.query(
          `SELECT id, valor_centavos::text, moeda, competencia, recebido_em, meio,
                  referencia_externa, observacao, registrado_em
             FROM pagamentos_manuais
            WHERE deleted_at IS NULL
            ORDER BY recebido_em DESC LIMIT 100`,
        )
        return { itens: r.rows }
      },
    )
  }

  /**
   * O registro — e **lê-lo é evento**.
   *
   * A projeção é fixa e vive na função: `ip_hash` e `user_agent_hash` **não têm
   * como** sair porque não estão no tipo de retorno. Não é uma lista que alguém
   * precisa lembrar de manter — acrescentá-las exigiria mudar a assinatura.
   *
   * E a leitura **notifica os outros operadores**, por um destino fora do
   * painel. Um log que ninguém lê descobre o incidente quando o cliente
   * reclama; um log cuja leitura é silenciosa descobre na mesma hora.
   */
  @Get('registro')
  async registro(@Req() req: FastifyRequest, @Query() consulta: unknown) {
    const analise = zRegistro.safeParse(consulta)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const operador = this.operador(req)

    const itens = await this.traduzindoRecusa(async () =>
      comAdmin(this.pool, contextoDeOperador(operador), async (c) => {
        const r = await c.query('SELECT * FROM admin.ler_registro($1, $2, $3)', [
          analise.data.desde ?? null,
          analise.data.tenantId ?? null,
          analise.data.limite,
        ])
        return r.rows
      }),
    )

    // **Depois do `COMMIT`, e sem `await` no caminho da resposta.**
    //
    // A notificação é detecção, não autorização: falhar em enviá-la não pode
    // impedir a leitura nem derrubar a requisição. Ela é disparada e registrada;
    // a entrega garantida é a fila do épico de alertas, e está registrada como
    // dívida no ticket.
    void this.avisarPares(operador, itens.length)

    return { itens }
  }

  @Post('clientes')
  @HttpCode(201)
  async cadastrar(@Req() req: FastifyRequest, @Body() corpo: unknown) {
    const { motivo, referencia } = this.hipotese(req)
    const operador = this.operador(req)

    const analise = zCadastro.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    return this.traduzindoRecusa(async () =>
      comTenantDeAdminEscrita(
        this.poolDeEscrita,
        contextoDeAdminEscrita(operador, ESPACO_A_CRIAR),
        async (c) => {
          const abertura = await c.query<{ correlacao: string }>(
            `SELECT admin.abrir_espaco_para_escrita($1, $2::motivo_de_acesso, $3, $4, $5) AS correlacao`,
            [ESPACO_A_CRIAR, motivo, referencia, 'cadastrou_cliente', '/v1/admin/clientes'],
          )
          const r = await c.query<{ id: string }>(
            'SELECT admin.cadastrar_cliente($1, $2, $3) AS id',
            [d.titularId, d.nome, abertura.rows[0]!.correlacao],
          )
          return {
            id: r.rows[0]!.id,
            // O texto que a tela mostra, e ele é a metade que impede o operador
            // de procurar o botão que não existe: o espaço **não** vira `ativa`
            // por aqui. Dizer isso agora é mais barato que explicar depois.
            aviso:
              'Este espaço fica em teste por sete dias, com as cotas do Família. ' +
              'Ele só passa a ativo quando o cliente assinar.',
          }
        },
      ),
    )
  }

  @Post('clientes/:tenantId/pagamentos')
  @HttpCode(201)
  async darBaixa(@Req() req: FastifyRequest, @Param('tenantId') tenantId: string, @Body() corpo: unknown) {
    const { motivo, referencia } = this.hipotese(req)
    const operador = this.operador(req)

    const analise = zBaixa.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    return this.traduzindoRecusa(async () =>
      comTenantDeAdminEscrita(
        this.poolDeEscrita,
        contextoDeAdminEscrita(operador, tenantId),
        async (c) => {
          const abertura = await c.query<{ correlacao: string }>(
            `SELECT admin.abrir_espaco_para_escrita($1, $2::motivo_de_acesso, $3, $4, $5) AS correlacao`,
            [tenantId, motivo, referencia, 'deu_baixa', '/v1/admin/pagamentos'],
          )

          const r = await c.query<{ id_do_pagamento: string; estado_novo: string }>(
            `SELECT * FROM admin.registrar_pagamento($1, $2::bigint, $3::meio_de_pagamento,
                                                     $4, $5::timestamptz, $6, $7)`,
            [
              tenantId,
              d.valorCentavos,
              d.meio,
              d.referenciaExterna,
              d.recebidoEm,
              d.observacao ?? null,
              abertura.rows[0]!.correlacao,
            ],
          )
          return { id: r.rows[0]!.id_do_pagamento, estado: r.rows[0]!.estado_novo }
        },
      ),
    )
  }

  /**
   * Prorrogar o teste. **Sem teto e repetível** desde 2026-09-05.
   *
   * Não usa `escrevendoContrato` porque aquele helper carrega o schema de
   * `{ dias: 1..30 }`, que é o da cortesia — e a cortesia **continua** com teto
   * (30 por vez, 60 acumulados). São políticas diferentes sobre coisas
   * diferentes: uma estende um teste grátis, a outra compensa um cliente
   * pagante. Compartilhar o schema faria a mudança de uma mexer na outra.
   */
  @Post('clientes/:tenantId/teste/prorrogar')
  @HttpCode(201)
  async prorrogarTeste(@Req() req: FastifyRequest, @Param('tenantId') tenantId: string, @Body() corpo: unknown) {
    const analise = zProrrogacao.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    return this.escrevendoNoEspaco(req, tenantId, 'prorrogou_teste', async (c, correlacao) => {
      const r = await c.query<{ fim: string }>(
        'SELECT admin.prorrogar_teste($1, $2, $3, $4) AS fim',
        [tenantId, d.dias, d.razao, correlacao],
      )
      return { cortesiaAte: r.rows[0]!.fim }
    })
  }

  // -------------------------------------------------------------------------
  // Operadores — quem tem acesso ao painel
  // -------------------------------------------------------------------------

  /**
   * O que **eu** sou no painel.
   *
   * A única leitura de `concessoes_de_admin` que o painel faz, e ela é sobre
   * quem pergunta — exatamente o que a policy `concessao_propria` da `0031`
   * autoriza. Não há como usá-la para descobrir o nível de outra pessoa: o
   * `usuario_id` do `WHERE` é o da sessão, e a RLS repete a restrição embaixo.
   *
   * Serve para a tela decidir se mostra a seção de operadores. Esconder um
   * botão não é controle — a função no banco exige `super` de qualquer jeito —,
   * mas mostrar um botão que sempre recusa é uma interface que mente.
   */
  @Get('eu')
  async euNoPainel(@Req() req: FastifyRequest) {
    const operador = this.operador(req)
    return this.traduzindoRecusa(async () =>
      comAdmin(this.pool, contextoDeOperador(operador), async (c) => {
        const r = await c.query<{ nivel: string }>(
          `SELECT nivel FROM concessoes_de_admin
            WHERE usuario_id = $1 AND revogada_em IS NULL`,
          [operador],
        )
        // **`?? 'operador'` era o defeito S-3.** A policy `concessao_propria`
        // faz o trabalho dela e devolve zero linhas para quem não é operador; o
        // default transformava "não é operador" em "é operador comum", e a
        // casca do painel carregava para qualquer cliente autenticado.
        //
        // Ausência de linha é **ausência de concessão**, e o nome da recusa é o
        // mesmo que as funções levantam — para a tradução ser uma só.
        const linha = r.rows[0]
        if (!linha) throw new ForbiddenException('Esta conta não tem concessão de administrador ativa.')
        return { nivel: linha.nivel }
      }),
    )
  }

  /**
   * **Não existe rota que liste operadores, e a ausência é a decisão.**
   *
   * A migration `0031` restringe `mavia_admin` a enxergar a **própria**
   * concessão, com a razão escrita nela: *"uma policy ampla entregaria, numa
   * conexão sem segundo fator, a lista de todos os operadores da Mavia com nome
   * e e-mail — que é exatamente o alvo de quem já comprometeu um deles."*
   *
   * A DP-32 revista pôs o painel em produção **sem MFA**, o que torna esse
   * argumento mais forte e não menos: hoje a conexão é literalmente sem segundo
   * fator. Uma tela de "operadores" seria a lista pronta para quem entrasse com
   * uma sessão roubada.
   *
   * O que se perde é conveniência, e ela tem substituto: conceder e revogar
   * funcionam **por e-mail**, e as recusas `JA_E_OPERADOR` e `NAO_E_OPERADOR`
   * respondem sobre uma pessoa de cada vez. Dá para conferir alguém; não dá
   * para enumerar todo mundo. A diferença entre as duas coisas é o ataque.
   *
   * Quando o MFA existir, esta decisão pode ser revisitada — e aí ela é uma
   * ADR, não um `GET` que alguém acrescentou.
   */

  /**
   * Tornar alguém operador.
   *
   * **Escalada de privilégio por desenho**, e por isso três coisas ficam
   * explícitas: quem concede é quem pediu (a corrente de responsabilidade na
   * auditoria), o alvo é resolvido por e-mail, e a pessoa precisa já ter conta.
   *
   * Não abre espaço de cliente: uma concessão não pertence a espaço nenhum, e
   * `admin.conceder` grava a auditoria com `tenant_id` nulo desde a `0031`.
   */
  @Post('operadores')
  @HttpCode(201)
  async concederOperador(@Req() req: FastifyRequest, @Body() corpo: unknown) {
    const operador = this.operador(req)
    const analise = zOperador.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))

    return this.traduzindoRecusa(async () =>
      comAdminEscrita(this.poolDeEscrita, contextoDeOperadorEscrita(operador), async (c) => {
        const r = await c.query<{ id_da_concessao: string; usuario: string; ativos: number }>(
          'SELECT * FROM admin.conceder_operador($1, $2, $3::nivel_de_admin)',
          [analise.data.email, randomUUID(), analise.data.nivel],
        )
        return {
          id: r.rows[0]!.id_da_concessao,
          usuarioId: r.rows[0]!.usuario,
          operadoresAtivos: r.rows[0]!.ativos,
        }
      }),
    )
  }

  /**
   * Desligar um operador.
   *
   * **Desligar a si mesmo é livre para qualquer operador; desligar outra pessoa
   * exige `super`.** A regra vive em `admin.revogar_operador` (migration
   * `0047`), não aqui.
   *
   * ## O defeito S-4, registrado porque quase custou caro
   *
   * A `0045` escreveu a justificativa da auto-revogação — *"quem percebe que a
   * própria conta foi comprometida precisa poder se desligar sem esperar por
   * outra pessoa"* — e a `0046` a revogou ao exigir `super` para tudo, sem
   * mencionar. **Este comentário continuou descrevendo o controle removido**,
   * citando `exigir_dois_admins_ativos`, que nem chegava a rodar porque a
   * checagem de `super` recusava antes.
   *
   * Um controle descrito e ausente é pior que ausente: alguém conta com ele
   * durante um incidente. E sem MFA (DP-32 revista) esta é a contenção que
   * resta — a alternativa é SSH na VPS.
   *
   * As invariantes de contagem seguem por cima das duas: `exigir_dois_admins_
   * ativos` (`0031`) e `manter_um_super_ativo` (`0046`).
   */
  @Delete('operadores')
  @HttpCode(200)
  async revogarOperador(@Req() req: FastifyRequest, @Body() corpo: unknown) {
    const operador = this.operador(req)
    const analise = zOperador.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))

    return this.traduzindoRecusa(async () =>
      comAdminEscrita(this.poolDeEscrita, contextoDeOperadorEscrita(operador), async (c) => {
        const r = await c.query<{ usuario: string; ativos: number }>(
          'SELECT * FROM admin.revogar_operador($1, $2)',
          [analise.data.email, randomUUID()],
        )
        return { usuarioId: r.rows[0]!.usuario, operadoresAtivos: r.rows[0]!.ativos }
      }),
    )
  }

  // -------------------------------------------------------------------------
  // Preço e desconto — ADR 0025
  // -------------------------------------------------------------------------

  /**
   * O histórico de preço de cada plano.
   *
   * **Leitura sem espaço aberto**, porque preço não pertence a espaço nenhum:
   * é do produto. Nenhuma linha de `abrir_espaco` é escrita, e nenhuma deveria
   * ser — auditar "entrou no espaço X" para ler uma tabela sem tenant seria
   * registrar um acesso que não aconteceu.
   */
  @Get('precos')
  async precos(@Req() req: FastifyRequest) {
    const operador = this.operador(req)
    return this.traduzindoRecusa(async () =>
      comAdmin(this.pool, contextoDeOperador(operador), async (c) => {
        // **`SELECT` direto era o defeito S-1.** Esta rota era a única leitura do
        // painel que não passava por função `admin.*`, e é lá que a checagem de
        // concessão mora. `ROTAS_DE_ADMIN` dispensa a matriz de papéis e exige
        // só sessão — logo qualquer cliente autenticado lia o histórico de
        // preços com a nota interna do operador e o UUID de quem a escreveu.
        const r = await c.query('SELECT * FROM admin.listar_precos($1)', [100])
        return { itens: r.rows }
      }),
    )
  }

  /**
   * Trocar o preço-base de um plano. **Cria; nunca altera.**
   *
   * A ausência de Stripe **não bloqueia** esta rota — ver a D3 reescrita da ADR
   * 0025. Hoje ninguém é cobrado nada, então a nossa linha não é uma segunda
   * verdade sobre o preço: é a única. A trava contra cobrar errado vive na
   * abertura da assinatura, no épico 11, e não aqui.
   *
   * `assinaturasAfetadas` volta na resposta **sempre zero**, e a tela é
   * obrigada a mostrá-lo. Não é decoração: quem clica precisa ler, em número,
   * que ninguém que já paga vai ser tocado.
   */
  @Post('precos')
  @HttpCode(201)
  async criarPreco(@Req() req: FastifyRequest, @Body() corpo: unknown) {
    const operador = this.operador(req)
    const analise = zPrecoNovo.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    return this.traduzindoRecusa(async () =>
      comAdminEscrita(this.poolDeEscrita, contextoDeOperadorEscrita(operador), async (c) => {
        const r = await c.query<{ id_do_preco: string; valor_anterior: string | null }>(
          'SELECT * FROM admin.criar_preco($1, $2::intervalo_de_cobranca, $3::bigint, $4, $5, $6)',
          [d.plano, d.intervalo, d.centavos, d.motivo, randomUUID(), null],
        )
        return {
          id: r.rows[0]!.id_do_preco,
          valorAnterior: r.rows[0]!.valor_anterior,
          assinaturasAfetadas: 0,
        }
      }),
    )
  }

  /** O desconto vigente de um cliente, e o histórico dele. */
  @Get('clientes/:tenantId/descontos')
  async descontos(@Req() req: FastifyRequest, @Param('tenantId') tenantId: string) {
    return this.comEspacoAberto(req, tenantId, 'descontos', async (c) => {
      const r = await c.query(
        `SELECT id, especie, pontos_base, valor_centavos::text AS valor_centavos, moeda,
                duracao, meses, stripe_coupon_id, motivo, concedido_em, revogado_em
           FROM descontos_de_cliente WHERE tenant_id = $1 ORDER BY concedido_em DESC`,
        [tenantId],
      )
      return { itens: r.rows }
    })
  }

  /**
   * Conceder desconto. Substitui o vigente, e as duas linhas ficam.
   *
   * Este **abre o espaço do cliente**, ao contrário da rota de preço: o
   * desconto é do cliente, e conceder é um ato dentro do espaço dele — com
   * hipótese declarada e auditoria, como toda escrita do painel.
   */
  @Post('clientes/:tenantId/descontos')
  @HttpCode(201)
  async concederDesconto(
    @Req() req: FastifyRequest,
    @Param('tenantId') tenantId: string,
    @Body() corpo: unknown,
  ) {
    const analise = zDesconto.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    return this.escrevendoNoEspaco(req, tenantId, 'concedeu_desconto', async (c, correlacao) => {
      const r = await c.query<{ id: string }>(
        `SELECT admin.conceder_desconto($1, $2::especie_de_desconto, $3, $4::bigint,
                                        $5::duracao_de_desconto, $6, $7, $8, $9) AS id`,
        [
          tenantId,
          d.especie,
          d.pontosBase ?? null,
          d.centavos ?? null,
          d.duracao,
          d.meses ?? null,
          d.motivo,
          correlacao,
          null,
        ],
      )
      return { id: r.rows[0]!.id }
    })
  }

  @Delete('clientes/:tenantId/descontos')
  @HttpCode(200)
  async revogarDesconto(
    @Req() req: FastifyRequest,
    @Param('tenantId') tenantId: string,
    @Body() corpo: unknown,
  ) {
    const analise = zMotivo.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))

    return this.escrevendoNoEspaco(req, tenantId, 'revogou_desconto', async (c, correlacao) => {
      const r = await c.query<{ id: string }>(
        'SELECT admin.revogar_desconto($1, $2, $3) AS id',
        [tenantId, analise.data.motivo, correlacao],
      )
      return { id: r.rows[0]!.id }
    })
  }

  @Post('clientes/:tenantId/cortesia')
  @HttpCode(201)
  async concederCortesia(@Req() req: FastifyRequest, @Param('tenantId') tenantId: string, @Body() corpo: unknown) {
    return this.escrevendoContrato(req, tenantId, corpo, 'concedeu_cortesia', async (c, dados, correlacao) => {
      const r = await c.query<{ fim: string }>(
        'SELECT admin.conceder_cortesia($1, $2, $3, $4) AS fim',
        [tenantId, dados.dias, dados.razao, correlacao],
      )
      return { cortesiaAte: r.rows[0]!.fim }
    })
  }

  /**
   * O aviso entre pares — a única salvaguarda de **detecção** do épico.
   *
   * As demais são prevenção (a hipótese declarada antes do ato) ou forense (o
   * log). Esta é a que faz alguém **saber** que algo aconteceu sem precisar
   * procurar.
   *
   * **O destino é fora do painel** (DP-34, padrão vigente): uma notificação que
   * só existe dentro do sistema que ela vigia não detecta o comprometimento
   * desse sistema. Com um único operador ela é o conjunto vazio — e é
   * exatamente por isso que o destino é um endereço externo, e não a lista de
   * operadores.
   *
   * Sem `MAVIA_ALERTA_OPERACAO`, ela **não é enviada**, e o processo diz isso em
   * voz alta. É condição de deploy (C-11): o painel não vai a produção com a
   * detecção desligada.
   */
  private async avisarPares(operador: string, quantos: number): Promise<void> {
    const destino = process.env['MAVIA_ALERTA_OPERACAO']
    if (!destino) {
      console.warn(
        'registro de auditoria lido sem destino de alerta configurado — ' +
          'defina MAVIA_ALERTA_OPERACAO. A detecção entre pares está desligada.',
      )
      return
    }
    try {
      await this.mensageiro.enviar({
        para: destino,
        assunto: 'Mavia · alguém leu o registro de auditoria',
        corpo:
          `O operador ${operador} leu o registro de auditoria e recebeu ${quantos} linhas.` +
          NOVA_LINHA +
          NOVA_LINHA +
          'Se não foi você, e você não sabia disso, investigue agora.',
      })
    } catch (erro) {
      // Falhar em avisar não pode derrubar a leitura — mas precisa aparecer.
      console.error('falha ao avisar os pares sobre leitura do registro', erro)
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Uma escrita de contrato, com o **par de linhas** que a regra 18 exige.
   *
   * `abrir_espaco_para_escrita` grava a linha de **intenção** e devolve a
   * correlação; a função de contrato grava a de **efeito**, com `de → para`, e
   * carrega a mesma correlação. São duas linhas porque `auditoria` não aceita
   * `UPDATE` de ninguém: a linha da intenção existe **antes** de o valor novo
   * existir, e nunca pode ser completada depois. Achado F-14.
   */
  private async escrevendoContrato<T>(
    req: FastifyRequest,
    tenantId: string,
    corpo: unknown,
    acao: string,
    trabalho: (c: PoolClient, dados: { dias: number; razao: string }, correlacao: string) => Promise<T>,
  ): Promise<T> {
    const analise = zTempoConcedido.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))

    return this.escrevendoNoEspaco(req, tenantId, acao, (c, correlacao) =>
      trabalho(c, analise.data, correlacao),
    )
  }

  /**
   * Escrita dentro do espaço de um cliente, com o corpo já analisado.
   *
   * Extraído de `escrevendoContrato`, que era o mesmo bloco amarrado ao schema
   * de `{ dias, razao }`. As rotas de desconto têm corpos diferentes e a mesma
   * cerimônia — hipótese declarada, espaço aberto na mesma transação,
   * correlação vinda da própria função que auditou.
   *
   * A correlação **vem de `abrir_espaco_para_escrita`** e não é gerada aqui: é
   * ela que liga a linha de intenção à linha de efeito, e gerá-la fora
   * permitiria auditar um espaço e efetivar noutro.
   */
  private async escrevendoNoEspaco<T>(
    req: FastifyRequest,
    tenantId: string,
    acao: string,
    trabalho: (c: PoolClient, correlacao: string) => Promise<T>,
  ): Promise<T> {
    const { motivo, referencia } = this.hipotese(req)
    const operador = this.operador(req)

    return this.traduzindoRecusa(async () =>
      comTenantDeAdminEscrita(
        this.poolDeEscrita,
        contextoDeAdminEscrita(operador, tenantId),
        async (c) => {
          const r = await c.query<{ correlacao: string }>(
            `SELECT admin.abrir_espaco_para_escrita($1, $2::motivo_de_acesso, $3, $4, $5) AS correlacao`,
            [tenantId, motivo, referencia, acao, `/v1/admin/${acao}`],
          )
          return trabalho(c, r.rows[0]!.correlacao)
        },
      ),
    )
  }

  /**
   * Abre o espaço e roda a leitura, **numa transação só**.
   *
   * A linha de auditoria e o `set_config` acontecem dentro de
   * `admin.abrir_espaco`, com o mesmo parâmetro vinculado — não há como auditar
   * um tenant e efetivar outro. A contagem de registros é gravada **depois** da
   * leitura, numa segunda linha? Não: ela vai na mesma linha, porque a leitura
   * acontece na mesma transação e a contagem é conhecida antes do `COMMIT`.
   *
   * A resposta é montada **estritamente depois** do `COMMIT` — §1.8. Se a
   * transação não fechar, o operador não recebe dado nenhum.
   */
  private async comEspacoAberto<T extends { itens: unknown[] }>(
    req: FastifyRequest,
    tenantId: string,
    rota: string,
    leitura: (c: PoolClient) => Promise<T>,
  ) {
    const { motivo, referencia } = this.hipotese(req)
    const operador = this.operador(req)

    return this.traduzindoRecusa(async () =>
      comTenantDeAdmin(this.pool, contextoDeAdmin(operador, tenantId), async (c) => {
        const correlacao = await this.abrirEspaco(c, tenantId, motivo, referencia, 'leu', rota)
        const resultado = await leitura(c)

        // **A segunda linha, com a contagem** — e ela existe porque a primeira
        // não pode tê-la.
        //
        // `admin.abrir_espaco` roda **antes** da leitura: naquele instante
        // ninguém sabe quantos registros a consulta vai devolver. E `auditoria`
        // não aceita `UPDATE` de ninguém, então a linha da abertura nunca é
        // completada depois.
        //
        // A §8 promete "rota e contagem", e sem esta segunda linha a promessa
        // era falsa: medido no banco, as quatro telas de cliente gravavam
        // `registros` nulo. "Abriu o espaço" não responde à natureza dos dados
        // afetados que o art. 48 pede; "abriu o espaço, rota X, 143 registros"
        // responde.
        //
        // É a mesma forma do par intenção/efeito das escritas, e a `correlacao`
        // é o que permite afirmar que as duas são o mesmo ato.
        await c.query(
          `INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade,
                                  entidade_id, acao, classe, rota, registros, correlacao)
           VALUES ($1, $2, 'operador', 'tenant', $1, 'leu_registros',
                   'leitura_em_massa', $3, $4, $5)`,
          [tenantId, operador, rota, resultado.itens.length, correlacao],
        )

        return resultado
      }),
    )
  }

  private async abrirEspaco(
    c: PoolClient,
    tenantId: string,
    motivo: string,
    referencia: string,
    acao: string,
    rota: string,
  ): Promise<string> {
    const r = await c.query<{ correlacao: string }>(
      `SELECT admin.abrir_espaco($1, $2::motivo_de_acesso, $3, $4, $5) AS correlacao`,
      [tenantId, motivo, referencia, acao, rota],
    )
    return r.rows[0]!.correlacao
  }

  /**
   * `SEM_CONCESSAO_DE_ADMIN` vira **403**, não 500.
   *
   * A concessão é resolvida **por requisição**, dentro da função, contra
   * `concessoes_de_admin` — nunca carimbada no token. Revogar um operador tira
   * o acesso dele na requisição seguinte, sem esperar os quinze minutos de vida
   * do access token.
   */
  private async traduzindoRecusa<T>(trabalho: () => Promise<T>): Promise<T> {
    try {
      return await trabalho()
    } catch (erro) {
      const texto = String((erro as { message?: string }).message ?? '')
      if (texto.includes('SEM_CONCESSAO_DE_ADMIN')) {
        throw new ForbiddenException('Esta conta não tem concessão de administrador ativa.')
      }
      // **403 e não 400 — o defeito S-6.** `EXIGE_SUPERADMIN` estava na lista
      // `RECUSAS`, que traduz tudo para `BadRequestException`. Uma tentativa de
      // escalada de privilégio ficava indistinguível de erro de digitação em
      // qualquer alerta baseado em status.
      if (texto.includes('EXIGE_SUPERADMIN')) {
        throw new ForbiddenException(
          'Só um superadministrador concede acesso ao painel, ou desliga outra pessoa.',
        )
      }
      // As recusas das funções de contrato são **regra de negócio**, não falha:
      // teto excedido, estado que não permite, teste já prorrogado. Devolver
      // 500 faria o operador achar que o sistema quebrou quando ele apenas
      // pediu algo que a regra não autoriza.
      for (const [marca, frase] of RECUSAS) {
        if (texto.includes(marca)) throw new BadRequestException(frase)
      }
      throw erro
    }
  }
}
