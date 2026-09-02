'use client'

import { partesDoValor, dinheiro } from '@mavia/domain'
import { useId } from 'react'

/**
 * Entrada de valor monetário.
 *
 * O estado é **centavos como string de dígitos**, e a máscara é derivada dele.
 * O caminho oposto — guardar o texto e converter na hora de enviar — é o que
 * produz `parseFloat('1.234,56')` e um lançamento de R$ 1,00 no lugar de
 * R$ 1.234,56. Aqui não existe conversão para número em momento nenhum: o
 * dígito digitado entra na string, e a string vira `bigint`.
 *
 * A digitação é da direita para a esquerda, como numa calculadora ou num
 * terminal de cartão: quem digita `1`, `2`, `3` quer R$ 1,23. Pedir que a
 * pessoa acerte a vírgula é pedir que ela pense no formato em vez de no valor.
 */

export interface CampoDeValorProps {
  /** Magnitude em centavos, só dígitos. O sinal é do domínio, não do campo. */
  readonly centavos: string
  aoMudar(centavos: string): void
  readonly rotulo?: string
  readonly autoFocus?: boolean
}

export function CampoDeValor({
  centavos,
  aoMudar,
  rotulo = 'Valor',
  autoFocus = false,
}: CampoDeValorProps) {
  const id = useId()
  const p = partesDoValor(dinheiro(BigInt(centavos || '0'), 'BRL'))

  function digitar(evento: React.KeyboardEvent<HTMLInputElement>) {
    if (evento.key >= '0' && evento.key <= '9') {
      evento.preventDefault()
      // Teto de 15 dígitos: o `BIGINT` do Postgres comporta mais, mas um valor
      // acima disso é engano de digitação, não um lançamento.
      if (centavos.length >= 15) return
      aoMudar(String(BigInt(centavos || '0') * 10n + BigInt(evento.key)))
      return
    }

    if (evento.key === 'Backspace') {
      evento.preventDefault()
      aoMudar(String(BigInt(centavos || '0') / 10n))
    }
  }

  return (
    <label className="flex flex-col gap-6" htmlFor={id}>
      <span className="rotulo">{rotulo}</span>
      <input
        id={id}
        className="campo valor text-right"
        // `text` e não `number`: o campo `number` aceita `e`, `+` e notação
        // científica, e o navegador formata segundo o locale dele.
        type="text"
        inputMode="numeric"
        autoFocus={autoFocus}
        value={`${p.simbolo} ${p.inteiro}${p.separador}${p.decimais}`}
        onKeyDown={digitar}
        // A leitura é o próprio estado; sem `onChange` o React reclama de campo
        // controlado sem manipulador, e colar texto não deve entrar por aqui.
        onChange={() => undefined}
      />
    </label>
  )
}
