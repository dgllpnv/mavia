import { randomBytes } from 'node:crypto'
import { createHash } from 'node:crypto'
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
  UnauthorizedException,
} from '@nestjs/common'
import { decidirEntradaFederada, type DecisaoDeEntrada } from '@mavia/domain'
import { z } from 'zod'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { POOL } from '../contas/contas.controller.js'
import { COFRE, LIMITE } from '../redis/tokens.js'
import { VIDA_DO_ACESSO_EM_SEGUNDOS, type CofreDeAcesso } from '../redis/cofre-de-acesso.js'
import { LimiteExcedido, type LimiteDeTentativas } from '../redis/limite-de-tentativas.js'
import { ESTADO_OAUTH, type EstadoDoOauth } from '../redis/estado-do-oauth.js'
import { comUsuario } from '../tenancy/tenancy.js'
import {
  cookieDeSessao,
  cookieDoOauth,
  cookieDoOauthDeSaida,
  vinculoDoCookie,
} from './cookie.js'
import {
  EntradaFederadaInvalida,
  gerarPkce,
  googleDoAmbiente,
  trocarCodigo,
  urlDeAutorizacao,
  type ConfiguracaoDoGoogle,
  type IdentidadeDoGoogle,
} from './oidc.js'

/**
 * Entrar com o Google — `spec-autenticacao.md` §1 e §2. Pendência P-4.
 *
 * **A decisão de o que fazer com uma identidade que chega não está aqui.** Ela
 * é pura, mora em `packages/domain/identidade`, e tem as seis combinações da
 * matriz enumeradas e testadas. Este arquivo faz o protocolo, consulta o banco
 * pelos fatos, e **obedece** à decisão.
 *
 * A separação é o que impede o erro clássico desta superfície: um `if` a mais
 * escrito às pressas num caso de suporte, que abre a porta que a matriz fechou.
 * Aqui não há `if` sobre identidade — há um `switch` sobre o que a função pura
 * devolveu, e o compilador cobra a exaustividade.
 *
 * ## As três recusas são a mesma recusa
 *
 * E-mail não verificado, endereço reatribuído e estado impossível produzem a
 * **mesma** mensagem e o **mesmo** status. O motivo vai para o log do operador,
 * separado. Distingui-los diria a quem controla uma caixa postal recém-tomada
 * se existe uma conta por trás dela — e, no caso da reatribuição, entregaria a
 * própria vítima.
 *
 * ## A única exceção, e ela é deliberada
 *
 * O caso C4 — a conta existe e **tem credencial própria** — pode dizer que a
 * conta existe. Quem está do outro lado acabou de provar ao Google que controla
 * aquele endereço; enumerar em massa exigiria controlar cada caixa testada. O
 * sinalizador `podeRevelarQueContaExiste` é explícito no domínio justamente
 * para que revelar seja uma decisão registrada, e não um descuido.
 */

const zIniciar = z.object({
  /**
   * Para onde voltar. **Caminho relativo, e o servidor confere.** Um destino
   * absoluto transformaria o login num redirecionador aberto — a porta que
   * transforma um link nosso em phishing convincente.
   */
  destino: z
    .string()
    .max(200)
    .regex(/^\/[^/\\]/, 'o destino é um caminho do próprio site')
    .optional(),
})

const zRetorno = z.object({
  codigo: z.string().min(1).max(2048),
  state: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * `mobile` muda a vida da sessão e faz o refresh sair no corpo. **O app ainda
   * não usa esta rota** (P-10/P-11), e quando usar precisará carregar o vínculo
   * do cookie por conta própria — o `__Host-` do navegador não existe lá. Está
   * declarado para que a diferença seja decidida, e não descoberta.
   */
  plataforma: z.enum(['web', 'mobile']).default('web'),
})

const VIDAS = {
  web: { deslizanteEmDias: 14, absolutoEmDias: 30 },
  mobile: { deslizanteEmDias: 60, absolutoEmDias: 180 },
} as const

const SEM_USUARIO = '00000000-0000-0000-0000-000000000000'

/** A única frase de recusa. Uma segunda é a diferença que enumera a base. */
const RECUSA = 'Não foi possível entrar com o Google.'

@Controller('v1/auth/google')
export class GoogleController {
  readonly #cfg: ConfiguracaoDoGoogle | null

  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(COFRE) private readonly cofre: CofreDeAcesso,
    @Inject(LIMITE) private readonly limite: LimiteDeTentativas,
    @Inject(ESTADO_OAUTH) private readonly estado: EstadoDoOauth,
  ) {
    this.#cfg = googleDoAmbiente()
  }

  /**
   * Começa: guarda `state`, `nonce` e o verificador PKCE, e devolve a URL.
   *
   * **Devolve a URL em vez de redirecionar** porque quem chama é a nossa
   * interface, por `fetch`, e um 302 numa resposta de `fetch` seria seguido
   * pelo navegador sem que a aplicação visse o que aconteceu.
   */
  @Post()
  @HttpCode(200)
  async iniciar(
    @Res({ passthrough: true }) resposta: FastifyReply,
    @Body() corpo: unknown,
  ): Promise<{ url: string }> {
    // A validação vem **antes** da configuração, e a ordem é deliberada: um
    // destino malformado é 400 quer o Google esteja ligado ou não. Com a ordem
    // invertida, a recusa do redirecionador aberto ficaria escondida atrás do
    // 503 desta instalação — e ninguém saberia se ela existe.
    const analise = zIniciar.safeParse(corpo ?? {})
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))

    const cfg = this.exigirConfiguracao()

    const pkce = gerarPkce()
    const tentativa = await this.estado.abrir(analise.data.destino ?? '/')

    // **O vínculo com o navegador, e é ele que impede o CSRF de login.** O
    // `state` sozinho não impede: o atacante que começa uma entrada com a conta
    // Google dele conhece o `state` — ele o gerou —, e um link entregue à
    // vítima faria a nossa própria tela concluir a entrada **na conta dele**. O
    // atacante não tem como escrever um cookie no navegador da vítima.
    resposta.header('set-cookie', cookieDoOauth(tentativa.vinculo))

    return {
      url: urlDeAutorizacao(cfg, {
        state: tentativa.state,
        nonce: tentativa.nonce,
        challenge: pkce.challenge,
      }),
    }
  }

  /**
   * O retorno. Consome o `state`, troca o código, verifica o `id_token` e
   * obedece à matriz.
   */
  @Post('retorno')
  @HttpCode(200)
  async retornar(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) resposta: FastifyReply,
    @Body() corpo: unknown,
  ): Promise<Record<string, unknown>> {
    const cfg = this.exigirConfiguracao()

    const analise = zRetorno.safeParse(corpo)
    if (!analise.success) throw new UnauthorizedException(RECUSA)
    const d = analise.data

    await this.contarTentativa(req)

    // O cookie sai **sempre**, inclusive nas recusas: a tentativa acabou de um
    // jeito ou de outro, e um vínculo que sobrevive a ela é lixo no navegador.
    resposta.header('set-cookie', cookieDoOauthDeSaida())

    // Uso único **e** vinculado ao navegador que começou. As duas coisas: a
    // primeira impede replay, a segunda impede CSRF de login, e confundi-las
    // foi o defeito da versão anterior deste arquivo.
    const tentativa = await this.estado.consumir(d.state, vinculoDoCookie(req.headers.cookie))
    if (!tentativa) throw new UnauthorizedException(RECUSA)

    let identidade: IdentidadeDoGoogle
    try {
      identidade = await trocarCodigo(cfg, d.codigo, tentativa.verifier, tentativa.nonce)
    } catch (erro) {
      this.registrarRecusa(erro instanceof EntradaFederadaInvalida ? erro.motivoInterno : 'troca')
      await this.limite.registrarFalha(this.origem(req))
      throw new UnauthorizedException(RECUSA)
    }

    const decisao = await this.decidir(identidade)

    switch (decisao.acao) {
      case 'entrar': {
        const usuarioId = await this.entrar(identidade)
        return { ...(await this.emitirSessao(resposta, usuarioId, d.plataforma)), destino: tentativa.destino }
      }

      case 'cadastrar': {
        const usuarioId = await this.cadastrar(identidade)
        return { ...(await this.emitirSessao(resposta, usuarioId, d.plataforma)), destino: tentativa.destino }
      }

      case 'exigir-prova':
        // C4, e a única resposta que revela existência. Ela **não** emite
        // sessão: a pessoa entra com a credencial que a conta já tem, e a
        // vinculação vira um fluxo autenticado. É a regra V-1 do spec — a posse
        // do e-mail nunca é prova suficiente.
        throw new HttpException(
          {
            message:
              'Já existe uma conta com este endereço. Entre com a sua senha e vincule o Google depois.',
            precisaEntrarComSenha: true,
          },
          409,
        )

      case 'recusar':
        this.registrarRecusa(decisao.motivoInterno, decisao.alertarOperador === true)
        await this.limite.registrarFalha(this.origem(req))
        throw new UnauthorizedException(RECUSA)
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Os fatos que a matriz precisa, buscados **antes** de decidir.
   *
   * Nenhum deles é opinião: são cinco consultas ao estado do banco, e a decisão
   * é uma função pura sobre elas.
   */
  private async decidir(id: IdentidadeDoGoogle): Promise<DecisaoDeEntrada> {
    const fatos = await comUsuario(this.pool, { usuarioId: SEM_USUARIO }, async (c) => {
      const r = await c.query<{
        usuario_id: string | null
        email: string | null
        mfa_ativo: boolean | null
        email_de_outro_subject: boolean | null
      }>('SELECT * FROM auth.resolver_identidade_federada($1, $2, $3)', [
        id.issuer,
        id.subject,
        id.email,
      ])
      const linha = r.rows[0]

      // A conta com aquele endereço, e se ela tem credencial própria. `senha` ou
      // `MFA` — as duas contam, porque as duas são coisas que só o dono tem.
      const doEmail = await c.query<{ tem_credencial: boolean }>(
        `SELECT (u.senha_hash IS NOT NULL OR u.mfa_ativado_em IS NOT NULL) AS tem_credencial
           FROM usuarios u
          WHERE lower(u.email) = lower($1) AND u.deleted_at IS NULL
          LIMIT 1`,
        [id.email],
      )

      return {
        subConhecido: linha?.usuario_id != null,
        emailVerificadoNoProvedor: id.emailVerificado,
        existeUsuarioComEsseEmail: (doEmail.rowCount ?? 0) > 0,
        usuarioTemSenhaOuMfa: doEmail.rows[0]?.tem_credencial === true,
        emailPertenceAOutroSubject: linha?.email_de_outro_subject === true,
      }
    })

    return decidirEntradaFederada(fatos)
  }

  private async entrar(id: IdentidadeDoGoogle): Promise<string> {
    return comUsuario(this.pool, { usuarioId: SEM_USUARIO }, async (c) => {
      await c.query('SELECT auth.registrar_login_federado($1, $2, $3)', [
        id.issuer,
        id.subject,
        id.email,
      ])
      const r = await c.query<{ usuario_id: string }>(
        'SELECT usuario_id FROM auth.resolver_identidade_federada($1, $2, $3)',
        [id.issuer, id.subject, id.email],
      )
      const usuarioId = r.rows[0]?.usuario_id
      if (!usuarioId) throw new UnauthorizedException(RECUSA)
      return usuarioId
    })
  }

  private async cadastrar(id: IdentidadeDoGoogle): Promise<string> {
    return comUsuario(this.pool, { usuarioId: SEM_USUARIO }, async (c) => {
      const r = await c.query<{ usuario_id: string }>(
        'SELECT * FROM auth.cadastrar_federado($1, $2, $3, $4, $5)',
        [id.issuer, id.subject, id.email, id.nome, 'Meu espaço'],
      )
      const usuarioId = r.rows[0]?.usuario_id
      if (!usuarioId) throw new UnauthorizedException(RECUSA)
      return usuarioId
    })
  }

  /**
   * Sem `client_id` configurado, a rota **recusa** em vez de fingir.
   *
   * 503 e não 500: é configuração ausente, não defeito. É a mesma escolha do
   * webhook da Stripe sem segredo e do cadastro sem SMTP.
   */
  private exigirConfiguracao(): ConfiguracaoDoGoogle {
    if (!this.#cfg) {
      throw new HttpException(
        'A entrada pelo Google não está configurada nesta instalação.',
        503,
      )
    }
    return this.#cfg
  }

  /**
   * O motivo da recusa vai para o log, **nunca para a resposta**.
   *
   * `estado-impossivel` alerta: significa que um usuário existe sem credencial
   * nenhuma, o que não deveria ser construível. Seguir em frente adivinhando é
   * pior que parar.
   */
  private registrarRecusa(motivo: string, alertar = false): void {
    const linha = `[google] entrada recusada: ${motivo}`
    if (alertar) console.error(`${linha} — ALERTA: estado que não deveria existir`)
    else console.warn(linha)
  }

  private async contarTentativa(req: FastifyRequest): Promise<void> {
    try {
      // Sem endereço a contar — ele só é conhecido depois da troca. A janela
      // por origem é a que vale aqui, e ela conta falhas.
      await this.limite.registrar(`google:${this.origem(req)}`, this.origem(req))
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
        [
          usuarioId,
          createHash('sha256').update(refresh, 'utf8').digest(),
          plataforma,
          vida.deslizanteEmDias,
          vida.absolutoEmDias,
        ],
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
