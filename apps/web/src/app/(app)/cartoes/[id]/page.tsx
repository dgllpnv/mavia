'use client'

import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../../api/cliente'
import { useEspaco } from '../../../../componentes/provedores'
import { TrilhoDeCiclo } from '../../../../componentes/trilho-de-ciclo'
import { Valor } from '../../../../componentes/valor'

/**
 * A fatura de um cartão, ciclo a ciclo.
 *
 * Cada fatura é um objeto com janela — abre, fecha, vence —, e não uma linha
 * de saldo. O trilho de duas marcas é a assinatura do produto no seu uso mais
 * literal: aqui o denominador é tempo.
 */
export default function Cartao() {
  const espaco = useEspaco()
  const { id } = useParams<{ id: string }>()

  const faturas = useQuery({
    queryKey: ['faturas', espaco.id, id],
    queryFn: () => api.faturas(espaco.id, id),
  })

  return (
    <>
      <Link href="/cartoes" className="rotulo hover:text-primaria">
        ‹ cartões
      </Link>

      <h1 className="mt-12">Faturas</h1>

      {faturas.isPending && <p className="mt-24 text-corpo text-ink-3">Carregando…</p>}

      {faturas.data?.itens.length === 0 && (
        <p className="mt-24 text-corpo text-ink-3">
          Nenhuma fatura ainda. Ela nasce na primeira compra do ciclo — ninguém
          abre fatura à mão.
        </p>
      )}

      <div className="mt-32 flex flex-col gap-44">
        {(faturas.data?.itens ?? []).map((f) => (
          <section key={f.id} className="max-w-[640px]">
            <div className="flex items-baseline justify-between gap-24">
              <p className="rotulo">
                Fatura de {f.competencia.slice(0, 7)} · {f.estado.replace('_', ' ')}
              </p>
              {BigInt(f.pagoCentavos) > 0n && (
                <p className="text-sm text-ink-3">
                  pago <Valor centavos={f.pagoCentavos} />
                </p>
              )}
            </div>

            <p className="mt-8 font-numero text-4 font-semibold tracking-tight text-ink-0">
              <Valor centavos={f.totalCentavos} isolado />
            </p>

            <div className="mt-12">
              <TrilhoDeCiclo fechamento={f.dataFechamento} vencimento={f.dataVencimento} />
            </div>
          </section>
        ))}
      </div>
    </>
  )
}
