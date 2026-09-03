import { somarLista, type Moeda, type Money } from './money.js'

/**
 * Planejamento — valor esperado para uma categoria numa competência.
 *
 * **O sinal do valor é a natureza.** Negativo é teto de despesa, positivo é
 * piso de receita. Não existe enum, e não é economia de campo: é o que permite
 * escrever cada regra **uma vez**, sem um `if` por natureza.
 *
 * O ADR 0008 registra por que isso importa. A versão anterior tinha o enum, e
 * cada regra vinha em duas metades — uma para teto, outra para piso — que
 * precisavam ser mantidas simétricas à mão. Elas não ficaram.
 *
 * Ver `CONTEXT.md`, verbete **Planejamento**.
 */

export type NaturezaDoPlanejamento = 'teto' | 'piso'

/**
 * Três estados, e o terceiro é o que evita a tela e o sino discordarem.
 *
 * Gastar **exatamente** o teto está dentro do planejado e é 100% de consumo ao
 * mesmo tempo. Com dois rótulos, a tela mostra verde e o alerta dispara para o
 * mesmo objeto no mesmo instante.
 *
 * `fora_do_planejado`, e não `estourado`: num **piso** não se estoura nada — se
 * fica aquém. A palavra que a tela usa depende da natureza ("estourou" para
 * teto, "faltou" para piso), e palavra é apresentação. O estado, não.
 */
export type EstadoDoPlanejamento = 'dentro_do_planejado' | 'no_planejado' | 'fora_do_planejado'

/** Derivada do sinal, nunca persistida. Existe para rotular a interface. */
export function naturezaDoValor(valor: Money): NaturezaDoPlanejamento {
  return valor.centavos < 0n ? 'teto' : 'piso'
}

/**
 * `realizado >= valor`, com o sinal do domínio, para teto e piso igualmente.
 *
 * Teto de −R$ 500 com −R$ 300 gastos: `−30000 >= −50000` é verdadeiro.
 * Piso de R$ 3.000 com R$ 3.500 recebidos: `350000 >= 300000` é verdadeiro.
 *
 * Uma expressão, duas naturezas. Um `if` aqui é o defeito que a ausência de
 * enum existe para impedir.
 */
export function dentroDoPlanejado(realizado: Money, valor: Money): boolean {
  return realizado.centavos >= valor.centavos
}

/**
 * O consumo em pontos-base (1% = 100 bp), inteiro com sinal, truncado em
 * direção a zero.
 *
 * **Uma divisão, e ela não pode ser evitada.** A tentação é multiplicar os dois
 * lados por `valor` para comparar sem dividir — e isso **inverte a
 * desigualdade** quando `valor` é negativo, que é o caso de todo teto. Com teto
 * de R$ 500 e R$ 300 gastos, `−30000 × 100 >= 80 × −50000` é verdadeiro, e o
 * alerta de 80% dispara aos 60% de consumo. O `if` abolido reaparecia,
 * invertido, dentro do cálculo percentual.
 *
 * **Truncado, e não arredondado.** Com −R$ 399,99 sob teto de R$ 500 o
 * resultado é 7999 bp: a tela mostra 79,99% e o alerta de 80% não dispara.
 * Arredondar faria a tela anunciar 80,00% sem alerta — ou disparar um centavo
 * antes do limiar.
 *
 * O resultado **pode ser negativo**: um mês cuja única linha na categoria é um
 * estorno tem realizado de sinal oposto ao do teto.
 *
 * **Cuidado com a leitura por natureza.** Consumo acima de 100% é ruim num teto
 * e é *bom* num piso: no teto significa gastar além do previsto, no piso
 * significa receber além da meta. `dentroDoPlanejado` é quem responde "está
 * bem?"; `consumoEmBp` responde só "quanto do valor foi percorrido".
 */
export function consumoEmBp(realizado: Money, valor: Money): number {
  if (valor.centavos === 0n) {
    // `valor ≠ 0` é invariante da entidade, garantida no banco. Se chegou aqui,
    // é defeito de quem construiu o objeto — e devolver 0 esconderia isso.
    throw new Error('Planejamento de valor zero: a razão de consumo não existe.')
  }

  // A divisão de `bigint` já trunca em direção a zero em JavaScript, que é
  // exatamente a semântica pedida — inclusive para negativos.
  return Number((realizado.centavos * 10_000n) / valor.centavos)
}

/**
 * Se um limiar percentual foi atingido.
 *
 * Aritmética inteira sobre `consumo_bp`, **jamais** sobre o percentual
 * formatado: o número que a tela mostra é `consumo_bp / 100`, e derivar o
 * alerta do texto faria os dois divergirem no arredondamento.
 */
export function atingiu(consumoBp: number, percentual: number): boolean {
  return consumoBp >= percentual * 100
}

export function estadoDoPlanejamento(realizado: Money, valor: Money): EstadoDoPlanejamento {
  if (realizado.centavos === valor.centavos) return 'no_planejado'
  return dentroDoPlanejado(realizado, valor) ? 'dentro_do_planejado' : 'fora_do_planejado'
}

export interface PlanejamentoParaTotal {
  /** Nulo é o planejamento **global** — um valor legítimo da identidade. */
  readonly categoriaId: string | null
  readonly valor: Money
}

export interface TotalPlanejado {
  readonly teto: Money
  readonly piso: Money
}

/**
 * O total planejado do mês, uma soma por natureza.
 *
 * **Precedência: global → categoria-raiz → subcategoria.** Um planejamento
 * superior agrega o realizado de tudo abaixo dele; um inferior é um sub-teto
 * legítimo, e o mesmo lançamento conta nos dois. Para não haver contagem dupla,
 * o total soma, em cada caminho, apenas o de **nível mais alto** que existir.
 *
 * Teto global de R$ 3.000 mais sub-teto de R$ 500 em Alimentação **não** são
 * R$ 3.500 de teto: são R$ 3.000, dos quais R$ 500 têm dono.
 *
 * A regra roda **duas vezes, uma por natureza**, e os dois totais nunca se
 * somam — um "planejado líquido" não significa nada.
 *
 * @param arvore  categoria → mãe (`null` na raiz). Só precisa conter as
 *                categorias que aparecem nos planejamentos.
 */
export function totalPlanejado(
  planejamentos: readonly PlanejamentoParaTotal[],
  arvore: ReadonlyMap<string, string | null>,
): TotalPlanejado {
  // A moeda vem da lista, e não de um parâmetro: os planejamentos são todos do
  // mesmo espaço, e o espaço tem uma moeda. Uma divergência aqui é defeito de
  // quem montou a lista, e lançar é o que a regra 2 manda — nunca converter em
  // silêncio, e nunca devolver zero como se estivesse tudo bem.
  const moeda = planejamentos[0]?.valor.moeda ?? 'BRL'
  const divergente = planejamentos.find((p) => p.valor.moeda !== moeda)
  if (divergente) {
    throw new Error(
      `Planejamentos de moedas diferentes no mesmo total: ${moeda} e ${divergente.valor.moeda}.`,
    )
  }

  return {
    teto: somaDaNatureza(planejamentos, arvore, 'teto', moeda),
    piso: somaDaNatureza(planejamentos, arvore, 'piso', moeda),
  }
}

function somaDaNatureza(
  planejamentos: readonly PlanejamentoParaTotal[],
  arvore: ReadonlyMap<string, string | null>,
  natureza: NaturezaDoPlanejamento,
  moeda: Moeda,
): Money {
  const daNatureza = planejamentos.filter((p) => naturezaDoValor(p.valor) === natureza)

  // O global cobre todos os caminhos desta natureza: existindo, ele **é** o
  // total, e nada abaixo entra.
  const global = daNatureza.find((p) => p.categoriaId === null)
  if (global) return global.valor

  const comPlanejamento = new Set(
    daNatureza.filter((p) => p.categoriaId !== null).map((p) => p.categoriaId as string),
  )

  const contam = daNatureza.filter((p) => {
    const id = p.categoriaId
    if (id === null) return false
    const mae = arvore.get(id) ?? null
    // Uma subcategoria só entra quando a raiz dela não tem planejamento próprio
    // desta natureza — senão o valor dela já está contido no da mãe.
    return mae === null || !comPlanejamento.has(mae)
  })

  const soma = somarLista(
    contam.map((p) => p.valor),
    moeda,
  )
  // A homogeneidade já foi verificada em `totalPlanejado`; se falhasse aqui
  // seria porque a verificação de lá deixou passar, e o zero mentiria.
  if (!soma.ok) throw new Error('Soma de planejamentos falhou apesar da moeda conferida.')
  return soma.valor
}
