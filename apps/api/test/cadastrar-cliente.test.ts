import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * Cadastrar um cliente novo — ticket 09.
 *
 * O que este arquivo protege são três ausências, e cada uma custaria caro:
 *
 * 1. **A função não cria identidade.** Criar conta é ato de quem vai ser dono
 *    dela. Um operador criando login para terceiro é um operador que conhece a
 *    credencial de um cliente.
 * 2. **Não força estado.** O espaço nasce em `teste`, pelo gatilho, com sete
 *    dias e as cotas do Família. Sair de `teste` é `assinou`, e `assinou` pede
 *    plano e intervalo — que é a DP-40, ainda aberta.
 * 3. **Não é bypass do teto.** A rota do cliente cumpre três espaços por dia e
 *    dez ativos por titular. Um painel que ignorasse isso transformaria o
 *    limite numa formalidade que basta pedir a um operador para contornar.
 */

let api: ApiDeTeste
const HIPOTESE = { 'x-mavia-motivo': 'chamado', 'x-mavia-referencia': 'CH-9100' }

/** Um titular novo por chamada — os tetos são por pessoa. */
let sufixo = 0
async function novoTitular(): Promise<string> {
  sufixo += 1
  const id = `88888888-0000-4000-8000-${String(sufixo).padStart(12, '0')}`
  await api.banco.cliente.query(
    `INSERT INTO usuarios (id, email, nome) VALUES ($1, $2, 'Titular')
     ON CONFLICT (id) DO NOTHING`,
    [id, `titular${sufixo}@mavia.test`],
  )
  return id
}

async function cadastrar(titularId: string, nome = 'Espaço novo') {
  return api.pedir({
    metodo: 'POST',
    url: '/v1/admin/clientes',
    usuario: USUARIO_A,
    cabecalhos: HIPOTESE,
    corpo: { titularId, nome },
  })
}

beforeAll(async () => {
  api = await subirApi()
  await api.banco.cliente.query('SELECT admin.conceder($1, $2)', [USUARIO_A, USUARIO_A])
  await api.banco.cliente.query('SELECT admin.conceder($1, $2)', [USUARIO_B, USUARIO_A])
}, 120_000)

afterAll(async () => {
  await api?.encerrar()
})

describe('o espaço nasce em teste, e o painel diz isso', () => {
  it('**cria o espaço, vincula o titular, e não força estado**', async () => {
    const titular = await novoTitular()
    const r = await cadastrar(titular, 'Casa da Bia')
    expect(r.statusCode).toBe(201)

    const criado = r.json().id
    const estado = await api.banco.cliente.query<{ e: string; fim: Date }>(
      `SELECT estado::text AS e, periodo_fim AS fim FROM assinaturas WHERE tenant_id = $1`,
      [criado],
    )
    // A assinatura vem do **gatilho**, como `mavia_auth`. O painel não a insere
    // e não tem privilégio sobre `assinaturas` neste caminho — é o que mantém
    // "não força estado" verificável, e não uma promessa.
    expect(estado.rows[0]!.e).toBe('teste')

    const vinculo = await api.banco.cliente.query<{ papel: string }>(
      `SELECT papel FROM tenant_usuarios WHERE tenant_id = $1`,
      [criado],
    )
    expect(vinculo.rows[0]!.papel).toBe('proprietario')
  })

  it('**a resposta carrega o texto que a tela mostra**', async () => {
    // Ele é a metade que impede o operador de procurar o botão que não existe.
    const r = await cadastrar(await novoTitular())
    expect(r.statusCode).toBe(201)
    expect(r.json().aviso).toContain('teste')
    expect(r.json().aviso).toContain('assinar')
  })
})

describe('a função não cria identidade', () => {
  it('**titular que não existe é recusado, com frase**', async () => {
    const r = await cadastrar('44444444-0000-4000-8000-000000000404')
    expect(r.statusCode).toBe(400)
    expect(r.body).toContain('ainda não tem conta')
  })

  it('o corpo não aceita e-mail nem senha — só o id de quem já tem conta', async () => {
    const r = await api.pedir({
      metodo: 'POST',
      url: '/v1/admin/clientes',
      usuario: USUARIO_A,
      cabecalhos: HIPOTESE,
      corpo: { email: 'novo@cliente.test', senha: 'x', nome: 'Espaço' },
    })
    expect(r.statusCode).toBe(400)
  })
})

describe('o painel não é bypass do teto', () => {
  it('**o quarto espaço do dia é recusado**, com a mesma exceção da rota do cliente', async () => {
    const titular = await novoTitular()
    for (let i = 1; i <= 3; i++) {
      expect((await cadastrar(titular, `Espaço ${i}`)).statusCode, `${i}º`).toBe(201)
    }
    const quarto = await cadastrar(titular, 'Espaço 4')
    expect(quarto.statusCode).toBe(400)
    expect(quarto.body).toContain('três espaços')
  })

  it('**o décimo primeiro ativo é recusado**', async () => {
    const titular = await novoTitular()
    // Dez espaços criados por trás, com data antiga: o teto diário é de 24h, e
    // o que se mede aqui é o **de ativos**, que não tem janela.
    for (let i = 0; i < 10; i++) {
      const t = await api.banco.cliente.query<{ id: string }>(
        `INSERT INTO tenants (nome, criado_em) VALUES ($1, now() - interval '30 days') RETURNING id`,
        [`Antigo ${i}`],
      )
      await api.banco.cliente.query(
        `INSERT INTO tenant_usuarios (tenant_id, usuario_id, papel) VALUES ($1, $2, 'proprietario')`,
        [t.rows[0]!.id, titular],
      )
    }

    const r = await cadastrar(titular, 'O décimo primeiro')
    expect(r.statusCode).toBe(400)
    expect(r.body).toContain('dez espaços')
  })
})

describe('o par de linhas, com o espaço que nasceu', () => {
  it('**a intenção não tem espaço, e o efeito tem** — a abertura é do ato', async () => {
    const titular = await novoTitular()
    const m = await api.banco.cliente.query<{ t: string }>('SELECT now()::text AS t')

    const r = await cadastrar(titular, 'Com auditoria')
    expect(r.statusCode).toBe(201)
    const criado = r.json().id

    const linhas = await api.banco.cliente.query<{
      acao: string
      tenant_id: string
      correlacao: string
      para: { titular_email_sha256?: string } | null
    }>(
      `SELECT acao, tenant_id, correlacao, para FROM auditoria
        WHERE ocorrido_em > $1::timestamptz AND acao IN ('cadastrou_cliente')
        ORDER BY ocorrido_em`,
      [m.rows[0]!.t],
    )

    expect(linhas.rows).toHaveLength(2)
    const [intencao, efeito] = linhas.rows
    expect(intencao!.correlacao).toBe(efeito!.correlacao)

    // A intenção aponta para o UUID nulo — o espaço ainda não existia quando
    // ela foi gravada. O efeito carrega o espaço que nasceu.
    expect(intencao!.tenant_id).toBe('00000000-0000-0000-0000-000000000000')
    expect(efeito!.tenant_id).toBe(criado)

    // **O e-mail do titular entra hasheado.** Ele é dado pessoal, e a auditoria
    // tem regime de retenção diferente do cadastro.
    expect(efeito!.para?.titular_email_sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})
