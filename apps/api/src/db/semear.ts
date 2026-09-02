import { hash } from '@node-rs/argon2'
import { Client } from 'pg'

/**
 * `pnpm db:seed` — um espaço de demonstração no banco local.
 *
 * Existe porque o cadastro por e-mail ainda não tem rota (P-3 em
 * `docs/pendencias.md`): sem semente, não há como entrar na aplicação local.
 *
 * **Só para desenvolvimento.** Roda como superusuário e grava uma senha
 * conhecida, o que em produção seria uma porta dos fundos. A checagem de que a
 * URL é local não é cerimônia — é o que impede alguém de apontar a variável de
 * ambiente para a VPS e criar lá um usuário com senha pública.
 *
 * É idempotente: rodar duas vezes não duplica nada.
 */

const URL_PADRAO = 'postgres://mavia:mavia_local_dev@127.0.0.1:4732/mavia'

const EMAIL = 'demo@mavia.local'
const SENHA = 'mavia-demonstracao'

const TENANT = 'dbdbdbdb-0000-4000-8000-000000000001'
const USUARIO = 'dbdbdbdb-0000-4000-8000-0000000000a1'

/** Meio-dia em São Paulo: longe de qualquer borda de fuso. */
const meioDia = (dia: string): string => `${dia}T15:00:00Z`

async function principal(): Promise<void> {
  const url = process.env['DATABASE_URL_SEED'] ?? URL_PADRAO
  if (!url.includes('127.0.0.1') && !url.includes('localhost')) {
    throw new Error(
      'A semente só roda contra banco local. Ela grava uma senha conhecida, ' +
        'e num banco de verdade isso é uma porta dos fundos.',
    )
  }

  const c = new Client({ connectionString: url })
  await c.connect()

  try {
    // `mavia_app` nasce NOLOGIN na migration: quem concede credencial é o
    // provisionamento do ambiente, não a migration. Em produção isso é o SRE;
    // aqui é a semente, que já é o script do ambiente local.
    await c.query(`ALTER ROLE mavia_app LOGIN PASSWORD 'mavia_local_dev'`)

    const jaTem = await c.query('SELECT 1 FROM tenants WHERE id = $1', [TENANT])
    if (jaTem.rowCount) {
      console.log(`espaço de demonstração já existe — entre com ${EMAIL} / ${SENHA}`)
      return
    }

    await c.query('BEGIN')

    await c.query(`INSERT INTO tenants (id, nome) VALUES ($1, 'Família Demonstração')`, [TENANT])
    await c.query(
      `INSERT INTO usuarios (id, email, nome, email_verificado_em, senha_hash)
       VALUES ($1, $2, 'Pessoa de Demonstração', now(), $3)`,
      [USUARIO, EMAIL, await hash(SENHA)],
    )
    await c.query(
      `INSERT INTO tenant_usuarios (tenant_id, usuario_id, papel)
       VALUES ($1, $2, 'proprietario')`,
      [TENANT, USUARIO],
    )

    const conta = await inserir(
      c,
      `INSERT INTO contas (tenant_id, nome, tipo, saldo_inicial_centavos, incluir_no_saldo_geral)
       VALUES ($1, 'Conta corrente', 'corrente', 412000, TRUE) RETURNING id`,
      [TENANT],
    )
    const poupanca = await inserir(
      c,
      `INSERT INTO contas (tenant_id, nome, tipo, saldo_inicial_centavos, incluir_no_saldo_geral)
       VALUES ($1, 'Reserva', 'poupanca', 1580000, TRUE) RETURNING id`,
      [TENANT],
    )

    // Categorias com filhas: a raiz recebe lançamento (ADR 0021), e as filhas
    // existem para o relatório ter o que separar.
    const moradia = await categoria(c, 'Moradia', 'despesa')
    const aluguel = await categoria(c, 'Aluguel', 'despesa', moradia)
    const alimentacao = await categoria(c, 'Alimentação', 'despesa')
    const mercado = await categoria(c, 'Mercado', 'despesa', alimentacao)
    const transporte = await categoria(c, 'Transporte', 'despesa')
    const renda = await categoria(c, 'Renda', 'receita')
    const salario = await categoria(c, 'Salário', 'receita', renda)

    // Três meses de histórico. O extrato precisa ter o que mostrar, e o
    // relatório precisa ter com o que comparar — um mês só não compara nada.
    for (const mes of ['2026-07', '2026-08', '2026-09']) {
      await lancar(c, conta, salario, 720000n, meioDia(`${mes}-05`), 'Salário', true)
      await lancar(c, conta, aluguel, -180000n, meioDia(`${mes}-10`), 'Aluguel', true)
      await lancar(c, conta, mercado, -46830n, meioDia(`${mes}-12`), 'Mercado do mês', true)
      await lancar(c, conta, transporte, -21500n, meioDia(`${mes}-18`), 'Combustível', true)
    }

    // Um previsto e um pendente, para os dois eixos terem o que separar.
    await lancar(c, conta, mercado, -32000n, meioDia('2026-10-12'), 'Mercado (previsto)', false)
    await lancar(c, conta, transporte, -14900n, meioDia('2026-09-28'), 'Revisão do carro', false)

    // Transferência: duas pernas, ligadas, e fora de toda agregação de
    // receita ou despesa (regra 12b).
    const grupo = await inserir(
      c,
      `INSERT INTO transferencias (tenant_id, tipo, descricao, criado_por)
       VALUES ($1, 'entre_contas', 'Para a reserva', $2) RETURNING id`,
      [TENANT, USUARIO],
    )
    await c.query(
      `INSERT INTO lancamentos (tenant_id, conta_id, valor_centavos, moeda, posted_at,
                                settled_at, descricao, transfer_group_id, criado_por)
       VALUES ($1,$2,-50000,'BRL',$4,$4,'Para a reserva',$3,$5),
              ($1,$6, 50000,'BRL',$4,$4,'Da conta corrente',$3,$5)`,
      [TENANT, conta, grupo, meioDia('2026-09-06'), USUARIO, poupanca],
    )

    const cartao = await inserir(
      c,
      `INSERT INTO cartoes (tenant_id, nome, limite_centavos, closing_day, due_day,
                            conta_pagamento_id)
       VALUES ($1, 'Cartão principal', 500000, 25, 5, $2) RETURNING id`,
      [TENANT, conta],
    )

    await c.query('COMMIT')

    console.log('espaço de demonstração criado.')
    console.log(`  entre com: ${EMAIL}`)
    console.log(`  senha:     ${SENHA}`)
    console.log(`  cartão ${cartao.slice(0, 8)}… fecha dia 25 e vence dia 5.`)
    console.log('  compre nele por POST /v1/cartoes/:id/compras — a fatura abre sozinha.')
  } catch (erro) {
    await c.query('ROLLBACK').catch(() => undefined)
    throw erro
  } finally {
    await c.end()
  }
}

async function inserir(c: Client, sql: string, valores: unknown[]): Promise<string> {
  const r = await c.query<{ id: string }>(sql, valores)
  const linha = r.rows[0]
  if (!linha) throw new Error(`A semente não conseguiu inserir: ${sql.slice(0, 60)}…`)
  return linha.id
}

async function categoria(
  c: Client,
  nome: string,
  natureza: 'receita' | 'despesa',
  mae?: string,
): Promise<string> {
  return inserir(
    c,
    `INSERT INTO categorias (tenant_id, nivel, nome, natureza, parent_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [TENANT, mae ? 2 : 1, nome, natureza, mae ?? null],
  )
}

/**
 * `compensado` distingue os dois eixos: um lançamento sem `settled_at` está no
 * Realizado por competência e **fora** do saldo em caixa, e as duas coisas
 * estão certas ao mesmo tempo.
 */
async function lancar(
  c: Client,
  contaId: string,
  categoriaId: string,
  centavos: bigint,
  quando: string,
  descricao: string,
  compensado: boolean,
): Promise<void> {
  await c.query(
    `INSERT INTO lancamentos (tenant_id, conta_id, categoria_id, valor_centavos, moeda,
                              posted_at, settled_at, descricao, criado_por)
     VALUES ($1,$2,$3,$4,'BRL',$5,$6,$7,$8)`,
    [
      TENANT,
      contaId,
      categoriaId,
      centavos.toString(),
      quando,
      compensado ? quando : null,
      descricao,
      USUARIO,
    ],
  )
}

principal().catch((erro: unknown) => {
  console.error(String((erro as Error).message))
  process.exitCode = 1
})
