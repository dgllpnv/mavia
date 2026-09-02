/**
 * Baldes de agregação — `docs/adr/0022-balde-exaustivo.md`.
 *
 * O enum é fechado e a classificação é total. Não é rigor decorativo: a
 * grandeza que **não tem balde** é a que altera o saldo e não aparece no
 * rodapé. Foi assim que o defeito B1 nasceu, e assim que ele reapareceu um
 * nível abaixo — com `Ajuste de saldo`, que move o saldo e não é gasto nem
 * ganho.
 */

export const BALDES = ['receita', 'despesa', 'transferencia', 'nao_analitica'] as const

export type Balde = (typeof BALDES)[number]

/**
 * O que a classificação precisa saber. `categoria` **não é anulável**: é a
 * assinatura que impede chamar esta função com uma perna de transferência
 * carregada sem categoria, e é ela que torna a função total sem `default`.
 */
export interface LancamentoClassificavel {
  readonly transferGroupId: string | null
  readonly categoria: {
    /** `false` quando o lançamento não é fato econômico — "Ajuste de saldo". */
    readonly analitica: boolean
    readonly natureza: 'receita' | 'despesa'
  }
}

/**
 * Total: sem `null`, sem `default`, sem `throw`.
 *
 * A totalidade não é promessa — decorre de uma invariante já escrita do
 * `Lancamento`: `categoria_id` é obrigatório **exceto** em perna de
 * transferência, onde é obrigatoriamente nulo. Os dois primeiros testes são
 * mutuamente exclusivos e o terceiro é sempre alcançável.
 */
export function baldeDe(lancamento: LancamentoClassificavel): Balde {
  if (lancamento.transferGroupId !== null) return 'transferencia'
  if (!lancamento.categoria.analitica) return 'nao_analitica'
  return lancamento.categoria.natureza === 'receita' ? 'receita' : 'despesa'
}
