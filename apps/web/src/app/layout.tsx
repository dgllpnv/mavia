import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { Provedores } from '../componentes/provedores'
import { SCRIPT_ANTI_PISCADA } from '../componentes/seletor-de-tema'
import './globais.css'

export const metadata: Metadata = {
  title: 'Mavia',
  description: 'Controle financeiro pessoal.',
}

export const viewport: Viewport = {
  /**
   * `viewport-fit=cover` é o que **liga** `env(safe-area-inset-*)`.
   *
   * Sem ele os quatro insets valem zero em qualquer iPhone, e a barra de abas
   * do rodapé — que é fixa, e é o cromo inteiro do celular — ficaria por baixo
   * do indicador de home. O custo é que a página passa a entrar sob o entalhe
   * em paisagem, e é por isso que `.barra`, `.abas` e `.conteudo` reservam os
   * insets laterais em `globais.css`.
   */
  viewportFit: 'cover',
  // A cor da barra do navegador acompanha o tema, mas o claro é a identidade
  // canônica da Mavia — o escuro é preferência, não a cara do produto.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FFFEFB' },
    { media: '(prefers-color-scheme: dark)', color: '#0E0D0B' },
  ],
}

export default function LayoutRaiz({ children }: { children: ReactNode }) {
  return (
    /**
     * `suppressHydrationWarning` no `<html>`, e **só nele**.
     *
     * O script acima escreve `data-tema` antes de o React hidratar, e o HTML do
     * servidor não tem esse atributo — então o React acusa divergência. Não é
     * defeito: é a mutação deliberada que evita a piscada, e o servidor não tem
     * como saber a preferência de quem vai abrir a página.
     *
     * A supressão vale **um nível**, o do próprio elemento. Ela não esconde
     * divergência nenhuma dentro da árvore, que é onde uma divergência de
     * verdade apareceria.
     */
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        {/*
          **Antes de tudo, o tema.** Este script é síncrono e roda antes do
          primeiro pixel: sem ele, quem escolheu claro num sistema escuro vê a
          tela escura por um quadro e depois ela vira clara.

          Ler `localStorage` num efeito do React seria tarde demais — efeito
          roda depois da pintura, por definição. O conteúdo é uma constante
          literal, sem interpolação nenhuma, e há teste que prova isso.
        */}
        <script dangerouslySetInnerHTML={{ __html: SCRIPT_ANTI_PISCADA }} />
        {/*
          As fontes entram com `preload` porque o `font-display: swap` de
          `fontes.css` deixa uma janela em que o texto sai na fonte do sistema.
          A altura da linha não depende da métrica intrínseca, então a troca não
          reflui a tabela — mas ela pisca, e piscar é o que o preload encurta.
        */}
        <link
          rel="preload"
          href="/fontes/archivo.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/fontes/public-sans.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>
        <Provedores>{children}</Provedores>
      </body>
    </html>
  )
}
