import 'reflect-metadata'
import { Readable } from 'node:stream'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import type { Pool } from 'pg'
import { AppModule } from './app.module.js'
import { ErroInesperadoFilter } from './observabilidade/erro-inesperado.filter.js'
import type { CofreDeAcesso } from './redis/cofre-de-acesso.js'
import type { LimiteDeTentativas } from './redis/limite-de-tentativas.js'
import {
  chaveDaRota,
  ROTAS_SEM_TENANT,
  verificarCoberturaDaMatriz,
  type Rota,
} from './autorizacao/politica-acesso.js'
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
  cofre: CofreDeAcesso,
  limite: LimiteDeTentativas,
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.comPool(pool, cofre, limite),
    new FastifyAdapter(),
    { logger: false },
  )

  // Sem isto, um erro não previsto vira `{"statusCode":500}` sem deixar rastro
  // nenhum — e a investigação começa e termina no relato do cliente.
  app.useGlobalFilters(new ErroInesperadoFilter())

  const instancia = app.getHttpAdapter().getInstance()

  // A autenticação entra como parâmetro, e não embutida: é um seam de
  // verdade. O processo passa o autenticador de sessão; um teste passa outro.
  // Nenhum código só-de-teste vive na aplicação por causa disso.
  /**
   * O corpo **cru** do webhook de cobrança.
   *
   * A assinatura da Stripe é um HMAC sobre os bytes que ela mandou. Verificá-la
   * contra `JSON.stringify(corpoParseado)` funciona por acidente enquanto o
   * espaçamento coincide, e falha em toda assinatura legítima no dia em que não
   * coincidir — o tipo de defeito que só aparece em produção, na primeira
   * cobrança real.
   *
   * `preParsing`, e não um parser de tipo de conteúdo: o Nest registra o parser
   * de JSON dele no `init`, e substituí-lo seria disputar com o framework a
   * porta de entrada de **toda** requisição por causa de uma rota. O hook lê o
   * fluxo, guarda os bytes e devolve um fluxo novo — e só para esta rota.
   */
  instancia.addHook('preParsing', async (req, _resposta, fluxo) => {
    if (!req.url.startsWith('/v1/cobranca/webhook')) return fluxo

    const pedacos: Buffer[] = []
    for await (const pedaco of fluxo) pedacos.push(pedaco as Buffer)
    const bruto = Buffer.concat(pedacos)

    ;(req as unknown as { rawBody?: string }).rawBody = bruto.toString('utf8')
    return Readable.from(bruto)
  })

  instancia.addHook('preHandler', async (req, resposta) => {
    // A resolução do espaço depende da rota: `GET /v1/eu` existe para
    // descobrir quais espaços o usuário tem, e exigir o cabeçalho ali seria
    // pedir a resposta como pergunta.
    const chave = chaveDaRota({
      metodo: req.method as Rota['metodo'],
      caminho: req.routeOptions.url ?? '',
    })

    try {
      const r = await autenticar(req, { exigeTenant: !ROTAS_SEM_TENANT.has(chave) })
      if (r.sessao) req.sessao = r.sessao
      if (r.autenticado) req.autenticado = r.autenticado
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
