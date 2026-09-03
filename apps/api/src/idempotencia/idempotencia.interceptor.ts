import { createHash } from 'node:crypto'
import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { firstValueFrom, of, type Observable } from 'rxjs'
import { POOL } from '../contas/contas.controller.js'
import { comTenant } from '../tenancy/tenancy.js'

/**
 * `Idempotency-Key`: a mesma mutação, enviada duas vezes, acontece uma vez.
 *
 * Existe para a fila offline do app móvel. A rede volta de forma ruim — meio
 * pacote, timeout depois do commit, o processo do app morto entre o envio e a
 * resposta — e nesses casos o cliente **precisa** reenviar sem saber se o
 * primeiro envio chegou. Sem isto, reenviar cria a despesa duas vezes, e duas
 * despesas iguais no mesmo minuto é justamente o que ninguém percebe: parece um
 * erro de digitação da própria pessoa.
 *
 * ## Interceptor, e não um `if` em cada rota
 *
 * Idempotência escrita rota a rota é idempotência que falta na rota nova. Aqui
 * ela é uma propriedade do transporte: qualquer mutação que traga o cabeçalho
 * ganha o comportamento, inclusive as que ainda não existem.
 *
 * ## O que é repetição e o que é conflito
 *
 * Mesma chave **e** mesmo corpo é repetição: devolve a resposta guardada, com o
 * status original. Mesma chave e corpo diferente é **409** — duas intenções
 * distintas nasceram com a mesma identidade, e devolver a primeira resposta
 * esconderia a segunda para sempre.
 *
 * ## O que ele não faz
 *
 * Não guarda falha. Um 500 não vira resposta congelada: se o servidor errou, a
 * retentativa tem de poder acertar. Só o desfecho bem-sucedido é memorizado.
 */
@Injectable()
export class IdempotenciaInterceptor implements NestInterceptor {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async intercept(contexto: ExecutionContext, proximo: CallHandler): Promise<Observable<unknown>> {
    const req = contexto.switchToHttp().getRequest<FastifyRequest>()

    const chave = req.headers['idempotency-key']
    if (typeof chave !== 'string' || chave === '') return proximo.handle()

    if (chave.length > 200) {
      throw new BadRequestException('Idempotency-Key longa demais.')
    }

    const autenticado = req.autenticado
    // Sem espaço não há a quem atribuir a chave, e a tabela é por tenant. As
    // rotas sem tenant não são mutações de dinheiro.
    if (!autenticado) return proximo.handle()

    const ctx = { tenantId: autenticado.tenantId, usuarioId: autenticado.usuarioId }
    const metodo = req.method
    const caminho = req.routeOptions.url ?? req.url
    const corpoHash = createHash('sha256')
      .update(JSON.stringify(req.body ?? null), 'utf8')
      .digest()

    const guardado = await comTenant(this.pool, ctx, async (c) => {
      const r = await c.query<{
        metodo: string
        caminho: string
        corpo_hash: Buffer
        status: number
        resposta: unknown
      }>(
        `SELECT metodo, caminho, corpo_hash, status, resposta
           FROM mutacoes_idempotentes WHERE tenant_id = $1 AND chave = $2`,
        [ctx.tenantId, chave],
      )
      return r.rows[0] ?? null
    })

    if (guardado) {
      const mesmaIntencao =
        guardado.metodo === metodo &&
        guardado.caminho === caminho &&
        guardado.corpo_hash.equals(corpoHash)

      if (!mesmaIntencao) {
        throw new ConflictException(
          'Esta chave de idempotência já foi usada para outra operação. Gere uma nova.',
        )
      }

      contexto.switchToHttp().getResponse().status(guardado.status)
      return of(guardado.resposta)
    }

    const resultado = await firstValueFrom(proximo.handle())

    // Guardar **depois** do sucesso, e com o status que a rota escolheu: um
    // 201 repetido tem de continuar 201, senão o cliente conclui que a segunda
    // chamada fez outra coisa.
    const status = contexto.switchToHttp().getResponse().statusCode as number
    await comTenant(this.pool, ctx, (c) =>
      c.query(
        `INSERT INTO mutacoes_idempotentes
           (tenant_id, chave, metodo, caminho, corpo_hash, status, resposta, usuario_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING`,
        [
          ctx.tenantId,
          chave,
          metodo,
          caminho,
          corpoHash,
          status,
          resultado === undefined ? null : JSON.stringify(resultado),
          ctx.usuarioId,
        ],
      ),
    )

    return of(resultado)
  }
}
