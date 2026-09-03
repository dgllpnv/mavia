import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * O que acontece quando algo dá errado e ninguém previu.
 *
 * Existia um buraco operacional aqui: a aplicação sobe com `logger: false`, e um
 * erro não tratado virava `{"statusCode":500}` **sem deixar rastro nenhum**. Na
 * VPS isso significa um cliente relatando "não consigo importar" e nada no log
 * para investigar — a pior posição possível num produto que mexe com dinheiro.
 *
 * ## O que ele registra, e o que ele recusa a registrar
 *
 * Registra: método, rota **padronizada** (`/v1/lancamentos/:id`, nunca o id
 * concreto), classe do erro, mensagem e código do Postgres.
 *
 * **Não** registra: corpo da requisição, parâmetros de rota, query string, e —
 * em erro de banco — os campos `detail`, `where` e `internalQuery`. É a regra 20
 * do `CLAUDE.md`: log de produção não contém CPF, e-mail completo, número de
 * conta ou valor de transação. E é justamente `detail` que carrega a linha que
 * violou a restrição, valores inclusive.
 *
 * A mensagem de restrição do Postgres — `violates check constraint
 * "valor_nao_zero"` — é o que resolve o problema, e ela não tem dado do cliente.
 */
@Catch()
export class ErroInesperadoFilter implements ExceptionFilter {
  catch(erro: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const resposta = http.getResponse<FastifyReply>()
    const req = http.getRequest<FastifyRequest>()

    if (erro instanceof HttpException) {
      // Recusa deliberada da aplicação: 400, 404, 409. Não é incidente, e
      // logá-la encheria o log de ruído até a linha que importa se perder.
      void resposta.status(erro.getStatus()).send(erro.getResponse())
      return
    }

    const e = erro as { name?: string; message?: string; code?: string; stack?: string }

    console.error(
      JSON.stringify({
        nivel: 'erro',
        rota: `${req.method} ${req.routeOptions?.url ?? '?'}`,
        classe: e.name ?? 'Error',
        // Sem `detail`: é ele que carrega a linha que violou a restrição.
        mensagem: e.message ?? 'sem mensagem',
        ...(e.code === undefined ? {} : { codigo: e.code }),
        // A pilha ajuda e não tem dado do cliente. Truncada: um stack inteiro
        // por erro afoga o arquivo.
        pilha: e.stack?.split('\n').slice(0, 6).join(' | '),
      }),
    )

    void resposta.status(500).send({ statusCode: 500, message: 'Internal server error' })
  }
}
