'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, type ReactNode } from 'react'
import { useSessao } from '../../componentes/provedores'
import { SeletorDeTema } from '../../componentes/seletor-de-tema'
import { ProvedorDoPainel } from '../../painel/contexto'
import { useNivel } from '../../painel/nivel'
import './painel.css'

/**
 * O painel de operação.
 *
 * ## O hostname, e por que este arquivo não o resolve
 *
 * A §6.1 do spec exige **hostname próprio e escopo de cookie distinto**, e a
 * razão não é organização de rotas: hoje, no mesmo host e com o mesmo cookie,
 * *um XSS em qualquer tela do produto, no navegador de um admin, alcança o
 * painel inteiro*. Isso é metade da **C-6**, e a C-6 bloqueia o deploy.
 *
 * O que existe aqui é o caminho `/admin` dentro do mesmo Next — que é
 * exatamente a forma que o ticket 12 chama de armadilha. **Ele serve para as
 * telas existirem e serem revisadas, e não autoriza a subida**: a separação de
 * host, o escopo de cookie e a camada de rede (allowlist ou mTLS no Traefik)
 * continuam abertos, e sem eles o painel não vai a produção com cliente real.
 * DP-32 (MFA) e DP-39 (C-11) também seguem abertas.
 *
 * ## O cromo é diferente do produto de propósito
 *
 * Barra de papel com régua de tinta, no lugar da barra sólida na cor da marca.
 * Um operador com as duas abas abertas precisa saber em qual está antes de ler
 * a página — a distinção é periférica, não textual.
 *
 * ## O que não existe aqui, e é decisão escrita
 *
 * Nenhum link para tela do cliente: alertas, preferências e sessões são as
 * telas `⊙` da §1.7, **não visíveis pelo painel**, e a ausência de rota é a
 * forma dessa decisão. Não há tela de trocar plano (DP-40) nem de editar
 * **cota** — a D3 da ADR 0020 vale inteira para cotas, e a ADR 0025 a reafirma:
 * uma cota editada em produção muda o comportamento do produto para todo mundo
 * sem que teste nenhum perceba. Não há rota, não há coluna, não há tela.
 *
 * **Preço e desconto saíram do código** (ADR 0025) e têm tela: `/admin/precos`,
 * append-only, e a sub-tela de desconto dentro da ficha do cliente. A metade da
 * D3 que caiu foi a do preço — ele já era cópia, porque quem cobra é o provedor
 * de pagamento; a metade das cotas continua de pé.
 *
 * ## `operadores` só aparece para quem pode usá-lo
 *
 * O destino é escondido de quem não é `super`. **Esconder não é o controle** —
 * `admin.conceder_operador` exige `super` de qualquer jeito, e a policy
 * `concessao_propria` da `0031` garante que a leitura de nível é sobre quem
 * pergunta. O que se evita é um caminho que sempre termina em recusa: uma
 * interface que mente sobre o que oferece ensina o operador a duvidar do resto.
 */

const DESTINOS = [
  { href: '/admin', rotulo: 'clientes' },
  { href: '/admin/precos', rotulo: 'preços' },
  { href: '/admin/registro', rotulo: 'registro' },
] as const

/** O destino que só existe para o superadministrador. */
const OPERADORES = { href: '/admin/operadores', rotulo: 'operadores' } as const

export default function LayoutDoPainel({ children }: { children: ReactNode }) {
  const { eu, carregando, sair } = useSessao()
  const router = useRouter()
  const caminho = usePathname()
  const { nivel } = useNivel(!carregando && eu !== null)

  useEffect(() => {
    if (!carregando && !eu) router.replace('/entrar')
  }, [carregando, eu, router])

  if (carregando || !eu) return null

  // Enquanto o nível não chegou, o destino não aparece: um link que some depois
  // de aparecer é pior do que um link que demora um instante a nascer.
  const destinos = nivel !== null && nivel === 'super' ? [...DESTINOS, OPERADORES] : DESTINOS

  return (
    <ProvedorDoPainel>
      <div className="min-h-dvh bg-paper">
        <header className="painel-barra sticky top-0 z-20">
          <span className="painel-barra__marca">mavia</span>
          <span className="painel-barra__lugar">painel de operação</span>

          <nav className="flex items-center gap-20" aria-label="Navegação do painel">
            {destinos.map((d) => {
              const ativo =
                d.href === '/admin' ? caminho === '/admin' || caminho.startsWith('/admin/clientes') : caminho.startsWith(d.href)
              return (
                <Link
                  key={d.href}
                  href={d.href}
                  aria-current={ativo ? 'page' : undefined}
                  className="painel-barra__destino"
                >
                  {d.rotulo}
                </Link>
              )
            })}
          </nav>

          <div className="ml-auto flex items-center gap-16">
            <span className="hidden text-sm text-ink-3 sm:inline">{eu.usuario.email}</span>
            <SeletorDeTema />
            <button className="botao botao--discreto text-sm" onClick={() => void sair()}>
              sair
            </button>
          </div>
        </header>

        {/* Coluna estreita, e não a largura do produto: aqui se lê tabela, e
            linha de tabela com 1240px de comprimento perde o olho entre a
            primeira coluna e a última. */}
        <main className="mx-auto max-w-[1080px] px-24 py-24">{children}</main>
      </div>
    </ProvedorDoPainel>
  )
}
