'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useRef, useState } from 'react'
import { api, ErroDaApi } from '../../../api/cliente'
import { useSessao } from '../../../componentes/provedores'

/**
 * O retorno do Google.
 *
 * O `state` e o `code` chegam na URL porque é assim que o OAuth funciona; o que
 * esta tela faz é entregá-los ao servidor por `POST` e sumir. **Nada é decidido
 * aqui** — nem se a conta existe, nem se pode entrar: isso é da matriz de
 * identidade, que é pura e mora no domínio.
 *
 * O efeito roda **uma vez**, e a trava é explícita. O `state` é de uso único: o
 * `StrictMode` do React monta o componente duas vezes em desenvolvimento, e a
 * segunda chamada encontraria um `state` já consumido — a pessoa veria "não foi
 * possível entrar" logo depois de ter entrado.
 */
function Retorno() {
  const parametros = useSearchParams()
  const router = useRouter()
  const { adotar } = useSessao()
  const jaTentou = useRef(false)

  const [erro, setErro] = useState<string | null>(null)
  const [precisaSenha, setPrecisaSenha] = useState(false)

  useEffect(() => {
    if (jaTentou.current) return
    jaTentou.current = true

    const codigo = parametros.get('code')
    const state = parametros.get('state')

    // O Google devolve `error=access_denied` quando a pessoa desiste na tela
    // dele. Não é falha: é uma escolha, e merece um caminho de volta em vez de
    // uma mensagem de erro.
    if (parametros.get('error')) {
      setErro('Você cancelou a entrada pelo Google.')
      return
    }

    if (!codigo || !state) {
      setErro('O retorno do Google veio incompleto.')
      return
    }

    api
      .retornoDoGoogle(codigo, state)
      .then((r) => {
        adotar(r)
        router.replace(r.destino || '/')
      })
      .catch((e) => {
        // 409 é o caso C4 da matriz: a conta existe e tem credencial própria. É
        // a **única** resposta que revela existência, e ela é deliberada — quem
        // está do outro lado acabou de provar ao Google que controla aquele
        // endereço. A posse do e-mail nunca é prova suficiente para vincular.
        if (e instanceof ErroDaApi && e.status === 409) setPrecisaSenha(true)
        setErro(e instanceof ErroDaApi ? e.message : 'Não foi possível entrar agora.')
      })
  }, [parametros, router, adotar])

  if (erro) {
    return (
      <>
        <h1 className="mt-8 font-numero text-4 leading-none tracking-tight text-ink-0">
          {precisaSenha ? 'Esta conta já existe' : 'Não deu para entrar'}
        </h1>
        <p role="alert" className="mt-24 text-corpo text-ink-1">
          {erro}
        </p>
        <p className="mt-44">
          <Link className="botao botao--primario justify-center" href="/entrar">
            {precisaSenha ? 'Entrar com a senha' : 'Voltar'}
          </Link>
        </p>
      </>
    )
  }

  return (
    <>
      <h1 className="mt-8 font-numero text-4 leading-none tracking-tight text-ink-0">Entrando…</h1>
      <p className="mt-24 text-corpo text-ink-1">Um instante.</p>
    </>
  )
}

export default function RetornoDoGoogle() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[420px] flex-col justify-center px-24">
      <p className="rotulo">Mavia</p>
      <Suspense fallback={null}>
        <Retorno />
      </Suspense>
    </main>
  )
}
