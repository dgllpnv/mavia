'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'
import { ErroDaApi } from '../../api/cliente'
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

  useEffect(() => {
    if (eu) router.replace('/')
  }, [eu, router])

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

      <form onSubmit={enviar} className="mt-44 flex flex-col gap-20" noValidate>
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

      <p className="mt-44 text-sm text-ink-3">
        Ainda não há cadastro por aqui — ele depende do envio de e-mail, que é a
        pendência P-3. No ambiente local, <code className="font-mono">pnpm db:seed</code> cria um
        espaço de demonstração.
      </p>
    </main>
  )
}
