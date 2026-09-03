import { createHash, randomBytes } from 'node:crypto'
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common'
import { z } from 'zod'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { POOL } from '../contas/contas.controller.js'
import { COFRE, LIMITE } from '../redis/tokens.js'
import { VIDA_DO_ACESSO_EM_SEGUNDOS, type CofreDeAcesso } from '../redis/cofre-de-acesso.js'
import { LimiteExcedido, type LimiteDeTentativas } from '../redis/limite-de-tentativas.js'
import { comUsuario } from '../tenancy/tenancy.js'
import { cookieDeSessao } from './cookie.js'
import { hashDeSenha } from './sessoes.controller.js'
import { MENSAGEIRO, type Mensageiro } from '../mensageiro/mensageiro.js'
import {
  confirmacaoDeCadastro,
  recuperacaoDeSenha,
  senhaAlterada,
} from '../mensageiro/mensagens.js'

/**
 * Cadastro por e-mail e recuperação de senha — spec §2.6 e §3.4. Pendência P-3.
 *
 * As funções de banco existiam desde a migration 0004 e esperavam por isto: a
 * superfície HTTP **não devia nascer antes do mensageiro**, porque um cadastro
 * que grava `cadastros_pendentes` e não consegue mandar o link deixa a pessoa
 * numa conta que ela não tem como confirmar, e sem caminho de saída.
 *
 * ## A propriedade que domina as quatro rotas
 *
 * **A resposta é a mesma tenha o endereço uma conta ou não.** Cadastrar com um
 * endereço já usado e cadastrar com um endereço novo produzem o mesmo 202 e o
 * mesmo corpo; pedir recuperação para quem existe e para quem não existe,
 * idem. Qualquer diferença aqui é um oráculo de enumeração — e num produto
 * financeiro a lista de clientes tem valor de mercado sozinha, sem senha
 * nenhuma.
 *
 * O que muda entre os casos é **qual e-mail sai**, e isso só quem tem a caixa
 * postal observa.
 *
 * ## Por que a recuperação é o caminho mais atacado
 *
 * É a única superfície não autenticada que **substitui** uma credencial. Login
 * compara; recuperação escreve. Daí as três travas, e nenhuma delas está nesta
 * camada por acaso:
 *
 * 1. **Conta sem senha não recebe token** (regra D5 da spec). Vive na função de
 *    banco, não aqui: sem ela, quem passasse a controlar o endereço de uma
 *    conta que só entra pelo Google *definiria* uma senha e entraria — a recusa
 *    de vinculação seria contornada pela porta dos fundos.
 * 2. **Trocar a senha derruba todas as sessões.** Recuperar sem revogar deixa
 *    o atacante logado depois de a vítima recuperar a conta.
 * 3. **O aviso de troca sai sempre**, inclusive quando a troca foi legítima. Um
 *    aviso que só chega em caso de fraude ensina o atacante a reconhecê-lo.
 */

const zCadastrar = z.object({
  email: z.string().trim().email().max(320),
  nome: z.string().trim().min(1, 'informe seu nome').max(120),
  /**
   * Doze, e não oito. O produto guarda dinheiro, e o teto de tentativas do
   * login já torna a senha curta o alvo óbvio. Sem regra de composição:
   * exigir símbolo produz `Senha@123`, que é pior do que uma frase longa.
   */
  senha: z.string().min(12, 'a senha precisa de ao menos 12 caracteres').max(1024),
  /** O nome do espaço. Sem ele, o padrão nomeia pela pessoa. */
  espaco: z.string().trim().min(1).max(80).optional(),
})

const zConfirmar = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/, 'token inválido'),
  plataforma: z.enum(['web', 'mobile']).default('web'),
})

const zRecuperar = z.object({ email: z.string().trim().email().max(320) })

const zRedefinir = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/, 'token inválido'),
  senha: z.string().min(12, 'a senha precisa de ao menos 12 caracteres').max(1024),
})

/** 24 h para confirmar, 1 h para redefinir. Ver spec §3.4. */
const VALIDADE_DO_CADASTRO_MS = 24 * 60 * 60 * 1000
const VALIDADE_DA_RECUPERACAO_MS = 60 * 60 * 1000

const SEM_USUARIO = '00000000-0000-0000-0000-000000000000'
const VIDAS = {
  web: { deslizanteEmDias: 14, absolutoEmDias: 30 },
  mobile: { deslizanteEmDias: 60, absolutoEmDias: 180 },
} as const

/** A única frase, nas duas rotas de emissão. Uma segunda enumera a base. */
const ENVIADO = 'Se este endereço puder receber, a mensagem já está a caminho.'

@Controller('v1')
export class CadastroController {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(COFRE) private readonly cofre: CofreDeAcesso,
    @Inject(LIMITE) private readonly limite: LimiteDeTentativas,
    @Inject(MENSAGEIRO) private readonly mensageiro: Mensageiro,
  ) {}

  /**
   * Registrar. **Não cria usuário nem tenant** — cria um pendente e manda o
   * link.
   *
   * 202, e não 201: nada foi criado ainda, e o código diz isso. Uma conta cujo
   * endereço não foi provado não tem canal de recuperação nem canal de
   * notificação de segurança, e num produto financeiro isso não é detalhe de
   * cadastro.
   */
  @Post('cadastro')
  @HttpCode(202)
  async cadastrar(
    @Req() req: FastifyRequest,
    @Body() corpo: unknown,
  ): Promise<{ mensagem: string }> {
    const analise = zCadastrar.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    this.exigirMensageiro()
    await this.contarTentativa(d.email, req)

    const token = randomBytes(32).toString('hex')
    const senhaHash = await hashDeSenha(d.senha)

    const cabe = await comUsuario(this.pool, { usuarioId: SEM_USUARIO }, async (c) => {
      const r = await c.query<{ registrar_pendente: boolean }>(
        'SELECT auth.registrar_pendente($1, $2, $3, $4, $5, $6)',
        [
          d.email,
          d.nome,
          senhaHash,
          hashDoToken(token),
          new Date(Date.now() + VALIDADE_DO_CADASTRO_MS),
          // O nome do espaço viaja **com o pendente**, e não como argumento da
          // confirmação: quem abre o link vem de um e-mail, possivelmente noutro
          // aparelho, e não tem como saber o que foi digitado no formulário.
          d.espaco ?? null,
        ],
      )
      return r.rows[0]?.registrar_pendente === true
    })

    // **O endereço já usado sai por aqui, com a mesma resposta.** Não mandamos
    // nada: um e-mail dizendo "você já tem conta" seria a confirmação que a
    // resposta HTTP se recusa a dar, entregue por outro canal.
    if (cabe) {
      await this.entregar(confirmacaoDeCadastro(d.email, d.nome, token))
    }

    return { mensagem: ENVIADO }
  }

  /**
   * O clique no link. Cria usuário, espaço e vínculo numa transação, e já
   * devolve a sessão — quem acabou de provar o endereço não precisa digitar a
   * senha que acabou de escolher.
   */
  @Post('cadastro/confirmar')
  @HttpCode(201)
  async confirmar(
    @Res({ passthrough: true }) resposta: FastifyReply,
    @Body() corpo: unknown,
  ): Promise<Record<string, unknown>> {
    const analise = zConfirmar.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    const criado = await comUsuario(this.pool, { usuarioId: SEM_USUARIO }, async (c) => {
      try {
        const r = await c.query<{ usuario_id: string; tenant_id: string }>(
          'SELECT * FROM auth.confirmar_cadastro($1, $2)',
          // O segundo argumento é o fallback de quem não escolheu nome no
          // formulário. O nome escolhido vem do pendente, dentro da função.
          [hashDoToken(d.token), 'Meu espaço'],
        )
        return r.rows[0] ?? null
      } catch (erro) {
        if ((erro as { message?: string }).message?.includes('CADASTRO_INVALIDO')) return null
        throw erro
      }
    })

    if (!criado) {
      // Expirado, já usado ou inventado — os três iguais. Distinguir "expirado"
      // de "não existe" diria a um atacante que aquele token um dia foi real.
      throw new BadRequestException('Este link não vale mais. Peça um novo cadastro.')
    }

    return this.emitirSessao(resposta, criado.usuario_id, d.plataforma)
  }

  /**
   * Pedir recuperação.
   *
   * A regra que fecha o buraco não está aqui: `auth.emitir_recuperacao` recusa
   * conta sem `senha_hash`. Repeti-la nesta camada daria a impressão de que o
   * banco confia na aplicação, e é o contrário.
   */
  @Post('senha/recuperar')
  @HttpCode(202)
  async recuperar(
    @Req() req: FastifyRequest,
    @Body() corpo: unknown,
  ): Promise<{ mensagem: string }> {
    const analise = zRecuperar.safeParse(corpo)
    if (!analise.success) throw new BadRequestException('Informe um e-mail.')
    const d = analise.data

    this.exigirMensageiro()
    await this.contarTentativa(d.email, req)

    const token = randomBytes(32).toString('hex')

    const emitiu = await comUsuario(this.pool, { usuarioId: SEM_USUARIO }, async (c) => {
      const r = await c.query<{ emitir_recuperacao: boolean }>(
        'SELECT auth.emitir_recuperacao($1, $2, $3, $4)',
        [
          d.email,
          hashDoToken(token),
          new Date(Date.now() + VALIDADE_DA_RECUPERACAO_MS),
          // O IP entra hasheado — achado A-39. Sem o guardião desselado ele
          // fica nulo: a prova de que alguém pediu recuperação não pode
          // depender do estado do cofre.
          null,
        ],
      )
      return r.rows[0]?.emitir_recuperacao === true
    })

    if (emitiu) await this.entregar(recuperacaoDeSenha(d.email, token))

    return { mensagem: ENVIADO }
  }

  /**
   * Redefinir. Consome o token, escreve a senha e **derruba todas as sessões**.
   *
   * A ordem importa: as sessões morrem na mesma unidade de trabalho da troca.
   * Trocar a senha e revogar depois deixa uma janela em que o atacante continua
   * logado com a senha nova já no lugar — e é a janela que ele usa.
   */
  @Post('senha/redefinir')
  @HttpCode(200)
  async redefinir(@Body() corpo: unknown): Promise<{ sessoesEncerradas: number }> {
    const analise = zRedefinir.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    const senhaHash = await hashDeSenha(d.senha)

    const desfecho = await comUsuario(this.pool, { usuarioId: SEM_USUARIO }, async (c) => {
      let usuarioId: string
      try {
        const r = await c.query<{ concluir_recuperacao: string }>(
          'SELECT auth.concluir_recuperacao($1, $2)',
          [hashDoToken(d.token), senhaHash],
        )
        usuarioId = r.rows[0]!.concluir_recuperacao
      } catch (erro) {
        const m = (erro as { message?: string }).message ?? ''
        if (m.includes('RECUPERACAO_INVALIDA') || m.includes('CONTA_SEM_SENHA')) return null
        throw erro
      }

      const revogadas = await this.revogarSessoes(c, usuarioId)
      const email = await this.emailDe(c, usuarioId)
      return { usuarioId, revogadas, email }
    })

    if (!desfecho) {
      throw new BadRequestException('Este link não vale mais. Peça a recuperação de novo.')
    }

    // Fora da transação: o Redis não participa dela, e um envio de e-mail
    // dentro de uma transação aberta prende conexão de pool pelo tempo do SMTP.
    for (const sessaoId of desfecho.revogadas) await this.cofre.revogarSessao(sessaoId)

    // O aviso **sempre**, e não só em caso suspeito: um aviso que só chega na
    // fraude ensina o atacante a reconhecê-lo. Se ele falhar, a senha já foi
    // trocada e as sessões já caíram — o desfecho de segurança está feito, e
    // derrubar a resposta agora só confundiria quem acabou de redefinir.
    if (desfecho.email) {
      await this.entregar(senhaAlterada(desfecho.email)).catch(() => {})
    }

    return { sessoesEncerradas: desfecho.revogadas.length }
  }

  // -------------------------------------------------------------------------

  /**
   * Sem SMTP, a rota recusa em vez de fingir.
   *
   * 503 e não 500: é configuração ausente, não defeito. E não 202 — um 202 que
   * não manda e-mail nenhum é a pior das três respostas, porque a pessoa espera
   * para sempre e o log diz que deu certo.
   */
  private exigirMensageiro(): void {
    if (!this.mensageiro.configurado) {
      throw new HttpException(
        'O envio de e-mail não está configurado nesta instalação. Fale com quem a administra.',
        503,
      )
    }
  }

  private async entregar(mensagem: Parameters<Mensageiro['enviar']>[0]): Promise<void> {
    await this.mensageiro.enviar(mensagem)
  }

  /**
   * O mesmo contador do login, e de propósito.
   *
   * Sem ele, cadastro e recuperação viram o caminho barato para descobrir quais
   * endereços existem — pela latência, se não pelo corpo — e para inundar a
   * caixa de terceiros. Conta por endereço, como o login: quem tenta mil
   * endereços diferentes é pego pela janela por origem.
   */
  private async contarTentativa(email: string, req: FastifyRequest): Promise<void> {
    try {
      await this.limite.registrar(email, this.origem(req))
    } catch (erro) {
      if (erro instanceof LimiteExcedido) {
        throw new HttpException({ message: erro.message, retryAfter: erro.segundosAteLiberar }, 429)
      }
      throw erro
    }
  }

  private origem(req: FastifyRequest): string {
    const encaminhado = req.headers['x-forwarded-for']
    if (typeof encaminhado === 'string' && encaminhado.length > 0) {
      return encaminhado.split(',')[0]?.trim() ?? req.ip
    }
    return req.ip
  }

  private async revogarSessoes(c: PoolClient, usuarioId: string): Promise<string[]> {
    await c.query('SELECT set_config($1, $2, true)', ['app.usuario_id', usuarioId])
    const r = await c.query<{ id: string }>(
      `UPDATE sessoes SET revogada_em = now()
        WHERE usuario_id = $1 AND revogada_em IS NULL
        RETURNING id`,
      [usuarioId],
    )
    return r.rows.map((l) => l.id)
  }

  private async emailDe(c: PoolClient, usuarioId: string): Promise<string | null> {
    await c.query('SELECT set_config($1, $2, true)', ['app.usuario_id', usuarioId])
    const r = await c.query<{ email: string }>('SELECT email FROM usuarios WHERE id = $1', [
      usuarioId,
    ])
    return r.rows[0]?.email ?? null
  }

  private async emitirSessao(
    resposta: FastifyReply,
    usuarioId: string,
    plataforma: 'web' | 'mobile',
  ): Promise<Record<string, unknown>> {
    const refresh = randomBytes(32).toString('hex')
    const vida = VIDAS[plataforma]

    const sessaoId = await comUsuario(this.pool, { usuarioId }, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO sessoes (usuario_id, familia_id, refresh_hash, plataforma,
                              expira_em, expira_absoluto_em)
         VALUES ($1, gen_random_uuid(), $2, $3::plataforma_de_sessao,
                 now() + ($4 || ' days')::interval, now() + ($5 || ' days')::interval)
         RETURNING id`,
        [usuarioId, hashDoToken(refresh), plataforma, vida.deslizanteEmDias, vida.absolutoEmDias],
      )
      return r.rows[0]!.id
    })

    const acesso = await this.cofre.emitir({ sessaoId, usuarioId })

    const dados = await comUsuario(this.pool, { usuarioId }, async (c) => {
      const u = await c.query('SELECT id, nome, email FROM usuarios WHERE id = $1', [usuarioId])
      const t = await c.query(
        `SELECT t.id, t.nome, tu.papel
           FROM tenant_usuarios tu JOIN tenants t ON t.id = tu.tenant_id
          WHERE tu.usuario_id = $1 AND tu.removido_em IS NULL`,
        [usuarioId],
      )
      return { usuario: u.rows[0], tenants: t.rows }
    })

    const base = { acesso, expiraEmSegundos: VIDA_DO_ACESSO_EM_SEGUNDOS, ...dados }

    // No web o refresh vai só no cookie `HttpOnly`. Devolvê-lo também no corpo
    // tornaria o cookie decorativo — bastaria um XSS ler a resposta.
    if (plataforma === 'web') {
      resposta.header(
        'set-cookie',
        cookieDeSessao(refresh, { maxAgeEmSegundos: vida.deslizanteEmDias * 24 * 60 * 60 }),
      )
      return base
    }

    return { ...base, refresh }
  }
}

function hashDoToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}
