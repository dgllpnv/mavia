'use client'

import { PLANOS, type CodigoDoPlano } from '@mavia/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { chamar, ErroDaApi } from '../../../api/cliente'
import { Cartao } from '../../../componentes/cartao'
import { useSessao } from '../../../componentes/provedores'
import { Valor } from '../../../componentes/valor'

/**
 * Plano e cobrança.
 *
 * ## O que um membro vê, e o que não vê
 *
 * Vê plano, cotas e uso — porque quem esbarra numa cota precisa entender por
 * que o botão recusou. **Não** vê preço pago, meio de pagamento nem documento
 * fiscal, e nenhum dos três chega nesta tela: a API não os manda.
 *
 * ## O contador do teste é honesto desde o primeiro dia
 *
 * "Seu teste vai até 08/09. Não pedimos cartão e não cobramos nada." Sem letra
 * miúda e sem contagem regressiva agressiva — a frase que o spec escreve é a
 * frase que a tela mostra.
 */
export default function Plano() {
  const { espaco } = useSessao()
  const fila = useQueryClient()
  const [erro, setErro] = useState<string | null>(null)
  const [intervalo, setIntervalo] = useState<'mensal' | 'anual'>('mensal')

  const assinatura = useQuery({
    queryKey: ['cobranca', espaco?.id],
    enabled: espaco !== null,
    queryFn: () => chamar<Assinatura>('/cobranca', { tenantId: espaco!.id }),
  })

  const trocar = useMutation({
    mutationFn: (codigo: CodigoDoPlano) =>
      chamar<{ aplicadoEm: string }>('/cobranca/plano', {
        metodo: 'POST',
        tenantId: espaco!.id,
        corpo: { plano: codigo, intervalo },
      }),
    onSuccess: () => void fila.invalidateQueries({ queryKey: ['cobranca'] }),
    onError: (e) => setErro(e instanceof ErroDaApi ? e.message : 'Não foi possível trocar.'),
  })

  const a = assinatura.data
  const ehDono = espaco?.papel === 'proprietario'

  return (
    <>
      <h1 className="text-2 font-semibold">Plano e cobrança</h1>

      {a && <Situacao assinatura={a} />}

      {a && (
        <Cartao titulo="Uso do espaço" className="mt-24">
          <Uso rotulo="Pessoas" atual={a.uso.pessoas} cota={a.cotas.pessoas} />
          <Uso rotulo="Espaços que você administra" atual={a.uso.espacos} cota={a.cotas.espacos} />
          <p className="mt-16 max-w-[70ch] text-sm text-ink-3">
            Pessoas conta membros <strong>e convites pendentes</strong>: um
            convite guarda um lugar, e ele conta enquanto guarda. Lançamentos,
            contas, cartões, categorias, planejamentos e objetivos são{' '}
            <strong>ilimitados</strong> em todos os planos.
          </p>
        </Cartao>
      )}

      <div className="mt-24 flex items-center gap-16">
        <h2 className="text-1 font-semibold">Planos</h2>
        <label className="ml-auto flex items-center gap-8">
          <span className="rotulo">Cobrança</span>
          <select
            className="campo w-auto"
            value={intervalo}
            onChange={(e) => setIntervalo(e.target.value as typeof intervalo)}
          >
            <option value="mensal">mensal</option>
            <option value="anual">anual — dois meses grátis</option>
          </select>
        </label>
      </div>

      {erro && (
        <p role="alert" className="mt-16 text-corpo text-despesa">
          {erro}
        </p>
      )}

      <div className="mt-16 grid gap-16 lg:grid-cols-3">
        {(Object.values(PLANOS)).map((p) => {
          const atual = a?.plano === p.codigo
          const valor = intervalo === 'anual' ? p.anual : p.mensal

          return (
            <Cartao key={p.codigo} titulo={p.nome} className={atual ? 'ring-1 ring-marca' : ''}>
              <p className="font-numero text-3 font-semibold">
                <Valor centavos={valor.centavos.toString()} isolado saldo />
                <span className="ml-6 text-sm font-normal text-ink-3">
                  {intervalo === 'anual' ? '/ano' : '/mês'}
                </span>
              </p>

              <ul className="mt-16 flex flex-col gap-8 text-corpo text-ink-2">
                <li>{p.cotas.pessoas} pessoas no espaço</li>
                <li>
                  {p.cotas.espacos} {p.cotas.espacos === 1 ? 'espaço' : 'espaços'} como
                  proprietário
                </li>
                <li>{Math.round(p.cotas.anexosBytes / 1024 / 1024 / 1024)} GB de anexos</li>
                <li>Lançamentos, contas e cartões ilimitados</li>
              </ul>

              <p className="mt-12 text-sm text-ink-3">
                {p.cotas.conexoes} conexão(ões) bancária(s) —{' '}
                <span className="text-atencao">em desenvolvimento</span>
              </p>

              {ehDono && !atual && (
                <button
                  className="botao botao--primario mt-20"
                  onClick={() => {
                    setErro(null)
                    trocar.mutate(p.codigo)
                  }}
                  disabled={trocar.isPending}
                >
                  mudar para este
                </button>
              )}
              {atual && <p className="mt-20 text-corpo text-ink-3">seu plano atual</p>}
            </Cartao>
          )
        })}
      </div>

      {trocar.data?.aplicadoEm === 'fim_do_periodo' && a && (
        <p className="mt-16 max-w-[70ch] text-corpo text-ink-2">
          A troca vale a partir de {new Date(a.periodoFim).toLocaleDateString('pt-BR')}. Você
          comprou este período inteiro, e ele continua sendo seu — descer de
          plano no meio seria vender doze meses e entregar sete.
        </p>
      )}

      {!ehDono && (
        <p className="mt-24 max-w-[70ch] text-sm text-ink-3">
          Só o proprietário do espaço muda o plano. Você vê as cotas para saber o
          que cabe, e nada sobre pagamento.
        </p>
      )}

      <p className="mt-24 max-w-[70ch] text-sm text-ink-3">
        A cobrança em si ainda não está ligada — falta a credencial da operadora,
        e isso está declarado na pendência P-14. O que já funciona é o estado do
        seu espaço: teste, cotas e a troca de plano.
      </p>
    </>
  )
}

function Situacao({ assinatura }: { assinatura: Assinatura }) {
  const fim = new Date(assinatura.periodoFim).toLocaleDateString('pt-BR')

  if (assinatura.estado === 'teste') {
    return (
      <Cartao titulo="Seu teste" className="mt-24">
        <p className="text-corpo text-ink-1">
          Seu teste vai até <strong>{fim}</strong>. Não pedimos cartão e não
          cobramos nada.
        </p>
        <p className="mt-8 text-sm text-ink-3">
          Durante o teste você usa as cotas do plano Família — dá para convidar
          quem mora com você e ver o produto funcionando de verdade.
        </p>
      </Cartao>
    )
  }

  if (assinatura.estado === 'em_atraso') {
    return (
      <Cartao titulo="O pagamento não passou" className="mt-24">
        <p className="text-corpo text-ink-1">
          <strong>Nada foi bloqueado.</strong> Você tem até{' '}
          {assinatura.gracaAte
            ? new Date(assinatura.gracaAte).toLocaleDateString('pt-BR')
            : fim}{' '}
          para atualizar o cartão, e o produto continua inteiro até lá — leitura
          e escrita.
        </p>
      </Cartao>
    )
  }

  if (assinatura.estado === 'expirada') {
    return (
      <Cartao titulo="Assinatura expirada" className="mt-24">
        <p className="text-corpo text-ink-1">
          A escrita está pausada. <strong>Nada foi apagado</strong>: você
          continua vendo tudo e pode exportar seus dados a qualquer momento.
          Reativar devolve o produto inteiro, com o histórico no lugar.
        </p>
      </Cartao>
    )
  }

  if (assinatura.estado === 'cancelada') {
    return (
      <Cartao titulo="Cancelada" className="mt-24">
        <p className="text-corpo text-ink-1">
          Você continua com tudo até <strong>{fim}</strong> — comprou o período,
          e ele é seu. Depois dessa data a escrita pausa e a leitura continua.
        </p>
      </Cartao>
    )
  }

  return null
}

function Uso({ rotulo, atual, cota }: { rotulo: string; atual: number; cota: number }) {
  const largura = Math.min(100, (atual / Math.max(1, cota)) * 100)
  const cheio = atual >= cota

  return (
    <div className="mb-16 last:mb-0">
      <p className="flex items-baseline justify-between gap-12">
        <span className="text-1">{rotulo}</span>
        <span className="font-numero text-sm text-ink-3">
          {atual} de {cota}
        </span>
      </p>
      <span className="mt-6 block h-[6px] rounded-1 bg-surface-2" aria-hidden="true">
        <span
          className="block h-full rounded-1"
          style={{ width: `${largura}%`, background: cheio ? 'var(--atencao)' : 'var(--marca)' }}
        />
      </span>
    </div>
  )
}

interface Assinatura {
  readonly estado: 'teste' | 'ativa' | 'em_atraso' | 'cancelada' | 'expirada'
  readonly plano: CodigoDoPlano
  readonly intervalo: 'mensal' | 'anual'
  readonly periodoFim: string
  readonly gracaAte: string | null
  readonly precoCentavos: string
  readonly podeEscrever: boolean
  readonly cotas: { pessoas: number; espacos: number; anexosBytes: number; conexoes: number }
  readonly uso: { pessoas: number; espacos: number }
}
