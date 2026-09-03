'use client'

import Link from 'next/link'
import { useState, type FormEvent } from 'react'
import { api } from '../../api/cliente'
import { ErroDaApi } from '../../api/cliente'
import { SeletorDeTema } from '../../componentes/seletor-de-tema'

/**
 * O cadastro.
 *
 * **Nada é criado aqui.** A rota grava um pendente e manda um link; a conta
 * nasce quando alguém abre esse link. Uma conta cujo endereço não foi provado
 * não tem canal de recuperação nem canal de notificação de segurança, e num
 * produto que guarda dinheiro isso não é detalhe de cadastro.
 *
 * A tela diz isso em vez de esconder: depois de enviar, o que aparece é "abra
 * seu e-mail", e não "bem-vindo". Prometer uma conta que ainda não existe
 * produz a pessoa que fecha a aba e tenta entrar cinco minutos depois.
 */
export default function Cadastrar() {
  const [email, setEmail] = useState('')
  const [nome, setNome] = useState('')
  const [senha, setSenha] = useState('')
  const [espaco, setEspaco] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)
  const [enviado, setEnviado] = useState(false)

  async function enviar(evento: FormEvent) {
    evento.preventDefault()
    setErro(null)
    setEnviando(true)
    try {
      await api.cadastrar({ email, nome, senha, ...(espaco.trim() ? { espaco } : {}) })
      setEnviado(true)
    } catch (e) {
      setErro(e instanceof ErroDaApi ? e.message : 'Não foi possível cadastrar agora.')
    } finally {
      setEnviando(false)
    }
  }

  if (enviado) {
    return (
      <main className="portico">
        <div className="portico__topo">
        <p className="rotulo">Mavia</p>
        <SeletorDeTema />
      </div>
        <h1 className="portico__titulo">
          Abra seu e-mail
        </h1>
        <p className="mt-24 text-corpo text-ink-1">
          Mandamos um link para <strong className="text-ink-0">{email}</strong>. Ele vale por 24
          horas e só funciona uma vez.
        </p>
        {/* A frase é a mesma que a API devolve, e ela é deliberadamente vaga:
            dizer "esse endereço já tem conta" seria a informação que a resposta
            do servidor se recusa a dar. */}
        <p className="mt-16 text-sm text-ink-3">
          Se este endereço já tiver uma conta, nada foi criado e nada muda — entre por ela.
        </p>
        <p className="mt-44 text-sm text-ink-3">
          <Link className="underline" href="/entrar">
            Voltar para a entrada
          </Link>
        </p>
      </main>
    )
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-[420px] flex-col justify-center px-24">
      <p className="rotulo">Mavia</p>
      <h1 className="portico__titulo">
        Crie sua conta
      </h1>

      <form onSubmit={(e) => void enviar(e)} className="mt-44 flex flex-col gap-20" noValidate>
        <label className="flex flex-col gap-6">
          <span className="rotulo">Nome</span>
          <input
            className="campo"
            autoComplete="name"
            autoFocus
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            required
          />
        </label>

        <label className="flex flex-col gap-6">
          <span className="rotulo">E-mail</span>
          <input
            className="campo"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>

        <label className="flex flex-col gap-6">
          <span className="rotulo">Senha</span>
          <input
            className="campo"
            type="password"
            autoComplete="new-password"
            minLength={12}
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            required
          />
          {/* Sem regra de composição: exigir símbolo produz `Senha@123`, que é
              pior do que uma frase longa. O comprimento é o que importa. */}
          <span className="text-sm text-ink-3">Ao menos 12 caracteres. Uma frase serve.</span>
        </label>

        <label className="flex flex-col gap-6">
          <span className="rotulo">Nome do espaço</span>
          <input
            className="campo"
            placeholder="Meu espaço"
            value={espaco}
            onChange={(e) => setEspaco(e.target.value)}
          />
          <span className="text-sm text-ink-3">
            É onde suas contas e lançamentos vivem. Dá para trocar depois.
          </span>
        </label>

        {erro && (
          <p role="alert" className="text-corpo text-despesa">
            {erro}
          </p>
        )}

        <button className="botao botao--primario justify-center" type="submit" disabled={enviando}>
          {enviando ? 'Enviando…' : 'Criar conta'}
        </button>
      </form>

      <p className="mt-44 text-sm text-ink-3">
        Já tem conta?{' '}
        <Link className="underline" href="/entrar">
          Entre
        </Link>
      </p>
    </main>
  )
}
