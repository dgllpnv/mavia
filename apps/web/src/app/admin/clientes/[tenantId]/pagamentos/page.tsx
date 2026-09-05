'use client'

import type { BaixaAnterior, MeioDePagamento } from '@mavia/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { CampoDeValor } from '../../../../../componentes/campo-de-valor'
import { Valor } from '../../../../../componentes/valor'
import { painel } from '../../../../../painel/api'
import {
  A_OBSERVACAO_SAI_NA_EXPORTACAO,
  aceitaBaixa,
  avaliarBaixa,
  instanteDoRecebimento,
  O_QUE_A_BAIXA_NAO_FAZ,
  oQueEstaBaixaFaz,
} from '../../../../../painel/baixas'
import { usePainel } from '../../../../../painel/contexto'
import { competenciaPorExtenso, dataEHoraNaTela, dataNaTela } from '../../../../../painel/formatos'
import type { Hipotese } from '../../../../../painel/hipotese'
import { CabecalhoDeLeitura, Estado, mensagemDoErro } from '../../../../../painel/pecas'
import { TabelaRolavel } from '../../../tabela-rolavel'

/**
 * As baixas anteriores, **e depois delas** o formulário de baixa.
 *
 * ## A ordem é requisito, não conveniência
 *
 * A lista fica **acima** do formulário, e não numa aba. Uma aba é uma decisão de
 * layout que apaga um controle: o cenário F-3 — dois operadores, o mesmo Pix,
 * horas diferentes — depende de o operador **ver** antes de clicar. O índice
 * único do banco recusa a repetição exata da referência e **não** recusa a mesma
 * quantia com outra referência; a tela é o que faz alguém perceber a segunda.
 *
 * ## A baixa não é um registro contábil
 *
 * Num cliente `em_atraso`, `admin.registrar_pagamento` aplica a transição
 * `em_atraso → ativa` na mesma transação: a baixa **reativa o acesso**. A tela
 * diz isso por escrito antes do botão (achado F-1), e diz também o que ela não
 * faz — o pagamento fora da Stripe não entra em cálculo de reembolso nenhum
 * (F-10).
 *
 * ## O que esta tela não soma
 *
 * Nenhum total. `pagamentosRecebidos` é a única função do repositório autorizada
 * a somar `pagamentos_manuais`, e ela vive no servidor com a janela semiaberta e
 * o `deleted_at IS NULL`. Somar aqui as 100 linhas que a rota devolve produziria
 * um número que não é a receita de período nenhum.
 */

const MEIOS: readonly (readonly [MeioDePagamento, string])[] = [
  ['pix', 'Pix'],
  ['transferencia', 'transferência'],
  ['boleto', 'boleto'],
  ['dinheiro', 'dinheiro em espécie'],
]

export default function Pagamentos() {
  const { tenantId } = useParams<{ tenantId: string }>()
  const { hipoteseDe } = usePainel()
  const hipotese = hipoteseDe(tenantId)

  const pagamentos = useQuery({
    queryKey: ['painel', 'pagamentos', tenantId],
    queryFn: () => painel.pagamentos(tenantId, hipotese!),
    enabled: hipotese !== null,
  })

  /**
   * O estado da assinatura, para a tela poder dizer o que a baixa faz.
   *
   * Mesma chave da tela de perfil: se o operador já passou por lá, o TanStack
   * reusa o que está em cache e nenhuma leitura nova acontece. Se não passou,
   * esta é uma leitura de verdade e vira uma linha do registro — como deve ser,
   * porque a tela de fato leu o contrato dele.
   */
  const perfil = useQuery({
    queryKey: ['painel', 'perfil', tenantId],
    queryFn: () => painel.perfil(tenantId, hipotese!),
    enabled: hipotese !== null,
  })

  const itens = pagamentos.data ?? []
  const estado = perfil.data?.estado ?? null

  return (
    <>
      <CabecalhoDeLeitura
        secao="baixas anteriores"
        numero={pagamentos.isPending ? '—' : itens.length}
        denominador="baixas já registradas para este cliente, da mais recente para a mais antiga. Confira esta lista antes de registrar outra: o banco recusa a referência repetida e não recusa a mesma quantia com outra referência."
      />

      <div className="mt-24">
        <Estado
          carregando={pagamentos.isPending}
          erro={pagamentos.error}
          vazio={itens.length === 0}
          textoDoVazio={
            <>
              Nenhuma baixa manual para este cliente. É o normal de quem paga por cartão: a baixa
              manual existe para o dinheiro que entrou fora do provedor — Pix, transferência, boleto
              e espécie.
            </>
          }
        >
          <TabelaDeBaixas itens={itens} />
        </Estado>
      </div>

      <hr className="regua mt-44" />

      {hipotese && (
        <FormularioDeBaixa
          tenantId={tenantId}
          hipotese={hipotese}
          estado={estado}
          anteriores={itens}
          carregandoEstado={perfil.isPending}
        />
      )}
    </>
  )
}

function TabelaDeBaixas({ itens }: { readonly itens: readonly BaixaAnterior[] }) {
  return (
    <TabelaRolavel rotulo="Baixas registradas">
      <table className="tabela">
        <caption className="sr-only">
          Baixas de pagamento já registradas, com competência, valor e referência
        </caption>
        <thead>
          <tr>
            <th scope="col" className="numero">
              Competência
            </th>
            <th scope="col" className="numero">
              Recebido em
            </th>
            <th scope="col">Meio</th>
            <th scope="col">Referência</th>
            <th scope="col">Observação</th>
            <th scope="col" className="numero">
              Valor
            </th>
          </tr>
        </thead>
        <tbody>
          {itens.map((b) => (
            <tr key={b.id}>
              {/* Competência como **mês por extenso**: item 9 da auditoria. E sem
                  conversão de fuso — é `DATE`, uma data civil. */}
              <td className="text-ink-1">{competenciaPorExtenso(b.competencia)}</td>
              <td className="numero text-ink-2">{dataNaTela(b.recebido_em)}</td>
              <td className="text-ink-2">{MEIOS.find(([v]) => v === b.meio)?.[1] ?? b.meio}</td>
              <td className="identificador">{b.referencia_externa}</td>
              <td className="text-ink-3">{b.observacao ?? '—'}</td>
              <td className="numero">
                {/* Dinheiro que entrou na Mavia, e não movimento do razão do
                    cliente: `saldo` tira o `+` e a tinta verde, que afirmariam
                    uma direção que este número não tem no eixo dele. */}
                <Valor centavos={b.valor_centavos} moeda={b.moeda} saldo />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TabelaRolavel>
  )
}

function FormularioDeBaixa({
  tenantId,
  hipotese,
  estado,
  anteriores,
  carregandoEstado,
}: {
  readonly tenantId: string
  readonly hipotese: Hipotese
  readonly estado: string | null
  readonly anteriores: readonly BaixaAnterior[]
  readonly carregandoEstado: boolean
}) {
  const fila = useQueryClient()
  const [centavos, setCentavos] = useState('0')
  const [meio, setMeio] = useState<MeioDePagamento>('pix')
  const [referencia, setReferencia] = useState('')
  const [dia, setDia] = useState('')
  const [observacao, setObservacao] = useState('')
  const [confirmouSemelhantes, setConfirmou] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const recebidoEm = dia ? instanteDoRecebimento(dia, new Date()) : ''

  const avaliacao = avaliarBaixa(
    anteriores,
    { valorCentavos: centavos, meio, referenciaExterna: referencia, recebidoEm: recebidoEm || new Date().toISOString() },
    confirmouSemelhantes,
  )

  const registrar = useMutation({
    mutationFn: () =>
      painel.darBaixa(tenantId, hipotese, {
        valorCentavos: centavos,
        meio,
        referenciaExterna: referencia.trim(),
        recebidoEm,
        ...(observacao.trim() ? { observacao: observacao.trim() } : {}),
      }),
    onSuccess() {
      void fila.invalidateQueries({ queryKey: ['painel', 'pagamentos', tenantId] })
      void fila.invalidateQueries({ queryKey: ['painel', 'perfil', tenantId] })
      setCentavos('0')
      setReferencia('')
      setObservacao('')
      setConfirmou(false)
    },
  })

  if (carregandoEstado) {
    return (
      <p className="mt-24 text-corpo text-ink-3" aria-live="polite">
        Lendo o estado da assinatura para dizer o que a baixa faz…
      </p>
    )
  }

  if (!aceitaBaixa(estado)) {
    return (
      <section className="mt-24 max-w-[70ch]">
        <h2 className="rotulo">Dar baixa</h2>
        <p className="mt-8 text-corpo text-ink-2">{oQueEstaBaixaFaz(estado)}</p>
      </section>
    )
  }

  const camposCompletos =
    BigInt(centavos || '0') > 0n && referencia.trim().length >= 6 && dia.length > 0

  async function enviar(e: FormEvent) {
    e.preventDefault()
    setErro(null)
    try {
      await registrar.mutateAsync()
    } catch (erro) {
      setErro(mensagemDoErro(erro))
    }
  }

  return (
    <section className="mt-24 max-w-[70ch]">
      <h2 className="rotulo">Dar baixa</h2>

      {/*
        Exigência 2 da §9: a tela diz o que a baixa **faz**. A régua colorida é
        reforço; o texto carrega o significado sozinho.
      */}
      <p
        className={`consequencia mt-8 text-corpo text-ink-1 ${
          estado === 'em_atraso' ? 'consequencia--muda-acesso' : ''
        }`}
      >
        {oQueEstaBaixaFaz(estado)}
      </p>

      {/* Exigência 3: a tela diz o que ela **não** faz, com estas palavras. */}
      <p className="consequencia mt-12 text-corpo text-ink-2">{O_QUE_A_BAIXA_NAO_FAZ}</p>

      <form className="mt-24 flex flex-col gap-20" onSubmit={(e) => void enviar(e)}>
        <div className="grid grid-cols-[1fr_1fr] gap-16">
          <CampoDeValor centavos={centavos} aoMudar={setCentavos} rotulo="Valor recebido" />

          <label className="flex flex-col gap-6">
            <span className="rotulo">Meio</span>
            <select
              className="campo"
              value={meio}
              onChange={(e) => setMeio(e.target.value as MeioDePagamento)}
            >
              {MEIOS.map(([v, rotulo]) => (
                <option key={v} value={v}>
                  {rotulo}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="flex flex-col gap-6">
          <span className="rotulo">Dia do recebimento</span>
          <input
            className="campo valor"
            type="date"
            value={dia}
            onChange={(e) => setDia(e.target.value)}
            required
          />
          <span className="text-sm text-ink-3">
            O dia que está no comprovante, e não o dia de hoje. É ele que decide a competência da
            receita — {dia ? competenciaPorExtenso(dia) : 'ainda não informada'}.
          </span>
        </label>

        <label className="flex flex-col gap-6">
          <span className="rotulo">Referência externa</span>
          <input
            className="campo identificador"
            value={referencia}
            onChange={(e) => {
              setReferencia(e.target.value)
              setConfirmou(false)
            }}
            minLength={6}
            maxLength={140}
            autoComplete="off"
            required
          />
          <span className="text-sm text-ink-3">
            O end-to-end id do Pix, o número do comprovante, do boleto ou do recibo. De 6 a 140
            caracteres. Em espécie, é o número do recibo — se não há recibo, não há baixa.
          </span>
        </label>

        {avaliacao.repetida && <Repetida baixa={avaliacao.repetida} />}

        {!avaliacao.repetida && avaliacao.semelhantes.length > 0 && (
          <Semelhantes
            baixas={avaliacao.semelhantes}
            confirmou={confirmouSemelhantes}
            aoConfirmar={setConfirmou}
          />
        )}

        <label className="flex flex-col gap-6">
          <span className="rotulo">Observação</span>
          <textarea
            className="campo"
            rows={2}
            maxLength={1000}
            value={observacao}
            onChange={(e) => setObservacao(e.target.value)}
          />
          {/* O aviso fica **ao lado do campo**, e não no rodapé da tela: quem
              escreve precisa saber enquanto escreve. */}
          <span className="text-sm text-atencao">{A_OBSERVACAO_SAI_NA_EXPORTACAO}</span>
        </label>

        {erro && (
          <p role="alert" className="text-corpo text-despesa">
            {erro}
          </p>
        )}

        {registrar.data && (
          <p role="status" className="consequencia text-corpo text-ink-1">
            Baixa registrada. A assinatura está {registrar.data.estado.replace('_', ' ')}.
          </p>
        )}

        <div className="flex items-center gap-16 border-t border-line pt-16">
          <button
            className="botao botao--primario"
            type="submit"
            disabled={!camposCompletos || !avaliacao.podeEnviar || registrar.isPending}
          >
            {registrar.isPending ? 'registrando…' : 'registrar a baixa'}
          </button>
          <span className="text-sm text-ink-3">
            duas linhas no registro: a intenção e o efeito, com o de → para
          </span>
        </div>
      </form>
    </section>
  )
}

/**
 * A referência já usada.
 *
 * Critério de aceite 3 do ticket, literal: *"mostra a linha existente e a data
 * em que foi registrada — nunca 'erro ao salvar'"*. O botão fica desabilitado
 * porque o índice único vai recusar; mandar para receber `409` trocaria um fato
 * conhecido por uma mensagem de restrição violada.
 */
function Repetida({ baixa }: { readonly baixa: BaixaAnterior }) {
  return (
    <div role="alert" className="consequencia consequencia--muda-acesso">
      <p className="text-corpo text-ink-1">
        Esta referência já foi registrada para este cliente, em{' '}
        <strong>{dataEHoraNaTela(baixa.registrado_em)}</strong>.
      </p>
      <p className="mt-4 text-corpo text-ink-2">
        <Valor centavos={baixa.valor_centavos} moeda={baixa.moeda} saldo /> recebidos em{' '}
        {dataNaTela(baixa.recebido_em)}, competência {competenciaPorExtenso(baixa.competencia)}.
      </p>
      <p className="mt-4 text-sm text-ink-3">
        Se o pagamento é outro, use a referência dele. Se é o mesmo, ele já está registrado.
      </p>
    </div>
  )
}

/**
 * A semelhança — mesma quantia, mesma competência, referência diferente.
 *
 * Sugestão, nunca sobrescrita: a tela mostra e pergunta. O operador pode ter
 * recebido duas vezes a mesma quantia no mesmo mês, e isso é legítimo.
 *
 * **O limite honesto:** esta verificação é da tela. A pré-checagem que a §8.2 c
 * do spec especifica — `PAGAMENTO_SEMELHANTE` levantado pela função e
 * `confirmado_semelhante` gravado na linha de auditoria — não existe na função
 * nem na rota. Dois operadores simultâneos passam pelos dois lados desta
 * verificação sem se ver, e a confirmação abaixo **não vai para o registro**.
 */
function Semelhantes({
  baixas,
  confirmou,
  aoConfirmar,
}: {
  readonly baixas: readonly BaixaAnterior[]
  readonly confirmou: boolean
  aoConfirmar(v: boolean): void
}) {
  return (
    <div className="consequencia consequencia--muda-acesso">
      <p className="text-corpo text-ink-1">
        {baixas.length === 1
          ? 'Já existe uma baixa com esta mesma quantia nesta mesma competência, com outra referência.'
          : `Já existem ${baixas.length} baixas com esta mesma quantia nesta mesma competência, com outras referências.`}
      </p>

      <ul className="mt-8 flex flex-col gap-4">
        {baixas.map((b) => (
          <li key={b.id} className="text-corpo text-ink-2">
            <Valor centavos={b.valor_centavos} moeda={b.moeda} saldo /> · referência{' '}
            <span className="identificador">{b.referencia_externa}</span> · registrada em{' '}
            {dataEHoraNaTela(b.registrado_em)}
          </li>
        ))}
      </ul>

      <label className="mt-12 flex items-start gap-8 text-corpo text-ink-1">
        <input
          type="checkbox"
          checked={confirmou}
          onChange={(e) => aoConfirmar(e.target.checked)}
        />
        <span>
          Conferi os comprovantes: são pagamentos distintos, e este ainda não foi registrado.
        </span>
      </label>
    </div>
  )
}
