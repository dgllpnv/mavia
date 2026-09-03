'use client'

import type { TipoDeConta } from '@mavia/contracts'
import { corDaCategoria } from '@mavia/ui'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { competenciaDe } from '@mavia/domain'
import { useState, type FormEvent } from 'react'
import { api, chamar, ErroDaApi } from '../../../api/cliente'
import { periodoDe } from '../../../api/periodo'
import { CampoDeValor } from '../../../componentes/campo-de-valor'
import { Cartao, Vazio } from '../../../componentes/cartao'
import { IconeDeCategoria } from '../../../componentes/icone-de-categoria'
import { Modal } from '../../../componentes/modal'
import { useEspaco } from '../../../componentes/provedores'
import { Valor } from '../../../componentes/valor'

/**
 * Contas.
 *
 * Existe porque sem ela um usuário novo não consegue começar: o espaço nasce
 * com categorias de sistema e mais nada, e todo lançamento precisa de uma conta.
 * Antes desta tela, criar conta só era possível por `curl` ou pela semente.
 *
 * O saldo de cada linha é **derivado**, e não um campo guardado: ele vem do
 * mesmo `resumo` que o painel usa, com o recorte da conta. Guardá-lo numa
 * coluna criaria uma segunda verdade sobre quanto há na conta, e as duas
 * divergem no primeiro estorno.
 */

const TIPOS: readonly (readonly [TipoDeConta, string])[] = [
  ['corrente', 'conta corrente'],
  ['poupanca', 'poupança'],
  ['dinheiro', 'dinheiro em espécie'],
  ['digital', 'conta digital'],
  ['investimento', 'investimento'],
  ['outra', 'outra'],
]

export default function Contas() {
  const espaco = useEspaco()
  const fila = useQueryClient()
  const [criando, setCriando] = useState(false)

  const hoje = competenciaDe(new Date())
  const periodo = periodoDe(hoje.ano, hoje.mes)

  const contas = useQuery({
    queryKey: ['contas', espaco.id],
    queryFn: () => api.contas(espaco.id),
  })

  const saldos = useQueries({
    queries: (contas.data?.itens ?? []).map((c) => ({
      queryKey: ['resumo-conta', espaco.id, c.id, periodo.janela],
      queryFn: () => api.resumo(espaco.id, periodo.janela, 'caixa' as const, c.id),
    })),
  })

  const arquivar = useMutation({
    mutationFn: (id: string) => chamar<void>(`/contas/${id}`, { metodo: 'DELETE', tenantId: espaco.id }),
    onSuccess: () => {
      void fila.invalidateQueries({ queryKey: ['contas'] })
      void fila.invalidateQueries({ queryKey: ['resumo'] })
    },
  })

  return (
    <>
      <div className="flex items-baseline justify-between gap-24">
        <h1>Contas</h1>
        <button className="botao botao--primario" onClick={() => setCriando(true)}>
          + conta
        </button>
      </div>

      <div className="mt-24 max-w-[760px]">
        <Cartao titulo="Minhas contas" semPadding>
          {contas.isPending && <p className="px-20 py-16 text-corpo text-ink-3">Carregando…</p>}

          {contas.data?.itens.length === 0 && (
            <div className="px-20 py-8">
              <Vazio
                acao={
                  <button className="botao botao--primario" onClick={() => setCriando(true)}>
                    criar conta
                  </button>
                }
              >
                Toda movimentação sai de uma conta ou de um cartão. Comece pela
                conta em que o seu salário cai.
              </Vazio>
            </div>
          )}

          {(contas.data?.itens ?? []).map((c, i) => (
            <div key={c.id} className="linha grid-cols-[auto_1fr_auto_auto]">
              <IconeDeCategoria nome={c.nome} cor={corDaCategoria(c.id)} />
              <span className="min-w-0">
                <span className="block truncate text-1">{c.nome}</span>
                <span className="block truncate text-sm text-ink-3">
                  {TIPOS.find(([t]) => t === c.tipo)?.[1] ?? c.tipo}
                  {c.incluirNoSaldoGeral ? '' : ' · fora do saldo geral'}
                </span>
              </span>
              <span className="text-1">
                <Valor centavos={saldos[i]?.data?.saldo ?? c.saldoInicialCentavos} saldo />
              </span>
              <button
                className="botao text-sm text-ink-3"
                aria-label={`Arquivar ${c.nome}`}
                onClick={() => arquivar.mutate(c.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </Cartao>

        <p className="mt-16 max-w-[60ch] text-sm text-ink-3">
          Arquivar uma conta não apaga o histórico dela. Os lançamentos continuam
          no extrato e nos totais dos meses em que aconteceram — o que muda é que
          ela deixa de aparecer para receber lançamento novo.
        </p>
      </div>

      {criando && <FormularioDeConta tenantId={espaco.id} aoFechar={() => setCriando(false)} />}
    </>
  )
}

function FormularioDeConta({ tenantId, aoFechar }: { tenantId: string; aoFechar(): void }) {
  const fila = useQueryClient()
  const [nome, setNome] = useState('')
  const [tipo, setTipo] = useState<TipoDeConta>('corrente')
  const [centavos, setCentavos] = useState('0')
  const [negativo, setNegativo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const criar = useMutation({
    mutationFn: () =>
      chamar('/contas', {
        metodo: 'POST',
        tenantId,
        corpo: {
          nome,
          tipo,
          // O saldo inicial pode ser negativo — conta no cheque especial existe,
          // e obrigar a começar em zero faria o primeiro mês inteiro mentir.
          saldoInicialCentavos: (negativo ? -BigInt(centavos) : BigInt(centavos)).toString(),
        },
      }),
    onSuccess() {
      void fila.invalidateQueries({ queryKey: ['contas'] })
      void fila.invalidateQueries({ queryKey: ['resumo'] })
      aoFechar()
    },
  })

  async function enviar(e: FormEvent) {
    e.preventDefault()
    setErro(null)
    try {
      await criar.mutateAsync()
    } catch (erro) {
      setErro(erro instanceof ErroDaApi ? erro.message : 'Não foi possível criar a conta.')
    }
  }

  return (
    <Modal
      titulo="Nova conta"
      subtitulo="O saldo inicial é o que havia nela no dia em que você começou a usar a Mavia."
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

        <div className="grid grid-cols-[2fr_3fr] gap-16">
          <label className="flex flex-col gap-6">
            <span className="rotulo">Tipo</span>
            <select
              className="campo"
              value={tipo}
              onChange={(e) => setTipo(e.target.value as TipoDeConta)}
            >
              {TIPOS.map(([v, texto]) => (
                <option key={v} value={v}>
                  {texto}
                </option>
              ))}
            </select>
          </label>

          <CampoDeValor centavos={centavos} aoMudar={setCentavos} rotulo="Saldo inicial" />
        </div>

        <label className="flex items-center gap-8 text-corpo">
          <input
            type="checkbox"
            checked={negativo}
            onChange={(e) => setNegativo(e.target.checked)}
          />
          A conta está negativa
        </label>

        {tipo === 'investimento' && (
          <p className="text-sm text-ink-3">
            Conta de investimento nasce fora do saldo geral: o dinheiro é seu, mas
            não é o que você tem para gastar este mês.
          </p>
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
            {criar.isPending ? 'criando…' : 'criar conta'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
