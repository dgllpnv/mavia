'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useRef, useState } from 'react'
import { api, ErroDaApi } from '../../api/cliente'
import { useSessao } from '../../componentes/provedores'

/**
 * O clique no link de confirmação.
 *
 * A conta nasce **aqui**, e não na tela de cadastro: usuário, espaço e vínculo
 * numa transação só. Quem chegou até aqui provou que controla o endereço, e por
 * isso já sai autenticado — pedir a senha que a pessoa acabou de escolher, dois
 * minutos atrás, seria cerimônia sem ganho.
 *
 * **O efeito roda uma vez, e a trava é explícita.** Sem o `useRef`, o
 * `StrictMode` do React em desenvolvimento monta o componente duas vezes, a
 * confirmação é chamada duas vezes, e a segunda encontra um token já consumido
 * — o usuário veria "este link não vale mais" logo após ele ter valido.
 */
function Confirmacao() {
  const parametros = useSearchParams()
  const router = useRouter()
  const { adotar } = useSessao()
  const token = parametros.get('t') ?? ''
  const jaTentou = useRef(false)
  const [erro, setErro] = useState<string | null>(null)

  useEffect(() => {
    if (jaTentou.current) return
    jaTentou.current = true

    if (!/^[0-9a-f]{64}$/.test(token)) {
      setErro('Este link está incompleto. Copie o endereço inteiro do e-mail.')
      return
    }

    api
      .confirmarCadastro(token)
      .then((eu) => {
        // Adotar **antes** de navegar: sem isto o provedor continua com `eu`
        // nulo, o layout do aplicativo não vê sessão e manda para a entrada —
        // logo depois de a pessoa ter autenticado.
        adotar(eu)
        router.replace('/')
      })
      .catch((e) =>
        setErro(e instanceof ErroDaApi ? e.message : 'Não foi possível confirmar agora.'),
      )
  }, [token, router, adotar])

  if (erro) {
    return (
      <>
        <h1 className="mt-8 font-numero text-4 leading-none tracking-tight text-ink-0">
          Este link não vale mais
        </h1>
        <p role="alert" className="mt-24 text-corpo text-ink-1">
          {erro}
        </p>
        <p className="mt-16 text-sm text-ink-3">
          Links de confirmação valem 24 horas e só funcionam uma vez.
        </p>
        <p className="mt-44 text-sm text-ink-3">
          <Link className="underline" href="/cadastrar">
            Cadastrar de novo
          </Link>
        </p>
      </>
    )
  }

  return (
    <>
      <h1 className="mt-8 font-numero text-4 leading-none tracking-tight text-ink-0">
        Confirmando…
      </h1>
      <p className="mt-24 text-corpo text-ink-1">Um instante.</p>
    </>
  )
}

export default function Confirmar() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[420px] flex-col justify-center px-24">
      <p className="rotulo">Mavia</p>
      {/* `useSearchParams` exige Suspense no App Router; sem ele a página
          inteira vira renderização dinâmica no build. */}
      <Suspense fallback={null}>
        <Confirmacao />
      </Suspense>
    </main>
  )
}
