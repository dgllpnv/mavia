import { Pool } from 'pg'
import Redis from 'ioredis'
import { criarAplicacao } from './aplicacao.js'
import { autenticadorDeSessao } from './autenticacao/autenticador.js'
import { CofreDeAcesso } from './redis/cofre-de-acesso.js'
import { LimiteDeTentativas } from './redis/limite-de-tentativas.js'
import { agendarMaterializacao } from './recorrencias/agendador.js'

/**
 * Ponto de entrada do processo `http`.
 *
 * Conecta como `mavia_app` — o papel sem BYPASSRLS. A credencial vem do
 * ambiente e nunca do repositório (regra 19).
 */
async function principal(): Promise<void> {
  const pool = new Pool({ connectionString: process.env['DATABASE_URL'] })

  // Bloco 47xx, como o Postgres. `maxRetriesPerRequest: null` é exigência do
  // BullMQ e não muda o comportamento do cofre.
  const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://127.0.0.1:4779', {
    maxRetriesPerRequest: null,
  })

  const cofre = new CofreDeAcesso(redis)
  const limite = new LimiteDeTentativas(
    redis,
    // Sem pepper o processo não sobe: a chave do contador seria reversível por
    // força bruta sobre endereços conhecidos. Em desenvolvimento há um valor
    // fixo; em produção ele vem do ambiente, como todo segredo.
    process.env['MAVIA_PEPPER_TENTATIVAS'] ?? 'pepper-local-de-desenvolvimento',
  )

  const app = await criarAplicacao(pool, autenticadorDeSessao(pool, cofre), cofre, limite)

  // O horizonte da recorrência passa a andar sozinho — pendência P-8.
  const agendador = await agendarMaterializacao(pool, redis)

  // Bloco 47xx, longe de 80 e 8080 — ver infra/README.md.
  const porta = Number(process.env['PORT'] ?? 4711)
  await app.listen({ port: porta, host: '127.0.0.1' })
  console.log(`API em http://127.0.0.1:${porta}`)

  for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sinal, () => {
      void (async () => {
        await agendador.encerrar()
        await app.close()
        await pool.end()
        redis.disconnect()
        process.exit(0)
      })()
    })
  }
}

void principal()
