import { randomBytes, createHash } from 'node:crypto'
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { comUsuario } from '../tenancy/tenancy.js'
import { cookieDeSaida, cookieDeSessao } from './cookie.js'
import { SessaoGuard } from './sessao.guard.js'

/**
 * Entrada e saída da plataforma — `docs/produto/spec-autenticacao.md`.
 *
 * A propriedade que domina este arquivo: **as respostas de falha são
 * indistinguíveis entre si**. Senha errada, endereço que não existe e conta que
 * só entra pelo Google produzem o mesmo status, o mesmo corpo e — pela
 * verificação fantasma — um tempo da mesma ordem. Qualquer diferença aqui
 * transforma a rota num oráculo que enumera a base de clientes, e um oráculo
 * de enumeração não precisa de senha nenhuma para ter valor de mercado.
 *
 * **O que ainda não está aqui, e é dívida declarada** (`docs/pendencias.md`):
 * a decisão D6 do spec — token de acesso de 15 minutos no Redis e refresh
 * rotacionado a cada uso — depende do Redis, que entra no épico 5. Até lá a
 * sessão é o token opaco com validade deslizante e teto absoluto que as
 * migrations 0003 já modelam, e a detecção de reuso por família fica sem uso.
 * Limite de tentativas por endereço e por IP tem a mesma dependência.
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

/** Deslizante de 14 dias, teto absoluto de 30. Ver `sessoes` na 0003. */
const DIAS_DESLIZANTE = 14
const DIAS_ABSOLUTO = 30

interface Espaco {
  readonly id: string
  readonly nome: string
  readonly papel: string
}

@Controller('v1')
export class SessoesController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Post('sessoes')
  @HttpCode(201)
  async entrar(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) resposta: FastifyReply,
    @Body() corpo: unknown,
  ): Promise<{ token?: string; usuario: unknown; tenants: Espaco[] }> {
    const analise = zEntrar.safeParse(corpo)
    // 400 e não 401: um corpo que não é uma credencial não pode ser recusado
    // como credencial errada.
    if (!analise.success) throw new BadRequestException('Informe e-mail, senha e plataforma.')
    const d = analise.data

    const credencial = await this.buscarCredencial(d.email)

    // Um `if` só, e o mesmo desfecho nos três casos: sem usuário, sem senha
    // (conta federada) e senha errada. Separá-los daria três caminhos com três
    // tempos, que é exatamente o que a verificação fantasma existe para evitar.
    const confere = await verify(credencial?.senha_hash ?? HASH_FANTASMA, d.senha).catch(
      () => false,
    )
    if (!credencial?.senha_hash || !confere) throw new UnauthorizedException(RECUSA)

    const usuarioId = credencial.usuario_id
    const token = randomBytes(32).toString('hex')
    await this.criarSessao(usuarioId, token, d.plataforma)

    const usuario = await this.carregarUsuario(usuarioId)
    const tenants = await this.espacosDo(usuarioId)

    if (d.plataforma === 'web') {
      // No web o token nunca chega ao JavaScript da página. Devolvê-lo no
      // corpo tornaria o cookie `HttpOnly` decorativo — bastaria um XSS ler a
      // resposta do próprio login.
      resposta.header('set-cookie', cookieDeSessao(token, {
        maxAgeEmSegundos: DIAS_DESLIZANTE * 24 * 60 * 60,
      }))
      return { usuario, tenants }
    }

    // O mobile guarda no Keychain/Keystore, que o cookie jar não substitui.
    return { token, usuario, tenants }
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
   * Sair revoga **no ato**.
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

    await comUsuario(this.pool, { usuarioId }, async (c) => {
      await c.query(
        `UPDATE sessoes SET revogada_em = now(), motivo_revogacao = 'saida_do_usuario'
          WHERE id = $1 AND revogada_em IS NULL`,
        [sessaoId],
      )
    })

    resposta.header('set-cookie', cookieDeSaida())
  }

  private async buscarCredencial(
    email: string,
  ): Promise<{ usuario_id: string; senha_hash: string | null } | null> {
    return comUsuario(this.pool, { usuarioId: SEM_USUARIO }, async (c) => {
      const r = await c.query<{ usuario_id: string; senha_hash: string | null }>(
        'SELECT usuario_id, senha_hash FROM auth.buscar_credencial($1)',
        [email],
      )
      return r.rows[0] ?? null
    })
  }

  private async criarSessao(usuarioId: string, token: string, plataforma: string): Promise<void> {
    await comUsuario(this.pool, { usuarioId }, async (c) => {
      await c.query(
        `INSERT INTO sessoes (usuario_id, familia_id, refresh_hash, plataforma,
                              expira_em, expira_absoluto_em)
         VALUES ($1, gen_random_uuid(), $2, $3::plataforma_de_sessao,
                 now() + ($4 || ' days')::interval, now() + ($5 || ' days')::interval)`,
        [usuarioId, hashDoToken(token), plataforma, DIAS_DESLIZANTE, DIAS_ABSOLUTO],
      )
    })
  }

  private async carregarUsuario(usuarioId: string): Promise<unknown> {
    return comUsuario(this.pool, { usuarioId }, async (c) => {
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
    return comUsuario(this.pool, { usuarioId }, async (c) => {
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

const SEM_USUARIO = '00000000-0000-0000-0000-000000000000'

function hashDoToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

/** Reexportado para o cadastro, que grava a mesma forma de hash. */
export const hashDeSenha = (senha: string): Promise<string> => hash(senha)
