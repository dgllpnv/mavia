'use client'

import { dinheiro, gerarParcelas, valorEmTexto } from '@mavia/domain'

/**
 * O rateio das parcelas, desenhado ao vivo enquanto a pessoa digita.
 *
 * Cinco blocos, cada um com a largura da sua parcela; o primeiro é alguns
 * centavos mais largo, e o texto diz exatamente isso. É o ADR 0005 desenhado
 * em vez de descrito — a pessoa vê que "R$ 100,00 em 3x" não é três de
 * R$ 33,33 antes de confirmar, e não descobre no extrato.
 *
 * Chama a **mesma** `gerarParcelas` que o servidor chama. Recalcular a divisão
 * aqui criaria uma segunda regra de rateio, e a prévia mostraria uma coisa
 * enquanto o banco grava outra — que é pior do que não ter prévia.
 */

export interface PrevisaoDoRateioProps {
  /** Magnitude em centavos. */
  readonly centavos: string
  readonly parcelas: number
  readonly dataDaCompra: string
}

export function PrevisaoDoRateio({ centavos, parcelas, dataDaCompra }: PrevisaoDoRateioProps) {
  const total = BigInt(centavos || '0')
  if (total === 0n || parcelas < 2) return null

  const r = gerarParcelas(dinheiro(-total, 'BRL'), parcelas, new Date(dataDaCompra))

  if (!r.ok) {
    return (
      <p className="text-sm text-despesa" role="alert">
        {r.erro.tipo === 'parcelamento-indivisivel'
          ? `Este valor não divide em ${parcelas} parcelas sem gerar parcela de R$ 0,00.`
          : 'Número de parcelas inválido.'}
      </p>
    )
  }

  const valores = r.valor.map((p) => -p.valor.centavos)
  const menor = valores.reduce((a, b) => (b < a ? b : a))
  const maior = valores.reduce((a, b) => (b > a ? b : a))
  const quantasMaiores = valores.filter((v) => v === maior).length
  const dividiuExato = menor === maior

  return (
    <div>
      {/* A largura de cada bloco é proporcional à parcela. A diferença de um
          centavo não se vê em 400px — e é justamente por isso que o texto
          abaixo existe: a forma mostra a divisão, a frase mostra o resto. */}
      <div className="flex gap-4" aria-hidden="true">
        {valores.map((v, i) => (
          <div
            key={i}
            className="h-[6px] bg-ink-2"
            style={{ flexGrow: Number(v), flexBasis: 0 }}
          />
        ))}
      </div>

      <p className="mt-8 text-sm text-ink-2">
        {dividiuExato ? (
          <>
            {parcelas} parcelas de {valorEmTexto(dinheiro(menor, 'BRL')).replace('+', '')}.
          </>
        ) : (
          <>
            {parcelas} parcelas de {valorEmTexto(dinheiro(menor, 'BRL')).replace('+', '')} — as{' '}
            {quantasMaiores === 1 ? 'primeira leva' : `${quantasMaiores} primeiras levam`}{' '}
            {valorEmTexto(dinheiro(maior, 'BRL')).replace('+', '')}.
          </>
        )}{' '}
        <span className="text-ink-3">O valor digitado é o total.</span>
      </p>
    </div>
  )
}
