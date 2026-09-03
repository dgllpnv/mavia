'use client'

import type { Categoria } from '@mavia/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useState } from 'react'
import { api, chamar, ErroDaApi } from '../../../../api/cliente'
import { Cartao, Vazio } from '../../../../componentes/cartao'
import { useEspaco } from '../../../../componentes/provedores'

/**
 * Regras de categorização.
 *
 * **Sub-rota de categorias**, e não item de navegação: a regra existe para
 * atribuir categoria, e sozinha ela não significa nada.
 *
 * A tela é franca sobre o limite do que o sistema faz: sem regra e sem
 * histórico, ele não classifica — e diz isso, em vez de inventar uma categoria
 * plausível. É o custo declarado de não haver modelo externo nem treinamento com
 * dado de cliente.
 */
export default function Regras() {
  const espaco = useEspaco()
  const fila = useQueryClient()
  const [erro, setErro] = useState<string | null>(null)

  const [padrao, setPadrao] = useState('')
  const [tipo, setTipo] = useState<'contem' | 'comeca_com' | 'igual'>('contem')
  const [categoriaId, setCategoriaId] = useState('')

  const regras = useQuery({
    queryKey: ['regras', espaco.id],
    queryFn: () => chamar<{ itens: Regra[] }>('/regras', { tenantId: espaco.id }),
  })

  const categorias = useQuery({
    queryKey: ['categorias', espaco.id],
    queryFn: () => api.categorias(espaco.id),
    staleTime: 5 * 60_000,
  })

  const disponiveis = (categorias.data?.itens ?? []).filter(
    (c: Categoria) => c.analitica && !c.arquivada,
  )
  const nomes = new Map(disponiveis.map((c: Categoria) => [c.id, c.nome]))
  const escolhida = categoriaId || disponiveis[0]?.id || ''

  const criar = useMutation({
    mutationFn: () =>
      chamar('/regras', {
        metodo: 'POST',
        tenantId: espaco.id,
        corpo: { padrao: padrao.trim(), tipo, categoriaId: escolhida },
      }),
    onSuccess() {
      setPadrao('')
      void fila.invalidateQueries({ queryKey: ['regras'] })
    },
    onError: (e) =>
      setErro(e instanceof ErroDaApi ? e.message : 'Não foi possível criar a regra.'),
  })

  const excluir = useMutation({
    mutationFn: (id: string) =>
      chamar(`/regras/${id}`, { metodo: 'DELETE', tenantId: espaco.id }),
    onSuccess: () => void fila.invalidateQueries({ queryKey: ['regras'] }),
  })

  const aplicar = useMutation({
    mutationFn: () =>
      chamar<{ classificados: number }>('/regras/aplicar', {
        metodo: 'POST',
        tenantId: espaco.id,
      }),
    onSuccess() {
      void fila.invalidateQueries({ queryKey: ['lancamentos'] })
    },
  })

  return (
    <>
      <p className="mb-16 text-sm text-ink-3">
        <Link href="/categorias" className="underline">
          ← categorias
        </Link>
      </p>

      <div className="grid gap-24 lg:grid-cols-2">
        <Cartao titulo="Nova regra">
          <label className="flex flex-col gap-6">
            <span className="rotulo">Quando a descrição</span>
            <select
              className="campo"
              value={tipo}
              onChange={(e) => setTipo(e.target.value as typeof tipo)}
            >
              <option value="contem">contém</option>
              <option value="comeca_com">começa com</option>
              <option value="igual">é exatamente</option>
            </select>
          </label>

          <label className="mt-16 flex flex-col gap-6">
            <span className="rotulo">O texto</span>
            <input
              className="campo"
              value={padrao}
              onChange={(e) => setPadrao(e.target.value)}
              placeholder="mercado, posto, farmácia…"
              maxLength={120}
            />
          </label>

          <label className="mt-16 flex flex-col gap-6">
            <span className="rotulo">Classificar como</span>
            <select
              className="campo"
              value={escolhida}
              onChange={(e) => setCategoriaId(e.target.value)}
            >
              {disponiveis.map((c: Categoria) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </label>

          <p className="mt-16 max-w-[52ch] text-sm text-ink-3">
            A comparação ignora números, acentos e pontuação: uma regra com
            "mercado" pega <span className="font-numero">MERCADO SÃO JOSÉ 0912</span>.
            Números não servem como padrão porque somem na comparação.
          </p>

          {erro && (
            <p role="alert" className="mt-16 text-corpo text-despesa">
              {erro}
            </p>
          )}

          <button
            className="botao botao--primario mt-20"
            onClick={() => {
              setErro(null)
              criar.mutate()
            }}
            disabled={padrao.trim().length < 2 || criar.isPending}
          >
            {criar.isPending ? 'criando…' : 'criar regra'}
          </button>
        </Cartao>

        <Cartao
          titulo="Como a Mavia classifica"
          rodape={
            <button
              className="botao botao--discreto"
              onClick={() => aplicar.mutate()}
              disabled={aplicar.isPending}
            >
              {aplicar.isPending ? 'aplicando…' : 'aplicar ao que está sem categoria'}
            </button>
          }
        >
          <ol className="flex flex-col gap-12 text-corpo text-ink-2">
            <li>
              <strong className="text-ink-1">Sua regra, primeiro.</strong> Você
              decidiu; o resto é inferência.
            </li>
            <li>
              <strong className="text-ink-1">Depois, o seu histórico.</strong> Se
              você já classificou o mesmo estabelecimento duas vezes na mesma
              categoria, a próxima vai para lá — e o lançamento diz quantas vezes
              foram.
            </li>
            <li>
              <strong className="text-ink-1">Se nenhum dos dois souber, fica em
              "A classificar".</strong> Sem palpite: um palpite errado num
              relatório é pior do que uma linha esperando você.
            </li>
          </ol>

          <p className="mt-20 max-w-[52ch] text-sm text-ink-3">
            Nada disso sai do seu espaço. Não há modelo externo, e o seu extrato
            não treina nada — nem para você, nem para ninguém.
          </p>

          {aplicar.data && (
            <p className="mt-16 text-corpo text-ink-2">
              {aplicar.data.classificados === 0
                ? 'Nada a classificar: nenhuma regra nem histórico alcançou o que está pendente.'
                : `${aplicar.data.classificados} lançamento(s) classificado(s).`}
            </p>
          )}
        </Cartao>
      </div>

      <Cartao titulo="Suas regras" className="mt-24" semPadding>
        {(regras.data?.itens.length ?? 0) === 0 ? (
          <div className="px-20 py-16">
            <Vazio>
              Nenhuma regra ainda. Enquanto não houver, a Mavia usa só o seu
              histórico — e ele começa a valer depois que você classificar o
              mesmo lugar duas vezes.
            </Vazio>
          </div>
        ) : (
          regras.data!.itens.map((r) => (
            <div key={r.id} className="linha grid-cols-[1fr_auto] items-center">
              <span className="min-w-0">
                <span className="block truncate text-1">
                  {ROTULO[r.tipo]} <strong>{r.padrao}</strong> →{' '}
                  {nomes.get(r.categoriaId) ?? 'categoria removida'}
                </span>
                <span className="mt-2 block text-sm text-ink-3">
                  prioridade {r.prioridade}
                </span>
              </span>
              <button className="botao botao--discreto" onClick={() => excluir.mutate(r.id)}>
                excluir
              </button>
            </div>
          ))
        )}
      </Cartao>
    </>
  )
}

const ROTULO = {
  contem: 'contém',
  comeca_com: 'começa com',
  igual: 'é exatamente',
} as const

interface Regra {
  readonly id: string
  readonly tipo: 'contem' | 'comeca_com' | 'igual'
  readonly padrao: string
  readonly categoriaId: string
  readonly prioridade: number
}
