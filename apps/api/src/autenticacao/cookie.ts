/**
 * O cookie de **refresh** do web — escrito à mão, e de propósito.
 *
 * `@fastify/cookie` na versão atual exige Fastify 5, e trocar a versão do
 * servidor por um único cookie opaco seria acoplar a porta de entrada do
 * produto a um upgrade que não temos razão para fazer agora. São vinte linhas
 * com um formato fixo, e um teste de rota que as exercita de ponta a ponta.
 *
 * O nome tem o prefixo `__Host-`, que o navegador trata como contrato: o
 * cookie **precisa** ser `Secure`, ter `Path=/` e **não pode** declarar
 * `Domain`. Sem esse prefixo, um subdomínio comprometido — inclusive um que
 * ainda não existe — pode fixar a sessão do domínio inteiro.
 *
 * ## O que este cookie carrega, e o que não carrega
 *
 * Carrega o **refresh**, que vale semanas e nunca chega ao JavaScript da
 * página. **Não** carrega o access token: esse vive quinze minutos numa
 * variável de módulo do cliente e viaja em `Authorization`. A separação é o que
 * faz um XSS roubar quinze minutos em vez de semanas — ler o cookie ele não
 * consegue, e a variável some ao recarregar a página.
 */

/** `rt` de refresh token. O nome mudou junto com o papel do cookie. */
export const NOME_DO_COOKIE = '__Host-mavia_rt'

export interface OpcoesDoCookie {
  /**
   * Em desenvolvimento local o navegador aceita `Secure` em `localhost`, então
   * o atributo fica sempre. Nunca há um caminho que o remova: um cookie de
   * sessão sem `Secure` é um cookie que viaja em claro na primeira requisição
   * a `http://`.
   */
  readonly maxAgeEmSegundos: number
}

export function cookieDeSessao(token: string, opcoes: OpcoesDoCookie): string {
  return [
    `${NOME_DO_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    // `Lax` e não `Strict`: com `Strict`, quem chega à Mavia por um link de
    // e-mail cai numa tela deslogada mesmo tendo sessão válida. `Lax` recusa
    // POST de outra origem, que é onde mora o CSRF.
    'SameSite=Lax',
    `Max-Age=${opcoes.maxAgeEmSegundos}`,
  ].join('; ')
}

/** O mesmo cookie, vencido. Limpar é sobrescrever com `Max-Age=0`. */
export function cookieDeSaida(): string {
  return cookieDeSessao('', { maxAgeEmSegundos: 0 })
}

/**
 * Lê o valor do cookie do cabeçalho `Cookie`.
 *
 * Aceita **só** o formato que emitimos: token opaco em hexadecimal. Qualquer
 * outra coisa é tratada como ausência, e não como valor a ser decodificado —
 * um parser tolerante numa credencial é uma superfície que não precisamos ter.
 */
export function tokenDoCookie(cabecalho: string | undefined): string | null {
  if (!cabecalho) return null

  for (const parte of cabecalho.split(';')) {
    const igual = parte.indexOf('=')
    if (igual < 0) continue
    if (parte.slice(0, igual).trim() !== NOME_DO_COOKIE) continue

    const valor = parte.slice(igual + 1).trim()
    return /^[0-9a-f]{64}$/.test(valor) ? valor : null
  }
  return null
}
