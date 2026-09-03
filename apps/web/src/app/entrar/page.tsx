'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'
import { api, ErroDaApi } from '../../api/cliente'
import { useSessao } from '../../componentes/provedores'

/**
 * A entrada.
 *
 * Uma coluna, largura de leitura, sem card e sem ilustração. A tela de login de
 * um produto financeiro não precisa vender nada: quem está aqui já decidiu.
 *
 * A mensagem de erro é **uma só**, e vem do servidor. Distinguir "esse e-mail
 * não existe" de "essa senha está errada" seria útil ao titular e igualmente
 * útil a quem varre endereços — e a decisão de não distinguir é do servidor,
 * não da interface. Aqui ela só é repetida.
 */
export default function Entrar() {
  const { entrar, eu, carregando } = useSessao()
  const router = useRouter()

  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)
  const [googleIndisponivel, setGoogleIndisponivel] = useState(false)

  useEffect(() => {
    if (eu) router.replace('/')
  }, [eu, router])

  /**
   * Começa a entrada pelo Google.
   *
   * A rota devolve a URL e **esta camada navega**. Um 302 numa resposta de
   * `fetch` seria seguido pelo navegador sem que a aplicação visse nada.
   */
  async function comGoogle() {
    setErro(null)
    setEnviando(true)
    try {
      const { url } = await api.entrarComGoogle()
      window.location.href = url
    } catch (e) {
      // 503 é "não está configurado nesta instalação", e é um estado legítimo
      // enquanto o dono do produto não cria o cliente OAuth. A tela diz isso em
      // vez de repetir uma falha genérica.
      if (e instanceof ErroDaApi && e.status === 503) setGoogleIndisponivel(true)
      else setErro(e instanceof ErroDaApi ? e.message : 'Não foi possível entrar agora.')
      setEnviando(false)
    }
  }

  async function enviar(evento: FormEvent) {
    evento.preventDefault()
    setErro(null)
    setEnviando(true)
    try {
      await entrar(email, senha)
      router.replace('/')
    } catch (e) {
      setErro(e instanceof ErroDaApi ? e.message : 'Não foi possível entrar agora.')
    } finally {
      setEnviando(false)
    }
  }

  if (carregando) return null

  return (
    <main className="mx-auto flex min-h-dvh max-w-[420px] flex-col justify-center px-24">
      <p className="rotulo">Mavia</p>
      <h1 className="mt-8 font-numero text-4 leading-none tracking-tight text-ink-0">
        Entre na sua conta
      </h1>

      {/* "Continuar", e não "Entrar com o Google": é a palavra convencional
          para este botão, porque ele serve tanto a quem já tem conta quanto a
          quem está criando uma — e o clique é o mesmo nos dois casos.

          De quebra ela não contém "Entrar", que fazia o localizador dos testes
          casar com dois botões. Um rótulo que é prefixo de outro é ambiguidade
          esperando para acontecer, na tela e no teste.

          O Google vem **antes** do formulário: é um clique contra quatro
          campos, e a ordem da tela deve refletir a ordem do esforço. */}
      <button
        type="button"
        className="botao mt-44 justify-center"
        onClick={() => void comGoogle()}
        disabled={enviando}
      >
        Continuar com o Google
      </button>

      {googleIndisponivel && (
        <p role="alert" className="mt-12 text-sm text-ink-3">
          A entrada pelo Google não está configurada nesta instalação. Use e-mail e senha.
        </p>
      )}

      <p className="mt-24 text-center text-sm text-ink-3">ou</p>

      <form onSubmit={(e) => void enviar(e)} className="mt-24 flex flex-col gap-20" noValidate>
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

        <label className="flex flex-col gap-6">
          <span className="rotulo">Senha</span>
          <input
            className="campo"
            type="password"
            autoComplete="current-password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            required
          />
        </label>

        {/* `role="alert"` e não um texto solto: quem usa leitor de tela precisa
            ouvir a recusa sem ter de sair procurando pela página. */}
        {erro && (
          <p role="alert" className="text-corpo text-despesa">
            {erro}
          </p>
        )}

        <button className="botao botao--primario justify-center" type="submit" disabled={enviando}>
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>
      </form>

      <p className="mt-44 flex flex-col gap-8 text-sm text-ink-3">
        <Link className="underline" href="/recuperar">
          Esqueci minha senha
        </Link>
        <span>
          Ainda não tem conta?{' '}
          <Link className="underline" href="/cadastrar">
            Crie uma
          </Link>
        </span>
      </p>
    </main>
  )
}
