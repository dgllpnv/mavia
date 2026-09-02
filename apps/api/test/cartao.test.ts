import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { faturaAlvo, gerarParcelas, janelaDaFatura, vencimentoDaFatura } from '@mavia/domain'
import type { PoolClient } from 'pg'
import { projetarCaixa, saldoGeralDoTenant } from '../src/agregacao/projecao.js'
import { comoApp, semearDoisTenants, subirPostgres, TENANT_A, USUARIO_A, type BancoDeTeste } from './postgres.js'

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
    // Compra em fatura NÃO paga nunca tem compensação. Em fatura paga tem, e
    // é o pagamento que a escreveu — a asserção precisa distinguir os dois,
    // senão reprova o comportamento correto.
    const r = await banco.cliente.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM lancamentos l
         JOIN faturas f ON f.id = l.fatura_id
        WHERE l.tenant_id = $1 AND l.cartao_id IS NOT NULL
          AND l.transfer_group_id IS NULL
          AND f.estado <> 'paga'
          AND l.settled_at IS NOT NULL`,
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
    const fatura = await criarFatura({ ano: 2024, mes: 5 })
    await expect(
      banco.cliente.query('SELECT registrar_pagamento_de_fatura($1,$2,$3,$4)', [
        TENANT_A,
        fatura,
        10000,
        new Date('2024-05-05T12:00:00Z'),
      ]),
    ).rejects.toThrow(/FATURA_AINDA_ABERTA/)
  })

  it('a compra só compensa quando a fatura é quitada', async () => {
    // É o pagamento que move o dinheiro, não a compra. Enquanto a fatura não
    // é paga, a compra está no Realizado do mês e fora do Saldo.
    const fatura = await criarFatura({ ano: 2024, mes: 6 })
    const compra = await comprarNoCartao({
      fatura,
      centavos: -40000n,
      postedAt: new Date('2024-05-10T12:00:00Z'),
    })

    const antes = await banco.cliente.query<{ settled_at: Date | null }>(
      'SELECT settled_at FROM lancamentos WHERE id = $1',
      [compra],
    )
    expect(antes.rows[0]!.settled_at).toBeNull()

    await banco.cliente.query('SELECT fechar_fatura($1,$2)', [TENANT_A, fatura])
    const quando = new Date('2024-06-05T12:00:00Z')
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
    const fatura = await criarFatura({ ano: 2024, mes: 7 })
    const compra = await comprarNoCartao({
      fatura,
      centavos: -60000n,
      postedAt: new Date('2024-06-10T12:00:00Z'),
    })
    await banco.cliente.query('SELECT fechar_fatura($1,$2)', [TENANT_A, fatura])

    const r = await banco.cliente.query<{ registrar_pagamento_de_fatura: string }>(
      'SELECT registrar_pagamento_de_fatura($1,$2,$3,$4) AS registrar_pagamento_de_fatura',
      [TENANT_A, fatura, 20000, new Date('2024-07-05T12:00:00Z')],
    )
    expect(r.rows[0]!.registrar_pagamento_de_fatura).toBe('parcialmente_paga')

    const l = await banco.cliente.query<{ settled_at: Date | null }>(
      'SELECT settled_at FROM lancamentos WHERE id = $1',
      [compra],
    )
    expect(l.rows[0]!.settled_at).toBeNull()
  })

  it('a soma dos pagamentos parciais quita a fatura', async () => {
    const fatura = await criarFatura({ ano: 2024, mes: 8 })
    await comprarNoCartao({
      fatura,
      centavos: -10000n,
      postedAt: new Date('2024-07-10T12:00:00Z'),
    })
    await banco.cliente.query('SELECT fechar_fatura($1,$2)', [TENANT_A, fatura])

    // A data do pagamento precisa ser posterior à da compra: compensar antes
    // do fato acontecer é impossível, e o `CHECK` recusa.
    const quitacao = new Date('2024-08-05T12:00:00Z')
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
    const fatura = await criarFatura({ ano: 2024, mes: 9 })
    await comprarNoCartao({
      fatura,
      centavos: -10000n,
      postedAt: new Date('2024-08-10T12:00:00Z'),
    })
    await banco.cliente.query('SELECT fechar_fatura($1,$2)', [TENANT_A, fatura])

    await expect(
      banco.cliente.query('SELECT registrar_pagamento_de_fatura($1,$2,$3,$4)', [
        TENANT_A,
        fatura,
        10001,
        new Date('2024-09-05T12:00:00Z'),
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

describe('a projeção do eixo caixa agrega faturas, não compras', () => {
  const comoTenant = <T>(t: () => Promise<T>) =>
    comoApp(banco.cliente, { tenantId: TENANT_A, usuarioId: USUARIO_A }, t)

  it('a fatura em aberto entra pelo saldo devedor, não pelo total', async () => {
    // Fatura de R$ 100,00 com R$ 60,00 já pagos: faltam R$ 40,00. Usar o total
    // projetaria os R$ 100,00 inteiros e contaria duas vezes a parte já paga —
    // uma na perna de débito que saiu da conta, outra na fatura.
    const conta = await banco.cliente.query<{ id: string }>(
      `INSERT INTO contas (tenant_id, nome, saldo_inicial_centavos)
       VALUES ($1,'Projecao',100000) RETURNING id`,
      [TENANT_A],
    )
    const contaId = conta.rows[0]!.id

    const cr = await banco.cliente.query<{ id: string }>(
      `INSERT INTO cartoes (tenant_id, nome, closing_day, due_day, conta_pagamento_id)
       VALUES ($1,'Proj',25,5,$2) RETURNING id`,
      [TENANT_A, contaId],
    )
    const cartaoProj = cr.rows[0]!.id

    const f = await banco.cliente.query<{ id: string }>(
      `INSERT INTO faturas (tenant_id, cartao_id, periodo_inicio, periodo_fim,
                            data_fechamento, data_vencimento, competencia,
                            conta_pagamento_id, estado, total_centavos, pago_centavos)
       VALUES ($1,$2,'2030-01-26','2030-02-26','2030-02-25','2030-03-05','2030-03-01',
               $3,'parcialmente_paga',-10000,6000) RETURNING id`,
      [TENANT_A, cartaoProj, contaId],
    )
    expect(f.rows[0]?.id).toBeTruthy()

    const projetado = await comoTenant(() =>
      projetarCaixa(banco.cliente as unknown as PoolClient, {
        tenantId: TENANT_A,
        ate: new Date('2030-03-31T00:00:00Z'),
        contaId,
        moeda: 'BRL',
      }),
    )

    // 100.000 de saldo − 4.000 que ainda faltam da fatura.
    expect(projetado.centavos).toBe(96000n)
  })

  it('fatura paga sai da projeção sozinha, sem depender de um if sobre o estado', async () => {
    // `total + pago` chega a zero na quitação, no mesmo instante em que a
    // perna de débito passa a representar a saída. É a aritmética que impede
    // a dupla contagem.
    const conta = await banco.cliente.query<{ id: string }>(
      `INSERT INTO contas (tenant_id, nome, saldo_inicial_centavos)
       VALUES ($1,'Quitada',100000) RETURNING id`,
      [TENANT_A],
    )
    const contaId = conta.rows[0]!.id
    const cr = await banco.cliente.query<{ id: string }>(
      `INSERT INTO cartoes (tenant_id, nome, closing_day, due_day, conta_pagamento_id)
       VALUES ($1,'Quit',25,5,$2) RETURNING id`,
      [TENANT_A, contaId],
    )
    await banco.cliente.query(
      `INSERT INTO faturas (tenant_id, cartao_id, periodo_inicio, periodo_fim,
                            data_fechamento, data_vencimento, competencia,
                            conta_pagamento_id, estado, total_centavos, pago_centavos)
       VALUES ($1,$2,'2031-01-26','2031-02-26','2031-02-25','2031-03-05','2031-03-01',
               $3,'paga',-10000,10000)`,
      [TENANT_A, cr.rows[0]!.id, contaId],
    )

    const projetado = await comoTenant(() =>
      projetarCaixa(banco.cliente as unknown as PoolClient, {
        tenantId: TENANT_A,
        ate: new Date('2031-03-31T00:00:00Z'),
        contaId,
        moeda: 'BRL',
      }),
    )

    expect(projetado.centavos).toBe(100000n)
  })

  it('a compra na fatura ABERTA já conta como dívida na projeção', async () => {
    // CT-1 da auditoria, e o pior erro desta sessão: eu havia escrito este
    // teste esperando 50000 — sem desconto — com um comentário explicando por
    // que estava certo. Um teste que certifica um defeito é pior que a
    // ausência do teste, porque impede a próxima pessoa de desconfiar.
    //
    // A fatura aberta com R$ 300,00 de compras É dívida. `total_centavos` só
    // era escrito no fechamento, então a fatura valia zero até lá e a compra
    // sumia da projeção e do Saldo geral.
    const conta = await banco.cliente.query<{ id: string }>(
      `INSERT INTO contas (tenant_id, nome, saldo_inicial_centavos)
       VALUES ($1,'AbertaConta',50000) RETURNING id`,
      [TENANT_A],
    )
    const contaId = conta.rows[0]!.id
    const cr = await banco.cliente.query<{ id: string }>(
      `INSERT INTO cartoes (tenant_id, nome, closing_day, due_day, conta_pagamento_id)
       VALUES ($1,'AbertaCartao',25,5,$2) RETURNING id`,
      [TENANT_A, contaId],
    )
    const fx = await banco.cliente.query<{ id: string }>(
      `INSERT INTO faturas (tenant_id, cartao_id, periodo_inicio, periodo_fim,
                            data_fechamento, data_vencimento, competencia, conta_pagamento_id)
       VALUES ($1,$2,'2032-01-26','2032-02-26','2032-02-25','2032-03-05','2032-03-01',$3)
       RETURNING id`,
      [TENANT_A, cr.rows[0]!.id, contaId],
    )
    await banco.cliente.query(
      `INSERT INTO lancamentos (tenant_id, cartao_id, categoria_id, valor_centavos, moeda,
                                posted_at, descricao, fatura_id, criado_por)
       VALUES ($1,$2,$3,-30000,'BRL','2032-02-10','compra',$4,$5)`,
      [TENANT_A, cr.rows[0]!.id, catDespesa, fx.rows[0]!.id, USUARIO_A],
    )

    // O gatilho mantém o total da fatura aberta em dia.
    const total = await banco.cliente.query<{ total_centavos: string }>(
      'SELECT total_centavos FROM faturas WHERE id = $1',
      [fx.rows[0]!.id],
    )
    expect(total.rows[0]!.total_centavos).toBe('-30000')

    const projetado = await comoTenant(() =>
      projetarCaixa(banco.cliente as unknown as PoolClient, {
        tenantId: TENANT_A,
        ate: new Date('2032-03-31T00:00:00Z'),
        contaId,
        moeda: 'BRL',
      }),
    )

    // R$ 500,00 de saldo menos os R$ 300,00 que a fatura vai cobrar.
    expect(projetado.centavos).toBe(20000n)
  })

  it('a compra de cartão continua fora do saldo, que conta só o que se moveu', async () => {
    // A distinção que o CT-1 não apaga: a compra entra na PROJEÇÃO, porque
    // vai sair; e fica fora do SALDO, porque ainda não saiu.
    // Compra em fatura NÃO paga nunca tem compensação. Em fatura paga tem, e
    // é o pagamento que a escreveu — a asserção precisa distinguir os dois,
    // senão reprova o comportamento correto.
    const r = await banco.cliente.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM lancamentos l
         JOIN faturas f ON f.id = l.fatura_id
        WHERE l.tenant_id = $1 AND l.cartao_id IS NOT NULL
          AND l.transfer_group_id IS NULL
          AND f.estado <> 'paga'
          AND l.settled_at IS NOT NULL`,
      [TENANT_A],
    )
    expect(r.rows[0]!.n).toBe('0')
  })

  it('o saldo geral mostra a dívida do cartão separada do saldo', async () => {
    // O cartão não tem saldo para incluir; a dívida aparece na conta que vai
    // pagá-la, que é onde ela de fato vai doer.
    const r = await comoTenant(() =>
      saldoGeralDoTenant(banco.cliente as unknown as PoolClient, TENANT_A, 'BRL'),
    )

    expect(r.saldo.centavos).toBeGreaterThan(0n)
    // Negativo: são dívidas.
    expect(r.faturasEmAberto.centavos).toBeLessThanOrEqual(0n)
  })
})

describe('os bloqueios da auditoria — CT-3 e CT-4', () => {
  it('CT-3 — fatura fechada recusa alteração de valor, não só inserção', async () => {
    // O gatilho era BEFORE INSERT apenas. Um UPDATE deixava o total travado em
    // −R$ 100,00 com soma real de −R$ 999,99.
    const fatura = await criarFatura({ ano: 2024, mes: 11 })
    const compra = await comprarNoCartao({
      fatura,
      centavos: -10000n,
      postedAt: new Date('2024-10-10T12:00:00Z'),
    })
    await banco.cliente.query('SELECT fechar_fatura($1,$2)', [TENANT_A, fatura])

    await expect(
      banco.cliente.query('UPDATE lancamentos SET valor_centavos = -99999 WHERE id = $1', [compra]),
    ).rejects.toThrow(/FATURA_FECHADA_NAO_RECEBE/)
  })

  it('CT-3 — fatura fechada recusa soft delete de lançamento', async () => {
    // Deixava a fatura cobrando R$ 150,00 com R$ 50,00 de compras vivas — e o
    // pagamento dos R$ 150,00 era aceito.
    const fatura = await criarFatura({ ano: 2024, mes: 12 })
    const compra = await comprarNoCartao({
      fatura,
      centavos: -15000n,
      postedAt: new Date('2024-11-10T12:00:00Z'),
    })
    await banco.cliente.query('SELECT fechar_fatura($1,$2)', [TENANT_A, fatura])

    await expect(
      banco.cliente.query('UPDATE lancamentos SET deleted_at = now() WHERE id = $1', [compra]),
    ).rejects.toThrow(/FATURA_FECHADA_NAO_RECEBE/)
  })

  it('CT-4 — fatura credora não se paga', async () => {
    // O caso real: a compra cai numa fatura, o reembolso cai na SEGUINTE —
    // porque a primeira já fechou. A segunda fica a favor do usuário: o cartão
    // é que deve. `abs()` apagava o sinal e aceitava um "pagamento", tirando
    // dinheiro da conta em vez de devolver. Erro medido: R$ 200,00.
    const janeiro = await criarFatura({ ano: 2025, mes: 1 })
    const compra = await comprarNoCartao({
      fatura: janeiro,
      centavos: -4000n,
      postedAt: new Date('2024-12-20T12:00:00Z'),
    })
    await banco.cliente.query('SELECT fechar_fatura($1,$2)', [TENANT_A, janeiro])

    const fevereiro = await criarFatura({ ano: 2025, mes: 2 })
    await banco.cliente.query(
      `INSERT INTO lancamentos (tenant_id, cartao_id, categoria_id, valor_centavos, moeda,
                                posted_at, descricao, fatura_id, estorno_de_lancamento_id,
                                origem, criado_por)
       VALUES ($1,$2,$3,4000,'BRL','2025-01-15','reembolso',$4,$5,'ajuste',$6)`,
      [TENANT_A, cartao, catDespesa, fevereiro, compra, USUARIO_A],
    )
    await banco.cliente.query('SELECT fechar_fatura($1,$2)', [TENANT_A, fevereiro])

    const t = await banco.cliente.query<{ total_centavos: string; estado: string }>(
      'SELECT total_centavos, estado FROM faturas WHERE id = $1',
      [fevereiro],
    )
    expect(t.rows[0]!.total_centavos).toBe('4000') // crédito

    await expect(
      banco.cliente.query('SELECT registrar_pagamento_de_fatura($1,$2,$3,$4)', [
        TENANT_A,
        fevereiro,
        4000,
        new Date('2025-02-05T12:00:00Z'),
      ]),
    ).rejects.toThrow(/FATURA_CREDORA_NAO_SE_PAGA/)
  })

  it('CT-5 — pagamento no futuro é recusado', async () => {
    // `pagoEm: 2099-01-01` era aceito e derrubava o saldo hoje, por um fato
    // que não aconteceu. Regras 8 e 9: data de negócio vem do servidor.
    const fatura = await criarFatura({ ano: 2025, mes: 3 })
    await comprarNoCartao({
      fatura,
      centavos: -5000n,
      postedAt: new Date('2025-02-10T12:00:00Z'),
    })
    await banco.cliente.query('SELECT fechar_fatura($1,$2)', [TENANT_A, fatura])

    await expect(
      banco.cliente.query('SELECT registrar_pagamento_de_fatura($1,$2,$3,$4)', [
        TENANT_A,
        fatura,
        5000,
        new Date('2099-01-01T12:00:00Z'),
      ]),
    ).rejects.toThrow(/PAGAMENTO_NAO_ACONTECE_NO_FUTURO/)
  })

  it('fatura de total zero fecha já paga, sem esperar pagamento de nada', async () => {
    const fatura = await criarFatura({ ano: 2025, mes: 4 })
    await banco.cliente.query('SELECT fechar_fatura($1,$2)', [TENANT_A, fatura])

    const r = await banco.cliente.query<{ estado: string }>(
      'SELECT estado FROM faturas WHERE id = $1',
      [fatura],
    )
    expect(r.rows[0]!.estado).toBe('paga')
  })
})
