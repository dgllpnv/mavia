'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Fragment } from 'react'

/**
 * A barra de abas do celular — cinco lugares, e o do meio não é um lugar.
 *
 * `visão geral · lançamentos · [+ lançar] · cartões · mais`, na ordem decidida
 * no `/grill-me` de 2026-09-05. Ela existe no rodapé porque o polegar não
 * alcança o topo de um telefone de seis polegadas com uma mão só, e lançar
 * despesa é a ação que se faz em pé, no caixa, com uma mão.
 *
 * **Cinco é o limite físico, não uma diretriz.** A barra do topo derivou de
 * cinco destinos para oito porque cabia; aqui não cabe, e a restrição deixa de
 * depender de alguém lembrar dela.
 *
 * **O centro navega, e por isso é um `<Link>`.**
 *
 * Ele nasceu `<button>` porque abria uma sobreposição, e a regra era honesta:
 * uma aba que não navega e se anuncia como navegação promete uma página que não
 * existe. A decisão 4 do épico mudou o fato embaixo da regra — no celular o
 * formulário é a rota `/lancar`, de tela inteira, pelo motivo do teclado. Com um
 * destino de verdade do outro lado, `<button>` passaria a ser a mentira oposta:
 * esconderia de leitor de tela, do abrir-em-nova-aba e do toque longo uma
 * navegação que de fato acontece.
 *
 * Ele segue **fora do `<nav>`**: é a ação primária do produto, não um dos
 * lugares onde se pode estar.
 */

interface Aba {
  readonly href: string
  readonly rotulo: string
  /**
   * Os caminhos que esta aba representa além do próprio.
   *
   * Sem isto, quem entra em `/planejamento` pela tela `mais` fica sem nenhuma
   * aba acesa e perde a referência de onde está — o defeito mais comum de barra
   * de abas com uma gaveta.
   */
  readonly cobre?: readonly string[]
}

const ABAS: readonly Aba[] = [
  { href: '/', rotulo: 'visão geral' },
  { href: '/lancamentos', rotulo: 'lançamentos' },
  { href: '/cartoes', rotulo: 'cartões' },
  {
    href: '/mais',
    rotulo: 'mais',
    cobre: [
      '/planejamento',
      '/objetivos',
      '/relatorios',
      '/contas',
      '/categorias',
      '/membros',
      '/plano',
      // Chega-se a ele pela tela de contas, e não pela `mais` — mas ele é
      // configuração, e é sob `mais` que a pessoa vai procurá-lo de volta.
      '/importar',
    ],
  },
]

/**
 * O índice em `ABAS` **antes** do qual a coluna da ação entra: a fileira sai
 * `visão geral · lançamentos · [+ lançar] · cartões · mais`.
 */
const ABA_DEPOIS_DA_ACAO = 2

function estaAtiva(aba: Aba, caminho: string): boolean {
  if (aba.href === '/') return caminho === '/'
  const alvos = [aba.href, ...(aba.cobre ?? [])]
  return alvos.some((alvo) => caminho === alvo || caminho.startsWith(`${alvo}/`))
}

export function BarraDeAbas() {
  const caminho = usePathname()

  return (
    <div className="abas">
      <nav className="abas__destinos" aria-label="Navegação principal">
        {ABAS.map((aba, i) => (
          <Fragment key={aba.href}>
            {/* A coluna vazia sobre a qual a ação do centro se posiciona. */}
            {i === ABA_DEPOIS_DA_ACAO && <span aria-hidden="true" />}
            <Link
              href={aba.href}
              className="abas__destino"
              aria-current={estaAtiva(aba, caminho) ? 'page' : undefined}
            >
              {aba.rotulo}
            </Link>
          </Fragment>
        ))}
      </nav>

      {/*
        O nome acessível é "lançar" — o `+` é decoração, e um rótulo que o
        incluísse leria "mais lançar".

        `?tipo=despesa` porque é a natureza de quase todo lançamento manual, e a
        rota valida o parâmetro contra as três naturezas do domínio antes de
        usá-lo: endereço é entrada de fora.
      */}
      <Link href="/lancar?tipo=despesa" className="abas__acao">
        <span className="abas__acao__alvo">
          <span className="abas__acao__cruz" aria-hidden="true">
            +
          </span>
          lançar
        </span>
      </Link>
    </div>
  )
}
