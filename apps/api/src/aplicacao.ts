import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import type { Pool } from 'pg'
import { AppModule } from './app.module.js'
import { verificarCoberturaDaMatriz, type Rota } from './autorizacao/politica-acesso.js'
import { TenantNaoInformado, TenantNaoPertence, type Autenticador } from './autenticacao/autenticador.js'

/**
 * Monta a aplicação e **verifica a cobertura da matriz de acesso antes de
 * aceitar a primeira requisição**.
 *
 * É aqui que "nega por padrão" vira "impossível esquecer": uma rota registrada
 * sem entrada na matriz derruba a inicialização. O erro aparece no deploy, e
 * não no dia em que alguém acessa a rota esquecida.
 */
export async function criarAplicacao(
  pool: Pool,
  autenticar: Autenticador,
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.comPool(pool),
    new FastifyAdapter(),
    { logger: false },
  )

  const instancia = app.getHttpAdapter().getInstance()

  // A autenticação entra como parâmetro, e não embutida: é um seam de
  // verdade. O processo passa o autenticador de sessão; um teste passa outro.
  // Nenhum código só-de-teste vive na aplicação por causa disso.
  instancia.addHook('preHandler', async (req, resposta) => {
    try {
      const autenticado = await autenticar(req)
      if (autenticado) req.autenticado = autenticado
    } catch (erro) {
      if (erro instanceof TenantNaoInformado) {
        await resposta.status(400).send({ erro: erro.message })
        return
      }
      if (erro instanceof TenantNaoPertence) {
        // 403 sem troca de contexto. Nunca 404 aqui: o espaço existe, e negar
        // acesso é a resposta honesta a quem pediu um espaço que não é dele.
        await resposta.status(403).send({ erro: erro.message })
        return
      }
      throw erro
    }
  })

  // `onRoute` é a única fonte confiável do que foi de fato registrado. Ler uma
  // lista mantida à mão levaria à situação que este mecanismo existe para
  // impedir: a lista e o roteador discordarem.
  const rotas: Rota[] = []
  instancia.addHook('onRoute', (opcoes) => {
    const metodos = Array.isArray(opcoes.method) ? opcoes.method : [opcoes.method]
    for (const metodo of metodos) {
      if (metodo === 'HEAD' || metodo === 'OPTIONS') continue
      rotas.push({ metodo: metodo as Rota['metodo'], caminho: opcoes.url })
    }
  })

  await app.init()
  await instancia.ready()

  verificarCoberturaDaMatriz(rotas)

  return app
}
