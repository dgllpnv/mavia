import Link from 'next/link'
import { Cartao } from '../../../componentes/cartao'

/**
 * A tela `mais` — onde vão os destinos que não cabem na barra de abas.
 *
 * Cinco lugares no rodapé é o limite físico da mão, e o produto tem doze. Os
 * sete que sobram vêm para cá: cinco que saíram do topo e dois que viviam
 * escondidos no menu da conta, onde ninguém procura configuração de espaço.
 *
 * **Agrupada, e não uma lista solta.** Uma gaveta sem hierarquia troca o
 * problema de lugar: em vez de oito rótulos disputando 390px de largura, sete
 * disputando a mesma leitura vertical. Os três grupos respondem a três
 * perguntas diferentes — *o que eu pretendo*, *o que aconteceu*, *como o
 * produto está montado* —, e a pessoa que abre esta tela já sabe qual das três
 * a trouxe aqui.
 *
 * Cada linha diz o que a tela faz, com o vocabulário do `CONTEXT.md`. Um menu
 * de sete substantivos soltos obriga a entrar para descobrir, e entrar no
 * celular custa uma navegação e uma volta.
 *
 * As descrições cabem **em uma linha a 390px**, e isso é medida, não estilo: a
 * segunda linha somava 34px por item e empurrava metade do menu para fora da
 * tela. Densidade é feature, inclusive num menu.
 */

interface Destino {
  readonly href: string
  readonly rotulo: string
  readonly descricao: string
}

interface Grupo {
  readonly titulo: string
  readonly destinos: readonly Destino[]
}

const GRUPOS: readonly Grupo[] = [
  {
    titulo: 'Planejar',
    destinos: [
      {
        href: '/planejamento',
        rotulo: 'Planejamento',
        descricao: 'Teto de despesa e piso de receita, mês a mês.',
      },
      {
        href: '/objetivos',
        rotulo: 'Objetivos',
        descricao: 'Quanto falta para cada valor-alvo, e até quando.',
      },
    ],
  },
  {
    titulo: 'Analisar',
    destinos: [
      {
        href: '/relatorios',
        rotulo: 'Relatórios',
        descricao: 'Para onde o dinheiro foi, mês contra mês.',
      },
    ],
  },
  {
    titulo: 'Configurar',
    destinos: [
      {
        href: '/contas',
        rotulo: 'Contas',
        descricao: 'Suas contas, e o que entra no Saldo geral.',
      },
      {
        href: '/categorias',
        rotulo: 'Categorias',
        descricao: 'Dois níveis, e as regras que classificam.',
      },
      {
        href: '/membros',
        rotulo: 'Pessoas do espaço',
        descricao: 'Quem mais lança e consulta, e com qual papel.',
      },
      {
        href: '/plano',
        rotulo: 'Plano e cobrança',
        descricao: 'O plano em vigor e o histórico de cobrança.',
      },
    ],
  },
]

export default function Mais() {
  return (
    <>
      <h1>Mais</h1>

      <div className="mt-16 flex flex-col gap-16 md:mt-24 md:gap-24">
        {GRUPOS.map((grupo) => (
          <Cartao key={grupo.titulo} titulo={grupo.titulo} semPadding>
            {grupo.destinos.map((destino) => (
              <Link
                key={destino.href}
                href={destino.href}
                className="linha grid-cols-[1fr_auto]"
              >
                <span className="min-w-0">
                  <span className="block truncate text-1 text-ink-1">{destino.rotulo}</span>
                  <span className="block text-sm text-ink-3">{destino.descricao}</span>
                </span>
                {/* O mesmo glifo do navegador de período. Decorativo: quem lê
                    com o leitor de tela já ouviu que a linha é um link. */}
                <span aria-hidden="true" className="text-1 text-ink-3">
                  ›
                </span>
              </Link>
            ))}
          </Cartao>
        ))}
      </div>
    </>
  )
}
