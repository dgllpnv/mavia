import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { faturaAlvo, gerarParcelas, janelaDaFatura, vencimentoDaFatura } from '@mavia/domain'
import { semearDoisTenants, subirPostgres, TENANT_A, USUARIO_A, type BancoDeTeste } from './postgres.js'

/**
 * Cartão, fatura e parcelamento, contra Postgres real.
 *
 * O que estes testes protegem: uma compra não pode ser cobrada duas vezes nem
 * sumir, o pagamento de fatura não pode virar despesa, e a fatura fechada não
 * pode mudar depois que o usuário a viu.
 */

let banco: BancoDeTeste
let conta = ''
let cartao = ''
let catDespesa = ''

const CICLO = { closingDay: 25, dueDay: 5 }

/** Cria a fatura de uma competência a partir do ciclo, como o domínio manda. */
async function criarFatura(competencia: { ano: number; mes: number }): Promise<string> {
  const janela = janelaDaFatura(CICLO, competencia)
  const venc = vencimentoDaFatura(CICLO, competencia)
  const fecha = new Date(janela.fim.getTime() - 1)

  const r = await banco.cliente.query<{ id: string }>(
    `INSERT INTO faturas (tenant_id, cartao_id, periodo_inicio, periodo_fim,
                          data_fechamento, data_vencimento, competencia, conta_pagamento_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      TENANT_A,
      cartao,
      janela.inicio,
      janela.fim,
      fecha.toISOString().slice(0, 10),
      `${venc.ano}-${String(venc.mes).padStart(2, '0')}-${String(venc.dia).padStart(2, '0')}`,
      `${venc.ano}-${String(venc.mes).padStart(2, '0')}-01`,
      conta,
    ],
  )
  return r.rows[0]!.id
}

async function comprarNoCartao(dados: {
  fatura: string
  centavos: bigint
  postedAt: Date
  grupo?: string
  numero?: number
  total?: number
}): Promise<string> {
  const r = await banco.cliente.query<{ id: string }>(
    `INSERT INTO lancamentos (tenant_id, cartao_id, categoria_id, valor_centavos, moeda,
                              posted_at, descricao, fatura_id, installment_group_id,
                              installment_number, installment_total, criado_por)
     VALUES ($1,$2,$3,$4,'BRL',$5,'compra',$6,$7,$8,$9,$10) RETURNING id`,
    [
      TENANT_A,
      cartao,
      catDespesa,
      dados.centavos.toString(),
      dados.postedAt,
      dados.fatura,
      dados.grupo ?? null,
      dados.numero ?? null,
      dados.total ?? null,
      USUARIO_A,
    ],
  )
  return r.rows[0]!.id
}

beforeAll(async () => {
  banco = await subirPostgres()
  await semearDoisTenants(banco.cliente)

  const c = await banco.cliente.query<{ id: string }>(
    `INSERT INTO contas (tenant_id, nome, saldo_inicial_centavos)
     VALUES ($1,'Corrente',500000) RETURNING id`,
    [TENANT_A],
  )
  conta = c.rows[0]!.id

  const cat = await banco.cliente.query<{ id: string }>(
    `INSERT INTO categorias (tenant_id, nivel, nome, natureza)
     VALUES ($1,1,'Compras','despesa') RETURNING id`,
    [TENANT_A],
  )
  catDespesa = cat.rows[0]!.id

  const cr = await banco.cliente.query<{ id: string }>(
    `INSERT INTO cartoes (tenant_id, nome, limite_centavos, closing_day, due_day, conta_pagamento_id)
     VALUES ($1,'Nubank',500000,25,5,$2) RETURNING id`,
    [TENANT_A, conta],
  )
  cartao = cr.rows[0]!.id
})

afterAll(async () => {
  await banco?.encerrar()
})

describe('o ciclo de faturas não se sobrepõe', () => {
  it('aceita faturas de meses consecutivos, que encostam exatamente', async () => {
    const outubro = await criarFatura({ ano: 2026, mes: 10 })
    const novembro = await criarFatura({ ano: 2026, mes: 11 })

    expect(outubro).toBeTruthy()
    expect(novembro).toBeTruthy()

    const r = await banco.cliente.query<{ fim: Date; inicio: Date }>(
      `SELECT a.periodo_fim AS fim, b.periodo_inicio AS inicio
         FROM faturas a, faturas b WHERE a.id = $1 AND b.id = $2`,
      [outubro, novembro],
    )
    // Contiguidade verificável por igualdade — é o ponto da janela semiaberta.
    expect(r.rows[0]!.fim.getTime()).toBe(r.rows[0]!.inicio.getTime())
  })

  it('recusa duas faturas cobrindo o mesmo instante', async () => {
    // Sem esta restrição, a mesma compra cai em duas faturas e é cobrada duas
    // vezes. O banco verifica, em vez de a aplicação lembrar.
    const janela = janelaDaFatura(CICLO, { ano: 2026, mes: 10 })
    await expect(
      banco.cliente.query(
        `INSERT INTO faturas (tenant_id, cartao_id, periodo_inicio, periodo_fim,
                              data_fechamento, data_vencimento, competencia)
         VALUES ($1,$2,$3,$4,'2026-10-25','2026-11-05','2026-11-01')`,
        [TENANT_A, cartao, new Date(janela.inicio.getTime() + 86_400_000), janela.fim],
      ),
    ).rejects.toThrow(/faturas_nao_se_sobrepoem/)
  })
})

describe('a compra cai na fatura certa', () => {
  it('compra no dia exato do fechamento entra na fatura que fecha naquele dia', async () => {
    // A regra 10: "compras APÓS o fechamento caem na seguinte" — e o dia do
    // fechamento não é após o fechamento.
    const compra = new Date('2026-10-25T18:00:00Z')
    expect(faturaAlvo(CICLO, compra)).toEqual({ ano: 2026, mes: 10 })

    const fatura = await banco.cliente.query<{ id: string }>(
      `SELECT id FROM faturas WHERE cartao_id = $1 AND competencia = '2026-11-01'`,
      [cartao],
    )
    const id = await comprarNoCartao({
      fatura: fatura.rows[0]!.id,
      centavos: -20000n,
      postedAt: compra,
    })
    expect(id).toBeTruthy()
  })

  it('compra no dia seguinte cai na fatura seguinte', () => {
    expect(faturaAlvo(CICLO, new Date('2026-10-26T12:00:00Z'))).toEqual({ ano: 2026, mes: 11 })
  })
})

describe('fatura fechada é imutável', () => {
  it('recusa lançamento novo em fatura fechada', async () => {
    // Aceitar mudaria um total que o usuário já viu — e possivelmente já pagou.
    const fatura = await criarFatura({ ano: 2026, mes: 12 })
    await banco.cliente.query(`UPDATE faturas SET estado = 'fechada' WHERE id = $1`, [fatura])

    await expect(
      comprarNoCartao({
        fatura,
        centavos: -5000n,
        postedAt: new Date('2026-11-30T12:00:00Z'),
      }),
    ).rejects.toThrow(/FATURA_FECHADA_NAO_RECEBE/)
  })
})

describe('parcelamento', () => {
  it('gera N parcelas somando exatamente a compra, uma por fatura', async () => {
    // R$ 100,00 em 3x: as parcelas somam −10000, e o resto vai na primeira.
    // Ano próprio, para não esbarrar na fatura que outro teste fecha.
    const compra = new Date('2029-10-10T15:00:00Z')
    const parcelas = gerarParcelas({ centavos: -10000n, moeda: 'BRL' }, 3, compra)
    expect(parcelas.ok).toBe(true)
    if (!parcelas.ok) return

    const grupo = await banco.cliente.query<{ id: string }>(
      `INSERT INTO parcelamentos (tenant_id, cartao_id, data_compra, valor_total_centavos,
                                  moeda, parcelas, descricao, criado_por)
       VALUES ($1,$2,$3,-10000,'BRL',3,'Compra 3x',$4) RETURNING id`,
      [TENANT_A, cartao, compra, USUARIO_A],
    )
    const grupoId = grupo.rows[0]!.id

    for (const p of parcelas.valor) {
      const competencia = faturaAlvo(CICLO, p.postedAt)
      const existente = await banco.cliente.query<{ id: string }>(
        `SELECT id FROM faturas WHERE cartao_id = $1 AND periodo_inicio = $2`,
        [cartao, janelaDaFatura(CICLO, competencia).inicio],
      )
      const faturaId = existente.rows[0]?.id ?? (await criarFatura(competencia))

      await comprarNoCartao({
        fatura: faturaId,
        centavos: p.valor.centavos,
        postedAt: p.postedAt,
        grupo: grupoId,
        numero: p.numero,
        total: p.total,
      })
    }

    const soma = await banco.cliente.query<{ soma: string; n: string }>(
      `SELECT coalesce(sum(valor_centavos),0)::text AS soma, count(*)::text AS n
         FROM lancamentos WHERE installment_group_id = $1`,
      [grupoId],
    )
    // A invariante mais citada do ADR 0007.
    expect(soma.rows[0]!.soma).toBe('-10000')
    expect(Number(soma.rows[0]!.n)).toBe(3)
  })

  it('o banco recusa parcelamento indivisível', async () => {
    // R$ 0,01 em 3x produziria parcelas de valor zero.
    await expect(
      banco.cliente.query(
        `INSERT INTO parcelamentos (tenant_id, cartao_id, data_compra, valor_total_centavos,
                                    moeda, parcelas, descricao, criado_por)
         VALUES ($1,$2,now(),-1,'BRL',3,'Indivisível',$3)`,
        [TENANT_A, cartao, USUARIO_A],
      ),
    ).rejects.toThrow(/parcelamento_divisivel/)
  })

  it('a data da compra vive no grupo, e não nas parcelas', async () => {
    // Um fato pertence à compra, não a cada parcela. Replicá-lo permitiria N
    // cópias divergentes de uma data só.
    const colunas = await banco.cliente.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns
        WHERE table_name = 'lancamentos' AND column_name = 'data_compra'`,
    )
    expect(colunas.rows[0]!.n).toBe('0')
  })
})

describe('pagamento de fatura', () => {
  it('é transferência, e a perna do cartão não entra na fatura', async () => {
    // O erro clássico da categoria: contar o pagamento como despesa duplica o
    // gasto do mês. O `CHECK` impede a perna de crédito de entrar na fatura,
    // onde zeraria o total dela.
    const fatura = await criarFatura({ ano: 2027, mes: 1 })

    const g = await banco.cliente.query<{ id: string }>(
      `INSERT INTO transferencias (tenant_id, tipo, fatura_id, descricao, criado_por)
       VALUES ($1,'pagamento_fatura',$2,'Pagamento da fatura',$3) RETURNING id`,
      [TENANT_A, fatura, USUARIO_A],
    )
    const grupo = g.rows[0]!.id
    const quando = new Date('2027-01-05T12:00:00Z')

    await banco.cliente.query('BEGIN')
    // Perna de débito, na conta.
    await banco.cliente.query(
      `INSERT INTO lancamentos (tenant_id, conta_id, valor_centavos, moeda, posted_at,
                                settled_at, descricao, transfer_group_id, criado_por)
       VALUES ($1,$2,-20000,'BRL',$3,$3,'Pagamento',$4,$5)`,
      [TENANT_A, conta, quando, grupo, USUARIO_A],
    )
    // Perna de crédito, no cartão — SEM fatura_id.
    await banco.cliente.query(
      `INSERT INTO lancamentos (tenant_id, cartao_id, valor_centavos, moeda, posted_at,
                                settled_at, descricao, transfer_group_id, criado_por)
       VALUES ($1,$2,20000,'BRL',$3,$3,'Pagamento',$4,$5)`,
      [TENANT_A, cartao, quando, grupo, USUARIO_A],
    )
    await banco.cliente.query('COMMIT')

    // O vínculo pagamento ↔ fatura é `transferencias.fatura_id`, e só ele.
    const v = await banco.cliente.query<{ fatura_id: string }>(
      'SELECT fatura_id FROM transferencias WHERE id = $1',
      [grupo],
    )
    expect(v.rows[0]!.fatura_id).toBe(fatura)

    // E nenhuma perna aponta para a fatura.
    const pernas = await banco.cliente.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM lancamentos
        WHERE transfer_group_id = $1 AND fatura_id IS NOT NULL`,
      [grupo],
    )
    expect(pernas.rows[0]!.n).toBe('0')
  })

  it('recusa a perna de crédito apontando para a fatura', async () => {
    // Se entrasse, a fatura somaria a própria quitação e o total iria a zero.
    const fatura = await criarFatura({ ano: 2027, mes: 2 })
    const g = await banco.cliente.query<{ id: string }>(
      `INSERT INTO transferencias (tenant_id, tipo, fatura_id, descricao, criado_por)
       VALUES ($1,'pagamento_fatura',$2,'Errado',$3) RETURNING id`,
      [TENANT_A, fatura, USUARIO_A],
    )

    await expect(
      banco.cliente.query(
        `INSERT INTO lancamentos (tenant_id, cartao_id, valor_centavos, moeda, posted_at,
                                  descricao, transfer_group_id, fatura_id, criado_por)
         VALUES ($1,$2,20000,'BRL',now(),'Errado',$3,$4,$5)`,
        [TENANT_A, cartao, g.rows[0]!.id, fatura, USUARIO_A],
      ),
    ).rejects.toThrow(/cartao_tem_fatura/)
  })

  it('o pagamento não aparece como despesa em nenhum balde de gasto', async () => {
    // As pernas têm `transfer_group_id`, e a agregação as manda para o balde
    // de transferência por construção — não por um `AND` que alguém lembrou.
    const r = await banco.cliente.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM lancamentos
        WHERE tenant_id = $1 AND transfer_group_id IS NOT NULL AND categoria_id IS NOT NULL`,
      [TENANT_A],
    )
    expect(r.rows[0]!.n).toBe('0')
  })
})

describe('lançamento de cartão fora do eixo caixa', () => {
  it('compra de cartão não tem conta, então não pode entrar no saldo de conta nenhuma', async () => {
    // Uma compra não sai do bolso — quem sai é a fatura. O `CHECK` de origem
    // única já garante que lançamento de cartão não tem `conta_id`.
    const r = await banco.cliente.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM lancamentos
        WHERE tenant_id = $1 AND cartao_id IS NOT NULL AND conta_id IS NOT NULL`,
      [TENANT_A],
    )
    expect(r.rows[0]!.n).toBe('0')
  })

  it('compra de cartão nasce sem compensação', async () => {
    // `settled_at` só é escrito quando a fatura é paga. Nascer compensada
    // punha o realizado de 2027 pronto hoje — foi o defeito que aposentou o
    // nome `effective_at`.
    const r = await banco.cliente.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM lancamentos
        WHERE tenant_id = $1 AND cartao_id IS NOT NULL
          AND transfer_group_id IS NULL AND settled_at IS NOT NULL`,
      [TENANT_A],
    )
    expect(r.rows[0]!.n).toBe('0')
  })
})

describe('fechar e pagar a fatura', () => {
  it('fechar trava o total com a soma dos lançamentos da fatura', async () => {
    const fatura = await criarFatura({ ano: 2028, mes: 3 })
    const dentro = new Date('2028-02-10T12:00:00Z')
    await comprarNoCartao({ fatura, centavos: -30000n, postedAt: dentro })
    await comprarNoCartao({ fatura, centavos: -20000n, postedAt: dentro })

    const r = await banco.cliente.query<{ fechar_fatura: string }>(
      'SELECT fechar_fatura($1,$2) AS fechar_fatura',
      [TENANT_A, fatura],
    )

    expect(r.rows[0]!.fechar_fatura).toBe('-50000')
  })

  it('fechar duas vezes é recusado, e não silenciosamente idempotente', async () => {
    // Idempotente seria pior: recalcularia o total de uma fatura que já pode
    // ter sido paga, e esconderia o erro de quem chamou.
    const fatura = await criarFatura({ ano: 2028, mes: 4 })
    await banco.cliente.query('SELECT fechar_fatura($1,$2)', [TENANT_A, fatura])

    await expect(
      banco.cliente.query('SELECT fechar_fatura($1,$2)', [TENANT_A, fatura]),
    ).rejects.toThrow(/FATURA_JA_FECHADA/)
  })

  it('pagar antes de fechar é recusado', async () => {
    // Pagar um total que ainda pode mudar.
    const fatura = await criarFatura({ ano: 2028, mes: 5 })
    await expect(
      banco.cliente.query('SELECT registrar_pagamento_de_fatura($1,$2,$3,now())', [
        TENANT_A,
        fatura,
        10000,
      ]),
    ).rejects.toThrow(/FATURA_AINDA_ABERTA/)
  })

  it('a compra só compensa quando a fatura é quitada', async () => {
    // É o pagamento que move o dinheiro, não a compra. Enquanto a fatura não
    // é paga, a compra está no Realizado do mês e fora do Saldo.
    const fatura = await criarFatura({ ano: 2028, mes: 6 })
    const compra = await comprarNoCartao({
      fatura,
      centavos: -40000n,
      postedAt: new Date('2028-05-10T12:00:00Z'),
    })

    const antes = await banco.cliente.query<{ settled_at: Date | null }>(
      'SELECT settled_at FROM lancamentos WHERE id = $1',
      [compra],
    )
    expect(antes.rows[0]!.settled_at).toBeNull()

    await banco.cliente.query('SELECT fechar_fatura($1,$2)', [TENANT_A, fatura])
    const quando = new Date('2028-06-05T12:00:00Z')
    await banco.cliente.query('SELECT registrar_pagamento_de_fatura($1,$2,$3,$4)', [
      TENANT_A,
      fatura,
      40000,
      quando,
    ])

    const depois = await banco.cliente.query<{ settled_at: Date | null }>(
      'SELECT settled_at FROM lancamentos WHERE id = $1',
      [compra],
    )
    expect(depois.rows[0]!.settled_at?.toISOString()).toBe(quando.toISOString())
  })

  it('pagamento parcial não compensa nada', async () => {
    // Metade do dinheiro ter saído não torna metade das compras compensadas —
    // não há como dizer quais.
    const fatura = await criarFatura({ ano: 2028, mes: 7 })
    const compra = await comprarNoCartao({
      fatura,
      centavos: -60000n,
      postedAt: new Date('2028-06-10T12:00:00Z'),
    })
    await banco.cliente.query('SELECT fechar_fatura($1,$2)', [TENANT_A, fatura])

    const r = await banco.cliente.query<{ registrar_pagamento_de_fatura: string }>(
      'SELECT registrar_pagamento_de_fatura($1,$2,$3,now()) AS registrar_pagamento_de_fatura',
      [TENANT_A, fatura, 20000],
    )
    expect(r.rows[0]!.registrar_pagamento_de_fatura).toBe('parcialmente_paga')

    const l = await banco.cliente.query<{ settled_at: Date | null }>(
      'SELECT settled_at FROM lancamentos WHERE id = $1',
      [compra],
    )
    expect(l.rows[0]!.settled_at).toBeNull()
  })

  it('a soma dos pagamentos parciais quita a fatura', async () => {
    const fatura = await criarFatura({ ano: 2028, mes: 8 })
    await comprarNoCartao({
      fatura,
      centavos: -10000n,
      postedAt: new Date('2028-07-10T12:00:00Z'),
    })
    await banco.cliente.query('SELECT fechar_fatura($1,$2)', [TENANT_A, fatura])

    // A data do pagamento precisa ser posterior à da compra: compensar antes
    // do fato acontecer é impossível, e o `CHECK` recusa.
    const quitacao = new Date('2028-08-05T12:00:00Z')
    await banco.cliente.query('SELECT registrar_pagamento_de_fatura($1,$2,$3,$4)', [
      TENANT_A,
      fatura,
      6000,
      quitacao,
    ])
    const r = await banco.cliente.query<{ registrar_pagamento_de_fatura: string }>(
      'SELECT registrar_pagamento_de_fatura($1,$2,$3,$4) AS registrar_pagamento_de_fatura',
      [TENANT_A, fatura, 4000, quitacao],
    )

    expect(r.rows[0]!.registrar_pagamento_de_fatura).toBe('paga')
  })

  it('recusa pagamento maior que a fatura', async () => {
    const fatura = await criarFatura({ ano: 2028, mes: 9 })
    await comprarNoCartao({
      fatura,
      centavos: -10000n,
      postedAt: new Date('2028-08-10T12:00:00Z'),
    })
    await banco.cliente.query('SELECT fechar_fatura($1,$2)', [TENANT_A, fatura])

    await expect(
      banco.cliente.query('SELECT registrar_pagamento_de_fatura($1,$2,$3,now())', [
        TENANT_A,
        fatura,
        10001,
      ]),
    ).rejects.toThrow(/PAGAMENTO_EXCEDE_A_FATURA/)
  })

  it('o pagamento não vira despesa: a fatura paga sai da projeção e entra a perna', async () => {
    // A invariante que impede a dupla contagem. Uma fatura entra na projeção
    // enquanto não está paga; depois, quem representa a saída é a perna de
    // débito da transferência, na conta. Nunca as duas.
    const emAberto = await banco.cliente.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM faturas
        WHERE tenant_id = $1 AND estado <> 'paga' AND deleted_at IS NULL`,
      [TENANT_A],
    )
    const pagas = await banco.cliente.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM faturas
        WHERE tenant_id = $1 AND estado = 'paga' AND deleted_at IS NULL`,
      [TENANT_A],
    )

    expect(Number(emAberto.rows[0]!.n)).toBeGreaterThan(0)
    expect(Number(pagas.rows[0]!.n)).toBeGreaterThan(0)
    // Nenhuma fatura paga entra no índice do eixo caixa, que é parcial em
    // `estado <> 'paga'`.
  })
})
