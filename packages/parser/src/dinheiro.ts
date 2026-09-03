/**
 * A conversão de um valor textual de arquivo para centavos.
 *
 * **Nunca passa por `Number`.** É a regra 1 do `CLAUDE.md` no ponto em que ela
 * é mais fácil de violar sem perceber: `parseFloat('1234.56') * 100` dá
 * `123455.99999999999`, e `Math.round` disfarça isso na maioria dos valores —
 * até o dia em que não disfarça. O extrato do cliente vira um centavo errado, e
 * ninguém acha a causa.
 *
 * Aqui a string é dividida na parte inteira e na fracionária, e as duas viram
 * `bigint` separadamente. Nenhuma operação de ponto flutuante existe neste
 * arquivo.
 */

export class ValorIlegivel extends Error {
  constructor(readonly bruto: string) {
    super(`Valor não reconhecido: ${bruto}`)
    this.name = 'ValorIlegivel'
  }
}

/**
 * `-1.234,56`, `-1234.56`, `1234`, `(1.234,56)` → centavos com sinal.
 *
 * Aceita as três notações que aparecem em arquivo de banco brasileiro e a
 * quarta que aparece em exportação de planilha: parêntese como negativo, que é
 * herança de contabilidade e que um parser ingênuo lê como positivo — invertendo
 * o sinal de toda despesa do arquivo.
 */
export function centavosDe(bruto: string): bigint {
  const texto = bruto.trim()
  if (texto === '') throw new ValorIlegivel(bruto)

  const entreParenteses = /^\((.*)\)$/.exec(texto)
  const semParenteses = entreParenteses?.[1]?.trim() ?? texto

  let corpo = semParenteses.replace(/\s|R\$| /g, '')
  let negativo = entreParenteses !== null

  if (corpo.startsWith('-')) {
    negativo = !negativo
    corpo = corpo.slice(1)
  } else if (corpo.startsWith('+')) {
    corpo = corpo.slice(1)
  }

  if (!/^[\d.,]+$/.test(corpo)) throw new ValorIlegivel(bruto)

  const separador = separadorDecimalDe(corpo)

  // Sem separador decimal, o que sobrar de `.` ou `,` **precisa** ser
  // agrupamento de milhar bem-formado. Cair no `replace` cego aqui era o
  // defeito que o teste de "mais de duas casas" pegou: `1,2345` virava
  // R$ 12.345,00 em silêncio — quatro ordens de grandeza, sem nenhum erro.
  if (separador === null && /[.,]/.test(corpo) && !ehAgrupamentoDeMilhar(corpo)) {
    throw new ValorIlegivel(bruto)
  }

  const [inteiraBruta, fracionariaBruta] =
    separador === null ? [corpo, ''] : partir(corpo, separador)

  const inteira = inteiraBruta.replace(/[.,]/g, '')
  if (inteira === '' && fracionariaBruta === '') throw new ValorIlegivel(bruto)
  if (!/^\d*$/.test(inteira) || !/^\d*$/.test(fracionariaBruta)) throw new ValorIlegivel(bruto)

  // Mais de duas casas não é dinheiro: é taxa, cotação ou erro de exportação.
  // Truncar em silêncio inventaria um valor; recusar devolve o problema a quem
  // pode resolvê-lo.
  if (fracionariaBruta.length > 2) throw new ValorIlegivel(bruto)

  const centavos = BigInt(inteira || '0') * 100n + BigInt(fracionariaBruta.padEnd(2, '0') || '0')
  return negativo ? -centavos : centavos
}

/**
 * Qual dos dois símbolos é o separador decimal.
 *
 * O **último** que aparecer, e só se sobrarem no máximo duas casas depois dele.
 * `1.234` é mil duzentos e trinta e quatro; `1.23` é um e vinte e três. Sem essa
 * distinção, todo valor redondo em notação americana vira um valor mil vezes
 * menor — e o extrato importado fecha com o saldo errado sem nenhum erro visível.
 */
function separadorDecimalDe(corpo: string): '.' | ',' | null {
  const ultimoPonto = corpo.lastIndexOf('.')
  const ultimaVirgula = corpo.lastIndexOf(',')
  const posicao = Math.max(ultimoPonto, ultimaVirgula)
  if (posicao < 0) return null

  const casas = corpo.length - posicao - 1
  if (casas > 2) return null

  // Milhar nunca aparece sozinho: `1.234` tem exatamente três casas depois do
  // ponto e nenhum outro separador. Já foi coberto por `casas > 2`.
  return posicao === ultimoPonto ? '.' : ','
}

/**
 * `1.234`, `1.234.567`, `12,345,678` — grupos de exatamente três, com um único
 * símbolo repetido. Qualquer outra coisa com separador não é número de dinheiro.
 */
function ehAgrupamentoDeMilhar(corpo: string): boolean {
  return /^\d{1,3}(\.\d{3})+$/.test(corpo) || /^\d{1,3}(,\d{3})+$/.test(corpo)
}

function partir(corpo: string, separador: string): [string, string] {
  const i = corpo.lastIndexOf(separador)
  return [corpo.slice(0, i), corpo.slice(i + 1)]
}
