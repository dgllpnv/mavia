'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { useSessao } from '../../componentes/provedores'

/**
 * O cromo do produto: barra sólida na cor da marca, cinco destinos à esquerda,
 * conta à direita.
 *
 * A disposição é a do Organizze (DP-31), porque é a que os clientes já sabem
 * usar. Navegação **plana**: cinco lugares, sem menu lateral e sem hierarquia —
 * em finanças pessoais a pessoa vai a um de poucos lugares, e dois níveis só
 * acrescentam um clique para todo mundo.
 *
 * A cor é nossa, não a deles: petróleo no lugar do verde. O pedido foi a
 * disposição, não a pele.
 */

const DESTINOS = [
  { href: '/', rotulo: 'visão geral' },
  { href: '/lancamentos', rotulo: 'lançamentos' },
  { href: '/cartoes', rotulo: 'cartões' },
  { href: '/planejamento', rotulo: 'planejamento' },
  { href: '/contas', rotulo: 'contas' },
  { href: '/categorias', rotulo: 'categorias' },
] as const

export default function LayoutDoApp({ children }: { children: ReactNode }) {
  const { eu, carregando, espaco, sair } = useSessao()
  const router = useRouter()
  const caminho = usePathname()
  const [menuAberto, setMenuAberto] = useState(false)

  useEffect(() => {
    if (!carregando && !eu) router.replace('/entrar')
  }, [carregando, eu, router])

  if (carregando || !eu || !espaco) return null

  const iniciais = eu.usuario.nome
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toLocaleUpperCase('pt-BR') ?? '')
    .join('')

  return (
    <div className="min-h-dvh bg-fundo">
      <header className="barra sticky top-0 z-20">
        <span className="font-numero text-2 font-bold tracking-tight">mavia</span>

        <nav className="flex items-center gap-20" aria-label="Navegação principal">
          {DESTINOS.map((d) => {
            const ativo = d.href === '/' ? caminho === '/' : caminho.startsWith(d.href)
            return (
              <Link
                key={d.href}
                href={d.href}
                aria-current={ativo ? 'page' : undefined}
                className="barra__destino"
              >
                {d.rotulo}
              </Link>
            )
          })}
        </nav>

        <div className="relative ml-auto flex items-center gap-16">
          <span className="hidden text-sm opacity-80 sm:inline">{espaco.nome}</span>

          {/* Avatar de iniciais, e não foto. O teardown registra que o Organizze
              busca `picture` do provedor, o que cria uma requisição de saída da
              nossa página para um terceiro em toda tela que o exibe. */}
          <button
            className="flex h-[32px] w-[32px] items-center justify-center rounded-full bg-[rgb(255_255_255/18%)] font-numero text-sm font-semibold"
            aria-haspopup="menu"
            aria-expanded={menuAberto}
            aria-label="Sua conta"
            onClick={() => setMenuAberto((v) => !v)}
          >
            {iniciais || '?'}
          </button>

          {menuAberto && (
            <div
              role="menu"
              className="absolute top-[44px] right-0 min-w-[220px] rounded-3 border border-[var(--card-borda)] bg-card p-8 text-ink-1 shadow-[var(--elev-2)]"
            >
              <p className="px-12 py-8 text-sm text-ink-3">{eu.usuario.email}</p>
              <hr className="my-4 border-line" />
              <button
                role="menuitem"
                className="botao w-full justify-start"
                onClick={() => void sair()}
              >
                sair
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-[1240px] px-24 py-24">{children}</main>
    </div>
  )
}
