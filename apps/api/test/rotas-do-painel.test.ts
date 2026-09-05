import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, TENANT_B, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'
import { ROTAS_DE_ADMIN } from '../src/autorizacao/politica-acesso.js'

/**
 * As rotas de leitura do painel — ticket 06.
 *
 * É a primeira vez que `/v1/admin/` existe no roteador, e o que estes testes
 * protegem é a propriedade que a ADR 0024 D2 fixa: **nenhuma rota de admin
 * produz um `Autenticado`**.
 *
 * Sem ela, o autenticador montaria um contexto de cliente com o tenant do
 * cliente, e a partir daí **todos** os controladores existentes passariam a
 * servir o operador — cada um chamando `comTenant`, que roda como `mavia_app`,
 * com escrita completa sobre o razão. Não é hipótese: é o que acontece se a
 * segunda condição do `exigeTenant` sumir.
 */

let api: ApiDeTeste

const HIPOTESE = {
  'x-mavia-motivo': 'chamado',
  'x-mavia-referencia': 'CH-4242',
}

async function darConcessao(usuario: string): Promise<void> {
  await api.banco.cliente.query('SELECT admin.conceder($1, $2)', [usuario, USUARIO_A])
}

beforeAll(async () => {
  api = await subirApi()
  // Duas: a invariante do ticket 04 impede descer para uma.
  await darConcessao(USUARIO_A)
  await darConcessao(USUARIO_B)
}, 120_000)

afterAll(async () => {
  await api?.encerrar()
})

describe('as rotas do painel estão declaradas, e o boot passou', () => {
  it('as chaves conferem, e o boot as aceitou nas duas direções', () => {
    // Se a asserção de prefixo do ticket 02 tivesse falhado — rota registrada
    // fora da lista, ou chave da lista fora do prefixo —, o `subirApi` teria
    // lançado no `beforeAll`.
    // **Os dois lados ordenados**, e não só o esperado. A versão anterior
    // comparava contra uma lista escrita à mão, e cada rota nova quebrava o
    // teste por posição em vez de por conteúdo — ruído que ensina a atualizar
    // a lista sem ler o que ela diz.
    const esperadas = [
      'GET /v1/admin/clientes',
      'GET /v1/admin/clientes/:tenantId',
      'GET /v1/admin/clientes/:tenantId/contas',
      'GET /v1/admin/clientes/:tenantId/lancamentos',
      'GET /v1/admin/clientes/:tenantId/pagamentos',
      'POST /v1/admin/clientes',
      'GET /v1/admin/registro',
      'POST /v1/admin/clientes/:tenantId/abrir',
      'POST /v1/admin/clientes/:tenantId/cortesia',
      'POST /v1/admin/clientes/:tenantId/pagamentos',
      'POST /v1/admin/clientes/:tenantId/teste/prorrogar',
      // ADR 0025. As duas de preço **não têm `:tenantId`** — preço de plano é
      // do produto, não de um espaço —, e são as únicas do painel assim.
      'GET /v1/admin/precos',
      'POST /v1/admin/precos',
      'GET /v1/admin/clientes/:tenantId/descontos',
      'POST /v1/admin/clientes/:tenantId/descontos',
      'DELETE /v1/admin/clientes/:tenantId/descontos',
    ]
    expect([...ROTAS_DE_ADMIN].sort()).toEqual([...esperadas].sort())
  })
})

describe('o painel não empresta o caminho do cliente', () => {
  it('**o controlador não chama `comTenant`, `comUsuario` nem `resolverTenant`**', async () => {
    // Asserção sobre o código, e não sobre a requisição: as três funções são o
    // caminho do cliente, e uma delas aqui significaria o painel rodando como
    // `mavia_app` sobre o espaço de alguém.
    const fonte = await readFile(new URL('../src/admin/admin.controller.ts', import.meta.url), 'utf8')
    const codigo = fonte
      .split(/\r?\n/)
      .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
      .join('\n')
    for (const proibida of ['comTenant(', 'comUsuario(', 'resolverTenant(']) {
      expect(codigo, proibida).not.toContain(proibida)
    }
  })

  it('**`exigeTenant` exclui as rotas de admin** — é o que impede o `Autenticado`', async () => {
    const fonte = await readFile(new URL('../src/aplicacao.ts', import.meta.url), 'utf8')
    expect(fonte).toContain('!ROTAS_DE_ADMIN.has(chave)')
  })

  it('sem sessão, a rota de admin responde 401', async () => {
    const r = await api.pedir({ metodo: 'GET', url: '/v1/admin/clientes' })
    expect(r.statusCode).toBe(401)
  })

  it('**sem concessão ativa, responde 403** — e não 500', async () => {
    // A concessão é resolvida **por requisição**, dentro da função, contra a
    // tabela — nunca carimbada no token. O cofre só carrega `{sessaoId,
    // usuarioId}`; não há onde guardar uma claim de papel.
    const semConcessao = '77777777-0000-0000-0000-00000000007a'
    await api.banco.cliente.query(
      `INSERT INTO usuarios (id, email, nome) VALUES ($1, 'sem@mavia.test', 'Sem')
       ON CONFLICT (id) DO NOTHING`,
      [semConcessao],
    )
    // **Com sessão**, e é o ponto: sem ela a resposta seria 401, e o teste
    // mediria autenticação em vez de autorização. 401 diz "não entrou"; 403
    // diz "entrou e não pode" — e é o segundo que este teste existe para provar.
    await api.abrirSessao(semConcessao)

    const r = await api.pedir({ metodo: 'GET', url: '/v1/admin/clientes', usuario: semConcessao })
    expect(r.statusCode).toBe(403)
  })
})

describe('a hipótese é pedida antes, não depois', () => {
  it('**sem motivo e referência, a leitura do espaço é recusada**', async () => {
    const r = await api.pedir({
      metodo: 'GET',
      url: `/v1/admin/clientes/${TENANT_B}`,
      usuario: USUARIO_A,
    })
    expect(r.statusCode).toBe(400)
    expect(r.body).toContain('motivo do acesso')
  })

  it('**um motivo fora da lista fechada é recusado**', async () => {
    const r = await api.pedir({
      metodo: 'GET',
      url: `/v1/admin/clientes/${TENANT_B}`,
      usuario: USUARIO_A,
      cabecalhos: { 'x-mavia-motivo': 'curiosidade', 'x-mavia-referencia': 'CH-1' },
    })
    expect(r.statusCode).toBe(400)
  })

  it('**referência vazia é recusada** — hipótese que ninguém confere não é hipótese', async () => {
    const r = await api.pedir({
      metodo: 'GET',
      url: `/v1/admin/clientes/${TENANT_B}`,
      usuario: USUARIO_A,
      cabecalhos: { 'x-mavia-motivo': 'chamado', 'x-mavia-referencia': '' },
    })
    expect(r.statusCode).toBe(400)
  })
})

describe('cada tela deixa a sua própria linha', () => {
  async function linhasDesde(marca: string): Promise<{ rota: string; registros: string | null }[]> {
    const r = await api.banco.cliente.query<{ rota: string; registros: string | null }>(
      `SELECT rota, registros::text FROM auditoria
        WHERE ator_tipo = 'operador' AND ocorrido_em > $1::timestamptz
        ORDER BY ocorrido_em`,
      [marca],
    )
    return r.rows
  }

  it('**duas telas seguidas deixam duas linhas, não uma**', async () => {
    // É a propriedade que o reuso dos controladores do cliente destruiria:
    // uma linha na abertura e nenhuma nas N leituras seguintes.
    const m = await api.banco.cliente.query<{ t: string }>('SELECT now()::text AS t')
    const marca = m.rows[0]!.t

    for (const url of [
      `/v1/admin/clientes/${TENANT_A}`,
      `/v1/admin/clientes/${TENANT_A}/contas`,
    ]) {
      const r = await api.pedir({ metodo: 'GET', url, usuario: USUARIO_A, cabecalhos: HIPOTESE })
      expect(r.statusCode, url).toBe(200)
    }

    const linhas = await linhasDesde(marca)
    expect(linhas.map((l) => l.rota)).toEqual([
      '/v1/admin/clientes/:tenantId',
      '/v1/admin/clientes/:tenantId',
      '/v1/admin/clientes/:tenantId/contas',
      '/v1/admin/clientes/:tenantId/contas',
    ])
  })

  it('**cada tela grava a contagem**, numa segunda linha correlacionada', async () => {
    // A §8 promete "rota e contagem", e a promessa era falsa: `abrir_espaco`
    // roda **antes** da leitura, quando ninguém sabe quantos registros virão, e
    // `auditoria` não aceita `UPDATE` — a linha da abertura nunca é completada
    // depois. Medido no banco: as quatro telas de cliente gravavam `registros`
    // nulo.
    //
    // "Abriu o espaço" não responde à natureza dos dados afetados; "abriu o
    // espaço, rota X, 143 registros" responde.
    const m = await api.banco.cliente.query<{ t: string }>('SELECT now()::text AS t')
    const r = await api.pedir({
      metodo: 'GET',
      url: `/v1/admin/clientes/${TENANT_A}/contas`,
      usuario: USUARIO_A,
      cabecalhos: HIPOTESE,
    })
    expect(r.statusCode).toBe(200)

    const linhas = await api.banco.cliente.query<{
      acao: string
      registros: string | null
      correlacao: string
    }>(
      `SELECT acao, registros::text, correlacao FROM auditoria
        WHERE ator_tipo = 'operador' AND ocorrido_em > $1::timestamptz
        ORDER BY ocorrido_em`,
      [m.rows[0]!.t],
    )

    expect(linhas.rows.map((l) => l.acao)).toEqual(['leu', 'leu_registros'])
    // A mesma correlação: é ela que permite afirmar que as duas são o mesmo ato.
    expect(linhas.rows[0]!.correlacao).toBe(linhas.rows[1]!.correlacao)
    expect(linhas.rows[0]!.registros).toBeNull()
    expect(Number(linhas.rows[1]!.registros)).toBe(r.json().itens.length)
  })

  it('**a leitura enxerga o espaço do cliente**, e o operador não é membro dele', async () => {
    const r = await api.pedir({
      metodo: 'GET',
      url: `/v1/admin/clientes/${TENANT_A}/contas`,
      usuario: USUARIO_A,
      cabecalhos: HIPOTESE,
    })
    expect(r.statusCode).toBe(200)
    // A semente dá uma conta ao tenant A. O operador não tem vínculo com ele —
    // quem abre a porta é `admin.abrir_espaco`, não `tenant_usuarios`.
    expect(r.json().itens.length).toBeGreaterThan(0)
  })

  it('**abrir explicitamente devolve a correlação** que a linha de efeito vai carregar', async () => {
    const r = await api.pedir({
      metodo: 'POST',
      url: `/v1/admin/clientes/${TENANT_B}/abrir`,
      usuario: USUARIO_A,
      cabecalhos: HIPOTESE,
      corpo: {},
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().correlacao).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('a busca', () => {
  it('lista os clientes e grava uma linha por busca', async () => {
    const r = await api.pedir({ metodo: 'GET', url: '/v1/admin/clientes', usuario: USUARIO_A })
    expect(r.statusCode).toBe(200)
    expect(r.json().itens.length).toBeGreaterThanOrEqual(2)
  })

  it('**o termo não aparece em claro no log**', async () => {
    const m = await api.banco.cliente.query<{ t: string }>('SELECT now()::text AS t')
    await api.pedir({
      metodo: 'GET',
      url: '/v1/admin/clientes?q=Ana',
      usuario: USUARIO_A,
    })
    const log = await api.banco.cliente.query<{ de: unknown }>(
      `SELECT de FROM auditoria WHERE acao = 'buscou' AND ocorrido_em > $1::timestamptz`,
      [m.rows[0]!.t],
    )
    expect(log.rows).toHaveLength(1)
    expect(JSON.stringify(log.rows[0]!.de)).not.toContain('Ana')
  })
})
