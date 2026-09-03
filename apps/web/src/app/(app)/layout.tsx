'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, type ReactNode } from 'react'
import { useSessao } from '../../componentes/provedores'

/**
 * O cromo do produto: 48px de navegação e nada mais.
 *
 * Navegação **plana**, quatro destinos, sem menu lateral e sem submenu. É o que
 * o Organizze acerta e o que o teardown recomendou herdar: em finanças pessoais
 * o usuário vai a um de poucos lugares, e uma hierarquia de dois níveis só
 * acrescenta um clique para todo mundo.
 *
 * O cromo inteiro soma 228px contra 312px do Organizze — a diferença é o que
 * permite 15 lançamentos por tela em vez de 6.
 */

const DESTINOS = [
  { href: '/', rotulo: 'visão geral' },
  { href: '/lancamentos', rotulo: 'lançamentos' },
  { href: '/cartoes', rotulo: 'cartões' },
  { href: '/contas', rotulo: 'contas' },
  { href: '/categorias', rotulo: 'categorias' },
] as const

export default function LayoutDoApp({ children }: { children: ReactNode }) {
  const { eu, carregando, espaco, sair } = useSessao()
  const router = useRouter()
  const caminho = usePathname()

  useEffect(() => {
    if (!carregando && !eu) router.replace('/entrar')
  }, [carregando, eu, router])

  if (carregando || !eu || !espaco) return null

  return (
    <div className="min-h-dvh bg-paper">
      <header className="sticky top-0 z-10 flex h-[var(--altura-nav)] items-center gap-24 border-b border-line bg-paper px-24">
        <span className="font-numero text-2 font-bold tracking-tight text-primaria">mavia</span>

        <nav className="flex items-center gap-20" aria-label="Navegação principal">
          {DESTINOS.map((d) => {
            const ativo = d.href === '/' ? caminho === '/' : caminho.startsWith(d.href)
            return (
              <Link
                key={d.href}
                href={d.href}
                aria-current={ativo ? 'page' : undefined}
                className={
                  ativo
                    ? 'rotulo text-ink-0 underline decoration-primaria decoration-2 underline-offset-8'
                    : 'rotulo hover:text-ink-1'
                }
              >
                {d.rotulo}
              </Link>
            )
          })}
        </nav>

        <div className="ml-auto flex items-center gap-16">
          <span className="text-sm text-ink-3">{espaco.nome}</span>
          <button className="botao botao--discreto" onClick={() => void sair()}>
            sair
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1240px] px-24 py-32">{children}</main>
    </div>
  )
}
