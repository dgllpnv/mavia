import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { resumoDoPeriodo } from '@mavia/domain'
import { baldesDoPeriodo, saldoDerivadoDaConta } from '../src/agregacao/agregacao.js'
import { comoApp, semearDoisTenants, subirPostgres, TENANT_A, USUARIO_A, type BancoDeTeste } from './postgres.js'

/**
 * O núcleo financeiro, contra Postgres real.
 *
 * Não testa se a aplicação lembra de somar certo; testa que o desenho não
 * deixa somar errado.
 */

let banco: BancoDeTeste
let contaA = ''
let contaB = ''
let catDespesa = ''
let catReceita = ''

const AGORA = new Date('2026-09-15T12:00:00Z')
const DE = new Date('2026-09-01T03:00:00Z') // 00h de 1º/set em São Paulo
const ATE = new Date('2026-10-01T03:00:00Z')

/** Executa como superusuário: os testes precisam montar cenários. */
async function comoDono<T>(trabalho: (c: PoolClient) => Promise<T>): Promise<T> {
  return trabalho(banco.cliente as unknown as PoolClient)
}

async function lancar(dados: {
  conta: string
  categoria?: string
  centavos: bigint
  postedAt: Date
  settledAt?: Date | null
  transferGroup?: string
}): Promise<string> {
  const r = await banco.cliente.query<{ id: string }>(
    `INSERT INTO lancamentos (tenant_id, conta_id, categoria_id, valor_centavos, moeda,
                              posted_at, settled_at, descricao, transfer_group_id, criado_por)
     VALUES ($1,$2,$3,$4,'BRL',$5,$6,'teste',$7,$8) RETURNING id`,
    [
      TENANT_A,
      dados.conta,
      dados.categoria ?? null,
      dados.centavos.toString(),
      dados.postedAt,
      dados.settledAt ?? null,
      dados.transferGroup ?? null,
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
     VALUES ($1,'Corrente',100000), ($1,'Reserva',0) RETURNING id`,
    [TENANT_A],
  )
  contaA = c.rows[0]!.id
  contaB = c.rows[1]!.id

  const cat = await banco.cliente.query<{ id: string }>(
    `INSERT INTO categorias (tenant_id, nivel, nome, natureza)
     VALUES ($1,1,'Alimentação','despesa'), ($1,1,'Salário','receita') RETURNING id`,
    [TENANT_A],
  )
  catDespesa = cat.rows[0]!.id
  catReceita = cat.rows[1]!.id
})

afterAll(async () => {
  await banco?.encerrar()
})

describe('categoria — árvore de dois níveis', () => {
  it('subcategoria herda a natureza do pai', async () => {
    const r = await banco.cliente.query<{ id: string }>(
      `INSERT INTO categorias (tenant_id, parent_id, nivel, nome, natureza)
       VALUES ($1,$2,2,'Mercado','despesa') RETURNING id`,
      [TENANT_A, catDespesa],
    )
    expect(r.rows[0]?.id).toBeTruthy()
  })

  it('recusa subcategoria com natureza diferente do pai', async () => {
    // Uma subcategoria de receita pendurada numa raiz de despesa inverteria o
    // sinal do relatório sem que nada reclamasse.
    await expect(
      banco.cliente.query(
        `INSERT INTO categorias (tenant_id, parent_id, nivel, nome, natureza)
         VALUES ($1,$2,2,'Errada','receita')`,
        [TENANT_A, catDespesa],
      ),
    ).rejects.toThrow(/SUBCATEGORIA_HERDA_NATUREZA/)
  })

  it('recusa um terceiro nível', async () => {
    const sub = await banco.cliente.query<{ id: string }>(
      `INSERT INTO categorias (tenant_id, parent_id, nivel, nome, natureza)
       VALUES ($1,$2,2,'Feira','despesa') RETURNING id`,
      [TENANT_A, catDespesa],
    )
    await expect(
      banco.cliente.query(
        `INSERT INTO categorias (tenant_id, parent_id, nivel, nome, natureza)
         VALUES ($1,$2,2,'Neta','despesa')`,
        [TENANT_A, sub.rows[0]!.id],
      ),
    ).rejects.toThrow(/ARVORE_TEM_DOIS_NIVEIS/)
  })

  it('só categoria analítica recebe lançamento', async () => {
    const sintetica = await banco.cliente.query<{ id: string }>(
      `INSERT INTO categorias (tenant_id, nivel, nome, natureza, analitica)
       VALUES ($1,1,'Sintética','despesa',false) RETURNING id`,
      [TENANT_A],
    )
    await expect(
      lancar({
        conta: contaA,
        categoria: sintetica.rows[0]!.id,
        centavos: -1000n,
        postedAt: AGORA,
      }),
    ).rejects.toThrow(/CATEGORIA_NAO_ANALITICA/)
  })
})

describe('sinal e natureza precisam concordar', () => {
  it('recusa despesa com valor positivo', async () => {
    await expect(
      lancar({ conta: contaA, categoria: catDespesa, centavos: 5000n, postedAt: AGORA }),
    ).rejects.toThrow(/DESPESA_TEM_SINAL_NEGATIVO/)
  })

  it('recusa receita com valor negativo', async () => {
    await expect(
      lancar({ conta: contaA, categoria: catReceita, centavos: -5000n, postedAt: AGORA }),
    ).rejects.toThrow(/RECEITA_TEM_SINAL_POSITIVO/)
  })

  it('recusa valor zero', async () => {
    await expect(
      lancar({ conta: contaA, categoria: catDespesa, centavos: 0n, postedAt: AGORA }),
    ).rejects.toThrow(/valor_nao_zero/)
  })
})

describe('transferência de duas pernas', () => {
  it('aceita as duas pernas somando zero', async () => {
    const g = await banco.cliente.query<{ id: string }>(
      `INSERT INTO transferencias (tenant_id, descricao, criado_por)
       VALUES ($1,'Para a reserva',$2) RETURNING id`,
      [TENANT_A, USUARIO_A],
    )
    const grupo = g.rows[0]!.id

    await banco.cliente.query('BEGIN')
    await lancar({ conta: contaA, centavos: -30000n, postedAt: AGORA, settledAt: AGORA, transferGroup: grupo })
    await lancar({ conta: contaB, centavos: 30000n, postedAt: AGORA, settledAt: AGORA, transferGroup: grupo })
    await banco.cliente.query('COMMIT')

    const r = await banco.cliente.query<{ n: string }>(
      'SELECT count(*) AS n FROM lancamentos WHERE transfer_group_id = $1',
      [grupo],
    )
    expect(Number(r.rows[0]?.n)).toBe(2)
  })

  it('recusa uma perna sozinha', async () => {
    // Perna isolada cria ou destrói dinheiro do nada.
    const g = await banco.cliente.query<{ id: string }>(
      `INSERT INTO transferencias (tenant_id, descricao, criado_por)
       VALUES ($1,'Torta',$2) RETURNING id`,
      [TENANT_A, USUARIO_A],
    )
    await banco.cliente.query('BEGIN')
    await lancar({ conta: contaA, centavos: -1000n, postedAt: AGORA, transferGroup: g.rows[0]!.id })
    await expect(banco.cliente.query('COMMIT')).rejects.toThrow(/TRANSFERENCIA_TEM_DUAS_PERNAS/)
  })

  it('recusa pernas que não somam zero', async () => {
    const g = await banco.cliente.query<{ id: string }>(
      `INSERT INTO transferencias (tenant_id, descricao, criado_por)
       VALUES ($1,'Desbalanceada',$2) RETURNING id`,
      [TENANT_A, USUARIO_A],
    )
    await banco.cliente.query('BEGIN')
    await lancar({ conta: contaA, centavos: -1000n, postedAt: AGORA, transferGroup: g.rows[0]!.id })
    await lancar({ conta: contaB, centavos: 900n, postedAt: AGORA, transferGroup: g.rows[0]!.id })
    await expect(banco.cliente.query('COMMIT')).rejects.toThrow(/TRANSFERENCIA_SOMA_ZERO/)
  })

  it('recusa transferência para a própria conta', async () => {
    const g = await banco.cliente.query<{ id: string }>(
      `INSERT INTO transferencias (tenant_id, descricao, criado_por)
       VALUES ($1,'Circular',$2) RETURNING id`,
      [TENANT_A, USUARIO_A],
    )
    await banco.cliente.query('BEGIN')
    await lancar({ conta: contaA, centavos: -1000n, postedAt: AGORA, transferGroup: g.rows[0]!.id })
    await lancar({ conta: contaA, centavos: 1000n, postedAt: AGORA, transferGroup: g.rows[0]!.id })
    await expect(banco.cliente.query('COMMIT')).rejects.toThrow(
      /TRANSFERENCIA_ENTRE_CONTAS_DISTINTAS/,
    )
  })

  it('perna de transferência não tem categoria, e lançamento comum tem', async () => {
    const g = await banco.cliente.query<{ id: string }>(
      `INSERT INTO transferencias (tenant_id, descricao, criado_por)
       VALUES ($1,'Com categoria',$2) RETURNING id`,
      [TENANT_A, USUARIO_A],
    )
    await expect(
      lancar({
        conta: contaA,
        categoria: catDespesa,
        centavos: -1000n,
        postedAt: AGORA,
        transferGroup: g.rows[0]!.id,
      }),
    ).rejects.toThrow(/categoria_obrigatoria_fora_de_transferencia/)

    await expect(lancar({ conta: contaA, centavos: -1000n, postedAt: AGORA })).rejects.toThrow(
      /categoria_obrigatoria_fora_de_transferencia/,
    )
  })
})

describe('o rodapé não mente', () => {
  it('transferência entra no saldo da conta e não em receita nem despesa', async () => {
    // O defeito B1 exatamente: R$ 1.000,00 de saldo inicial, R$ 300,00
    // transferidos para fora. O rodapé mostrava R$ 1.000,00; o real é R$ 700,00.
    const baldes = await comoApp(banco.cliente, { tenantId: TENANT_A, usuarioId: USUARIO_A }, () =>
      baldesDoPeriodo(banco.cliente as unknown as PoolClient, {
        tenantId: TENANT_A,
        de: DE,
        ate: ATE,
        contaId: contaA,
        moeda: 'BRL',
        agora: AGORA,
      }),
    )

    expect(baldes.receitaRealizada.centavos).toBe(0n)
    expect(baldes.despesaRealizada.centavos).toBe(0n)
    expect(baldes.transferenciaLiquidaRealizada.centavos).toBe(-30000n)
  })

  it('a identidade fecha: anterior + receita + despesa + transferência = saldo', async () => {
    const baldes = await comoApp(banco.cliente, { tenantId: TENANT_A, usuarioId: USUARIO_A }, () =>
      baldesDoPeriodo(banco.cliente as unknown as PoolClient, {
        tenantId: TENANT_A,
        de: DE,
        ate: ATE,
        contaId: contaA,
        moeda: 'BRL',
        agora: AGORA,
      }),
    )

    const resumo = resumoDoPeriodo(baldes)
    expect(resumo.ok).toBe(true)
    if (!resumo.ok) return

    const soma =
      baldes.saldoAnterior.centavos +
      baldes.receitaRealizada.centavos +
      baldes.despesaRealizada.centavos +
      baldes.transferenciaLiquidaRealizada.centavos
    expect(resumo.valor.saldo.centavos).toBe(soma)
  })
})

describe('saldo derivado', () => {
  it('conta só o que se moveu, e soma o saldo inicial', async () => {
    // Corrente: inicial R$ 1.000,00, menos R$ 300,00 transferidos e compensados.
    const saldo = await comoApp(banco.cliente, { tenantId: TENANT_A, usuarioId: USUARIO_A }, () =>
      saldoDerivadoDaConta(banco.cliente as unknown as PoolClient, TENANT_A, contaA, 'BRL'),
    )

    expect(saldo.centavos).toBe(70000n)
  })

  it('lançamento não compensado não entra no saldo', async () => {
    await lancar({ conta: contaB, categoria: catDespesa, centavos: -5000n, postedAt: AGORA })

    const saldo = await comoApp(banco.cliente, { tenantId: TENANT_A, usuarioId: USUARIO_A }, () =>
      saldoDerivadoDaConta(banco.cliente as unknown as PoolClient, TENANT_A, contaB, 'BRL'),
    )

    // Reserva recebeu R$ 300,00 compensados; a despesa de R$ 50,00 é pendente.
    expect(saldo.centavos).toBe(30000n)
  })
})

describe('estorno no banco', () => {
  it('o par original mais estorno some do saldo', async () => {
    const original = await lancar({
      conta: contaB,
      categoria: catDespesa,
      centavos: -8000n,
      postedAt: AGORA,
      settledAt: AGORA,
    })

    const antes = await comoApp(banco.cliente, { tenantId: TENANT_A, usuarioId: USUARIO_A }, () =>
      saldoDerivadoDaConta(banco.cliente as unknown as PoolClient, TENANT_A, contaB, 'BRL'),
    )

    await banco.cliente.query(
      `INSERT INTO lancamentos (tenant_id, conta_id, categoria_id, valor_centavos, moeda,
                                posted_at, settled_at, descricao, estorno_de_lancamento_id, criado_por)
       VALUES ($1,$2,$3,8000,'BRL',$4,$4,'estorno',$5,$6)`,
      [TENANT_A, contaB, catDespesa, AGORA, original, USUARIO_A],
    )

    const depois = await comoApp(banco.cliente, { tenantId: TENANT_A, usuarioId: USUARIO_A }, () =>
      saldoDerivadoDaConta(banco.cliente as unknown as PoolClient, TENANT_A, contaB, 'BRL'),
    )

    expect(depois.centavos - antes.centavos).toBe(8000n)
  })

  it('um lançamento não estorna a si mesmo', async () => {
    const id = await lancar({
      conta: contaB,
      categoria: catDespesa,
      centavos: -100n,
      postedAt: AGORA,
    })
    await expect(
      banco.cliente.query('UPDATE lancamentos SET estorno_de_lancamento_id = id WHERE id = $1', [id]),
    ).rejects.toThrow(/estorno_nao_e_o_proprio/)
  })
})
