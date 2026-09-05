'use client'

import Link from 'next/link'
import { useParams, usePathname, useSearchParams } from 'next/navigation'
import type { ReactNode } from 'react'
import { usePainel } from '../../../../painel/contexto'
import { CabecalhoDeLeitura, HipoteseEmCurso } from '../../../../painel/pecas'
import { Portao } from '../../../../painel/portao'

/**
 * O espaço de um cliente — e o portão que o precede.
 *
 * **Enquanto não houver hipótese declarada, esta layout não renderiza os
 * filhos.** É assim que "o motivo é pedido antes de abrir o espaço" deixa de ser
 * uma promessa de fluxo e vira uma propriedade da árvore de componentes: as
 * telas abaixo não existem para o React, logo não há consulta a disparar.
 *
 * ## Uma tela, uma rota, uma linha no registro
 *
 * Perfil, contas, lançamentos, baixas anteriores e desconto têm rota própria na
 * API (§1.4 e ADR 0025), e aqui elas têm rota própria também. Uma página única
 * que carregasse todas de uma vez gravaria uma leitura de cada toda vez que
 * alguém quisesse conferir uma data no perfil — e um registro que diz que o
 * operador leu 200 lançamentos quando ele leu zero é um registro que ninguém
 * consegue usar.
 *
 * **Desconto entrou aqui, e não numa tela de produto**: ele é do cliente, por
 * negociação, e conceder é um ato dentro do espaço dele — com hipótese
 * declarada, como toda escrita do painel. Preço é o oposto: é do produto, não
 * abre espaço nenhum, e por isso mora em `/admin/precos`.
 *
 * As telas `⊙` — alertas, preferências, sessões — **não são visíveis pelo
 * painel** (§1.7), e a ausência de rota é a forma dessa decisão.
 */

const ABAS = [
  { sufixo: '', rotulo: 'perfil' },
  { sufixo: '/contas', rotulo: 'contas' },
  { sufixo: '/lancamentos', rotulo: 'lançamentos' },
  { sufixo: '/pagamentos', rotulo: 'baixas' },
  { sufixo: '/descontos', rotulo: 'desconto' },
] as const

export default function LayoutDoEspaco({ children }: { children: ReactNode }) {
  const parametros = useParams<{ tenantId: string }>()
  const tenantId = parametros.tenantId
  const caminho = usePathname()
  const busca = useSearchParams()
  const { hipoteseDe, declarar, esquecer } = usePainel()

  const hipotese = hipoteseDe(tenantId)

  /**
   * O nome vem da URL, e **serve só para a tela dizer de quem é o espaço**
   * antes de qualquer consulta — o portão não pode consultar nada para
   * descobri-lo, porque consultar é justamente o que ele está guardando.
   *
   * Nenhuma decisão o lê. O que a API recebe é o identificador do caminho, e o
   * nome verdadeiro aparece no perfil, vindo do banco.
   */
  const nome = busca.get('nome')

  if (!hipotese) {
    return (
      <>
        <CabecalhoDeLeitura
          secao="antes de abrir"
          numero={nome ?? 'espaço do cliente'}
          denominador={
            'Nada deste espaço foi consultado ainda. Declare o motivo e a referência para abrir; ' +
            'a mesma instrução que registra é a que dá o acesso.'
          }
        />
        <div className="mt-24">
          <Portao aoDeclarar={(h) => declarar(tenantId, h)} />
        </div>
      </>
    )
  }

  const base = `/admin/clientes/${tenantId}`

  return (
    <>
      <HipoteseEmCurso hipotese={hipotese} aoFechar={() => esquecer(tenantId)} />

      <nav className="mt-16 flex items-center gap-20" aria-label="Telas deste cliente">
        {ABAS.map((a) => {
          const href = `${base}${a.sufixo}`
          const ativo = caminho === href
          return (
            <Link
              key={a.rotulo}
              href={href}
              aria-current={ativo ? 'page' : undefined}
              className="painel-barra__destino"
            >
              {a.rotulo}
            </Link>
          )
        })}
      </nav>

      <div className="mt-24">{children}</div>
    </>
  )
}
