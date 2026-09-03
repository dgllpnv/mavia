'use client'

import type { Conta, Objetivo } from '@mavia/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { api, chamar, ErroDaApi } from '../../../api/cliente'
import { CampoDeValor } from '../../../componentes/campo-de-valor'
import { Cartao, Vazio } from '../../../componentes/cartao'
import { Modal } from '../../../componentes/modal'
import { useEspaco } from '../../../componentes/provedores'
import { Valor } from '../../../componentes/valor'

/**
 * Objetivos — acúmulo com prazo.
 *
 * **Tela própria, e não uma aba do planejamento.** As duas respondem perguntas
 * diferentes: planejamento é "quanto posso gastar este mês", objetivo é "quanto
 * falta para os R$ 12.000 de dezembro". O ADR 0009 nasceu justamente de as duas
 * terem sido fundidas uma vez, e juntá-las de novo na navegação convidaria o
 * erro de volta. O estado vazio é onde a diferença é dita, porque é onde a
 * pessoa está decidindo qual das duas quer.
 *
 * A barra trava em 100% e o número não: 125% é resposta legítima, e o dado real
 * fica ao lado. Progresso negativo — resgate maior que os aportes — desenha
 * zero e mostra o número com sinal.
 */
export default function Objetivos() {
  const espaco = useEspaco()
  const [criando, setCriando] = useState(false)

  const objetivos = useQuery({
    queryKey: ['objetivos', espaco.id],
    queryFn: () => chamar<{ itens: Objetivo[] }>('/objetivos', { tenantId: espaco.id }),
  })

  const contas = useQuery({
    queryKey: ['contas', espaco.id],
    queryFn: () => api.contas(espaco.id),
    staleTime: 5 * 60_000,
  })

  const itens = objetivos.data?.itens ?? []
  const emAndamento = itens.filter((o) => o.estado === 'ativo')
  const encerrados = itens.filter((o) => o.estado !== 'ativo')
  const nomeDaConta = new Map((contas.data?.itens ?? []).map((c: Conta) => [c.id, c.nome]))

  return (
    <>
      <div className="flex flex-wrap items-center gap-16">
        <h1 className="text-2 font-semibold">Objetivos</h1>
        <button
          className="botao botao--primario ml-auto"
          onClick={() => setCriando(true)}
        >
          + objetivo
        </button>
      </div>

      {objetivos.isPending && <p className="mt-24 text-corpo text-ink-3">Carregando…</p>}

      {objetivos.data && itens.length === 0 && (
        <div className="mt-24 max-w-[700px]">
          <Cartao>
            <Vazio
              acao={
                <button className="botao botao--primario" onClick={() => setCriando(true)}>
                  criar o primeiro objetivo
                </button>
              }
            >
              Um objetivo junta dinheiro ao longo de meses até um alvo — a viagem
              de dezembro, a reserva de emergência. É diferente do planejamento,
              que é mensal e recomeça todo mês: aqui o que interessa é o quanto
              já foi acumulado, não o quanto foi gasto neste mês.
            </Vazio>
          </Cartao>
        </div>
      )}

      {emAndamento.length > 0 && (
        <div className="mt-24 grid gap-16 lg:grid-cols-2">
          {emAndamento.map((o) => (
            <CartaoDoObjetivo
              key={o.id}
              objetivo={o}
              conta={o.contaId ? (nomeDaConta.get(o.contaId) ?? null) : null}
              tenantId={espaco.id}
            />
          ))}
        </div>
      )}

      {encerrados.length > 0 && (
        <>
          <h2 className="mt-32 text-1 font-semibold text-ink-2">Concluídos e vencidos</h2>
          <p className="mt-4 max-w-[70ch] text-sm text-ink-3">
            Concluído é fato com data: um resgate depois disso reduz o valor
            acumulado e não desfaz a conclusão. Vencido é preservado inteiro —
            continua respondendo quanto havia sido juntado quando o prazo
            acabou. Nada é excluído e nada se estende sozinho.
          </p>
          <div className="mt-16 grid gap-16 lg:grid-cols-2">
            {encerrados.map((o) => (
              <CartaoDoObjetivo
                key={o.id}
                objetivo={o}
                conta={o.contaId ? (nomeDaConta.get(o.contaId) ?? null) : null}
                tenantId={espaco.id}
              />
            ))}
          </div>
        </>
      )}

      {criando && (
        <FormularioDeObjetivo
          tenantId={espaco.id}
          contas={contas.data?.itens ?? []}
          aoFechar={() => setCriando(false)}
        />
      )}
    </>
  )
}

function CartaoDoObjetivo({
  objetivo,
  conta,
  tenantId,
}: {
  objetivo: Objetivo
  conta: string | null
  tenantId: string
}) {
  const [editando, setEditando] = useState(false)

  const largura = Math.min(100, Math.max(0, objetivo.consumoBp / 100))
  const percentual = (objetivo.consumoBp / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: objetivo.consumoBp % 100 === 0 ? 0 : 1,
    maximumFractionDigits: objetivo.consumoBp % 100 === 0 ? 0 : 1,
  })

  const cor =
    objetivo.estado === 'concluido'
      ? 'var(--receita)'
      : objetivo.estado === 'vencido'
        ? 'var(--ink-3)'
        : 'var(--marca)'

  const falta = BigInt(objetivo.valorAlvoCentavos) - BigInt(objetivo.progressoCentavos)

  return (
    <>
      <Cartao
        titulo={objetivo.nome}
        acoes={
          <button className="botao botao--discreto" onClick={() => setEditando(true)}>
            editar
          </button>
        }
      >
        <p className="flex items-baseline justify-between gap-12">
          <span className="text-2 font-semibold">
            <Valor centavos={objetivo.progressoCentavos} isolado saldo />
          </span>
          <span className="text-sm text-ink-3">
            {/* `saldo`: o alvo é **estoque**, não movimento. Sem isso ele sai
                como "+R$ 12.000,00" em verde — a tela afirmando uma direção que
                o número não tem, que é exatamente a convenção que o ADR 0009
                recusa carregar para cá. */}
            de <Valor centavos={objetivo.valorAlvoCentavos} saldo />
          </span>
        </p>

        <span className="mt-12 block h-[8px] rounded-1 bg-surface-2" aria-hidden="true">
          <span
            className="block h-full rounded-1"
            style={{ width: `${largura}%`, background: cor }}
          />
        </span>

        <p className="mt-12 flex flex-wrap items-baseline justify-between gap-8 text-sm">
          <span className="font-numero text-ink-1">{percentual}%</span>
          <span className="text-ink-3">
            {objetivo.estado === 'concluido'
              ? 'concluído'
              : objetivo.estado === 'vencido'
                ? 'prazo vencido'
                : falta > 0n
                  ? // O número que a pessoa realmente quer: quanto ainda falta.
                    `faltam ${formatar(falta)}`
                  : 'alvo alcançado'}
          </span>
        </p>

        <p className="mt-12 border-t border-line pt-12 text-sm text-ink-3">
          {conta
            ? `Ancorado em ${conta}: o progresso é o quanto o saldo cresceu desde a criação.`
            : `Por aportes: ${objetivo.aportes} lançamento(s) marcado(s) como aporte.`}
          {objetivo.prazo && ` · prazo ${diaMesAno(objetivo.prazo)}`}
        </p>
      </Cartao>

      {editando && (
        <FormularioDeObjetivo
          tenantId={tenantId}
          contas={[]}
          existente={objetivo}
          aoFechar={() => setEditando(false)}
        />
      )}
    </>
  )
}

function FormularioDeObjetivo({
  tenantId,
  contas,
  existente,
  aoFechar,
}: {
  tenantId: string
  contas: readonly Conta[]
  existente?: Objetivo
  aoFechar(): void
}) {
  const fila = useQueryClient()

  const [nome, setNome] = useState(existente?.nome ?? '')
  const [centavos, setCentavos] = useState(existente?.valorAlvoCentavos ?? '0')
  const [prazo, setPrazo] = useState(existente?.prazo ?? '')
  const [contaId, setContaId] = useState('')
  const [contarOQueJaTem, setContarOQueJaTem] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const salvar = useMutation({
    mutationFn: () => {
      if (BigInt(centavos || '0') <= 0n) throw new ErroDaApi(400, 'Informe o alvo.')

      if (existente) {
        return chamar(`/objetivos/${existente.id}`, {
          metodo: 'PATCH',
          tenantId,
          corpo: { nome, valorAlvoCentavos: centavos, prazo: prazo === '' ? null : prazo },
        })
      }

      return chamar('/objetivos', {
        metodo: 'POST',
        tenantId,
        corpo: {
          nome,
          valorAlvoCentavos: centavos,
          ...(prazo === '' ? {} : { prazo }),
          ...(contaId === ''
            ? {}
            : {
                contaId,
                // Marco zero conta o que já estava na conta; o padrão do
                // servidor é o saldo de agora, que começa o progresso em zero.
                ...(contarOQueJaTem ? { saldoBaseCentavos: '0' } : {}),
              }),
        },
      })
    },
    onSuccess() {
      void fila.invalidateQueries({ queryKey: ['objetivos'] })
      aoFechar()
    },
  })

  const excluir = useMutation({
    mutationFn: () =>
      chamar(`/objetivos/${existente?.id}`, { metodo: 'DELETE', tenantId }),
    onSuccess() {
      void fila.invalidateQueries({ queryKey: ['objetivos'] })
      aoFechar()
    },
  })

  async function enviar(e: FormEvent) {
    e.preventDefault()
    setErro(null)
    try {
      await salvar.mutateAsync()
    } catch (erro) {
      setErro(erro instanceof ErroDaApi ? erro.message : 'Não foi possível salvar.')
    }
  }

  return (
    <Modal
      titulo={existente ? 'Editar objetivo' : 'Novo objetivo'}
      {...(existente
        ? {}
        : {
            subtitulo:
              'Quanto você quer juntar, e até quando. O prazo é opcional — a reserva de emergência não tem data.',
          })}
      largura={480}
      aoFechar={aoFechar}
    >
      <form className="mt-24 flex flex-col gap-20" onSubmit={(e) => void enviar(e)}>
        <label className="flex flex-col gap-6">
          <span className="rotulo">Nome</span>
          <input
            className="campo"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder="Viagem, reserva de emergência…"
            maxLength={80}
            autoFocus
          />
        </label>

        <CampoDeValor centavos={centavos} aoMudar={setCentavos} rotulo="Alvo" />

        <label className="flex flex-col gap-6">
          <span className="rotulo">Prazo (opcional)</span>
          <input
            className="campo"
            type="date"
            value={prazo}
            onChange={(e) => setPrazo(e.target.value)}
          />
        </label>

        {!existente && (
          <>
            <label className="flex flex-col gap-6">
              <span className="rotulo">Como apurar</span>
              <select
                className="campo"
                value={contaId}
                onChange={(e) => setContaId(e.target.value)}
              >
                <option value="">Marcando lançamentos como aporte</option>
                {contas.map((c) => (
                  <option key={c.id} value={c.id}>
                    Pelo saldo de {c.nome}
                  </option>
                ))}
              </select>
            </label>

            {contaId !== '' && (
              <label className="flex items-start gap-8 text-sm text-ink-2">
                <input
                  type="checkbox"
                  checked={contarOQueJaTem}
                  onChange={(e) => setContarOQueJaTem(e.target.checked)}
                  className="mt-2"
                />
                <span>
                  Contar o que já está na conta como progresso. Sem isso, o
                  objetivo começa em zero e mede só o que entrar daqui em diante.
                </span>
              </label>
            )}

            <p className="text-sm text-ink-3">
              A forma de apurar não muda depois. Um objetivo ancorado lê o saldo
              da conta; um por aportes soma os lançamentos que você marcar.
            </p>
          </>
        )}

        {erro && (
          <p role="alert" className="text-corpo text-despesa">
            {erro}
          </p>
        )}

        <div className="flex items-center gap-12 border-t border-line pt-16">
          {existente && (
            <button
              type="button"
              className="botao botao--discreto text-despesa"
              onClick={() => void excluir.mutateAsync()}
            >
              excluir
            </button>
          )}
          <button className="botao ml-auto" type="button" onClick={aoFechar}>
            cancelar
          </button>
          <button className="botao botao--primario" type="submit" disabled={salvar.isPending}>
            {salvar.isPending ? 'salvando…' : 'salvar'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function formatar(centavos: bigint): string {
  const negativo = centavos < 0n
  const absoluto = negativo ? -centavos : centavos
  const reais = absoluto / 100n
  const resto = absoluto % 100n
  return `${negativo ? '−' : ''}R$ ${reais.toLocaleString('pt-BR')},${String(resto).padStart(2, '0')}`
}

/** `AAAA-MM-DD` → `DD/MM/AAAA`. A data já é civil; não passa por fuso. */
function diaMesAno(data: string): string {
  const [ano, mes, dia] = data.split('-')
  return `${dia}/${mes}/${ano}`
}
