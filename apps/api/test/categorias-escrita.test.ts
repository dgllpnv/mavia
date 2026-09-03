import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, TENANT_B, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * Criar, renomear e arquivar categoria.
 *
 * A árvore tem **dois níveis** e regras que o banco já protege; estas rotas
 * existem para que a pessoa consiga usá-las sem `psql`. O que os testes travam
 * é o que o formulário conseguiria pedir e não deve:
 *
 * - uma neta (nível 3), que a hierarquia não tem;
 * - trocar a natureza de uma categoria que já tem lançamento — o sinal do
 *   lançamento passaria a discordar da categoria dele;
 * - apagar categoria de sistema, ou apagar de verdade qualquer categoria.
 */

let api: ApiDeTeste
let contaId = ''

beforeAll(async () => {
  api = await subirApi()

  const contas = await api.pedir({
    metodo: 'GET',
    url: '/v1/contas',
    usuario: USUARIO_A,
    tenant: TENANT_A,
  })
  contaId = contas.json().itens[0].id
}, 180_000)

afterAll(async () => {
  await api?.encerrar()
})

const criar = (corpo: Record<string, unknown>, quem = { usuario: USUARIO_A, tenant: TENANT_A }) =>
  api.pedir({ metodo: 'POST', url: '/v1/categorias', ...quem, corpo })

const listar = (quem = { usuario: USUARIO_A, tenant: TENANT_A }) =>
  api.pedir({ metodo: 'GET', url: '/v1/categorias', ...quem })

describe('criar categoria', () => {
  let moradiaId = ''

  it('cria uma raiz', async () => {
    const r = await criar({ nome: 'Moradia', natureza: 'despesa' })

    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({
      nome: 'Moradia',
      natureza: 'despesa',
      nivel: 1,
      parentId: null,
      analitica: true,
      sistema: false,
    })
    moradiaId = r.json().id
  })

  it('cria uma filha, e ela herda a natureza da mãe', async () => {
    // Natureza herdada, e não escolhida: uma filha de despesa que fosse receita
    // faria a soma da árvore misturar os dois sinais no mesmo galho.
    const r = await criar({ nome: 'Aluguel', natureza: 'receita', parentId: moradiaId })

    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({ nivel: 2, parentId: moradiaId, natureza: 'despesa' })
  })

  it('recusa neta: a árvore tem dois níveis', async () => {
    const filha = (await listar()).json().itens.find((c: { nome: string }) => c.nome === 'Aluguel')

    const r = await criar({ nome: 'Condomínio', natureza: 'despesa', parentId: filha.id })

    expect(r.statusCode).toBe(400)
    expect(String(r.json().message)).toMatch(/dois níveis|subcategoria/i)
  })

  it('recusa mãe de outro espaço', async () => {
    // 404 e não 403: dizer "existe, mas não é sua" entrega a existência de uma
    // categoria de outro cliente.
    const r = await criar(
      { nome: 'Invasora', natureza: 'despesa', parentId: (await listar()).json().itens[0].id },
      { usuario: USUARIO_B, tenant: TENANT_B },
    )

    expect(r.statusCode).toBe(404)
  })

  it('recusa nome vazio', async () => {
    expect((await criar({ nome: '   ', natureza: 'despesa' })).statusCode).toBe(400)
  })
})

describe('renomear e arquivar', () => {
  let alvo = ''

  beforeAll(async () => {
    alvo = (await criar({ nome: 'Lazer', natureza: 'despesa' })).json().id
  })

  it('renomeia', async () => {
    const r = await api.pedir({
      metodo: 'PATCH',
      url: `/v1/categorias/${alvo}`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { nome: 'Lazer e cultura' },
    })

    expect(r.statusCode).toBe(200)
    expect(r.json().nome).toBe('Lazer e cultura')
  })

  it('recusa trocar a natureza de categoria que já tem lançamento', async () => {
    // O sinal do lançamento passaria a discordar da natureza da categoria, e o
    // gatilho `lancamento_coerente` só olha o lançamento na hora de gravá-lo —
    // ninguém revisita os antigos.
    await api.pedir({
      metodo: 'POST',
      url: '/v1/lancamentos',
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: {
        contaId,
        categoriaId: alvo,
        valorCentavos: '-5000',
        postedAt: '2026-05-10T15:00:00.000Z',
        compensado: true,
        descricao: 'Cinema',
      },
    })

    const r = await api.pedir({
      metodo: 'PATCH',
      url: `/v1/categorias/${alvo}`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
      corpo: { natureza: 'receita' },
    })

    expect(r.statusCode).toBe(409)
    expect(String(r.json().message)).toMatch(/lançamento/i)
  })

  it('arquivar não apaga, e o lançamento antigo continua com nome', async () => {
    const r = await api.pedir({
      metodo: 'DELETE',
      url: `/v1/categorias/${alvo}`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })
    expect(r.statusCode).toBe(204)

    // Continua na resposta, marcada — é o que dá nome ao lançamento antigo. O
    // cliente a esconde do seletor, não do dicionário.
    const c = (await listar()).json().itens.find((x: { id: string }) => x.id === alvo)
    expect(c).toMatchObject({ nome: 'Lazer e cultura', arquivada: true })
  })

  it('categoria de sistema não se arquiva', async () => {
    // `Sem categoria` é o destino do importado que a categorização não soube
    // classificar. Sem ela, a importação não teria onde pôr o que não entendeu.
    const sistema = (await listar())
      .json()
      .itens.find((c: { nome: string; natureza: string }) => c.nome === 'Sem categoria')

    const r = await api.pedir({
      metodo: 'DELETE',
      url: `/v1/categorias/${sistema.id}`,
      usuario: USUARIO_A,
      tenant: TENANT_A,
    })

    expect(r.statusCode).toBe(409)
  })

  it('a categoria de um espaço não é tocada pelo outro', async () => {
    const r = await api.pedir({
      metodo: 'PATCH',
      url: `/v1/categorias/${alvo}`,
      usuario: USUARIO_B,
      tenant: TENANT_B,
      corpo: { nome: 'Roubada' },
    })

    expect(r.statusCode).toBe(404)
  })

  it('visualizador lê e não escreve', async () => {
    const { pode } = await import('../src/autorizacao/politica-acesso.js')

    expect(pode({ metodo: 'GET', caminho: '/v1/categorias' }, 'visualizador')).toBe(true)
    expect(pode({ metodo: 'POST', caminho: '/v1/categorias' }, 'visualizador')).toBe(false)
    expect(pode({ metodo: 'PATCH', caminho: '/v1/categorias/:id' }, 'visualizador')).toBe(false)
    expect(pode({ metodo: 'DELETE', caminho: '/v1/categorias/:id' }, 'membro')).toBe(true)
  })
})
