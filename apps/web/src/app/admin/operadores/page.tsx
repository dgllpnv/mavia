'use client'

import type { NivelDeAdmin, OperadorConcedido, OperadorRevogado } from '@mavia/contracts'
import { useMutation } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { painel } from '../../../painel/api'
import { useNivel } from '../../../painel/nivel'
import {
  administraOperadores,
  emailNormalizado,
  emailValido,
  O_QUE_A_REVOGACAO_FAZ,
  oQueAConcessaoFaz,
  POR_QUE_NAO_HA_LISTAGEM,
} from '../../../painel/operadores'
import { CabecalhoDeLeitura, mensagemDoErro } from '../../../painel/pecas'

/**
 * Quem tem acesso ao painel — **conceder e revogar, e nada mais**.
 *
 * ## Não há listagem, e a ausência é a decisão
 *
 * A migration `0031` restringe `mavia_admin` a enxergar a **própria** concessão:
 * *"uma policy ampla entregaria, numa conexão sem segundo fator, a lista de
 * todos os operadores da Mavia com nome e e-mail — que é exatamente o alvo de
 * quem já comprometeu um deles."* A DP-32 revista pôs o painel em produção sem
 * MFA, o que torna o argumento mais forte: hoje a conexão é literalmente essa.
 *
 * Não existe rota que liste, e esta tela não a reconstrói. Conferir uma pessoa
 * continua possível — conceder a quem já é operadora responde `JA_E_OPERADOR`.
 * Enumerar, não. A diferença entre as duas coisas é o ataque.
 *
 * ## O número de cima é o do servidor
 *
 * Em toda tela de leitura do painel o número grande é a contagem que a consulta
 * devolveu. Aqui não há consulta que conte, e o número só existe **depois** de
 * um ato: `operadoresAtivos`, que `admin.conceder_operador` e
 * `admin.revogar_operador` devolvem. Antes disso ele é um traço, e o
 * denominador diz por quê — inventar uma contagem seria a interface afirmando
 * um número que ninguém leu.
 */

export default function Operadores() {
  const { nivel, carregando } = useNivel()
  const [ativos, setAtivos] = useState<number | null>(null)

  return (
    <>
      <CabecalhoDeLeitura
        secao="operadores"
        numero={ativos ?? '—'}
        denominador="operadores ativos, contados pelo banco no último ato desta tela. Não há listagem: a migration 0031 recusa entregar a lista de quem opera a Mavia, e esta tela não a reconstrói."
      />

      <p className="mt-24 max-w-[70ch] text-corpo text-ink-2">{POR_QUE_NAO_HA_LISTAGEM}</p>

      {carregando && (
        <p className="mt-24 text-corpo text-ink-3" aria-live="polite">
          Lendo o seu nível no painel…
        </p>
      )}

      {!carregando && nivel !== null && !administraOperadores(nivel) && <SoOSuper />}

      {!carregando && nivel !== null && administraOperadores(nivel) && (
        <>
          <hr className="regua mt-44" />
          <Conceder aoContar={setAtivos} />
          <hr className="regua mt-44" />
          <Revogar aoContar={setAtivos} />
        </>
      )}
    </>
  )
}

/**
 * O que um operador comum lê aqui.
 *
 * A tela diz o que falta e por quê, em vez de mostrar um formulário que sempre
 * recusa. **Esconder não é o controle** — `admin.conceder_operador` exige `super`
 * de qualquer jeito, e a recusa vem do banco; o que se evita é uma interface que
 * mente, e que ensina o operador a duvidar de todos os outros botões.
 */
function SoOSuper() {
  return (
    <section className="mt-24 max-w-[70ch]">
      <h2 className="rotulo">Conceder e revogar</h2>
      <p className="consequencia mt-8 text-corpo text-ink-1">
        Você opera o painel como operadora, e conceder ou revogar acesso é do superadministrador.
        Não é uma opção escondida: a função no banco recusa com{' '}
        <code>EXIGE_SUPERADMIN</code> mesmo que a requisição saia daqui. Peça a quem é super.
      </p>
    </section>
  )
}

function Conceder({ aoContar }: { aoContar(ativos: number): void }) {
  const [email, setEmail] = useState('')
  const [nivel, setNivel] = useState<NivelDeAdmin>('operador')
  const [erro, setErro] = useState<string | null>(null)
  const [feito, setFeito] = useState<OperadorConcedido | null>(null)

  const conceder = useMutation({
    mutationFn: () => painel.concederOperador(emailNormalizado(email), nivel),
    onSuccess(dados) {
      setFeito(dados)
      aoContar(dados.operadoresAtivos)
      setEmail('')
    },
  })

  async function enviar(e: FormEvent) {
    e.preventDefault()
    setErro(null)
    setFeito(null)
    try {
      await conceder.mutateAsync()
    } catch (erro) {
      setErro(mensagemDoErro(erro))
    }
  }

  return (
    <section className="mt-24 max-w-[70ch]">
      <h2 className="rotulo">Dar acesso ao painel</h2>

      {/* O que a concessão faz, dito antes do botão — e ela é escalada de
          privilégio. O texto muda com o nível escolhido porque as duas
          consequências são diferentes. */}
      <p className="consequencia consequencia--muda-acesso mt-8 text-corpo text-ink-1">
        {oQueAConcessaoFaz(nivel)}
      </p>

      <p className="mt-12 max-w-[70ch] text-corpo text-ink-2">
        A pessoa precisa já ter conta na Mavia. Esta operação não cria identidade nem senha: criar
        conta é ato de quem vai ser dono dela.
      </p>

      <form className="mt-24 flex flex-col gap-20" onSubmit={(e) => void enviar(e)}>
        <div className="grid grid-cols-[2fr_1fr] gap-16">
          <label className="flex flex-col gap-6">
            <span className="rotulo">E-mail</span>
            <input
              className="campo"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                setErro(null)
                setFeito(null)
              }}
              maxLength={320}
              autoComplete="off"
              required
            />
            {/* Por e-mail, nunca por id: um UUID colado do lugar errado torna
                administrador alguém que o operador nem sabe quem é. */}
            <span className="text-sm text-ink-3">
              O endereço da conta dela, e nunca o identificador: um UUID ninguém confere a olho.
            </span>
          </label>

          <label className="flex flex-col gap-6">
            <span className="rotulo">Nível</span>
            {/* `as` sobre `e.target.value`: o DOM tipa o valor de um `select`
                como `string`, e as duas opções abaixo são exatamente os dois
                valores de `nivel_de_admin`. */}
            <select
              className="campo"
              value={nivel}
              onChange={(e) => setNivel(e.target.value as NivelDeAdmin)}
            >
              <option value="operador">operadora</option>
              <option value="super">superadministradora</option>
            </select>
          </label>
        </div>

        {erro && (
          <p role="alert" className="text-corpo text-despesa">
            {erro}
          </p>
        )}

        {feito && (
          <p role="status" className="consequencia text-corpo text-ink-1">
            Acesso concedido. São {feito.operadoresAtivos} operadores ativos agora — a contagem é do
            banco, no mesmo ato.
          </p>
        )}

        <div className="flex items-center gap-16 border-t border-line pt-16">
          <button
            className="botao botao--primario"
            type="submit"
            disabled={!emailValido(email) || conceder.isPending}
          >
            {conceder.isPending ? 'concedendo…' : 'conceder acesso'}
          </button>
          <span className="text-sm text-ink-3">
            uma linha no registro, com quem concedeu e o e-mail no ato
          </span>
        </div>
      </form>
    </section>
  )
}

function Revogar({ aoContar }: { aoContar(ativos: number): void }) {
  const [email, setEmail] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [feito, setFeito] = useState<OperadorRevogado | null>(null)

  const revogar = useMutation({
    mutationFn: () => painel.revogarOperador(emailNormalizado(email)),
    onSuccess(dados) {
      setFeito(dados)
      aoContar(dados.operadoresAtivos)
      setEmail('')
    },
  })

  async function enviar(e: FormEvent) {
    e.preventDefault()
    setErro(null)
    setFeito(null)
    try {
      await revogar.mutateAsync()
    } catch (erro) {
      setErro(mensagemDoErro(erro))
    }
  }

  return (
    <section className="mt-24 max-w-[70ch]">
      <h2 className="rotulo">Tirar o acesso</h2>

      <p className="consequencia consequencia--muda-acesso mt-8 text-corpo text-ink-1">
        {O_QUE_A_REVOGACAO_FAZ}
      </p>

      <form className="mt-24 flex flex-col gap-20" onSubmit={(e) => void enviar(e)}>
        <label className="flex max-w-[420px] flex-col gap-6">
          <span className="rotulo">E-mail</span>
          <input
            className="campo"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              setErro(null)
              setFeito(null)
            }}
            maxLength={320}
            autoComplete="off"
            required
          />
          {/* Revogar a si mesmo é permitido de propósito, e a tela diz isso:
              quem percebe que a própria conta foi comprometida precisa poder se
              desligar sem esperar por outra pessoa. */}
          <span className="text-sm text-ink-3">
            Pode ser o seu próprio endereço — quem percebe que a própria conta foi comprometida se
            desliga sem esperar por ninguém.
          </span>
        </label>

        {erro && (
          <p role="alert" className="text-corpo text-despesa">
            {erro}
          </p>
        )}

        {feito && (
          <p role="status" className="consequencia text-corpo text-ink-1">
            Acesso encerrado. Sobraram {feito.operadoresAtivos} operadores ativos.
          </p>
        )}

        <div className="flex items-center gap-16 border-t border-line pt-16">
          <button
            className="botao botao--discreto"
            type="submit"
            disabled={!emailValido(email) || revogar.isPending}
          >
            {revogar.isPending ? 'revogando…' : 'revogar acesso'}
          </button>
        </div>
      </form>
    </section>
  )
}
