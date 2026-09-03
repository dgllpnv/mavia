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
          {titulo && <h2 className="cartao__titulo truncate">{titulo}</h2>}
          {acoes && <div className="ml-auto flex items-center gap-8">{acoes}</div>}
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
