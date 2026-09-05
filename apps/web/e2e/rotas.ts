import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * As rotas do produto, lidas do **disco** — não de uma lista escrita à mão.
 *
 * ## Por que derivar, e não listar
 *
 * A invariante de largura só vale se valer em **toda** rota, inclusive na que
 * ainda não existe. Uma lista escrita à mão vale até a próxima tela: este
 * repositório já pagou esse preço uma vez, e está registrado em `CONTEXT.md`
 * — *"foi uma lista escrita à mão que perdeu o quarto balde por uma revisão
 * inteira"*. O `Balde` é enum fechado hoje por causa disso.
 *
 * Aqui o mesmo raciocínio: a fonte de verdade das rotas do App Router é a
 * **árvore de arquivos**, e é dela que a suíte lê. Rota nova em `src/app`
 * nasce coberta, sem ninguém lembrar de nada.
 *
 * ## O que a derivação **não** resolve sozinha
 *
 * Duas classes de rota não se visitam por URL literal:
 *
 * 1. **Segmento dinâmico** (`/cartoes/[id]`) — precisa de um recurso que
 *    exista. Recebe um `resolvedor`, que descobre a URL concreta navegando
 *    como um humano navegaria.
 * 2. **Rota fora do escopo deste épico** (`/admin/**`, decisão 6) — declarada
 *    numa `DISPENSA`, com motivo e ticket.
 *
 * Ambas são exceções **nomeadas**, e `largura.spec.ts` prova três coisas sobre
 * elas: que toda rota do disco cai em exatamente um balde, que nenhuma
 * exceção sobreviveu à rota que ela desculpava, e que a varredura enxergou o
 * produto. Sem essas três, a derivação apenas mudaria o lugar onde a lista
 * apodrece.
 */

/** `apps/web/src/app`, ancorado no diretório deste arquivo. */
const RAIZ_DO_APP = resolve(__dirname, '..', 'src', 'app')

/**
 * Tolerância de sub-pixel, em CSS pixels.
 *
 * Um pixel, e um só. `scrollWidth` e `clientWidth` são inteiros arredondados a
 * partir de layout fracionário, e um `50%` numa largura ímpar produz 1px de
 * diferença sem que nada esteja errado. **Qualquer valor maior deixa de ser
 * arredondamento e passa a ser a asserção desistindo** — 2px já escondem uma
 * borda, 8px escondem um `padding` esquecido.
 */
export const TOLERANCIA_SUBPIXEL = 1

/** Onde a rota exige sessão. Decidido pela árvore, não por lista. */
export type Alcance = 'publica' | 'autenticada'

export interface RotaDoDisco {
  /** O padrão do App Router, sem os grupos: `/`, `/cartoes/[id]`. */
  readonly padrao: string
  readonly alcance: Alcance
  /** Caminho do `page.tsx` a partir de `src/app`, para a mensagem de erro. */
  readonly arquivo: string
  /** Verdadeiro quando o padrão tem `[segmento]`. */
  readonly dinamica: boolean
}

/** Uma rota que a suíte visita: padrão mais o modo de chegar até ela. */
export interface RotaVisitavel {
  readonly padrao: string
  readonly alcance: Alcance
  /**
   * A URL concreta. Estática vira função constante; dinâmica descobre a URL
   * navegando — e falha alto se o recurso não existir no banco semeado.
   */
  readonly url: (page: Page) => Promise<string>
}

/**
 * Rotas que a suíte **não** visita, com o motivo e o dono.
 *
 * A dispensa é por **regra**, não por enumeração: `/admin/**` são sete rotas
 * hoje e a oitava não pode aparecer dispensada por acidente — ela aparece
 * dispensada pela mesma razão que as outras sete, ou não aparece.
 */
interface Dispensa {
  readonly nome: string
  readonly quando: (rota: RotaDoDisco) => boolean
  readonly motivo: string
}

const DISPENSAS: readonly Dispensa[] = [
  {
    nome: 'espaço de cliente no painel',
    quando: (r) => r.padrao.startsWith('/admin/clientes/'),
    motivo:
      'Estas telas ficam atrás do Portão: o layout não renderiza filho nenhum ' +
      'antes de o operador **declarar a hipótese** (motivo + referência), e ' +
      'declarar uma hipótese não é um clique de navegação — `admin.abrir_espaco` ' +
      'grava a linha de acesso ao espaço de um cliente. Um teste de largura que ' +
      'passasse por aqui fabricaria registro de auditoria a cada execução, e o ' +
      'log de quem entrou no espaço de quem deixaria de significar o que ' +
      'significa. Quando alguém precisar da largura destas telas, o resolvedor ' +
      'existe — mas ele é uma decisão, não um detalhe.\n' +
      'As quatro telas do painel que **não** pedem hipótese (/admin, ' +
      '/admin/precos, /admin/registro, /admin/operadores) estão na invariante.',
  },
  {
    nome: 'aceite de convite',
    quando: (r) => r.padrao === '/convite/[token]',
    motivo:
      'O token é de uso único e o aceite consome o convite. Visitar esta rota ' +
      'num teste de largura gastaria um recurso para medir um pixel, e a tela ' +
      'que ela mostra sem token válido é a mesma de erro que já vive no ' +
      'pórtico. Coberta por E2E de convite, não por este.',
  },
]

/**
 * Como chegar às rotas dinâmicas que a suíte **visita**.
 *
 * A chave é o padrão do App Router. Padrão dinâmico sem resolvedor e sem
 * dispensa reprova o teste de exaustividade — é assim que uma tela nova com
 * `[id]` obriga alguém a decidir, em vez de sumir.
 */
const RESOLVEDORES: Readonly<Record<string, (page: Page) => Promise<string>>> = {
  '/cartoes/[id]': async (page) => {
    await page.goto('/cartoes')
    const link = page.locator('a[href^="/cartoes/"]').first()
    const href = await link.getAttribute('href', { timeout: 15_000 })
    if (!href) {
      throw new Error(
        'nenhum cartão em /cartoes para abrir o detalhe da fatura. ' +
          'A semente (`pnpm db:seed`) precisa ter ao menos um Cartao.',
      )
    }
    return href
  },
}

/** Um arquivo é página do App Router quando se chama `page.<ext>`. */
const PAGINA = /^page\.(tsx|ts|jsx|js|mjs)$/

/**
 * Varre `src/app` e devolve toda rota de página.
 *
 * Regras da árvore, e o que cada uma faz quando não se aplica:
 *
 * - `(grupo)` não vira segmento de URL.
 * - `_pasta` é privada do Next e não vira rota.
 * - `@slot` (rota paralela) e `(.)` (rota interceptada) **lançam**. Não há
 *   nenhuma hoje, e a primeira que aparecer merece uma decisão explícita
 *   sobre como se visita, não ser engolida por um `continue`.
 */
export function rotasDoDisco(): readonly RotaDoDisco[] {
  if (!existsSync(RAIZ_DO_APP)) {
    throw new Error(
      `não encontrei o App Router em ${RAIZ_DO_APP}. ` +
        'Sem ele a derivação devolveria zero rotas, e zero rotas passam calados.',
    )
  }

  const achadas: RotaDoDisco[] = []

  const varrer = (dir: string, segmentos: readonly string[], autenticada: boolean): void => {
    for (const entrada of readdirSync(dir, { withFileTypes: true })) {
      const nome = entrada.name

      if (entrada.isFile()) {
        if (!PAGINA.test(nome)) continue
        const padrao = segmentos.length === 0 ? '/' : `/${segmentos.join('/')}`
        achadas.push({
          padrao,
          alcance: autenticada ? 'autenticada' : 'publica',
          arquivo: join(dir, nome).slice(RAIZ_DO_APP.length + 1).replaceAll('\\', '/'),
          dinamica: padrao.includes('['),
        })
        continue
      }

      if (!entrada.isDirectory()) continue
      if (nome.startsWith('_') || nome === 'node_modules') continue

      if (nome.startsWith('@') || nome.startsWith('(.')) {
        throw new Error(
          `${join(dir, nome)}: rota paralela ou interceptada. A invariante de ` +
            'largura não sabe visitá-la sozinha — decida em rotas.ts como se ' +
            'chega até ela, ou dispense-a com um motivo.',
        )
      }

      const grupo = nome.startsWith('(') && nome.endsWith(')')
      varrer(
        join(dir, nome),
        grupo ? segmentos : [...segmentos, nome],
        // Duas áreas com sessão, e as duas pelo mesmo motivo: o `layout.tsx`
        // de cada uma chama `router.replace('/entrar')` quando não há `eu`. O
        // painel usa **a mesma sessão** do produto — a autorização de operador
        // é resolvida por requisição contra `concessoes_de_admin`, e no
        // ambiente local a semente concede admin a `demo@mavia.local`
        // (`apps/api/src/db/semear.ts`), então o `entrar()` da suíte basta
        // para os dois.
        //
        // Se um dia uma terceira área ficar autenticada e não estiver aqui, a
        // rota nova entra como pública, é redirecionada para `/entrar`, e o
        // teste falha dizendo exatamente isso. Falha alto, não em silêncio.
        autenticada || nome === '(app)' || (segmentos.length === 0 && nome === 'admin'),
      )
    }
  }

  varrer(RAIZ_DO_APP, [], false)
  return achadas.sort((a, b) => a.padrao.localeCompare(b.padrao))
}

/** A dispensa que cobre esta rota, se houver. */
export function dispensaDe(rota: RotaDoDisco): Dispensa | undefined {
  return DISPENSAS.find((d) => d.quando(rota))
}

export function todasAsDispensas(): readonly Dispensa[] {
  return DISPENSAS
}

export function padroesComResolvedor(): readonly string[] {
  return Object.keys(RESOLVEDORES)
}

/**
 * As rotas que a suíte visita, já com o modo de chegar até cada uma.
 *
 * Chamada em tempo de **coleção**: cada rota vira um `test()` próprio, para
 * que o relatório nomeie a tela que estourou em vez de parar na primeira.
 */
export function rotasVisitaveis(): readonly RotaVisitavel[] {
  return rotasDoDisco()
    .filter((r) => dispensaDe(r) === undefined)
    .flatMap((r) => {
      const resolvedor = RESOLVEDORES[r.padrao]
      if (r.dinamica) {
        // Sem resolvedor a rota some da suíte, e sumir calado é o defeito que
        // este arquivo existe para impedir. Quem reprova é o teste de
        // exaustividade; aqui ela é apenas omitida da visita.
        return resolvedor ? [{ padrao: r.padrao, alcance: r.alcance, url: resolvedor }] : []
      }
      return [{ padrao: r.padrao, alcance: r.alcance, url: () => Promise.resolve(r.padrao) }]
    })
}

/**
 * Rotas que existem enquanto o produto existir.
 *
 * A varredura pode quebrar de um jeito silencioso e caro: um `resolve` errado
 * devolve zero rotas, zero `test()` são gerados, e a suíte fica **verde por
 * não ter feito nada**. Estas âncoras transformam esse verde em vermelho.
 */
export const ANCORAS = ['/', '/lancamentos', '/cartoes', '/entrar', '/admin'] as const
