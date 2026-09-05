'use client'


/**
 * O botão de lançar dentro do cabeçalho de um card — **e só no computador**.
 *
 * ## Por que ele não existe no celular
 *
 * Abaixo de `lg` a barra de abas já carrega `+ lançar`, fixa no rodapé, ao
 * alcance do polegar. Repetir a ação no cabeçalho do card custava a **terceira
 * linha de cromo antes do primeiro lançamento** — medido em `/lancamentos`, a
 * 390px — e duplicava, a dois centímetros de distância, o alvo que a decisão 3
 * do épico pôs no rodapé justamente por ser o mais usado.
 *
 * A ação não sumiu: ela ficou onde **não rola para fora da tela**. O cabeçalho
 * do card é conteúdo e sobe com a lista; a barra de abas não.
 *
 * As naturezas que o rodapé não oferece — receita e transferência — continuam
 * alcançáveis: `/lancar` aceita `?tipo=` e o próprio formulário troca a natureza,
 * reescrevendo o endereço. O rodapé abre em `despesa` porque é a natureza de
 * quase todo lançamento manual.
 *
 * ## Por que `lg` e não `md`
 *
 * O corte do cromo do produto é 1024px (ver `(app)/layout.tsx`). Com a fronteira
 * em `md`, a faixa de 768 a 1023 recebia a barra de abas — cujo centro **navega**
 * para `/lancar` — e, ao mesmo tempo, um botão de cabeçalho que abria a
 * **sobreposição**: duas molduras para a mesma ação, na mesma largura. As duas
 * fronteiras são a mesma decisão e precisam ser o mesmo número.
 *
 * ## Por que `display: contents` no invólucro
 *
 * Sem ele, o `<span>` viraria o item flex do cabeçalho no lugar do botão, e o
 * espaçamento da barra de ações mudaria no computador. `contents` faz o
 * invólucro sumir da caixa e deixa o botão como filho direto — o desktop fica
 * idêntico ao de hoje.
 *
 * E o invólucro é necessário porque **`hidden` direto no `.botao` não
 * funcionaria**: as regras de elemento do `globais.css` estão fora de `@layer` e
 * vencem o `@layer utilities` do Tailwind, então `.botao { display: inline-flex }`
 * ganha de `.hidden`.
 */

export interface AcaoDeLancarProps {
  readonly rotulo: string
  readonly variante?: 'primario' | 'discreto'
  /** Abrir a sobreposição na própria tela. É o caminho do computador. */
  aoAbrir(): void
}

export function AcaoDeLancar({ rotulo, variante = 'primario', aoAbrir }: AcaoDeLancarProps) {
  const classe = variante === 'primario' ? 'botao botao--primario' : 'botao botao--discreto'

  return (
    <span className="hidden lg:contents">
      <button type="button" className={classe} onClick={aoAbrir}>
        {rotulo}
      </button>
    </span>
  )
}
