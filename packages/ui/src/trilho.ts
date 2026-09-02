import { dinheiro, type Money } from '@mavia/domain'

/**
 * A geometria do trilho — o elemento-assinatura da Mavia.
 *
 * `docs/design/direcao-visual.md` §1: uma régua com três partes e uma só
 * gramática, que responde em toda tela a mesma pergunta — **quanto disto já é
 * fato, e onde estava previsto terminar.**
 *
 * ```
 *    R$ 4.281,90
 *    ███████████████████████▌ · · · · · · · │ · · · ·
 *    └─ carga ──────────────┘               ↑ marca
 * ```
 *
 * Este módulo calcula as três proporções e nada mais: cor, altura e hachura
 * são CSS. A separação é o ponto — a proporção é a única parte que pode estar
 * **errada**, e é a única testada.
 *
 * O denominador é o **maior** entre realizado e previsto, em magnitude. Fixá-lo
 * no previsto faria a carga passar de 1 num mês estourado, e a barra sairia
 * desenhada para fora da própria caixa.
 */

export interface DadosDoTrilho {
  /** O que já é fato. */
  readonly realizado: Money
  /** Onde se esperava terminar. É ele quem define a direção. */
  readonly previsto: Money
}

export interface GeometriaDoTrilho {
  /** Fração do trilho preenchida pelo realizado. Entre 0 e 1. */
  readonly carga: number
  /** Onde a marca do previsto cruza o trilho. Entre 0 e 1. */
  readonly marca: number
  /** Fração à direita da marca. Zero quando não houve estouro. */
  readonly estouro: number
  /** Quanto passou do previsto, para o rótulo `+R$ 312 acima`. Nulo sem estouro. */
  readonly excedente: Money | null
  /**
   * De onde a carga cresce. Despesa carrega da direita para a esquerda —
   * segundo canal de sinal, independente de cor (§3.5).
   */
  readonly direcao: 'esquerda' | 'direita'
}

export function geometriaDoTrilho(dados: DadosDoTrilho): GeometriaDoTrilho {
  const { realizado, previsto } = dados

  if (realizado.moeda !== previsto.moeda) {
    // Regra 2: moedas diferentes lançam, nunca se convertem em silêncio. Um
    // trilho é uma razão entre dois valores, e razão entre moedas não existe.
    throw new Error(
      `Trilho com moedas diferentes: ${realizado.moeda} e ${previsto.moeda}. ` +
        'Uma razão entre moedas distintas não significa nada.',
    )
  }

  const direcao = sinalDominante(previsto, realizado) < 0n ? 'direita' : 'esquerda'

  // Realizado de sinal contrário ao previsto não é carga negativa: é ausência
  // de carga. Uma barra negativa sairia desenhada para fora da caixa, e o
  // número ao lado já conta a história melhor do que uma barra invertida.
  const realizadoNaDirecao = concordamNoSinal(realizado, previsto)
    ? magnitude(realizado)
    : 0n
  const previstoAbsoluto = magnitude(previsto)

  if (previstoAbsoluto === 0n && realizadoNaDirecao === 0n) {
    return { carga: 0, marca: 0, estouro: 0, excedente: null, direcao }
  }

  // Dentro do previsto: o trilho vale o previsto, a marca fica na ponta.
  if (realizadoNaDirecao <= previstoAbsoluto) {
    return {
      carga: fracao(realizadoNaDirecao, previstoAbsoluto),
      marca: 1,
      estouro: 0,
      excedente: null,
      direcao,
    }
  }

  // Estourado: o trilho passa a valer o realizado, a carga enche, e a marca
  // recua exatamente o que o estouro avança.
  //
  // `marca = 1 − estouro`, e não uma terceira divisão. Três divisões
  // independentes discordam por arredondamento: com R$ 10.000.000,00 previstos
  // e um centavo a mais realizado, o estouro arredondava para 0 enquanto a
  // marca ficava em 0,999999 — um trilho que dizia "estourou" e "não estourou"
  // ao mesmo tempo. Foi a propriedade que achou isso.
  const excedenteEmCentavos = realizadoNaDirecao - previstoAbsoluto
  const estouro = fracao(excedenteEmCentavos, realizadoNaDirecao)

  return {
    carga: 1,
    marca: 1 - estouro,
    estouro,
    // O excedente carrega o sinal do previsto: R$ 250 a mais de despesa é
    // −25000, não +25000.
    excedente: dinheiro(
      previsto.centavos < 0n || realizado.centavos < 0n
        ? -excedenteEmCentavos
        : excedenteEmCentavos,
      realizado.moeda,
    ),
    direcao,
  }
}

/**
 * O sinal que manda é o do previsto — ele é o denominador, e é ele que diz de
 * que lado o trilho carrega. Só quando o previsto é zero o realizado decide;
 * do contrário, um mês de despesas que começou com um estorno viraria um
 * trilho de receita por causa da primeira linha.
 */
function sinalDominante(previsto: Money, realizado: Money): bigint {
  return previsto.centavos !== 0n ? previsto.centavos : realizado.centavos
}

function concordamNoSinal(a: Money, b: Money): boolean {
  if (a.centavos === 0n || b.centavos === 0n) return true
  return a.centavos < 0n === b.centavos < 0n
}

const magnitude = (m: Money): bigint => (m.centavos < 0n ? -m.centavos : m.centavos)

/**
 * Razão entre dois `bigint` como `number`.
 *
 * A conversão para ponto flutuante é aceitável **aqui e só aqui**: o resultado
 * é uma largura em CSS, não dinheiro. Nenhum valor monetário sai deste módulo
 * como `number` — `excedente` sai como `Money`.
 */
function fracao(parte: bigint, todo: bigint): number {
  // Escala inteira antes de dividir: com magnitudes acima de 2^53 a divisão
  // direta em `number` já teria perdido precisão nas duas pontas.
  const escala = 1_000_000n
  return Number((parte * escala) / todo) / Number(escala)
}
