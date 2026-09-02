'use client'

import { useQueries, useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useState } from 'react'
import { api } from '../../api/cliente'
import { mesAnterior, mesSeguinte, periodoDe } from '../../api/periodo'
import { useEspaco } from '../../componentes/provedores'
import { Trilho } from '../../componentes/trilho'
import { Valor } from '../../componentes/valor'
import { competenciaDe } from '@mavia/domain'

/**
 * Visão geral.
 *
 * Grade **7fr / 4fr**, e não três colunas iguais: a coluna dominante carrega
 * estado e urgência, a de apoio carrega ação. Simetria é o default de quem não
 * decidiu (`docs/design.md` §2.5).
 *
 * Um herói por tela — o saldo, em 56px, com o trilho logo abaixo. A frase que o
 * segue é **específica**, montada com os números do próprio usuário, e não um
 * slogan: "você tem R$ X hoje e R$ Y previstos até o fim do mês" diz algo;
 * "controle suas finanças" não diz nada.
 */
export default function VisaoGeral() {
  const espaco = useEspaco()
  const [mes, setMes] = useState(() => competenciaDe(new Date()))
  const periodo = periodoDe(mes.ano, mes.mes)

  const resumo = useQuery({
    queryKey: ['resumo', espaco.id, periodo.janela, 'caixa'],
    // O eixo é **caixa**: esta tela responde "quanto há e quanto haverá na
    // conta". O eixo competência responde outra pergunta, e misturá-los foi o
    // defeito RP-4.
    queryFn: () => api.resumo(espaco.id, periodo.janela, 'caixa'),
  })

  const contas = useQuery({
    queryKey: ['contas', espaco.id],
    queryFn: () => api.contas(espaco.id),
  })

  const cartoes = useQuery({
    queryKey: ['cartoes', espaco.id],
    queryFn: () => api.cartoes(espaco.id),
  })

  const saldosPorConta = useQueries({
    queries: (contas.data?.itens ?? []).map((c) => ({
      queryKey: ['resumo-conta', espaco.id, c.id, periodo.janela],
      queryFn: () => api.resumo(espaco.id, periodo.janela, 'caixa', c.id),
    })),
  })

  return (
    <>
      <div className="flex items-baseline justify-between gap-24">
        <h1 className="sr-only">Visão geral</h1>
        <p className="rotulo">Saldo geral · {periodo.rotulo}</p>
        <NavegadorDeMes
          rotulo={periodo.rotulo}
          aoVoltar={() => setMes(mesAnterior(mes))}
          aoAvancar={() => setMes(mesSeguinte(mes))}
        />
      </div>

      <div className="mt-32 grid gap-44 lg:grid-cols-[7fr_4fr]">
        {/* ---------------------------------------------------------------
            Coluna dominante — estado e urgência
            --------------------------------------------------------------- */}
        <section>
          {resumo.isPending ? (
            <p className="text-corpo text-ink-3">Somando o período…</p>
          ) : resumo.data ? (
            <>
              <p className="font-numero text-heroi font-bold leading-none tracking-tight text-ink-0">
                <Valor centavos={resumo.data.saldo} isolado saldo />
              </p>

              <div className="mt-16 max-w-[520px]">
                {/*
                  O trilho mede **despesa realizada contra despesa do mês**, e
                  não saldo contra projeção.

                  A §1.3 sugeria saldo contra previsto, e isso não fecha: quando
                  ainda há dinheiro para sair, o saldo de hoje é MAIOR que a
                  projeção, e a geometria — que existe para acusar estouro de
                  gasto — leria a diferença como "R$ 149 acima do previsto".
                  Estaria dizendo que a pessoa gastou demais justamente porque
                  ela ainda não gastou.

                  Despesa realizada contra despesa do mês é a mesma pergunta do
                  documento — quanto disto já é fato, e onde estava previsto
                  terminar — sobre um par em que ela tem resposta.
                */}
                <Trilho
                  realizadoCentavos={resumo.data.despesaRealizada}
                  previstoCentavos={(
                    BigInt(resumo.data.despesaRealizada) + BigInt(resumo.data.despesaPrevista)
                  ).toString()}
                  tamanho="heroi"
                  denominador={`do gasto previsto para ${periodo.rotulo.split(' de ')[0]}`}
                />
              </div>

              <p className="mt-24 max-w-[52ch] text-corpo text-ink-2">
                <FraseDoMes
                  saldo={resumo.data.saldo}
                  projetado={resumo.data.projetado}
                  despesaPrevista={resumo.data.despesaPrevista}
                />
              </p>
            </>
          ) : (
            <p className="text-corpo text-despesa">Não foi possível somar o período.</p>
          )}

          <hr className="my-44 border-line" />

          <p className="rotulo">Contas</p>
          <ul className="mt-12">
            {(contas.data?.itens ?? []).map((c, i) => (
              <li key={c.id} className="linha grid-cols-[1fr_auto]">
                <span className="truncate text-1">{c.nome}</span>
                <span className="text-1">
                  <Valor centavos={saldosPorConta[i]?.data?.saldo ?? c.saldoInicialCentavos} saldo />
                </span>
              </li>
            ))}
            {contas.data?.itens.length === 0 && (
              <li className="flex h-[32px] items-center text-corpo text-ink-3">
                Nenhuma conta ainda.
              </li>
            )}
          </ul>
        </section>

        {/* ---------------------------------------------------------------
            Coluna de apoio — ação e cartões
            --------------------------------------------------------------- */}
        <aside>
          <p className="rotulo">Cartões</p>
          <ul className="mt-12 flex flex-col gap-24">
            {(cartoes.data?.itens ?? []).map((c) => (
              <li key={c.id}>
                <Link href={`/cartoes/${c.id}`} className="block hover:text-primaria">
                  <p className="text-1 font-medium">{c.nome}</p>
                  <p className="mt-4 text-sm text-ink-3">
                    fecha dia {c.closingDay} · vence dia {c.dueDay}
                  </p>
                </Link>
              </li>
            ))}
            {cartoes.data?.itens.length === 0 && (
              // Vazio ocupa uma linha de 32px e convida com algo específico —
              // não um widget permanente roubando a coluna para sempre.
              <li className="flex h-[32px] items-center text-corpo text-ink-3">
                Nenhum cartão ainda.
              </li>
            )}
          </ul>

          <hr className="my-44 border-line" />

          <p className="rotulo">No mês</p>
          {resumo.data && (
            <dl className="mt-12">
              <LinhaDeResumo rotulo="Receitas" centavos={resumo.data.receitaRealizada} />
              <LinhaDeResumo rotulo="Despesas" centavos={resumo.data.despesaRealizada} />
              <LinhaDeResumo
                rotulo="Ainda previsto"
                centavos={resumo.data.despesaPrevista}
                previsto
              />
              {/* Transferência tem linha própria e neutra: ela não é receita nem
                  despesa, e somá-la a qualquer um dos dois duplica o gasto. */}
              <LinhaDeResumo
                rotulo="Transferências"
                centavos={resumo.data.transferenciaLiquidaRealizada}
                transferencia
              />
            </dl>
          )}
        </aside>
      </div>
    </>
  )
}

function LinhaDeResumo({
  rotulo,
  centavos,
  previsto = false,
  transferencia = false,
}: {
  rotulo: string
  centavos: string
  previsto?: boolean
  transferencia?: boolean
}) {
  return (
    <div className="linha grid-cols-[1fr_auto]">
      <dt className="text-corpo text-ink-2">{rotulo}</dt>
      <dd className="text-1">
        <Valor centavos={centavos} previsto={previsto} transferencia={transferencia} />
      </dd>
    </div>
  )
}

function NavegadorDeMes({
  rotulo,
  aoVoltar,
  aoAvancar,
}: {
  rotulo: string
  aoVoltar(): void
  aoAvancar(): void
}) {
  return (
    <div className="flex items-center gap-12">
      <button className="botao botao--discreto" onClick={aoVoltar} aria-label="Mês anterior">
        ‹
      </button>
      <span className="min-w-[15ch] text-center text-corpo">{rotulo}</span>
      <button className="botao botao--discreto" onClick={aoAvancar} aria-label="Mês seguinte">
        ›
      </button>
    </div>
  )
}

/**
 * A frase específica.
 *
 * Ela é montada com os números do próprio usuário porque uma frase genérica no
 * lugar mais visível da tela é espaço gasto sem informar nada. Quando não há o
 * que dizer de específico, ela some — em vez de virar slogan.
 */
function FraseDoMes({
  saldo,
  projetado,
  despesaPrevista,
}: {
  saldo: string
  projetado: string
  despesaPrevista: string
}) {
  const aPagar = -BigInt(despesaPrevista)
  if (aPagar <= 0n) {
    return <>Nada mais previsto para sair este mês.</>
  }

  const cai = BigInt(saldo) > BigInt(projetado)
  return (
    <>
      Ainda há <Valor centavos={(-aPagar).toString()} previsto /> previstos para sair este mês
      {cai ? ', e o saldo fecha menor do que está hoje.' : '.'}
    </>
  )
}
