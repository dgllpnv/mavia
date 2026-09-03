'use client'

import { useMutation } from '@tanstack/react-query'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { chamar, ErroDaApi } from '../../../../api/cliente'
import { Cartao } from '../../../../componentes/cartao'
import { useSessao } from '../../../../componentes/provedores'

/**
 * Aceitar um convite.
 *
 * A rota vive **dentro** da área autenticada de propósito: aceitar exige estar
 * logado, e o redirecionamento para a entrada já é do layout. Quem chega pelo
 * link sem sessão entra e volta; quem chega com sessão de outra conta recebe a
 * recusa do servidor dizendo que o convite é de outro e-mail — que é a
 * informação de que ele precisa, e não "convite inválido".
 *
 * O aceite acontece com **um toque**, e não sozinho ao abrir a página. Um link
 * que executa uma ação só de ser aberto é um link que um pré-carregador de
 * mensageiro dispara antes de a pessoa ler.
 */
export default function AceitarConvite() {
  const { token } = useParams<{ token: string }>()
  const router = useRouter()
  const { eu, escolherEspaco } = useSessao()
  const [erro, setErro] = useState<string | null>(null)

  const aceitar = useMutation({
    mutationFn: () =>
      chamar<{ tenantId: string; papel: string }>('/convites/aceitar', {
        metodo: 'POST',
        corpo: { token },
      }),
    onSuccess(r) {
      escolherEspaco(r.tenantId)
      // Recarrega para que a lista de espaços da sessão inclua o novo: ele não
      // existia quando `/eu` respondeu.
      window.location.href = '/'
    },
    onError: (e) =>
      setErro(e instanceof ErroDaApi ? e.message : 'Não foi possível aceitar o convite.'),
  })

  useEffect(() => {
    if (!/^[0-9a-f]{64}$/.test(token ?? '')) setErro('Este link de convite não é válido.')
  }, [token])

  return (
    <div className="mx-auto max-w-[520px]">
      <Cartao titulo="Você foi convidado">
        <p className="max-w-[52ch] text-corpo text-ink-2">
          Aceitar dá a você acesso ao espaço de quem convidou, com o papel que
          essa pessoa escolheu. Você continua com o seu próprio espaço.
        </p>
        <p className="mt-12 max-w-[52ch] text-sm text-ink-3">
          Entrando como <strong className="text-ink-2">{eu?.usuario.email}</strong>. O
          convite só funciona para o e-mail a que foi endereçado.
        </p>

        {erro && (
          <p role="alert" className="mt-16 text-corpo text-despesa">
            {erro}
          </p>
        )}

        <div className="mt-24 flex gap-12">
          <button
            className="botao botao--primario"
            onClick={() => {
              setErro(null)
              aceitar.mutate()
            }}
            disabled={aceitar.isPending}
          >
            {aceitar.isPending ? 'aceitando…' : 'aceitar convite'}
          </button>
          <button className="botao" onClick={() => router.replace('/')}>
            agora não
          </button>
        </div>
      </Cartao>
    </div>
  )
}
