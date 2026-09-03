'use client'

import { useEffect, useState } from 'react'

/**
 * O seletor de tema — três estados, e o terceiro é o que costuma faltar.
 *
 * `sistema` não é "claro por padrão": é **seguir o aparelho**, e muda sozinho
 * quando o sistema operacional troca ao anoitecer. Produtos que oferecem só
 * claro/escuro obrigam quem usa o automático do sistema a escolher um dos dois
 * para sempre.
 *
 * ## Como os três estados existem no CSS
 *
 * Os tokens já estavam prontos para isso, e a montagem é o que faz o atributo
 * **vencer nos dois sentidos**:
 *
 * ```css
 * :root                                          → claro
 * @media (prefers-color-scheme: dark) {
 *   :root:not([data-tema='claro']) { … }          → escuro do sistema, a menos
 * }                                                  que o claro seja explícito
 * :root[data-tema='escuro']        { … }          → escuro explícito
 * ```
 *
 * Daí `sistema` ser a **ausência** do atributo, e não um valor dele. Um
 * `data-tema="sistema"` exigiria uma terceira regra dizendo "ignore-me", e
 * regra que existe para ser ignorada é regra que alguém remove por engano.
 */

export type Tema = 'sistema' | 'claro' | 'escuro'

export const CHAVE_DO_TEMA = 'mavia.tema'

const OPCOES: readonly { readonly valor: Tema; readonly nome: string }[] = [
  { valor: 'sistema', nome: 'Sistema' },
  { valor: 'claro', nome: 'Claro' },
  { valor: 'escuro', nome: 'Escuro' },
]

/**
 * Aplica o tema ao documento. Fora do componente porque o script anti-piscada
 * do `layout.tsx` faz exatamente isto **antes** do React existir, e as duas
 * versões precisam concordar — se divergirem, a tela pisca na hidratação.
 */
function aplicar(tema: Tema): void {
  if (tema === 'sistema') document.documentElement.removeAttribute('data-tema')
  else document.documentElement.setAttribute('data-tema', tema)
}

export function SeletorDeTema({ className = '' }: { readonly className?: string }) {
  /**
   * Começa em `null`, e não no valor salvo.
   *
   * O servidor não tem `localStorage`, então renderizar o estado salvo aqui
   * produziria HTML diferente do que o cliente monta — e o React reclamaria de
   * hidratação divergente. O `null` marca "ainda não sei", e o primeiro efeito
   * resolve. A tela **não** pisca por causa disso: quem já pintou o tema certo
   * foi o script do `layout.tsx`, antes de qualquer pixel.
   */
  const [tema, setTema] = useState<Tema | null>(null)

  useEffect(() => {
    const salvo = window.localStorage.getItem(CHAVE_DO_TEMA)
    setTema(salvo === 'claro' || salvo === 'escuro' ? salvo : 'sistema')
  }, [])

  function escolher(novo: Tema) {
    setTema(novo)
    aplicar(novo)
    // `sistema` é a ausência do atributo **e** a ausência da chave: guardar a
    // palavra "sistema" faria o script de carregamento ter um terceiro caso a
    // interpretar, para chegar ao mesmo lugar que a ausência já leva.
    if (novo === 'sistema') window.localStorage.removeItem(CHAVE_DO_TEMA)
    else window.localStorage.setItem(CHAVE_DO_TEMA, novo)
  }

  return (
    <div className={`seletor-de-tema ${className}`.trim()} role="group" aria-label="Tema">
      {OPCOES.map((o) => (
        <button
          key={o.valor}
          type="button"
          className="seletor-de-tema__opcao"
          // `aria-pressed` e não `aria-selected`: são botões alternáveis, não
          // abas. Quem usa leitor de tela ouve "pressionado" no que está ativo.
          //
          // Enquanto o tema é `null` nenhum fica marcado — por um quadro, e é
          // honesto: nesse instante a interface de fato ainda não sabe.
          aria-pressed={tema === o.valor}
          onClick={() => escolher(o.valor)}
        >
          {o.nome}
        </button>
      ))}
    </div>
  )
}

/**
 * O script que roda **antes do primeiro pixel**.
 *
 * Sem ele, quem escolheu claro num sistema escuro vê a tela escura por um
 * quadro e depois ela vira clara. Ler `localStorage` num `useEffect` é tarde
 * demais: o efeito roda depois da pintura, por definição.
 *
 * Vai como string porque precisa ser **síncrono e inline** no `<head>`. É a
 * única coisa deste produto que usa `dangerouslySetInnerHTML`.
 *
 * **A string é literal, sem uma única interpolação** — nem a da constante
 * `CHAVE_DO_TEMA`, que seria segura. Um `${'$'}{…}` aqui obrigaria quem revisa a
 * rastrear a origem do valor para concluir o óbvio; sem nenhum, a inspeção
 * acaba na primeira linha. O teste abaixo trava a duplicação da chave.
 */
export const SCRIPT_ANTI_PISCADA = `
(function () {
  try {
    var t = localStorage.getItem('mavia.tema');
    if (t === 'claro' || t === 'escuro') {
      document.documentElement.setAttribute('data-tema', t);
    }
  } catch (e) {
    /* Modo privativo bloqueia o localStorage. Sem preferência salva, o CSS
       segue o sistema — que é o padrão certo. */
  }
})();
`
