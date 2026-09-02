'use client'

import { useQueries, useQuery } from '@tanstack/react-query'
import { api } from '../../../api/cliente'
import { useEspaco } from '../../../componentes/provedores'
import { Valor } from '../../../componentes/valor'
import { TrilhoDeCiclo } from '../../../componentes/trilho-de-ciclo'

/**
 * Cartões — cada um como **objeto com ciclo**, não como uma linha de saldo.
 *
 * É onde a Mavia mais se afasta do Organizze, que não tem visão de fatura como
 * objeto. Um cartão não tem saldo: ele tem uma janela que abre, fecha e vence,
 * e a pergunta do usuário é sempre "quanto e quando", nunca "quanto tem".
 */
export default function Cartoes() {
  const espaco = useEspaco()

  const cartoes = useQuery({
    queryKey: ['cartoes', espaco.id],
    queryFn: () => api.cartoes(espaco.id),
  })

  const faturas = useQueries({
    queries: (cartoes.data?.itens ?? []).map((c) => ({
      queryKey: ['faturas', espaco.id, c.id],
      queryFn: () => api.faturas(espaco.id, c.id),
    })),
  })

  return (
    <>
      <h1>Cartões</h1>

      {cartoes.isPending && <p className="mt-24 text-corpo text-ink-3">Carregando…</p>}

      {cartoes.data?.itens.length === 0 && (
        <p className="mt-24 text-corpo text-ink-3">
          Nenhum cartão ainda. Um cartão precisa do dia de fechamento e do dia de
          vencimento — é o ciclo que decide em qual fatura cada compra entra.
        </p>
      )}

      <div className="mt-32 flex flex-col gap-64">
        {(cartoes.data?.itens ?? []).map((cartao, i) => {
          const lista = faturas[i]?.data?.itens ?? []
          // A fatura corrente é a **aberta mais antiga**: é a que está
          // recebendo compra agora, e a única cujo total ainda muda.
          const porCompetencia = [...lista].sort((a, b) =>
            a.competencia < b.competencia ? -1 : 1,
          )
          const corrente = porCompetencia.find((f) => f.estado === 'aberta')
          // As demais são as parcelas que já foram lançadas em faturas
          // futuras. Um parcelamento em 6x cria seis faturas no ato, e omiti-las
          // esconderia exatamente o compromisso que o usuário assumiu.
          const outras = porCompetencia.filter((f) => f.id !== corrente?.id)

          return (
            <section key={cartao.id}>
              <div className="flex items-baseline justify-between gap-24">
                <h2 className="font-numero text-2 font-semibold">{cartao.nome}</h2>
                <p className="text-sm text-ink-3">
                  fecha dia {cartao.closingDay} · vence dia {cartao.dueDay}
                </p>
              </div>

              {corrente ? (
                <div className="mt-16 max-w-[640px]">
                  <p className="rotulo">Fatura de {corrente.competencia.slice(0, 7)} · aberta</p>
                  <p className="mt-8 font-numero text-4 font-semibold tracking-tight text-ink-0">
                    <Valor centavos={corrente.totalCentavos} isolado />
                  </p>
                  <div className="mt-12">
                    <TrilhoDeCiclo
                      fechamento={corrente.dataFechamento}
                      vencimento={corrente.dataVencimento}
                    />
                  </div>
                </div>
              ) : (
                <p className="mt-16 text-corpo text-ink-3">
                  Nenhuma fatura aberta. Ela nasce na primeira compra do ciclo.
                </p>
              )}

              {outras.length > 0 && (
                <div className="mt-32 max-w-[640px]">
                  <p className="rotulo">Demais faturas</p>
                  <ul className="mt-8">
                    {outras.map((f) => (
                      <li key={f.id} className="linha grid-cols-[100px_1fr_auto] gap-16">
                        <span className="valor text-1">{f.competencia.slice(0, 7)}</span>
                        <span className="text-sm text-ink-3">
                          {f.estado.replace('_', ' ')} · vence {f.dataVencimento}
                        </span>
                        <span className="text-1">
                          <Valor centavos={f.totalCentavos} />
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-12 text-sm text-ink-3">
                    Parcela lançada em fatura futura já é compromisso: ela aparece
                    aqui desde o dia da compra, e não no mês em que chega.
                  </p>
                </div>
              )}
            </section>
          )
        })}
      </div>
    </>
  )
}
