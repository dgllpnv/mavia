import { Pool } from 'pg'
import { criarAplicacao } from './aplicacao.js'
import { autenticadorDeSessao } from './autenticacao/autenticador.js'

/**
 * Ponto de entrada do processo `http`.
 *
 * Conecta como `mavia_app` — o papel sem BYPASSRLS. A credencial vem do
 * ambiente e nunca do repositório (regra 19).
 */
async function principal(): Promise<void> {
  const pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
  const app = await criarAplicacao(pool, autenticadorDeSessao(pool))
  // Bloco 47xx, longe de 80 e 8080 — ver infra/README.md.
  const porta = Number(process.env['PORT'] ?? 4711)
  await app.listen({ port: porta, host: '127.0.0.1' })
  console.log(`API em http://127.0.0.1:${porta}`)
}

void principal()
