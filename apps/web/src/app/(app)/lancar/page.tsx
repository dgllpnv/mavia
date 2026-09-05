'use client'

import { useQuery } from '@tanstack/react-query'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useCallback } from 'react'
import { api } from '../../../api/cliente'
import {
  FormularioDeLancamento,
  naturezaDe,
  type Natureza,
} from '../../../componentes/formulario-de-lancamento'
import { MolduraEmTelaCheia } from '../../../componentes/moldura-de-lancamento'
import { useEspaco } from '../../../componentes/provedores'

/**
 * Lançar — o formulário como **rota**, e não como sobreposição.
 *
 * Decisão 4 do épico do navegador do celular, e o motivo é o teclado: com ele
 * aberto num 390×844 sobram ~380px úteis, e uma folha nesse espaço obriga a
 * rolar dentro de algo que já rola dentro da página. Tela cheia dá ao campo em
 * foco para onde subir, mantém `salvar` alcançável e dá significado ao botão
 * voltar do navegador.
 *
 * **É o mesmo componente do diálogo do computador.** O que muda é a moldura —
 * `MolduraEmTelaCheia` no lugar de `MolduraEmSobreposicao`. Não há um segundo
 * formulário, e não há um segundo lugar onde a validação possa divergir.
 *
 * O tipo vem do endereço porque a aba central do rodapé chama esta rota já
 * sabendo o que a pessoa quer lançar, e porque recarregar a página no meio do
 * preenchimento não pode devolver `despesa` a quem estava lançando uma receita.
 */
export default function Lancar() {
  return (
    // `useSearchParams` exige fronteira de suspense para que o resto da rota
    // possa ser pré-renderizado.
    <Suspense fallback={null}>
      <TelaDeLancar />
    </Suspense>
  )
}

function TelaDeLancar() {
  const espaco = useEspaco()
  const router = useRouter()
  const parametros = useSearchParams()

  const contas = useQuery({
    queryKey: ['contas', espaco.id],
    queryFn: () => api.contas(espaco.id),
  })

  const cartoes = useQuery({
    queryKey: ['cartoes', espaco.id],
    queryFn: () => api.cartoes(espaco.id),
  })

  const categorias = useQuery({
    queryKey: ['categorias', espaco.id],
    queryFn: () => api.categorias(espaco.id),
    staleTime: 5 * 60_000,
  })

  /**
   * Sair da rota volta para onde a pessoa estava.
   *
   * `router.back()` quando há de onde voltar; `/lancamentos` quando não há —
   * quem abriu o endereço direto, ou recarregou, não tem histórico, e
   * `back()` aí jogaria a pessoa para fora do produto.
   */
  const sair = useCallback(() => {
    if (window.history.length > 1) router.back()
    else router.push('/lancamentos')
  }, [router])

  /**
   * A natureza escolhida no formulário vira endereço.
   *
   * `history.replaceState` e não `router.replace`: o objetivo é só manter o
   * endereço honesto para um recarregamento, e uma navegação de verdade
   * remontaria o formulário — apagando a descrição e o valor já digitados.
   */
  const registrarNatureza = useCallback((natureza: Natureza) => {
    window.history.replaceState(null, '', `/lancar?tipo=${natureza}`)
  }, [])

  const falhou = contas.isError || cartoes.isError || categorias.isError

  return (
    <FormularioDeLancamento
      tenantId={espaco.id}
      moldura={MolduraEmTelaCheia}
      naturezaInicial={naturezaDe(parametros.get('tipo'))}
      contas={contas.data?.itens ?? []}
      cartoes={cartoes.data?.itens ?? []}
      categorias={categorias.data?.itens ?? []}
      aoMudarNatureza={registrarNatureza}
      aoFechar={sair}
      {...(falhou
        ? {
            aviso: (
              <p role="alert" className="rounded-2 bg-surface-2 px-12 py-8 text-corpo text-despesa">
                Não foi possível carregar suas contas e categorias. Verifique a
                conexão e recarregue antes de lançar.
              </p>
            ),
          }
        : {})}
    />
  )
}
