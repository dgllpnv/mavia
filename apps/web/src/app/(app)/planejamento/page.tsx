'use client'

import type { Categoria, Planejamento } from '@mavia/contracts'
import { competenciaDe } from '@mavia/domain'
import { corDaCategoria } from '@mavia/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState, type FormEvent } from 'react'
import { api, chamar, ErroDaApi } from '../../../api/cliente'
import { mesAnterior, mesSeguinte, periodoDe } from '../../../api/periodo'
import { CampoDeValor } from '../../../componentes/campo-de-valor'
import { Cartao, Vazio } from '../../../componentes/cartao'
import { IconeDeCategoria } from '../../../componentes/icone-de-categoria'
import { Modal } from '../../../componentes/modal'
import { useEspaco } from '../../../componentes/provedores'
import { Valor } from '../../../componentes/valor'

/**
 * Planejamento — o teto de gastos e o piso de receitas do mês.
 *
 * No Organizze são **duas telas espelhadas**: "Limite de gastos" na navegação
 * de primeiro nível, e "Metas de receitas" enterrada em ⚙ → mais opções. O
 * teardown registra isso como inconsistência de arquitetura de informação
 * (§8.5, item 1) — é o mesmo mecanismo, em direções opostas.
 *
 * Aqui é **uma tela só**, com duas seções. O sinal do valor decide qual.
 *
 * O planejamento é **mensal e não perpétuo**, e é por isso que existe "copiar
 * do mês anterior": sem ela, todo mês começa do zero e a pessoa desiste no
 * segundo.
 */
export default function PlanejamentoDoMes() {
  const espaco = useEspaco()
  const fila = useQueryClient()
  const [mes, setMes] = useState(() => competenciaDe(new Date()))
  const [criando, setCriando] = useState<'teto' | 'piso' | null>(null)
  const [erro, setErro] = useState<string | null>(null)

  const periodo = periodoDe(mes.ano, mes.mes)
  const competencia = `${mes.ano}-${String(mes.mes).padStart(2, '0')}`
  const anterior = mesAnterior(mes)

  const planejamentos = useQuery({
    queryKey: ['planejamentos', espaco.id, competencia],
    queryFn: () => api.planejamentos(espaco.id, competencia),
  })

  const categorias = useQuery({
    queryKey: ['categorias', espaco.id],
    queryFn: () => api.categorias(espaco.id),
    staleTime: 5 * 60_000,
  })

  const copiar = useMutation({
    mutationFn: () =>
      chamar<{ copiados: number }>('/planejamentos/copiar', {
        metodo: 'POST',
        tenantId: espaco.id,
        corpo: {
          de: `${anterior.ano}-${String(anterior.mes).padStart(2, '0')}`,
          para: competencia,
        },
      }),
    onSuccess: () => void fila.invalidateQueries({ queryKey: ['planejamentos'] }),
    onError: (e) =>
      setErro(e instanceof ErroDaApi ? e.message : 'Não foi possível copiar o mês anterior.'),
  })

  const porNatureza = useMemo(() => {
    const itens = planejamentos.data?.itens ?? []
    return {
      teto: itens.filter((p) => p.natureza === 'teto'),
      piso: itens.filter((p) => p.natureza === 'piso'),
    }
  }, [planejamentos.data])

  const nomes = useMemo(
    () => new Map((categorias.data?.itens ?? []).map((c) => [c.id, c])),
    [categorias.data],
  )

  const vazio = (planejamentos.data?.itens.length ?? 0) === 0

  return (
    <>
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

        <div className="ml-auto flex flex-wrap items-center gap-8">
          <button
            className="botao botao--discreto"
            onClick={() => {
              setErro(null)
              copiar.mutate()
            }}
            disabled={copiar.isPending}
          >
            {copiar.isPending ? 'copiando…' : 'copiar do mês anterior'}
          </button>
          <button className="botao botao--primario" onClick={() => setCriando('teto')}>
            + planejamento
          </button>
        </div>
      </div>

      {erro && (
        <p role="alert" className="mt-16 text-corpo text-despesa">
          {erro}
        </p>
      )}

      {copiar.data && (
        <p className="mt-16 text-corpo text-ink-2">
          {copiar.data.copiados === 0
            ? 'Nada a copiar: tudo o que havia no mês anterior já existe aqui. Copiar de novo não duplica nem sobrescreve.'
            : `${copiar.data.copiados} planejamento(s) copiado(s) do mês anterior.`}
        </p>
      )}

      {planejamentos.isPending && <p className="mt-24 text-corpo text-ink-3">Carregando…</p>}

      {planejamentos.data && vazio && (
        <div className="mt-24 max-w-[700px]">
          <Cartao>
            <Vazio
              acao={
                <div className="flex gap-8">
                  <button className="botao botao--primario" onClick={() => setCriando('teto')}>
                    definir teto de gastos
                  </button>
                  <button
                    className="botao botao--discreto"
                    onClick={() => {
                      setErro(null)
                      copiar.mutate()
                    }}
                  >
                    copiar do mês anterior
                  </button>
                </div>
              }
            >
              Nenhum planejamento em {periodo.rotulo}. Um teto diz quanto você
              pretende gastar numa categoria; um piso, quanto pretende receber.
              O planejamento é mensal — por isso existe copiar do mês anterior.
            </Vazio>
          </Cartao>
        </div>
      )}

      {planejamentos.data && !vazio && (
        <div className="mt-24 grid gap-24 lg:grid-cols-2">
          <Secao
            titulo="Teto de gastos"
            total={planejamentos.data.totalPlanejado.teto}
            itens={porNatureza.teto}
            nomes={nomes}
            aoCriar={() => setCriando('teto')}
            tenantId={espaco.id}
          />
          <Secao
            titulo="Piso de receitas"
            total={planejamentos.data.totalPlanejado.piso}
            itens={porNatureza.piso}
            nomes={nomes}
            aoCriar={() => setCriando('piso')}
            tenantId={espaco.id}
          />
        </div>
      )}

      <p className="mt-24 max-w-[70ch] text-sm text-ink-3">
        Um teto de categoria dentro de um teto global é um sub-teto legítimo: o
        mesmo gasto conta nos dois. O <strong>total</strong> soma, em cada
        caminho, apenas o planejamento de nível mais alto — senão o mesmo
        dinheiro entraria duas vezes na conta.
      </p>

      {criando && (
        <FormularioDePlanejamento
          tenantId={espaco.id}
          competencia={competencia}
          natureza={criando}
          categorias={categorias.data?.itens ?? []}
          jaPlanejadas={new Set(
            (planejamentos.data?.itens ?? [])
              .filter((p) => p.natureza === criando)
              .map((p) => p.categoriaId ?? 'global'),
          )}
          aoFechar={() => setCriando(null)}
        />
      )}
    </>
  )
}

function Secao({
  titulo,
  total,
  itens,
  nomes,
  aoCriar,
  tenantId,
}: {
  titulo: string
  total: string
  itens: readonly Planejamento[]
  nomes: ReadonlyMap<string, Categoria>
  aoCriar(): void
  tenantId: string
}) {
  return (
    <Cartao
      titulo={titulo}
      semPadding
      acoes={
        <span className="font-numero text-2 font-semibold">
          <Valor centavos={total} />
        </span>
      }
      rodape={
        <button className="botao text-sm text-primaria" onClick={aoCriar}>
          + adicionar
        </button>
      }
    >
      {itens.length === 0 ? (
        <div className="px-20 py-8">
          <Vazio>Nada definido aqui neste mês.</Vazio>
        </div>
      ) : (
        itens.map((p) => (
          <LinhaDePlanejamento
            key={p.id}
            planejamento={p}
            categoria={p.categoriaId ? (nomes.get(p.categoriaId) ?? null) : null}
            tenantId={tenantId}
          />
        ))
      )}
    </Cartao>
  )
}

/**
 * A linha de um planejamento.
 *
 * A barra usa `consumoBp` **truncado em 100%** para a largura, e o número real
 * ao lado. Deixar a barra passar da caixa não informa nada que o número já não
 * diga, e um consumo negativo — mês cuja única linha na categoria é um estorno
 * — desenharia para fora da caixa pelo outro lado.
 */
function LinhaDePlanejamento({
  planejamento,
  categoria,
  tenantId,
}: {
  planejamento: Planejamento
  categoria: Categoria | null
  tenantId: string
}) {
  const fila = useQueryClient()
  const [editando, setEditando] = useState(false)

  const nome = categoria?.nome ?? 'Todas as categorias'
  const cor = categoria ? corDaCategoria(categoria.parentId ?? categoria.id) : 'var(--ink-3)'

  const largura = Math.min(100, Math.max(0, planejamento.consumoBp / 100))
  const estado = planejamento.estado

  // A palavra depende da natureza; o estado, não. Num piso não se estoura nada
  // — fica-se aquém.
  const rotulo =
    estado === 'dentro_do_planejado'
      ? planejamento.natureza === 'teto'
        ? 'dentro do teto'
        : 'acima do piso'
      : estado === 'no_planejado'
        ? 'exatamente no planejado'
        : planejamento.natureza === 'teto'
          ? 'estourou'
          : 'faltou'

  const corDaBarra =
    estado === 'fora_do_planejado' && planejamento.natureza === 'teto'
      ? 'var(--despesa)'
      : estado === 'fora_do_planejado'
        ? 'var(--atencao)'
        : cor

  return (
    <>
      <button
        type="button"
        onClick={() => setEditando(true)}
        className="linha w-full grid-cols-[auto_1fr_auto] text-left"
      >
        <IconeDeCategoria nome={nome} cor={cor} />

        <span className="min-w-0">
          <span className="flex items-baseline justify-between gap-12">
            <span className="truncate text-1">{nome}</span>
            <span className="shrink-0 text-sm text-ink-3">
              <Valor centavos={planejamento.realizadoCentavos} /> de{' '}
              <Valor centavos={planejamento.valorCentavos} />
            </span>
          </span>

          <span className="mt-6 block h-[6px] rounded-1 bg-surface-2" aria-hidden="true">
            <span
              className="block h-full rounded-1"
              style={{ width: `${largura}%`, background: corDaBarra }}
            />
          </span>
        </span>

        <span className="text-right">
          <span
            className={`block text-1 ${
              estado === 'fora_do_planejado' ? 'text-despesa' : 'text-ink-1'
            }`}
          >
            {/* O percentual vem do **mesmo** `consumoBp` que decide o alerta,
                dividido por 100. Formatá-lo a partir de outro número faria a
                tela anunciar 80% sem alerta, ou o alerta disparar antes. */}
            {(planejamento.consumoBp / 100).toLocaleString('pt-BR', {
              // Inteiro sai sem casas; o resto, com duas. `toFixed` daria
              // ponto decimal ao lado de valores com vírgula na mesma linha.
              minimumFractionDigits: planejamento.consumoBp % 100 === 0 ? 0 : 2,
              maximumFractionDigits: planejamento.consumoBp % 100 === 0 ? 0 : 2,
            })}
            %
          </span>
          <span className="block text-sm text-ink-3">{rotulo}</span>
        </span>
      </button>

      {editando && (
        <FormularioDePlanejamento
          tenantId={tenantId}
          competencia={planejamento.competencia}
          natureza={planejamento.natureza}
          categorias={[]}
          jaPlanejadas={new Set()}
          existente={planejamento}
          aoFechar={() => {
            setEditando(false)
            void fila.invalidateQueries({ queryKey: ['planejamentos'] })
          }}
        />
      )}
    </>
  )
}

function FormularioDePlanejamento({
  tenantId,
  competencia,
  natureza,
  categorias,
  jaPlanejadas,
  existente,
  aoFechar,
}: {
  tenantId: string
  competencia: string
  natureza: 'teto' | 'piso'
  categorias: readonly Categoria[]
  jaPlanejadas: ReadonlySet<string>
  existente?: Planejamento
  aoFechar(): void
}) {
  const fila = useQueryClient()

  const magnitude = existente
    ? (BigInt(existente.valorCentavos) < 0n
        ? -BigInt(existente.valorCentavos)
        : BigInt(existente.valorCentavos)
      ).toString()
    : '0'

  const [centavos, setCentavos] = useState(magnitude)
  const [escopo, setEscopo] = useState<string>(existente?.categoriaId ?? 'global')
  const [erro, setErro] = useState<string | null>(null)

  /**
   * As categorias que ainda cabem: da natureza certa, analíticas, não
   * arquivadas, e que ainda não têm planejamento desta natureza neste mês.
   *
   * Oferecer uma já planejada seria oferecer um 409 — e a pessoa acabaria
   * criando um segundo em vez de editar o primeiro.
   */
  const disponiveis = categorias.filter(
    (c) =>
      c.natureza === (natureza === 'teto' ? 'despesa' : 'receita') &&
      c.analitica &&
      !c.arquivada &&
      !jaPlanejadas.has(c.id),
  )

  const salvar = useMutation({
    mutationFn: () => {
      const m = BigInt(centavos)
      if (m === 0n) throw new ErroDaApi(400, 'Informe um valor.')

      // O sinal vem da natureza escolhida, e não de um campo: um "teto" com
      // valor positivo é uma contradição que alguém teria de resolver depois.
      const valorCentavos = (natureza === 'teto' ? -m : m).toString()

      if (existente) {
        return chamar(`/planejamentos/${existente.id}`, {
          metodo: 'PATCH',
          tenantId,
          corpo: { valorCentavos },
        })
      }

      return chamar('/planejamentos', {
        metodo: 'POST',
        tenantId,
        corpo: {
          competencia,
          valorCentavos,
          ...(escopo === 'global' ? {} : { categoriaId: escopo }),
        },
      })
    },
    onSuccess() {
      void fila.invalidateQueries({ queryKey: ['planejamentos'] })
      aoFechar()
    },
  })

  /**
   * Excluir é soft delete no servidor. Existe porque editar o valor não é
   * saída: quem criou um teto por engano ficava com uma linha que não queria e
   * sem caminho para removê-la — e o índice único de identidade impedia até
   * criar outro no lugar.
   */
  const excluir = useMutation({
    mutationFn: () =>
      chamar(`/planejamentos/${existente?.id}`, { metodo: 'DELETE', tenantId }),
    onSuccess() {
      void fila.invalidateQueries({ queryKey: ['planejamentos'] })
      aoFechar()
    },
  })

  async function enviar(e: FormEvent) {
    e.preventDefault()
    setErro(null)
    try {
      await salvar.mutateAsync()
    } catch (erro) {
      setErro(erro instanceof ErroDaApi ? erro.message : 'Não foi possível salvar.')
    }
  }

  return (
    <Modal
      titulo={
        existente
          ? 'Editar planejamento'
          : natureza === 'teto'
            ? 'Novo teto de gastos'
            : 'Novo piso de receitas'
      }
      subtitulo={
        natureza === 'teto'
          ? 'Quanto você pretende gastar neste mês.'
          : 'Quanto você pretende receber neste mês.'
      }
      largura={480}
      aoFechar={aoFechar}
    >
      <form className="mt-24 flex flex-col gap-20" onSubmit={(e) => void enviar(e)}>
        {!existente && (
          <label className="flex flex-col gap-6">
            <span className="rotulo">Escopo</span>
            <select className="campo" value={escopo} onChange={(e) => setEscopo(e.target.value)}>
              <option value="global">Todas as categorias</option>
              {disponiveis.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </label>
        )}

        <CampoDeValor centavos={centavos} aoMudar={setCentavos} rotulo="Valor" autoFocus />

        {escopo === 'global' && !existente && (
          <p className="text-sm text-ink-3">
            Um planejamento de todas as categorias agrega tudo daquela natureza.
            Ele convive com tetos de categoria — os menores viram sub-tetos, e o
            total continua sendo o dele.
          </p>
        )}

        {erro && (
          <p role="alert" className="text-corpo text-despesa">
            {erro}
          </p>
        )}

        <div className="flex items-center gap-12 border-t border-line pt-16">
          {existente && (
            <button
              type="button"
              className="botao botao--discreto text-despesa"
              onClick={() => void excluir.mutateAsync()}
            >
              excluir
            </button>
          )}
          <button className="botao ml-auto" type="button" onClick={aoFechar}>
            cancelar
          </button>
          <button className="botao botao--primario" type="submit" disabled={salvar.isPending}>
            {salvar.isPending ? 'salvando…' : 'salvar'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
