'use client'

import type { Conta, Fatura } from '@mavia/contracts'
import {
  dataCivilDe,
  dinheiro,
  fimDoDiaCivil,
  formatarDataCivil,
  valorEmTexto,
} from '@mavia/domain'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { chamar, ErroDaApi } from '../api/cliente'
import { CampoDeValor } from './campo-de-valor'
import { Modal } from './modal'
import { Valor } from './valor'

/**
 * O instante de um pagamento informado como data.
 *
 * **Hoje** vira o agora: é o instante que de fato aconteceu, e ele não pode ser
 * futuro. **Um dia passado** vira o fim daquele dia — e não a meia-noite.
 *
 * A meia-noite parece a escolha natural e está errada: um pagamento datado de
 * 05/07 às 00:00 **antecede** uma compra feita às 15h de 05/07, e o banco
 * recusa compensar antes de acontecer. Foi assim que a primeira versão desta
 * tela devolveu 500 na primeira tentativa real de pagar uma fatura.
 */
function instanteDoPagamento(dia: string, hoje: string): string {
  if (dia === hoje) return new Date().toISOString()
  const [ano, mes, d] = dia.split('-').map(Number)
  return fimDoDiaCivil({ ano: ano!, mes: mes!, dia: d! }).toISOString()
}

/**
 * Pagar a fatura.
 *
 * **É uma transferência, não uma despesa**, e a tela diz isso com todas as
 * letras porque este é o erro clássico da categoria: contar o pagamento como
 * despesa duplica o gasto do mês — as compras já foram contadas quando
 * aconteceram, e o pagamento apenas move o dinheiro da conta para o cartão.
 *
 * O valor vem preenchido com o **saldo devedor**, e não com o total: numa
 * fatura parcialmente paga, o total já foi coberto em parte, e oferecer o total
 * como padrão convidaria a pagar duas vezes.
 */

export interface PagamentoDeFaturaProps {
  readonly tenantId: string
  readonly fatura: Fatura
  readonly contas: readonly Conta[]
  aoFechar(): void
}

export function PagamentoDeFatura({ tenantId, fatura, contas, aoFechar }: PagamentoDeFaturaProps) {
  const fila = useQueryClient()

  // `total` é negativo (é dívida) e `pago` é positivo. A soma é o que falta.
  const devedor = -(BigInt(fatura.totalCentavos) + BigInt(fatura.pagoCentavos))

  const [centavos, setCentavos] = useState(() => (devedor > 0n ? devedor.toString() : '0'))
  const [dia, setDia] = useState(() => formatarDataCivil(dataCivilDe(new Date())))
  const [contaId, setContaId] = useState(() => contas[0]?.id ?? '')
  const [erro, setErro] = useState<string | null>(null)

  const parcial = BigInt(fatura.pagoCentavos) > 0n
  const hoje = formatarDataCivil(dataCivilDe(new Date()))

  const pagar = useMutation({
    mutationFn: () => {
      const magnitude = BigInt(centavos)
      if (magnitude <= 0n) throw new ErroDaApi(400, 'Informe o valor pago.')
      if (magnitude > devedor) {
        throw new ErroDaApi(
          400,
          `O pagamento passa do que falta desta fatura (${valorEmTexto(
            dinheiro(devedor, 'BRL'),
          ).replace('+', '')}).`,
        )
      }
      if (dia > hoje) {
        // O servidor também recusa. Recusar aqui evita a viagem e explica o
        // porquê: pagamento é fato, não agendamento — data futura derrubaria o
        // saldo de hoje por um dinheiro que ainda não saiu.
        throw new ErroDaApi(400, 'O pagamento não pode ter data futura.')
      }

      return chamar(`/cartoes/faturas/${fatura.id}/pagamentos`, {
        metodo: 'POST',
        tenantId,
        corpo: {
          valorCentavos: magnitude.toString(),
          pagoEm: instanteDoPagamento(dia, hoje),
          ...(contaId ? { contaId } : {}),
        },
      })
    },
    onSuccess() {
      void fila.invalidateQueries({ queryKey: ['faturas'] })
      void fila.invalidateQueries({ queryKey: ['lancamentos'] })
      void fila.invalidateQueries({ queryKey: ['resumo'] })
      void fila.invalidateQueries({ queryKey: ['resumo-conta'] })
      aoFechar()
    },
  })

  async function enviar(e: FormEvent) {
    e.preventDefault()
    setErro(null)
    try {
      await pagar.mutateAsync()
    } catch (erro) {
      setErro(erro instanceof ErroDaApi ? erro.message : 'Não foi possível registrar o pagamento.')
    }
  }

  return (
    <Modal
      titulo="Pagar fatura"
      subtitulo={`Fatura de ${fatura.competencia.slice(0, 7)} · vence em ${fatura.dataVencimento}`}
      aoFechar={aoFechar}
    >
      <div className="mt-16 flex items-baseline justify-between border-b border-line pb-16">
        <span className="rotulo">{parcial ? 'Falta pagar' : 'Total da fatura'}</span>
        <span className="font-numero text-4 font-semibold tracking-tight">
          <Valor centavos={(-devedor).toString()} isolado />
        </span>
      </div>

      {parcial && (
        <p className="mt-8 text-sm text-ink-3">
          Já foram pagos <Valor centavos={fatura.pagoCentavos} /> desta fatura.
        </p>
      )}

      <form className="mt-24 flex flex-col gap-20" onSubmit={(e) => void enviar(e)}>
        <div className="grid grid-cols-[3fr_2fr] gap-16">
          <CampoDeValor centavos={centavos} aoMudar={setCentavos} rotulo="Valor pago" autoFocus />
          <label className="flex flex-col gap-6">
            <span className="rotulo">Pago em</span>
            <input
              className="campo"
              type="date"
              value={dia}
              max={hoje}
              onChange={(e) => setDia(e.target.value)}
              required
            />
          </label>
        </div>

        <label className="flex flex-col gap-6">
          <span className="rotulo">Conta que paga</span>
          <select className="campo" value={contaId} onChange={(e) => setContaId(e.target.value)}>
            {contas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nome}
              </option>
            ))}
          </select>
        </label>

        <p className="text-sm text-ink-2">
          Isto é uma <strong>transferência</strong>, e não uma despesa: as compras
          já entraram na soma do mês em que aconteceram. Contar o pagamento como
          gasto contaria o mesmo dinheiro duas vezes.
        </p>

        {erro && (
          <p role="alert" className="text-corpo text-despesa">
            {erro}
          </p>
        )}

        <div className="flex items-center justify-end gap-12 border-t border-line pt-16">
          <button className="botao botao--discreto" type="button" onClick={aoFechar}>
            cancelar
          </button>
          <button className="botao botao--primario" type="submit" disabled={pagar.isPending}>
            {pagar.isPending ? 'registrando…' : 'registrar pagamento'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
