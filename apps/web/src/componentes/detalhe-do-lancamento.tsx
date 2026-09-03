'use client'

import type { Lancamento } from '@mavia/contracts'
import { dataCivilDe, dinheiro, fimDoDiaCivil, formatarDataCivil, valorEmTexto } from '@mavia/domain'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { chamar, ErroDaApi } from '../api/cliente'
import { CampoDeValor } from './campo-de-valor'
import { Modal } from './modal'
import { Valor } from './valor'

/**
 * O lançamento aberto, e o estorno.
 *
 * **Estornar não apaga.** O original fica, o estorno entra como lançamento
 * próprio ligado a ele, e os dois aparecem no extrato. É a decisão DP-4: o dado
 * é do espaço, e a correção precisa ser rastreável — quem olha o mês seguinte
 * tem de conseguir ver que houve devolução, e não um mês que mudou sozinho.
 *
 * Por isso não existe botão de excluir aqui. Apagar um lançamento financeiro
 * some com a linha e com a explicação junto.
 */

export interface DetalheDoLancamentoProps {
  readonly tenantId: string
  readonly lancamento: Lancamento
  readonly nomeDaCategoria: string
  readonly nomeDaConta: string
  aoFechar(): void
}

export function DetalheDoLancamento({
  tenantId,
  lancamento,
  nomeDaCategoria,
  nomeDaConta,
  aoFechar,
}: DetalheDoLancamentoProps) {
  const fila = useQueryClient()
  const [estornando, setEstornando] = useState(false)

  const magnitude =
    BigInt(lancamento.valorCentavos) < 0n
      ? -BigInt(lancamento.valorCentavos)
      : BigInt(lancamento.valorCentavos)

  const ehTransferencia = lancamento.transferGroupId !== null
  const ehEstorno = lancamento.estornoDeLancamentoId !== null
  const ehDeCartao = lancamento.cartaoId !== null

  return (
    <Modal
      titulo={lancamento.descricao}
      subtitulo={`${diaLongo(lancamento.postedAt)} · ${nomeDaConta}`}
      largura={480}
      aoFechar={aoFechar}
    >
      <div className="mt-16 border-b border-line pb-16">
        <p className="font-numero text-4 font-semibold tracking-tight">
          <Valor
            centavos={lancamento.valorCentavos}
            isolado
            transferencia={ehTransferencia}
            status={lancamento.status}
          />
        </p>
      </div>

      <dl className="mt-16">
        <Linha rotulo="Estado" valor={lancamento.status} />
        <Linha rotulo="Categoria" valor={ehTransferencia ? 'transferência' : nomeDaCategoria} />
        {lancamento.installmentTotal !== null && (
          <Linha
            rotulo="Parcela"
            valor={`${lancamento.installmentNumero} de ${lancamento.installmentTotal}`}
          />
        )}
        <Linha rotulo="Origem" valor={ORIGENS[lancamento.origem]} />
        <Linha
          rotulo="Compensado em"
          valor={lancamento.settledAt ? diaLongo(lancamento.settledAt) : 'ainda não'}
        />
      </dl>

      {estornando ? (
        <FormularioDeEstorno
          tenantId={tenantId}
          lancamento={lancamento}
          magnitude={magnitude}
          aoConcluir={() => {
            void fila.invalidateQueries({ queryKey: ['lancamentos'] })
            void fila.invalidateQueries({ queryKey: ['resumo'] })
            void fila.invalidateQueries({ queryKey: ['resumo-conta'] })
            aoFechar()
          }}
          aoCancelar={() => setEstornando(false)}
        />
      ) : (
        <div className="mt-24 border-t border-line pt-16">
          {podeEstornar({ ehTransferencia, ehEstorno, ehDeCartao }) ? (
            <>
              <button className="botao botao--discreto" onClick={() => setEstornando(true)}>
                estornar
              </button>
              <p className="mt-8 max-w-[52ch] text-sm text-ink-3">
                O estorno entra como lançamento próprio, ligado a este. Os dois
                continuam no extrato — a correção fica visível, em vez de o mês
                mudar sozinho.
              </p>
            </>
          ) : (
            <p className="max-w-[52ch] text-sm text-ink-3">{PORQUE_NAO[razaoParaNao({ ehTransferencia, ehEstorno, ehDeCartao })]}</p>
          )}
        </div>
      )}
    </Modal>
  )
}

interface Situacao {
  readonly ehTransferencia: boolean
  readonly ehEstorno: boolean
  readonly ehDeCartao: boolean
}

function podeEstornar(s: Situacao): boolean {
  return !s.ehTransferencia && !s.ehEstorno && !s.ehDeCartao
}

function razaoParaNao(s: Situacao): keyof typeof PORQUE_NAO {
  if (s.ehTransferencia) return 'transferencia'
  if (s.ehEstorno) return 'estorno'
  if (s.ehDeCartao) return 'cartao'
  return 'nenhuma'
}

const PORQUE_NAO = {
  transferencia:
    'Uma transferência não se estorna: ela tem duas pernas, e desfazer uma delas ' +
    'criaria dinheiro. Lance a transferência inversa.',
  estorno: 'Isto já é um estorno. Estornar um estorno seria refazer o lançamento original.',
  // Declarado como pendência em `docs/pendencias.md` (P-6): o estorno de compra
  // no cartão precisa decidir em qual fatura o crédito entra, e essa é uma
  // regra de negócio, não um detalhe de implementação.
  cartao:
    'O estorno de compra no cartão ainda não existe: falta decidir em qual fatura ' +
    'o crédito entra, e isso é regra de negócio, não detalhe de código.',
  nenhuma: '',
} as const

const ORIGENS: Record<Lancamento['origem'], string> = {
  manual: 'digitado',
  importado: 'importado de extrato',
  recorrencia: 'lançamento fixo',
  parcelamento: 'parcelamento',
  ajuste: 'ajuste',
}

function Linha({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="linha grid-cols-[140px_1fr]">
      <dt className="rotulo">{rotulo}</dt>
      <dd className="truncate text-corpo">{valor}</dd>
    </div>
  )
}

function FormularioDeEstorno({
  tenantId,
  lancamento,
  magnitude,
  aoConcluir,
  aoCancelar,
}: {
  tenantId: string
  lancamento: Lancamento
  magnitude: bigint
  aoConcluir(): void
  aoCancelar(): void
}) {
  const hoje = formatarDataCivil(dataCivilDe(new Date()))
  const [centavos, setCentavos] = useState(magnitude.toString())
  const [dia, setDia] = useState(hoje)
  const [erro, setErro] = useState<string | null>(null)

  const estornar = useMutation({
    mutationFn: () => {
      const pedido = BigInt(centavos)
      if (pedido <= 0n) throw new ErroDaApi(400, 'Informe o valor a estornar.')
      if (pedido > magnitude) {
        throw new ErroDaApi(
          400,
          `O estorno não pode passar do lançamento (${valorEmTexto(
            dinheiro(magnitude, 'BRL'),
          ).replace('+', '')}).`,
        )
      }

      const [ano, mes, d] = dia.split('-').map(Number)
      return chamar(`/lancamentos/${lancamento.id}/estornos`, {
        metodo: 'POST',
        tenantId,
        corpo: {
          // Magnitude positiva: o sinal do estorno é derivado do original, e
          // mandá-lo daqui seria a interface decidindo a direção do dinheiro.
          valorCentavos: pedido.toString(),
          postedAt:
            dia === hoje
              ? new Date().toISOString()
              : fimDoDiaCivil({ ano: ano!, mes: mes!, dia: d! }).toISOString(),
          descricao: `Estorno de ${lancamento.descricao}`,
        },
      })
    },
    onSuccess: aoConcluir,
  })

  async function enviar(e: FormEvent) {
    e.preventDefault()
    setErro(null)
    try {
      await estornar.mutateAsync()
    } catch (erro) {
      setErro(erro instanceof ErroDaApi ? erro.message : 'Não foi possível estornar.')
    }
  }

  return (
    <form className="mt-24 flex flex-col gap-20 border-t border-line pt-16" onSubmit={(e) => void enviar(e)}>
      <p className="rotulo">Estornar</p>

      <div className="grid grid-cols-[3fr_2fr] gap-16">
        <CampoDeValor centavos={centavos} aoMudar={setCentavos} rotulo="Valor" autoFocus />
        <label className="flex flex-col gap-6">
          <span className="rotulo">Data</span>
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

      <p className="text-sm text-ink-3">
        Estorno parcial é permitido — devolveram parte, e o extrato mostra os
        dois valores.
      </p>

      {erro && (
        <p role="alert" className="text-corpo text-despesa">
          {erro}
        </p>
      )}

      <div className="flex items-center justify-end gap-12">
        <button className="botao botao--discreto" type="button" onClick={aoCancelar}>
          cancelar
        </button>
        <button className="botao botao--primario" type="submit" disabled={estornar.isPending}>
          {estornar.isPending ? 'estornando…' : 'estornar'}
        </button>
      </div>
    </form>
  )
}

const MESES = [
  'jan',
  'fev',
  'mar',
  'abr',
  'mai',
  'jun',
  'jul',
  'ago',
  'set',
  'out',
  'nov',
  'dez',
] as const

function diaLongo(iso: string): string {
  const c = dataCivilDe(new Date(iso))
  return `${String(c.dia).padStart(2, '0')} ${MESES[c.mes - 1]} ${c.ano}`
}
