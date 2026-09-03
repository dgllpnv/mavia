import { createHash, randomBytes } from 'node:crypto'
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import { verify } from '@node-rs/argon2'
import { z } from 'zod'
import type { FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { SessaoGuard } from '../autenticacao/sessao.guard.js'
import { AutorizacaoGuard } from '../autorizacao/autorizacao.guard.js'
import { POOL } from '../contas/contas.controller.js'
import { COFRE } from '../redis/tokens.js'
import type { CofreDeAcesso } from '../redis/cofre-de-acesso.js'
import { exigirCotaDePessoas } from '../cobranca/cobranca.controller.js'
import { comTenant, comUsuario } from '../tenancy/tenancy.js'

/**
 * Membros do espaço — convidar, mudar papel, remover.
 *
 * Implementa a regra **R-4** da matriz de acesso, que chama a mudança de papel
 * de "a rota de escalada de privilégio do produto". As quatro travas, e onde
 * cada uma mora:
 *
 * | Trava | Onde |
 * |---|---|
 * | 1. papel exigido | matriz de acesso, `SO_DONO` |
 * | 2. autoalteração proibida | aqui, e é uma checagem **independente** |
 * | 3. último proprietário | **no banco**, gatilho `tenant_tem_dono` |
 * | 4. reautenticação | aqui, senha no ato |
 *
 * A trava 2 existe separada da 1 de propósito: "um `proprietario` não muda o
 * próprio papel, e portanto um `membro` também não — a checagem existe para
 * tornar a regra independente da checagem de papel, e não uma consequência
 * dela". Se um dia o papel exigido mudar, a proibição de autoalteração não vai
 * junto por acidente.
 *
 * A trava 3 mora no banco porque um `if` protege o caminho que alguém lembrou
 * de proteger.
 *
 * ## O e-mail dos outros
 *
 * A matriz separa `membro · ler` de `membro · ler_contato`: nome e papel são de
 * todos, endereço é só do proprietário. A projeção depende do papel de quem
 * pergunta, e isso é autorização — não formatação.
 */

const zConvidar = z.object({
  email: z.string().trim().email().max(320),
  // `proprietario` não é convidável: promover é outra rota, com reautenticação.
  papel: z.enum(['membro', 'visualizador']),
})

const zPapel = z.object({
  papel: z.enum(['proprietario', 'membro', 'visualizador']),
  /** Trava 4: senha no ato. Promover a proprietário é escalada de privilégio. */
  senha: z.string().min(1).max(1024),
})

/** Sete dias. Convite sem prazo é credencial eterna num histórico de conversa. */
const VALIDADE_EM_DIAS = 7

interface Membro {
  readonly usuarioId: string
  readonly nome: string
  readonly papel: string
  /** Só o proprietário vê. Para os demais, `null` — e a ausência é a regra. */
  readonly email: string | null
  readonly removidoEm: string | null
}

@Controller('v1/membros')
@UseGuards(AutorizacaoGuard)
export class MembrosController {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(COFRE) private readonly cofre: CofreDeAcesso,
  ) {}

  private contexto(req: FastifyRequest) {
    const a = req.autenticado
    if (!a) throw new BadRequestException('Contexto ausente.')
    return { usuarioId: a.usuarioId, tenantId: a.tenantId, papel: a.papel }
  }

  @Get()
  async listar(@Req() req: FastifyRequest): Promise<{ itens: Membro[] }> {
    const ctx = this.contexto(req)
    const ehDono = ctx.papel === 'proprietario'

    const itens = await comTenant(this.pool, ctx, async (c) => {
      const r = await c.query<{
        usuario_id: string
        nome: string
        email: string
        papel: string
        removido_em: Date | null
      }>(
        `SELECT tu.usuario_id, u.nome, u.email, tu.papel, tu.removido_em
           FROM tenant_usuarios tu
           JOIN usuarios u ON u.id = tu.usuario_id
          WHERE tu.tenant_id = $1
          ORDER BY tu.removido_em NULLS FIRST, u.nome`,
        [ctx.tenantId],
      )

      return r.rows.map(
        (l): Membro => ({
          usuarioId: l.usuario_id,
          nome: l.nome,
          papel: l.papel,
          // `ler_contato` é ✓ só para proprietário (matriz §2.3). A projeção
          // depende do papel de quem pergunta — isso é autorização, não
          // formatação, e por isso acontece aqui e não na tela.
          email: ehDono ? l.email : null,
          removidoEm: l.removido_em?.toISOString() ?? null,
        }),
      )
    })

    return { itens }
  }

  @Post('convites')
  @HttpCode(201)
  async convidar(
    @Req() req: FastifyRequest,
    @Body() corpo: unknown,
  ): Promise<{ id: string; token: string; expiraEm: string }> {
    const ctx = this.contexto(req)
    const analise = zConvidar.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))
    const d = analise.data

    // 256 bits de CSPRNG. O token viaja uma vez, na resposta; no banco vive só
    // o hash, como toda credencial.
    const token = randomBytes(32).toString('hex')

    try {
      return await comTenant(this.pool, ctx, async (c) => {
        // A cota é conferida **na mesma transação** da criação. Conferi-la
        // antes, fora da transação, deixaria uma janela em que dois convites
        // simultâneos passam pelo mesmo último lugar.
        await exigirCotaDePessoas(c, ctx.tenantId)

        const r = await c.query<{ id: string; expira_em: Date }>(
          `INSERT INTO convites (tenant_id, email, papel, token_hash, criado_por, expira_em)
           VALUES ($1,$2,$3::papel_no_tenant,$4,$5, now() + ($6 || ' days')::interval)
           RETURNING id, expira_em`,
          [ctx.tenantId, d.email, d.papel, hashDo(token), ctx.usuarioId, VALIDADE_EM_DIAS],
        )
        const linha = r.rows[0]!
        return { id: linha.id, token, expiraEm: linha.expira_em.toISOString() }
      })
    } catch (erro) {
      if (String((erro as { message?: string }).message ?? '').includes('convite_unico_por_email')) {
        throw new ConflictException(
          'Já existe um convite pendente para este e-mail. Revogue o anterior antes de criar outro.',
        )
      }
      throw erro
    }
  }

  @Get('convites')
  async convites(
    @Req() req: FastifyRequest,
  ): Promise<{ itens: { id: string; email: string; papel: string; expiraEm: string }[] }> {
    const ctx = this.contexto(req)

    const itens = await comTenant(this.pool, ctx, async (c) => {
      const r = await c.query<{ id: string; email: string; papel: string; expira_em: Date }>(
        `SELECT id, email, papel, expira_em FROM convites
          WHERE tenant_id = $1 AND aceito_em IS NULL AND revogado_em IS NULL
          ORDER BY criado_em DESC`,
        [ctx.tenantId],
      )
      return r.rows.map((l) => ({
        id: l.id,
        email: l.email,
        papel: l.papel,
        expiraEm: l.expira_em.toISOString(),
      }))
    })

    return { itens }
  }

  @Delete('convites/:id')
  @HttpCode(204)
  async revogarConvite(@Req() req: FastifyRequest, @Param('id') id: string): Promise<void> {
    const ctx = this.contexto(req)
    const revogou = await comTenant(this.pool, ctx, async (c) => {
      const r = await c.query(
        `UPDATE convites SET revogado_em = now()
          WHERE tenant_id = $1 AND id = $2 AND aceito_em IS NULL AND revogado_em IS NULL`,
        [ctx.tenantId, id],
      )
      return (r.rowCount ?? 0) > 0
    })
    if (!revogou) throw new NotFoundException('Convite não encontrado.')
  }

  /**
   * Mudar o papel de alguém — a rota de escalada de privilégio.
   *
   * As quatro travas da R-4, e nenhuma delas depende das outras.
   */
  @Patch(':usuarioId')
  async mudarPapel(
    @Req() req: FastifyRequest,
    @Param('usuarioId') usuarioId: string,
    @Body() corpo: unknown,
  ): Promise<{ usuarioId: string; papel: string }> {
    const ctx = this.contexto(req)
    const analise = zPapel.safeParse(corpo)
    if (!analise.success) throw new BadRequestException(analise.error.issues.map((i) => i.message))

    // Trava 2 — autoalteração proibida. **Antes** da senha: recusar por
    // autoalteração não deve custar uma verificação de Argon2, e a ordem
    // também impede usar a rota como oráculo de senha própria.
    if (usuarioId === ctx.usuarioId) {
      throw new ForbiddenException(
        'Você não muda o próprio papel. Peça a outro proprietário do espaço.',
      )
    }

    // Trava 4 — reautenticação no ato.
    await this.exigirSenha(ctx.usuarioId, analise.data.senha)

    try {
      return await comTenant(this.pool, ctx, async (c) => {
        const r = await c.query<{ papel: string }>(
          `UPDATE tenant_usuarios SET papel = $3::papel_no_tenant
            WHERE tenant_id = $1 AND usuario_id = $2 AND removido_em IS NULL
            RETURNING papel`,
          [ctx.tenantId, usuarioId, analise.data.papel],
        )
        const linha = r.rows[0]
        if (!linha) throw new NotFoundException('Membro não encontrado neste espaço.')
        return { usuarioId, papel: linha.papel }
      })
    } catch (erro) {
      throw this.traduzir(erro)
    }
  }

  /**
   * Remover alguém do espaço — ou sair dele.
   *
   * A matriz dá ao membro e ao visualizador o direito de removerem **a si
   * mesmos** ("sair do espaço"), e só isso. Sair não exige senha: quem já está
   * autenticado abrindo mão do próprio acesso não escala privilégio nenhum.
   */
  @Delete(':usuarioId')
  @HttpCode(200)
  async remover(
    @Req() req: FastifyRequest,
    @Param('usuarioId') usuarioId: string,
    @Body() corpo: unknown,
  ): Promise<{ sessoesRevogadas: number }> {
    const ctx = this.contexto(req)
    const ehEuMesmo = usuarioId === ctx.usuarioId

    if (!ehEuMesmo && ctx.papel !== 'proprietario') {
      throw new ForbiddenException('Só um proprietário remove outra pessoa do espaço.')
    }

    if (!ehEuMesmo) {
      const analise = z.object({ senha: z.string().min(1).max(1024) }).safeParse(corpo)
      if (!analise.success) {
        throw new BadRequestException('Confirme sua senha para remover alguém do espaço.')
      }
      await this.exigirSenha(ctx.usuarioId, analise.data.senha)
    }

    try {
      const sessoes = await comTenant(this.pool, ctx, async (c) => {
        const r = await c.query(
          `UPDATE tenant_usuarios SET removido_em = now(), removido_por = $3
            WHERE tenant_id = $1 AND usuario_id = $2 AND removido_em IS NULL`,
          [ctx.tenantId, usuarioId, ctx.usuarioId],
        )
        if ((r.rowCount ?? 0) === 0) throw new NotFoundException('Membro não encontrado.')

        // Revogação **automática**, spec de autenticação §4.3. Sem ela, quem foi
        // removido continua com access válido por quinze minutos e refresh por
        // semanas — e "removi o acesso" vira promessa que o servidor não cumpre.
        const revogadas = await c.query<{ sessao_id: string }>(
          'SELECT * FROM auth.revogar_sessoes_do_usuario($1, $2)',
          [usuarioId, 'removido_do_espaco'],
        )
        return revogadas.rows.map((l) => l.sessao_id)
      })

      await this.cofre.revogarSessoes(sessoes)
      return { sessoesRevogadas: sessoes.length }
    } catch (erro) {
      throw this.traduzir(erro)
    }
  }

  /**
   * A senha, no ato.
   *
   * Conta federada não tem senha e por isso não passa por aqui — e a mensagem
   * diz isso em vez de "senha incorreta", que mandaria a pessoa tentar
   * lembrar de uma senha que ela nunca teve.
   */
  private async exigirSenha(usuarioId: string, senha: string): Promise<void> {
    const hash = await comUsuario(this.pool, { usuarioId }, async (c) => {
      const r = await c.query<{ senha_hash: string | null }>(
        'SELECT senha_hash FROM usuarios WHERE id = $1 AND deleted_at IS NULL',
        [usuarioId],
      )
      return r.rows[0]?.senha_hash ?? null
    })

    if (hash === null) {
      throw new BadRequestException(
        'Esta conta entra pelo Google e não tem senha. Defina uma senha antes desta operação.',
      )
    }

    const confere = await verify(hash, senha).catch(() => false)
    if (!confere) throw new UnauthorizedException('Senha incorreta.')
  }

  private traduzir(erro: unknown): Error {
    if (erro instanceof NotFoundException || erro instanceof BadRequestException) return erro
    if (erro instanceof ForbiddenException || erro instanceof UnauthorizedException) return erro

    if (String((erro as { message?: string }).message ?? '').includes('ESPACO_FICARIA_SEM_DONO')) {
      return new ConflictException(
        'Este espaço ficaria sem proprietário. Promova outra pessoa antes.',
      )
    }
    return erro as Error
  }
}

/**
 * Aceitar um convite.
 *
 * **Sem tenant no cabeçalho**, e é a razão de ela viver noutro controlador:
 * quem aceita ainda não pertence ao espaço, e exigir o cabeçalho seria pedir a
 * resposta como pergunta. Quem escolhe o espaço é o token.
 */
@Controller('v1/convites')
export class AceitarConviteController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Post('aceitar')
  @HttpCode(200)
  @UseGuards(SessaoGuard)
  async aceitar(
    @Req() req: FastifyRequest,
    @Body() corpo: unknown,
  ): Promise<{ tenantId: string; papel: string }> {
    const usuarioId = req.sessao!.usuarioId

    const analise = z
      .object({ token: z.string().regex(/^[0-9a-f]{64}$/) })
      .safeParse(corpo)
    if (!analise.success) throw new BadRequestException('Convite inválido.')

    const meuEmail = await comUsuario(this.pool, { usuarioId }, async (c) => {
      const r = await c.query<{ email: string }>(
        'SELECT email FROM usuarios WHERE id = $1 AND deleted_at IS NULL',
        [usuarioId],
      )
      return r.rows[0]?.email ?? null
    })
    if (!meuEmail) throw new UnauthorizedException('Sessão inválida.')

    const r = await comUsuario(this.pool, { usuarioId: SEM_USUARIO }, async (c) => {
      const saida = await c.query<{
        id_do_tenant: string | null
        papel_concedido: string | null
        motivo: string
      }>(
        'SELECT * FROM auth.aceitar_convite($1, $2, $3)',
        [hashDo(analise.data.token), usuarioId, meuEmail],
      )
      return saida.rows[0]!
    })

    if (r.motivo !== 'aceito') throw new BadRequestException(RECUSA[r.motivo] ?? RECUSA['desconhecido']!)

    return { tenantId: r.id_do_tenant!, papel: r.papel_concedido! }
  }
}

/**
 * As recusas, por motivo.
 *
 * "Convite para outro endereço" é dito **explicitamente**, e não escondido atrás
 * de "convite inválido": quem recebeu um link encaminhado precisa saber que o
 * problema é o endereço, e não o link — senão fica pedindo um convite novo que
 * também não vai funcionar.
 */
const RECUSA: Record<string, string> = {
  desconhecido: 'Convite não encontrado.',
  ja_aceito: 'Este convite já foi usado.',
  expirado: 'Este convite expirou ou foi revogado. Peça um novo.',
  outro_destinatario:
    'Este convite é para outro e-mail. Entre com a conta que recebeu o convite.',
}

const SEM_USUARIO = '00000000-0000-0000-0000-000000000000'

function hashDo(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}
