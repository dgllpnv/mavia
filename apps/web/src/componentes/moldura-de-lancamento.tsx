'use client'

import type { ComponentType, ReactNode } from 'react'
import { Modal } from './modal'

/**
 * As molduras do formulário de lançamento.
 *
 * O formulário é **um só** — os campos, a validação e o envio vivem inteiros em
 * `formulario-de-lancamento.tsx`. O que muda entre o celular e o computador é a
 * **moldura**: sobreposição sobre a tela de trás no desktop, rota de tela cheia
 * no celular (decisão 4 do épico).
 *
 * Por que a fronteira é aqui e não no miolo: duplicar os campos duplicaria a
 * validação, e uma validação em duas cópias diverge na primeira correção. A
 * moldura, ao contrário, é pura disposição — não sabe o que é um lançamento.
 *
 * O que a moldura decide, e só ela:
 *
 * - onde ficam as três ações (`cancelar`, `salvar e novo`, `salvar`);
 * - se o conteúdo rola dentro de uma caixa ou dentro da página;
 * - se há um fundo escurecido atrás.
 *
 * O que ela **não** decide: nada do que entra no `POST`.
 */

export interface MolduraDeLancamentoProps {
  readonly titulo: string
  /**
   * O `id` do `<form>` do miolo.
   *
   * É o que permite à moldura pôr o `salvar` **fora** do elemento do
   * formulário: `<button type="submit" form="…">` dispara o mesmo `onSubmit` de
   * qualquer lugar do documento. Sem isso, a barra do topo precisaria de um
   * segundo formulário — que é exatamente o que este ticket proíbe.
   */
  readonly formId: string
  readonly salvando: boolean
  aoCancelar(): void
  aoSalvarENovo(): void
  readonly children: ReactNode
}

export type MolduraDeLancamento = ComponentType<MolduraDeLancamentoProps>

/**
 * A moldura do computador: o diálogo de sempre, com as três ações à direita.
 *
 * É o comportamento que o produto já tinha. Nada aqui muda acima de `md`.
 */
export function MolduraEmSobreposicao({
  titulo,
  formId,
  salvando,
  aoCancelar,
  aoSalvarENovo,
  children,
}: MolduraDeLancamentoProps) {
  return (
    <Modal titulo={titulo} aoFechar={aoCancelar}>
      {children}

      {/* `mt-16` reproduz o `gap-16` que estas ações tinham enquanto eram o
          último filho do `<form>`. A distância na tela é a mesma. */}
      <div className="mt-16 flex flex-col gap-12 border-t border-line pt-16 lg:flex-row lg:items-center lg:justify-end">
        <button className="botao" type="button" onClick={aoCancelar}>
          cancelar
        </button>
        <button
          className="botao botao--discreto"
          type="button"
          disabled={salvando}
          onClick={aoSalvarENovo}
        >
          salvar e novo
        </button>
        <button className="botao botao--primario" type="submit" form={formId} disabled={salvando}>
          {salvando ? 'salvando…' : 'salvar'}
        </button>
      </div>
    </Modal>
  )
}

/**
 * A moldura do celular: tela cheia, barra própria, `salvar` sempre alcançável.
 *
 * **Por que tela cheia e não folha** (decisão 4, e o motivo está escrito no
 * épico): com o teclado virtual aberto num 390×844 sobram ~380px úteis. Uma
 * folha nesse espaço obriga a rolar dentro de algo que já rola dentro da
 * página — o gesto que mais falha no navegador do celular.
 *
 * **O que torna `salvar` sempre visível não é `position: fixed`.** Com o
 * teclado aberto, o iOS move os elementos fixos junto com o viewport visual e o
 * Android não; depender disso é depender do navegador. Aqui a garantia é
 * estrutural: a barra é irmã do conteúdo, e **quem rola é o conteúdo**
 * (`flex-1 overflow-y-auto`). O campo em foco sobe dentro do seu próprio
 * contêiner e a barra, que está fora dele, não tem para onde sair.
 *
 * Acima de `md` a moldura sai do modo sobreposto e volta a ser fluxo normal da
 * página — a rota é do celular, mas continua legível se alguém a abrir num
 * computador ou girar o telefone.
 */
export function MolduraEmTelaCheia({
  titulo,
  formId,
  salvando,
  aoCancelar,
  aoSalvarENovo,
  children,
}: MolduraDeLancamentoProps) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-surface-1 lg:static lg:z-auto lg:mx-auto lg:max-w-[640px] lg:rounded-3 lg:border lg:border-[var(--elev-borda)] lg:shadow-[var(--elev-2)]">
      <div
        className="flex flex-none items-center gap-12 border-b border-line px-16 pb-8 lg:px-24"
        // `env(safe-area-inset-top)` porque a moldura cobre a tela inteira e,
        // com `viewportFit: 'cover'`, o topo dela passa por baixo do entalhe.
        // Em navegador sem entalhe o `env()` vale zero e sobra o `--s-8`.
        style={{ paddingTop: 'max(var(--s-8), env(safe-area-inset-top))' }}
      >
        <button className="botao" type="button" onClick={aoCancelar}>
          cancelar
        </button>

        {/*
          Estilo em linha, e não `text-1`: as regras de elemento de
          `globais.css` estão fora de `@layer`, e `h1 { font-size: var(--text-3) }`
          vence o utilitário do Tailwind (a dívida está registrada lá, perto de
          `.portico__titulo`). Um `<h2>` fugiria do problema, mas esta é a
          única tela da rota e o título dela é um `h1`.
        */}
        <h1
          className="min-w-0 flex-1 truncate text-center font-semibold"
          style={{ fontSize: 'var(--text-1)', lineHeight: 'var(--lh-1)' }}
        >
          {titulo}
        </h1>

        <button className="botao botao--primario" type="submit" form={formId} disabled={salvando}>
          {salvando ? 'salvando…' : 'salvar'}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-16 pt-16 pb-24 lg:overflow-visible lg:px-24 lg:pb-24">
        {children}

        {/* `salvar e novo` fica no fim do conteúdo, e não na barra: quem lança
            em lote termina de preencher antes de decidir, e a barra tem espaço
            para dois alvos de toque, não três. */}
        <div className="mt-16 border-t border-line pt-16">
          <button
            className="botao botao--discreto w-full"
            type="button"
            disabled={salvando}
            onClick={aoSalvarENovo}
          >
            salvar e novo
          </button>
        </div>
      </div>
    </div>
  )
}
