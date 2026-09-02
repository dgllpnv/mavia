import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { Provedores } from '../componentes/provedores'
import './globais.css'

export const metadata: Metadata = {
  title: 'Mavia',
  description: 'Controle financeiro pessoal.',
}

export const viewport: Viewport = {
  // A cor da barra do navegador acompanha o tema, mas o claro é a identidade
  // canônica da Mavia — o escuro é preferência, não a cara do produto.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FFFEFB' },
    { media: '(prefers-color-scheme: dark)', color: '#0E0D0B' },
  ],
}

export default function LayoutRaiz({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
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
