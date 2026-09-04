import { randomBytes, createHash } from 'node:crypto'
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import { hash, verify } from '@node-rs/argon2'
import { z } from 'zod'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { POOL } from '../contas/contas.controller.js'
import { COFRE, LIMITE } from '../redis/tokens.js'
import type { CofreDeAcesso } from '../redis/cofre-de-acesso.js'
import { VIDA_DO_ACESSO_EM_SEGUNDOS } from '../redis/cofre-de-acesso.js'
import { LimiteExcedido, type LimiteDeTentativas } from '../redis/limite-de-tentativas.js'
import { comUsuario, contextoDeUsuario } from '../tenancy/tenancy.js'
import { cookieDeSaida, cookieDeSessao, tokenDoCookie } from './cookie.js'
import { SessaoGuard } from './sessao.guard.js'

/**
 * Entrada, renovação e saída — `docs/produto/spec-autenticacao.md` §4.
 *
 * A propriedade que domina o login: **as respostas de falha são
 * indistinguíveis entre si**. Senha errada, endereço que não existe e conta que
 * só entra pelo Google produzem o mesmo status, o mesmo corpo e — pela
 * verificação fantasma — um tempo da mesma ordem. Qualquer diferença aqui
 * transforma a rota num oráculo que enumera a base de clientes, e um oráculo
 * de enumeração não precisa de senha nenhuma para ter valor de mercado.
 *
 * ## Os dois tokens
 *
 * | | Forma | Vida | Onde vive |
 * |---|---|---|---|
 * | **Access** | opaco, 256 bits | 15 min | Redis; no cliente, memória |
 * | **Refresh** | opaco, 256 bits | deslizante com teto absoluto | Postgres; no cliente, cookie `__Host-` (web) ou Keychain/Keystore (mobile) |
 *
 * Redis é autoridade do access, Postgres é autoridade do refresh. Perder o
 * Redis não desloga ninguém — os clientes renovam em silêncio.
 */

const zEntrar = z.object({
  email: z.string().trim().email().max(320),
  // O mínimo é do cadastro, não daqui: recusar por tamanho no login diria
  // "essa senha não poderia ser de ninguém", que já é informação.
  senha: z.string().min(1).max(1024),
  /**
   * Duas, porque a coluna tem duas (`plataforma_de_sessao`). Aceitar `ios` e
   * `android` aqui prometeria uma distinção que o banco não guarda, e a
   * promessa só apareceria como mentira no dia da auditoria de sessões.
   */
  plataforma: z.enum(['web', 'mobile']),
})

/**
 * Hash constante para a verificação fantasma.
 *
 * Endereço inexistente executa um Argon2 real contra este valor antes de
 * responder. Sem isso, o caminho sem usuário volta em microssegundos e o
 * caminho com usuário em dezenas de milissegundos — duas ordens de grandeza de
 * diferença, mensuráveis pela rede, e as respostas idênticas não adiantam nada.
 */
const HASH_FANTASMA =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$8Rs9nJqCg0e2wSSCK0dbrzCq0GTBhTsjfPUKzPfnCrE'

/**
 * Vidas do refresh, por plataforma — DP-24, do dono do produto.
 *
 * O piso de segurança não são os números: é a rotação e o teto absoluto
 * existirem. O mobile é mais longo de propósito — exigir login a cada quatorze
 * dias num app de finanças é o que faz a pessoa escolher uma senha pior.
 */
const VIDAS = {
  web: { deslizanteEmDias: 14, absolutoEmDias: 30 },
  mobile: { deslizanteEmDias: 60, absolutoEmDias: 180 },
} as const

interface Espaco {
  readonly id: string
  readonly nome: string
  readonly papel: string
}

interface Emissao {
  readonly acesso: string
  readonly expiraEmSegundos: number
  readonly refresh?: string
  readonly usuario: unknown
  readonly tenants: Espaco[]
}

@Controller('v1')
export class SessoesController {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(COFRE) private readonly cofre: CofreDeAcesso,
    @Inject(LIMITE) private readonly limite: LimiteDeTentativas,
  ) {}

  @Post('sessoes')
  @HttpCode(201)
  async entrar(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) resposta: FastifyReply,
    @Body() corpo: unknown,
  ): Promise<Emissao> {
    const analise = zEntrar.safeParse(corpo)
    // 400 e não 401: um corpo que não é uma credencial não pode ser recusado
    // como credencial errada.
    if (!analise.success) throw new BadRequestException('Informe e-mail, senha e plataforma.')
    const d = analise.data

    // A janela por endereço conta **antes** da verificação, e conta também
    // endereço inexistente: contar só as falhas deixaria passar quem tem uma
    // credencial válida entre mil inválidas, e não contar o inexistente seria
    // um oráculo de existência com outro nome. A janela por origem é só lida
    // aqui — ela conta falhas, e a falha ainda não aconteceu.
    try {
      await this.limite.registrar(d.email, this.origem(req))
    } catch (erro) {
      if (erro instanceof LimiteExcedido) {
        throw new HttpException(
          { message: erro.message, retryAfter: erro.segundosAteLiberar },
          429,
        )
      }
      throw erro
    }

    const credencial = await this.buscarCredencial(d.email)

    // Um `if` só, e o mesmo desfecho nos três casos: sem usuário, sem senha
    // (conta federada) e senha errada. Separá-los daria três caminhos com três
    // tempos, que é exatamente o que a verificação fantasma existe para evitar.
    const confere = await verify(credencial?.senha_hash ?? HASH_FANTASMA, d.senha).catch(
      () => false,
    )
    if (!credencial?.senha_hash || !confere) {
      // A falha alimenta a janela por origem — o sinal de *spraying*. O acerto
      // não a alimenta, e é isso que impede um escritório inteiro de ficar
      // trancado por estar usando o produto.
      await this.limite.registrarFalha(this.origem(req))
      throw new UnauthorizedException(RECUSA)
    }

    await this.limite.limpar(d.email)

    const usuarioId = credencial.usuario_id
    const refresh = randomBytes(32).toString('hex')
    const sessaoId = await this.criarSessao(usuarioId, refresh, d.plataforma)
    const acesso = await this.cofre.emitir({ sessaoId, usuarioId })

    return this.responder(resposta, d.plataforma, { acesso, refresh, usuarioId })
  }

  /**
   * Renovar: consome o refresh apresentado e emite outro.
   *
   * **Apresentar um refresh já consumido revoga a família inteira.** Duas
   * cópias do mesmo token no mundo é roubo até prova em contrário, e a prova
   * não existe. A linha antiga fica no banco de propósito — ela é a armadilha.
   *
   * Um refresh desconhecido ou vencido, por outro lado, **não** é incidente: é
   * um cliente com credencial velha, e a resposta é 401 seca.
   */
  @Post('sessoes/renovar')
  @HttpCode(200)
  async renovar(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) resposta: FastifyReply,
    @Body() corpo: unknown,
  ): Promise<Emissao> {
    const apresentado = this.refreshDaRequisicao(req, corpo)
    if (!apresentado) throw new UnauthorizedException(SEM_SESSAO)

    const novo = randomBytes(32).toString('hex')
    const plataforma = this.plataformaDaRequisicao(req, corpo)
    const vida = VIDAS[plataforma]

    const r = await comUsuario(this.pool, contextoDeUsuario(SEM_USUARIO), async (c) => {
      const saida = await c.query<{
        desfecho: 'rotacionada' | 'reuso'
        sessao_id: string
        usuario_id: string
        sessoes_revogadas: string[]
      }>('SELECT * FROM auth.rotacionar_sessao($1, $2, $3)', [
        hashDoToken(apresentado),
        hashDoToken(novo),
        vida.deslizanteEmDias * 24 * 60 * 60,
      ])
      return saida.rows[0] ?? null
    })

    if (!r) {
      resposta.header('set-cookie', cookieDeSaida())
      throw new UnauthorizedException(SEM_SESSAO)
    }

    // Em qualquer desfecho, os access tokens das sessões afetadas morrem no
    // ato. Sem isto a revogação seria imediata no Postgres e teria até quinze
    // minutos de atraso no Redis — a janela que o token opaco existe para
    // eliminar.
    await this.cofre.revogarSessoes(r.sessoes_revogadas)

    if (r.desfecho === 'reuso') {
      resposta.header('set-cookie', cookieDeSaida())
      throw new UnauthorizedException(
        'Sua sessão foi encerrada por segurança: este acesso foi apresentado duas vezes. Entre de novo.',
      )
    }

    const acesso = await this.cofre.emitir({ sessaoId: r.sessao_id, usuarioId: r.usuario_id })
    return this.responder(resposta, plataforma, {
      acesso,
      refresh: novo,
      usuarioId: r.usuario_id,
    })
  }

  /**
   * Quem sou eu e quais espaços tenho.
   *
   * A única rota autenticada que **não** exige `X-Mavia-Tenant`: ela é a
   * pergunta cuja resposta é o cabeçalho. Exigi-lo aqui seria circular, e a
   * saída seria o cliente adivinhar um tenant — que é a escolha implícita que
   * a decisão D9 proíbe.
   */
  @Get('eu')
  @UseGuards(SessaoGuard)
  async eu(@Req() req: FastifyRequest): Promise<{ usuario: unknown; tenants: Espaco[] }> {
    const usuarioId = req.sessao!.usuarioId
    return {
      usuario: await this.carregarUsuario(usuarioId),
      tenants: await this.espacosDo(usuarioId),
    }
  }

  /**
   * Sair revoga **no ato**, no Postgres e no Redis.
   *
   * Uma sessão que continua valendo até expirar torna o botão "sair" uma
   * promessa que o servidor não cumpre — e é o botão que a pessoa aperta
   * justamente quando desconfia de alguma coisa.
   */
  @Delete('sessoes/atual')
  @HttpCode(204)
  @UseGuards(SessaoGuard)
  async sair(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) resposta: FastifyReply,
  ): Promise<void> {
    const { sessaoId, usuarioId } = req.sessao!

    // O refresh também: sem revogá-lo, sair mataria quinze minutos de access e
    // deixaria semanas de refresh vivas no cookie que o navegador ainda tem.
    const apresentado = tokenDoCookie(req.headers.cookie)
    if (apresentado) {
      await comUsuario(this.pool, contextoDeUsuario(SEM_USUARIO), (c) =>
        c.query('SELECT * FROM auth.revogar_sessao($1, $2)', [
          hashDoToken(apresentado),
          'saida_do_usuario',
        ]),
      )
    } else {
      await comUsuario(this.pool, contextoDeUsuario(usuarioId), (c) =>
        c.query(
          `UPDATE sessoes SET revogada_em = now(), motivo_revogacao = 'saida_do_usuario'
            WHERE id = $1 AND revogada_em IS NULL`,
          [sessaoId],
        ),
      )
    }

    await this.cofre.revogarSessao(sessaoId)
    resposta.header('set-cookie', cookieDeSaida())
  }

  /**
   * Desconectar os outros dispositivos.
   *
   * O efeito é **imediato**, e é o requisito que dispensou o JWT: cada sessão
   * revogada tem os seus access tokens apagados do Redis na mesma chamada.
   */
  @Post('sessoes/revogar-outras')
  @HttpCode(200)
  @UseGuards(SessaoGuard)
  async revogarOutras(@Req() req: FastifyRequest): Promise<{ revogadas: number }> {
    const apresentado = tokenDoCookie(req.headers.cookie) ?? this.refreshDoCabecalho(req)
    if (!apresentado) {
      throw new BadRequestException(
        'Esta operação precisa do seu acesso atual para saber qual sessão preservar.',
      )
    }

    const ids = await comUsuario(this.pool, contextoDeUsuario(SEM_USUARIO), async (c) => {
      const r = await c.query<{ sessao_id: string }>(
        'SELECT * FROM auth.revogar_familia($1, $2)',
        [hashDoToken(apresentado), 'revogadas_pelo_usuario'],
      )
      return r.rows.map((l) => l.sessao_id)
    })

    await this.cofre.revogarSessoes(ids)
    return { revogadas: ids.length }
  }

  // -------------------------------------------------------------------------

  /**
   * No web o refresh nunca chega ao JavaScript da página: devolvê-lo no corpo
   * tornaria o cookie `HttpOnly` decorativo — bastaria um XSS ler a resposta do
   * próprio login. O mobile recebe no corpo porque guarda no Keychain/Keystore,
   * que o cookie jar não substitui.
   */
  private async responder(
    resposta: FastifyReply,
    plataforma: 'web' | 'mobile',
    dados: { acesso: string; refresh: string; usuarioId: string },
  ): Promise<Emissao> {
    const base = {
      acesso: dados.acesso,
      expiraEmSegundos: VIDA_DO_ACESSO_EM_SEGUNDOS,
      usuario: await this.carregarUsuario(dados.usuarioId),
      tenants: await this.espacosDo(dados.usuarioId),
    }

    if (plataforma === 'web') {
      resposta.header(
        'set-cookie',
        cookieDeSessao(dados.refresh, {
          maxAgeEmSegundos: VIDAS.web.deslizanteEmDias * 24 * 60 * 60,
        }),
      )
      return base
    }

    return { ...base, refresh: dados.refresh }
  }

  /** Cookie no web, corpo no mobile. Nunca query string: URL vai para log. */
  private refreshDaRequisicao(req: FastifyRequest, corpo: unknown): string | null {
    const doCookie = tokenDoCookie(req.headers.cookie)
    if (doCookie) return doCookie

    const analise = z.object({ refresh: z.string().regex(/^[0-9a-f]{64}$/) }).safeParse(corpo)
    return analise.success ? analise.data.refresh : null
  }

  private refreshDoCabecalho(req: FastifyRequest): string | null {
    const bruto = req.headers['x-mavia-refresh']
    return typeof bruto === 'string' && /^[0-9a-f]{64}$/.test(bruto) ? bruto : null
  }

  private plataformaDaRequisicao(req: FastifyRequest, corpo: unknown): 'web' | 'mobile' {
    // O cookie só existe no web; o corpo com refresh só existe no mobile.
    if (tokenDoCookie(req.headers.cookie)) return 'web'
    const analise = z.object({ refresh: z.string() }).safeParse(corpo)
    return analise.success ? 'mobile' : 'web'
  }

  /**
   * A origem da requisição, para o contador por IP.
   *
   * `x-forwarded-for` é confiável **atrás do nosso Traefik** e mais nada; o
   * primeiro endereço da lista é o que o proxy anotou. Sem proxy, cai no
   * endereço do socket.
   */
  private origem(req: FastifyRequest): string {
    const encaminhado = req.headers['x-forwarded-for']
    if (typeof encaminhado === 'string' && encaminhado.length > 0) {
      return encaminhado.split(',')[0]?.trim() ?? req.ip
    }
    return req.ip
  }

  private async buscarCredencial(
    email: string,
  ): Promise<{ usuario_id: string; senha_hash: string | null } | null> {
    return comUsuario(this.pool, contextoDeUsuario(SEM_USUARIO), async (c) => {
      const r = await c.query<{ usuario_id: string; senha_hash: string | null }>(
        'SELECT usuario_id, senha_hash FROM auth.buscar_credencial($1)',
        [email],
      )
      return r.rows[0] ?? null
    })
  }

  private async criarSessao(
    usuarioId: string,
    refresh: string,
    plataforma: 'web' | 'mobile',
  ): Promise<string> {
    const vida = VIDAS[plataforma]
    return comUsuario(this.pool, contextoDeUsuario(usuarioId), async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO sessoes (usuario_id, familia_id, refresh_hash, plataforma,
                              expira_em, expira_absoluto_em)
         VALUES ($1, gen_random_uuid(), $2, $3::plataforma_de_sessao,
                 now() + ($4 || ' days')::interval, now() + ($5 || ' days')::interval)
         RETURNING id`,
        [usuarioId, hashDoToken(refresh), plataforma, vida.deslizanteEmDias, vida.absolutoEmDias],
      )
      const id = r.rows[0]?.id
      if (!id) throw new UnauthorizedException(RECUSA)
      return id
    })
  }

  private async carregarUsuario(usuarioId: string): Promise<unknown> {
    return comUsuario(this.pool, contextoDeUsuario(usuarioId), async (c) => {
      const r = await c.query<{ id: string; nome: string; email: string }>(
        'SELECT id, nome, email FROM usuarios WHERE id = $1 AND deleted_at IS NULL',
        [usuarioId],
      )
      // Nunca `SELECT *`: `senha_hash` mora nesta tabela, e uma coluna nova
      // não pode entrar numa resposta de API por descuido de projeção.
      return r.rows[0] ?? null
    })
  }

  private async espacosDo(usuarioId: string): Promise<Espaco[]> {
    return comUsuario(this.pool, contextoDeUsuario(usuarioId), async (c) => {
      const r = await c.query<Espaco>(
        `SELECT t.id, t.nome, tu.papel FROM tenant_usuarios tu
           JOIN tenants t ON t.id = tu.tenant_id
          WHERE tu.usuario_id = $1 AND t.deleted_at IS NULL
          ORDER BY t.nome`,
        [usuarioId],
      )
      return r.rows
    })
  }
}

/**
 * A única frase de recusa. Uma segunda frase, em qualquer condição, é a
 * diferença que enumera a base.
 */
const RECUSA = 'E-mail ou senha inválidos.'
const SEM_SESSAO = 'Sua sessão expirou. Entre de novo.'

const SEM_USUARIO = '00000000-0000-0000-0000-000000000000'

function hashDoToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

/** Reexportado para o cadastro, que grava a mesma forma de hash. */
export const hashDeSenha = (senha: string): Promise<string> => hash(senha)
