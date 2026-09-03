'use client'

import type { Fatura } from '@mavia/contracts'
import { dataCivilDe, formatarDataCivil } from '@mavia/domain'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useState } from 'react'
import { api, chamar, ErroDaApi } from '../../../api/cliente'
import { Cartao as CartaoUi, Vazio } from '../../../componentes/cartao'
import { FormularioDeCartao } from '../../../componentes/formulario-de-cartao'
import { PagamentoDeFatura } from '../../../componentes/pagamento-de-fatura'
import { useEspaco } from '../../../componentes/provedores'
import { TrilhoDeCiclo } from '../../../componentes/trilho-de-ciclo'
import { Valor } from '../../../componentes/valor'

/**
 * Cartões — cada um como **objeto com ciclo**, não como linha de saldo.
 *
 * É onde a Mavia mais se afasta do Organizze, que não tem visão de fatura como
 * objeto. Um cartão não tem saldo: ele tem uma janela que abre, fecha e vence,
 * e a pergunta do usuário é sempre "quanto e quando", nunca "quanto tem".
 *
 * As duas ações da fatura vivem aqui porque é aqui que a pessoa olha quando
 * pensa nelas. **Fechar** trava o total; **pagar** só aparece depois disso —
 * pagar um total que ainda pode mudar é pagar um número que não é o número, e
 * a rota recusa. Oferecer o botão antes seria oferecer um erro.
 */
export default function Cartoes() {
  const espaco = useEspaco()
  const [criando, setCriando] = useState(false)
  const [pagando, setPagando] = useState<Fatura | null>(null)

  const cartoes = useQuery({
    queryKey: ['cartoes', espaco.id],
    queryFn: () => api.cartoes(espaco.id),
  })

  const contas = useQuery({
    queryKey: ['contas', espaco.id],
    queryFn: () => api.contas(espaco.id),
  })

  const faturas = useQueries({
    queries: (cartoes.data?.itens ?? []).map((c) => ({
      queryKey: ['faturas', espaco.id, c.id],
      queryFn: () => api.faturas(espaco.id, c.id),
    })),
  })

  const semContas = (contas.data?.itens.length ?? 0) === 0

  return (
    <>
      <div className="flex items-baseline justify-between gap-24">
        <h1>Cartões</h1>
        <button
          className="botao botao--primario"
          onClick={() => setCriando(true)}
          disabled={semContas}
        >
          + cartão
        </button>
      </div>

      {cartoes.isPending && <p className="mt-24 text-corpo text-ink-3">Carregando…</p>}

      {contas.data && semContas && (
        <div className="mt-24 max-w-[700px]">
          <CartaoUi>
            <Vazio
              acao={
                <Link href="/contas" className="botao botao--primario">
                  criar conta
                </Link>
              }
            >
              Antes do cartão, crie a conta que vai pagá-lo — o pagamento da
              fatura é uma transferência, e ela precisa sair de algum lugar.
            </Vazio>
          </CartaoUi>
        </div>
      )}

      {cartoes.data?.itens.length === 0 && !semContas && (
        <div className="mt-24 max-w-[700px]">
          <CartaoUi>
            <Vazio
              acao={
                <button className="botao botao--primario" onClick={() => setCriando(true)}>
                  adicionar cartão
                </button>
              }
            >
              Nenhum cartão ainda. Um cartão precisa do dia de fechamento e do dia
              de vencimento — é o ciclo que decide em qual fatura cada compra entra.
            </Vazio>
          </CartaoUi>
        </div>
      )}

      <div className="mt-24 grid max-w-[820px] gap-24">
        {(cartoes.data?.itens ?? []).map((cartao, i) => {
          const lista = [...(faturas[i]?.data?.itens ?? [])].sort((a, b) =>
            a.competencia < b.competencia ? -1 : 1,
          )
          // A corrente é a **aberta mais antiga**: a que está recebendo compra
          // agora, e a única cujo total ainda muda.
          const corrente = lista.find((f) => f.estado === 'aberta')
          const outras = lista.filter((f) => f.id !== corrente?.id)

          return (
            <CartaoUi
              key={cartao.id}
              titulo={cartao.nome}
              acoes={
                <span className="text-sm text-ink-3">
                  fecha dia {cartao.closingDay} · vence dia {cartao.dueDay}
                </span>
              }
              semPadding
              rodape={
                <Link href={`/cartoes/${cartao.id}`} className="hover:underline">
                  ver todas as faturas
                </Link>
              }
            >
              {corrente ? (
                <FaturaCorrente tenantId={espaco.id} fatura={corrente} />
              ) : (
                <p className="px-20 py-16 text-corpo text-ink-3">
                  Nenhuma fatura aberta. Ela nasce na primeira compra do ciclo —
                  ninguém abre fatura à mão.
                </p>
              )}

              {outras.length > 0 && (
                <div className="border-t border-line">
                  <p className="rotulo px-20 pt-16">Demais faturas</p>
                  <ul className="mt-8">
                    {outras.map((f) => (
                      <li key={f.id} className="linha grid-cols-[92px_1fr_150px_88px]">
                        <span className="valor text-1">{f.competencia.slice(0, 7)}</span>
                        <span className="truncate text-sm text-ink-3">
                          {f.estado.replace('_', ' ')} · vence {f.dataVencimento}
                        </span>
                        <span className="text-right text-1">
                          <Valor centavos={f.totalCentavos} />
                        </span>
                        <span className="text-right">
                          {podeReceberPagamento(f) && (
                            <button className="botao text-sm" onClick={() => setPagando(f)}>
                              pagar
                            </button>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="max-w-[60ch] px-20 pb-16 text-sm text-ink-3">
                    Parcela lançada em fatura futura já é compromisso: ela aparece
                    aqui desde o dia da compra, e não no mês em que chega.
                  </p>
                </div>
              )}
            </CartaoUi>
          )
        })}
      </div>

      {criando && (
        <FormularioDeCartao
          tenantId={espaco.id}
          contas={contas.data?.itens ?? []}
          aoFechar={() => setCriando(false)}
        />
      )}

      {pagando && (
        <PagamentoDeFatura
          tenantId={espaco.id}
          fatura={pagando}
          contas={contas.data?.itens ?? []}
          aoFechar={() => setPagando(null)}
        />
      )}
    </>
  )
}

/**
 * Quais faturas aceitam pagamento.
 *
 * Três condições, e cada uma corresponde a uma recusa do servidor:
 *
 * - **não pode estar aberta** — o total ainda muda;
 * - **não pode estar paga** — não sobrou nada;
 * - **o saldo precisa ser devedor** — uma fatura credora (mais estorno do que
 *   compra) é dinheiro que o cartão deve ao usuário; "pagá-la" tiraria dinheiro
 *   da conta em vez de devolver.
 */
function podeReceberPagamento(f: Fatura): boolean {
  if (f.estado === 'aberta' || f.estado === 'paga') return false
  return BigInt(f.totalCentavos) + BigInt(f.pagoCentavos) < 0n
}

/**
 * A fatura corrente, com o trilho de ciclo e a ação de fechar.
 *
 * Fechar trava o total e **não tem desfazer simples** — por isso o texto ao
 * lado do botão diz a consequência antes do clique, e não num aviso depois.
 */
function FaturaCorrente({ tenantId, fatura }: { tenantId: string; fatura: Fatura }) {
  const fila = useQueryClient()
  const [erro, setErro] = useState<string | null>(null)

  const fechar = useMutation({
    mutationFn: () => chamar(`/cartoes/faturas/${fatura.id}/fechar`, { metodo: 'POST', tenantId }),
    onSuccess() {
      void fila.invalidateQueries({ queryKey: ['faturas'] })
      void fila.invalidateQueries({ queryKey: ['resumo'] })
    },
    onError(e) {
      setErro(e instanceof ErroDaApi ? e.message : 'Não foi possível fechar a fatura.')
    },
  })

  const vazia = BigInt(fatura.totalCentavos) === 0n

  // Quem fecha uma fatura é o **calendário**, não um botão (migration 0015).
  // Antes da data, fechar criaria uma fatura que já contém compras posteriores
  // ao próprio fechamento e empurraria as seguintes do ciclo para o mês que
  // vem, em silêncio. O servidor recusa; a tela não oferece.
  const hoje = formatarDataCivil(dataCivilDe(new Date()))
  const aindaNaoFechou = hoje < fatura.dataFechamento

  return (
    <div className="px-20 py-16">
      <p className="rotulo">Fatura de {fatura.competencia.slice(0, 7)} · aberta</p>
      <p className="mt-8 font-numero text-4 font-semibold tracking-tight text-ink-0">
        <Valor centavos={fatura.totalCentavos} isolado />
      </p>

      <div className="mt-12">
        <TrilhoDeCiclo fechamento={fatura.dataFechamento} vencimento={fatura.dataVencimento} />
      </div>

      <div className="mt-16 flex flex-wrap items-center gap-12">
        <button
          className="botao botao--discreto"
          onClick={() => {
            setErro(null)
            fechar.mutate()
          }}
          disabled={fechar.isPending || aindaNaoFechou}
        >
          {fechar.isPending ? 'fechando…' : 'fechar a fatura'}
        </button>
        <span className="max-w-[46ch] text-sm text-ink-3">
          {aindaNaoFechou
            ? `Ela fecha sozinha em ${fatura.dataFechamento} — até lá ainda recebe compras.`
            : vazia
              ? 'Sem lançamentos: ela fecha já quitada, porque não há o que cobrar.'
              : 'Depois de fechada, o total para de mudar e ela passa a aceitar pagamento.'}
        </span>
      </div>

      {erro && (
        <p role="alert" className="mt-12 text-corpo text-despesa">
          {erro}
        </p>
      )}
    </div>
  )
}
