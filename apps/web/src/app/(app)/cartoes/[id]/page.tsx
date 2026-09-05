'use client'

import type { Fatura } from '@mavia/contracts'
import { dataCivilDe } from '@mavia/domain'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useMemo } from 'react'
import { api } from '../../../../api/cliente'
import { montarDicionarios } from '../../../../api/dicionarios'
import { useEspaco } from '../../../../componentes/provedores'
import { TrilhoDeCiclo } from '../../../../componentes/trilho-de-ciclo'
import { Valor } from '../../../../componentes/valor'

/**
 * A fatura, ciclo a ciclo, **com os lançamentos que a compõem**.
 *
 * A lista existe porque uma fatura sem ela é um número que o usuário não tem
 * como conferir — e conferir é a única coisa que se faz com uma fatura. É
 * também onde a composição fica visível: compras do ciclo, parcelas de compras
 * anteriores e retroativos convivem na mesma lista, e a parcela diz `3/6`.
 *
 * A soma da lista **é** o total exibido acima dela. Se as duas divergirem, a
 * tela mostra o próprio defeito — que é melhor do que escondê-lo.
 */
export default function Cartao() {
  const espaco = useEspaco()
  const { id } = useParams<{ id: string }>()

  const faturas = useQuery({
    queryKey: ['faturas', espaco.id, id],
    queryFn: () => api.faturas(espaco.id, id),
  })

  const categorias = useQuery({
    queryKey: ['categorias', espaco.id],
    queryFn: () => api.categorias(espaco.id),
    staleTime: 5 * 60_000,
  })

  const dicionarios = useMemo(
    () => montarDicionarios(categorias.data?.itens ?? [], []),
    [categorias.data],
  )

  const ordenadas = [...(faturas.data?.itens ?? [])].sort((a, b) =>
    a.competencia < b.competencia ? 1 : -1,
  )

  return (
    <>
      <Link href="/cartoes" className="rotulo hover:text-primaria">
        ‹ cartões
      </Link>

      <h1 className="mt-12">Faturas</h1>

      {faturas.isPending && <p className="mt-24 text-corpo text-ink-3">Carregando…</p>}

      {faturas.data?.itens.length === 0 && (
        <p className="mt-24 max-w-[60ch] text-corpo text-ink-3">
          Nenhuma fatura ainda. Ela nasce na primeira compra do ciclo — ninguém
          abre fatura à mão.
        </p>
      )}

      <div className="mt-32 flex flex-col gap-64">
        {ordenadas.map((f) => (
          <FaturaDetalhada
            key={f.id}
            tenantId={espaco.id}
            fatura={f}
            nomeDaCategoria={dicionarios.nomeDaCategoria}
            corDaCategoria={dicionarios.corDaCategoriaPorId}
          />
        ))}
      </div>
    </>
  )
}

function FaturaDetalhada({
  tenantId,
  fatura,
  nomeDaCategoria,
  corDaCategoria,
}: {
  tenantId: string
  fatura: Fatura
  nomeDaCategoria(id: string | null): string
  corDaCategoria(id: string | null): string | null
}) {
  const lancamentos = useQuery({
    queryKey: ['lancamentos-da-fatura', tenantId, fatura.id],
    queryFn: () => api.lancamentosDaFatura(tenantId, fatura.id),
  })

  const itens = lancamentos.data?.itens ?? []
  const soma = itens.reduce((a, l) => a + BigInt(l.valorCentavos), 0n)
  const bate = soma.toString() === fatura.totalCentavos

  return (
    <section className="max-w-[760px]">
      <div className="flex items-baseline justify-between gap-24">
        <p className="rotulo">
          Fatura de {fatura.competencia.slice(0, 7)} · {fatura.estado.replace('_', ' ')}
        </p>
        {BigInt(fatura.pagoCentavos) > 0n && (
          <p className="text-sm text-ink-3">
            pago <Valor centavos={fatura.pagoCentavos} />
          </p>
        )}
      </div>

      <p className="mt-8 font-numero text-4 font-semibold tracking-tight text-ink-0">
        <Valor centavos={fatura.totalCentavos} isolado />
      </p>

      <div className="mt-12">
        <TrilhoDeCiclo fechamento={fatura.dataFechamento} vencimento={fatura.dataVencimento} />
      </div>

      {itens.length > 0 && (
        <div className="mt-24">
          <div className="linha h-[var(--altura-colunas)] grid-cols-[56px_minmax(0,1fr)_auto_auto] border-b border-line-forte bg-surface-2 lg:grid-cols-[72px_1fr_180px_150px]">
            <span className="rotulo">Data</span>
            <span className="rotulo">Descrição</span>
            <span className="rotulo">Categoria</span>
            <span className="rotulo text-right">Valor</span>
          </div>

          {itens.map((l) => {
            const cor = corDaCategoria(l.categoriaId)
            return (
              <div key={l.id} className="linha grid-cols-[56px_minmax(0,1fr)_auto_auto] lg:grid-cols-[72px_1fr_180px_150px]">
                <span className="valor text-sm text-ink-3">{diaCurto(l.postedAt)}</span>
                <span className="truncate text-1">{l.descricao}</span>
                <span className="flex items-center gap-6 truncate text-sm text-ink-3">
                  <span
                    className="marca-categoria"
                    style={{ background: cor ?? 'var(--dado-outros)' }}
                    aria-hidden="true"
                  />
                  <span className="truncate">{nomeDaCategoria(l.categoriaId)}</span>
                </span>
                <span className="text-right text-1">
                  <Valor centavos={l.valorCentavos} />
                </span>
              </div>
            )
          })}

          <div className="flex h-[var(--altura-cabecalho-dia)] items-center justify-end gap-16 border-b border-line-forte pr-8">
            <span className="rotulo">Total</span>
            <span className="text-1">
              <Valor centavos={soma.toString()} />
            </span>
          </div>

          {/* A tela mostra o próprio defeito em vez de escondê-lo: se a soma
              das linhas não for o total, o número de cima está errado, e quem
              está conferindo precisa saber disso. */}
          {!bate && (
            <p role="alert" className="mt-12 text-corpo text-despesa">
              A soma dos lançamentos não bate com o total desta fatura. Isto é
              defeito nosso — não altere nada e nos avise.
            </p>
          )}
        </div>
      )}

      {lancamentos.data && itens.length === 0 && (
        <p className="mt-16 text-corpo text-ink-3">Nenhuma compra nesta fatura.</p>
      )}
    </section>
  )
}

function diaCurto(iso: string): string {
  const c = dataCivilDe(new Date(iso))
  return `${String(c.dia).padStart(2, '0')}/${String(c.mes).padStart(2, '0')}`
}
