/**
 * O ícone de categoria — círculo cheio na cor da raiz, com a inicial dentro.
 *
 * É o elemento que torna o extrato escaneável **antes de ser lido**: a pessoa
 * encontra "as compras de mercado" pela cor, e só então lê a descrição. Era o
 * que a direção anterior removia para ganhar 24px de altura por linha, e é o
 * que o dono do produto pediu de volta.
 *
 * **Inicial, e não um desenho.** Uma biblioteca de ícones obrigaria alguém a
 * escolher um símbolo para cada categoria que o usuário criar — e a escolha
 * seria de quem escreveu o código, não de quem criou a categoria. A inicial é
 * sempre certa, em qualquer idioma, para qualquer nome.
 *
 * A cor é a **da raiz**: as filhas de Alimentação compartilham a cor de
 * Alimentação, senão a lista vira seis tons sem parentesco visível.
 */

export interface IconeDeCategoriaProps {
  readonly nome: string
  readonly cor: string
  /** Transferência não é categoria: ela ganha o glifo de duas setas. */
  readonly transferencia?: boolean
  readonly tamanho?: number
}

export function IconeDeCategoria({
  nome,
  cor,
  transferencia = false,
  tamanho,
}: IconeDeCategoriaProps) {
  const estilo = {
    background: transferencia ? 'var(--ink-3)' : cor,
    ...(tamanho ? { width: tamanho, height: tamanho, fontSize: tamanho * 0.44 } : {}),
  }

  return (
    <span className="icone-categoria" style={estilo} aria-hidden="true">
      {transferencia ? '⇄' : inicial(nome)}
    </span>
  )
}

/**
 * A primeira letra que **é** letra.
 *
 * "1º Aluguel" e "— Sem categoria" existem, e uma inicial que sai `1` ou `—`
 * não ajuda ninguém a reconhecer nada.
 */
function inicial(nome: string): string {
  const letra = [...nome].find((c) => /\p{L}/u.test(c))
  return (letra ?? nome[0] ?? '?').toLocaleUpperCase('pt-BR')
}
