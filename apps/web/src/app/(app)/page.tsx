'use client'

import { competenciaDe } from '@mavia/domain'
import { corDaCategoria } from '@mavia/ui'
import { useQueries, useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { api } from '../../api/cliente'
import { montarDicionarios } from '../../api/dicionarios'
import { mesAnterior, mesSeguinte, periodoDe } from '../../api/periodo'
import { AcaoDeLancar } from '../../componentes/acao-de-lancar'
import { Cartao, Vazio } from '../../componentes/cartao'
import { FormularioDeLancamento } from '../../componentes/formulario-de-lancamento'
import { IconeDeCategoria } from '../../componentes/icone-de-categoria'
import { useEspaco } from '../../componentes/provedores'
import { Valor } from '../../componentes/valor'

/**
 * Visão geral.
 *
 * Duas colunas de **cards independentes**, na disposição do Organizze (DP-31):
 * à esquerda o que é estado e urgência — saldo, contas, a pagar; à direita o
 * que é análise e o que exige ação — cartões, para onde o dinheiro foi.
 *
 * O cabeçalho carrega as **ações primárias** em vez de um botão flutuante. É
 * deliberado no Organizze e vale herdar: lançar é o que a pessoa vem fazer, e o
 * lugar de lançar é a primeira tela.
 *
 * Onde nos afastamos: os **estados vazios são compactos**. O teardown aponta
 * (§8.5, item 3) que os vazios permanentes do Organizze ocupam o espaço de um
 * widget cheio para sempre — bom no primeiro dia, ruim em todos os outros.
 */
export default function VisaoGeral() {
  const espaco = useEspaco()
  const [mes, setMes] = useState(() => competenciaDe(new Date()))
  const [lancando, setLancando] = useState<'despesa' | 'receita' | 'transferencia' | null>(null)
  const [ocultarSaldo, setOcultarSaldo] = useState(false)

  const periodo = periodoDe(mes.ano, mes.mes)

  const resumo = useQuery({
    queryKey: ['resumo', espaco.id, periodo.janela, 'caixa'],
    // Eixo **caixa**: esta tela responde "quanto há e quanto haverá na conta".
    // O eixo competência responde outra pergunta, e misturá-los foi o RP-4.
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

  const categorias = useQuery({
    queryKey: ['categorias', espaco.id],
    queryFn: () => api.categorias(espaco.id),
    staleTime: 5 * 60_000,
  })

  const lancamentos = useQuery({
    queryKey: ['lancamentos', espaco.id, periodo.janela],
    queryFn: () => api.lancamentos(espaco.id, periodo.janela),
  })

  const saldosPorConta = useQueries({
    queries: (contas.data?.itens ?? []).map((c) => ({
      queryKey: ['resumo-conta', espaco.id, c.id, periodo.janela],
      queryFn: () => api.resumo(espaco.id, periodo.janela, 'caixa' as const, c.id),
    })),
  })

  const faturas = useQueries({
    queries: (cartoes.data?.itens ?? []).map((c) => ({
      queryKey: ['faturas', espaco.id, c.id],
      queryFn: () => api.faturas(espaco.id, c.id),
    })),
  })

  const dicionarios = useMemo(
    () => montarDicionarios(categorias.data?.itens ?? [], contas.data?.itens ?? []),
    [categorias.data, contas.data],
  )

  const aPagar = useMemo(
    () =>
      (lancamentos.data?.itens ?? [])
        .filter((l) => l.status !== 'efetivado' && BigInt(l.valorCentavos) < 0n)
        .sort((a, b) => (a.postedAt < b.postedAt ? -1 : 1)),
    [lancamentos.data],
  )

  const porCategoria = useMemo(
    () => maioresGastos(lancamentos.data?.itens ?? [], categorias.data?.itens ?? []),
    [lancamentos.data, categorias.data],
  )

  return (
    <>
      {/* -----------------------------------------------------------------
          Cabeçalho: período, totais do mês e as ações primárias
          ----------------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-16">
        <div className="flex items-center gap-8">
          <button className="botao" onClick={() => setMes(mesAnterior(mes))} aria-label="Mês anterior">
            ‹
          </button>
          <span className="text-center font-numero text-2 font-semibold lg:min-w-[15ch]">
            <span className="lg:hidden">{periodo.rotuloCurto}</span>
            <span className="hidden lg:inline">{periodo.rotulo}</span>
            </span>
          <button className="botao" onClick={() => setMes(mesSeguinte(mes))} aria-label="Mês seguinte">
            ›
          </button>
        </div>

        {resumo.data && (
          <div className="flex items-center gap-24">
            <TotalDoMes rotulo="Receita do mês" centavos={resumo.data.receitaRealizada} />
            <TotalDoMes rotulo="Despesa do mês" centavos={resumo.data.despesaRealizada} />
          </div>
        )}

        {/* No celular estas ações levam à rota `/lancar`; no computador abrem a
            sobreposição sobre esta tela. Quem decide é a consulta de mídia
            dentro de `AcaoDeLancar`, e não uma medida de largura em JavaScript. */}
        <div className="ml-auto flex flex-wrap items-center gap-8">
          <AcaoDeLancar rotulo="despesa" aoAbrir={() => setLancando('despesa')} />
          <AcaoDeLancar
            rotulo="receita"
            variante="discreto"
            aoAbrir={() => setLancando('receita')}
          />
          <AcaoDeLancar
            rotulo="transferência"
            variante="discreto"
            aoAbrir={() => setLancando('transferencia')}
          />
        </div>
      </div>

      <div className="mt-24 grid gap-24 lg:grid-cols-[7fr_5fr]">
        {/* ---------------------------------------------------------------
            Coluna esquerda — estado e urgência
            --------------------------------------------------------------- */}
        <div className="flex flex-col gap-24">
          <Cartao
            titulo="Saldo geral"
            acoes={
              // O olho de ocultar é do Organizze, e serve a quem abre o
              // aplicativo em lugar público. É estado da sessão, não do usuário.
              <button
                className="botao text-sm"
                aria-pressed={ocultarSaldo}
                onClick={() => setOcultarSaldo((v) => !v)}
              >
                {ocultarSaldo ? 'mostrar' : 'ocultar'}
              </button>
            }
          >
            {resumo.isPending ? (
              <p className="text-corpo text-ink-3">Somando…</p>
            ) : resumo.data ? (
              <>
                <p className="font-numero text-heroi font-bold leading-none tracking-tight text-ink-0">
                  {ocultarSaldo ? (
                    <span aria-label="Saldo oculto">••••••</span>
                  ) : (
                    <Valor centavos={resumo.data.saldo} isolado saldo />
                  )}
                </p>
                <p className="mt-12 text-corpo text-ink-2">
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
          </Cartao>

          <Cartao
            titulo="Minhas contas"
            semPadding
            rodape={
              <Link href="/contas" className="hover:underline">
                gerenciar contas
              </Link>
            }
          >
            {contas.data?.itens.length === 0 ? (
              <div className="px-20 py-8">
                <Vazio
                  acao={
                    <Link href="/contas" className="botao botao--primario">
                      criar conta
                    </Link>
                  }
                >
                  Toda movimentação sai de uma conta ou de um cartão. Comece pela
                  conta em que o seu salário cai.
                </Vazio>
              </div>
            ) : (
              (contas.data?.itens ?? []).map((c, i) => (
                <div key={c.id} className="linha grid-cols-[auto_1fr_auto]">
                  <IconeDeCategoria nome={c.nome} cor={corDaCategoria(c.id)} />
                  <span className="min-w-0">
                    <span className="block truncate text-1">{c.nome}</span>
                    <span className="block text-sm text-ink-3">
                      {c.origem === 'conectado' ? 'conta conectada' : 'conta manual'}
                      {!c.incluirNoSaldoGeral && ' · fora do saldo geral'}
                    </span>
                  </span>
                  <span className="text-1">
                    <Valor
                      centavos={saldosPorConta[i]?.data?.saldo ?? c.saldoInicialCentavos}
                      saldo
                    />
                  </span>
                </div>
              ))
            )}
          </Cartao>

          <Cartao titulo="Contas a pagar" semPadding>
            {aPagar.length === 0 ? (
              <div className="px-20 py-8">
                <Vazio>Nada previsto para sair em {periodo.rotulo}.</Vazio>
              </div>
            ) : (
              aPagar.map((l) => {
                const atrasado = l.status === 'pendente'
                return (
                  <div key={l.id} className="linha grid-cols-[auto_1fr_auto_auto]">
                    <IconeDeCategoria
                      nome={dicionarios.nomeDaCategoria(l.categoriaId)}
                      cor={dicionarios.corDaCategoriaPorId(l.categoriaId) ?? 'var(--dado-outros)'}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-1">{l.descricao}</span>
                      <span className="block truncate text-sm text-ink-3">
                        {dicionarios.nomeDaCategoria(l.categoriaId)}
                      </span>
                    </span>
                    <span className={`text-sm ${atrasado ? 'text-despesa' : 'text-ink-3'}`}>
                      {atrasado ? 'em atraso' : diaCurto(l.postedAt)}
                    </span>
                    <span className="text-1">
                      <Valor centavos={l.valorCentavos} previsto />
                    </span>
                  </div>
                )
              })
            )}
          </Cartao>
        </div>

        {/* ---------------------------------------------------------------
            Coluna direita — cartões e análise
            --------------------------------------------------------------- */}
        <div className="flex flex-col gap-24">
          <Cartao
            titulo="Cartões de crédito"
            semPadding
            {...((cartoes.data?.itens.length ?? 0) > 0
              ? {
                  rodape: (
                    <Link href="/cartoes" className="hover:underline">
                      ver faturas
                    </Link>
                  ),
                }
              : {})}
          >
            {cartoes.data?.itens.length === 0 ? (
              <div className="px-20 py-8">
                <Vazio
                  acao={
                    <Link href="/cartoes" className="botao botao--primario">
                      adicionar cartão
                    </Link>
                  }
                >
                  Nenhum cartão. O ciclo — dia de fechamento e de vencimento — é o
                  que decide em qual fatura cada compra entra.
                </Vazio>
              </div>
            ) : (
              (cartoes.data?.itens ?? []).map((cartao, i) => {
                const aberta = [...(faturas[i]?.data?.itens ?? [])]
                  .sort((a, b) => (a.competencia < b.competencia ? -1 : 1))
                  .find((f) => f.estado === 'aberta')

                return (
                  <Link
                    key={cartao.id}
                    href={`/cartoes/${cartao.id}`}
                    className="linha grid-cols-[auto_1fr_auto]"
                  >
                    <IconeDeCategoria nome={cartao.nome} cor={corDaCategoria(cartao.id)} />
                    <span className="min-w-0">
                      <span className="block truncate text-1">{cartao.nome}</span>
                      <span className="block truncate text-sm text-ink-3">
                        {aberta
                          ? `fatura aberta · vence ${aberta.dataVencimento}`
                          : `fecha dia ${cartao.closingDay}`}
                      </span>
                    </span>
                    <span className="text-1">
                      {aberta && <Valor centavos={aberta.totalCentavos} />}
                    </span>
                  </Link>
                )
              })
            )}
          </Cartao>

          <Cartao
            titulo="Onde o dinheiro foi"
            semPadding
            {...(porCategoria.length > 0
              ? {
                  rodape: (
                    <Link href="/lancamentos" className="hover:underline">
                      ver lançamentos
                    </Link>
                  ),
                }
              : {})}
          >
            {porCategoria.length === 0 ? (
              <div className="px-20 py-8">
                <Vazio>Nenhuma despesa em {periodo.rotulo} ainda.</Vazio>
              </div>
            ) : (
              porCategoria.map((c) => (
                <div key={c.id} className="linha grid-cols-[auto_1fr_auto]">
                  <IconeDeCategoria nome={c.nome} cor={c.cor} />
                  <span className="min-w-0">
                    <span className="block truncate text-1">{c.nome}</span>
                    {/* A barra de participação: o teardown mostra uma rosca, e a
                        barra responde à mesma pergunta sem a leitura angular,
                        que é justamente a parte que a rosca faz mal. */}
                    <span
                      className="mt-6 block h-[4px] rounded-1"
                      style={{ width: `${c.fracao * 100}%`, background: c.cor, minWidth: 2 }}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="text-right">
                    <span className="block text-1">
                      <Valor centavos={c.centavos.toString()} />
                    </span>
                    <span className="block text-sm text-ink-3">
                      {(c.fracao * 100).toFixed(0)}%
                    </span>
                  </span>
                </div>
              ))
            )}
          </Cartao>
        </div>
      </div>

      {/* A sobreposição é do computador, e o `hidden lg:contents` é o que
          garante isso mesmo se a janela encolher com ela aberta: no celular o
          formulário é a rota `/lancar`, que o teclado exige. */}
      <div className="hidden lg:contents">
        {lancando && (
          <FormularioDeLancamento
            tenantId={espaco.id}
            naturezaInicial={lancando}
            contas={contas.data?.itens ?? []}
            cartoes={cartoes.data?.itens ?? []}
            categorias={categorias.data?.itens ?? []}
            aoFechar={() => setLancando(null)}
          />
        )}
      </div>
    </>
  )
}

function TotalDoMes({ rotulo, centavos }: { rotulo: string; centavos: string }) {
  return (
    <div>
      <p className="rotulo">{rotulo}</p>
      <p className="mt-2 font-numero text-2 font-semibold">
        <Valor centavos={centavos} />
      </p>
    </div>
  )
}

interface FatiaDeCategoria {
  readonly id: string
  readonly nome: string
  readonly cor: string
  readonly centavos: bigint
  readonly fracao: number
}

/**
 * Os maiores gastos do mês, agrupados pela **categoria-raiz**.
 *
 * Raiz, e não folha: "Mercado" e "Restaurante" respondem juntas a pergunta
 * "quanto foi para alimentação", e é essa a pergunta do painel. A quebra por
 * subcategoria é do relatório.
 *
 * Transferência fica de fora por construção — ela não é gasto (regra 12b), e
 * somá-la faria o pagamento de fatura aparecer como despesa.
 */
function maioresGastos(
  lancamentos: readonly {
    categoriaId: string | null
    valorCentavos: string
    transferGroupId: string | null
  }[],
  categorias: readonly { id: string; nome: string; parentId: string | null }[],
): FatiaDeCategoria[] {
  const porId = new Map(categorias.map((c) => [c.id, c]))
  const soma = new Map<string, bigint>()

  for (const l of lancamentos) {
    if (l.transferGroupId !== null) continue
    const valor = BigInt(l.valorCentavos)
    if (valor >= 0n) continue
    if (!l.categoriaId) continue

    const c = porId.get(l.categoriaId)
    const raiz = c?.parentId ?? l.categoriaId
    soma.set(raiz, (soma.get(raiz) ?? 0n) + valor)
  }

  const total = [...soma.values()].reduce((a, b) => a + b, 0n)
  if (total === 0n) return []

  return [...soma.entries()]
    .sort(([, a], [, b]) => (a < b ? -1 : 1))
    .slice(0, 6)
    .map(([id, centavos]) => ({
      id,
      nome: porId.get(id)?.nome ?? 'Sem categoria',
      cor: corDaCategoria(id),
      centavos,
      fracao: Number((centavos * 1000n) / total) / 1000,
    }))
}

/**
 * A frase específica, montada com os números do próprio usuário.
 *
 * Uma frase genérica no lugar mais visível da tela é espaço gasto sem informar
 * nada. Quando não há o que dizer de específico, ela some.
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
  if (aPagar <= 0n) return <>Nada mais previsto para sair este mês.</>

  const cai = BigInt(saldo) > BigInt(projetado)
  return (
    <>
      Ainda há <Valor centavos={(-aPagar).toString()} previsto /> previstos para sair
      {cai ? ', e o saldo fecha menor do que está hoje.' : '.'}
    </>
  )
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

function diaCurto(iso: string): string {
  const d = new Date(iso)
  return `${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`
}
