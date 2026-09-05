'use client'

import type { DescontoDoCliente } from '@mavia/contracts'
import type { CodigoDoPlano, Intervalo } from '@mavia/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { CampoDeValor } from '../../../../../componentes/campo-de-valor'
import { Valor } from '../../../../../componentes/valor'
import { painel } from '../../../../../painel/api'
import { usePainel } from '../../../../../painel/contexto'
import {
  aceitaDesconto,
  corpoDoDesconto,
  descontoAtivo,
  digitarPontosBase,
  duracaoPorExtenso,
  estimativa,
  historicoDeDescontos,
  MOTIVO_MAXIMO,
  motivoDaRecusa,
  O_QUE_O_DESCONTO_NAO_FAZ,
  oQueAConcessaoFaz,
  pontosBaseNaTela,
  ROTULO_DA_ESTIMATIVA,
  type CorpoDoDesconto,
  type DuracaoDeDesconto,
  type EspecieDeDesconto,
  type RascunhoDoDesconto,
} from '../../../../../painel/descontos'
import { dataEHoraNaTela } from '../../../../../painel/formatos'
import type { Hipotese } from '../../../../../painel/hipotese'
import { CabecalhoDeLeitura, Estado, mensagemDoErro } from '../../../../../painel/pecas'
import { codigoDoPlano, NOME_DO_PLANO, precoEmVigor } from '../../../../../painel/precos'
import { TabelaRolavel } from '../../../tabela-rolavel'

/**
 * O desconto deste cliente — **ADR 0025 D1**.
 *
 * ## O histórico vem antes do formulário
 *
 * A mesma ordem das baixas, e por uma razão maior aqui: conceder sobre um
 * desconto ativo **substitui** o ativo, na mesma transação. Quem concede sem ver
 * o que já existe está desfazendo uma negociação que não conhece — e o cliente
 * descobre pela fatura.
 *
 * ## A estimativa é rotulada, e o rótulo é o requisito
 *
 * *"≈ R$ 169,92 · valor final confirmado pela Stripe"* está entre aspas na D1
 * porque é ele que impede o operador de tratar o número como o valor cobrado.
 * Quem cobra é a Stripe, sobre um cupom que ela aplica, e o valor final chega
 * pelo webhook. A conta vem inteira de `packages/domain`; esta tela não
 * multiplica percentual nenhum.
 *
 * ## O intervalo que a rota do perfil não devolve
 *
 * `admin.ler_perfil` projeta `plano`, e **não** `intervalo`. Como o desconto
 * incide sobre o preço do par, e o par não é conhecido, a tela mostra a
 * estimativa nos **dois** intervalos do plano contratado e diz por quê. A
 * alternativa seria escolher um — e escolher errado é mostrar ao operador um
 * número que não é o do cliente dele.
 */

const ESPECIES: readonly (readonly [EspecieDeDesconto, string])[] = [
  ['percentual', 'percentual'],
  ['valor', 'quantia fixa'],
]

const DURACOES: readonly (readonly [DuracaoDeDesconto, string])[] = [
  ['uma_vez', 'uma vez'],
  ['meses', 'por alguns meses'],
  ['sempre', 'para sempre'],
]

export default function Descontos() {
  const { tenantId } = useParams<{ tenantId: string }>()
  const { hipoteseDe } = usePainel()
  const hipotese = hipoteseDe(tenantId)

  const descontos = useQuery({
    queryKey: ['painel', 'descontos', tenantId],
    queryFn: () => painel.descontos(tenantId, hipotese!),
    enabled: hipotese !== null,
  })

  /**
   * O perfil, pelo plano e pelo estado.
   *
   * Mesma chave da tela de perfil: se o operador já passou por lá, o TanStack
   * reusa o que está em cache e nenhuma leitura nova acontece.
   */
  const perfil = useQuery({
    queryKey: ['painel', 'perfil', tenantId],
    queryFn: () => painel.perfil(tenantId, hipotese!),
    enabled: hipotese !== null,
  })

  const itens = historicoDeDescontos(descontos.data ?? [])
  const ativo = descontoAtivo(itens)
  const plano = codigoDoPlano(perfil.data?.plano ?? null)

  return (
    <>
      <CabecalhoDeLeitura
        secao="desconto"
        numero={descontos.isPending ? '—' : itens.length}
        denominador="linhas de desconto deste cliente, da mais recente para a mais antiga. Um desconto ativo por espaço: conceder outro revoga o atual, e as duas linhas ficam. Nada é apagado."
      />

      <div className="mt-24">
        <Estado
          carregando={descontos.isPending}
          erro={descontos.error}
          vazio={itens.length === 0}
          textoDoVazio={
            <>
              Este espaço nunca teve desconto. Desconto é por cliente e por negociação — três dias
              sem acesso por culpa nossa, a primeira semana de venda, um acordo. Nada disso versiona
              em código, e é por isso que ele mora aqui.
            </>
          }
        >
          <>
            {ativo && <DescontoAtivo desconto={ativo} plano={plano} />}
            <div className={ativo ? 'mt-32' : ''}>
              <TabelaDeDescontos itens={itens} />
            </div>
          </>
        </Estado>
      </div>

      <hr className="regua mt-44" />

      {hipotese && (
        <Conceder
          tenantId={tenantId}
          hipotese={hipotese}
          ativo={ativo}
          plano={plano}
          estado={perfil.data?.estado ?? null}
          carregandoEstado={perfil.isPending}
        />
      )}

      {hipotese && ativo && <Revogar tenantId={tenantId} hipotese={hipotese} />}
    </>
  )
}

/**
 * O desconto que vale agora, em corpo grande.
 *
 * O número é o protagonista, e o que ele é — percentual ou quantia — está
 * escrito ao lado, não codificado numa cor.
 */
function DescontoAtivo({
  desconto,
  plano,
}: {
  readonly desconto: DescontoDoCliente
  readonly plano: CodigoDoPlano | null
}) {
  return (
    <section>
      <h2 className="rotulo">Desconto ativo</h2>
      <p className="numero-forte mt-4">
        {desconto.especie === 'percentual' ? (
          <>{pontosBaseNaTela(String(desconto.pontos_base ?? 0))}%</>
        ) : (
          <Valor centavos={desconto.valor_centavos ?? '0'} saldo />
        )}
      </p>
      <p className="mt-4 max-w-[64ch] text-corpo text-ink-2">
        {duracaoPorExtenso(desconto.duracao, desconto.meses)}, concedido em{' '}
        {dataEHoraNaTela(desconto.concedido_em)}. Motivo: {desconto.motivo}
      </p>

      <div className="mt-16">
        <EstimativaDoDesconto plano={plano} corpo={comoCorpo(desconto)} />
      </div>
    </section>
  )
}

/**
 * A linha do banco relida como corpo de requisição, só para a estimativa.
 *
 * As colunas são anuláveis porque o `CHECK` `valor_combina_com_especie` é quem
 * garante o par certo; a leitura recompõe o mesmo tipo que o formulário produz,
 * e a estimativa passa a ter um caminho só.
 */
function comoCorpo(d: DescontoDoCliente): CorpoDoDesconto {
  const duracao =
    d.duracao === 'meses'
      ? ({ duracao: 'meses', meses: d.meses ?? 1 } as const)
      : ({ duracao: d.duracao } as const)

  return d.especie === 'percentual'
    ? { especie: 'percentual', pontosBase: d.pontos_base ?? 0, motivo: d.motivo, ...duracao }
    : { especie: 'valor', centavos: d.valor_centavos ?? '0', motivo: d.motivo, ...duracao }
}

/**
 * A estimativa sobre o preço vigente do plano contratado.
 *
 * Lê `precos_vigentes` — a mesma chave da tela de preço, então o cache serve as
 * duas — e cai no catálogo em código quando o par não tem linha, exatamente
 * como o servidor faz.
 */
function EstimativaDoDesconto({
  plano,
  corpo,
}: {
  readonly plano: CodigoDoPlano | null
  readonly corpo: CorpoDoDesconto | null
}) {
  const precos = useQuery({ queryKey: ['painel', 'precos'], queryFn: () => painel.precos() })

  if (!corpo) return null

  if (!plano) {
    return (
      <p className="text-sm text-ink-3">
        Sem estimativa: este espaço não tem um plano do catálogo, e o desconto incide sobre o preço
        de um plano.
      </p>
    )
  }

  if (precos.isPending) {
    return (
      <p className="text-sm text-ink-3" aria-live="polite">
        Lendo o preço vigente para estimar…
      </p>
    )
  }

  const agora = new Date()
  const intervalos: readonly Intervalo[] = ['mensal', 'anual']

  return (
    <div>
      <p className="rotulo">Estimativa sobre o preço vigente</p>
      <ul className="mt-8 flex flex-col gap-4">
        {intervalos.map((intervalo) => {
          const vigor = precoEmVigor(precos.data ?? [], plano, intervalo, agora)
          const e = estimativa(vigor.centavos, corpo)
          return (
            <li key={intervalo} className="text-corpo text-ink-1">
              <span className="text-ink-3">
                {NOME_DO_PLANO[plano]} {intervalo}
              </span>{' '}
              <Valor centavos={vigor.centavos} saldo /> <span aria-hidden="true">→</span>{' '}
              {e ? (
                <>
                  {/* O til é parte da frase que a D1 exige: o número é
                      aproximado, e a tela o diz antes de dizer qualquer outra
                      coisa sobre ele. */}
                  <strong>
                    ≈ <Valor centavos={e.finalCentavos} saldo />
                  </strong>{' '}
                  <span className="text-ink-3">· {ROTULO_DA_ESTIMATIVA}</span>
                </>
              ) : (
                <span className="text-ink-3">sem estimativa</span>
              )}
            </li>
          )
        })}
      </ul>
      <p className="mt-8 max-w-[64ch] text-sm text-ink-3">
        Os dois intervalos aparecem porque o perfil não informa qual deles este cliente contratou.
        O desconto vale para o par que ele tiver — quem aplica é a Stripe, e o valor final vem pelo
        webhook dela.
      </p>
    </div>
  )
}

function TabelaDeDescontos({ itens }: { readonly itens: readonly DescontoDoCliente[] }) {
  return (
    <TabelaRolavel rotulo="Descontos concedidos">
      <table className="tabela">
        <caption className="sr-only">
          Descontos já concedidos a este cliente, com espécie, duração, motivo e revogação
        </caption>
        <thead>
          <tr>
            <th scope="col" className="numero">
              Concedido em
            </th>
            <th scope="col">Espécie</th>
            <th scope="col" className="numero">
              Desconto
            </th>
            <th scope="col">Duração</th>
            <th scope="col">Motivo</th>
            <th scope="col" className="numero">
              Revogado em
            </th>
          </tr>
        </thead>
        <tbody>
          {itens.map((d) => (
            <tr key={d.id}>
              <td className="numero text-ink-2">{dataEHoraNaTela(d.concedido_em)}</td>
              <td className="curta text-ink-2">
                {d.especie === 'percentual' ? 'percentual' : 'quantia fixa'}
              </td>
              <td className="numero">
                {d.especie === 'percentual' ? (
                  <span className="valor">{pontosBaseNaTela(String(d.pontos_base ?? 0))}%</span>
                ) : (
                  <Valor centavos={d.valor_centavos ?? '0'} saldo />
                )}
              </td>
              <td className="curta text-ink-2">{duracaoPorExtenso(d.duracao, d.meses)}</td>
              <td className="text-ink-2">{d.motivo}</td>
              {/* A linha revogada continua aqui, e o estado dela é palavra: "em
                  vigor" e uma data são distinguíveis sem enxergar cor. */}
              <td className="numero text-ink-3">
                {d.revogado_em ? dataEHoraNaTela(d.revogado_em) : 'em vigor'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TabelaRolavel>
  )
}

function Conceder({
  tenantId,
  hipotese,
  ativo,
  plano,
  estado,
  carregandoEstado,
}: {
  readonly tenantId: string
  readonly hipotese: Hipotese
  readonly ativo: DescontoDoCliente | null
  readonly plano: CodigoDoPlano | null
  readonly estado: string | null
  readonly carregandoEstado: boolean
}) {
  const fila = useQueryClient()
  const [rascunho, setRascunho] = useState<RascunhoDoDesconto>({
    especie: 'percentual',
    pontosBase: '0',
    centavos: '0',
    duracao: 'sempre',
    meses: '',
    motivo: '',
  })
  const [erro, setErro] = useState<string | null>(null)

  const corpo = corpoDoDesconto(rascunho)
  const recusa = motivoDaRecusa(rascunho)
  const tocou =
    rascunho.motivo.length > 0 ||
    rascunho.pontosBase !== '0' ||
    rascunho.centavos !== '0' ||
    rascunho.meses !== ''

  const conceder = useMutation({
    mutationFn: () => painel.concederDesconto(tenantId, hipotese, corpo!),
    onSuccess() {
      void fila.invalidateQueries({ queryKey: ['painel', 'descontos', tenantId] })
      setRascunho((r) => ({ ...r, pontosBase: '0', centavos: '0', motivo: '' }))
    },
  })

  function mudar(campos: Partial<RascunhoDoDesconto>) {
    setErro(null)
    setRascunho((r) => ({ ...r, ...campos }))
  }

  if (carregandoEstado) {
    return (
      <p className="mt-24 text-corpo text-ink-3" aria-live="polite">
        Lendo o estado da assinatura para dizer o que a concessão faz…
      </p>
    )
  }

  if (!aceitaDesconto(estado)) {
    return (
      <section className="mt-24 max-w-[70ch]">
        <h2 className="rotulo">Conceder desconto</h2>
        <p className="mt-8 text-corpo text-ink-2">
          Este espaço não tem assinatura, e desconto é um desconto sobre o preço de um plano
          contratado. A função recusa com <code>ASSINATURA_INEXISTENTE</code>.
        </p>
      </section>
    )
  }

  async function enviar(e: FormEvent) {
    e.preventDefault()
    setErro(null)
    try {
      await conceder.mutateAsync()
    } catch (erro) {
      setErro(mensagemDoErro(erro))
    }
  }

  return (
    <section className="mt-24 max-w-[70ch]">
      <h2 className="rotulo">Conceder desconto</h2>

      {/* O que a concessão faz — e com desconto ativo ela **substitui**. A régua
          de atenção reforça; o texto carrega o significado sozinho. */}
      <p
        className={`consequencia mt-8 text-corpo text-ink-1 ${
          ativo ? 'consequencia--muda-acesso' : ''
        }`}
      >
        {oQueAConcessaoFaz(ativo)}
      </p>

      <p className="consequencia mt-12 text-corpo text-ink-2">{O_QUE_O_DESCONTO_NAO_FAZ}</p>

      <form className="mt-24 flex flex-col gap-20" onSubmit={(e) => void enviar(e)}>
        <div className="grid grid-cols-[1fr_1fr] gap-16">
          <label className="flex flex-col gap-6">
            <span className="rotulo">Espécie</span>
            {/* `as` sobre `e.target.value`: o DOM tipa o valor de um `select`
                como `string`, e as opções aqui são exatamente as duas do enum
                do banco — a lista que as renderiza é a mesma que o tipo declara.
                Vale para os outros `select` deste arquivo. */}
            <select
              className="campo"
              value={rascunho.especie}
              onChange={(e) => mudar({ especie: e.target.value as EspecieDeDesconto })}
            >
              {ESPECIES.map(([v, rotulo]) => (
                <option key={v} value={v}>
                  {rotulo}
                </option>
              ))}
            </select>
          </label>

          {rascunho.especie === 'percentual' ? (
            <CampoDePontosBase
              pontosBase={rascunho.pontosBase}
              aoMudar={(pontosBase) => mudar({ pontosBase })}
            />
          ) : (
            <CampoDeValor
              centavos={rascunho.centavos}
              aoMudar={(centavos) => mudar({ centavos })}
              rotulo="Quantia do desconto"
            />
          )}
        </div>

        <div className="grid grid-cols-[1fr_1fr] gap-16">
          <label className="flex flex-col gap-6">
            <span className="rotulo">Duração</span>
            <select
              className="campo"
              value={rascunho.duracao}
              onChange={(e) => mudar({ duracao: e.target.value as DuracaoDeDesconto })}
            >
              {DURACOES.map(([v, rotulo]) => (
                <option key={v} value={v}>
                  {rotulo}
                </option>
              ))}
            </select>
          </label>

          {rascunho.duracao === 'meses' && (
            <label className="flex flex-col gap-6">
              <span className="rotulo">Meses</span>
              <input
                className="campo valor text-right"
                type="number"
                min={1}
                max={120}
                value={rascunho.meses}
                onChange={(e) => mudar({ meses: e.target.value })}
              />
            </label>
          )}
        </div>

        <label className="flex flex-col gap-6">
          <span className="rotulo">Motivo</span>
          <textarea
            className="campo"
            rows={2}
            maxLength={MOTIVO_MAXIMO}
            value={rascunho.motivo}
            onChange={(e) => mudar({ motivo: e.target.value })}
            required
          />
          <span className="text-sm text-ink-3">
            Vai para o registro e fica na linha do desconto. De 8 a {MOTIVO_MAXIMO} caracteres — o
            cliente não o lê, e quem for conferir a negociação daqui a um ano, sim.
          </span>
        </label>

        <div className="consequencia">
          <EstimativaDoDesconto plano={plano} corpo={corpo} />
          {!corpo && (
            <p className="text-sm text-ink-3">
              A estimativa aparece quando o desconto estiver completo.
            </p>
          )}
        </div>

        {/* A recusa aparece assim que **algum** campo foi tocado, e não só
            depois do motivo: o engano mais provável é o percentual acima de
            100%, e esperar pelo último campo para dizer isso faz a pessoa
            reescrever o formulário inteiro. Antes do primeiro toque não há erro
            a apontar — só um formulário em branco. */}
        {recusa && tocou && (
          <p role="alert" className="text-corpo text-atencao">
            {recusa}
          </p>
        )}

        {erro && (
          <p role="alert" className="text-corpo text-despesa">
            {erro}
          </p>
        )}

        {conceder.data && (
          <p role="status" className="consequencia text-corpo text-ink-1">
            Desconto concedido. {ativo ? 'O anterior foi revogado e continua no histórico.' : ''}
          </p>
        )}

        <div className="flex items-center gap-16 border-t border-line pt-16">
          <button
            className="botao botao--primario"
            type="submit"
            disabled={corpo === null || conceder.isPending}
          >
            {conceder.isPending ? 'gravando…' : ativo ? 'substituir o desconto' : 'conceder'}
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
 * O campo de percentual — **em pontos-base, do primeiro dígito ao envio**.
 *
 * Mesma gramática de `CampoDeValor`: o estado é uma string de dígitos, a
 * digitação é da direita para a esquerda, e não existe conversão para `number`
 * com casa decimal em ponto nenhum. `type="text"` e não `number` pela mesma
 * razão de lá: o campo numérico aceita `e`, `+` e notação científica.
 */
function CampoDePontosBase({
  pontosBase,
  aoMudar,
}: {
  readonly pontosBase: string
  aoMudar(pontosBase: string): void
}) {
  return (
    <label className="flex flex-col gap-6">
      <span className="rotulo">Percentual</span>
      <input
        className="campo valor text-right"
        type="text"
        inputMode="numeric"
        value={`${pontosBaseNaTela(pontosBase)} %`}
        onKeyDown={(e) => {
          const proximo = digitarPontosBase(pontosBase, e.key)
          if (proximo !== pontosBase || e.key === 'Backspace') {
            e.preventDefault()
            aoMudar(proximo)
          }
        }}
        onChange={() => undefined}
      />
      <span className="text-sm text-ink-3">
        Em pontos-base inteiros: 15% é 1500. O teto é 100%.
      </span>
    </label>
  )
}

/**
 * Revogar — só existe quando há o que revogar.
 *
 * `admin.revogar_desconto` levanta `SEM_DESCONTO_ATIVO` quando não há nenhum, e
 * é o certo: devolver sucesso deixaria o operador com a impressão de ter
 * desfeito algo. A tela não oferece o botão nesse caso, pelo mesmo motivo.
 */
function Revogar({ tenantId, hipotese }: { readonly tenantId: string; readonly hipotese: Hipotese }) {
  const fila = useQueryClient()
  const [motivo, setMotivo] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  const revogar = useMutation({
    mutationFn: () => painel.revogarDesconto(tenantId, hipotese, motivo.trim()),
    onSuccess() {
      void fila.invalidateQueries({ queryKey: ['painel', 'descontos', tenantId] })
      setMotivo('')
    },
  })

  async function enviar(e: FormEvent) {
    e.preventDefault()
    setErro(null)
    try {
      await revogar.mutateAsync()
    } catch (erro) {
      setErro(mensagemDoErro(erro))
    }
  }

  return (
    <section className="mt-44 max-w-[70ch]">
      <h2 className="rotulo">Revogar o desconto ativo</h2>
      <p className="consequencia consequencia--muda-acesso mt-8 text-corpo text-ink-1">
        O cliente passa a pagar o preço cheio do plano dele a partir do próximo ciclo cobrado. A
        linha não é apagada: ela recebe a data da revogação e continua no histórico.
      </p>

      <form className="mt-16 flex flex-col gap-20" onSubmit={(e) => void enviar(e)}>
        <label className="flex flex-col gap-6">
          <span className="rotulo">Motivo</span>
          <textarea
            className="campo"
            rows={2}
            maxLength={MOTIVO_MAXIMO}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            required
          />
          <span className="text-sm text-ink-3">De 8 a {MOTIVO_MAXIMO} caracteres.</span>
        </label>

        {erro && (
          <p role="alert" className="text-corpo text-despesa">
            {erro}
          </p>
        )}

        <div className="flex items-center gap-16 border-t border-line pt-16">
          <button
            className="botao botao--discreto"
            type="submit"
            disabled={motivo.trim().length < 8 || revogar.isPending}
          >
            {revogar.isPending ? 'revogando…' : 'revogar'}
          </button>
        </div>
      </form>
    </section>
  )
}
