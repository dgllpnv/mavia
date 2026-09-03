import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, TENANT_B, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'
import {
  EXPORTADA_JUNTO,
  FORA_DA_EXPORTACAO,
  TABELAS_EXPORTADAS,
} from '../src/exportacao/exportacao.controller.js'

/**
 * Relatórios e exportação.
 *
 * O que estes testes travam:
 *
 * - a **base temporal** muda a resposta, e muda na direção certa: uma compra
 *   parcelada aparece inteira no mês da compra e em pedaços nos meses das
 *   parcelas;
 * - a comparação usa a **mesma** base nos dois lados, porque o servidor calcula
 *   os dois;
 * - a exportação é **completa** — e há um teste que falha quando alguém cria
 *   uma tabela com `tenant_id` e esquece de decidir se ela é do titular.
 */

let api: ApiDeTeste
let conta = ''
let cartao = ''
let alimentacao = ''
let moradia = ''

const DE = { usuario: USUARIO_A, tenant: TENANT_A }
const pedir = (metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, corpo?: unknown) =>
  api.pedir({ metodo, url, ...DE, ...(corpo === undefined ? {} : { corpo }) })

beforeAll(async () => {
  api = await subirApi()

  conta = (await pedir('GET', '/v1/contas')).json().itens[0].id

  const criar = async (nome: string, natureza: 'despesa' | 'receita') =>
    (await pedir('POST', '/v1/categorias', { nome, natureza })).json().id as string

  alimentacao = await criar('Alimentação', 'despesa')
  moradia = await criar('Moradia', 'despesa')

  cartao = (
    await pedir('POST', '/v1/cartoes', {
      nome: 'Cartão dos relatórios',
      closingDay: 20,
      dueDay: 28,
      contaPagamentoId: conta,
    })
  ).json().id

  // Despesas de conta em julho e agosto, para comparar.
  const lancar = (categoriaId: string, valor: string, quando: string, descricao: string) =>
    pedir('POST', '/v1/lancamentos', {
      contaId: conta,
      categoriaId,
      valorCentavos: valor,
      postedAt: quando,
      compensado: true,
      descricao,
    })

  await lancar(alimentacao, '-40000', '2026-07-10T12:00:00.000Z', 'Mercado de julho')
  await lancar(moradia, '-180000', '2026-07-05T12:00:00.000Z', 'Aluguel de julho')
  await lancar(alimentacao, '-60000', '2026-08-10T12:00:00.000Z', 'Mercado de agosto')

  // E uma compra parcelada, que é onde a base temporal deixa de ser detalhe.
  await pedir('POST', `/v1/cartoes/${cartao}/compras`, {
    categoriaId: alimentacao,
    valorCentavos: '-30000',
    parcelas: 3,
    postedAt: '2026-07-08T12:00:00.000Z',
    descricao: 'Compra parcelada',
  })
}, 180_000)

afterAll(async () => {
  await api?.encerrar()
})

const porCategoria = (competencia: string, base?: string) =>
  pedir(
    'GET',
    `/v1/relatorios/por-categoria?competencia=${competencia}${base ? `&base=${base}` : ''}`,
  )

const somaDe = (fatias: { nome: string; totalCentavos: string }[], nome: string): bigint =>
  fatias.filter((f) => f.nome === nome).reduce((s, f) => s + BigInt(f.totalCentavos), 0n)

describe('por categoria', () => {
  it('agrupa na raiz e devolve participação em pontos-base', async () => {
    const r = await porCategoria('2026-07')

    expect(r.statusCode).toBe(200)
    expect(r.json().base).toBe('data_parcela')

    const total = r.json().despesas.reduce((s: number, f: { participacaoBp: number }) => s + f.participacaoBp, 0)
    // Pode faltar um ponto-base por truncagem; o que não pode é sobrar.
    expect(total).toBeLessThanOrEqual(10_000)
    expect(total).toBeGreaterThan(9_990)
  })

  it('**transferência não entra em relatório de despesa**', async () => {
    const antes = await porCategoria('2026-07')
    const antesDespesa = antes
      .json()
      .despesas.reduce((s: bigint, f: { totalCentavos: string }) => s + BigInt(f.totalCentavos), 0n)

    await pedir('POST', '/v1/lancamentos/transferencias', {
      deContaId: conta,
      paraContaId: conta,
      valorCentavos: '50000',
      postedAt: '2026-07-15T12:00:00.000Z',
      compensado: true,
      descricao: 'não deve aparecer',
    })

    const depois = await porCategoria('2026-07')
    const depoisDespesa = depois
      .json()
      .despesas.reduce((s: bigint, f: { totalCentavos: string }) => s + BigInt(f.totalCentavos), 0n)

    expect(depoisDespesa).toBe(antesDespesa)
  })
})

describe('a base temporal muda a resposta, e muda certo', () => {
  it('**por data da compra, a parcelada aparece inteira no mês da compra**', async () => {
    const r = await porCategoria('2026-07', 'data_compra')
    const alimentacaoDeJulho = somaDe(r.json().despesas, 'Alimentação')

    // R$ 400 de mercado + R$ 300 da compra inteira.
    expect(alimentacaoDeJulho).toBe(-70000n)
  })

  it('**por data da parcela, só a parcela do mês**', async () => {
    const r = await porCategoria('2026-07', 'data_parcela')
    const alimentacaoDeJulho = somaDe(r.json().despesas, 'Alimentação')

    // R$ 400 de mercado + R$ 100 da primeira parcela.
    expect(alimentacaoDeJulho).toBe(-50000n)
  })

  it('a base viaja na resposta, para a tela não adivinhar', async () => {
    expect((await porCategoria('2026-07', 'data_fatura')).json().base).toBe('data_fatura')
  })

  it('base desconhecida é recusada, e não silenciosamente trocada pelo padrão', async () => {
    const r = await porCategoria('2026-07', 'data_do_pagamento')

    expect(r.statusCode).toBe(400)
    expect(r.json().message).toContain('data_parcela')
  })
})

describe('evolução', () => {
  it('devolve um ponto por mês, com receita e despesa separadas', async () => {
    const r = await pedir('GET', '/v1/relatorios/evolucao?ate=2026-08&meses=3')

    expect(r.statusCode).toBe(200)
    const julho = r.json().meses.find((m: { competencia: string }) => m.competencia === '2026-07')
    expect(julho).toBeDefined()
    expect(BigInt(julho.despesaCentavos)).toBeLessThan(0n)
  })
})

describe('comparação', () => {
  it('**o servidor calcula os dois lados, com a mesma base**', async () => {
    // A invariante do glossário: comparação com fronteiras ou bases distintas
    // produz variação inventada, e ela aparece como uma queda de 30% que
    // ninguém teve.
    const r = await pedir('GET', '/v1/relatorios/comparacao?a=2026-07&b=2026-08')

    expect(r.statusCode).toBe(200)
    expect(r.json().base).toBe('data_parcela')
    expect(r.json().a.competencia).toBe('2026-07')
    expect(r.json().b.competencia).toBe('2026-08')
  })

  it('**a variação inclui a categoria que sumiu**', async () => {
    // Moradia existe em julho e não em agosto. É a informação mais útil do
    // relatório, e um `join` ingênuo a perderia.
    const r = await pedir('GET', '/v1/relatorios/comparacao?a=2026-07&b=2026-08')
    const moradiaNaVariacao = r
      .json()
      .variacao.find((v: { categoriaId: string }) => v.categoriaId === moradia)

    expect(moradiaNaVariacao).toBeDefined()
    // Saiu de −R$ 1.800 para zero: o delta é positivo, gastou-se menos.
    expect(BigInt(moradiaNaVariacao.deltaCentavos)).toBe(180000n)
  })

  it('ordena pela maior piora primeiro', async () => {
    const r = await pedir('GET', '/v1/relatorios/comparacao?a=2026-07&b=2026-08')
    const deltas = r.json().variacao.map((v: { deltaCentavos: string }) => BigInt(v.deltaCentavos))

    for (let i = 1; i < deltas.length; i++) {
      expect(deltas[i - 1] <= deltas[i]).toBe(true)
    }
  })
})

describe('exportação — o direito de portabilidade', () => {
  it('traz todos os conjuntos, e o espaço', async () => {
    const r = await pedir('GET', '/v1/exportacao')

    expect(r.statusCode).toBe(200)
    const dados = r.json()

    expect(dados.espaco.id).toBe(TENANT_A)
    expect(dados.lancamentos.length).toBeGreaterThan(0)
    for (const tabela of TABELAS_EXPORTADAS) {
      expect(dados[tabela === 'saldo_snapshots' ? 'saldo_snapshots' : tabela]).toBeDefined()
    }
  })

  it('**nenhum material criptográfico sai**', async () => {
    // Exportar hash de senha ou de refresh transformaria o arquivo de
    // portabilidade numa arma.
    const texto = (await pedir('GET', '/v1/exportacao')).body

    expect(texto).not.toContain('senha_hash')
    expect(texto).not.toContain('refresh_hash')
  })

  it('**a exportação não vaza o outro espaço**', async () => {
    const doB = await api.pedir({
      metodo: 'GET',
      url: '/v1/exportacao',
      usuario: USUARIO_B,
      tenant: TENANT_B,
    })

    expect(doB.json().espaco.id).toBe(TENANT_B)
    expect(doB.json().lancamentos.every((l: { id: string }) => l.id !== undefined)).toBe(true)

    const idsDeA = new Set(
      (await pedir('GET', '/v1/exportacao')).json().lancamentos.map((l: { id: string }) => l.id),
    )
    for (const l of doB.json().lancamentos) expect(idsDeA.has(l.id)).toBe(false)
  })

  it('**toda tabela com `tenant_id` foi classificada**', async () => {
    // O teste que existe para falhar no futuro: quem criar uma tabela nova
    // precisa decidir se ela é dado do titular. Esquecer produziria uma
    // exportação que parece completa e não é — e o titular só descobriria
    // exercendo o direito.
    const r = await api.banco.cliente.query<{ table_name: string }>(
      `SELECT DISTINCT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE c.table_schema = 'public'
          AND c.column_name = 'tenant_id'
          AND t.table_type = 'BASE TABLE'`,
    )

    const classificadas = new Set([
      ...TABELAS_EXPORTADAS,
      ...EXPORTADA_JUNTO.keys(),
      ...FORA_DA_EXPORTACAO.keys(),
    ])
    const esquecidas = r.rows.map((l) => l.table_name).filter((t) => !classificadas.has(t))

    expect(esquecidas).toEqual([])
  })

  it('exportar é do dono, e não de quem foi convidado para ver', async () => {
    const { pode } = await import('../src/autorizacao/politica-acesso.js')

    expect(pode({ metodo: 'GET', caminho: '/v1/exportacao' }, 'proprietario')).toBe(true)
    expect(pode({ metodo: 'GET', caminho: '/v1/exportacao' }, 'membro')).toBe(false)
    expect(pode({ metodo: 'GET', caminho: '/v1/exportacao' }, 'visualizador')).toBe(false)
  })
})
