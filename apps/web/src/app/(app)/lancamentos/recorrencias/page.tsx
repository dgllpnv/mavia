'use client'

import type { Categoria, Conta, Recorrencia } from '@mavia/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useState, type FormEvent } from 'react'
import { api, chamar, ErroDaApi } from '../../../../api/cliente'
import { CampoDeValor } from '../../../../componentes/campo-de-valor'
import { Cartao, Vazio } from '../../../../componentes/cartao'
import { Interruptor } from '../../../../componentes/interruptor'
import { Modal } from '../../../../componentes/modal'
import { useEspaco } from '../../../../componentes/provedores'
import { Valor } from '../../../../componentes/valor'

/** Só o que esta tela precisa de um cartão: o suficiente para nomeá-lo. */
interface CartaoDoEspaco {
  readonly id: string
  readonly nome: string
}

/**
 * Recorrências — as regras que geram lançamentos repetidos.
 *
 * **Sub-rota do extrato, e não item de navegação.** As ocorrências de uma
 * recorrência *são* lançamentos e vivem no extrato como qualquer outro; o que
 * mora aqui é só a regra. Um oitavo item na barra colocaria a regra no mesmo
 * nível do dinheiro.
 *
 * A tela diz **quando é a próxima** ocorrência, que é a pergunta que a pessoa
 * tem ao abrir. E diz quantas já viraram lançamento — o número que revela, sem
 * explicação técnica, que a regra não é o lançamento.
 */
export default function Recorrencias() {
  const espaco = useEspaco()
  const fila = useQueryClient()
  const [criando, setCriando] = useState(false)

  const recorrencias = useQuery({
    queryKey: ['recorrencias', espaco.id],
    queryFn: () => chamar<{ itens: Recorrencia[] }>('/recorrencias', { tenantId: espaco.id }),
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

  const categorias = useQuery({
    queryKey: ['categorias', espaco.id],
    queryFn: () => api.categorias(espaco.id),
    staleTime: 5 * 60_000,
  })

  const pausar = useMutation({
    mutationFn: ({ id, pausada }: { id: string; pausada: boolean }) =>
      chamar(`/recorrencias/${id}`, { metodo: 'PATCH', tenantId: espaco.id, corpo: { pausada } }),
    onSuccess: () => {
      void fila.invalidateQueries({ queryKey: ['recorrencias'] })
      void fila.invalidateQueries({ queryKey: ['lancamentos'] })
    },
  })

  const itens = recorrencias.data?.itens ?? []
  const ondes = new Map<string, string>([
    ...(contas.data?.itens ?? []).map((c: Conta) => [c.id, c.nome] as const),
    ...(cartoes.data?.itens ?? []).map((c: CartaoDoEspaco) => [c.id, c.nome] as const),
  ])
  const nomeDaCategoria = new Map(
    (categorias.data?.itens ?? []).map((c: Categoria) => [c.id, c.nome]),
  )

  return (
    <>
      <p className="mb-16 text-sm text-ink-3">
        <Link href="/lancamentos" className="underline">
          ← lançamentos
        </Link>
      </p>

      <Cartao
        titulo="Recorrências"
        semPadding
        acoes={
          <button className="botao botao--primario" onClick={() => setCriando(true)}>
            + recorrência
          </button>
        }
      >
        {recorrencias.isPending && <p className="px-20 py-16 text-corpo text-ink-3">Carregando…</p>}

        {recorrencias.data && itens.length === 0 && (
          <div className="px-20 py-16">
            <Vazio
              acao={
                <button className="botao botao--primario" onClick={() => setCriando(true)}>
                  criar a primeira
                </button>
              }
            >
              Uma recorrência guarda a regra — aluguel todo dia 10, salário todo
              dia 5, assinatura anual — e gera os lançamentos por você. Editar a
              regra reposiciona o que ainda não aconteceu e não mexe no passado.
            </Vazio>
          </div>
        )}

        {itens.map((r) => (
          <div key={r.id} className="linha grid-cols-[1fr_auto] items-center">
            <span className="min-w-0">
              <span className="flex items-baseline gap-8">
                <span className={`truncate text-1 ${r.pausada ? 'text-ink-3' : ''}`}>
                  {r.descricao}
                </span>
                <Valor centavos={r.valorCentavos} />
              </span>
              <span className="mt-2 block truncate text-sm text-ink-3">
                {cadencia(r)} · {nomeDaCategoria.get(r.categoriaId) ?? '—'} ·{' '}
                {ondes.get(r.contaId ?? r.cartaoId ?? '') ?? '—'}
                {' · '}
                {r.pausada
                  ? 'pausada'
                  : r.proximaOcorrencia
                    ? `próxima em ${diaMesAno(r.proximaOcorrencia)}`
                    : 'encerrada'}
                {` · ${r.materializadas} lançamento(s) gerado(s)`}
              </span>
            </span>

            <span className="flex items-center gap-12">
              <Interruptor
                ligado={!r.pausada}
                aoMudar={(ligado) => pausar.mutate({ id: r.id, pausada: !ligado })}
                rotulo="ativa"
                rotuloAcessivel={`Ativa: ${r.descricao}`}
              />
              <EditarRecorrencia recorrencia={r} tenantId={espaco.id} />
            </span>
          </div>
        ))}
      </Cartao>

      <p className="mt-16 max-w-[70ch] text-sm text-ink-3">
        Os lançamentos gerados nascem <strong>pendentes</strong>: a recorrência
        prevê o compromisso, e quem diz que o dinheiro saiu é você, ao
        compensá-lo. Pausar interrompe a regra sem apagar o que ela já gerou.
      </p>

      {criando && (
        <FormularioDeRecorrencia
          tenantId={espaco.id}
          contas={contas.data?.itens ?? []}
          cartoes={cartoes.data?.itens ?? []}
          categorias={categorias.data?.itens ?? []}
          aoFechar={() => setCriando(false)}
        />
      )}
    </>
  )
}

function EditarRecorrencia({
  recorrencia,
  tenantId,
}: {
  recorrencia: Recorrencia
  tenantId: string
}) {
  const [aberto, setAberto] = useState(false)

  return (
    <>
      <button className="botao botao--discreto" onClick={() => setAberto(true)}>
        editar
      </button>
      {aberto && (
        <FormularioDeRecorrencia
          tenantId={tenantId}
          contas={[]}
          cartoes={[]}
          categorias={[]}
          existente={recorrencia}
          aoFechar={() => setAberto(false)}
        />
      )}
    </>
  )
}

function FormularioDeRecorrencia({
  tenantId,
  contas,
  cartoes,
  categorias,
  existente,
  aoFechar,
}: {
  tenantId: string
  contas: readonly Conta[]
  cartoes: readonly CartaoDoEspaco[]
  categorias: readonly Categoria[]
  existente?: Recorrencia
  aoFechar(): void
}) {
  const fila = useQueryClient()

  const magnitudeInicial = existente
    ? (BigInt(existente.valorCentavos) < 0n
        ? -BigInt(existente.valorCentavos)
        : BigInt(existente.valorCentavos)
      ).toString()
    : '0'

  const [descricao, setDescricao] = useState(existente?.descricao ?? '')
  const [centavos, setCentavos] = useState(magnitudeInicial)
  const [diaDoMes, setDiaDoMes] = useState(String(existente?.diaDoMes ?? 10))
  const [intervalo, setIntervalo] = useState(String(existente?.intervaloMeses ?? 1))
  const [categoriaId, setCategoriaId] = useState('')
  const [onde, setOnde] = useState('')
  const [fim, setFim] = useState(existente?.fim ?? '')
  const [erro, setErro] = useState<string | null>(null)

  // As analíticas, na ordem em que se procura: despesa primeiro, que é a
  // esmagadora maioria das recorrências.
  const disponiveis = categorias.filter((c) => c.analitica && !c.arquivada)
  const categoria = categorias.find((c) => c.id === (categoriaId || disponiveis[0]?.id))
  const ehCartao = onde.startsWith('cartao:')

  const salvar = useMutation({
    mutationFn: () => {
      const m = BigInt(centavos || '0')
      if (m === 0n) throw new ErroDaApi(400, 'Informe o valor.')

      if (existente) {
        // O sinal do valor já existente não muda de direção numa edição: a
        // categoria continua a mesma, e é ela que manda no sinal.
        const sinal = BigInt(existente.valorCentavos) < 0n ? -1n : 1n
        return chamar(`/recorrencias/${existente.id}`, {
          metodo: 'PATCH',
          tenantId,
          corpo: {
            descricao,
            valorCentavos: (m * sinal).toString(),
            diaDoMes: Number(diaDoMes),
            intervaloMeses: Number(intervalo),
            fim: fim === '' ? null : fim,
          },
        })
      }

      if (!categoria) throw new ErroDaApi(400, 'Escolha a categoria.')
      if (onde === '') throw new ErroDaApi(400, 'Escolha a conta ou o cartão.')

      // O sinal vem da **natureza da categoria**, e não de um campo: um campo
      // deixaria o usuário criar uma despesa positiva, que o banco recusaria
      // depois com uma mensagem que ele não pediu.
      const valorCentavos = (categoria.natureza === 'despesa' ? -m : m).toString()
      const id = onde.slice(onde.indexOf(':') + 1)

      return chamar('/recorrencias', {
        metodo: 'POST',
        tenantId,
        corpo: {
          ...(ehCartao ? { cartaoId: id } : { contaId: id }),
          categoriaId: categoria.id,
          valorCentavos,
          descricao,
          diaDoMes: Number(diaDoMes),
          intervaloMeses: Number(intervalo),
          inicio: new Date().toISOString().slice(0, 7),
          ...(fim === '' ? {} : { fim }),
        },
      })
    },
    onSuccess() {
      void fila.invalidateQueries({ queryKey: ['recorrencias'] })
      void fila.invalidateQueries({ queryKey: ['lancamentos'] })
      aoFechar()
    },
  })

  const excluir = useMutation({
    mutationFn: () =>
      chamar(`/recorrencias/${existente?.id}`, { metodo: 'DELETE', tenantId }),
    onSuccess() {
      void fila.invalidateQueries({ queryKey: ['recorrencias'] })
      void fila.invalidateQueries({ queryKey: ['lancamentos'] })
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
      titulo={existente ? 'Editar recorrência' : 'Nova recorrência'}
      largura={520}
      aoFechar={aoFechar}
    >
      <form className="mt-24 flex flex-col gap-20" onSubmit={(e) => void enviar(e)}>
        <label className="flex flex-col gap-6">
          <span className="rotulo">Descrição</span>
          <input
            className="campo"
            value={descricao}
            onChange={(e) => setDescricao(e.target.value)}
            placeholder="Aluguel, salário, assinatura…"
            maxLength={140}
            autoFocus
          />
        </label>

        <CampoDeValor centavos={centavos} aoMudar={setCentavos} rotulo="Valor" />

        {!existente && (
          <>
            <label className="flex flex-col gap-6">
              <span className="rotulo">Categoria</span>
              <select
                className="campo"
                value={categoriaId || (disponiveis[0]?.id ?? '')}
                onChange={(e) => setCategoriaId(e.target.value)}
              >
                {disponiveis.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nome}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-6">
              <span className="rotulo">Onde</span>
              <select className="campo" value={onde} onChange={(e) => setOnde(e.target.value)}>
                <option value="">Escolha…</option>
                {contas.map((c) => (
                  <option key={c.id} value={`conta:${c.id}`}>
                    {c.nome}
                  </option>
                ))}
                {cartoes.map((c) => (
                  <option key={c.id} value={`cartao:${c.id}`}>
                    {c.nome} (cartão)
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        <div className="grid grid-cols-2 gap-12">
          <label className="flex flex-col gap-6">
            <span className="rotulo">Dia do mês</span>
            <input
              className="campo"
              type="number"
              min={1}
              max={31}
              value={diaDoMes}
              onChange={(e) => setDiaDoMes(e.target.value)}
            />
          </label>

          <label className="flex flex-col gap-6">
            <span className="rotulo">A cada</span>
            <select
              className="campo"
              value={intervalo}
              onChange={(e) => setIntervalo(e.target.value)}
            >
              <option value="1">mês</option>
              <option value="2">2 meses</option>
              <option value="3">3 meses</option>
              <option value="6">6 meses</option>
              <option value="12">ano</option>
            </select>
          </label>
        </div>

        {Number(diaDoMes) > 28 && (
          <p className="text-sm text-ink-3">
            Em meses mais curtos a data cai no último dia — dia 31 vira 28 de
            fevereiro e volta a 31 em março. Nunca pula um mês e nunca dá dois ao
            mês seguinte.
          </p>
        )}

        <label className="flex flex-col gap-6">
          <span className="rotulo">Até (opcional)</span>
          <input
            className="campo"
            type="month"
            value={fim}
            onChange={(e) => setFim(e.target.value)}
          />
        </label>

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

function cadencia(r: Recorrencia): string {
  const dia = `dia ${r.diaDoMes}`
  if (r.intervaloMeses === 1) return `todo mês, ${dia}`
  if (r.intervaloMeses === 12) return `todo ano, ${dia}`
  return `a cada ${r.intervaloMeses} meses, ${dia}`
}

/** `AAAA-MM-DD` → `DD/MM`. A data já é civil; não passa por fuso. */
function diaMesAno(data: string): string {
  const [, mes, dia] = data.split('-')
  return `${dia}/${mes}`
}
