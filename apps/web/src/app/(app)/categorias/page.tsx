'use client'

import type { Categoria } from '@mavia/contracts'
import { corDaCategoria } from '@mavia/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState, type FormEvent } from 'react'
import { api, chamar, ErroDaApi } from '../../../api/cliente'
import { Cartao } from '../../../componentes/cartao'
import { IconeDeCategoria } from '../../../componentes/icone-de-categoria'
import { Modal } from '../../../componentes/modal'
import { useEspaco } from '../../../componentes/provedores'

/**
 * Categorias.
 *
 * A árvore tem **dois níveis**, e a tela mostra os dois de uma vez: mãe e
 * filhas na mesma lista, indentadas. Uma árvore de finanças pessoais tem
 * dezenas de nós, não milhares — esconder as filhas atrás de um chevron
 * economiza altura e custa a visão de conjunto, que é justamente o que a pessoa
 * veio conferir.
 *
 * A cor é a **da raiz**: as filhas de Alimentação compartilham a cor de
 * Alimentação, senão o relatório vira seis tons sem parentesco visível.
 *
 * Arquivadas ficam ao fim, apagadas, e não somem: elas dão nome ao lançamento
 * antigo, e uma lista que as esconde faz o usuário achar que perdeu a categoria.
 */
export default function Categorias() {
  const espaco = useEspaco()
  const fila = useQueryClient()
  const [criando, setCriando] = useState<{ parentId?: string } | null>(null)
  const [erro, setErro] = useState<string | null>(null)

  const categorias = useQuery({
    queryKey: ['categorias', espaco.id],
    queryFn: () => api.categorias(espaco.id),
  })

  const arquivar = useMutation({
    mutationFn: (id: string) =>
      chamar<void>(`/categorias/${id}`, { metodo: 'DELETE', tenantId: espaco.id }),
    onSuccess: () => void fila.invalidateQueries({ queryKey: ['categorias'] }),
    onError: (e) =>
      setErro(e instanceof ErroDaApi ? e.message : 'Não foi possível arquivar a categoria.'),
  })

  const arvore = useMemo(() => montarArvore(categorias.data?.itens ?? []), [categorias.data])

  return (
    <>
      <div className="flex items-baseline justify-between gap-24">
        <h1>Categorias</h1>
        <button className="botao botao--primario" onClick={() => setCriando({})}>
          + categoria
        </button>
      </div>

      {categorias.isPending && <p className="mt-24 text-corpo text-ink-3">Carregando…</p>}

      {erro && (
        <p role="alert" className="mt-16 text-corpo text-despesa">
          {erro}
        </p>
      )}

      <div className="mt-24 grid gap-24 lg:grid-cols-2">
        {(['despesa', 'receita'] as const).map((natureza) => (
          <Cartao
            key={natureza}
            titulo={natureza === 'despesa' ? 'Despesas' : 'Receitas'}
            semPadding
          >
            {arvore
              .filter((r) => r.raiz.natureza === natureza)
              .map(({ raiz, filhas }) => (
                <div key={raiz.id}>
                  <LinhaDeCategoria
                    categoria={raiz}
                    cor={corDaCategoria(raiz.id)}
                    aoCriarFilha={() => {
                      setErro(null)
                      setCriando({ parentId: raiz.id })
                    }}
                    aoArquivar={() => {
                      setErro(null)
                      arquivar.mutate(raiz.id)
                    }}
                  />
                  {filhas.map((f) => (
                    <LinhaDeCategoria
                      key={f.id}
                      categoria={f}
                      cor={corDaCategoria(raiz.id)}
                      filha
                      aoArquivar={() => {
                        setErro(null)
                        arquivar.mutate(f.id)
                      }}
                    />
                  ))}
                </div>
              ))}
          </Cartao>
        ))}
      </div>

      <p className="mt-32 max-w-[64ch] text-sm text-ink-3">
        Arquivar não apaga: a categoria sai do formulário e continua dando nome
        aos lançamentos antigos. Arquivar uma categoria-mãe arquiva as filhas
        junto — elas não existem sem ela.
      </p>

      {criando && (
        <FormularioDeCategoria
          tenantId={espaco.id}
          mae={arvore.find((r) => r.raiz.id === criando.parentId)?.raiz ?? null}
          aoFechar={() => setCriando(null)}
        />
      )}
    </>
  )
}

interface Ramo {
  readonly raiz: Categoria
  readonly filhas: Categoria[]
}

/**
 * Raízes primeiro, filhas sob a mãe, arquivadas ao fim de cada grupo.
 *
 * A ordem é do cliente porque a resposta é uma lista plana — e plana é a forma
 * certa de transportar: aninhar no servidor obrigaria a inventar uma estrutura
 * para cada consumidor, e o mobile precisa da mesma árvore com outra ordem.
 */
function montarArvore(itens: readonly Categoria[]): Ramo[] {
  const raizes = itens.filter((c) => c.parentId === null)
  const porMae = new Map<string, Categoria[]>()

  for (const c of itens) {
    if (!c.parentId) continue
    const atual = porMae.get(c.parentId)
    if (atual) atual.push(c)
    else porMae.set(c.parentId, [c])
  }

  const ordenar = (a: Categoria, b: Categoria) => {
    // Arquivada ao fim, e depois por nome: quem procura uma categoria viva não
    // deve tropeçar nas mortas no meio do caminho.
    if (a.arquivada !== b.arquivada) return a.arquivada ? 1 : -1
    return a.nome.localeCompare(b.nome, 'pt-BR')
  }

  return [...raizes].sort(ordenar).map((raiz) => ({
    raiz,
    filhas: (porMae.get(raiz.id) ?? []).sort(ordenar),
  }))
}

function LinhaDeCategoria({
  categoria,
  cor,
  filha = false,
  aoCriarFilha,
  aoArquivar,
}: {
  categoria: Categoria
  cor: string
  filha?: boolean
  aoCriarFilha?(): void
  aoArquivar(): void
}) {
  return (
    <div className="linha group grid-cols-[auto_1fr_auto]">
      {filha ? (
        // A filha não repete o círculo da mãe: ela recebe um recuo e um traço,
        // que é o que diz "pertence à de cima" sem duplicar a cor.
        <span className="flex w-[var(--icone-categoria)] justify-center text-ink-4" aria-hidden="true">
          └
        </span>
      ) : (
        <IconeDeCategoria nome={categoria.nome} cor={cor} />
      )}

      <span className="flex min-w-0 items-center gap-8">
        <span className={`truncate text-1 ${categoria.arquivada ? 'text-ink-4 line-through' : ''}`}>
          {categoria.nome}
        </span>
        {categoria.sistema && <span className="rotulo shrink-0">do sistema</span>}
        {!categoria.analitica && (
          <span
            className="rotulo shrink-0"
            title="Fica fora do relatório de categoria e do planejamento"
          >
            não analítica
          </span>
        )}
      </span>

      {/* As ações aparecem no hover, como no Organizze: a lista fica limpa
          para quem só veio conferir, e completa para quem veio mexer. */}
      <span className="flex items-center gap-4 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {aoCriarFilha && !categoria.arquivada && (
          <button className="botao text-sm" onClick={aoCriarFilha}>
            + subcategoria
          </button>
        )}
        {!categoria.sistema && !categoria.arquivada && (
          <button
            className="botao text-sm text-ink-3"
            aria-label={`Arquivar ${categoria.nome}`}
            onClick={aoArquivar}
          >
            ✕
          </button>
        )}
      </span>
    </div>
  )
}

function FormularioDeCategoria({
  tenantId,
  mae,
  aoFechar,
}: {
  tenantId: string
  mae: Categoria | null
  aoFechar(): void
}) {
  const fila = useQueryClient()
  const [nome, setNome] = useState('')
  const [natureza, setNatureza] = useState<Categoria['natureza']>(mae?.natureza ?? 'despesa')
  const [erro, setErro] = useState<string | null>(null)

  const criar = useMutation({
    mutationFn: () =>
      chamar('/categorias', {
        metodo: 'POST',
        tenantId,
        corpo: {
          nome,
          // A natureza da filha é herdada no servidor; mandá-la aqui é só para
          // o contrato, e o valor enviado é o da mãe para não parecer escolha.
          natureza: mae?.natureza ?? natureza,
          ...(mae ? { parentId: mae.id } : {}),
        },
      }),
    onSuccess() {
      void fila.invalidateQueries({ queryKey: ['categorias'] })
      aoFechar()
    },
  })

  async function enviar(e: FormEvent) {
    e.preventDefault()
    setErro(null)
    try {
      await criar.mutateAsync()
    } catch (erro) {
      setErro(erro instanceof ErroDaApi ? erro.message : 'Não foi possível criar a categoria.')
    }
  }

  return (
    <Modal
      titulo={mae ? `Nova subcategoria de ${mae.nome}` : 'Nova categoria'}
      largura={460}
      aoFechar={aoFechar}
    >
      <form className="mt-24 flex flex-col gap-20" onSubmit={(e) => void enviar(e)}>
        <label className="flex flex-col gap-6">
          <span className="rotulo">Nome</span>
          <input
            className="campo"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            maxLength={60}
            required
            autoFocus
          />
        </label>

        {mae ? (
          <p className="text-sm text-ink-3">
            Ela é de <strong>{mae.natureza}</strong>, como {mae.nome}. Uma subcategoria
            herda a natureza da mãe — se fossem diferentes, a soma do galho
            misturaria os dois sinais.
          </p>
        ) : (
          <div role="radiogroup" aria-label="Natureza" className="flex gap-2">
            {(['despesa', 'receita'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={v === natureza}
                onClick={() => setNatureza(v)}
                className={
                  v === natureza
                    ? 'rounded-1 border border-primaria bg-primaria-sutil px-12 py-6 text-sm font-medium text-primaria'
                    : 'rounded-1 border border-line-forte px-12 py-6 text-sm text-ink-2 hover:bg-surface-2'
                }
              >
                {v}
              </button>
            ))}
          </div>
        )}

        {erro && (
          <p role="alert" className="text-corpo text-despesa">
            {erro}
          </p>
        )}

        <div className="flex items-center justify-end gap-12 border-t border-line pt-16">
          <button className="botao botao--discreto" type="button" onClick={aoFechar}>
            cancelar
          </button>
          <button className="botao botao--primario" type="submit" disabled={criar.isPending}>
            {criar.isPending ? 'criando…' : 'criar'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
