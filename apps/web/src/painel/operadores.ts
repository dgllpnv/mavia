import type { NivelDeAdmin } from '@mavia/contracts'

/**
 * Conceder e revogar acesso ao painel.
 *
 * ## Não existe listagem, e a ausência é a decisão
 *
 * A migration `0031` restringe `mavia_admin` a enxergar a **própria** concessão,
 * com a razão escrita nela: uma policy ampla entregaria, numa conexão sem
 * segundo fator, a lista de todos os operadores da Mavia com nome e e-mail —
 * que é exatamente o alvo de quem já comprometeu um deles. A DP-32 revista pôs
 * o painel em produção **sem MFA**, o que torna o argumento mais forte, não
 * menos: hoje a conexão é literalmente essa.
 *
 * O que se perde é conveniência, e ela tem substituto: conceder e revogar
 * respondem sobre **uma pessoa de cada vez**, pelas recusas `JA_E_OPERADOR` e
 * `NAO_E_OPERADOR`. Dá para conferir alguém; não dá para enumerar todo mundo.
 * A diferença entre as duas coisas é o ataque.
 *
 * Uma tela que montasse a lista "por conveniência" reconstruiria pelo painel
 * exatamente o que o banco recusa a entregar.
 *
 * ## Por e-mail, nunca por id
 *
 * Um UUID vindo de um formulário é um identificador que ninguém confere a olho:
 * colar o errado torna administrador alguém que o operador nem sabe quem é. Um
 * e-mail ele lê antes de clicar.
 */

/** O `max(320)` do Zod da rota. Além disso o endereço não é de ninguém. */
export const EMAIL_MAXIMO = 320

export function emailNormalizado(bruto: string): string {
  return bruto.trim()
}

/**
 * A forma mínima de um endereço, **deliberadamente mais frouxa que a da API**.
 *
 * O Zod valida com uma expressão mais estrita, e a diferença é intencional: uma
 * tela mais estrita que o servidor recusa endereços válidos sem que exista
 * regra que os recuse — e a pessoa fica sem entender por que o botão não liga.
 * Mais frouxa, o pior caso é uma ida ao servidor que volta com a frase dele.
 */
export function emailValido(bruto: string): boolean {
  const e = emailNormalizado(bruto)
  return e.length > 0 && e.length <= EMAIL_MAXIMO && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
}

/**
 * Só `super` concede e revoga.
 *
 * **Esconder o formulário não é o controle** — `admin.conceder_operador` exige
 * `super` de qualquer jeito, e a recusa `EXIGE_SUPERADMIN` vem do banco. O que
 * esta função evita é uma interface que mente: um botão que sempre recusa
 * ensina o operador a duvidar de todos os outros.
 */
export function administraOperadores(nivel: NivelDeAdmin): boolean {
  return nivel === 'super'
}

/** O que conceder faz, dito antes do botão. É escalada de privilégio. */
export function oQueAConcessaoFaz(nivel: NivelDeAdmin): string {
  if (nivel === 'super') {
    return (
      'Esta pessoa passa a operar o painel inteiro e a conceder e revogar acesso ' +
      'a outras pessoas, inclusive a revogar o seu. É o mesmo poder que você ' +
      'está usando agora.'
    )
  }
  return (
    'Esta pessoa passa a abrir o espaço de qualquer cliente, ler o registro de ' +
    'auditoria e escrever em contrato. O que ela não faz é conceder acesso a ' +
    'outras pessoas — isso é do superadministrador.'
  )
}

/**
 * O que revogar faz, e a invariante que pode recusá-la.
 *
 * `exigir_dois_admins_ativos` (migration `0031`) recusa qualquer revogação que
 * deixe menos de dois operadores ativos — **inclusive a de si mesmo**, que é
 * permitida de propósito: quem percebe que a própria conta foi comprometida
 * precisa poder se desligar sem esperar por outra pessoa.
 */
export const O_QUE_A_REVOGACAO_FAZ =
  'O acesso ao painel acaba na hora, e a concessão fica registrada com a data ' +
  'em que terminou — nada é apagado. Uma revogação que deixasse menos de dois ' +
  'operadores ativos é recusada pelo banco: perder o acesso do único trancaria ' +
  'o painel, e o aviso entre pares não teria para quem ir.'

/** Por que não há uma lista nesta tela. O operador precisa ler isto uma vez. */
export const POR_QUE_NAO_HA_LISTAGEM =
  'Esta tela não lista operadores, e a ausência é a decisão. Uma lista com nome ' +
  'e e-mail de toda a operação, numa sessão sem segundo fator, é o alvo de quem ' +
  'já comprometeu uma conta. Conferir uma pessoa é possível — conceder a quem já ' +
  'é operadora responde que ela já é. Enumerar, não.'
