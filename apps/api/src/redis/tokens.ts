/**
 * Símbolos de injeção do Redis.
 *
 * Ficam num módulo próprio porque tanto o processo quanto os testes precisam
 * deles, e importar o controlador só para pegar um símbolo criaria um ciclo.
 */
export const COFRE = Symbol('COFRE_DE_ACESSO')
export const LIMITE = Symbol('LIMITE_DE_TENTATIVAS')
