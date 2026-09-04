import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import {
  comAdmin,
  comTenantDeAdmin,
  comTenantDeAdminEscrita,
  contextoDeAdmin,
  contextoDeAdminEscrita,
  contextoDeOperador,
} from '../tenancy/tenancy.js'

export const POOL_DO_PAINEL = Symbol('POOL_DO_PAINEL')
export const POOL_DE_ESCRITA = Symbol('POOL_DE_ESCRITA')

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
  ['PRORROGACAO_ALEM_DO_TETO', 'A prorrogação do teste vai no máximo a sete dias.'],
  ['CORTESIA_ALEM_DO_TETO', 'A cortesia vai no máximo a trinta dias por vez.'],
  ['CORTESIA_ACUMULADA_ALEM_DO_TETO', 'Este espaço já acumulou sessenta dias de cortesia no período.'],
  ['TESTE_JA_PRORROGADO', 'O teste deste espaço já foi prorrogado uma vez.'],
  ['ESTADO_NAO_PERMITE_PRORROGACAO', 'Só um espaço em teste tem teste a prorrogar.'],
  ['ESTADO_NAO_PERMITE_CORTESIA', 'Este estado da assinatura não recebe cortesia.'],
  ['ASSINATURA_INEXISTENTE', 'Este espaço não tem assinatura.'],
  ['RAZAO_AUSENTE', 'Escreva a razão: ela vai para o registro.'],
  ['VALOR_INVALIDO', 'O valor da baixa é positivo, em centavos.'],
  ['RECEBIMENTO_NO_FUTURO', 'A data do recebimento não pode estar no futuro.'],
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
 * O corpo das duas escritas de tempo. `razao` é **obrigatória** e vai para a
 * linha de auditoria: uma cortesia sem motivo escrito é indistinguível de um
 * favor, e o teto de dias é conferido no banco — aqui a validação só evita uma
 * ida ao Postgres para recusar o óbvio.
 */
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

const zTempoConcedido = z.object({
  dias: z.number().int().min(1).max(30),
  razao: z.string().trim().min(3).max(280),
})

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
        `SELECT t.id, t.nome, t.criado_em,
                a.plano::text AS plano, a.estado::text AS estado,
                a.periodo_fim, a.graca_ate
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

  @Post('clientes/:tenantId/teste/prorrogar')
  @HttpCode(201)
  async prorrogarTeste(@Req() req: FastifyRequest, @Param('tenantId') tenantId: string, @Body() corpo: unknown) {
    return this.escrevendoContrato(req, tenantId, corpo, 'prorrogou_teste', async (c, dados, correlacao) => {
      const r = await c.query<{ fim: string }>(
        'SELECT admin.prorrogar_teste($1, $2, $3, $4) AS fim',
        [tenantId, dados.dias, dados.razao, correlacao],
      )
      return { cortesiaAte: r.rows[0]!.fim }
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
    const { motivo, referencia } = this.hipotese(req)
    const operador = this.operador(req)

    const analise = zTempoConcedido.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))

    return this.traduzindoRecusa(async () =>
      comTenantDeAdminEscrita(
        this.poolDeEscrita,
        contextoDeAdminEscrita(operador, tenantId),
        async (c) => {
          const r = await c.query<{ correlacao: string }>(
            `SELECT admin.abrir_espaco_para_escrita($1, $2::motivo_de_acesso, $3, $4, $5) AS correlacao`,
            [tenantId, motivo, referencia, acao, `/v1/admin/${acao}`],
          )
          return trabalho(c, analise.data, r.rows[0]!.correlacao)
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
        await this.abrirEspaco(c, tenantId, motivo, referencia, 'leu', rota)
        return leitura(c)
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
