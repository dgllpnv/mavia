import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { comoApp, TENANT_A, TENANT_B, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * Conexão, consentimento e revogação — contra Postgres real.
 *
 * O que estes testes protegem não é uma funcionalidade que alguém usa hoje:
 * **nenhum agregador está ligado**. Eles protegem o esqueleto que precisa estar
 * correto *antes* da primeira credencial bancária entrar — porque os dois erros
 * possíveis aqui, guardar credencial sem envelope e dizer "revogada" sobre um
 * acesso que continua vivo, são irreversíveis depois do primeiro usuário e
 * invisíveis sem um teste que os procure.
 */

let api: ApiDeTeste

const DE = { usuario: USUARIO_A, tenant: TENANT_A }
const pedir = (metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, corpo?: unknown) =>
  api.pedir({ metodo, url, ...DE, ...(corpo === undefined ? {} : { corpo }) })

const nova = (over: Record<string, unknown> = {}) =>
  pedir('POST', '/v1/conexoes', {
    provider: 'ofx-import',
    apelido: 'Itaú da Ana',
    instituicao: 'Itaú',
    termosVersao: '2026-09-01',
    finalidade: 'importar o extrato para conciliar com os lançamentos manuais',
    escopo: ['extrato'],
    ...over,
  })

beforeAll(async () => {
  api = await subirApi()
}, 180_000)

afterAll(async () => {
  await api.encerrar()
})

describe('criar', () => {
  it('a conexão e o consentimento nascem juntos', async () => {
    // Separá-los produziria conexão viva sem prova de que alguém autorizou — e é
    // a prova, não a conexão, que responde à autoridade.
    const r = await nova()
    expect(r.statusCode).toBe(201)

    const prova = await api.banco.cliente.query(
      'SELECT termos_versao, finalidade, revogado_em FROM consentimentos WHERE conexao_id = $1',
      [r.json().id],
    )

    expect(prova.rowCount).toBe(1)
    expect(prova.rows[0]).toMatchObject({ termos_versao: '2026-09-01', revogado_em: null })
  })

  it('**recusa provider sem adapter**', async () => {
    // Conexão sem adapter é conexão que ninguém sabe revogar: a Fase 1
    // aconteceria e o lado de lá ficaria pendente para sempre.
    const r = await nova({ provider: 'pluggy' })

    expect(r.statusCode).toBe(400)
    expect(r.json().message.join?.(' ') ?? r.json().message).toContain('adapter')
  })

  it('a listagem mostra a conexão do próprio espaço', async () => {
    const r = await pedir('GET', '/v1/conexoes')

    expect(r.statusCode).toBe(200)
    expect(r.json().itens.length).toBeGreaterThan(0)
    expect(r.json().itens[0]).toHaveProperty('revogacaoNoProvedor')
  })

  it('**e não a de outro espaço**', async () => {
    const criada = await nova({ apelido: 'só do espaço A' })

    const doB = await api.pedir({
      metodo: 'GET',
      url: '/v1/conexoes',
      usuario: USUARIO_B,
      tenant: TENANT_B,
    })

    expect(doB.json().itens.map((c: { id: string }) => c.id)).not.toContain(criada.json().id)
  })
})

describe('revogar', () => {
  it('**a resposta traz os dois fatos, separados**', async () => {
    // "Revogada" descreve o que a Mavia fez com a credencial — incondicional e
    // já aconteceu. `revogacaoNoProvedor` descreve o que sabemos do outro lado.
    // Uma palavra só mentiria em metade dos casos, e é a metade que importa.
    const criada = await nova({ apelido: 'para revogar' })

    const r = await pedir('DELETE', `/v1/conexoes/${criada.json().id}`)

    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({
      status: 'revogada',
      credencialDestruida: true,
      // `ofx-import` não tem acesso continuado a encerrar: o acesso foi o
      // titular entregar um arquivo, uma vez.
      revogacaoNoProvedor: 'nao_aplicavel',
      lancamentosMantidos: 0,
    })
  })

  it('**o crypto-shred acontece na mesma transação**', async () => {
    // Uma conexão revogada com credencial viva é o incidente que a DP-9 existe
    // para impedir, e ele nasce de um `UPDATE` que esqueceu uma coluna. Aqui a
    // constraint do banco também recusaria — este teste prova que o caminho
    // normal não depende dela.
    const criada = await nova({ apelido: 'com envelope' })
    const id = criada.json().id

    // Simula o que um adapter com credencial gravaria.
    await api.banco.cliente.query(
      `UPDATE conexoes
          SET credenciais_cifradas = '\\x01'::bytea, dek_cifrada = '\\x02'::bytea,
              kek_versao = 1, dek_criada_em = now()
        WHERE id = $1`,
      [id],
    )

    await pedir('DELETE', `/v1/conexoes/${id}`)

    const depois = await api.banco.cliente.query(
      `SELECT status, credenciais_cifradas, dek_cifrada, kek_versao, escopo, revogada_em
         FROM conexoes WHERE id = $1`,
      [id],
    )

    expect(depois.rows[0]).toMatchObject({
      status: 'revogada',
      credenciais_cifradas: null,
      dek_cifrada: null,
      kek_versao: null,
      escopo: null,
    })
    expect(depois.rows[0].revogada_em).not.toBeNull()
  })

  it('**o consentimento ganha a data e não some**', async () => {
    // Se a prova sumisse junto com a conexão, a revogação destruiria a
    // evidência de que a coleta foi legítima — o oposto do que a LGPD pede.
    const criada = await nova({ apelido: 'prova permanece' })
    const id = criada.json().id

    await pedir('DELETE', `/v1/conexoes/${id}`)

    const prova = await api.banco.cliente.query(
      'SELECT revogado_em, motivo_revogacao, termos_versao FROM consentimentos WHERE conexao_id = $1',
      [id],
    )

    expect(prova.rowCount).toBe(1)
    expect(prova.rows[0].revogado_em).not.toBeNull()
    expect(prova.rows[0].motivo_revogacao).toBe('titular')
    expect(prova.rows[0].termos_versao).toBe('2026-09-01')
  })

  it('**a segunda revogação não é erro**', async () => {
    // O botão recebe dois cliques. A segunda revogação virando 500 na tela do
    // titular é o modo de falha mais provável desta rota.
    const criada = await nova({ apelido: 'dois cliques' })
    const id = criada.json().id

    const primeira = await pedir('DELETE', `/v1/conexoes/${id}`)
    const segunda = await pedir('DELETE', `/v1/conexoes/${id}`)

    expect(primeira.statusCode).toBe(200)
    expect(segunda.statusCode).toBe(200)
    expect(segunda.json()).toEqual(primeira.json())
  })

  it('conexão inexistente é 404, e não 500', async () => {
    const r = await pedir('DELETE', '/v1/conexoes/cccccccc-0000-4000-8000-00000000ffff')

    expect(r.statusCode).toBe(404)
  })

  it('**a conexão de outro espaço não é revogável**', async () => {
    // A RLS é a primeira camada: do ponto de vista do espaço B, a linha não
    // existe — e "não existe" é a resposta certa, não "não pode".
    const criada = await nova({ apelido: 'do espaço A' })

    const doB = await api.pedir({
      metodo: 'DELETE',
      url: `/v1/conexoes/${criada.json().id}`,
      usuario: USUARIO_B,
      tenant: TENANT_B,
    })

    expect(doB.statusCode).toBe(404)

    const ainda = await api.banco.cliente.query('SELECT status FROM conexoes WHERE id = $1', [
      criada.json().id,
    ])
    expect(ainda.rows[0].status).toBe('ativa')
  })

  it('a conta conectada volta a ser manual, e não some', async () => {
    // Revogar o acesso ao banco não é pedir a destruição do próprio extrato.
    const criada = await nova({ apelido: 'com conta' })
    const id = criada.json().id

    const contas = await pedir('GET', '/v1/contas')
    const contaId = contas.json().itens[0].id
    await api.banco.cliente.query(
      `UPDATE contas SET conexao_id = $1, origem = 'conectado' WHERE id = $2`,
      [id, contaId],
    )

    await pedir('DELETE', `/v1/conexoes/${id}`)

    const depois = await api.banco.cliente.query('SELECT origem FROM contas WHERE id = $1', [
      contaId,
    ])
    expect(depois.rows[0].origem).toBe('manual')

    // E a conta continua existindo, com o histórico dela.
    const listadas = await pedir('GET', '/v1/contas')
    expect(listadas.json().itens.map((c: { id: string }) => c.id)).toContain(contaId)
  })
})

describe('o que o banco recusa por conta própria', () => {
  it('**meia credencial não entra**', async () => {
    // Um `UPDATE` que gravasse `credenciais_cifradas` sem `dek_cifrada`
    // produziria ciphertext eternamente ilegível, e o defeito só apareceria na
    // primeira leitura, semanas depois.
    const criada = await nova({ apelido: 'meia credencial' })

    await expect(
      api.banco.cliente.query(
        `UPDATE conexoes SET credenciais_cifradas = '\\x01'::bytea WHERE id = $1`,
        [criada.json().id],
      ),
    ).rejects.toThrow(/envelope_completo/)
  })

  it('**revogada com credencial viva não entra**', async () => {
    const criada = await nova({ apelido: 'revogada suja' })

    await expect(
      api.banco.cliente.query(
        `UPDATE conexoes
            SET status = 'revogada', revogada_em = now(), revogacao_remota = 'confirmada',
                motivo_revogacao = 'titular',
                credenciais_cifradas = '\\x01'::bytea, dek_cifrada = '\\x02'::bytea,
                kek_versao = 1, dek_criada_em = now()
          WHERE id = $1`,
        [criada.json().id],
      ),
    ).rejects.toThrow(/revogada_nao_guarda_segredo/)
  })

  it('**o consentimento não é apagável pela aplicação**', async () => {
    // A ausência do `GRANT DELETE` é mais forte que a intenção de não escrever
    // o `DELETE`: a prova tem retenção de 5 anos e não some com a conexão.
    const criada = await nova({ apelido: 'prova protegida' })

    const r = await comoApp(
      api.banco.cliente,
      { tenantId: TENANT_A, usuarioId: USUARIO_A },
      () =>
        api.banco.cliente
          .query('DELETE FROM consentimentos WHERE conexao_id = $1', [criada.json().id])
          .then(() => 'apagou')
          .catch((e: Error) => e.message),
    )

    expect(r).not.toBe('apagou')
    expect(r).toMatch(/permission denied|permissão negada/i)
  })
})
