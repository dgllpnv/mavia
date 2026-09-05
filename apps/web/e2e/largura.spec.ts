import { expect, test, type Page } from '@playwright/test'
import {
  ANCORAS,
  dispensaDe,
  padroesComResolvedor,
  rotasDoDisco,
  rotasVisitaveis,
  todasAsDispensas,
  TOLERANCIA_SUBPIXEL,
} from './rotas'

/**
 * Seam S-LARGURA — **a página não desliza de lado**, em toda rota.
 *
 * ```
 * document.documentElement.scrollWidth <= document.documentElement.clientWidth
 * ```
 *
 * ## O que esta invariante é
 *
 * *"A página desliza de lado"* não é um bug: é o **sintoma** de qualquer
 * elemento que estourou o viewport. Uma tabela sem contêiner, uma grade de
 * colunas fixa, um `min-width` esquecido, um número tabular que não quebra —
 * quinze causas diferentes, um sintoma só, e uma linha que o pega em todas.
 *
 * É a mesma razão por que este repositório testa **propriedade** em dinheiro
 * em vez de exemplo escolhido a dedo: a propriedade continua valendo para a
 * tela dezesseis, que ainda não existe. A lista de rotas vem do disco
 * (`rotas.ts`) exatamente para que a tela dezesseis nasça coberta.
 *
 * ## O que ela **não** é
 *
 * Ela mede se ficou **quebrado**, nunca se ficou **bom**. Alvo de toque,
 * contraste, ordem de leitura e sensação de uso continuam sendo o telefone do
 * dono do produto, antes do merge — decisão 8 do épico, as duas metades dela.
 *
 * ## Onde ela vale
 *
 * Nas rotas do produto e nas quatro telas do painel que não pedem hipótese
 * (`/admin`, `/admin/precos`, `/admin/registro`, `/admin/operadores`). O
 * painel usa a **mesma sessão** do produto, e a semente local concede admin a
 * `demo@mavia.local` — o `entrar()` desta suíte basta para os dois. O que fica
 * de fora está declarado em `rotas.ts`, com motivo, e um teste reprova se
 * alguém deixar rota nova cair fora sem dizer por quê.
 *
 * ## Pré-requisito
 *
 * `mavia`, `pnpm db:migrate`, `pnpm db:seed`, e a API em `127.0.0.1:4711` — o
 * mesmo de `fluxo-critico.spec.ts`, e pela mesma razão: as telas do produto só
 * mostram largura de verdade quando têm dado de verdade dentro. Uma tela vazia
 * cabe em qualquer viewport, e um teste que mede tela vazia passa sempre e não
 * protege ninguém. Por isso `corpoVazio` reprova.
 */

const EMAIL = 'demo@mavia.local'
const SENHA = 'mavia-demonstracao'

/**
 * A janela em que a tela tem de assentar.
 *
 * As telas carregam dado depois de hidratar, e um transbordo que só existe
 * enquanto o "Carregando…" está no lugar não é o defeito que procuramos. O
 * `toPass` custa tempo **só quando a tela realmente estoura** — no caminho
 * verde a primeira medição já passa.
 */
const ESPERA_ATE_ASSENTAR = 10_000

// --------------------------------------------------------------------------
// A medição, dentro do navegador
// --------------------------------------------------------------------------

interface Transbordo {
  readonly seletor: string
  readonly texto: string
  readonly largura: number
  /** Quantos CSS pixels o elemento passa do viewport, de qualquer lado. */
  readonly excesso: number
  /** Estilos que costumam ser a causa, quando algum deles está presente. */
  readonly pistas: readonly string[]
  /** O descendente mais fundo que também estoura — em geral o conteúdo real. */
  readonly dentro: string | null
}

interface Medida {
  readonly scrollWidth: number
  readonly clientWidth: number
  readonly caminho: string
  readonly corpoVazio: boolean
  /** As **raízes** do transbordo, da maior para a menor. */
  readonly culpados: readonly Transbordo[]
}

/**
 * Mede o transbordo e **nomeia o culpado**.
 *
 * `"scrollWidth 431 > clientWidth 390"` diz que há um defeito e não diz onde;
 * quem recebe isso abre o DevTools e refaz o trabalho que o teste já fez. O
 * que sai daqui é o elemento, o seletor, o excesso em pixels e a pista de CSS
 * — a diferença entre um teste que acusa e um que ensina.
 *
 * O culpado é a **raiz** do transbordo: o elemento largo demais que não tem
 * nenhum ancestral também largo demais. Numa tabela de 600px, o `<table>` é a
 * raiz e as dezenas de `<td>` são ruído. Ancestrais com `overflow: visible`
 * não entram na conta porque o retângulo deles continua sendo o do viewport —
 * quem cresce é o `scrollWidth` deles, não a caixa.
 *
 * Roda serializada no navegador: nada aqui pode fechar sobre o módulo.
 */
function medirNoNavegador(tolerancia: number): Medida {
  window.scrollTo(0, 0)

  const raiz = document.documentElement
  const limite = raiz.clientWidth

  const seletorDe = (alvo: Element): string => {
    const partes: string[] = []
    let atual: Element | null = alvo

    for (let nivel = 0; atual && nivel < 4 && atual !== raiz; nivel++) {
      let parte = atual.tagName.toLowerCase()

      if (atual.id) {
        partes.unshift(`${parte}#${atual.id}`)
        break
      }

      const classes = (atual.getAttribute('class') ?? '').trim()
      // As classes **são** o diagnóstico neste produto: `grid-cols-4` sem
      // prefixo responsivo é literalmente o defeito. Vão inteiras, cortadas
      // só quando o atributo é longo a ponto de esconder a linha seguinte.
      if (classes) parte += `.${classes.length > 160 ? `${classes.slice(0, 160)}…` : classes}`.replaceAll(' ', '.')

      const rotulo = atual.getAttribute('aria-label') ?? atual.getAttribute('role')
      if (rotulo) parte += `[${rotulo.slice(0, 40)}]`

      const pai: Element | null = atual.parentElement
      if (pai) {
        const irmaos = Array.from(pai.children).filter((c) => c.tagName === atual?.tagName)
        if (irmaos.length > 1) parte += `:nth-of-type(${irmaos.indexOf(atual) + 1})`
      }

      partes.unshift(parte)
      atual = pai
    }

    return partes.join(' > ')
  }

  const pistasDe = (alvo: Element): string[] => {
    const estilo = window.getComputedStyle(alvo)
    const pistas: string[] = []
    if (estilo.display.includes('grid')) {
      pistas.push(`grid-template-columns: ${estilo.gridTemplateColumns}`)
    }
    if (estilo.whiteSpace === 'nowrap' || estilo.whiteSpace === 'pre') {
      pistas.push(`white-space: ${estilo.whiteSpace}`)
    }
    if (estilo.minWidth !== '0px' && estilo.minWidth !== 'auto') {
      pistas.push(`min-width: ${estilo.minWidth}`)
    }
    if (estilo.width.endsWith('px') && Number.parseFloat(estilo.width) > limite) {
      pistas.push(`width: ${estilo.width}`)
    }
    if (estilo.position === 'fixed' || estilo.position === 'absolute') {
      pistas.push(`position: ${estilo.position}`)
    }
    if (estilo.overflowX === 'visible' && estilo.display.includes('flex')) {
      pistas.push('flex sem `min-w-0` no filho estoura em vez de encolher')
    }
    return pistas
  }

  /**
   * O elemento está dentro de algo que **corta ou rola por conta própria**?
   *
   * Se sim, ele não empurra a página: o ancestral com `overflow-x` diferente
   * de `visible` estabelece um contexto de rolagem, e o `scrollWidth` que
   * cresce é o dele. Uma tabela com `min-width: 44rem` dentro de um
   * `overflow-x: auto` é **exatamente o comportamento desejado** — foi assim
   * que o ticket 06 tratou as oito tabelas do painel. Acusá-la aqui seria o
   * teste reprovando a solução que ele pediu.
   *
   * O que continua sendo reprovado é o **contêiner** de rolagem estourar a
   * página. Ele não tem ancestral que o corte, e por isso não passa por aqui.
   */
  const dentroDeAlgoQueRola = (alvo: Element): boolean => {
    let pai = alvo.parentElement
    while (pai && pai !== raiz) {
      if (window.getComputedStyle(pai).overflowX !== 'visible') return true
      pai = pai.parentElement
    }
    return false
  }

  const estourando = new Set<Element>()
  const excessos = new Map<Element, number>()

  for (const elemento of Array.from(document.querySelectorAll('*'))) {
    const retangulo = elemento.getBoundingClientRect()
    if (retangulo.width === 0 && retangulo.height === 0) continue

    const excesso = Math.max(retangulo.right - limite, -retangulo.left)
    if (excesso <= tolerancia) continue
    if (dentroDeAlgoQueRola(elemento)) continue

    estourando.add(elemento)
    excessos.set(elemento, excesso)
  }

  const temAncestralEstourando = (alvo: Element): boolean => {
    let pai = alvo.parentElement
    while (pai) {
      if (estourando.has(pai)) return true
      pai = pai.parentElement
    }
    return false
  }

  const maisFundoDentro = (alvo: Element): Element | null => {
    let fundo: Element | null = null
    let profundidadeMaxima = -1
    for (const candidato of Array.from(alvo.querySelectorAll('*'))) {
      if (!estourando.has(candidato)) continue
      let profundidade = 0
      let pai = candidato.parentElement
      while (pai && pai !== alvo) {
        profundidade++
        pai = pai.parentElement
      }
      if (profundidade > profundidadeMaxima) {
        profundidadeMaxima = profundidade
        fundo = candidato
      }
    }
    return fundo
  }

  const culpados = Array.from(estourando)
    .filter((e) => !temAncestralEstourando(e))
    .sort((a, b) => (excessos.get(b) ?? 0) - (excessos.get(a) ?? 0))
    .slice(0, 3)
    .map((elemento) => {
      const fundo = maisFundoDentro(elemento)
      return {
        seletor: seletorDe(elemento),
        texto: (elemento.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 70),
        largura: Math.round(elemento.getBoundingClientRect().width),
        excesso: Math.round(excessos.get(elemento) ?? 0),
        pistas: pistasDe(elemento),
        dentro: fundo && fundo !== elemento ? seletorDe(fundo) : null,
      }
    })

  return {
    scrollWidth: raiz.scrollWidth,
    clientWidth: limite,
    caminho: window.location.pathname,
    corpoVazio: document.body.innerText.trim().length === 0,
    culpados,
  }
}

/** O relatório que vai na falha. Uma tela, um culpado, um caminho de conserto. */
function relatorio(rota: string, m: Medida): string {
  const linhas = [
    `${rota} desliza de lado: scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth} ` +
      `(${m.scrollWidth - m.clientWidth}px além).`,
  ]

  if (m.culpados.length === 0) {
    linhas.push(
      'Nenhum elemento tem retângulo fora do viewport. Sobra margem, ' +
        '`transform`, ou pseudo-elemento — abra o DevTools nesta rota a ' +
        `${m.clientWidth}px.`,
    )
  }

  for (const [i, c] of m.culpados.entries()) {
    linhas.push(
      `${i + 1}. ${c.excesso}px além, largura ${c.largura}px` +
        (c.texto ? ` — "${c.texto}"` : ''),
      `   ${c.seletor}`,
    )
    if (c.dentro) linhas.push(`   conteúdo mais fundo que também estoura: ${c.dentro}`)
    for (const pista of c.pistas) linhas.push(`   pista: ${pista}`)
  }

  return linhas.join('\n')
}

// --------------------------------------------------------------------------
// Sessão
// --------------------------------------------------------------------------

/**
 * Entra pelo formulário, como em `fluxo-critico.spec.ts`.
 *
 * **De propósito uma vez por teste, e não uma vez por arquivo.** Um estado
 * compartilhado entre as rotas tornaria a suíte serial: a primeira tela que
 * estourasse abortaria as seguintes, e o relatório nomearia uma tela quando o
 * defeito está em cinco. Esta suíte existe para dar a lista inteira de uma vez
 * — o custo é o login repetido, e ele é barato perto de uma auditoria que
 * mostra um item por execução.
 *
 * A espera é pelo **`<main>`**, e não pela barra de navegação: o ticket 01
 * está reescrevendo o cromo agora, e amarrar a sessão ao formato da barra
 * faria esta suíte quebrar por causa do trabalho que ela existe para vigiar.
 */
async function entrar(page: Page): Promise<void> {
  await page.goto('/entrar')
  await page.getByLabel('E-mail').fill(EMAIL)
  await page.getByLabel('Senha').fill(SENHA)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  // **Sair de `/entrar`**, e não "ver um `<main>`": o pórtico também tem um
  // `<main>`, e esperar por ele daria sessão por boa depois de uma recusa de
  // credencial — a rota seguinte falharia dizendo "terminou em /entrar", que é
  // verdade e não é a causa.
  await expect(page).not.toHaveURL(/\/entrar/, { timeout: 30_000 })
}

/** Vai até a URL e espera a tela **ter dado**, não só ter pintado. */
async function abrir(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  // Tolerante: nem toda tela mostra "Carregando…", e as que não mostram passam
  // por aqui num piscar. O que ela evita é medir o esqueleto.
  await expect(page.getByText('Carregando…')).toHaveCount(0, { timeout: 20_000 })
  // As fontes entram com `font-display: swap` (ver o `layout.tsx` raiz), e a
  // troca muda a métrica do texto. Medir antes dela é medir a fonte do sistema.
  await page.evaluate(async () => {
    await document.fonts.ready
  })
}

/**
 * A asserção.
 *
 * Três coisas, e as duas primeiras existem para que a terceira signifique
 * alguma coisa. Uma tela que redirecionou para `/entrar` e uma tela que
 * renderizou `null` **cabem em qualquer viewport** — passariam verdes e
 * provariam nada. Um teste que passa sem exercitar a tela é pior do que
 * nenhum teste, porque ocupa o lugar dele.
 */
async function exigirQueCaiba(page: Page, rota: string, caminhoEsperado: string): Promise<void> {
  await expect(async () => {
    const m = await page.evaluate(medirNoNavegador, TOLERANCIA_SUBPIXEL)

    expect(
      m.caminho,
      `${rota}: o navegador terminou em ${m.caminho}. A tela medida não é a ` +
        'tela pedida — sessão que não valeu, ou redirecionamento não declarado.',
    ).toBe(caminhoEsperado)

    expect(
      m.corpoVazio,
      `${rota} renderizou um corpo vazio. Tela vazia cabe em qualquer largura, ` +
        'e medi-la seria um verde que não custou nada.',
    ).toBe(false)

    expect(m.scrollWidth, relatorio(rota, m)).toBeLessThanOrEqual(
      m.clientWidth + TOLERANCIA_SUBPIXEL,
    )
  }).toPass({ timeout: ESPERA_ATE_ASSENTAR, intervals: [250, 500, 1_000, 2_000] })
}

// --------------------------------------------------------------------------
// A invariante, rota a rota
// --------------------------------------------------------------------------

test.describe('a página não desliza de lado', () => {
  for (const rota of rotasVisitaveis()) {
    test(rota.padrao, async ({ page }) => {
      // 90s, e não os 30s padrão. Uma rota autenticada custa **três** esperas
      // — o login, a compilação sob demanda do `next dev` na primeira visita
      // àquela rota, e a janela até a tela assentar. Nos 30s padrão a suíte
      // reprovava por lentidão de compilador e chamava isso de defeito de
      // layout, que é o tipo de vermelho que ensina o time a ignorar vermelho.
      test.setTimeout(90_000)

      if (rota.alcance === 'autenticada') await entrar(page)

      const url = await rota.url(page)
      await abrir(page, url)
      await exigirQueCaiba(page, rota.padrao, new URL(url, 'http://127.0.0.1').pathname)
    })
  }
})

// --------------------------------------------------------------------------
// O detector, testado contra HTML conhecido
// --------------------------------------------------------------------------

/**
 * `medirNoNavegador` é a peça que decide **quem é o culpado**, e um detector
 * sem teste é uma intenção. Estes três casos não precisam do produto nem do
 * banco: HTML montado na hora, com a resposta certa sabida de antemão.
 *
 * O do meio é o que mais importa. O ticket 06 pôs contêiner de rolagem nas
 * oito tabelas do painel — `overflow-x: auto` com `min-width` na tabela por
 * dentro —, e isso é a **solução**, não o defeito. Um detector que acusasse a
 * tabela ali transformaria a correção em vermelho e ensinaria a próxima pessoa
 * a não usar contêiner de rolagem.
 */
test.describe('o detector de culpado', () => {
  test('nomeia o elemento que estoura, com seletor e excesso', async ({ page }) => {
    await page.setContent(`
      <style>body{margin:0}</style>
      <div class="cartao">
        <table id="extrato" style="width:5000px"><tr><td>uma coluna larguíssima</td></tr></table>
      </div>
    `)

    const m = await page.evaluate(medirNoNavegador, TOLERANCIA_SUBPIXEL)

    expect(m.scrollWidth).toBeGreaterThan(m.clientWidth)
    expect(m.culpados.length).toBeGreaterThan(0)

    const culpado = m.culpados[0]
    expect(culpado?.seletor, 'o seletor precisa apontar a tabela, não o body').toContain(
      'table#extrato',
    )
    expect(culpado?.excesso).toBeGreaterThan(1000)
    expect(culpado?.texto).toContain('larguíssima')

    // E a mensagem que a pessoa recebe diz onde ir.
    expect(relatorio('/exemplo', m)).toContain('table#extrato')
  })

  test('**não acusa o que está dentro de um contêiner que rola sozinho**', async ({ page }) => {
    await page.setContent(`
      <style>body{margin:0}</style>
      <div class="rolagem" style="overflow-x:auto;width:100%">
        <table style="min-width:44rem"><tr><td>tabela do painel</td></tr></table>
      </div>
    `)

    const m = await page.evaluate(medirNoNavegador, TOLERANCIA_SUBPIXEL)

    expect(m.scrollWidth, 'a página não desliza: quem rola é o contêiner').toBeLessThanOrEqual(
      m.clientWidth + TOLERANCIA_SUBPIXEL,
    )
    expect(m.culpados, 'a tabela dentro do contêiner de rolagem não é culpada').toEqual([])
  })

  test('página que cabe não produz culpado nenhum', async ({ page }) => {
    await page.setContent('<style>body{margin:0}</style><p>cabe folgado</p>')

    const m = await page.evaluate(medirNoNavegador, TOLERANCIA_SUBPIXEL)

    expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth + TOLERANCIA_SUBPIXEL)
    expect(m.culpados).toEqual([])
    expect(m.corpoVazio).toBe(false)
  })
})

// --------------------------------------------------------------------------
// A rede sob a rede: a lista não pode apodrecer em silêncio
// --------------------------------------------------------------------------

/**
 * Estes três não abrem navegador. Eles guardam a **derivação** — porque uma
 * derivação quebrada falha do jeito mais caro que existe: gerando zero testes
 * e ficando verde.
 */
test.describe('a lista de rotas', () => {
  test('a varredura enxerga o produto', () => {
    const padroes = rotasDoDisco().map((r) => r.padrao)

    // Sem isto, um `resolve` errado devolve zero rotas, zero `test()` nascem, e
    // a suíte inteira fica verde por não ter feito nada.
    expect(padroes.length, 'a varredura de src/app não achou rota nenhuma').toBeGreaterThan(0)
    for (const ancora of ANCORAS) {
      expect(padroes, `a varredura perdeu ${ancora}, que existe desde o começo`).toContain(ancora)
    }
  })

  test('toda rota do disco cai em exatamente um balde', () => {
    // A propriedade é a mesma que `CONTEXT.md` exige do `Balde`: a partição é
    // **exaustiva**, e é a exaustividade que se testa. Rota nova sem decisão
    // reprova aqui em vez de sumir da cobertura.
    const orfas = rotasDoDisco()
      .filter((r) => dispensaDe(r) === undefined)
      .filter((r) => r.dinamica && !padroesComResolvedor().includes(r.padrao))
      .map((r) => `${r.padrao}  (${r.arquivo})`)

    expect(
      orfas,
      'estas rotas têm segmento dinâmico e ninguém disse como se chega até ' +
        'elas. Escreva um resolvedor em rotas.ts, ou uma dispensa com motivo. ' +
        'Não as deixe fora da invariante em silêncio:\n' +
        orfas.join('\n'),
    ).toEqual([])
  })

  test('nenhuma dispensa sobrevive à rota que ela desculpava', () => {
    // Exceção que perdeu o objeto é exceção que ninguém vai reler, e a próxima
    // rota a cair nela cai sem que ninguém perceba.
    const doDisco = rotasDoDisco()

    for (const dispensa of todasAsDispensas()) {
      expect(
        doDisco.some((r) => dispensa.quando(r)),
        `a dispensa "${dispensa.nome}" não cobre mais nenhuma rota do disco. ` +
          'Apague-a de rotas.ts.',
      ).toBe(true)
    }

    for (const padrao of padroesComResolvedor()) {
      expect(
        doDisco.some((r) => r.padrao === padrao),
        `o resolvedor de "${padrao}" aponta para uma rota que não existe mais.`,
      ).toBe(true)
    }
  })
})
