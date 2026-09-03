'use client'

import { competenciaDe } from '@mavia/domain'
import { corDaCategoria } from '@mavia/ui'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { chamar } from '../../../api/cliente'
import { mesAnterior, mesSeguinte, periodoDe } from '../../../api/periodo'
import { Cartao, Vazio } from '../../../componentes/cartao'
import { useEspaco } from '../../../componentes/provedores'
import { Valor } from '../../../componentes/valor'

/**
 * Relatórios.
 *
 * ## O seletor de base no cabeçalho, e por que ele fica visível
 *
 * "Quanto gastei em março" tem três respostas certas, e elas diferem em
 * centenas de reais para quem parcela. Um relatório que escolhe uma delas em
 * silêncio faz o usuário comparar dois números que respondem perguntas
 * diferentes — e concluir que um deles está errado.
 *
 * O seletor fica no cabeçalho, sempre visível, e a explicação de cada base fica
 * junto dele. É o oposto de esconder num menu de configuração: a escolha é
 * parte da pergunta, não uma preferência.
 *
 * ## Gráficos desenhados à mão
 *
 * SVG direto, sem biblioteca. Não é economia de dependência: uma biblioteca de
 * gráfico traz a estética dela — gradiente, sombra, animação de entrada — e a
 * direção de design proíbe as três. Barra e coluna com algarismo tabular ao
 * lado é o que responde a pergunta.
 */

type Base = 'data_compra' | 'data_parcela' | 'data_fatura'

const BASES: readonly { valor: Base; rotulo: string; explica: string }[] = [
  {
    valor: 'data_compra',
    rotulo: 'data da compra',
    explica: 'Quanto você decidiu gastar no mês. A compra parcelada aparece inteira.',
  },
  {
    valor: 'data_parcela',
    rotulo: 'data da parcela',
    explica: 'Quanto do mês pertence ao mês. Cada parcela no seu próprio mês.',
  },
  {
    valor: 'data_fatura',
    rotulo: 'data da fatura',
    explica: 'Quanto sai do bolso no mês, pelo vencimento da fatura.',
  },
]

interface Fatia {
  readonly categoriaId: string
  readonly nome: string
  readonly totalCentavos: string
  readonly participacaoBp: number
}

interface Mes {
  readonly competencia: string
  readonly receitaCentavos: string
  readonly despesaCentavos: string
}

export default function Relatorios() {
  const espaco = useEspaco()
  const [mes, setMes] = useState(() => competenciaDe(new Date()))
  const [base, setBase] = useState<Base>('data_parcela')

  const periodo = periodoDe(mes.ano, mes.mes)
  const competencia = `${mes.ano}-${String(mes.mes).padStart(2, '0')}`
  const anterior = mesAnterior(mes)
  const competenciaAnterior = `${anterior.ano}-${String(anterior.mes).padStart(2, '0')}`

  const porCategoria = useQuery({
    queryKey: ['relatorio-categorias', espaco.id, competencia, base],
    queryFn: () =>
      chamar<{ base: Base; despesas: Fatia[]; receitas: Fatia[] }>(
        `/relatorios/por-categoria?competencia=${competencia}&base=${base}`,
        { tenantId: espaco.id },
      ),
  })

  const evolucao = useQuery({
    queryKey: ['relatorio-evolucao', espaco.id, competencia, base],
    queryFn: () =>
      chamar<{ meses: Mes[] }>(`/relatorios/evolucao?ate=${competencia}&meses=12&base=${base}`, {
        tenantId: espaco.id,
      }),
  })

  const comparacao = useQuery({
    queryKey: ['relatorio-comparacao', espaco.id, competencia, base],
    queryFn: () =>
      chamar<{ variacao: { categoriaId: string; nome: string; deltaCentavos: string }[] }>(
        `/relatorios/comparacao?a=${competenciaAnterior}&b=${competencia}&base=${base}`,
        { tenantId: espaco.id },
      ),
  })

  const explicacao = BASES.find((b) => b.valor === base)!

  return (
    <>
      <div className="flex flex-wrap items-center gap-16">
        <div className="flex items-center gap-8">
          <button
            className="botao"
            onClick={() => setMes(mesAnterior(mes))}
            aria-label="Mês anterior"
          >
            ‹
          </button>
          <span className="min-w-[15ch] text-center font-numero text-2 font-semibold">
            {periodo.rotulo}
          </span>
          <button
            className="botao"
            onClick={() => setMes(mesSeguinte(mes))}
            aria-label="Mês seguinte"
          >
            ›
          </button>
        </div>

        <label className="ml-auto flex items-center gap-8">
          <span className="rotulo">Contar pela</span>
          <select
            className="campo w-auto"
            value={base}
            onChange={(e) => setBase(e.target.value as Base)}
          >
            {BASES.map((b) => (
              <option key={b.valor} value={b.valor}>
                {b.rotulo}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="mt-8 max-w-[70ch] text-sm text-ink-3">{explicacao.explica}</p>

      <div className="mt-24 grid gap-24 lg:grid-cols-2">
        <Cartao titulo="Onde o dinheiro foi">
          {porCategoria.isPending ? (
            <p className="text-corpo text-ink-3">Carregando…</p>
          ) : (porCategoria.data?.despesas.length ?? 0) === 0 ? (
            <Vazio>Nenhuma despesa neste mês, nesta contagem.</Vazio>
          ) : (
            <Barras fatias={porCategoria.data!.despesas} />
          )}
        </Cartao>

        <Cartao titulo="De onde ele veio">
          {(porCategoria.data?.receitas.length ?? 0) === 0 ? (
            <Vazio>Nenhuma receita neste mês.</Vazio>
          ) : (
            <Barras fatias={porCategoria.data!.receitas} />
          )}
        </Cartao>
      </div>

      <Cartao titulo="Doze meses" className="mt-24">
        {evolucao.data ? <Colunas meses={evolucao.data.meses} /> : <p className="text-ink-3">Carregando…</p>}
      </Cartao>

      <Cartao titulo={`Comparado com ${periodoDe(anterior.ano, anterior.mes).rotulo}`} className="mt-24" semPadding>
        {(comparacao.data?.variacao.length ?? 0) === 0 ? (
          <div className="px-20 py-16">
            <Vazio>Sem despesa nos dois meses para comparar.</Vazio>
          </div>
        ) : (
          comparacao.data!.variacao.map((v) => {
            const delta = BigInt(v.deltaCentavos)
            if (delta === 0n) return null
            return (
              <div key={v.categoriaId} className="linha grid-cols-[1fr_auto] items-center">
                <span className="truncate text-1">{v.nome}</span>
                <span className="text-right">
                  {/* Despesa é negativa: delta negativo é gasto **maior**. A
                      palavra evita a leitura errada do sinal. */}
                  <span className="block text-sm text-ink-3">
                    {delta < 0n ? 'gastou mais' : 'gastou menos'}
                  </span>
                  {/* `saldo`: o delta é **magnitude**, não movimento. Sem
                      isso ele sai verde com "+" ao lado de "gastou mais" — a
                      tela se contradizendo na mesma linha. */}
                  <Valor centavos={(delta < 0n ? -delta : delta).toString()} saldo />
                </span>
              </div>
            )
          })
        )}
      </Cartao>

      <p className="mt-24 max-w-[70ch] text-sm text-ink-3">
        Os dois meses são calculados pelo servidor, com a <strong>mesma</strong>{' '}
        base e a mesma fronteira. Comparar períodos com bases diferentes produz
        uma variação que ninguém teve.
      </p>

      <Cartao titulo="Levar seus dados" className="mt-24">
        <p className="max-w-[70ch] text-corpo text-ink-2">
          Baixa <strong>tudo</strong> do seu espaço num arquivo: contas,
          lançamentos, cartões, faturas, planejamentos, objetivos, recorrências,
          regras e importações. É o seu direito de portabilidade, e ele não
          depende de pedir nada a ninguém.
        </p>
        <p className="mt-12 max-w-[70ch] text-sm text-ink-3">
          O arquivo não contém senha nem token de acesso — isso é material
          criptográfico, não dado seu, e exportá-lo transformaria o arquivo numa
          arma.
        </p>
        <button
          className="botao botao--primario mt-20"
          onClick={() => void baixarExportacao(espaco.id)}
        >
          baixar meus dados
        </button>
      </Cartao>
    </>
  )
}

/**
 * Barras horizontais.
 *
 * Horizontal e não pizza: nome de categoria cabe ao lado da barra e não cabe na
 * fatia, e comparar comprimento é mais fácil do que comparar ângulo — o que é
 * exatamente a tarefa aqui.
 */
function Barras({ fatias }: { fatias: readonly Fatia[] }) {
  const maior = Math.max(...fatias.map((f) => f.participacaoBp), 1)

  return (
    <ul className="flex flex-col gap-12">
      {fatias.map((f) => (
        <li key={f.categoriaId}>
          <span className="flex items-baseline justify-between gap-12">
            <span className="truncate text-1">{f.nome}</span>
            <span className="shrink-0">
              <Valor centavos={f.totalCentavos} />
              <span className="ml-8 font-numero text-sm text-ink-3">
                {(f.participacaoBp / 100).toLocaleString('pt-BR', {
                  minimumFractionDigits: 0,
                  maximumFractionDigits: 1,
                })}
                %
              </span>
            </span>
          </span>
          <span className="mt-6 block h-[6px] rounded-1 bg-surface-2" aria-hidden="true">
            <span
              className="block h-full rounded-1"
              style={{
                width: `${(f.participacaoBp / maior) * 100}%`,
                background: corDaCategoria(f.categoriaId),
              }}
            />
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Doze colunas, receita e despesa lado a lado.
 *
 * A escala é comum aos dois: escalas separadas fariam uma despesa de R$ 500
 * parecer do mesmo tamanho de uma receita de R$ 5.000, que é a mentira mais
 * comum dos gráficos de duas séries.
 */
function Colunas({ meses }: { meses: readonly Mes[] }) {
  if (meses.length === 0) return <Vazio>Sem movimento nos últimos meses.</Vazio>

  const magnitude = (c: string) => {
    const v = BigInt(c)
    return v < 0n ? -v : v
  }
  const teto = meses.reduce(
    (m, x) => {
      const r = magnitude(x.receitaCentavos)
      const d = magnitude(x.despesaCentavos)
      return r > m ? r : d > m ? d : m
    },
    1n,
  )

  const altura = (c: string) => Number((magnitude(c) * 100n) / teto)

  return (
    <div className="flex items-end gap-8 overflow-x-auto pb-8" style={{ minHeight: 180 }}>
      {meses.map((m) => (
        <div key={m.competencia} className="flex min-w-[52px] flex-1 flex-col items-center gap-6">
          <div className="flex h-[140px] w-full items-end justify-center gap-2">
            <span
              title={`Receita: ${m.receitaCentavos}`}
              className="w-[40%] rounded-1"
              style={{ height: `${altura(m.receitaCentavos)}%`, background: 'var(--receita)' }}
            />
            <span
              title={`Despesa: ${m.despesaCentavos}`}
              className="w-[40%] rounded-1"
              style={{ height: `${altura(m.despesaCentavos)}%`, background: 'var(--despesa)' }}
            />
          </div>
          <span className="font-numero text-[11px] text-ink-3">
            {m.competencia.slice(5)}/{m.competencia.slice(2, 4)}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Baixa a exportação como arquivo.
 *
 * Passa pelo cliente da API — e não por um `<a href>` direto — porque a rota
 * exige o access token em `Authorization`, e um link de navegação não o carrega.
 * A alternativa seria aceitar o token na query string, e token em URL vai para
 * log de servidor e histórico de navegador.
 */
async function baixarExportacao(tenantId: string): Promise<void> {
  const dados = await chamar<Record<string, unknown>>('/exportacao', { tenantId })

  const arquivo = new Blob([JSON.stringify(dados, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(arquivo)

  const link = document.createElement('a')
  link.href = url
  link.download = `mavia-${new Date().toISOString().slice(0, 10)}.json`
  link.click()

  URL.revokeObjectURL(url)
}
