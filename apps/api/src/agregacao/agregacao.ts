import {
  BALDES,
  dinheiro,
  type Balde,
  type BaldesDoPeriodo,
  type Moeda,
  type Money,
} from '@mavia/domain'
import type { PoolClient } from 'pg'

/**
 * Agregação — o tradutor único de toda soma monetária.
 *
 * Este módulo existe por causa do defeito B1, e a correção não foi consertar o
 * rodapé: foi tornar a classe de defeito irrepresentável. **Toda** soma de
 * dinheiro do sistema passa por aqui.
 *
 * Duas propriedades que ele garante:
 *
 * 1. **Todo lançamento cai em exatamente um balde**, e o conjunto é o enum
 *    fechado de `@mavia/domain`. Acrescentar um balde quebra o typecheck em
 *    todo lugar que constrói um resumo (ADR 0022).
 * 2. **A partição é por `Categoria.natureza`, nunca pelo sinal.** O sinal
 *    governa a soma; a natureza governa o balde. Particionar por sinal fazia um
 *    estorno de despesa virar receita inventada.
 */

/**
 * O eixo, e por que ele é obrigatório.
 *
 * `realizado` **não** significa a mesma coisa nos dois eixos, e foi aplicar a
 * definição de um ao outro que produziu o achado RP-4: uma despesa pendente
 * entrava em `despesa_realizada` mas não no `saldo`, e a tela mostrava três
 * números que não fechavam por R$ 100,00.
 *
 * - **competência** — realizado é o que **aconteceu**: `settled_at` presente
 *   ou `posted_at` já passado. É o eixo dos relatórios.
 * - **caixa** — realizado é o que **se moveu**: `settled_at` presente, e nada
 *   mais. É o eixo do saldo e do rodapé do extrato.
 *
 * Sem valor padrão de propósito: escolher o eixo é decisão de quem pergunta, e
 * um padrão silencioso é o caminho de volta para o defeito.
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

interface LinhaDeBalde {
  readonly balde: Balde
  readonly realizada: string
  readonly prevista: string
}

/**
 * A consulta agrupa **pelo balde**, em vez de ter uma coluna por balde.
 *
 * A diferença importa: com colunas nomeadas à mão, acrescentar um balde exige
 * lembrar de acrescentar duas colunas, e esquecer é silencioso. Agrupando, o
 * SQL classifica com a mesma regra do domínio e o balde novo aparece sozinho.
 *
 * `SUM` sobre `BIGINT` é aritmética inteira exata: sem `NUMERIC` implícito, sem
 * float, sem cast. O que continua proibido é o SQL **decidir** o que conta como
 * realizado — isso é o `FILTER` explícito, e nada mais.
 */
function sqlBaldes(eixo: EixoDeAgregacao): string {
  const realizado =
    eixo === 'caixa'
      ? 'l.settled_at IS NOT NULL'
      : '(l.settled_at IS NOT NULL OR l.posted_at <= $2)'
  const previsto =
    eixo === 'caixa' ? 'l.settled_at IS NULL' : '(l.settled_at IS NULL AND l.posted_at > $2)'

  // O universo vem ANTES da partição: lançamento de cartão não pertence ao eixo
  // caixa e não vira balde nenhum (ADR 0022, emenda 3). Uma compra não sai do
  // bolso — quem sai é a fatura.
  const universo = eixo === 'caixa' ? 'AND l.conta_id IS NOT NULL' : ''

  return `
    SELECT
      CASE
        WHEN l.transfer_group_id IS NOT NULL THEN 'transferencia'
        WHEN NOT c.analitica                 THEN 'nao_analitica'
        WHEN c.natureza = 'receita'          THEN 'receita'
        ELSE                                      'despesa'
      END AS balde,
      coalesce(sum(l.valor_centavos) FILTER (WHERE ${realizado}), 0)::text AS realizada,
      coalesce(sum(l.valor_centavos) FILTER (WHERE ${previsto}),  0)::text AS prevista
    FROM lancamentos l
    -- LEFT JOIN: perna de transferência não tem categoria, por invariante.
    LEFT JOIN categorias c ON c.id = l.categoria_id AND c.tenant_id = l.tenant_id
    WHERE l.tenant_id = $1
      AND l.deleted_at IS NULL
      -- Âncora de tipo: no eixo caixa o predicado não menciona $2, e sem esta
      -- linha o Postgres não infere o tipo do parâmetro.
      AND $2::timestamptz IS NOT NULL
      AND l.posted_at >= $3 AND l.posted_at < $4
      AND ($5::uuid IS NULL OR l.conta_id = $5)
      AND ($6::uuid IS NULL OR l.categoria_id = $6)
      ${universo}
    GROUP BY 1
  `
}

/**
 * Tudo que já se moveu antes do início da janela, **mais o saldo inicial das
 * contas no escopo**.
 *
 * O saldo inicial não é lançamento e não aparece no extrato, mas é dinheiro que
 * estava lá. Omiti-lo fazia o rodapé começar do zero numa conta com saldo — e a
 * identidade fechava com o número errado, que é pior que não fechar.
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
                 AND l.conta_id IS NOT NULL
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

  const linhas = await cliente.query<LinhaDeBalde>(sqlBaldes(filtro.eixo), [
    filtro.tenantId,
    filtro.agora,
    filtro.de,
    filtro.ate,
    filtro.contaId ?? null,
    filtro.categoriaId ?? null,
  ])

  // Começa com todos os baldes zerados e preenche o que veio. Um balde sem
  // lançamento no período fica em zero em vez de sumir da resposta — sumir é
  // exatamente o defeito que a exaustividade existe para impedir.
  const baldes = Object.fromEntries(
    BALDES.map((b) => [b, { realizada: centavos('0'), prevista: centavos('0') }]),
  ) as Record<Balde, { realizada: Money; prevista: Money }>

  for (const l of linhas.rows) {
    baldes[l.balde] = { realizada: centavos(l.realizada), prevista: centavos(l.prevista) }
  }

  return { saldoAnterior: centavos(anterior.rows[0]?.anterior ?? '0'), baldes }
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
