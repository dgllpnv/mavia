'use client'

import type { PerfilDoCliente } from '@mavia/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { painel } from '../../../../painel/api'
import { usePainel } from '../../../../painel/contexto'
import { dataEHoraNaTela, dataNaTela, diasEntre } from '../../../../painel/formatos'
import type { Hipotese } from '../../../../painel/hipotese'
import { CabecalhoDeLeitura, Estado, mensagemDoErro } from '../../../../painel/pecas'

/**
 * O perfil do cliente.
 *
 * ## A razão de esta tela existir com esta forma
 *
 * **`fim_efetivo` e `periodo_fim` aparecem lado a lado.** Ver os dois é o ponto,
 * e ele veio do gate financeiro (achados FC-2 e FC-3): sem a cortesia visível ao
 * lado do fim do ciclo, o operador que acabou de conceder trinta dias não tem
 * como ver que concedeu — e concede de novo, e a cortesia passa a valer zero.
 *
 * `fim_efetivo = greatest(periodo_fim, coalesce(cortesia_ate, periodo_fim))` é
 * derivado no `SELECT`, nunca coluna. `periodo_fim` é o que o webhook da Stripe
 * escreve; `cortesia_ate` é o que o painel escreve, e são colunas diferentes de
 * propósito — um `UPDATE` em `periodo_fim` seria apagado pela próxima fatura,
 * sem uma linha de auditoria (achado F-12).
 *
 * A grade é **assimétrica**, 3:2. Os dois números não têm o mesmo peso: quem
 * decide o direito de uso é o efetivo.
 */

export default function Perfil() {
  const { tenantId } = useParams<{ tenantId: string }>()
  const { hipoteseDe } = usePainel()
  const hipotese = hipoteseDe(tenantId)

  const perfil = useQuery({
    queryKey: ['painel', 'perfil', tenantId],
    queryFn: () => painel.perfil(tenantId, hipotese!),
    enabled: hipotese !== null,
  })

  const cliente = perfil.data ?? null

  return (
    <>
      <CabecalhoDeLeitura
        secao="perfil"
        numero={perfil.isPending ? '—' : (cliente?.nome ?? 'não encontrado')}
        denominador="Uma linha lida do contrato deste cliente. Abrir esta tela virou uma linha do registro, com o motivo, a referência e a rota."
      />

      <div className="mt-24">
        <Estado
          carregando={perfil.isPending}
          erro={perfil.error}
          vazio={cliente === null}
          textoDoVazio={
            <>
              Nenhum espaço com este identificador. Ou ele nunca existiu, ou foi excluído — a
              listagem só mostra espaços com <code>deleted_at</code> nulo.
            </>
          }
        >
          {cliente && <Contrato cliente={cliente} />}
          {cliente && hipotese && (
            <TempoConcedido tenantId={tenantId} hipotese={hipotese} estado={cliente.estado} />
          )}
        </Estado>
      </div>
    </>
  )
}

function Contrato({ cliente }: { readonly cliente: PerfilDoCliente }) {
  const cortesia =
    cliente.cortesia_ate && cliente.periodo_fim
      ? diasEntre(new Date(cliente.periodo_fim), new Date(cliente.cortesia_ate))
      : 0

  return (
    <>
      <div className="par-de-fins">
        <div>
          <p className="rotulo">Fim efetivo</p>
          <p className="fim-efetivo mt-4">
            {cliente.fim_efetivo ? dataNaTela(cliente.fim_efetivo) : '—'}
          </p>
          <p className="mt-4 max-w-[42ch] text-sm text-ink-3">
            É este o dia que decide o direito de uso. Todo caminho que decidir expiração lê este
            valor, nunca o fim do ciclo cru.
          </p>
        </div>

        <div>
          <p className="rotulo">Fim do ciclo</p>
          <p className="fim-do-ciclo mt-4">
            {cliente.periodo_fim ? dataNaTela(cliente.periodo_fim) : '—'}
          </p>
          <p className="mt-4 max-w-[38ch] text-sm text-ink-3">
            O que o provedor de pagamento escreve. O painel não o edita — e é por isso que a
            cortesia mora em coluna própria.
          </p>
        </div>
      </div>

      <hr className="regua mt-16" />

      {/* A cortesia dita em dias, e não só como data: "até 15 de novembro" não
          responde "quanto foi concedido", que é a pergunta de quem está prestes
          a conceder de novo. */}
      <p className="mt-16 max-w-[70ch] text-corpo text-ink-2">
        {cortesia > 0 ? (
          <>
            Este espaço tem <strong className="text-ink-0">{cortesia} dias de cortesia</strong> além
            do fim do ciclo, até {cliente.cortesia_ate ? dataNaTela(cliente.cortesia_ate) : '—'}.
            O teto é de 30 dias por concessão e 60 acumulados no mesmo período.
          </>
        ) : (
          <>Nenhuma cortesia concedida neste período. O fim efetivo é o próprio fim do ciclo.</>
        )}
      </p>

      {cliente.graca_ate && (
        <p className="consequencia consequencia--muda-acesso mt-16 max-w-[70ch] text-corpo text-ink-1">
          Em atraso, com graça até {dataNaTela(cliente.graca_ate)}. A escrita continua funcionando
          até lá.
        </p>
      )}

      <dl className="mt-24 grid max-w-[720px] grid-cols-[auto_1fr] gap-x-24 gap-y-8 text-corpo">
        <dt className="rotulo self-baseline">Plano</dt>
        <dd className="text-ink-1">{cliente.plano ?? 'sem assinatura'}</dd>

        <dt className="rotulo self-baseline">Estado</dt>
        <dd className="text-ink-1">{cliente.estado?.replace('_', ' ') ?? 'sem assinatura'}</dd>

        <dt className="rotulo self-baseline">Espaço criado em</dt>
        <dd className="text-ink-1 tabular-nums">{dataEHoraNaTela(cliente.criado_em)}</dd>

        <dt className="rotulo self-baseline">Identificador</dt>
        <dd className="identificador">{cliente.id}</dd>
      </dl>

      {/*
        DP-40, escrito para o operador e não só para o spec. A ação não existe, e
        dizer para onde ela foi é o que evita o chamado "onde fica o botão".
      */}
      <p className="mt-24 max-w-[70ch] text-sm text-ink-3">
        Não há como trocar plano ou intervalo por aqui, e não é um controle de permissão: a ação não
        existe no painel. O cliente troca pela própria tela de plano, que é onde a regra do
        rebaixamento no meio do ciclo já está implementada. Cota também não se edita — vive no
        catálogo em código, porque uma cota mudada em produção muda o produto para todo mundo. O
        desconto deste cliente fica na aba ao lado, e o preço-base dos planos em preços.
      </p>
    </>
  )
}

/**
 * Conceder tempo — as duas escritas de contrato.
 *
 * São **duas funções e não uma** porque são dois atos com nomes diferentes, com
 * estados exigidos e tetos diferentes:
 *
 * | Ato | Estado | Teto |
 * |---|---|---|
 * | prorrogar o teste | `teste` | **sem teto e repetível** desde 2026-09-05 |
 * | conceder cortesia | `ativa`, `em_atraso`, `cancelada` | +30 por vez, +60 acumulados |
 *
 * `expirada` é recusado nas duas: dar tempo a quem já expirou é reativar sem
 * pagamento, e reativar é ato do titular. A recusa vem do banco com nome
 * próprio, e a API a traduz — a tela mostra a frase que chegou.
 */
function TempoConcedido({
  tenantId,
  hipotese,
  estado,
}: {
  readonly tenantId: string
  readonly hipotese: Hipotese
  readonly estado: string | null
}) {
  const fila = useQueryClient()
  const [dias, setDias] = useState(7)
  const [razao, setRazao] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  const ehTeste = estado === 'teste'
  const aceita = ehTeste || estado === 'ativa' || estado === 'em_atraso' || estado === 'cancelada'
  // **Prorrogação e cortesia deixaram de compartilhar o teto**, e é decisão de
  // produto, não simetria perdida: uma estende um teste grátis, a outra
  // compensa um cliente pagante. O dono derrubou o teto da primeira em
  // 2026-09-05; o da segunda continua em pé (30 por vez, 60 acumulados).
  //
  // 3650 não é política: é guarda de digitação — a diferença entre "trinta" e
  // "trinta mil porque o zero grudou". A API repete a mesma faixa, e é ela que
  // vale; isto aqui evita a ida ao servidor para recusar o óbvio.
  const teto = ehTeste ? 3650 : 30

  const conceder = useMutation({
    mutationFn: () =>
      ehTeste
        ? painel.prorrogarTeste(tenantId, hipotese, dias, razao.trim())
        : painel.concederCortesia(tenantId, hipotese, dias, razao.trim()),
    onSuccess: () => void fila.invalidateQueries({ queryKey: ['painel', 'perfil', tenantId] }),
  })

  if (!aceita) {
    return (
      <section className="mt-44 max-w-[70ch]">
        <h2 className="rotulo">Conceder tempo</h2>
        <p className="mt-8 text-corpo text-ink-3">
          {estado === 'expirada'
            ? 'Este espaço já expirou, e dar tempo a quem expirou é reativar sem pagamento. Reativar é ato do titular, pela tela de plano dele.'
            : 'Este estado da assinatura não recebe cortesia.'}
        </p>
      </section>
    )
  }

  async function enviar(e: FormEvent) {
    e.preventDefault()
    setErro(null)
    try {
      await conceder.mutateAsync()
      setRazao('')
    } catch (erro) {
      setErro(mensagemDoErro(erro))
    }
  }

  return (
    <section className="mt-44 max-w-[70ch]">
      <h2 className="rotulo">{ehTeste ? 'Prorrogar o teste' : 'Conceder cortesia'}</h2>

      <p className="mt-8 text-corpo text-ink-2">
        {ehTeste
          ? 'Sem teto, e pode repetir — cada prorrogação soma sobre a anterior. O teste não é prorrogado automaticamente em nenhuma outra circunstância.'
          : 'No máximo trinta dias por concessão e sessenta acumulados no mesmo período. O tempo entra em cortesia, e nunca no fim do ciclo.'}
      </p>

      {/*
        A honestidade que a §8.4 do spec manda dizer, e que o operador precisa
        saber antes de prometer algo ao cliente: hoje nenhum job expira nada.
        Conceder tempo muda o que o cliente lê no perfil dele e não muda o que o
        sistema faz — quem governa o direito de uso é o estado da assinatura.
      */}
      <p className="consequencia mt-16 text-corpo text-ink-2">
        Hoje nenhum processo expira espaço por data. Esta concessão muda o fim efetivo que o cliente
        lê; quem governa o acesso é o estado da assinatura. Não prometa ao cliente que o acesso dele
        vai durar por causa desta operação.
      </p>

      <form className="mt-24 flex flex-col gap-20" onSubmit={(e) => void enviar(e)}>
        <label className="flex max-w-[220px] flex-col gap-6">
          <span className="rotulo">Dias</span>
          <input
            className="campo valor text-right"
            type="number"
            min={1}
            max={teto}
            value={dias}
            onChange={(e) => setDias(Number(e.target.value))}
          />
        </label>

        <label className="flex flex-col gap-6">
          <span className="rotulo">Razão</span>
          <textarea
            className="campo"
            rows={2}
            maxLength={280}
            value={razao}
            onChange={(e) => setRazao(e.target.value)}
            required
          />
          {/* A razão é obrigatória no banco: uma cortesia sem motivo escrito é
              indistinguível de um favor. Ela vai para a linha de auditoria. */}
          <span className="text-sm text-ink-3">
            Vai para o registro, junto com o valor anterior e o novo. De 3 a 280 caracteres.
          </span>
        </label>

        {erro && (
          <p role="alert" className="text-corpo text-despesa">
            {erro}
          </p>
        )}

        {conceder.data && (
          <p role="status" className="consequencia text-corpo text-ink-1">
            Concedido. O fim efetivo passa a {dataNaTela(conceder.data.cortesiaAte)}.
          </p>
        )}

        <div className="flex items-center gap-16 border-t border-line pt-16">
          <button
            className="botao botao--primario"
            type="submit"
            disabled={conceder.isPending || razao.trim().length < 3 || dias < 1 || dias > teto}
          >
            {conceder.isPending ? 'gravando…' : ehTeste ? 'prorrogar' : 'conceder'}
          </button>
          <span className="text-sm text-ink-3">
            duas linhas no registro: a intenção e o efeito, com o de → para
          </span>
        </div>
      </form>
    </section>
  )
}
