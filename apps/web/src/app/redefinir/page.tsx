'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useState, type FormEvent } from 'react'
import { api, ErroDaApi } from '../../api/cliente'

/**
 * Escrever a senha nova.
 *
 * A tela diz, **antes** de a pessoa enviar, o que vai acontecer: todas as
 * sessões caem. Não é letra miúda — é a consequência que importa se a conta foi
 * invadida, e alguém precisa saber que os outros aparelhos vão deslogar.
 *
 * Depois de redefinir, a pessoa **entra pela porta da frente**. Emitir sessão
 * aqui pareceria conveniente e daria ao link de recuperação o poder de logar
 * sozinho — que é exatamente o poder que um link vazado teria.
 */
function Formulario() {
  const parametros = useSearchParams()
  const token = parametros.get('t') ?? ''

  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)
  const [pronto, setPronto] = useState<number | null>(null)

  async function enviar(evento: FormEvent) {
    evento.preventDefault()
    setErro(null)
    setEnviando(true)
    try {
      const r = await api.redefinirSenha(token, senha)
      setPronto(r.sessoesEncerradas)
    } catch (e) {
      setErro(e instanceof ErroDaApi ? e.message : 'Não foi possível redefinir agora.')
    } finally {
      setEnviando(false)
    }
  }

  if (pronto !== null) {
    return (
      <>
        <h1 className="mt-8 font-numero text-4 leading-none tracking-tight text-ink-0">
          Senha trocada
        </h1>
        <p className="mt-24 text-corpo text-ink-1">
          {pronto === 0
            ? 'Não havia nenhuma sessão aberta.'
            : `${pronto} ${pronto === 1 ? 'sessão foi encerrada' : 'sessões foram encerradas'}.`}{' '}
          Entre com a senha nova.
        </p>
        <p className="mt-44">
          <Link className="botao botao--primario justify-center" href="/entrar">
            Entrar
          </Link>
        </p>
      </>
    )
  }

  if (!/^[0-9a-f]{64}$/.test(token)) {
    return (
      <>
        <h1 className="mt-8 font-numero text-4 leading-none tracking-tight text-ink-0">
          Este link está incompleto
        </h1>
        <p className="mt-24 text-corpo text-ink-1">Copie o endereço inteiro do e-mail.</p>
        <p className="mt-44 text-sm text-ink-3">
          <Link className="underline" href="/recuperar">
            Pedir outro link
          </Link>
        </p>
      </>
    )
  }

  return (
    <>
      <h1 className="mt-8 font-numero text-4 leading-none tracking-tight text-ink-0">
        Escolha a senha nova
      </h1>

      <form onSubmit={(e) => void enviar(e)} className="mt-44 flex flex-col gap-20" noValidate>
        <label className="flex flex-col gap-6">
          <span className="rotulo">Senha</span>
          <input
            className="campo"
            type="password"
            autoComplete="new-password"
            autoFocus
            minLength={12}
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            required
          />
          <span className="text-sm text-ink-3">Ao menos 12 caracteres. Uma frase serve.</span>
        </label>

        {/* Dito antes, e não depois. Se a conta foi invadida, é o que a pessoa
            precisa saber para entender o que vai acontecer nos outros
            aparelhos. */}
        <p className="text-sm text-ink-3">
          Trocar a senha encerra todas as sessões abertas, em todos os aparelhos.
        </p>

        {erro && (
          <p role="alert" className="text-corpo text-despesa">
            {erro}
          </p>
        )}

        <button className="botao botao--primario justify-center" type="submit" disabled={enviando}>
          {enviando ? 'Trocando…' : 'Trocar a senha'}
        </button>
      </form>
    </>
  )
}

export default function Redefinir() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[420px] flex-col justify-center px-24">
      <p className="rotulo">Mavia</p>
      <Suspense fallback={null}>
        <Formulario />
      </Suspense>
    </main>
  )
}
