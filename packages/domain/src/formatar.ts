import type { Moeda, Money } from './money.js'
import type { StatusDeLancamento } from './saldo.js'

/**
 * Composição de valor monetário — a única do sistema.
 *
 * `docs/design/direcao-visual.md` §3.4 exige que sinal, símbolo, reais e
 * centavos tenham tamanho e cor próprios quando o valor aparece isolado. Por
 * isso o formatador devolve **partes**, e não uma string: uma string pronta
 * obrigaria a interface a fatiá-la de volta com expressão regular, e é aí que o
 * `R$` de um valor negativo vira o `−`.
 *
 * Aqui não há `Intl.NumberFormat`: ele opera sobre `number`, e converter um
 * `bigint` de centavos para `number` para formatá-lo desfaz, no último passo,
 * a precisão que o sistema inteiro carrega desde o banco. Acima de
 * R$ 90.071.992.547,40 o resultado passa a ser silenciosamente errado.
 */

export interface PartesDoValor {
  /** `−` (U+2212), `+`, ou vazio no zero. Nunca hífen. */
  readonly sinal: string
  readonly simbolo: string
  /** Reais, agrupados por ponto. Sem sinal: ele mora em coluna própria. */
  readonly inteiro: string
  readonly separador: string
  /** Sempre dois dígitos. */
  readonly decimais: string
}

const SIMBOLOS: Record<Moeda, string> = {
  BRL: 'R$',
  USD: 'US$',
  EUR: '€',
}

/** U+2212. O hífen é mais curto e sobe a linha de base — ver §3.3. */
const MENOS = '−'

export function partesDoValor(valor: Money): PartesDoValor {
  const negativo = valor.centavos < 0n
  const magnitude = negativo ? -valor.centavos : valor.centavos

  const reais = magnitude / 100n
  const centavos = magnitude % 100n

  return {
    sinal: valor.centavos === 0n ? '' : negativo ? MENOS : '+',
    simbolo: SIMBOLOS[valor.moeda],
    inteiro: agruparMilhar(reais),
    separador: ',',
    decimais: centavos.toString().padStart(2, '0'),
  }
}

/** As partes na ordem em que se lê. Para atributo, rótulo e teste. */
export function valorEmTexto(valor: Money): string {
  const p = partesDoValor(valor)
  return `${p.sinal}${p.simbolo} ${p.inteiro}${p.separador}${p.decimais}`
}

export interface ContextoDoRotulo {
  readonly status?: StatusDeLancamento
  /**
   * Transferência não é receita nem despesa (`CONTEXT.md`), mesmo tendo sinal.
   * Lê-la como "despesa" reintroduziria no áudio a confusão que a regra 12b
   * elimina dos totais.
   */
  readonly transferencia?: boolean
}

/**
 * O que o leitor de tela anuncia no lugar do glifo.
 *
 * Sem isto, um valor de despesa é lido como "menos erre cifrão mil cento e
 * dezesseis", com o "menos" solto na frente — que é ruído, não informação.
 *
 * O número em si continua em algarismos, e não por descuido: soletrar valores
 * em português exige concordância ("duzentas mil"), "cem" contra "cento" e a
 * junção de ordens, o que é superfície de bug suficiente para valer um módulo
 * próprio. Leitores de tela em pt-BR já leem `R$ 1.116,00` corretamente; o que
 * eles não sabem é que aquele traço significa "despesa".
 */
export function rotuloAcessivel(valor: Money, contexto: ContextoDoRotulo): string {
  const natureza = contexto.transferencia
    ? 'transferência'
    : valor.centavos < 0n
      ? 'despesa'
      : 'receita'

  const p = partesDoValor(valor)
  const quantia = `${p.simbolo} ${p.inteiro}${p.separador}${p.decimais}`

  return contexto.status
    ? `${natureza} de ${quantia}, ${contexto.status}`
    : `${natureza} de ${quantia}`
}

/**
 * Ponto a cada três casas, da direita para a esquerda.
 *
 * Sobre a string do `bigint`, e não sobre o número: é o que mantém o valor
 * exato em qualquer magnitude que o `BIGINT` do Postgres comporte.
 */
function agruparMilhar(reais: bigint): string {
  const digitos = reais.toString()
  let saida = ''

  for (let i = 0; i < digitos.length; i++) {
    const restantes = digitos.length - i
    saida += digitos[i]
    if (restantes > 1 && (restantes - 1) % 3 === 0) saida += '.'
  }

  return saida
}
