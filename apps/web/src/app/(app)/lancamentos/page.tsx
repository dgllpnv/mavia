'use client'

import { competenciaDe, dataCivilDe, formatarDataCivil } from '@mavia/domain'
import type { Lancamento } from '@mavia/contracts'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { api } from '../../../api/cliente'
import { montarDicionarios, type Dicionarios } from '../../../api/dicionarios'
import { mesAnterior, mesSeguinte, periodoDe } from '../../../api/periodo'
import { useEspaco } from '../../../componentes/provedores'
import { Trilho } from '../../../componentes/trilho'
import { Valor } from '../../../componentes/valor'

/**
 * Extrato.
 *
 * Coluna única, linhas de **36px**, agrupadas por dia. Sem ícone em círculo,
 * sem card, sem faixa de alerta permanente: são exatamente as três remoções que
 * levam a tela de 6 lançamentos visíveis para 15, num viewport de 900px.
 * Densidade aqui não é estética — é a diferença entre comparar e lembrar.
 *
 * **Os três eixos de filtro são independentes.** O `Tipo` do Organizze colapsa
 * natureza, estado e origem em 13 opções lineares; aqui são três seletores de
 * três a quatro. O que era uma lista de 13 vira três perguntas simples.
 */
export default function Lancamentos() {
  const espaco = useEspaco()
  const [mes, setMes] = useState(() => competenciaDe(new Date()))
  const [natureza, setNatureza] = useState<'todas' | 'receita' | 'despesa' | 'transferencia'>(
    'todas',
  )
  const [estado, setEstado] = useState<'todos' | 'previsto' | 'pendente' | 'efetivado'>('todos')

  const periodo = periodoDe(mes.ano, mes.mes)

  const lista = useQuery({
    queryKey: ['lancamentos', espaco.id, periodo.janela],
    queryFn: () => api.lancamentos(espaco.id, periodo.janela),
  })

  const resumo = useQuery({
    queryKey: ['resumo', espaco.id, periodo.janela, 'caixa'],
    queryFn: () => api.resumo(espaco.id, periodo.janela, 'caixa'),
  })

  // Dois dicionários que a listagem precisa e o extrato não carrega por linha:
  // o servidor devolve o vínculo por identificador porque o nome muda, e uma
  // cópia por lançamento renomearia só as linhas futuras.
  const categorias = useQuery({
    queryKey: ['categorias', espaco.id],
    queryFn: () => api.categorias(espaco.id),
    staleTime: 5 * 60_000,
  })

  const contas = useQuery({
    queryKey: ['contas', espaco.id],
    queryFn: () => api.contas(espaco.id),
    staleTime: 5 * 60_000,
  })

  const dicionarios = useMemo(
    () => montarDicionarios(categorias.data?.itens ?? [], contas.data?.itens ?? []),
    [categorias.data, contas.data],
  )

  const dias = useMemo(
    () =>
      comSaldoAcumulado(
        agruparPorDia(filtrar(lista.data?.itens ?? [], natureza, estado)),
        resumo.data?.saldoAnterior ?? '0',
      ),
    [lista.data, natureza, estado, resumo.data],
  )

  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between gap-24">
        <h1>Lançamentos</h1>
        <div className="flex items-center gap-12">
          <button className="botao botao--discreto" onClick={() => setMes(mesAnterior(mes))} aria-label="Mês anterior">
            ‹
          </button>
          <span className="min-w-[15ch] text-center text-corpo">{periodo.rotulo}</span>
          <button className="botao botao--discreto" onClick={() => setMes(mesSeguinte(mes))} aria-label="Mês seguinte">
            ›
          </button>
        </div>
      </div>

      {/* Barra de filtros achatada em 32px, acima de tudo que ela escopa. */}
      <div className="mt-24 flex h-[32px] items-center gap-16 border-b border-line">
        <Seletor<typeof natureza>
          rotulo="Natureza"
          valor={natureza}
          opcoes={[
            ['todas', 'natureza: todas'],
            ['receita', 'receitas'],
            ['despesa', 'despesas'],
            ['transferencia', 'transferências'],
          ]}
          aoMudar={setNatureza}
        />
        <Seletor<typeof estado>
          rotulo="Estado"
          valor={estado}
          opcoes={[
            ['todos', 'estado: todos'],
            ['previsto', 'previstos'],
            ['pendente', 'pendentes'],
            ['efetivado', 'efetivados'],
          ]}
          aoMudar={setEstado}
        />
        <span className="ml-auto text-sm text-ink-3">
          {dias.reduce((n, d) => n + d.itens.length, 0)} lançamentos
        </span>
      </div>

      {/* Cabeçalho de colunas sticky, 28px. O Organizze não tem — e sem ele o
          usuário reencontra o significado de cada coluna a cada rolagem. */}
      <div className="linha sticky top-[var(--altura-nav)] z-[1] h-[28px] grid-cols-[24px_72px_1fr_160px_120px_160px] border-b border-line-forte bg-surface-2">
        <span />
        <span className="rotulo">Data</span>
        <span className="rotulo">Descrição</span>
        <span className="rotulo">Categoria</span>
        <span className="rotulo">Conta</span>
        <span className="rotulo text-right">Valor</span>
      </div>

      {lista.isPending && <p className="mt-24 text-corpo text-ink-3">Carregando o extrato…</p>}

      {lista.data && dias.length === 0 && (
        <p className="mt-24 text-corpo text-ink-3">
          Nenhum lançamento em {periodo.rotulo} com estes filtros.
        </p>
      )}

      {dias.map((dia) => (
        <section key={dia.chave}>
          <h2 className="cabecalho-dia rotulo">{dia.rotulo}</h2>
          {dia.itens.map((l) => (
            <LinhaDoExtrato key={l.id} lancamento={l} dicionarios={dicionarios} />
          ))}
          {/* O saldo ao fim do dia: o usuário rola o extrato e lê, dia a dia,
              quanto o dia já se cumpriu. É o trilho na sua versão curta. */}
          <div className="flex h-[var(--altura-cabecalho-dia)] items-center justify-end gap-12 border-b border-line pr-8">
            <span className="rotulo">saldo no dia</span>
            <span className="text-sm">
              <Valor centavos={dia.saldoAoFim} saldo />
            </span>
          </div>
        </section>
      ))}

      {/* Rodapé fixo, 56px, com o trilho do mês — o mesmo do painel. A
          continuidade entre as telas é o ponto do elemento-assinatura. */}
      {resumo.data && (
        <div className="sticky bottom-0 mt-32 border-t border-line-forte bg-paper py-12">
          <div className="flex flex-wrap items-baseline gap-x-24 gap-y-4 text-sm text-ink-3">
            <span>
              saldo anterior <Valor centavos={resumo.data.saldoAnterior} saldo />
            </span>
            <span>
              receitas <Valor centavos={resumo.data.receitaRealizada} />
            </span>
            <span>
              despesas <Valor centavos={resumo.data.despesaRealizada} />
            </span>
          </div>
          <div className="mt-8 flex items-baseline gap-24">
            <span className="rotulo">Saldo</span>
            <span className="font-numero text-4 font-semibold tracking-tight text-ink-0">
              <Valor centavos={resumo.data.saldo} isolado saldo />
            </span>
            <span className="min-w-[200px] flex-1">
              <Trilho
                realizadoCentavos={resumo.data.despesaRealizada}
                previstoCentavos={(
                  BigInt(resumo.data.despesaRealizada) + BigInt(resumo.data.despesaPrevista)
                ).toString()}
                denominador={`do gasto previsto para ${periodo.rotulo.split(' de ')[0]}`}
              />
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * A linha, em 36px.
 *
 * O estado é um glifo na primeira coluna — `✓` efetivado, `○` previsto, `⇄`
 * transferência. É o que o Organizze acerta e vale herdar: o estado fica onde o
 * olho já está, e não atrás de um menu.
 */
function LinhaDoExtrato({
  lancamento,
  dicionarios,
}: {
  lancamento: Lancamento
  dicionarios: Dicionarios
}) {
  const transferencia = lancamento.transferGroupId !== null
  const glifo = transferencia ? '⇄' : lancamento.status === 'efetivado' ? '✓' : '○'
  const cor = dicionarios.corDaCategoriaPorId(lancamento.categoriaId)

  return (
    <div className="linha grid-cols-[24px_72px_1fr_160px_120px_160px]">
      <span
        className="text-sm text-ink-3"
        title={transferencia ? 'transferência' : lancamento.status}
        aria-label={transferencia ? 'transferência' : lancamento.status}
      >
        {glifo}
      </span>
      <span className="valor text-sm text-ink-3">{diaCurto(lancamento.postedAt)}</span>
      <span className="truncate text-1">{lancamento.descricao}</span>
      <span className="flex items-center gap-6 truncate text-sm text-ink-3">
        {transferencia ? (
          '⇄ transferência'
        ) : (
          <>
            {/* Quadrado de 8px, e não ícone em círculo colorido de 32px: a
                mesma informação, 24px a menos de altura de linha. */}
            <span
              className="marca-categoria"
              style={{ background: cor ?? 'var(--dado-outros)' }}
              aria-hidden="true"
            />
            <span className="truncate">{dicionarios.nomeDaCategoria(lancamento.categoriaId)}</span>
          </>
        )}
      </span>
      <span className="truncate text-sm text-ink-3">
        {dicionarios.nomeDaConta(lancamento.contaId)}
      </span>
      <span className="text-right text-1">
        <Valor
          centavos={lancamento.valorCentavos}
          previsto={lancamento.status !== 'efetivado'}
          transferencia={transferencia}
          status={lancamento.status}
        />
      </span>
    </div>
  )
}

function Seletor<T extends string>({
  rotulo,
  valor,
  opcoes,
  aoMudar,
}: {
  rotulo: string
  valor: T
  opcoes: readonly (readonly [T, string])[]
  aoMudar(v: T): void
}) {
  return (
    <label className="flex items-center gap-6">
      <span className="sr-only">{rotulo}</span>
      <select
        className="rounded-1 border border-line-forte bg-paper px-8 py-2 text-sm"
        value={valor}
        onChange={(e) => aoMudar(e.target.value as T)}
      >
        {opcoes.map(([v, texto]) => (
          <option key={v} value={v}>
            {texto}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * O filtro de natureza olha o **sinal e o vínculo de transferência**, e não um
 * enum `tipo`. Inferir natureza de um enum ao lado do valor é o que a regra 6
 * proíbe: os dois podem discordar, e aí a tela mostra uma coisa e o total
 * soma outra.
 */
function filtrar(
  itens: readonly Lancamento[],
  natureza: 'todas' | 'receita' | 'despesa' | 'transferencia',
  estado: 'todos' | 'previsto' | 'pendente' | 'efetivado',
): Lancamento[] {
  return itens.filter((l) => {
    const ehTransferencia = l.transferGroupId !== null

    if (natureza === 'transferencia' && !ehTransferencia) return false
    if (natureza === 'receita' && (ehTransferencia || BigInt(l.valorCentavos) <= 0n)) return false
    if (natureza === 'despesa' && (ehTransferencia || BigInt(l.valorCentavos) >= 0n)) return false

    if (estado !== 'todos' && l.status !== estado) return false
    return true
  })
}

interface DiaDoExtrato {
  readonly chave: string
  readonly rotulo: string
  readonly itens: Lancamento[]
  /** Saldo ao fim daquele dia. Preenchido por `comSaldoAcumulado`. */
  readonly saldoAoFim: string
}

/**
 * O saldo ao fim de cada dia, acumulado a partir do saldo anterior do período.
 *
 * A lista vem do mais recente para o mais antigo — é a ordem em que se lê um
 * extrato —, mas o acúmulo tem de andar no sentido do tempo. Acumular na ordem
 * de exibição daria o saldo de trás para a frente, e o número do primeiro dia
 * do mês sairia igual ao do último.
 *
 * Só o que **se moveu** entra: um lançamento previsto ainda não mexeu no saldo,
 * e somá-lo aqui seria o eixo competência entrando no rodapé do eixo caixa.
 */
function comSaldoAcumulado(dias: DiaDoExtrato[], saldoAnterior: string): DiaDoExtrato[] {
  let acumulado = BigInt(saldoAnterior)

  const doMaisAntigo = [...dias].reverse().map((dia) => {
    for (const l of dia.itens) {
      if (l.status === 'efetivado') acumulado += BigInt(l.valorCentavos)
    }
    return { ...dia, saldoAoFim: acumulado.toString() }
  })

  return doMaisAntigo.reverse()
}

/**
 * Agrupa por **dia civil em São Paulo**, e não pelo dia do instante em UTC.
 *
 * Uma compra às 22h de 30 de setembro é 1º de outubro em UTC. Agrupar pelo
 * instante bruto a mandaria para o cabeçalho do dia seguinte — e, num extrato
 * de fim de mês, para fora do mês que o usuário está olhando.
 */
function agruparPorDia(itens: readonly Lancamento[]): DiaDoExtrato[] {
  const mapa = new Map<string, Lancamento[]>()

  for (const l of itens) {
    const chave = formatarDataCivil(dataCivilDe(new Date(l.postedAt)))
    const atual = mapa.get(chave)
    if (atual) atual.push(l)
    else mapa.set(chave, [l])
  }

  return [...mapa.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([chave, itens]) => ({ chave, rotulo: rotuloDoDia(chave), itens, saldoAoFim: '0' }))
}

const DIAS_DA_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'] as const
const MESES_CURTOS = [
  'jan',
  'fev',
  'mar',
  'abr',
  'mai',
  'jun',
  'jul',
  'ago',
  'set',
  'out',
  'nov',
  'dez',
] as const

function rotuloDoDia(chave: string): string {
  const [ano, mes, dia] = chave.split('-').map(Number)
  // `Date.UTC` e leitura em UTC: a data já é civil, e reinterpretá-la no fuso
  // do navegador a moveria de volta um dia.
  const d = new Date(Date.UTC(ano!, mes! - 1, dia!))
  return `${DIAS_DA_SEMANA[d.getUTCDay()]} ${dia} ${MESES_CURTOS[mes! - 1]}`
}

function diaCurto(iso: string): string {
  const c = dataCivilDe(new Date(iso))
  return `${String(c.dia).padStart(2, '0')}/${String(c.mes).padStart(2, '0')}`
}
