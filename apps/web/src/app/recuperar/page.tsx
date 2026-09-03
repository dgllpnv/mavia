'use client'

import Link from 'next/link'
import { useState, type FormEvent } from 'react'
import { api, ErroDaApi } from '../../api/cliente'

/**
 * Pedir a recuperação.
 *
 * **A tela não sabe se o endereço existe, e não deve saber.** A resposta da API
 * é a mesma nos dois casos, e a interface repete a frase vaga em vez de tentar
 * ser mais prestativa: ser mais prestativa aqui é entregar a lista de clientes.
 *
 * O mesmo vale para a conta que só entra pelo Google. Ela não recebe token — a
 * trava está na função de banco, e é o que impede que a recuperação vire a
 * porta dos fundos da vinculação recusada. Da tela, é indistinguível.
 */
export default function Recuperar() {
  const [email, setEmail] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)
  const [enviado, setEnviado] = useState(false)

  async function enviar(evento: FormEvent) {
    evento.preventDefault()
    setErro(null)
    setEnviando(true)
    try {
      await api.recuperarSenha(email)
      setEnviado(true)
    } catch (e) {
      setErro(e instanceof ErroDaApi ? e.message : 'Não foi possível pedir agora.')
    } finally {
      setEnviando(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-[420px] flex-col justify-center px-24">
      <p className="rotulo">Mavia</p>
      <h1 className="mt-8 font-numero text-4 leading-none tracking-tight text-ink-0">
        {enviado ? 'Abra seu e-mail' : 'Recuperar a senha'}
      </h1>

      {enviado ? (
        <>
          <p className="mt-24 text-corpo text-ink-1">
            Se <strong className="text-ink-0">{email}</strong> puder receber, o link já está a
            caminho. Ele vale por 1 hora e só funciona uma vez.
          </p>
          <p className="mt-16 text-sm text-ink-3">
            Redefinir a senha encerra todas as sessões abertas, em todos os aparelhos.
          </p>
          <p className="mt-44 text-sm text-ink-3">
            <Link className="underline" href="/entrar">
              Voltar para a entrada
            </Link>
          </p>
        </>
      ) : (
        <>
          <form onSubmit={(e) => void enviar(e)} className="mt-44 flex flex-col gap-20" noValidate>
            <label className="flex flex-col gap-6">
              <span className="rotulo">E-mail</span>
              <input
                className="campo"
                type="email"
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>

            {erro && (
              <p role="alert" className="text-corpo text-despesa">
                {erro}
              </p>
            )}

            <button
              className="botao botao--primario justify-center"
              type="submit"
              disabled={enviando}
            >
              {enviando ? 'Enviando…' : 'Mandar o link'}
            </button>
          </form>

          <p className="mt-44 text-sm text-ink-3">
            <Link className="underline" href="/entrar">
              Lembrei, quero entrar
            </Link>
          </p>
        </>
      )}
    </main>
  )
}
