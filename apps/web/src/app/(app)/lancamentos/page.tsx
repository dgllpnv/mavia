'use client'

import type { Lancamento } from '@mavia/contracts'
import { competenciaDe, dataCivilDe, formatarDataCivil } from '@mavia/domain'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { api } from '../../../api/cliente'
import { montarDicionarios, type Dicionarios } from '../../../api/dicionarios'
import { mesAnterior, mesSeguinte, periodoDe } from '../../../api/periodo'
import { Cartao } from '../../../componentes/cartao'
import { DetalheDoLancamento } from '../../../componentes/detalhe-do-lancamento'
import { FormularioDeLancamento } from '../../../componentes/formulario-de-lancamento'
import { IconeDeCategoria } from '../../../componentes/icone-de-categoria'
import { useEspaco } from '../../../componentes/provedores'
import { Valor } from '../../../componentes/valor'

/**
 * Lançamentos — a tela central.
 *
 * Estrutura do Organizze (DP-31), que é a que os clientes já sabem ler:
 *
 * - um **card** com cabeçalho: título, navegador de período, ação de lançar;
 * - **barra de filtros** recolhida, que só se abre quando alguém quer filtrar;
 * - lista **agrupada por dia**, com o dia como cabeçalho discreto e o **saldo
 *   no dia** ao fim de cada grupo;
 * - **rodapé de resumo**, colapsado em duas linhas e expansível para o modelo
 *   realizado × previsto completo — o coração conceitual do produto.
 *
 * Onde corrigimos o Organizze: o filtro `Tipo` deles colapsa **três eixos
 * ortogonais** em treze opções lineares (teardown §8.5, item 4). Aqui são três
 * seletores independentes — natureza, estado e origem.
 */
export default function Lancamentos() {
  const espaco = useEspaco()
  const [mes, setMes] = useState(() => competenciaDe(new Date()))
  const [natureza, setNatureza] = useState<'todas' | 'receita' | 'despesa' | 'transferencia'>('todas')
  const [estado, setEstado] = useState<'todos' | 'previsto' | 'pendente' | 'efetivado'>('todos')
  const [origem, setOrigem] = useState<'todas' | 'parcelado' | 'importado' | 'digitado'>('todas')
  const [filtrosAbertos, setFiltrosAbertos] = useState(false)
  const [resumoAberto, setResumoAberto] = useState(false)
  const [lancando, setLancando] = useState(false)
  const [aberto, setAberto] = useState<Lancamento | null>(null)

  const periodo = periodoDe(mes.ano, mes.mes)

  const lista = useQuery({
    queryKey: ['lancamentos', espaco.id, periodo.janela],
    queryFn: () => api.lancamentos(espaco.id, periodo.janela),
  })

  const resumo = useQuery({
    queryKey: ['resumo', espaco.id, periodo.janela, 'caixa'],
    queryFn: () => api.resumo(espaco.id, periodo.janela, 'caixa'),
  })

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

  const cartoes = useQuery({
    queryKey: ['cartoes', espaco.id],
    queryFn: () => api.cartoes(espaco.id),
    staleTime: 5 * 60_000,
  })

  const dicionarios = useMemo(
    () => montarDicionarios(categorias.data?.itens ?? [], contas.data?.itens ?? []),
    [categorias.data, contas.data],
  )

  /**
   * Há filtro ativo?
   *
   * Importa porque o **saldo no dia** e o rodapé só significam alguma coisa
   * sobre o mês inteiro. Acumular sobre um subconjunto dá um número que parece
   * saldo e não é — e um número que parece certo e está errado é pior do que
   * nenhum número.
   */
  const filtrado = natureza !== 'todas' || estado !== 'todos' || origem !== 'todas'

  const dias = useMemo(
    () =>
      comSaldoAcumulado(
        agruparPorDia(filtrar(lista.data?.itens ?? [], natureza, estado, origem)),
        resumo.data?.saldoAnterior ?? '0',
      ),
    [lista.data, natureza, estado, origem, resumo.data],
  )

  const visiveis = dias.reduce((n, d) => n + d.itens.length, 0)

  return (
    <>
      <Cartao
        titulo="Lançamentos"
        semPadding
        acoes={
          <>
            <button className="botao" onClick={() => setMes(mesAnterior(mes))} aria-label="Mês anterior">
              ‹
            </button>
            <span className="min-w-[15ch] text-center text-corpo">{periodo.rotulo}</span>
            <button className="botao" onClick={() => setMes(mesSeguinte(mes))} aria-label="Mês seguinte">
              ›
            </button>
            <button className="botao botao--primario" onClick={() => setLancando(true)}>
              lançar
            </button>
          </>
        }
      >
        {/* ---------------------------------------------------------------
            Barra de filtros — recolhida por padrão, como no Organizze
            --------------------------------------------------------------- */}
        <div className="flex flex-wrap items-center gap-12 border-b border-line px-20 py-12">
          <button
            className="botao botao--discreto"
            aria-expanded={filtrosAbertos}
            onClick={() => setFiltrosAbertos((v) => !v)}
          >
            {filtrosAbertos ? 'ocultar filtros' : 'filtrar por…'}
          </button>

          {filtrosAbertos && (
            <>
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
              <Seletor<typeof origem>
                rotulo="Origem"
                valor={origem}
                opcoes={[
                  ['todas', 'origem: todas'],
                  ['digitado', 'digitados'],
                  ['parcelado', 'parcelados'],
                  ['importado', 'importados'],
                ]}
                aoMudar={setOrigem}
              />
            </>
          )}

          <span className="ml-auto text-sm text-ink-3">
            {filtrado
              ? `${visiveis} de ${lista.data?.itens.length ?? 0} lançamentos`
              : `${visiveis} lançamentos`}
          </span>
        </div>

        {lista.isPending && <p className="px-20 py-16 text-corpo text-ink-3">Carregando…</p>}

        {lista.data && dias.length === 0 && (
          <p className="px-20 py-16 text-corpo text-ink-3">
            Nenhum lançamento em {periodo.rotulo}
            {filtrado ? ' com estes filtros.' : '.'}
          </p>
        )}

        {dias.map((dia) => (
          <div key={dia.chave}>
            <div className="cabecalho-dia">
              <span className="rotulo">{dia.rotulo}</span>
              {/* O saldo do dia vem no próprio cabeçalho do grupo, e não numa
                  linha extra: é o mesmo dado com 32px a menos por dia.
                  Com filtro ativo ele some — acumular sobre um subconjunto
                  produz um número que parece saldo e não é. */}
              {!filtrado && (
                <span className="text-sm text-ink-3">
                  saldo no dia <Valor centavos={dia.saldoAoFim} saldo />
                </span>
              )}
            </div>

            {dia.itens.map((l) => (
              <LinhaDoExtrato
                key={l.id}
                lancamento={l}
                dicionarios={dicionarios}
                aoAbrir={() => setAberto(l)}
              />
            ))}
          </div>
        ))}
      </Cartao>

      {/* -----------------------------------------------------------------
          Rodapé de resumo — colapsado em duas linhas, expansível para o
          modelo realizado × previsto completo
          ----------------------------------------------------------------- */}
      {resumo.data && (
        <section
          role="region"
          aria-label="Resumo do mês"
          className="cartao sticky bottom-0 z-10 mt-24"
        >
          <div className="flex flex-wrap items-center gap-24 px-20 py-12">
            <div>
              <p className="rotulo">Saldo</p>
              <p className="font-numero text-3 font-semibold">
                <Valor centavos={resumo.data.saldo} saldo />
              </p>
            </div>
            <div>
              <p className="rotulo">Previsto</p>
              <p className="font-numero text-3">
                <Valor centavos={resumo.data.projetado} saldo previsto />
              </p>
            </div>

            {filtrado && (
              <span className="text-sm text-atencao">totais do mês inteiro, não do filtro</span>
            )}

            <button
              className="botao botao--discreto ml-auto"
              aria-expanded={resumoAberto}
              onClick={() => setResumoAberto((v) => !v)}
            >
              {resumoAberto ? 'ocultar detalhe' : 'ver detalhe'}
            </button>
          </div>

          {resumoAberto && (
            <dl className="grid grid-cols-2 gap-x-24 border-t border-line px-20 py-12 sm:grid-cols-3">
              <LinhaDoResumo rotulo="Saldo anterior" centavos={resumo.data.saldoAnterior} saldo />
              <LinhaDoResumo rotulo="Receita realizada" centavos={resumo.data.receitaRealizada} />
              <LinhaDoResumo
                rotulo="Receita prevista"
                centavos={resumo.data.receitaPrevista}
                previsto
              />
              <LinhaDoResumo rotulo="Despesa realizada" centavos={resumo.data.despesaRealizada} />
              <LinhaDoResumo
                rotulo="Despesa prevista"
                centavos={resumo.data.despesaPrevista}
                previsto
              />
              {/* Transferência tem linha própria e neutra: ela não é receita nem
                  despesa, e somá-la a qualquer um dos dois duplica o gasto. */}
              <LinhaDoResumo
                rotulo="Transferências"
                centavos={resumo.data.transferenciaLiquidaRealizada}
                transferencia
              />
            </dl>
          )}
        </section>
      )}

      {aberto && (
        <DetalheDoLancamento
          tenantId={espaco.id}
          lancamento={aberto}
          nomeDaCategoria={dicionarios.nomeDaCategoria(aberto.categoriaId)}
          nomeDaConta={dicionarios.nomeDaConta(aberto.contaId)}
          aoFechar={() => setAberto(null)}
        />
      )}

      {lancando && (
        <FormularioDeLancamento
          tenantId={espaco.id}
          contas={contas.data?.itens ?? []}
          cartoes={cartoes.data?.itens ?? []}
          categorias={categorias.data?.itens ?? []}
          aoFechar={() => setLancando(false)}
        />
      )}
    </>
  )
}

function LinhaDoResumo({
  rotulo,
  centavos,
  previsto = false,
  transferencia = false,
  saldo = false,
}: {
  rotulo: string
  centavos: string
  previsto?: boolean
  transferencia?: boolean
  saldo?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-12 py-4">
      <dt className="text-sm text-ink-3">{rotulo}</dt>
      <dd className="text-1">
        <Valor
          centavos={centavos}
          previsto={previsto}
          transferencia={transferencia}
          saldo={saldo}
        />
      </dd>
    </div>
  )
}

/**
 * A linha, em 56px, com o ícone de categoria em círculo.
 *
 * O glifo de estado fica à direita e é **clicável no Organizze** — alterna pago
 * ali mesmo. Aqui ele ainda é indicador; alternar exige a rota de edição de
 * lançamento, que não existe (a listagem é de leitura, e o detalhe é onde se
 * age). Está registrado como o próximo passo natural desta tela.
 */
function LinhaDoExtrato({
  lancamento,
  dicionarios,
  aoAbrir,
}: {
  lancamento: Lancamento
  dicionarios: Dicionarios
  aoAbrir(): void
}) {
  const transferencia = lancamento.transferGroupId !== null
  const cor = dicionarios.corDaCategoriaPorId(lancamento.categoriaId)
  const parcela =
    lancamento.installmentNumero !== null && lancamento.installmentTotal !== null
      ? `${lancamento.installmentNumero}/${lancamento.installmentTotal}`
      : null

  return (
    <button
      type="button"
      onClick={aoAbrir}
      className="linha w-full grid-cols-[auto_1fr_auto_auto] text-left"
    >
      <IconeDeCategoria
        nome={transferencia ? 'transferência' : dicionarios.nomeDaCategoria(lancamento.categoriaId)}
        cor={cor ?? 'var(--dado-outros)'}
        transferencia={transferencia}
      />

      <span className="min-w-0">
        <span className="flex items-baseline gap-8">
          <span className="truncate text-1">{lancamento.descricao}</span>
          {parcela && <span className="shrink-0 text-sm text-ink-3">{parcela}</span>}
        </span>
        <span className="block truncate text-sm text-ink-3">
          {transferencia ? 'transferência' : dicionarios.nomeDaCategoria(lancamento.categoriaId)}
          {' · '}
          {dicionarios.nomeDaConta(lancamento.contaId)}
        </span>
      </span>

      <span className="text-right">
        <span className="block text-1">
          <Valor
            centavos={lancamento.valorCentavos}
            previsto={lancamento.status !== 'efetivado'}
            transferencia={transferencia}
            status={lancamento.status}
          />
        </span>
        {lancamento.status !== 'efetivado' && (
          <span className="block text-sm text-ink-3">
            {lancamento.status === 'pendente' ? 'em atraso' : 'previsto'}
          </span>
        )}
      </span>

      <span
        className={`text-sm ${lancamento.status === 'efetivado' ? 'text-receita' : 'text-ink-4'}`}
        title={transferencia ? 'transferência' : lancamento.status}
        aria-label={transferencia ? 'transferência' : lancamento.status}
      >
        {lancamento.status === 'efetivado' ? '✓' : '○'}
      </span>
    </button>
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
        className="rounded-2 border border-line-forte bg-card px-8 py-4 text-sm"
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
 * proíbe: os dois podem discordar, e aí a tela mostra uma coisa e o total soma
 * outra.
 */
function filtrar(
  itens: readonly Lancamento[],
  natureza: 'todas' | 'receita' | 'despesa' | 'transferencia',
  estado: 'todos' | 'previsto' | 'pendente' | 'efetivado',
  origem: 'todas' | 'parcelado' | 'importado' | 'digitado',
): Lancamento[] {
  return itens.filter((l) => {
    const ehTransferencia = l.transferGroupId !== null

    if (natureza === 'transferencia' && !ehTransferencia) return false
    if (natureza === 'receita' && (ehTransferencia || BigInt(l.valorCentavos) <= 0n)) return false
    if (natureza === 'despesa' && (ehTransferencia || BigInt(l.valorCentavos) >= 0n)) return false

    if (estado !== 'todos' && l.status !== estado) return false

    // Parcelado pelo **grupo**, e não pela origem: a origem diz de onde o
    // lançamento veio, e o grupo diz se ele tem irmãos em faturas futuras — que
    // é o que a pessoa procura quando filtra por "parcelados".
    if (origem === 'parcelado' && l.installmentGroupId === null) return false
    if (origem === 'importado' && l.origem !== 'importado') return false
    if (origem === 'digitado' && l.origem !== 'manual') return false

    return true
  })
}

interface DiaDoExtrato {
  readonly chave: string
  readonly rotulo: string
  readonly itens: Lancamento[]
  readonly saldoAoFim: string
}

/**
 * O saldo ao fim de cada dia, acumulado a partir do saldo anterior do período.
 *
 * A lista vem do mais recente para o mais antigo — é a ordem em que se lê um
 * extrato —, mas o acúmulo tem de andar no sentido do tempo. Acumular na ordem
 * de exibição daria o saldo de trás para a frente.
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
  // `Date.UTC` e leitura em UTC: a data já é civil, e reinterpretá-la no fuso do
  // navegador a moveria de volta um dia.
  const d = new Date(Date.UTC(ano!, mes! - 1, dia!))
  return `${DIAS_DA_SEMANA[d.getUTCDay()]}, ${dia} de ${MESES_CURTOS[mes! - 1]}`
}
