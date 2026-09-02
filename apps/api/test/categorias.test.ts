import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, TENANT_B, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * `GET /v1/categorias` — a árvore, inteira, numa chamada.
 *
 * Existe porque toda tela que mostra lançamento precisa do **nome** da
 * categoria, e uma chamada por linha transformaria um extrato de 15 linhas em
 * 16 requisições. A árvore de um espaço é pequena e muda raramente: ela cabe
 * numa resposta e vive em cache no cliente.
 */

let api: ApiDeTeste

beforeAll(async () => {
  api = await subirApi()

  await api.banco.cliente.query(
    `INSERT INTO categorias (tenant_id, nivel, nome, natureza)
     VALUES ($1, 1, 'Moradia', 'despesa')`,
    [TENANT_A],
  )
  await api.banco.cliente.query(
    `INSERT INTO categorias (tenant_id, nivel, nome, natureza, parent_id)
     SELECT $1, 2, 'Aluguel', 'despesa', id FROM categorias
      WHERE tenant_id = $1 AND nome = 'Moradia'`,
    [TENANT_A],
  )
  await api.banco.cliente.query(
    `INSERT INTO categorias (tenant_id, nivel, nome, natureza)
     VALUES ($1, 1, 'Só do Bruno', 'despesa')`,
    [TENANT_B],
  )
}, 180_000)

afterAll(async () => {
  await api?.encerrar()
})

const listar = (usuario: string, tenant: string) =>
  api.pedir({ metodo: 'GET', url: '/v1/categorias', usuario, tenant })

describe('GET /v1/categorias', () => {
  it('devolve a árvore do espaço com nome, natureza e mãe', async () => {
    const r = await listar(USUARIO_A, TENANT_A)

    expect(r.statusCode).toBe(200)
    const itens: { nome: string; natureza: string; parentId: string | null }[] = r.json().itens

    expect(itens.find((c) => c.nome === 'Moradia')).toMatchObject({
      natureza: 'despesa',
      parentId: null,
      nivel: 1,
    })
    const aluguel = itens.find((c) => c.nome === 'Aluguel')
    expect(aluguel?.parentId).toEqual(expect.any(String))
  })

  it('traz as categorias de sistema, que o espaço nasce com elas', async () => {
    const nomes = (await listar(USUARIO_A, TENANT_A)).json().itens.map((c: { nome: string }) => c.nome)

    // `Sem categoria` recebe o importado que a categorização não classificou, e
    // `Ajuste de saldo` recebe a conciliação. As duas precisam aparecer no
    // seletor do formulário, ou o usuário não consegue escolhê-las.
    expect(nomes).toContain('Sem categoria')
    expect(nomes).toContain('Ajuste de saldo')
  })

  it('diz quais recebem lançamento', async () => {
    // `Ajuste de saldo` é não-analítica: fica fora do relatório de categoria e
    // de todo Planejamento, mas continua recebendo lançamento (ADR 0021). O
    // cliente precisa dessa distinção para não a esconder do seletor.
    const itens: { nome: string; analitica: boolean }[] = (
      await listar(USUARIO_A, TENANT_A)
    ).json().itens

    expect(itens.find((c) => c.nome === 'Ajuste de saldo')?.analitica).toBe(false)
    expect(itens.find((c) => c.nome === 'Sem categoria')?.analitica).toBe(true)
  })

  it('a categoria de um espaço não vaza para o outro', async () => {
    const doA = await listar(USUARIO_A, TENANT_A)
    const doB = await listar(USUARIO_B, TENANT_B)

    expect(doA.body).not.toContain('Só do Bruno')
    expect(doB.body).toContain('Só do Bruno')
    expect(doB.body).not.toContain('Moradia')
  })

  it('sem sessão é 401', async () => {
    const r = await api.pedir({ metodo: 'GET', url: '/v1/categorias', tenant: TENANT_A })

    expect(r.statusCode).toBe(401)
  })

  it('visualizador lê a árvore', async () => {
    const { pode } = await import('../src/autorizacao/politica-acesso.js')

    expect(pode({ metodo: 'GET', caminho: '/v1/categorias' }, 'visualizador')).toBe(true)
  })
})
