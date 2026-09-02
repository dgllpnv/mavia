'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, SemSessao, type Eu, type Espaco } from '../api/cliente'

/**
 * Sessão e espaço, para a árvore inteira.
 *
 * O espaço escolhido é estado do cliente e vai em `X-Mavia-Tenant` a cada
 * chamada — a API recusa a omissão inclusive para quem tem um espaço só. Ele
 * fica em `localStorage` para sobreviver ao recarregamento: o identificador do
 * espaço **não é segredo** (aparece na interface), e guardá-lo aqui é diferente
 * de guardar o token, que nunca chega ao JavaScript.
 */

const CHAVE_DO_ESPACO = 'mavia.espaco'

interface Sessao {
  readonly eu: Eu | null
  readonly carregando: boolean
  readonly espaco: Espaco | null
  escolherEspaco(id: string): void
  entrar(email: string, senha: string): Promise<void>
  sair(): Promise<void>
}

const ContextoDeSessao = createContext<Sessao | null>(null)

export function useSessao(): Sessao {
  const s = useContext(ContextoDeSessao)
  if (!s) throw new Error('useSessao fora de <Provedores>.')
  return s
}

/** O espaço atual, quando a tela já sabe que ele existe. */
export function useEspaco(): Espaco {
  const { espaco } = useSessao()
  if (!espaco) throw new Error('useEspaco antes de o espaço ser escolhido.')
  return espaco
}

export function Provedores({ children }: { children: ReactNode }) {
  const [cliente] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Dinheiro não é dado que se pode mostrar velho sem avisar.
            // 30 segundos é curto o bastante para o saldo acompanhar um
            // lançamento feito noutra aba, e longo o bastante para a navegação
            // entre telas não repetir a mesma consulta.
            staleTime: 30_000,
            retry: (tentativas, erro) =>
              erro instanceof SemSessao ? false : tentativas < 2,
          },
        },
      }),
  )

  return (
    <QueryClientProvider client={cliente}>
      <ProvedorDeSessao>{children}</ProvedorDeSessao>
    </QueryClientProvider>
  )
}

function ProvedorDeSessao({ children }: { children: ReactNode }) {
  const [eu, setEu] = useState<Eu | null>(null)
  const [carregando, setCarregando] = useState(true)
  const [espacoId, setEspacoId] = useState<string | null>(null)

  useEffect(() => {
    let vivo = true
    api
      .eu()
      .then((r) => {
        if (!vivo) return
        setEu(r)
        const guardado = window.localStorage.getItem(CHAVE_DO_ESPACO)
        // O espaço guardado só vale se ainda for um espaço deste usuário:
        // quem perde o acesso não pode continuar mandando o cabeçalho antigo.
        const valido = r.tenants.find((t) => t.id === guardado) ?? r.tenants[0] ?? null
        setEspacoId(valido?.id ?? null)
      })
      .catch(() => {
        if (vivo) setEu(null)
      })
      .finally(() => {
        if (vivo) setCarregando(false)
      })
    return () => {
      vivo = false
    }
  }, [])

  const valor = useMemo<Sessao>(() => {
    const espaco = eu?.tenants.find((t) => t.id === espacoId) ?? null

    return {
      eu,
      carregando,
      espaco,
      escolherEspaco(id) {
        window.localStorage.setItem(CHAVE_DO_ESPACO, id)
        setEspacoId(id)
      },
      async entrar(email, senha) {
        const r = await api.entrar(email, senha)
        setEu(r)
        const primeiro = r.tenants[0]
        if (primeiro) {
          window.localStorage.setItem(CHAVE_DO_ESPACO, primeiro.id)
          setEspacoId(primeiro.id)
        }
      },
      async sair() {
        await api.sair()
        window.localStorage.removeItem(CHAVE_DO_ESPACO)
        setEu(null)
        setEspacoId(null)
      },
    }
  }, [eu, carregando, espacoId])

  return <ContextoDeSessao.Provider value={valor}>{children}</ContextoDeSessao.Provider>
}
