import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { criarAplicacao } from '../src/aplicacao.js'
import { autenticadorDeSessao } from '../src/autenticacao/autenticador.js'
import {
  semearDoisTenants,
  subirPostgres,
  TENANT_A,
  TENANT_B,
  USUARIO_A,
  USUARIO_B,
  type BancoDeTeste,
} from './postgres.js'

/**
 * Seam S2 — a API HTTP sobre Postgres real.
 *
 * O critério que o `arquiteto-solucao` fixou: **dois tenants em toda rota de
 * recurso**, e uma transação sem contexto lança erro em vez de devolver linha.
 * Estes testes não checam se a aplicação lembra de filtrar; checam que ela não
 * consegue deixar de filtrar.
 */

let banco: BancoDeTeste
let app: NestFastifyApplication
let pool: Pool

/** Sessões de teste, criadas no banco como o fluxo de login as criaria. */
const tokens = new Map<string, string>()

async function criarSessao(usuarioId: string): Promise<string> {
  const token = randomBytes(32).toString('hex')
  const hash = createHash('sha256').update(token, 'utf8').digest()
  await banco.cliente.query(
    `INSERT INTO sessoes (usuario_id, familia_id, refresh_hash, plataforma,
                          expira_em, expira_absoluto_em)
     VALUES ($1, gen_random_uuid(), $2, 'web', now() + interval '14 days',
             now() + interval '30 days')`,
    [usuarioId, hash],
  )
  return token
}

beforeAll(async () => {
  banco = await subirPostgres()
  await semearDoisTenants(banco.cliente)

  // `mavia_app` nasce NOLOGIN na migration: quem concede credencial é o
  // provisionamento do ambiente, não a migration. Aqui fazemos o que o SRE
  // faria no deploy.
  await banco.cliente.query(`ALTER ROLE mavia_app LOGIN PASSWORD 'mavia_local_dev'`)

  const conexao = banco.cliente as unknown as { connectionParameters: Record<string, unknown> }
  pool = new Pool({
    host: conexao.connectionParameters['host'] as string,
    port: conexao.connectionParameters['port'] as number,
    database: conexao.connectionParameters['database'] as string,
    user: 'mavia_app',
    password: 'mavia_local_dev',
  })

  app = await criarAplicacao(pool, autenticadorDeSessao(pool))
  await app.init()

  tokens.set(USUARIO_A, await criarSessao(USUARIO_A))
  tokens.set(USUARIO_B, await criarSessao(USUARIO_B))
})

afterAll(async () => {
  await app?.close()
  await pool?.end()
  await banco?.encerrar()
})

function pedir(opcoes: {
  metodo: string
  url: string
  usuario?: string
  tenant?: string
  corpo?: unknown
}) {
  const cabecalhos: Record<string, string> = {}
  if (opcoes.usuario) cabecalhos['authorization'] = `Bearer ${tokens.get(opcoes.usuario)}`
  if (opcoes.tenant) cabecalhos['x-mavia-tenant'] = opcoes.tenant
  return app.inject({
    method: opcoes.metodo as 'GET',
    url: opcoes.url,
    headers: cabecalhos,
    ...(opcoes.corpo !== undefined ? { payload: opcoes.corpo as object } : {}),
  })
}

describe('a matriz de acesso cobre o roteador', () => {
  it('a aplicação subiu, o que significa que toda rota registrada tem regra', () => {
    // `criarAplicacao` verifica a cobertura antes de aceitar requisição. Se uma
    // rota nova nascer sem entrada na matriz, este beforeAll falha — e falha
    // no boot, não no dia em que alguém acessar a rota.
    expect(app).toBeDefined()
  })
})

describe('sem sessão', () => {
  it('recusa a listagem', async () => {
    const r = await pedir({ metodo: 'GET', url: '/v1/contas', tenant: TENANT_A })
    expect(r.statusCode).toBe(401)
  })

  it('recusa a criação', async () => {
    const r = await pedir({
      metodo: 'POST',
      url: '/v1/contas',
      tenant: TENANT_A,
      corpo: { nome: 'Invasora' },
    })
    expect(r.statusCode).toBe(401)
  })
})

describe('sem informar o espaço', () => {
  it('é 400, e não a escolha implícita do primeiro tenant', async () => {
    // Mesmo com um tenant só. A escolha implícita fica errada no dia em que a
    // pessoa aceita um segundo convite, e nesse dia ninguém procura aqui.
    const r = await pedir({ metodo: 'GET', url: '/v1/contas', usuario: USUARIO_A })
    expect(r.statusCode).toBe(400)
  })
})

describe('dois tenants em toda rota', () => {
  it('GET /v1/contas — cada um enxerga só o próprio', async () => {
    const a = await pedir({ metodo: 'GET', url: '/v1/contas', usuario: USUARIO_A, tenant: TENANT_A })
    const b = await pedir({ metodo: 'GET', url: '/v1/contas', usuario: USUARIO_B, tenant: TENANT_B })

    expect(a.statusCode).toBe(200)
    expect(b.statusCode).toBe(200)
    expect(a.json().itens.map((c: { nome: string }) => c.nome)).toEqual(['Conta da Ana'])
    expect(b.json().itens.map((c: { nome: string }) => c.nome)).toEqual(['Conta do Bruno'])
  })

  it('pedir o espaço de outro é 403, sem troca de contexto', async () => {
    const r = await pedir({ metodo: 'GET', url: '/v1/contas', usuario: USUARIO_A, tenant: TENANT_B })
    expect(r.statusCode).toBe(403)
  })

  it('GET /v1/contas/:id — o id do outro tenant é 404, e não 403', async () => {
    // 404 de propósito: dizer "existe, mas não é sua" já entrega a existência
    // de um recurso de outro cliente.
    const doB = await pedir({
      metodo: 'GET',
      url: '/v1/contas',
      usuario: USUARIO_B,
      tenant: TENANT_B,
    })
    const idDoB = doB.json().itens[0].id

    const r = await pedir({
      metodo: 'GET',
      url: `/v1/contas/${idDoB}`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })
    expect(r.statusCode).toBe(404)
  })

  it('DELETE /v1/contas/:id — não arquiva conta de outro tenant', async () => {
    const doB = await pedir({
      metodo: 'GET',
      url: '/v1/contas',
      usuario: USUARIO_B,
      tenant: TENANT_B,
    })
    const idDoB = doB.json().itens[0].id

    const tentativa = await pedir({
      metodo: 'DELETE',
      url: `/v1/contas/${idDoB}`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })
    expect(tentativa.statusCode).toBe(404)

    const aindaLa = await pedir({
      metodo: 'GET',
      url: `/v1/contas/${idDoB}`,
      usuario: USUARIO_B,
      tenant: TENANT_B,
    })
    expect(aindaLa.statusCode).toBe(200)
  })
})

describe('a unidade de trabalho recusa contexto ausente', () => {
  it('lança antes de tocar o banco, com mensagem que diz o que faltou', async () => {
    // Critério do `arquiteto-solucao` para o S2: sem `SET LOCAL`, é erro — e
    // não zero linhas. Zero linhas viraria "sumiram meus dados", que manda
    // procurar no lugar errado.
    const { comTenant, ContextoAusente } = await import('../src/tenancy/tenancy.js')

    await expect(
      comTenant(pool, { usuarioId: USUARIO_A, tenantId: '' }, async () => 'nunca'),
    ).rejects.toThrow(ContextoAusente)

    await expect(
      comTenant(pool, { usuarioId: '', tenantId: TENANT_A }, async () => 'nunca'),
    ).rejects.toThrow(/app.usuario_id/)
  })
})

describe('POST /v1/contas', () => {
  it('cria no próprio espaço e devolve o recurso', async () => {
    const r = await pedir({
      metodo: 'POST',
      url: '/v1/contas',
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { nome: 'Poupança', tipo: 'poupanca', saldoInicialCentavos: '150000' },
    })

    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({
      nome: 'Poupança',
      tipo: 'poupanca',
      // Centavos viajam como string: bigint não sobrevive a JSON, e number
      // perde precisão. A conversão é do cliente, de propósito.
      saldoInicialCentavos: '150000',
      moeda: 'BRL',
      origem: 'manual',
    })
  })

  it('conta de investimento nasce fora do saldo geral', async () => {
    const r = await pedir({
      metodo: 'POST',
      url: '/v1/contas',
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { nome: 'Tesouro', tipo: 'investimento' },
    })

    expect(r.json().incluirNoSaldoGeral).toBe(false)
  })

  it('a conta criada não aparece para o outro tenant', async () => {
    await pedir({
      metodo: 'POST',
      url: '/v1/contas',
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { nome: 'Secreta' },
    })

    const doB = await pedir({
      metodo: 'GET',
      url: '/v1/contas',
      usuario: USUARIO_B,
      tenant: TENANT_B,
    })
    const nomes = doB.json().itens.map((c: { nome: string }) => c.nome)
    expect(nomes).not.toContain('Secreta')
  })

  it('recusa corpo inválido na borda, com 400', async () => {
    const r = await pedir({
      metodo: 'POST',
      url: '/v1/contas',
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { nome: '' },
    })

    expect(r.statusCode).toBe(400)
  })

  it('recusa valor monetário fracionário — centavos são inteiros', async () => {
    const r = await pedir({
      metodo: 'POST',
      url: '/v1/contas',
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { nome: 'Errada', saldoInicialCentavos: '10.50' },
    })

    expect(r.statusCode).toBe(400)
  })
})

describe('cartão pelo HTTP', () => {
  let cartaoId = ''
  let contaId = ''
  let faturaId = ''

  it('cria o cartão com o ciclo', async () => {
    const contas = await pedir({
      metodo: 'GET',
      url: '/v1/contas',
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })
    contaId = contas.json().itens[0].id

    const r = await pedir({
      metodo: 'POST',
      url: '/v1/cartoes',
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: {
        nome: 'Nubank',
        limiteCentavos: '500000',
        closingDay: 25,
        dueDay: 5,
        contaPagamentoId: contaId,
      },
    })

    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({ nome: 'Nubank', closingDay: 25, dueDay: 5 })
    cartaoId = r.json().id
  })

  it('abre a fatura com a janela vinda do domínio', async () => {
    const r = await pedir({
      metodo: 'POST',
      url: `/v1/cartoes/${cartaoId}/faturas`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { ano: 2026, mes: 11 },
    })

    expect(r.statusCode).toBe(201)
    // Fecha 25, vence 5: a fatura de novembro fecha em 25/nov e vence em
    // 05/dez. O fechamento é lido no fuso do tenant — em UTC daria 26.
    expect(r.json()).toMatchObject({
      estado: 'aberta',
      dataFechamento: '2026-11-25',
      dataVencimento: '2026-12-05',
    })
    faturaId = r.json().id
  })

  it('recusa abrir a mesma fatura duas vezes', async () => {
    // Duas faturas cobrindo o mesmo ciclo cobrariam a compra duas vezes.
    const r = await pedir({
      metodo: 'POST',
      url: `/v1/cartoes/${cartaoId}/faturas`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { ano: 2026, mes: 11 },
    })

    expect(r.statusCode).toBe(409)
  })

  it('fecha a fatura e trava o total', async () => {
    const r = await pedir({
      metodo: 'POST',
      url: `/v1/cartoes/faturas/${faturaId}/fechar`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })

    expect(r.statusCode).toBe(200)
    expect(r.json().totalCentavos).toBe('0')
  })

  it('recusa fechar duas vezes', async () => {
    const r = await pedir({
      metodo: 'POST',
      url: `/v1/cartoes/faturas/${faturaId}/fechar`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })

    expect(r.statusCode).toBe(409)
  })

  it('o cartão de um tenant não aparece para o outro', async () => {
    const r = await pedir({
      metodo: 'GET',
      url: '/v1/cartoes',
      usuario: USUARIO_B,
      tenant: TENANT_B,
    })

    expect(r.statusCode).toBe(200)
    expect(r.json().itens).toEqual([])
  })

  it('a fatura de um tenant não é listada pelo outro', async () => {
    const r = await pedir({
      metodo: 'GET',
      url: `/v1/cartoes/${cartaoId}/faturas`,
      usuario: USUARIO_B,
      tenant: TENANT_B,
    })

    expect(r.statusCode).toBe(200)
    expect(r.json().itens).toEqual([])
  })

  it('visualizador lê o cartão e não cria', async () => {
    // A matriz de acesso, aplicada às rotas novas.
    const { pode } = await import('../src/autorizacao/politica-acesso.js')

    expect(pode({ metodo: 'GET', caminho: '/v1/cartoes' }, 'visualizador')).toBe(true)
    expect(pode({ metodo: 'POST', caminho: '/v1/cartoes' }, 'visualizador')).toBe(false)
    expect(
      pode({ metodo: 'POST', caminho: '/v1/cartoes/faturas/:faturaId/pagamentos' }, 'visualizador'),
    ).toBe(false)
  })
})
