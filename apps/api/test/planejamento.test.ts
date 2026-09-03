import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, TENANT_B, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * Planejamento contra Postgres real.
 *
 * O que estes testes travam é o que a spec do `CONTEXT.md` avisa que quebra:
 *
 * - **dois planejamentos globais** no mesmo mês, que o índice único ingênuo
 *   deixa passar porque `NULL` não colide;
 * - **cópia não idempotente**, pelo mesmo motivo, com o agravante de abortar a
 *   transação e levar junto o que já tinha sido copiado;
 * - **realizado somado por sinal em vez de por natureza da categoria**, que faz
 *   receita anular despesa e torna o teto global impossível de estourar.
 */

let api: ApiDeTeste
let contaId = ''
let alimentacao = ''
let mercado = ''
let renda = ''
let ajusteDeSaldo = ''

const COMP = '2026-04'
const DENTRO = '2026-04-10T15:00:00.000Z'

beforeAll(async () => {
  api = await subirApi()

  const contas = await api.pedir({
    metodo: 'GET',
    url: '/v1/contas',
    usuario: USUARIO_A,
    tenant: TENANT_A,
  })
  contaId = contas.json().itens[0].id

  const criarCategoria = async (corpo: Record<string, unknown>) => {
    const r = await api.pedir({
      metodo: 'POST',
      url: '/v1/categorias',
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo,
    })
    return r.json().id as string
  }

  alimentacao = await criarCategoria({ nome: 'Alimentação', natureza: 'despesa' })
  mercado = await criarCategoria({ nome: 'Mercado', natureza: 'despesa', parentId: alimentacao })
  renda = await criarCategoria({ nome: 'Renda', natureza: 'receita' })

  const cats = await api.pedir({
    metodo: 'GET',
    url: '/v1/categorias',
    usuario: USUARIO_A,
    tenant: TENANT_A,
  })
  ajusteDeSaldo = cats
    .json()
    .itens.find((c: { nome: string; natureza: string }) => c.nome === 'Ajuste de saldo' && c.natureza === 'despesa').id
}, 180_000)

afterAll(async () => {
  await api?.encerrar()
})

const criar = (corpo: Record<string, unknown>, quem = { usuario: USUARIO_A, tenant: TENANT_A }) =>
  api.pedir({ metodo: 'POST', url: '/v1/planejamentos', ...quem, corpo })

const listar = (competencia: string, quem = { usuario: USUARIO_A, tenant: TENANT_A }) =>
  api.pedir({ metodo: 'GET', url: `/v1/planejamentos?competencia=${competencia}`, ...quem })

describe('criar planejamento', () => {
  it('teto de categoria: valor negativo, natureza derivada do sinal', async () => {
    const r = await criar({ competencia: COMP, categoriaId: alimentacao, valorCentavos: '-50000' })

    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({
      categoriaId: alimentacao,
      valorCentavos: '-50000',
      natureza: 'teto',
    })
    // Os alertas têm padrão, e ele vem do CONTEXT.md.
    expect(r.json().alertasPercentuais).toEqual([80, 100])
  })

  it('piso de receita: valor positivo', async () => {
    const r = await criar({ competencia: COMP, categoriaId: renda, valorCentavos: '300000' })

    expect(r.statusCode).toBe(201)
    expect(r.json().natureza).toBe('piso')
  })

  it('global: categoria nula é valor legítimo da identidade', async () => {
    const r = await criar({ competencia: COMP, valorCentavos: '-300000' })

    expect(r.statusCode).toBe(201)
    expect(r.json().categoriaId).toBeNull()
    expect(r.json().natureza).toBe('teto')
  })

  it('**dois globais da mesma natureza no mesmo mês é recusado**', async () => {
    // O caso que o índice único ingênuo deixa passar: `NULL` não colide em
    // índice único no Postgres, e o segundo global passaria despercebido até o
    // total do mês vir dobrado.
    const r = await criar({ competencia: COMP, valorCentavos: '-999900' })

    expect(r.statusCode).toBe(409)
  })

  it('mas o global de piso convive com o global de teto', async () => {
    // Natureza faz parte da identidade: são duas linhas legítimas.
    const r = await criar({ competencia: COMP, valorCentavos: '800000' })

    expect(r.statusCode).toBe(201)
  })

  it('recusa o mesmo escopo duas vezes', async () => {
    const r = await criar({ competencia: COMP, categoriaId: alimentacao, valorCentavos: '-70000' })

    expect(r.statusCode).toBe(409)
  })

  it('recusa teto em categoria de receita', async () => {
    // Um "teto" numa categoria de receita agregaria despesa nenhuma e ficaria
    // eternamente em 0% — um planejamento que nunca dispara e nunca é notado.
    const r = await criar({ competencia: COMP, categoriaId: renda, valorCentavos: '-50000' })

    expect(r.statusCode).toBe(400)
  })

  it('recusa valor zero', async () => {
    // Também é o que garante que a razão de consumo nunca divide por zero.
    const r = await criar({ competencia: COMP, categoriaId: mercado, valorCentavos: '0' })

    expect(r.statusCode).toBe(400)
  })

  it('recusa categoria não analítica', async () => {
    // `Ajuste de saldo` é correção de registro, não gasto: um teto sobre ela
    // mediria a frequência com que a pessoa concilia o saldo.
    const r = await criar({
      competencia: COMP,
      categoriaId: ajusteDeSaldo,
      valorCentavos: '-10000',
    })

    expect(r.statusCode).toBe(400)
  })

  it('recusa categoria de outro espaço', async () => {
    const r = await criar(
      { competencia: COMP, categoriaId: alimentacao, valorCentavos: '-10000' },
      { usuario: USUARIO_B, tenant: TENANT_B },
    )

    expect(r.statusCode).toBe(400)
  })
})

describe('o realizado, e por que ele é por natureza da categoria', () => {
  beforeAll(async () => {
    const lancar = (categoriaId: string, valorCentavos: string, descricao: string) =>
      api.pedir({
        metodo: 'POST',
        url: '/v1/lancamentos',
        usuario: USUARIO_A,
        tenant: TENANT_A,
        corpo: {
          contaId,
          categoriaId,
          valorCentavos,
          postedAt: DENTRO,
          compensado: true,
          descricao,
        },
      })

    await lancar(mercado, '-20000', 'Mercado')
    await lancar(alimentacao, '-10000', 'Restaurante')
    await lancar(renda, '2000000', 'Salário')
  })

  it('o teto de uma raiz agrega o realizado das filhas', async () => {
    const itens = (await listar(COMP)).json().itens
    const p = itens.find((x: { categoriaId: string }) => x.categoriaId === alimentacao)

    // R$ 200 no Mercado (filha) + R$ 100 em Alimentação (raiz).
    expect(p.realizadoCentavos).toBe('-30000')
    expect(p.consumoBp).toBe(6000)
    expect(p.estado).toBe('dentro_do_planejado')
  })

  it('**o teto global não é anulado pela receita**', async () => {
    // A razão de a partição ser por natureza da Categoria, e não pelo sinal do
    // lançamento. Somando líquido, R$ 300 de gasto com R$ 20.000 de salário
    // daria +1.970.000 >= −300.000 — dentro do planejado para qualquer pessoa
    // com superávit, e o teto global seria impossível de estourar.
    const itens = (await listar(COMP)).json().itens
    const global = itens.find(
      (x: { categoriaId: string | null; natureza: string }) =>
        x.categoriaId === null && x.natureza === 'teto',
    )

    expect(global.realizadoCentavos).toBe('-30000')
  })

  it('o piso global agrega só receita', async () => {
    const itens = (await listar(COMP)).json().itens
    const global = itens.find(
      (x: { categoriaId: string | null; natureza: string }) =>
        x.categoriaId === null && x.natureza === 'piso',
    )

    expect(global.realizadoCentavos).toBe('2000000')
  })

  it('o total planejado não conta o mesmo caminho duas vezes', async () => {
    // Teto global de R$ 3.000 e sub-teto de R$ 500 em Alimentação: o total é
    // R$ 3.000, não R$ 3.500.
    const r = await listar(COMP)

    expect(r.json().totalPlanejado.teto).toBe('-300000')
    expect(r.json().totalPlanejado.piso).toBe('800000')
  })

  it('transferência não entra no realizado de planejamento nenhum', async () => {
    const antes = (await listar(COMP)).json().itens.find(
      (x: { categoriaId: string | null; natureza: string }) =>
        x.categoriaId === null && x.natureza === 'teto',
    ).realizadoCentavos

    await api.pedir({
      metodo: 'POST',
      url: '/v1/lancamentos/transferencias',
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: {
        deContaId: contaId,
        paraContaId: contaId,
        valorCentavos: '50000',
        postedAt: DENTRO,
        compensado: true,
        descricao: 'não deve contar',
      },
    })

    const depois = (await listar(COMP)).json().itens.find(
      (x: { categoriaId: string | null; natureza: string }) =>
        x.categoriaId === null && x.natureza === 'teto',
    ).realizadoCentavos

    expect(depois).toBe(antes)
  })
})

describe('copiar para outra competência', () => {
  const DESTINO = '2026-05'

  const copiar = () =>
    api.pedir({
      metodo: 'POST',
      url: '/v1/planejamentos/copiar',
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { de: COMP, para: DESTINO },
    })

  it('copia o mês inteiro, inclusive o global', async () => {
    const r = await copiar()

    expect(r.statusCode).toBe(201)
    expect(r.json().copiados).toBeGreaterThan(0)

    const destino = (await listar(DESTINO)).json().itens
    expect(destino.some((x: { categoriaId: string | null }) => x.categoriaId === null)).toBe(true)
  })

  it('**é idempotente, e o global é justamente o que quebra a versão ingênua**', async () => {
    // Escrita com `categoria_id = origem.categoria_id`, a verificação nunca
    // encontra o global — `NULL = NULL` é `NULL` —, o `INSERT` é tentado, o
    // índice parcial o rejeita, e a transação aborta levando junto as
    // categorias que já tinham sido copiadas.
    const antes = (await listar(DESTINO)).json().itens.length

    const r = await copiar()

    expect(r.statusCode).toBe(201)
    expect(r.json().copiados).toBe(0)
    expect((await listar(DESTINO)).json().itens).toHaveLength(antes)
  })

  it('não sobrescreve valor editado no destino', async () => {
    const destino = (await listar(DESTINO)).json().itens
    const alvo = destino.find((x: { categoriaId: string }) => x.categoriaId === alimentacao)

    await api.pedir({
      metodo: 'PATCH',
      url: `/v1/planejamentos/${alvo.id}`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { valorCentavos: '-90000' },
    })

    await copiar()

    const depois = (await listar(DESTINO)).json().itens.find(
      (x: { categoriaId: string }) => x.categoriaId === alimentacao,
    )
    expect(depois.valorCentavos).toBe('-90000')
  })
})

describe('isolamento e acesso', () => {
  it('o planejamento de um espaço não aparece no outro', async () => {
    const r = await listar(COMP, { usuario: USUARIO_B, tenant: TENANT_B })

    expect(r.statusCode).toBe(200)
    expect(r.json().itens).toEqual([])
  })

  it('visualizador lê e não escreve', async () => {
    const { pode } = await import('../src/autorizacao/politica-acesso.js')

    expect(pode({ metodo: 'GET', caminho: '/v1/planejamentos' }, 'visualizador')).toBe(true)
    expect(pode({ metodo: 'POST', caminho: '/v1/planejamentos' }, 'visualizador')).toBe(false)
    expect(pode({ metodo: 'POST', caminho: '/v1/planejamentos/copiar' }, 'membro')).toBe(true)
  })
})
