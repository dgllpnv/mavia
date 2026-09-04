'use client'

import type { ReactNode } from 'react'
import { ErroDaApi } from '../api/cliente'
import { RespostaInesperada } from './api'
import { dataEHoraNaTela } from './formatos'
import type { Hipotese } from './hipotese'
import { MOTIVOS } from './hipotese'

/**
 * As peças repetidas do painel.
 *
 * Elas existem para que a mesma pergunta receba a mesma forma em toda tela — e
 * a pergunta do painel é sempre a mesma: *quantos registros eu acabei de ler, e
 * sob que pretexto*.
 */

/**
 * O cabeçalho de uma tela de leitura — o elemento-assinatura do painel.
 *
 * Um número grande, o que ele conta escrito ao lado, e a régua de 2px embaixo.
 * Em toda tela de leitura o número é a **contagem de registros que a consulta
 * devolveu** — o mesmo que o operador acabou de ver, dito de uma vez.
 *
 * Nas telas em que não há o que contar — o perfil é uma linha só — o número é
 * outro e o texto ao lado o nomeia, como o denominador do trilho no produto. A
 * forma nunca muda; o denominador sempre é dito.
 *
 * **O que o denominador não pode afirmar.** Só duas rotas gravam essa contagem
 * na coluna `auditoria.registros`: `admin.listar_clientes` (a busca) e
 * `admin.ler_registro`. As quatro telas de cliente passam por
 * `admin.abrir_espaco`, que não recebe contagem nenhuma — a linha delas tem
 * `registros` nulo. Só o denominador dessas duas telas diz que o número foi
 * para o log; os outros dizem apenas que a tela virou uma linha.
 */
export function CabecalhoDeLeitura({
  secao,
  numero,
  denominador,
  acoes,
}: {
  readonly secao: string
  readonly numero: ReactNode
  readonly denominador: string
  readonly acoes?: ReactNode
}) {
  return (
    <header>
      <div className="flex items-start justify-between gap-24">
        <div>
          <h1 className="rotulo">{secao}</h1>
          <p className="painel-heroi mt-4">{numero}</p>
        </div>
        {acoes && <div className="flex items-center gap-8 pt-8">{acoes}</div>}
      </div>
      <p className="mt-4 max-w-[64ch] text-sm text-ink-3">{denominador}</p>
      <hr className="regua mt-16" />
    </header>
  )
}

/**
 * A hipótese em curso, no alto de toda tela do espaço de um cliente.
 *
 * Fica visível o tempo todo porque o operador precisa lembrar sob que pretexto
 * está lendo. Um portão que se atravessa e se esquece é um portão que só
 * atrasa; visível, ele é a pergunta que continua sendo feita.
 */
export function HipoteseEmCurso({
  hipotese,
  aoFechar,
}: {
  readonly hipotese: Hipotese
  aoFechar(): void
}) {
  const rotulo = MOTIVOS.find(([v]) => v === hipotese.motivo)?.[1] ?? hipotese.motivo

  return (
    <div className="hipotese-em-curso">
      <span>
        espaço aberto como <strong className="text-ink-1">{rotulo}</strong>, referência{' '}
        <strong className="text-ink-1">{hipotese.referencia}</strong>
      </span>
      <span aria-hidden="true">·</span>
      <span>cada tela que você abrir vira uma linha do registro</span>
      <button className="botao ml-auto text-sm" onClick={aoFechar}>
        fechar o espaço
      </button>
    </div>
  )
}

/**
 * Os quatro estados, num lugar só: carregando, erro, vazio e sucesso.
 *
 * O vazio é o mais esquecido e recebe texto próprio em cada chamada — "nenhum
 * item encontrado" desperdiça a única frase que a tela tem para dizer o que
 * fazer.
 *
 * **Nada de `animate-pulse`.** Um esqueleto pulsando é movimento que não explica
 * nada; a palavra "carregando" explica.
 */
export function Estado({
  carregando,
  erro,
  vazio,
  textoDoVazio,
  children,
}: {
  readonly carregando: boolean
  readonly erro: unknown
  readonly vazio: boolean
  readonly textoDoVazio: ReactNode
  readonly children: ReactNode
}) {
  if (carregando) {
    return (
      <p className="py-16 text-corpo text-ink-3" aria-live="polite">
        Carregando…
      </p>
    )
  }

  if (erro) {
    return (
      <p role="alert" className="consequencia py-8 text-corpo text-despesa">
        {mensagemDoErro(erro)}
      </p>
    )
  }

  if (vazio) {
    return <div className="max-w-[60ch] py-16 text-corpo text-ink-3">{textoDoVazio}</div>
  }

  return <>{children}</>
}

/**
 * O texto de um erro, sem inventar tranquilidade.
 *
 * `RespostaInesperada` é 200 com formato errado, e dizer isso poupa a tarde de
 * quem for depurar. `ErroDaApi` já carrega a frase que a API escolheu — as
 * recusas das funções de contrato são regra de negócio ("este estado não aceita
 * baixa manual"), não falha, e reescrevê-las aqui as apagaria.
 */
export function mensagemDoErro(erro: unknown): string {
  if (erro instanceof RespostaInesperada) return erro.message
  if (erro instanceof ErroDaApi) return erro.message
  return 'Não foi possível concluir. Tente de novo; se repetir, o registro tem a hora exata.'
}

/** Um instante do banco, na tela, em `America/Sao_Paulo`. */
export function Instante({ iso }: { readonly iso: string | null }) {
  if (!iso) return <span className="text-ink-3">—</span>
  return <span>{dataEHoraNaTela(iso)}</span>
}
