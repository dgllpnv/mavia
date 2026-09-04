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
  fimDoDiaCivil,
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

export {
  atingiu,
  consumoEmBp,
  dentroDoPlanejado,
  estadoDoPlanejamento,
  naturezaDoValor,
  totalPlanejado,
  type EstadoDoPlanejamento,
  type NaturezaDoPlanejamento,
  type PlanejamentoParaTotal,
  type TotalPlanejado,
} from './planejamento.js'

export {
  atingiuOAlvo,
  consumoDoObjetivoEmBp,
  estadoDoObjetivo,
  prazoValido,
  progressoAncorado,
  progressoPorAportes,
  type EstadoDoObjetivo,
  type FatosDoObjetivo,
} from './objetivo.js'

export {
  ocorrencias,
  proximaOcorrencia,
  type Ocorrencia,
  type RegraDeRecorrencia,
} from './recorrencia.js'

export {
  conciliar,
  semelhanca,
  PISO_DE_CONFIANCA,
  type Candidato,
  type Importado,
  type OpcoesDeConciliacao,
  type Sugestao,
} from './conciliacao.js'

export {
  assinatura,
  classificar,
  PISO_DE_CONFIANCA as PISO_DE_CONFIANCA_DA_CLASSIFICACAO,
  REPETICOES_MINIMAS,
  type Classificacao,
  type Historico,
  type RegraDoUsuario,
  type TipoDeRegra,
} from './classificacao.js'

export { cotasVigentes, jobsAtivos, plano, podeEscrever, preco, transicao, COTAS_DO_TESTE, DIAS_DE_GRACA, DIAS_DE_TESTE, PLANOS, type CodigoDoPlano, type Cotas, type EstadoDaAssinatura, type EventoDaAssinatura, type Intervalo, type Plano, fimEfetivo } from './catalogo.js'

// ADR 0025 D1 — desconto sobre o preço do plano. **Estimativa para a tela**;
// quem cobra é a Stripe, e o valor final vem pelo webhook (DP-39).
export { descontoPercentual, descontoDeValor, estimarComDesconto, type Desconto, type ErroDeDesconto, type Estimativa } from './desconto.js'
