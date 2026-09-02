import { dinheiro, type Moeda, type Money } from '@mavia/domain'
import type { BaldesDoPeriodo } from '@mavia/domain'
import type { PoolClient } from 'pg'

/**
 * Agregação — o tradutor único de toda soma monetária.
 *
 * Este módulo existe por causa do defeito B1, e a correção não foi consertar o
 * rodapé: foi tornar a classe de defeito irrepresentável. **Toda** soma de
 * dinheiro do sistema passa por aqui — o rodapé, os relatórios, o total da
 * fatura e o realizado do Planejamento.
 *
 * A propriedade que ele garante: **é impossível pôr uma perna de transferência
 * num balde de receita ou de despesa**, porque os baldes são produzidos por
 * esta função e não por um `AND` repetido em cada consulta. Um `AND` repetido é
 * um `AND` que alguém esquece.
 *
 * A soma acontece no banco, sobre `BIGINT`: a página não é o período, e somar
 * em JavaScript daria o total da página em vez do total do recorte.
 */

/**
 * O eixo, e por que ele é obrigatório.
 *
 * `realizado` **não** tem o mesmo significado nos dois eixos, e foi aplicar a
 * definição de um ao outro que produziu o achado RP-4: uma despesa pendente
 * entrava em `despesa_realizada` mas não no `saldo`, e a tela mostrava três
 * números que não fechavam por R$ 100,00.
 *
 * - **competência** — realizado é o que **aconteceu**: `settled_at` presente
 *   ou `posted_at` já passado. É o eixo dos relatórios.
 * - **caixa** — realizado é o que **se moveu**: `settled_at` presente, e nada
 *   mais. É o eixo do saldo e do rodapé do extrato.
 *
 * Não tem valor padrão de propósito: escolher o eixo é decisão de quem
 * pergunta, e um padrão silencioso é o caminho de volta para o defeito.
 */
export type EixoDeAgregacao = 'competencia' | 'caixa'

export interface FiltroDeAgregacao {
  readonly eixo: EixoDeAgregacao
  readonly tenantId: string
  /** Semiaberto `[de, ate)`, como toda janela do domínio. */
  readonly de: Date
  readonly ate: Date
  readonly contaId?: string
  readonly categoriaId?: string
  readonly moeda: Moeda
  /** Momento de referência para separar realizado de previsto. */
  readonly agora: Date
}

interface LinhaDeBaldes {
  readonly receita_realizada: string
  readonly receita_prevista: string
  readonly despesa_realizada: string
  readonly despesa_prevista: string
  readonly transferencia_realizada: string
  readonly transferencia_prevista: string
}

/**
 * A consulta é uma só, com `FILTER` por balde.
 *
 * `SUM` sobre `BIGINT` é aritmética inteira exata — não há `NUMERIC` implícito,
 * não há float, não há cast. O que continua proibido é o SQL **decidir** o que
 * conta como realizado: isso é o `FILTER` explícito abaixo, e nada mais.
 */
function sqlBaldes(eixo: EixoDeAgregacao): string {
  // O único ponto onde os dois eixos divergem. Escrito uma vez, e o resto da
  // consulta é idêntico — o que impede as duas versões de divergirem por
  // manutenção.
  const realizado =
    eixo === 'caixa'
      ? 'settled_at IS NOT NULL'
      : '(settled_at IS NOT NULL OR posted_at <= $2)'
  const previsto = eixo === 'caixa' ? 'settled_at IS NULL' : '(settled_at IS NULL AND posted_at > $2)'
  return SQL_BALDES.replaceAll('/*REALIZADO*/', realizado).replaceAll('/*PREVISTO*/', previsto)
}

const SQL_BALDES = `
  SELECT
    coalesce(sum(valor_centavos) FILTER (
      WHERE transfer_group_id IS NULL AND valor_centavos > 0
        AND /*REALIZADO*/), 0)::text AS receita_realizada,
    coalesce(sum(valor_centavos) FILTER (
      WHERE transfer_group_id IS NULL AND valor_centavos > 0
        AND /*PREVISTO*/), 0)::text AS receita_prevista,
    coalesce(sum(valor_centavos) FILTER (
      WHERE transfer_group_id IS NULL AND valor_centavos < 0
        AND /*REALIZADO*/), 0)::text AS despesa_realizada,
    coalesce(sum(valor_centavos) FILTER (
      WHERE transfer_group_id IS NULL AND valor_centavos < 0
        AND /*PREVISTO*/), 0)::text AS despesa_prevista,
    -- Transferência tem balde próprio. Não é receita nem despesa, mas move o
    -- saldo da conta filtrada — e foi ignorar isso que fez o rodapé mentir.
    coalesce(sum(valor_centavos) FILTER (
      WHERE transfer_group_id IS NOT NULL
        AND /*REALIZADO*/), 0)::text AS transferencia_realizada,
    coalesce(sum(valor_centavos) FILTER (
      WHERE transfer_group_id IS NOT NULL
        AND /*PREVISTO*/), 0)::text AS transferencia_prevista
  FROM lancamentos
  WHERE tenant_id = $1
    AND deleted_at IS NULL
    -- Âncora de tipo: no eixo caixa o predicado não menciona $2, e sem esta
    -- linha o Postgres não consegue inferir o tipo do parâmetro. A alternativa
    -- seria montar duas listas de parâmetros — e duas listas divergem.
    AND $2::timestamptz IS NOT NULL
    AND posted_at >= $3 AND posted_at < $4
    AND ($5::uuid IS NULL OR conta_id = $5)
    AND ($6::uuid IS NULL OR categoria_id = $6)
`

/**
 * Tudo que já se moveu antes do início da janela, **mais o saldo inicial das
 * contas no escopo**.
 *
 * O saldo inicial não é lançamento e não aparece no extrato, mas é dinheiro
 * que estava lá. Omiti-lo fazia o rodapé começar do zero numa conta com saldo
 * — e a identidade fechava com o número errado, que é pior que não fechar.
 */
const SQL_SALDO_ANTERIOR = `
  SELECT (
    coalesce((SELECT sum(c.saldo_inicial_centavos) FROM contas c
               WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
                 AND ($3::uuid IS NULL OR c.id = $3)), 0)
    +
    coalesce((SELECT sum(l.valor_centavos) FROM lancamentos l
               WHERE l.tenant_id = $1 AND l.deleted_at IS NULL
                 AND l.settled_at IS NOT NULL
                 AND l.posted_at < $2
                 AND ($3::uuid IS NULL OR l.conta_id = $3)), 0)
  )::text AS anterior
`

export async function baldesDoPeriodo(
  cliente: PoolClient,
  filtro: FiltroDeAgregacao,
): Promise<BaldesDoPeriodo> {
  const centavos = (texto: string): Money => dinheiro(BigInt(texto), filtro.moeda)

  const anterior = await cliente.query<{ anterior: string }>(SQL_SALDO_ANTERIOR, [
    filtro.tenantId,
    filtro.de,
    filtro.contaId ?? null,
  ])

  const baldes = await cliente.query<LinhaDeBaldes>(sqlBaldes(filtro.eixo), [
    filtro.tenantId,
    filtro.agora,
    filtro.de,
    filtro.ate,
    filtro.contaId ?? null,
    filtro.categoriaId ?? null,
  ])

  const b = baldes.rows[0]
  if (!b) throw new Error('agregação não devolveu linha')

  return {
    saldoAnterior: centavos(anterior.rows[0]?.anterior ?? '0'),
    receitaRealizada: centavos(b.receita_realizada),
    receitaPrevista: centavos(b.receita_prevista),
    despesaRealizada: centavos(b.despesa_realizada),
    despesaPrevista: centavos(b.despesa_prevista),
    transferenciaLiquidaRealizada: centavos(b.transferencia_realizada),
    transferenciaLiquidaPrevista: centavos(b.transferencia_prevista),
  }
}

/**
 * Saldo derivado de uma conta: a soma de tudo que se moveu, mais o inicial.
 *
 * Verdade é isto. `saldo_snapshots` é materialização para desempenho, e a
 * reconciliação compara os dois — divergência é incidente, nunca correção
 * silenciosa.
 */
export async function saldoDerivadoDaConta(
  cliente: PoolClient,
  tenantId: string,
  contaId: string,
  moeda: Moeda,
): Promise<Money> {
  const r = await cliente.query<{ saldo: string }>(
    `SELECT (c.saldo_inicial_centavos
             + coalesce(sum(l.valor_centavos) FILTER (WHERE l.settled_at IS NOT NULL), 0))::text
              AS saldo
       FROM contas c
       LEFT JOIN lancamentos l
              ON l.conta_id = c.id AND l.tenant_id = c.tenant_id AND l.deleted_at IS NULL
      WHERE c.tenant_id = $1 AND c.id = $2 AND c.deleted_at IS NULL
      GROUP BY c.saldo_inicial_centavos`,
    [tenantId, contaId],
  )
  return dinheiro(BigInt(r.rows[0]?.saldo ?? '0'), moeda)
}
