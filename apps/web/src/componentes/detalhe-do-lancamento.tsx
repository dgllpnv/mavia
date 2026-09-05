'use client'

import type { Lancamento } from '@mavia/contracts'
import { dataCivilDe, dinheiro, fimDoDiaCivil, formatarDataCivil, valorEmTexto } from '@mavia/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { api, chamar, ErroDaApi } from '../api/cliente'
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
        {lancamento.classificacaoMotivo && (
          /* A garantia do glossário: "sempre com o motivo visível". Uma
             classificação que a pessoa não consegue explicar é uma que ela não
             consegue contestar. */
          <Linha rotulo="Por quê" valor={lancamento.classificacaoMotivo} />
        )}
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
          {!ehTransferencia && (
            <TrocarCategoria
              tenantId={tenantId}
              lancamento={lancamento}
              aoTrocar={() => {
                void fila.invalidateQueries({ queryKey: ['lancamentos'] })
                void fila.invalidateQueries({ queryKey: ['resumo'] })
                aoFechar()
              }}
            />
          )}

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
              {/* ADR 0023: quem estorna uma compra de março e vê o crédito na
                  fatura de maio precisa entender isso sem abrir um documento.
                  A frase aparece só no cartão porque só ali há fatura no meio. */}
              {ehDeCartao && (
                <p className="mt-8 max-w-[52ch] text-sm text-ink-3">
                  O crédito entra na <strong>fatura aberta na data do reembolso</strong>, como
                  faz a administradora do cartão — e não na fatura da compra, que já foi
                  fechada. Se o reembolso chegar antes de a fatura fechar, os dois caem
                  na mesma e o total já sai com o desconto.
                </p>
              )}
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

/**
 * Compra de cartão **pode** ser estornada desde o ADR 0023, e a ausência de
 * `ehDeCartao` nesta condição é a decisão, não um esquecimento. O teste
 * irmão trava isso — ver `detalhe-do-lancamento.test.ts`.
 */
export function podeEstornar(s: Situacao): boolean {
  return !s.ehTransferencia && !s.ehEstorno
}

export function razaoParaNao(s: Situacao): keyof typeof PORQUE_NAO {
  if (s.ehTransferencia) return 'transferencia'
  if (s.ehEstorno) return 'estorno'
  return 'nenhuma'
}

const PORQUE_NAO = {
  transferencia:
    'Uma transferência não se estorna: ela tem duas pernas, e desfazer uma delas ' +
    'criaria dinheiro. Lance a transferência inversa.',
  estorno: 'Isto já é um estorno. Estornar um estorno seria refazer o lançamento original.',
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
    <div className="linha grid-cols-[110px_minmax(0,1fr)] lg:grid-cols-[140px_1fr]">
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

/**
 * Trocar a categoria — a reversão em um toque que o épico 7 promete.
 *
 * Fica **atrás de um toque**, e não como um seletor sempre aberto: o detalhe é
 * uma tela de leitura, e um seletor aberto convida a mexer sem querer num
 * registro que já está certo.
 *
 * Trocar aqui apaga a marca de classificação automática — quem decidiu foi a
 * pessoa, e a partir daí o lançamento deixa de constar como decidido pelo
 * sistema.
 */
function TrocarCategoria({
  tenantId,
  lancamento,
  aoTrocar,
}: {
  tenantId: string
  lancamento: Lancamento
  aoTrocar(): void
}) {
  const [aberto, setAberto] = useState(false)
  const [escolhida, setEscolhida] = useState(lancamento.categoriaId ?? '')

  const categorias = useQuery({
    queryKey: ['categorias', tenantId],
    queryFn: () => api.categorias(tenantId),
    enabled: aberto,
    staleTime: 5 * 60_000,
  })

  const trocar = useMutation({
    mutationFn: () =>
      chamar(`/lancamentos/${lancamento.id}`, {
        metodo: 'PATCH',
        tenantId,
        corpo: { categoriaId: escolhida },
      }),
    onSuccess: aoTrocar,
  })

  const natureza = BigInt(lancamento.valorCentavos) < 0n ? 'despesa' : 'receita'
  const disponiveis = (categorias.data?.itens ?? []).filter(
    (c) => c.natureza === natureza && c.analitica && !c.arquivada,
  )

  if (!aberto) {
    return (
      <button className="botao botao--discreto mb-16" onClick={() => setAberto(true)}>
        trocar categoria
      </button>
    )
  }

  return (
    <div className="mb-20 flex flex-col gap-12">
      <label className="flex flex-col gap-6">
        <span className="rotulo">Categoria</span>
        <select
          className="campo"
          value={escolhida}
          onChange={(e) => setEscolhida(e.target.value)}
        >
          {disponiveis.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nome}
            </option>
          ))}
        </select>
      </label>

      <div className="flex gap-12">
        <button
          className="botao botao--primario"
          onClick={() => void trocar.mutateAsync()}
          disabled={trocar.isPending || escolhida === ''}
        >
          {trocar.isPending ? 'salvando…' : 'salvar'}
        </button>
        <button className="botao" onClick={() => setAberto(false)}>
          cancelar
        </button>
      </div>
    </div>
  )
}
