import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { BALDES, resumoDoPeriodo } from '@mavia/domain'
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

  it('categoria não analítica RECEBE lançamento — a regra de folha não existe', async () => {
    // Revertido pelo ADR 0021. `analitica` significa "não é fato econômico",
    // não "é folha da árvore". Quem mantém o lançamento fora do relatório de
    // gasto é o balde `nao_analitica`, não uma recusa na escrita.
    const sintetica = await banco.cliente.query<{ id: string }>(
      `INSERT INTO categorias (tenant_id, nivel, nome, natureza, analitica)
       VALUES ($1,1,'Sintética','despesa',false) RETURNING id`,
      [TENANT_A],
    )
    const id = await lancar({
      conta: contaA,
      categoria: sintetica.rows[0]!.id,
      centavos: -1000n,
      postedAt: AGORA,
    })
    expect(id).toBeTruthy()
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
      /TRANSFERENCIA_ENTRE_RECIPIENTES_DISTINTOS/,
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
        eixo: 'caixa',
        tenantId: TENANT_A,
        de: DE,
        ate: ATE,
        contaId: contaA,
        moeda: 'BRL',
        agora: AGORA,
      }),
    )

    expect(baldes.baldes.receita.realizada.centavos).toBe(0n)
    expect(baldes.baldes.despesa.realizada.centavos).toBe(0n)
    expect(baldes.baldes.transferencia.realizada.centavos).toBe(-30000n)
  })

  it('a identidade fecha: anterior + receita + despesa + transferência = saldo', async () => {
    const baldes = await comoApp(banco.cliente, { tenantId: TENANT_A, usuarioId: USUARIO_A }, () =>
      baldesDoPeriodo(banco.cliente as unknown as PoolClient, {
        eixo: 'caixa',
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

    // Percorre o enum em vez de listar campos: um balde novo entra sozinho,
    // e é isso que impede o defeito de voltar.
    const soma =
      baldes.saldoAnterior.centavos +
      BALDES.reduce((acc, b) => acc + baldes.baldes[b].realizada.centavos, 0n)
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

describe('RP-4 — a identidade do eixo caixa com lançamento pendente', () => {
  it('despesa pendente não pode entrar no realizado do eixo caixa', async () => {
    // Achado do `validador-financeiro`, cenário RP-4. `realizado = efetivado +
    // pendente` é a definição do eixo COMPETÊNCIA, e foi aplicada ao SQL sem
    // qualificar o eixo — enquanto `saldo` conta só `efetivado`. O resultado
    // são três números na mesma tela que não fecham.
    const conta = await banco.cliente.query<{ id: string }>(
      `INSERT INTO contas (tenant_id, nome, saldo_inicial_centavos)
       VALUES ($1,'RP4',100000) RETURNING id`,
      [TENANT_A],
    )
    const id = conta.rows[0]!.id

    // Único movimento: despesa de R$ 100,00 que ainda não compensou.
    await lancar({
      conta: id,
      categoria: catDespesa,
      centavos: -10000n,
      postedAt: new Date('2026-09-10T12:00:00Z'),
      settledAt: null,
    })

    const baldes = await comoApp(banco.cliente, { tenantId: TENANT_A, usuarioId: USUARIO_A }, () =>
      baldesDoPeriodo(banco.cliente as unknown as PoolClient, {
        tenantId: TENANT_A,
        de: DE,
        ate: ATE,
        contaId: id,
        moeda: 'BRL',
        agora: new Date('2026-09-30T23:00:00Z'),
        eixo: 'caixa',
      }),
    )

    // No eixo caixa, o que não se moveu é PREVISTO.
    expect(baldes.baldes.despesa.realizada.centavos).toBe(0n)
    expect(baldes.baldes.despesa.prevista.centavos).toBe(-10000n)

    const resumo = resumoDoPeriodo(baldes)
    if (!resumo.ok) return
    expect(resumo.valor.saldo.centavos).toBe(100000n)
    expect(resumo.valor.projetado.centavos).toBe(90000n)
  })

  it('no eixo competência, a mesma despesa pendente é realizada', async () => {
    // A outra leitura, igualmente correta — no eixo dela. O que não pode é
    // misturar as duas na mesma resposta.
    const conta = await banco.cliente.query<{ id: string }>(
      `INSERT INTO contas (tenant_id, nome, saldo_inicial_centavos)
       VALUES ($1,'RP4-comp',0) RETURNING id`,
      [TENANT_A],
    )
    const id = conta.rows[0]!.id
    await lancar({
      conta: id,
      categoria: catDespesa,
      centavos: -10000n,
      postedAt: new Date('2026-09-10T12:00:00Z'),
      settledAt: null,
    })

    const baldes = await comoApp(banco.cliente, { tenantId: TENANT_A, usuarioId: USUARIO_A }, () =>
      baldesDoPeriodo(banco.cliente as unknown as PoolClient, {
        tenantId: TENANT_A,
        de: DE,
        ate: ATE,
        contaId: id,
        moeda: 'BRL',
        agora: new Date('2026-09-30T23:00:00Z'),
        eixo: 'competencia',
      }),
    )

    expect(baldes.baldes.despesa.realizada.centavos).toBe(-10000n)
    expect(baldes.baldes.despesa.prevista.centavos).toBe(0n)
  })
})

describe('as invariantes que a bateria encontrou', () => {
  it('ES-5 — excluir o original de um estorno criaria dinheiro, e é recusado', async () => {
    const conta = await banco.cliente.query<{ id: string }>(
      `INSERT INTO contas (tenant_id, nome) VALUES ($1,'ES5') RETURNING id`,
      [TENANT_A],
    )
    const id = conta.rows[0]!.id
    const original = await lancar({
      conta: id,
      categoria: catDespesa,
      centavos: -10000n,
      postedAt: AGORA,
      settledAt: AGORA,
    })
    await banco.cliente.query(
      `INSERT INTO lancamentos (tenant_id, conta_id, categoria_id, valor_centavos, moeda,
                                posted_at, settled_at, descricao, estorno_de_lancamento_id, criado_por)
       VALUES ($1,$2,$3,10000,'BRL',$4,$4,'estorno',$5,$6)`,
      [TENANT_A, id, catDespesa, AGORA, original, USUARIO_A],
    )

    // O par soma zero. Excluir só o original deixaria +R$ 100,00 do nada.
    await expect(
      banco.cliente.query('UPDATE lancamentos SET deleted_at = now() WHERE id = $1', [original]),
    ).rejects.toThrow(/ORIGINAL_TEM_ESTORNO_VIVO/)
  })

  it('TR-7 — as duas pernas compensam juntas, ou nenhuma compensa', async () => {
    // Entre contas próprias a transferência é instantânea por definição. Uma
    // perna compensada e outra não faz o Saldo geral perder o valor por um dia,
    // e a tela diz que a pessoa empobreceu.
    const g = await banco.cliente.query<{ id: string }>(
      `INSERT INTO transferencias (tenant_id, descricao, criado_por)
       VALUES ($1,'Meia compensada',$2) RETURNING id`,
      [TENANT_A, USUARIO_A],
    )
    await banco.cliente.query('BEGIN')
    await lancar({
      conta: contaA,
      centavos: -50000n,
      postedAt: AGORA,
      settledAt: AGORA,
      transferGroup: g.rows[0]!.id,
    })
    await lancar({
      conta: contaB,
      centavos: 50000n,
      postedAt: AGORA,
      settledAt: null,
      transferGroup: g.rows[0]!.id,
    })
    await expect(banco.cliente.query('COMMIT')).rejects.toThrow(/TRANSFERENCIA_COMPENSA_JUNTO/)
  })

  it('duas pernas ambas não compensadas são coerentes', async () => {
    const g = await banco.cliente.query<{ id: string }>(
      `INSERT INTO transferencias (tenant_id, descricao, criado_por)
       VALUES ($1,'Agendada',$2) RETURNING id`,
      [TENANT_A, USUARIO_A],
    )
    await banco.cliente.query('BEGIN')
    await lancar({ conta: contaA, centavos: -1000n, postedAt: AGORA, transferGroup: g.rows[0]!.id })
    await lancar({ conta: contaB, centavos: 1000n, postedAt: AGORA, transferGroup: g.rows[0]!.id })
    await banco.cliente.query('COMMIT')

    const r = await banco.cliente.query<{ n: string }>(
      'SELECT count(*) AS n FROM lancamentos WHERE transfer_group_id = $1',
      [g.rows[0]!.id],
    )
    expect(Number(r.rows[0]?.n)).toBe(2)
  })
})

describe('o balde que faltava — "Ajuste de saldo"', () => {
  it('categoria não analítica agora recebe lançamento', async () => {
    // Era inalcançável: o gatilho da 0006 recusava lançamento em categoria não
    // analítica, e o sétimo balde nunca foi escrito porque nada podia cair
    // nele. A regra passou a ser "não é fato econômico", não "é folha".
    const ajuste = await banco.cliente.query<{ id: string }>(
      `SELECT id FROM categorias
        WHERE tenant_id = $1 AND nome = 'Ajuste de saldo' AND natureza = 'receita'`,
      [TENANT_A],
    )
    expect(ajuste.rows[0]?.id).toBeTruthy()

    const id = await lancar({
      conta: contaA,
      categoria: ajuste.rows[0]!.id,
      centavos: 500n,
      postedAt: AGORA,
      settledAt: AGORA,
    })
    expect(id).toBeTruthy()
  })

  it('a categoria-raiz com filhas recebe lançamento', async () => {
    // "Uso Casa há seis meses, agora quero separar Luz e Água." A raiz precisa
    // poder guardar o que estava lá antes de os galhos existirem.
    const raiz = await banco.cliente.query<{ id: string }>(
      `INSERT INTO categorias (tenant_id, nivel, nome, natureza)
       VALUES ($1,1,'Casa','despesa') RETURNING id`,
      [TENANT_A],
    )
    await banco.cliente.query(
      `INSERT INTO categorias (tenant_id, parent_id, nivel, nome, natureza)
       VALUES ($1,$2,2,'Luz','despesa')`,
      [TENANT_A, raiz.rows[0]!.id],
    )

    const id = await lancar({
      conta: contaA,
      categoria: raiz.rows[0]!.id,
      centavos: -4000n,
      postedAt: AGORA,
    })
    expect(id).toBeTruthy()
  })

  it('o ajuste vai para o balde próprio, e não para receita', async () => {
    const baldes = await comoApp(banco.cliente, { tenantId: TENANT_A, usuarioId: USUARIO_A }, () =>
      baldesDoPeriodo(banco.cliente as unknown as PoolClient, {
        eixo: 'caixa',
        tenantId: TENANT_A,
        de: DE,
        ate: ATE,
        contaId: contaA,
        moeda: 'BRL',
        agora: AGORA,
      }),
    )

    expect(baldes.baldes.nao_analitica.realizada.centavos).toBe(500n)
    // E não contaminou a receita.
    expect(baldes.baldes.receita.realizada.centavos).toBe(0n)
  })

  it('todo balde do enum aparece na resposta, mesmo zerado', async () => {
    // Balde que some da resposta é o defeito original: a grandeza existe, move
    // o saldo, e não tem linha no rodapé.
    const baldes = await comoApp(banco.cliente, { tenantId: TENANT_A, usuarioId: USUARIO_A }, () =>
      baldesDoPeriodo(banco.cliente as unknown as PoolClient, {
        eixo: 'competencia',
        tenantId: TENANT_A,
        de: new Date('2035-01-01T03:00:00Z'),
        ate: new Date('2035-02-01T03:00:00Z'),
        moeda: 'BRL',
        agora: AGORA,
      }),
    )

    for (const b of BALDES) {
      expect(baldes.baldes[b].realizada.centavos).toBe(0n)
      expect(baldes.baldes[b].prevista.centavos).toBe(0n)
    }
  })
})
