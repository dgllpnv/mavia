import { ConflictException } from '@nestjs/common'
import { faturaAlvo, statusDeLancamento, type StatusDeLancamento } from '@mavia/domain'
import type { CriarEstorno, CriarLancamento, CriarTransferencia, Lancamento } from '@mavia/contracts'
import type { PoolClient } from 'pg'
import { carregarCartaoDaCompra, faturaQueRecebe } from '../cartoes/compras.js'

/**
 * Escrita do átomo — inclui transferência e estorno.
 *
 * A transferência nasce inteira, numa transação só. Não existe caminho que crie
 * uma perna e depois a outra: perna isolada cria ou destrói dinheiro do nada.
 */

interface Linha {
  readonly id: string
  readonly conta_id: string | null
  readonly categoria_id: string | null
  readonly valor_centavos: string
  readonly moeda: Lancamento['moeda']
  readonly posted_at: Date
  readonly settled_at: Date | null
  readonly descricao: string
  readonly transfer_group_id: string | null
  readonly estorno_de_lancamento_id: string | null
  readonly cartao_id: string | null
  readonly fatura_id: string | null
  readonly installment_group_id: string | null
  readonly installment_number: number | null
  readonly installment_total: number | null
  readonly origem: Lancamento['origem']
  readonly classificacao_origem: 'regra' | 'historico' | null
  readonly classificacao_motivo: string | null
}

const COLUNAS = `id, conta_id, cartao_id, categoria_id, valor_centavos, moeda, posted_at,
                 settled_at, descricao, transfer_group_id, estorno_de_lancamento_id,
                 fatura_id, installment_group_id, installment_number, installment_total,
                 origem, classificacao_origem, classificacao_motivo`

function paraContrato(l: Linha, agora: Date): Lancamento {
  const status: StatusDeLancamento = statusDeLancamento(
    { postedAt: l.posted_at, settledAt: l.settled_at },
    agora,
  )
  return {
    id: l.id,
    contaId: l.conta_id,
    categoriaId: l.categoria_id,
    valorCentavos: l.valor_centavos,
    moeda: l.moeda,
    postedAt: l.posted_at.toISOString(),
    settledAt: l.settled_at ? l.settled_at.toISOString() : null,
    // Derivado na leitura, nunca persistido: um enum ao lado das datas que o
    // determinam é estado inválido representável.
    status,
    descricao: l.descricao,
    transferGroupId: l.transfer_group_id,
    estornoDeLancamentoId: l.estorno_de_lancamento_id,
    cartaoId: l.cartao_id,
    faturaId: l.fatura_id,
    installmentGroupId: l.installment_group_id,
    installmentNumero: l.installment_number,
    installmentTotal: l.installment_total,
    origem: l.origem,
    classificacaoOrigem: l.classificacao_origem,
    classificacaoMotivo: l.classificacao_motivo,
  }
}

export class ContaInexistente extends Error {
  constructor() {
    super('Conta não encontrada.')
    this.name = 'ContaInexistente'
  }
}

export class LancamentoInexistente extends Error {
  constructor() {
    super('Lançamento não encontrado.')
    this.name = 'LancamentoInexistente'
  }
}

export class EstornoExcedeOriginal extends Error {
  constructor(readonly disponivel: bigint) {
    super(`O estorno passa do que resta do original. Disponível: ${disponivel} centavos.`)
    this.name = 'EstornoExcedeOriginal'
  }
}

/**
 * ADR 0023 D6. Não é preciosismo de validação: sem isto, um estorno com data
 * anterior à compra cairia numa fatura **já paga** — e a regra que o ADR
 * inteiro existe para proteger é que fatura fechada não se reescreve.
 */
export class EstornoAntesDoOriginal extends Error {
  constructor() {
    super('O estorno não pode ser anterior ao lançamento que ele desfaz.')
    this.name = 'EstornoAntesDoOriginal'
  }
}

export async function listar(
  cliente: PoolClient,
  tenantId: string,
  janela: { de: Date; ate: Date },
  agora: Date,
): Promise<Lancamento[]> {
  const r = await cliente.query<Linha>(
    `SELECT ${COLUNAS} FROM lancamentos
      WHERE tenant_id = $1 AND deleted_at IS NULL
        AND posted_at >= $2 AND posted_at < $3
      ORDER BY posted_at DESC, id DESC`,
    [tenantId, janela.de, janela.ate],
  )
  return r.rows.map((l) => paraContrato(l, agora))
}

/**
 * Os lançamentos de uma fatura.
 *
 * Sem janela de tempo, e é o ponto: a fatura **é** a janela. Um parcelamento
 * põe na fatura de dezembro uma parcela cujo `posted_at` é de maio, e filtrar
 * por período aqui esconderia justamente as parcelas que compõem o total.
 *
 * A ordenação é por data crescente, ao contrário do extrato: uma fatura se lê
 * do começo do ciclo para o fim, como um comprovante.
 */
export async function listarDaFatura(
  cliente: PoolClient,
  tenantId: string,
  faturaId: string,
  agora: Date,
): Promise<Lancamento[]> {
  const r = await cliente.query<Linha>(
    `SELECT ${COLUNAS} FROM lancamentos
      WHERE tenant_id = $1 AND fatura_id = $2 AND deleted_at IS NULL
      ORDER BY posted_at ASC, id ASC`,
    [tenantId, faturaId],
  )
  return r.rows.map((l) => paraContrato(l, agora))
}

export async function buscarPorId(
  cliente: PoolClient,
  tenantId: string,
  id: string,
  agora: Date,
): Promise<Lancamento | null> {
  const r = await cliente.query<Linha>(
    `SELECT ${COLUNAS} FROM lancamentos
      WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [tenantId, id],
  )
  const l = r.rows[0]
  return l ? paraContrato(l, agora) : null
}

export async function criar(
  cliente: PoolClient,
  tenantId: string,
  usuarioId: string,
  dados: CriarLancamento,
  agora: Date,
): Promise<Lancamento> {
  const postedAt = new Date(dados.postedAt)
  const r = await cliente.query<Linha>(
    `INSERT INTO lancamentos (tenant_id, conta_id, categoria_id, valor_centavos, moeda,
                              posted_at, settled_at, descricao, observacao, criado_por)
     SELECT $1, c.id, $3, $4, c.moeda, $5, $6, $7, $8, $9
       FROM contas c
      WHERE c.tenant_id = $1 AND c.id = $2 AND c.deleted_at IS NULL
     RETURNING ${COLUNAS}`,
    [
      tenantId,
      dados.contaId,
      dados.categoriaId,
      dados.valorCentavos,
      postedAt,
      // Compensar no ato usa a própria competência: o dinheiro se moveu quando
      // o fato aconteceu. Usar `now()` deslocaria para o instante da digitação,
      // que pode ser dias depois — e o saldo do dia sairia errado.
      dados.compensado ? postedAt : null,
      dados.descricao,
      dados.observacao ?? null,
      usuarioId,
    ],
  )
  const l = r.rows[0]
  if (!l) throw new ContaInexistente()
  return paraContrato(l, agora)
}

/**
 * Cria as duas pernas numa transação só.
 *
 * O chamador informa **magnitude positiva**; o sinal de cada perna é derivado
 * aqui. Aceitar o sinal do cliente permitiria duas pernas do mesmo sinal — que
 * o gatilho recusaria no commit, mas com um erro de banco em vez de uma
 * mensagem que a pessoa entenda.
 */
export async function criarTransferencia(
  cliente: PoolClient,
  tenantId: string,
  usuarioId: string,
  dados: CriarTransferencia,
  agora: Date,
): Promise<Lancamento[]> {
  const grupo = await cliente.query<{ id: string }>(
    `INSERT INTO transferencias (tenant_id, descricao, criado_por)
     VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, dados.descricao, usuarioId],
  )
  const grupoId = grupo.rows[0]?.id
  if (!grupoId) throw new Error('transferência não devolveu id')

  const postedAt = new Date(dados.postedAt)
  const settledAt = dados.compensado ? postedAt : null
  const magnitude = BigInt(dados.valorCentavos)

  const pernas: Lancamento[] = []
  for (const [contaId, valor] of [
    [dados.deContaId, -magnitude],
    [dados.paraContaId, magnitude],
  ] as const) {
    const r = await cliente.query<Linha>(
      `INSERT INTO lancamentos (tenant_id, conta_id, valor_centavos, moeda, posted_at,
                                settled_at, descricao, transfer_group_id, criado_por)
       SELECT $1, c.id, $3, c.moeda, $4, $5, $6, $7, $8
         FROM contas c
        WHERE c.tenant_id = $1 AND c.id = $2 AND c.deleted_at IS NULL
       RETURNING ${COLUNAS}`,
      [tenantId, contaId, valor.toString(), postedAt, settledAt, dados.descricao, grupoId, usuarioId],
    )
    const l = r.rows[0]
    if (!l) throw new ContaInexistente()
    pernas.push(paraContrato(l, agora))
  }
  return pernas
}

/**
 * Estorno: lançamento novo, de sinal oposto, apontando para o original.
 *
 * O acumulado é conferido **no banco**, com `FOR UPDATE`, dentro da mesma
 * transação. Conferir na aplicação deixaria dois estornos concorrentes
 * passarem juntos do total do original — e o extrato ficaria com mais estorno
 * do que despesa.
 */
export async function estornar(
  cliente: PoolClient,
  tenantId: string,
  usuarioId: string,
  originalId: string,
  dados: CriarEstorno,
  agora: Date,
): Promise<Lancamento> {
  const orig = await cliente.query<{
    valor_centavos: string
    conta_id: string | null
    cartao_id: string | null
    categoria_id: string | null
    posted_at: Date
    estornado: string
  }>(
    `SELECT o.valor_centavos, o.conta_id, o.cartao_id, o.categoria_id, o.posted_at,
            coalesce((SELECT sum(abs(e.valor_centavos)) FROM lancamentos e
                       WHERE e.estorno_de_lancamento_id = o.id AND e.deleted_at IS NULL), 0)::text
              AS estornado
       FROM lancamentos o
      WHERE o.tenant_id = $1 AND o.id = $2 AND o.deleted_at IS NULL
      FOR UPDATE`,
    [tenantId, originalId],
  )
  const o = orig.rows[0]
  if (!o) throw new LancamentoInexistente()

  const original = BigInt(o.valor_centavos)
  const magnitudeOriginal = original < 0n ? -original : original
  const disponivel = magnitudeOriginal - BigInt(o.estornado)
  const pedido = BigInt(dados.valorCentavos)

  if (pedido > disponivel) throw new EstornoExcedeOriginal(disponivel)

  const postedAt = new Date(dados.postedAt)
  // ADR 0023 D6: um crédito antes da despesa não descreve nada real. Vale
  // para os dois tipos — na conta produziria saldo negativo por uma janela
  // que nunca existiu; no cartão, crédito numa fatura anterior à compra.
  if (postedAt.getTime() < o.posted_at.getTime()) throw new EstornoAntesDoOriginal()

  const valor = original < 0n ? pedido : -pedido

  // ------------------------------------------------------------------------
  // Cartão — ADR 0023
  // ------------------------------------------------------------------------
  // O crédito entra na fatura cuja janela contém o **seu** `posted_at`, e não
  // na da compra original. É a regra 10 aplicada sem exceção: não existe um
  // segundo caminho de colocação de lançamento em fatura, e por isso o
  // reembolso passa por `faturaQueRecebe`, a mesma função da compra.
  //
  // `settled_at` fica **nulo**. Quem move dinheiro num lançamento de cartão é
  // o pagamento da fatura (regra 8); preenchê-lo aqui poria o crédito no
  // realizado antes de a fatura ser paga — e, se a fatura for de um mês
  // futuro, no realizado de um mês que ainda não chegou.
  if (o.cartao_id) {
    const cartao = await carregarCartaoDaCompra(cliente, tenantId, o.cartao_id)
    const fatura = await faturaQueRecebe(cliente, tenantId, cartao, faturaAlvo(cartao, postedAt))

    const r = await cliente.query<Linha>(
      `INSERT INTO lancamentos (tenant_id, cartao_id, categoria_id, valor_centavos, moeda,
                                posted_at, settled_at, descricao, fatura_id,
                                estorno_de_lancamento_id, origem, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, 'ajuste', $10)
       RETURNING ${COLUNAS}`,
      [
        tenantId,
        o.cartao_id,
        o.categoria_id,
        valor.toString(),
        cartao.moeda,
        postedAt,
        dados.descricao ?? 'Estorno',
        fatura.id,
        originalId,
        usuarioId,
      ],
    )
    const l = r.rows[0]
    if (!l) throw new ConflictException('Não foi possível registrar o estorno.')
    return paraContrato(l, agora)
  }

  // ------------------------------------------------------------------------
  // Conta — inalterado
  // ------------------------------------------------------------------------
  // Aqui `settled_at` é preenchido de propósito: quem estorna um lançamento de
  // conta está informando que o dinheiro voltou. Não há fatura no meio.
  const r = await cliente.query<Linha>(
    `INSERT INTO lancamentos (tenant_id, conta_id, categoria_id, valor_centavos, moeda,
                              posted_at, settled_at, descricao,
                              estorno_de_lancamento_id, origem, criado_por)
     SELECT $1, $2, $3, $4, c.moeda, $5, $5, $6, $7, 'ajuste', $8
       FROM contas c WHERE c.tenant_id = $1 AND c.id = $2
     RETURNING ${COLUNAS}`,
    [
      tenantId,
      o.conta_id,
      o.categoria_id,
      valor.toString(),
      postedAt,
      dados.descricao ?? 'Estorno',
      originalId,
      usuarioId,
    ],
  )
  const l = r.rows[0]
  if (!l) throw new ContaInexistente()
  return paraContrato(l, agora)
}
