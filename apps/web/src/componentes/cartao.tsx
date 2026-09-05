import type { ReactNode } from 'react'

/**
 * O card.
 *
 * Ele voltou por decisão do dono do produto (DP-31), depois de a direção
 * anterior tê-lo proibido. O argumento contra continua verdadeiro — ele custa
 * altura e não informa nada por si —, e o argumento a favor pesa mais: num
 * painel, o card é o que separa **estado**, **urgência** e **análise** em
 * blocos que a pessoa reconhece antes de ler, e é a forma que os clientes já
 * sabem usar.
 *
 * Três partes, e nenhuma obrigatória além do corpo:
 *
 * - **cabeçalho** — título à esquerda, ações à direita;
 * - **corpo** — com padding, ou `semPadding` quando o conteúdo é uma lista que
 *   deve encostar nas bordas para o separador atravessar o card inteiro;
 * - **rodapé** — um único link de continuação, como o "Gerenciar contas" do
 *   Organizze.
 */

export interface CartaoProps {
  readonly titulo?: string
  readonly acoes?: ReactNode
  /** Lista encosta nas bordas; texto e formulário respiram. */
  readonly semPadding?: boolean
  readonly rodape?: ReactNode
  readonly className?: string
  readonly children: ReactNode
}

export function Cartao({
  titulo,
  acoes,
  semPadding = false,
  rodape,
  className = '',
  children,
}: CartaoProps) {
  return (
    <section className={`cartao ${className}`}>
      {(titulo || acoes) && (
        <header className="cartao__cabecalho">
          {/* `min-w-0` não é enfeite, e sem ele o `truncate` acima é decorativo.
              `.cartao__cabecalho` é `display:flex`, e um item flex com
              `white-space: nowrap` **não encolhe abaixo da largura do próprio
              texto** enquanto seu `min-width` for `auto` — que é o padrão. O
              título então empurra o cabeçalho para além do card, e a página
              inteira passa a rolar de lado num telefone. O `truncate` só começa
              a funcionar quando o item tem permissão de encolher. */}
          {titulo && <h2 className="cartao__titulo min-w-0 truncate">{titulo}</h2>}
          {/* As ações **quebram linha entre si**, e não encolhem cada uma. Um
              botão com o rótulo cortado é pior do que um botão numa linha
              abaixo.

              `shrink-0` aqui estava errado e a medição mostrou: em
              `/lancamentos` o grupo é um item flex só, com navegador de período
              mais duas ações — 440px de largura própria. Impedido de encolher,
              ele descia inteiro para a segunda linha e continuava estourando os
              390px da tela. Sem `shrink-0` e com `flex-wrap`, quem quebra são as
              ações **entre si**, que é onde há folga de verdade.

              `justify-end` para que, quebradas, elas continuem alinhadas à
              direita como no desktop, em vez de deslizarem para a esquerda. */}
          {acoes && (
            <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-8">
              {acoes}
            </div>
          )}
        </header>
      )}

      <div className={semPadding ? 'cartao__lista' : 'cartao__corpo'}>{children}</div>

      {rodape && <footer className="cartao__rodape">{rodape}</footer>}
    </section>
  )
}

/**
 * O vazio de um card.
 *
 * O Organizze deixa estados vazios permanentes ocupando o mesmo espaço de um
 * widget cheio, e o teardown apontou isso como fraqueza (§8.5, item 3). Aqui o
 * vazio é **compacto** e diz o que fazer — mantém a instrução para quem está
 * começando sem roubar a coluna para sempre de quem nunca vai usar aquilo.
 */
export function Vazio({ children, acao }: { children: ReactNode; acao?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-12 py-8">
      <p className="max-w-[46ch] text-corpo text-ink-3">{children}</p>
      {acao}
    </div>
  )
}
