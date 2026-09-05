'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * A moldura de rolagem própria de uma tabela do painel.
 *
 * ## Por que a tabela continua tabela no celular
 *
 * `docs/design.md` §2.3: densidade é a feature. O operador varre trinta linhas
 * atrás da que está fora do padrão, e essa varredura depende de as colunas
 * ficarem empilhadas umas sobre as outras. Transformar cada linha num bloco
 * rotulado — o truque usual de tabela responsiva — resolve a largura e destrói a
 * leitura que motiva a tela. O conteúdo aqui é uma matriz de verdade, e uma
 * matriz rola de lado.
 *
 * O que o épico existe para matar é a **página** deslizando de lado. Rolagem
 * lateral dentro de um bloco delimitado é uma escolha; a página inteira
 * escorregando é um vazamento.
 *
 * ## Por que os atributos são condicionais, e não fixos
 *
 * Um contêiner com `overflow` só é alcançável por teclado se for focável — sem
 * `tabindex`, quem não usa mouse nem toque não chega às colunas da direita. Mas
 * pôr `tabindex` e `role="region"` sempre criaria, **no desktop**, uma parada de
 * tabulação e um marco de navegação que hoje não existem, num bloco onde não há
 * nada para rolar. O ticket é explícito: acima de `lg` o painel não muda — o corte subiu de 768 para 1024 porque a faixa intermediária deslizava de lado.
 *
 * Daí a medição. Enquanto couber, este componente é uma `div` sem semântica
 * nenhuma; quando transborda, ele se anuncia como região rolável e entra na
 * ordem de tabulação. O leitor de tela ouve "região" exatamente quando há um
 * gesto de rolagem a oferecer.
 */
export function TabelaRolavel({
  rotulo,
  children,
}: {
  /** Como a região se anuncia. Nomeia a matriz; não repete a legenda da tabela. */
  readonly rotulo: string
  readonly children: ReactNode
}) {
  const moldura = useRef<HTMLDivElement>(null)
  const [transborda, setTransborda] = useState(false)

  useEffect(() => {
    const no = moldura.current
    if (!no || typeof ResizeObserver === 'undefined') return

    // A folga de 1px é contra arredondamento sub-pixel: sem ela, uma tabela que
    // cabe exatamente vira uma região focável que não tem para onde rolar.
    const medir = () => setTransborda(no.scrollWidth > no.clientWidth + 1)
    medir()

    const observador = new ResizeObserver(medir)
    observador.observe(no)
    // A tabela também: ela nasce vazia e ganha largura quando a consulta chega,
    // e nesse instante a moldura não mudou de tamanho nenhum.
    const tabela = no.firstElementChild
    if (tabela) observador.observe(tabela)

    return () => observador.disconnect()
  }, [])

  return (
    <div
      ref={moldura}
      className="tabela-rolagem"
      role={transborda ? 'region' : undefined}
      tabIndex={transborda ? 0 : undefined}
      aria-label={transborda ? rotulo : undefined}
    >
      {children}
    </div>
  )
}
