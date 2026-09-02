'use client'

import type { Conta } from '@mavia/contracts'
import { ancorarDiaNoMes, vencimentoDaFatura } from '@mavia/domain'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { chamar, ErroDaApi } from '../api/cliente'
import { CampoDeValor } from './campo-de-valor'
import { Modal } from './modal'

/**
 * Cadastro de cartão.
 *
 * Os dois campos que importam são **fechamento** e **vencimento**, e a tela
 * explica o que eles fazem em vez de só pedi-los: é o ciclo que decide em qual
 * fatura cada compra entra, e errá-lo joga um mês inteiro de compras na fatura
 * errada — em silêncio, porque nada no sistema tem como saber que está errado.
 *
 * Por isso o formulário mostra, ao vivo, a consequência da escolha: *"uma
 * compra hoje entraria na fatura que fecha em 25/set e vence em 05/out"*. É
 * mais barato conferir aqui do que descobrir no mês seguinte.
 */

export interface FormularioDeCartaoProps {
  readonly tenantId: string
  readonly contas: readonly Conta[]
  aoFechar(): void
}

export function FormularioDeCartao({ tenantId, contas, aoFechar }: FormularioDeCartaoProps) {
  const fila = useQueryClient()

  const [nome, setNome] = useState('')
  const [limite, setLimite] = useState('0')
  const [closingDay, setClosingDay] = useState(25)
  const [dueDay, setDueDay] = useState(5)
  const [contaPagamentoId, setContaPagamentoId] = useState(() => contas[0]?.id ?? '')
  const [erro, setErro] = useState<string | null>(null)

  const criar = useMutation({
    mutationFn: () =>
      chamar('/cartoes', {
        metodo: 'POST',
        tenantId,
        corpo: {
          nome,
          limiteCentavos: limite,
          closingDay,
          dueDay,
          ...(contaPagamentoId ? { contaPagamentoId } : {}),
        },
      }),
    onSuccess() {
      void fila.invalidateQueries({ queryKey: ['cartoes'] })
      aoFechar()
    },
  })

  async function enviar(e: FormEvent) {
    e.preventDefault()
    setErro(null)
    try {
      await criar.mutateAsync()
    } catch (erro) {
      setErro(erro instanceof ErroDaApi ? erro.message : 'Não foi possível criar o cartão.')
    }
  }

  return (
    <Modal
      titulo="Novo cartão"
      subtitulo="O ciclo é o que decide em qual fatura cada compra entra."
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

        <div className="grid grid-cols-2 gap-16">
          <label className="flex flex-col gap-6">
            <span className="rotulo">Fecha no dia</span>
            <input
              className="campo valor text-right"
              type="number"
              min={1}
              max={31}
              value={closingDay}
              onChange={(e) => setClosingDay(limitarDia(e.target.value, 25))}
              required
            />
          </label>

          <label className="flex flex-col gap-6">
            <span className="rotulo">Vence no dia</span>
            <input
              className="campo valor text-right"
              type="number"
              min={1}
              max={31}
              value={dueDay}
              onChange={(e) => setDueDay(limitarDia(e.target.value, 5))}
              required
            />
          </label>
        </div>

        <ExplicacaoDoCiclo closingDay={closingDay} dueDay={dueDay} />

        <div className="grid grid-cols-[2fr_3fr] gap-16">
          <CampoDeValor centavos={limite} aoMudar={setLimite} rotulo="Limite" />

          <label className="flex flex-col gap-6">
            <span className="rotulo">Conta que paga</span>
            <select
              className="campo"
              value={contaPagamentoId}
              onChange={(e) => setContaPagamentoId(e.target.value)}
            >
              {contas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="text-sm text-ink-3">
          A conta que paga fica congelada em cada fatura no dia em que ela abre.
          Trocá-la aqui vale para as próximas — as faturas já abertas continuam
          apontando para a conta com que foram criadas.
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
          <button className="botao botao--primario" type="submit" disabled={criar.isPending}>
            {criar.isPending ? 'criando…' : 'criar cartão'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/**
 * O que o ciclo escolhido significa, com a data de hoje.
 *
 * Usa `vencimentoDaFatura` do domínio, e não aritmética escrita aqui: se a
 * explicação e o cálculo real divergirem, a tela ensina errado — que é pior do
 * que não explicar.
 */
function ExplicacaoDoCiclo({ closingDay, dueDay }: { closingDay: number; dueDay: number }) {
  const hoje = new Date()
  const ano = hoje.getFullYear()
  const mes = hoje.getMonth() + 1

  const fecha = ancorarDiaNoMes(ano, mes, closingDay)
  const venc = vencimentoDaFatura({ closingDay, dueDay }, { ano, mes })

  return (
    <p className="text-sm text-ink-2">
      Uma compra feita até <strong>{dia(fecha)}</strong> entra na fatura que vence
      em <strong>{dia(venc)}</strong>. Depois disso, cai na fatura seguinte.
      {dueDay <= closingDay && (
        <span className="text-ink-3">
          {' '}
          Como o vencimento não é maior que o fechamento, ele cai sempre no mês
          seguinte ao do fechamento.
        </span>
      )}
    </p>
  )
}

const dia = (d: { dia: number; mes: number }) =>
  `${String(d.dia).padStart(2, '0')}/${String(d.mes).padStart(2, '0')}`

/** O campo é `number`, mas o teclado entrega string — e às vezes vazia. */
function limitarDia(texto: string, padrao: number): number {
  const n = Number(texto)
  if (!Number.isInteger(n) || n < 1 || n > 31) return padrao
  return n
}
