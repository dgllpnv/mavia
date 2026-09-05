'use client'

import type { PrecoCriado, PrecoVigente } from '@mavia/contracts'
import type { CodigoDoPlano, Intervalo } from '@mavia/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { CampoDeValor } from '../../../componentes/campo-de-valor'
import { Valor } from '../../../componentes/valor'
import { painel } from '../../../painel/api'
import { dataEHoraNaTela } from '../../../painel/formatos'
import { CabecalhoDeLeitura, Estado, mensagemDoErro } from '../../../painel/pecas'
import {
  avaliarTroca,
  CODIGOS,
  codigoDoPlano,
  motivoValido,
  NOME_DO_PLANO,
  O_QUE_A_TROCA_FAZ,
  O_QUE_A_TROCA_NAO_FAZ,
  precosEmVigor,
  type PrecoEmVigor,
} from '../../../painel/precos'
import { TabelaRolavel } from '../tabela-rolavel'

/**
 * O preço-base — **ADR 0025 D2**.
 *
 * ## O que vale agora vem antes do formulário
 *
 * Mesma ordem da tela de baixas, e pela mesma razão: quem vai trocar um preço
 * precisa **ver** o preço atual antes de digitar outro. Um formulário no topo
 * transforma "R$ 39,00" numa digitação sem referência, e o erro de uma casa
 * decimal só aparece depois de gravado — numa tabela que não aceita `UPDATE`.
 *
 * ## Seis pares, e nenhum deles fica vazio
 *
 * `precos_vigentes` nasce vazia (migration `0043`), e a leitura cai no catálogo
 * em código. A tabela de vigentes nomeia a origem de cada número em vez de
 * mostrar um traço: um `—` na coluna de preço faria o operador concluir que o
 * plano não tem preço, e ele tem — é o que a vitrine anuncia.
 *
 * ## A confirmação é um passo, e não um aviso
 *
 * A D2 lista quatro controles que substituem o portão de revisão de código, e um
 * deles é *"a tela exige que o operador leia o valor atual, o novo, e a contagem
 * de assinaturas afetadas"*. Ler não é ver de relance: o botão de gravar só
 * existe depois de o par atual → novo aparecer sozinho na tela.
 *
 * A contagem de assinaturas afetadas **vem do servidor**, depois de gravar, e
 * é sempre zero. Ela não é mostrada antes porque não seria a mesma coisa: um
 * número que a interface afirma é um número que ninguém conferiu.
 *
 * ## O que esta tela não tem
 *
 * Cota. A D3 da ADR 0020 vale inteira para cotas — `cotasVigentes` é função pura
 * que decide se um convite passa, e uma cota editada em produção muda o
 * comportamento do produto para todo mundo sem que teste nenhum perceba. Não há
 * rota, não há coluna, não há campo aqui.
 */

const INTERVALOS: readonly (readonly [Intervalo, string])[] = [
  ['mensal', 'mensal'],
  ['anual', 'anual'],
]

export default function Precos() {
  const precos = useQuery({ queryKey: ['painel', 'precos'], queryFn: () => painel.precos() })
  const linhas = precos.data ?? []
  const agora = new Date()

  return (
    <>
      <CabecalhoDeLeitura
        secao="preço-base"
        numero={precos.isPending ? '—' : linhas.length}
        denominador="linhas de preço já criadas. A tabela é append-only: trocar o preço cria uma linha e não altera nenhuma — as anteriores continuam existindo porque é nelas que as assinaturas já contratadas apontam."
      />

      {/* O erro é dito **uma vez**, e não uma vez por tabela: dois `role=alert`
          anunciando a mesma falha é ruído para quem ouve a tela. E, com a
          leitura falhada, o histórico não pode aparecer vazio — "ninguém trocou
          preço ainda" seria uma afirmação sobre dados que não chegaram. */}
      {precos.error ? (
        <p role="alert" className="consequencia mt-24 text-corpo text-despesa">
          {mensagemDoErro(precos.error)}
        </p>
      ) : (
        <>
          <h2 className="rotulo mt-24">O que vale agora</h2>
          <div className="mt-8">
            {/* `vazio` é falso por construção: os seis pares existem sempre, e
                o que muda é a origem do número — tabela ou catálogo. O vazio
                desta tela mora no histórico, que é onde ele significa algo. */}
            <Estado carregando={precos.isPending} erro={null} vazio={false} textoDoVazio={null}>
              <TabelaDeVigentes vigentes={precosEmVigor(linhas, agora)} />
            </Estado>
          </div>

          <hr className="regua mt-44" />

          <h2 className="rotulo mt-24">Histórico</h2>
          <div className="mt-8">
            <Estado
              carregando={precos.isPending}
              erro={null}
              vazio={linhas.length === 0}
              textoDoVazio={
                <>
                  Ninguém trocou preço ainda. Os seis valores acima vêm do catálogo em código, que é
                  a origem — a primeira troca cria a primeira linha desta tabela, e a partir daí o
                  histórico responde &ldquo;quanto custava o Família em março&rdquo; sem arqueologia
                  de <code>git log</code>.
                </>
              }
            >
              <TabelaDoHistorico linhas={linhas} />
            </Estado>
          </div>

          <hr className="regua mt-44" />

          {!precos.isPending && <FormularioDePreco linhas={linhas} agora={agora} />}
        </>
      )}
    </>
  )
}

function TabelaDeVigentes({ vigentes }: { readonly vigentes: readonly PrecoEmVigor[] }) {
  return (
    <TabelaRolavel rotulo="Preços em vigor">
      <table className="tabela">
        <caption className="sr-only">
          O preço em vigor de cada plano e intervalo, com a origem do valor
        </caption>
        <thead>
          <tr>
            <th scope="col">Plano</th>
            <th scope="col">Intervalo</th>
            <th scope="col" className="numero">
              Preço
            </th>
            <th scope="col">Origem</th>
            <th scope="col" className="numero">
              Desde
            </th>
          </tr>
        </thead>
        <tbody>
          {vigentes.map((v) => (
            <tr key={`${v.plano}-${v.intervalo}`}>
              <td className="text-ink-1">{NOME_DO_PLANO[v.plano]}</td>
              <td className="curta text-ink-2">{v.intervalo}</td>
              <td className="numero">
                {/* `saldo`: um preço não é receita nem despesa. O `+` e a tinta
                    verde afirmariam uma direção que este número não tem. */}
                <Valor centavos={v.centavos} saldo />
              </td>
              {/* A origem é palavra, e não um ícone ou uma cor: quem lê precisa
                  saber se aquele número já passou por uma decisão de operador. */}
              <td className="curta text-ink-2">
                {v.origem === 'tabela' ? 'trocado no painel' : 'catálogo em código'}
              </td>
              <td className="numero text-ink-3">
                {v.linha ? dataEHoraNaTela(v.linha.vigente_desde) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TabelaRolavel>
  )
}

function nomeOuCodigo(plano: string): string {
  const codigo = codigoDoPlano(plano)
  return codigo ? NOME_DO_PLANO[codigo] : plano
}

function TabelaDoHistorico({ linhas }: { readonly linhas: readonly PrecoVigente[] }) {
  const ordenadas = linhas
    .slice()
    .sort((a, b) => new Date(b.vigente_desde).getTime() - new Date(a.vigente_desde).getTime())

  return (
    <TabelaRolavel rotulo="Histórico de preços">
      <table className="tabela">
        <caption className="sr-only">
          Todas as linhas de preço já criadas, da mais recente para a mais antiga
        </caption>
        <thead>
          <tr>
            <th scope="col" className="numero">
              Vigente desde
            </th>
            <th scope="col">Plano</th>
            <th scope="col">Intervalo</th>
            <th scope="col" className="numero">
              Preço
            </th>
            <th scope="col">Motivo</th>
            <th scope="col">Criado por</th>
          </tr>
        </thead>
        <tbody>
          {ordenadas.map((l) => (
            <tr key={l.id}>
              <td className="numero text-ink-2">{dataEHoraNaTela(l.vigente_desde)}</td>
              {/* O nome bonito quando o código é um dos três; a string crua
                  quando não é. Uma linha de um plano retirado do catálogo
                  continua no histórico, e ela precisa continuar legível. */}
              <td className="text-ink-1">{nomeOuCodigo(l.plano)}</td>
              <td className="curta text-ink-2">{l.intervalo}</td>
              <td className="numero">
                <Valor centavos={l.valor_centavos} saldo />
              </td>
              <td className="text-ink-2">{l.motivo}</td>
              <td className="identificador">{l.criado_por}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TabelaRolavel>
  )
}

/**
 * A troca — e ela é uma criação.
 *
 * O verbo da tela é "criar", nunca "editar": nenhum papel do painel tem
 * `UPDATE` em `precos_vigentes`, e um botão chamado "salvar" prometeria uma
 * operação que o banco não oferece.
 */
function FormularioDePreco({
  linhas,
  agora,
}: {
  readonly linhas: readonly PrecoVigente[]
  readonly agora: Date
}) {
  const fila = useQueryClient()
  const [plano, setPlano] = useState<CodigoDoPlano>('pessoal')
  const [intervalo, setIntervalo] = useState<Intervalo>('mensal')
  const [centavos, setCentavos] = useState('0')
  const [motivo, setMotivo] = useState('')
  const [conferindo, setConferindo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [criado, setCriado] = useState<PrecoCriado | null>(null)

  const avaliacao = avaliarTroca(linhas, plano, intervalo, centavos, agora)

  /** Mexeu em qualquer campo, a conferência recomeça: ela é sobre estes valores. */
  function mudou<T>(aplicar: (v: T) => void) {
    return (v: T) => {
      setConferindo(false)
      setCriado(null)
      setErro(null)
      aplicar(v)
    }
  }

  const criar = useMutation({
    mutationFn: () =>
      painel.criarPreco({ plano, intervalo, centavos, motivo: motivo.trim() }),
    onSuccess(dados) {
      setCriado(dados)
      setConferindo(false)
      setCentavos('0')
      setMotivo('')
      void fila.invalidateQueries({ queryKey: ['painel', 'precos'] })
    },
  })

  const completo = avaliacao.podeEnviar && motivoValido(motivo)

  async function gravar(e: FormEvent) {
    e.preventDefault()
    setErro(null)
    try {
      await criar.mutateAsync()
    } catch (erro) {
      setErro(mensagemDoErro(erro))
    }
  }

  return (
    <section className="mt-24 max-w-[70ch]">
      <h2 className="rotulo">Trocar o preço de um plano</h2>

      <p className="consequencia mt-8 text-corpo text-ink-1">{O_QUE_A_TROCA_FAZ}</p>
      <p className="consequencia mt-12 text-corpo text-ink-2">{O_QUE_A_TROCA_NAO_FAZ}</p>

      <form className="mt-24 flex flex-col gap-20" onSubmit={(e) => void gravar(e)}>
        <div className="grid grid-cols-[1fr_1fr_1fr] gap-16">
          <label className="flex flex-col gap-6">
            <span className="rotulo">Plano</span>
            {/* `as` sobre `e.target.value`: o DOM tipa o valor de um `select`
                como `string`, e as opções são exatamente `CODIGOS` — a lista
                que as renderiza é a mesma que o tipo declara. Vale também para
                o `select` de intervalo, logo abaixo. */}
            <select
              className="campo"
              value={plano}
              onChange={(e) => mudou(setPlano)(e.target.value as CodigoDoPlano)}
            >
              {CODIGOS.map((p) => (
                <option key={p} value={p}>
                  {NOME_DO_PLANO[p]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-6">
            <span className="rotulo">Intervalo</span>
            <select
              className="campo"
              value={intervalo}
              onChange={(e) => mudou(setIntervalo)(e.target.value as Intervalo)}
            >
              {INTERVALOS.map(([v, rotulo]) => (
                <option key={v} value={v}>
                  {rotulo}
                </option>
              ))}
            </select>
          </label>

          <CampoDeValor centavos={centavos} aoMudar={mudou(setCentavos)} rotulo="Preço novo" />
        </div>

        <label className="flex flex-col gap-6">
          <span className="rotulo">Motivo</span>
          <textarea
            className="campo"
            rows={2}
            maxLength={280}
            value={motivo}
            onChange={(e) => mudou(setMotivo)(e.target.value)}
            required
          />
          <span className="text-sm text-ink-3">
            Vai para a linha de preço e para o registro, com o valor anterior e o novo. De 8 a 280
            caracteres — é o que alguém vai ler daqui a um ano para entender a mudança.
          </span>
        </label>

        {avaliacao.classe === 'igual-ao-vigente' && (
          <div role="alert" className="consequencia consequencia--muda-acesso">
            <p className="text-corpo text-ink-1">
              Este já é o preço vigente de {NOME_DO_PLANO[plano]} {intervalo}.
            </p>
            <p className="mt-4 text-sm text-ink-3">
              Gravar uma linha que não muda nada produziria uma entrada de auditoria dizendo que o
              preço mudou, e quem lesse o histórico depois procuraria uma mudança que não houve. A
              função recusa.
            </p>
          </div>
        )}

        {avaliacao.classe === 'igual-a-origem' && (
          <div className="consequencia consequencia--muda-acesso">
            <p className="text-corpo text-ink-1">
              Este é exatamente o valor que já vem do catálogo em código.
            </p>
            <p className="mt-4 text-sm text-ink-3">
              A gravação é aceita e cria a primeira linha deste par, mas o preço praticado continua
              o mesmo. Se a intenção era mudar o valor, confira o campo.
            </p>
          </div>
        )}

        {erro && (
          <p role="alert" className="text-corpo text-despesa">
            {erro}
          </p>
        )}

        {criado && <PrecoCriadoNaTela criado={criado} />}

        {!conferindo && (
          <div className="flex items-center gap-16 border-t border-line pt-16">
            <button
              className="botao botao--discreto"
              type="button"
              disabled={!completo}
              onClick={() => setConferindo(true)}
            >
              conferir a troca
            </button>
            <span className="text-sm text-ink-3">
              o valor atual e o novo aparecem antes de existir botão de gravar
            </span>
          </div>
        )}

        {conferindo && (
          <div className="border-t border-line pt-16">
            <p className="rotulo">Confira antes de gravar</p>

            <div className="troca mt-12">
              <div>
                <p className="rotulo">Preço atual</p>
                <p className="troca__de mt-4">
                  <Valor centavos={avaliacao.atual.centavos} saldo />
                </p>
                <p className="mt-4 text-sm text-ink-3">
                  {avaliacao.atual.origem === 'tabela'
                    ? 'a linha vigente desta tabela'
                    : 'do catálogo em código — este par ainda não tem linha'}
                </p>
              </div>

              <p className="troca__seta" aria-hidden="true">
                →
              </p>

              <div>
                <p className="rotulo">Preço novo</p>
                <p className="troca__para mt-4">
                  <Valor centavos={centavos} saldo />
                </p>
                <p className="mt-4 text-sm text-ink-3">
                  {NOME_DO_PLANO[plano]} {intervalo}, para contratações a partir de agora
                </p>
              </div>
            </div>

            <p className="consequencia mt-16 text-corpo text-ink-2">
              A contagem de assinaturas afetadas vem do servidor e aparece assim que a linha for
              gravada. Ela é zero por construção: quem já contratou mantém o preço contratado, e não
              existe operação neste painel que migre assinatura viva para preço novo.
            </p>

            <div className="mt-16 flex items-center gap-16">
              <button className="botao botao--primario" type="submit" disabled={criar.isPending}>
                {criar.isPending ? 'gravando…' : 'criar o preço novo'}
              </button>
              <button
                className="botao botao--discreto"
                type="button"
                onClick={() => setConferindo(false)}
              >
                voltar
              </button>
              <span className="text-sm text-ink-3">
                uma linha no registro, com o de → para e o motivo
              </span>
            </div>
          </div>
        )}
      </form>
    </section>
  )
}

/**
 * O que o servidor respondeu.
 *
 * **A contagem é dele, e não da tela** — é a metade do controle que a D2 chama
 * de dizer em voz alta. Por isso ela aparece em corpo grande, com o número que
 * voltou da requisição, e não como uma frase tranquilizadora escrita à mão.
 */
function PrecoCriadoNaTela({ criado }: { readonly criado: PrecoCriado }) {
  return (
    <div role="status" className="consequencia">
      <p className="text-corpo text-ink-1">
        Preço criado.{' '}
        {criado.valorAnterior === null ? (
          <>Este par não tinha linha: até agora valia o catálogo em código.</>
        ) : (
          <>
            O valor anterior era <Valor centavos={criado.valorAnterior} saldo /> e continua na
            tabela, porque é nele que as assinaturas contratadas apontam.
          </>
        )}
      </p>

      <p className="numero-forte mt-12">{criado.assinaturasAfetadas}</p>
      <p className="text-corpo text-ink-2">
        assinaturas afetadas — a contagem é do servidor, não desta tela.
      </p>
    </div>
  )
}
