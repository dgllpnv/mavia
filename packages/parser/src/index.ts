/**
 * `@mavia/parser` — a leitura de arquivo enviado por usuário.
 *
 * Sem dependências, sem I/O, sem segredo. Escrito para caber no processo filho
 * descartável que o `sistema.md` §2.6 exige, e testável sem nada disso.
 */
export { centavosDe, ValorIlegivel } from './dinheiro.js'
export { lerOfx } from './ofx.js'
export { lerCsv, type MapaDeColunas } from './csv.js'
export type { DataCivil, LinhaComProblema, RegistroBruto, Resultado } from './tipos.js'
