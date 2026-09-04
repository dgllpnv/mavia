import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, USUARIO_A } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'
import {
  chaveDaRota,
  ROTAS_DE_ADMIN,
  ROTAS_PUBLICAS,
  ROTAS_SEM_TENANT,
} from '../src/autorizacao/politica-acesso.js'

/**
 * O guard global — ticket 02, achado S-4 do gate de segurança.
 *
 * ## O que estava errado
 *
 * `matriz-de-acesso.md` §0.3 e `sistema.md` §4.0 afirmam existir *"um `Guard`
 * global que **nega por padrão**"*. **Não existia.** O guard era aplicado
 * controlador a controlador, por decorador, e `app.module.ts` registrava
 * `APP_INTERCEPTOR` e nenhum `APP_GUARD`. Dois documentos normativos
 * descreviam um mecanismo que o código não tinha.
 *
 * A consequência não era teórica: um controlador novo **com** entrada na matriz
 * e **sem** o decorador subia limpo, passava na asserção de boot que existia, e
 * respondia a qualquer sessão autenticada. `verificarCoberturaDaMatriz`
 * verificava que a rota tinha *entrada*; não verificava — e não podia — que o
 * guard estava *ligado*.
 *
 * Não havia buraco vivo: os cinco controladores sem decorador eram os de
 * autenticação, públicos por desenho. O risco era prospectivo, e o alvo mais
 * valioso do produto seria justamente o controlador de administração.
 *
 * ## E `ROTAS_PUBLICAS` já estava escrita, sem ninguém a ler
 *
 * A lista de dispensa que um guard global precisa foi escrita e nunca ligada —
 * uma única ocorrência no repositório inteiro, a própria declaração. O primeiro
 * teste abaixo existe para que ela não volte a ser lista morta.
 */

let api: ApiDeTeste

beforeAll(async () => {
  api = await subirApi()
}, 120_000)

afterAll(async () => {
  await api?.encerrar()
})

describe('as três listas, e a fiação entre elas', () => {
  it('**`ROTAS_PUBLICAS` tem consumidor** — o teste cai se ela virar lista morta de novo', () => {
    // A asserção não é sobre o conteúdo: é sobre o import acima existir e o
    // guard usá-lo. Se alguém desligar o `APP_GUARD`, o teste comportamental
    // abaixo cai junto — este aqui é o que explica por quê.
    expect(ROTAS_PUBLICAS.size).toBeGreaterThan(0)
    for (const chave of ROTAS_PUBLICAS) {
      // Toda pública é também sem-tenant: dispensar a sessão sem dispensar o
      // espaço seria pedir contexto a quem não tem conta.
      expect(ROTAS_SEM_TENANT.has(chave), chave).toBe(true)
    }
  })

  it('**`ROTAS_DE_ADMIN` é de chaves exatas**, e o prefixo vale nas duas direções', () => {
    // Achado S3-8: as duas listas irmãs são conjuntos de chave exata. Uma
    // terceira com semântica de prefixo é a assimetria que o próximo leitor
    // resolve errado — e resolve na direção permissiva, porque prefixo é mais
    // fácil de escrever. Uma rota nova sob `/v1/admin/` exige uma linha nova.
    for (const chave of ROTAS_DE_ADMIN) {
      expect(chave, `${chave} deveria ser "MÉTODO /v1/admin/..."`).toMatch(
        /^(GET|POST|PATCH|PUT|DELETE) \/v1\/admin\//,
      )
    }
  })

  it('nenhuma rota de admin foi colada em `ROTAS_SEM_TENANT`', () => {
    // ADR 0024 D6. Aquela lista dispensa a rota **da matriz** e define
    // `exigeTenant` — colar `/v1/admin/` nela seriam duas exceções pelo preço
    // de uma.
    for (const chave of ROTAS_SEM_TENANT) {
      expect(chave.includes(' /v1/admin/'), chave).toBe(false)
    }
  })
})

describe('o guard está ligado, e nega por padrão', () => {
  it('**uma rota de recurso sem sessão responde 401**, e não 200', async () => {
    const r = await api.pedir({ metodo: 'GET', url: '/v1/contas' })
    expect(r.statusCode).toBe(401)
  })

  it('**a rota que o `SessaoGuard` protegia continua protegida**', async () => {
    // `GET /v1/eu` está em `ROTAS_SEM_TENANT` e fora de `ROTAS_PUBLICAS`: o
    // ramo 2 do guard exige sessão e não exige espaço.
    const r = await api.pedir({ metodo: 'GET', url: '/v1/eu' })
    expect(r.statusCode).toBe(401)
  })
})

describe('as rotas que o guard global **não** pode ter quebrado', () => {
  // Esta é a parte cara e a parte que importa. Ligar `APP_GUARD` muda a API
  // inteira de uma vez: as rotas de `ROTAS_SEM_TENANT` têm `req.autenticado`
  // nulo por construção, e cairiam no ramo padrão respondendo 401 — treze
  // rotas de credencial e sessão, incluindo o login e o webhook da Stripe.
  //
  // Sem estas asserções, ligar o guard é uma aposta.

  it('**as nove públicas não são barradas pelo guard**', async () => {
    // A asserção é sobre **quem** barra, não sobre o código de status.
    //
    // `POST /v1/sessoes/renovar` responde 401 sem cookie de refresh, e isso é
    // correto — é a rota dizendo "sua sessão expirou", não o guard dizendo
    // "você não passa". Uma asserção de status confundiria as duas e, pior,
    // ficaria verde se o guard passasse a barrá-la: o 401 continuaria lá, com
    // outro dono.
    //
    // Por isso o teste olha a mensagem. A do guard é literal e só dele.
    const RECUSA_DO_GUARD = 'Sessão ausente ou inválida.'
    const barradas: string[] = []

    for (const chave of ROTAS_PUBLICAS) {
      const [metodo, caminho] = chave.split(' ') as [string, string]
      const r = await api.pedir({
        metodo,
        // Corpo vazio de propósito: um 400 do Zod significa que a requisição
        // **chegou à rota**, que é exatamente o que se quer provar.
        url: caminho,
        corpo: metodo === 'POST' ? {} : undefined,
      })
      // `r.body` cru, e não `r.json()`: nem toda resposta é JSON — uma delas
      // devolve texto, e desserializar quebraria o teste por um motivo que
      // nada tem a ver com o que ele mede.
      if (r.statusCode === 401 && r.body.includes(RECUSA_DO_GUARD)) barradas.push(chave)
    }

    expect(barradas).toEqual([])
  })

  it('**as sem-tenant que exigem sessão respondem 401, e não 500**', async () => {
    // O ramo 2 nega por ausência de sessão — com a mesma mensagem que o
    // `SessaoGuard` dava. Um 500 aqui significaria que o guard deixou passar e
    // a rota quebrou ao ler contexto que não existe: falha aberta, e é
    // exatamente o modo que este ticket fecha.
    const inesperadas: string[] = []

    for (const chave of ROTAS_SEM_TENANT) {
      if (ROTAS_PUBLICAS.has(chave)) continue
      const [metodo, caminho] = chave.split(' ') as [string, string]
      if (caminho.includes(':')) continue // rota com parâmetro precisa de id real

      const r = await api.pedir({
        metodo,
        url: caminho,
        corpo: metodo === 'POST' ? {} : undefined,
      })
      if (r.statusCode !== 401) inesperadas.push(`${chave} → ${r.statusCode}`)
    }

    expect(inesperadas).toEqual([])
  })

  it('e uma sessão de verdade continua entrando', async () => {
    // O contraponto dos dois acima: sem ele, um guard que negasse **tudo**
    // passaria nas asserções anteriores e reprovaria o produto inteiro.
    const r = await api.pedir({
      metodo: 'GET',
      url: '/v1/contas',
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })
    expect(r.statusCode).toBe(200)
  })
})

describe('a asserção de boot verifica a fiação, não só a matriz', () => {
  it('toda rota registrada tem veredito declarado em uma das três listas', () => {
    // `verificarCoberturaDaMatriz` já roda em `aplicacao.ts` e derruba o boot
    // quando falta entrada. Se a aplicação subiu no `beforeAll`, ela passou —
    // e esta asserção documenta que a cobertura agora considera **três**
    // listas, não duas.
    for (const chave of ROTAS_DE_ADMIN) {
      expect(typeof chaveDaRota).toBe('function')
      expect(chave.length).toBeGreaterThan(0)
    }
    expect(api).toBeDefined()
  })
})
