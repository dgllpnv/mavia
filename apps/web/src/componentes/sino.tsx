'use client'

import type { Alerta } from '@mavia/contracts'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { chamar } from '../api/cliente'

/**
 * O sino de alertas.
 *
 * **Só conta o que é urgente.** Um número que soma tudo — inclusive as boas
 * notícias, como um piso alcançado — vira ruído permanente, e um distintivo que
 * nunca zera deixa de ser lido em uma semana. O que aparece no número é o que
 * custa dinheiro se ficar mais um dia: lançamento em atraso, fatura vencida,
 * teto estourado.
 *
 * Sem urgência, o sino não tem distintivo — mas continua clicável, porque as
 * outras notícias continuam lá.
 */
export function Sino({ tenantId }: { tenantId: string }) {
  const [aberto, setAberto] = useState(false)
  const caixa = useRef<HTMLDivElement>(null)

  const alertas = useQuery({
    queryKey: ['alertas', tenantId],
    queryFn: () => chamar<{ itens: Alerta[] }>('/alertas', { tenantId }),
    // Alerta é derivado do estado; refazer a conta ao voltar para a aba é
    // barato e evita anunciar um teto que já foi desestourado.
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  })

  const itens = alertas.data?.itens ?? []
  const urgentes = itens.filter((a) => a.severidade === 'urgente').length

  useEffect(() => {
    if (!aberto) return
    function fora(evento: MouseEvent) {
      if (caixa.current && !caixa.current.contains(evento.target as Node)) setAberto(false)
    }
    function esc(evento: KeyboardEvent) {
      if (evento.key === 'Escape') setAberto(false)
    }
    document.addEventListener('mousedown', fora)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', fora)
      document.removeEventListener('keydown', esc)
    }
  }, [aberto])

  return (
    <div className="relative" ref={caixa}>
      <button
        className="relative flex h-[32px] w-[32px] items-center justify-center rounded-full"
        aria-haspopup="dialog"
        aria-expanded={aberto}
        aria-label={
          urgentes > 0
            ? `Alertas: ${urgentes} urgente(s)`
            : itens.length > 0
              ? `Alertas: ${itens.length}`
              : 'Alertas: nenhum'
        }
        onClick={() => setAberto((v) => !v)}
      >
        {/* Glifo desenhado, e não emoji: emoji na interface é proibido pela
            direção de design, e um sino de fonte varia de forma por sistema. */}
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" fill="none">
          <path
            d="M9 2c-2.5 0-4 1.8-4 4.2v2.9L3.6 12h10.8L13 9.1V6.2C13 3.8 11.5 2 9 2Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <path d="M7.2 14a1.9 1.9 0 0 0 3.6 0" stroke="currentColor" strokeWidth="1.4" />
        </svg>

        {urgentes > 0 && (
          <span
            className="absolute -top-[2px] -right-[2px] flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-[4px] font-numero text-[10px] font-bold"
            style={{ background: 'var(--despesa)', color: '#fff' }}
          >
            {urgentes}
          </span>
        )}
      </button>

      {aberto && (
        <div
          role="dialog"
          aria-label="Alertas"
          className="absolute top-[44px] right-0 z-30 w-[360px] max-w-[90vw] rounded-3 border border-[var(--card-borda)] bg-card p-8 text-ink-1 shadow-[var(--elev-2)]"
        >
          {itens.length === 0 ? (
            <p className="px-12 py-16 text-corpo text-ink-3">
              Nada pedindo atenção agora. Tetos dentro do planejado, nada em
              atraso.
            </p>
          ) : (
            <ul className="flex flex-col">
              {itens.map((a) => (
                <li key={a.chave}>
                  <Link
                    href={a.destino}
                    onClick={() => setAberto(false)}
                    className="flex gap-12 rounded-2 px-12 py-12 hover:bg-surface-2"
                  >
                    {/* A faixa de severidade repete em forma o que a cor diz —
                        a cor é o quarto canal, nunca o único. */}
                    <span
                      aria-hidden="true"
                      className="mt-2 block w-[3px] shrink-0 rounded-1"
                      style={{ background: corDa(a.severidade) }}
                    />
                    <span className="min-w-0">
                      <span className="block text-1">{a.titulo}</span>
                      <span className="mt-2 block text-sm text-ink-3">{a.detalhe}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <p className="border-t border-line px-12 pt-12 pb-4 text-sm text-ink-3">
            Os alertas são calculados do seu estado agora — não ficam guardados.
            Resolver a causa faz o aviso sumir.
          </p>
        </div>
      )}
    </div>
  )
}

function corDa(severidade: Alerta['severidade']): string {
  if (severidade === 'urgente') return 'var(--despesa)'
  if (severidade === 'atencao') return 'var(--atencao)'
  return 'var(--ink-3)'
}
