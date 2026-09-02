'use client'

import { useEffect, useRef, type ReactNode } from 'react'

/**
 * O diálogo do produto — 560px, raio 8, elevação 2.
 *
 * Raio 8 é o único do produto acima de 4, e a regra que o justifica está na
 * §2.3: **só o que se move ou se dispensa tem raio grande**. Um modal se
 * dispensa; uma linha de extrato, não.
 *
 * O que ele carrega e nenhuma tela precisa lembrar:
 *
 * - `Escape` fecha, e o clique no fundo também;
 * - o foco entra no diálogo ao abrir e **volta para onde estava** ao fechar —
 *   sem isso, quem usa teclado é devolvido ao topo da página a cada operação;
 * - o foco fica preso dentro dele enquanto está aberto, que é o que
 *   `aria-modal` promete e o navegador não cumpre sozinho.
 */

export interface ModalProps {
  readonly titulo: string
  /** Uma frase curta abaixo do título, quando a operação precisa de contexto. */
  readonly subtitulo?: string
  readonly largura?: number
  aoFechar(): void
  readonly children: ReactNode
}

const FOCAVEIS =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Modal({ titulo, subtitulo, largura = 560, aoFechar, children }: ModalProps) {
  const caixa = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const anterior = document.activeElement as HTMLElement | null
    caixa.current?.focus()

    function aoTeclar(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        aoFechar()
        return
      }
      if (e.key !== 'Tab' || !caixa.current) return

      // Prisão de foco: sem ela, `Tab` sai do diálogo e vai para a página de
      // trás, que continua lá e continua clicável para o teclado.
      const focaveis = [...caixa.current.querySelectorAll<HTMLElement>(FOCAVEIS)]
      const primeiro = focaveis[0]
      const ultimo = focaveis[focaveis.length - 1]
      if (!primeiro || !ultimo) return

      if (e.shiftKey && document.activeElement === primeiro) {
        e.preventDefault()
        ultimo.focus()
      } else if (!e.shiftKey && document.activeElement === ultimo) {
        e.preventDefault()
        primeiro.focus()
      }
    }

    document.addEventListener('keydown', aoTeclar)
    return () => {
      document.removeEventListener('keydown', aoTeclar)
      // Devolve o foco a quem abriu. Sem isto, fechar o diálogo joga o teclado
      // no início do documento e a pessoa reencontra o botão rolando.
      anterior?.focus()
    }
  }, [aoFechar])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgb(28_26_22/40%)] p-24"
      onClick={(e) => {
        if (e.target === e.currentTarget) aoFechar()
      }}
    >
      <div
        ref={caixa}
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        tabIndex={-1}
        style={{ maxWidth: largura }}
        className="mt-64 mb-64 w-full rounded-3 border border-[var(--elev-borda)] bg-surface-1 p-24 shadow-[var(--elev-2)] outline-none"
      >
        <div className="flex items-baseline justify-between gap-16">
          <div>
            <h2 className="font-numero text-3 font-semibold tracking-tight">{titulo}</h2>
            {subtitulo && <p className="mt-4 text-sm text-ink-3">{subtitulo}</p>}
          </div>
          <button className="botao" onClick={aoFechar} aria-label="Fechar">
            ✕
          </button>
        </div>

        {children}
      </div>
    </div>
  )
}
