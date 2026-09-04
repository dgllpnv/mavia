'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { Hipotese } from './hipotese'

/**
 * As hipóteses declaradas nesta sessão do navegador, por cliente.
 *
 * **Em memória, e nunca em `localStorage`.** Uma hipótese que sobrevive à aba é
 * uma hipótese que ninguém redeclarou: o operador voltaria amanhã ao espaço de
 * um cliente carregando o número do chamado da semana passada, e o registro
 * diria que a leitura de hoje pertence àquele caso. O motivo declarado precisa
 * ser o motivo de agora — é a única coisa que o log não tem como conferir.
 *
 * Fechar a aba apaga tudo, e é o comportamento certo.
 */

interface Painel {
  hipoteseDe(tenantId: string): Hipotese | null
  declarar(tenantId: string, h: Hipotese): void
  /** Fecha o espaço: a próxima entrada pede motivo e referência de novo. */
  esquecer(tenantId: string): void
}

const Contexto = createContext<Painel | null>(null)

export function usePainel(): Painel {
  const p = useContext(Contexto)
  if (!p) throw new Error('usePainel fora de <ProvedorDoPainel>.')
  return p
}

export function ProvedorDoPainel({ children }: { children: ReactNode }) {
  const [hipoteses, setHipoteses] = useState<Readonly<Record<string, Hipotese>>>({})

  const declarar = useCallback((tenantId: string, h: Hipotese) => {
    setHipoteses((atual) => ({ ...atual, [tenantId]: h }))
  }, [])

  const esquecer = useCallback((tenantId: string) => {
    setHipoteses((atual) => {
      const copia = { ...atual }
      delete copia[tenantId]
      return copia
    })
  }, [])

  const valor = useMemo<Painel>(
    () => ({
      hipoteseDe: (tenantId) => hipoteses[tenantId] ?? null,
      declarar,
      esquecer,
    }),
    [hipoteses, declarar, esquecer],
  )

  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>
}
