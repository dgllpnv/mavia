/**
 * @mavia/domain — o coração puro do sistema.
 *
 * Zero I/O, zero framework, relógio injetado. Nada aqui importa nada de fora
 * do próprio pacote. Toda regra de negócio monetária mora neste módulo e é
 * exercitada pelo seam S1 (`docs/arquitetura/sistema.md` §2).
 *
 * Esta é a interface pública do pacote: o que não é reexportado aqui é
 * interno e pode mudar sem aviso.
 */

export { falha, ok, type Result } from './result.js'

export {
  dinheiro,
  ehZero,
  negar,
  sinalDe,
  somar,
  somarLista,
  subtrair,
  type ErroMonetario,
  type Moeda,
  type Money,
} from './money.js'

export { ratear, type ErroDeRateio } from './ratear.js'
