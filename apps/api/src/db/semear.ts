import { hash } from '@node-rs/argon2'
import { Client, type PoolClient } from 'pg'
import { registrarCompra } from '../cartoes/compras.js'

/**
 * `pnpm db:seed` — um espaço de demonstração no banco local.
 *
 * Existe porque o cadastro por e-mail ainda não tem rota (P-3 em
 * `docs/pendencias.md`): sem semente, não há como entrar na aplicação local.
 *
 * **A trava é a senha conhecida, não o endereço do banco.**
 *
 * A versão anterior recusava qualquer URL que não fosse local, e a razão escrita
 * era exata: a semente grava `mavia-demonstracao`, que está no repositório
 * público — numa instância aberta na internet, é porta dos fundos literal.
 *
 * O que a trava protege, então, não é "banco remoto": é **senha publicada**. Com
 * `SENHA_DEMO` no ambiente, a senha deixa de ser conhecida e o perigo descrito
 * deixa de existir — e aí semear um ambiente de demonstração remoto passa a ser
 * legítimo. Sem ela, a recusa continua valendo, inclusive contra quem apontar a
 * variável de ambiente para a VPS por engano.
 *
 * Os **dados** são fictícios nos dois casos, e nunca foram o risco.
 *
 * É idempotente: rodar duas vezes não duplica nada.
 */

const URL_PADRAO = 'postgres://mavia:mavia_local_dev@127.0.0.1:4732/mavia'

const EMAIL = process.env['EMAIL_DEMO'] || 'demo@mavia.local'

/**
 * A senha do espaço de demonstração.
 *
 * O padrão é público de propósito — está no repositório, e o ambiente local
 * escuta em `127.0.0.1` e é apagado pelo `mavia reset`. Fora dali, quem semeia
 * **precisa** informar uma senha própria; ver a checagem em `principal`.
 */
const SENHA_PUBLICA = 'mavia-demonstracao'

/**
 * **`||` e não `??`.** Um `SENHA_DEMO=` vazio — que é o que sai de um `export`
 * sem valor, ou de um `ARG` de Docker não passado — cairia como "senha
 * informada" sob `??`, e a trava abaixo deixaria passar uma senha vazia contra
 * um banco remoto. O `??` só recua para `null` e `undefined`.
 *
 * Foi um teste que encontrou isso, e é o segundo lugar nesta base onde o mesmo
 * engano apareceu: o outro derrubava o `rewrite` de `/api` em produção.
 */
const SENHA = process.env['SENHA_DEMO'] || SENHA_PUBLICA

const TENANT = 'dbdbdbdb-0000-4000-8000-000000000001'
const USUARIO = 'dbdbdbdb-0000-4000-8000-0000000000a1'

/**
 * O endereço é local?
 *
 * **Analisado, e não procurado por substring.** A versão anterior fazia
 * `url.includes('127.0.0.1')`, e isso aceita
 * `postgres://u:s@banco-de-producao/db?opcao=127.0.0.1` como "local" — a trava
 * inteira cai com um parâmetro na string de conexão.
 *
 * `new URL` extrai o host de verdade. Se a string não for uma URL válida, a
 * resposta é **não local**: recusar o que não se entende é o único desfecho
 * seguro para uma trava.
 */
function enderecoEhLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/** Meio-dia em São Paulo: longe de qualquer borda de fuso. */
const meioDia = (dia: string): string => `${dia}T15:00:00Z`

async function principal(): Promise<void> {
  const url = process.env['DATABASE_URL_SEED'] ?? URL_PADRAO
  const ehLocal = enderecoEhLocal(url)

  // A trava, escrita sobre o que ela de fato protege: a senha publicada.
  if (!ehLocal && SENHA === SENHA_PUBLICA) {
    throw new Error(
      'Esta semente grava uma senha que está no repositório público. Contra um ' +
        'banco que não é local, isso é uma porta dos fundos — qualquer pessoa ' +
        'que leia o repositório entra. Informe `SENHA_DEMO` com uma senha ' +
        'própria para semear um ambiente remoto.',
    )
  }

  if (!ehLocal) {
    console.warn(
      'Semeando um banco REMOTO com dados de demonstração. Os dados são ' +
        'fictícios; a conta criada é real e entra na aplicação.',
    )
  }

  const c = new Client({ connectionString: url })
  await c.connect()

  try {
    // `mavia_app` nasce NOLOGIN na migration: quem concede credencial é o
    // provisionamento do ambiente, não a migration. Em produção isso é o SRE;
    // aqui é a semente, que já é o script do ambiente local.
    //
    // **Só no ambiente local.** Esta linha existe porque `mavia_app` nasce
    // NOLOGIN na migration e o ambiente local não tem SRE para provisioná-lo.
    // Rodada contra um banco remoto ela **reescreve a credencial da API** com
    // uma senha do repositório público — e a aplicação para de conectar.
    //
    // Não é hipótese: aconteceu, na primeira vez que esta semente rodou contra
    // a VPS. O login de produção respondeu 500 até a credencial ser restaurada.
    if (ehLocal) {
      await c.query(`ALTER ROLE mavia_app LOGIN PASSWORD 'mavia_local_dev'`)

      // Os dois papéis de conexão do painel de administração nascem `NOLOGIN`
      // na migration 0029 — condição C-9, e a razão é que migration é
      // forward-only: uma senha escrita ali fica no histórico para sempre.
      //
      // `LOGIN` e credencial são **provisionamento**. Em produção isso é do
      // SRE, com segredo do ambiente; aqui é a mesma senha pública que
      // `mavia_app` já usa, contra um Postgres que escuta em `127.0.0.1` e
      // cujos dados o `mavia reset` apaga.
      //
      // Os outros dois — `mavia_admin_contrato` e `mavia_admin_definer` —
      // continuam `NOLOGIN` em todo lugar, inclusive aqui: eles são **donos de
      // função**, nunca conexão. Um papel que loga é um papel que alguém pode
      // alcançar; o privilégio deles não deve ter porta.
      await c.query(`ALTER ROLE mavia_admin LOGIN PASSWORD 'mavia_local_dev'`)
      await c.query(`ALTER ROLE mavia_admin_escrita LOGIN PASSWORD 'mavia_local_dev'`)
    }

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

    const cartao: string = await inserir(
      c,
      `INSERT INTO cartoes (tenant_id, nome, limite_centavos, closing_day, due_day,
                            conta_pagamento_id)
       VALUES ($1, 'Cartão principal', 500000, 25, 5, $2) RETURNING id`,
      [TENANT, conta],
    )

    // As compras de cartão passam por `registrarCompra` — a **mesma** função
    // que a rota usa. Reescrever a divisão das parcelas aqui criaria uma
    // segunda regra de rateio, e a semente passaria a mentir sobre o produto.
    //
    // O elenco: uma compra à vista e um parcelamento em 6x, o suficiente para a
    // fatura aparecer com total e para o trilho de ciclo ter o que desenhar.
    const comoCliente = c as unknown as PoolClient
    const cartaoDaCompra = {
      id: cartao,
      closingDay: 25,
      dueDay: 5,
      contaPagamentoId: conta,
      moeda: 'BRL' as const,
    }

    // Um ciclo **já encerrado** (fecha 25/jul) e o ciclo corrente. Sem o
    // primeiro, não há fatura que se possa fechar nem pagar — e desde a 0015
    // quem fecha uma fatura é o calendário, não um botão.
    await registrarCompra(comoCliente, { tenantId: TENANT, usuarioId: USUARIO }, cartaoDaCompra, {
      categoriaId: mercado,
      valorCentavos: '-31890',
      postedAt: meioDia('2026-07-08'),
      parcelas: 1,
      descricao: 'Mercado no cartão',
    })

    await registrarCompra(comoCliente, { tenantId: TENANT, usuarioId: USUARIO }, cartaoDaCompra, {
      categoriaId: transporte,
      // R$ 1.000,00 em 6x não divide: 166,66… O resto vai para as primeiras
      // parcelas, uma unidade por parcela, e a soma bate no centavo.
      valorCentavos: '-100000',
      postedAt: meioDia('2026-07-14'),
      parcelas: 6,
      descricao: 'Pneus',
    })

    // E uma compra no ciclo corrente, para a fatura aberta ter conteúdo.
    await registrarCompra(comoCliente, { tenantId: TENANT, usuarioId: USUARIO }, cartaoDaCompra, {
      categoriaId: mercado,
      valorCentavos: '-14270',
      postedAt: meioDia('2026-08-30'),
      parcelas: 1,
      descricao: 'Feira no cartão',
    })

    await c.query('COMMIT')

    console.log('espaço de demonstração criado.')
    console.log(`  entre com: ${EMAIL}`)
    // A senha só é impressa quando é a **pública**, no ambiente local, onde ela
    // já está no repositório e serve de lembrete. Quando vem de `SENHA_DEMO`,
    // quem semeou já a tem — e imprimi-la a jogaria no log do deploy, que é
    // gravado, compartilhado e não tem por que guardar segredo.
    console.log(
      SENHA === SENHA_PUBLICA
        ? `  senha:     ${SENHA}`
        : '  senha:     a que você informou em SENHA_DEMO',
    )
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
