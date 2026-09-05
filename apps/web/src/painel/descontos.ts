import type { DescontoDoCliente } from '@mavia/contracts'
import {
  descontoDeValor,
  descontoPercentual,
  dinheiro,
  estimarComDesconto,
  type Money,
} from '@mavia/domain'

/**
 * O desconto de um cliente na tela — **ADR 0025 D1**.
 *
 * ## O que esta camada não faz, e é o ponto dela
 *
 * Não calcula quanto o cliente paga. `packages/domain/src/desconto.ts` produz
 * **estimativa**, esta camada a transporta, e a tela a rotula: *"≈ R$ 169,92 ·
 * valor final confirmado pela Stripe"*. Nenhuma multiplicação de percentual
 * entra no caminho do dinheiro — quando a Stripe existir, quem decide quanto
 * sai da fatura é ela, e o webhook informa.
 *
 * Estimativa não é desculpa para ser aproximada. Uma estimativa errada por um
 * centavo faz o operador conferir a fatura e concluir que a **fatura** está
 * errada. Por isso a conta vem inteira do domínio, com arredondamento declarado,
 * e nada aqui a refaz.
 *
 * ## Pontos-base, do primeiro dígito digitado até o corpo da requisição
 *
 * 15% é `1500`, e `0.15` não existe em ponto nenhum deste caminho: o campo
 * guarda dígitos, o dígito vira inteiro, o inteiro vai para a rota. É a mesma
 * disciplina de `CampoDeValor` — o oposto, guardar o texto e converter no
 * envio, é o que produz `parseFloat` perto de dinheiro.
 *
 * ## Um ativo por espaço, e conceder substitui
 *
 * O índice parcial `descontos_um_ativo_por_espaco` recusaria o segundo desconto
 * vivo. `admin.conceder_desconto` revoga o anterior na mesma transação, o que
 * transforma a recusa do banco numa substituição intencional — e as duas linhas
 * ficam no histórico. A tela precisa dizer isso **antes** do botão: quem concede
 * sem saber que já havia um está desfazendo uma negociação que não conhece.
 */

/** O que o banco aceita em `pontos_base`: de 1 a 10000, inteiro. */
export const PONTOS_BASE_MAXIMO = 10_000
export const MOTIVO_MINIMO = 8
export const MOTIVO_MAXIMO = 280

export type EspecieDeDesconto = DescontoDoCliente['especie']
export type DuracaoDeDesconto = DescontoDoCliente['duracao']

/**
 * O corpo da rota, **com a combinação impossível fora do tipo**.
 *
 * O `superRefine` da API recusa quatro combinações: percentual com centavos,
 * percentual sem pontos-base, valor com pontos-base, duração `meses` sem meses.
 * Aqui elas não são validadas — são irrepresentáveis. Um formulário que
 * produzisse `{ especie: 'percentual', centavos: '1000' }` não compilaria.
 */
export type CorpoDoDesconto = { readonly motivo: string } & (
  | { readonly especie: 'percentual'; readonly pontosBase: number }
  | { readonly especie: 'valor'; readonly centavos: string }
) &
  (
    | { readonly duracao: 'uma_vez' }
    | { readonly duracao: 'sempre' }
    | { readonly duracao: 'meses'; readonly meses: number }
  )

export interface RascunhoDoDesconto {
  readonly especie: EspecieDeDesconto
  /** Pontos-base como string de dígitos. `'1500'` é 15%. */
  readonly pontosBase: string
  /** Centavos como string de dígitos, do `CampoDeValor`. */
  readonly centavos: string
  readonly duracao: DuracaoDeDesconto
  /** Meses como string de dígitos, do campo. */
  readonly meses: string
  readonly motivo: string
}

/** O desconto que vale agora, ou `null`. Um por espaço, garantido pelo índice. */
export function descontoAtivo(itens: readonly DescontoDoCliente[]): DescontoDoCliente | null {
  return itens.find((d) => d.revogado_em === null) ?? null
}

/**
 * O histórico, do mais recente para o mais antigo.
 *
 * Reordenado aqui pela mesma razão de `precos.ts`: a tela trata a primeira
 * linha como a vigente, e herdar isso do `ORDER BY` da rota faria uma mudança
 * lá inverter o significado desta lista em silêncio.
 */
export function historicoDeDescontos(itens: readonly DescontoDoCliente[]): DescontoDoCliente[] {
  return itens
    .slice()
    .sort((a, b) => new Date(b.concedido_em).getTime() - new Date(a.concedido_em).getTime())
}

/**
 * Um dígito no campo de pontos-base, da direita para a esquerda.
 *
 * Mesma gramática de `CampoDeValor`, e pela mesma razão: quem digita `1`, `5`,
 * `0`, `0` quer 15,00%. Pedir que a pessoa acerte a vírgula é pedir que ela
 * pense no formato em vez de no número.
 *
 * O teto de cinco dígitos é o do banco (`10000`), e não um limite de tela: com
 * seis, o campo aceitaria um número que só o `CHECK` recusaria — depois de ida
 * e volta ao servidor.
 */
export function digitarPontosBase(atual: string, tecla: string): string {
  if (tecla >= '0' && tecla <= '9') {
    if (atual.replace(/^0+/, '').length >= 5) return atual
    return String(BigInt(atual || '0') * 10n + BigInt(tecla))
  }
  if (tecla === 'Backspace') return String(BigInt(atual || '0') / 10n)
  return atual
}

/**
 * Pontos-base como percentual na tela: `1500` vira `15,00`.
 *
 * Divisão inteira e resto, nunca `pb / 100` em ponto flutuante. O número é
 * pequeno e o `double` daria conta — e é exatamente assim que a primeira
 * divisão flutuante entra num arquivo que fala de dinheiro.
 */
export function pontosBaseNaTela(pontosBase: string): string {
  const pb = paraInteiro(pontosBase)
  const inteiro = pb / 100n
  const centesimos = pb % 100n
  return `${inteiro},${String(centesimos).padStart(2, '0')}`
}

/** `uma vez` · `por 3 meses` · `para sempre` — a duração em português. */
export function duracaoPorExtenso(duracao: DuracaoDeDesconto, meses: number | null): string {
  if (duracao === 'uma_vez') return 'uma vez'
  if (duracao === 'sempre') return 'para sempre'
  if (meses === null) return 'por alguns meses'
  return meses === 1 ? 'por 1 mês' : `por ${meses} meses`
}

/**
 * O corpo a enviar, ou `null` quando o rascunho não serve.
 *
 * `null` e não exceção: um rascunho incompleto é o estado normal de quem está
 * digitando, e não um evento excepcional.
 */
export function corpoDoDesconto(rascunho: RascunhoDoDesconto): CorpoDoDesconto | null {
  const motivo = rascunho.motivo.trim()
  if (motivo.length < MOTIVO_MINIMO || motivo.length > MOTIVO_MAXIMO) return null

  const duracao = duracaoDoRascunho(rascunho)
  if (!duracao) return null

  if (rascunho.especie === 'percentual') {
    const pb = paraInteiro(rascunho.pontosBase)
    if (pb < 1n || pb > BigInt(PONTOS_BASE_MAXIMO)) return null
    return { especie: 'percentual', pontosBase: Number(pb), motivo, ...duracao }
  }

  const centavos = paraInteiro(rascunho.centavos)
  if (centavos < 1n) return null
  return { especie: 'valor', centavos: String(centavos), motivo, ...duracao }
}

function duracaoDoRascunho(
  rascunho: RascunhoDoDesconto,
):
  | { readonly duracao: 'uma_vez' }
  | { readonly duracao: 'sempre' }
  | { readonly duracao: 'meses'; readonly meses: number }
  | null {
  if (rascunho.duracao === 'uma_vez') return { duracao: 'uma_vez' }
  if (rascunho.duracao === 'sempre') return { duracao: 'sempre' }
  const meses = paraInteiro(rascunho.meses)
  // 120 é o teto do Zod da rota. Dez anos de desconto é uma decisão; onze é um
  // engano de digitação que ninguém revisaria depois de gravado.
  if (meses < 1n || meses > 120n) return null
  return { duracao: 'meses', meses: Number(meses) }
}

/**
 * A recusa que a tela consegue nomear antes de enviar.
 *
 * Só o que é conhecido daqui. `ASSINATURA_INEXISTENTE` e `MOTIVO_INSUFICIENTE`
 * também vêm do banco, e a tela não os substitui: ela evita a ida quando já sabe
 * a resposta, e mostra a frase do servidor quando não sabe.
 */
export function motivoDaRecusa(rascunho: RascunhoDoDesconto): string | null {
  if (rascunho.especie === 'percentual') {
    const pb = paraInteiro(rascunho.pontosBase)
    if (pb < 1n) return 'Informe o percentual.'
    if (pb > BigInt(PONTOS_BASE_MAXIMO)) return 'O desconto não passa de 100%.'
  } else if (paraInteiro(rascunho.centavos) < 1n) {
    return 'Informe a quantia do desconto.'
  }

  if (rascunho.duracao === 'meses') {
    const meses = paraInteiro(rascunho.meses)
    if (meses < 1n) return 'Informe por quantos meses o desconto vale.'
    if (meses > 120n) return 'A duração vai no máximo a 120 meses.'
  }

  const motivo = rascunho.motivo.trim()
  if (motivo.length < MOTIVO_MINIMO) {
    return `Escreva o motivo com pelo menos ${MOTIVO_MINIMO} caracteres: ele vai para o registro.`
  }
  if (motivo.length > MOTIVO_MAXIMO) return `O motivo vai no máximo a ${MOTIVO_MAXIMO} caracteres.`

  return null
}

export interface EstimativaNaTela {
  readonly descontoCentavos: string
  readonly finalCentavos: string
}

/**
 * A estimativa sobre um preço, **calculada pelo domínio**.
 *
 * Devolve `null` quando o desconto não é válido ou o preço não é positivo. Não
 * inventa zero: um zero na tela seria lido como "sai de graça", e o que existe
 * é ausência de estimativa.
 */
export function estimativa(precoCentavos: string, corpo: CorpoDoDesconto): EstimativaNaTela | null {
  const preco = paraInteiro(precoCentavos)
  if (preco <= 0n) return null

  const desconto =
    corpo.especie === 'percentual'
      ? descontoPercentual(corpo.pontosBase)
      : descontoDeValor(comoDinheiro(corpo.centavos))
  if (!desconto.ok) return null

  const r = estimarComDesconto(comoDinheiro(String(preco)), desconto.valor)
  if (!r.ok) return null

  return {
    descontoCentavos: String(r.valor.desconto.centavos),
    finalCentavos: String(r.valor.final.centavos),
  }
}

function comoDinheiro(centavos: string): Money {
  return dinheiro(paraInteiro(centavos), 'BRL')
}

function paraInteiro(bruto: string): bigint {
  try {
    return BigInt(bruto || '0')
  } catch {
    return 0n
  }
}

/**
 * O rótulo da estimativa — **exigência literal da D1**.
 *
 * A ADR escreve a frase entre aspas porque é ela que impede o operador de tratar
 * o número como o valor cobrado. Sem o rótulo, a tela afirmaria uma cobrança que
 * nós não fazemos: quem cobra é a Stripe, e o valor final chega pelo webhook.
 */
export const ROTULO_DA_ESTIMATIVA = 'valor final confirmado pela Stripe'

/**
 * O que conceder faz, dito antes do botão.
 *
 * Com desconto ativo, o ato é uma **substituição** — e o operador que não sabe
 * disso está desfazendo uma negociação que ele não conhece.
 */
export function oQueAConcessaoFaz(ativo: DescontoDoCliente | null): string {
  if (ativo) {
    return (
      'Este espaço já tem um desconto ativo. Conceder outro revoga o atual na ' +
      'mesma transação e põe o novo no lugar: um desconto ativo por espaço, ' +
      'sempre. As duas linhas ficam no histórico, e nenhuma é apagada.'
    )
  }
  return (
    'Este espaço não tem desconto ativo. O desconto concedido aqui passa a ser ' +
    'o único, e substituí-lo depois é conceder outro.'
  )
}

/**
 * O que o desconto **não** faz hoje, e o operador precisa saber antes de
 * prometer algo ao cliente.
 *
 * A D3 emendada da ADR 0025: sem Stripe, o desconto é gravado sem cupom e
 * **não se aplica sozinho** a cobrança nenhuma — não existe cobrança. A guarda
 * que impede o dano vive na abertura da assinatura, no épico 11: um espaço com
 * desconto ativo sem cupom bloqueia a abertura, em voz alta, em vez de cobrar
 * cheio em silêncio.
 */
export const O_QUE_O_DESCONTO_NAO_FAZ =
  'Enquanto não houver conta de pagamento configurada, este desconto não é ' +
  'aplicado a cobrança nenhuma — não existe cobrança. Ele fica registrado, e a ' +
  'abertura da primeira assinatura deste espaço será recusada até o cupom ' +
  'correspondente existir. Não prometa ao cliente um valor debitado por causa ' +
  'desta operação.'

/**
 * Conceder exige **assinatura**, em qualquer estado.
 *
 * `admin.conceder_desconto` levanta `ASSINATURA_INEXISTENTE` quando o espaço
 * não tem linha em `assinaturas` — e é a única condição de estado que a função
 * impõe. Espelhar mais do que ela impõe faria a tela recusar o que o servidor
 * aceita.
 */
export function aceitaDesconto(estado: string | null): boolean {
  return estado !== null
}
