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

export {
  partesDoValor,
  rotuloAcessivel,
  valorEmTexto,
  type ContextoDoRotulo,
  type PartesDoValor,
} from './formatar.js'

export {
  competencia,
  competenciaAnterior,
  competenciaDe,
  competenciaSeguinte,
  contem,
  dataCivilDe,
  formatarDataCivil,
  inicioDoDiaCivil,
  janelaDaCompetencia,
  FUSO_PADRAO,
  type Competencia,
  type DataCivil,
  type ErroDeCompetencia,
  type Janela,
} from './tempo.js'

export {
  decidirEntradaFederada,
  type DecisaoDeEntrada,
  type FatosDaEntrada,
  type MotivoDeRecusa,
} from './identidade.js'

export {
  ehEfetivado,
  ehRealizado,
  resumoDoPeriodo,
  saldoDerivado,
  saldoGeral,
  statusDeLancamento,
  type BaldesDoPeriodo,
  type MarcasDeTempo,
  type Valores,
  type ResumoDoPeriodo,
  type StatusDeLancamento,
} from './saldo.js'

export {
  estornar,
  estornoAcumulado,
  saldoDoOriginal,
  type ErroDeEstorno,
} from './estorno.js'

export {
  ancorarDiaNoMes,
  faturaAlvo,
  janelaDaFatura,
  vencimentoDaFatura,
  type CicloDeFaturamento,
} from './fatura.js'

export {
  gerarParcelas,
  type ErroDeParcelamento,
  type Parcela,
} from './parcelamento.js'

export { BALDES, baldeDe, type Balde, type LancamentoClassificavel } from './balde.js'
