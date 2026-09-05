import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROTAS_DE_ADMIN } from '../src/autorizacao/politica-acesso.js'
import { TENANT_A, USUARIO_A } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * **Nenhuma rota de `/v1/admin` serve quem não tem concessão** — o teste que
 * faltava, e a ausência dele custou o achado S-1.
 *
 * ## O defeito que passou
 *
 * `GET /v1/admin/precos` fazia `SELECT` direto em `precos_vigentes`, sem passar
 * por função `admin.*`. Como `ROTAS_DE_ADMIN` dispensa a matriz de papéis e
 * **exige apenas sessão**, e como toda a autorização do painel mora dentro das
 * funções `SECURITY DEFINER`, qualquer cliente autenticado da Mavia lia o
 * histórico de preços — com a **nota interna do operador** e o **UUID de quem a
 * escreveu**.
 *
 * A tabela estava vazia, então nada vazou. Isso é cronograma, não controle: a
 * primeira troca de preço armaria o vazamento.
 *
 * ## Por que o teste que existia não pegou
 *
 * `rotas-do-painel.test.ts` prova "sem concessão → 403" para **uma** rota,
 * `GET /v1/admin/clientes`. Uma amostra de um não é uma propriedade — e a rota
 * defeituosa foi a décima sétima.
 *
 * Este arquivo percorre `ROTAS_DE_ADMIN` **inteira**. A rota dezoito nasce
 * coberta, e é essa a diferença entre um teste e uma amostra.
 */

let api: ApiDeTeste

/** Um usuário com conta e sessão válidas, e **sem concessão nenhuma**. */
let intruso: string

const HIPOTESE = { 'x-mavia-motivo': 'chamado', 'x-mavia-referencia': 'CH-0001' }

/** Um corpo plausível por rota — o suficiente para passar da validação. */
const CORPO: Record<string, unknown> = {
  'POST /v1/admin/precos': {
    plano: 'pessoal',
    intervalo: 'mensal',
    centavos: '3300',
    motivo: 'tentativa de intruso registrada no teste',
  },
  'POST /v1/admin/operadores': { email: 'intruso@exemplo.test' },
  'DELETE /v1/admin/operadores': { email: 'intruso@exemplo.test' },
  // `titularId` é preenchido no `beforeAll` com o id do próprio intruso: o
  // corpo precisa ser **válido**, senão a validação recusa antes da
  // autorização e o `400` resultante não prova nada sobre quem pode chamar.
  'POST /v1/admin/clientes': { titularId: '', nome: 'Espaco do intruso' },
  'POST /v1/admin/clientes/:tenantId/pagamentos': {
    valorCentavos: '1000',
    meio: 'pix',
    referenciaExterna: 'INTRUSO-1',
    recebidoEm: new Date(Date.now() - 3_600_000).toISOString(),
  },
  'POST /v1/admin/clientes/:tenantId/descontos': {
    especie: 'percentual',
    pontosBase: 5000,
    duracao: 'sempre',
    motivo: 'tentativa de intruso registrada no teste',
  },
  'DELETE /v1/admin/clientes/:tenantId/descontos': {
    motivo: 'tentativa de intruso registrada no teste',
  },
  'POST /v1/admin/clientes/:tenantId/teste/prorrogar': {
    dias: 3650,
    razao: 'tentativa de intruso',
  },
  'POST /v1/admin/clientes/:tenantId/cortesia': { dias: 30, razao: 'tentativa de intruso' },
  'POST /v1/admin/clientes/:tenantId/abrir': {},
}

beforeAll(async () => {
  api = await subirApi()

  // O operador legítimo, para o contraste do último teste.
  await api.banco.cliente.query('SELECT admin.conceder($1, $2)', [USUARIO_A, USUARIO_A])

  const r = await api.banco.cliente.query<{ id: string }>(
    `INSERT INTO usuarios (email, nome) VALUES ('intruso@exemplo.test', 'Intruso')
     RETURNING id`,
  )
  intruso = r.rows[0]!.id
  await api.abrirSessao(intruso)

  // Ver a nota em `CORPO`.
  ;(CORPO['POST /v1/admin/clientes'] as { titularId: string }).titularId = intruso
}, 180_000)

afterAll(async () => {
  await api.encerrar()
})

/** As rotas com o `:tenantId` resolvido e o método separado. */
const ROTAS = [...ROTAS_DE_ADMIN].map((chave) => {
  const [metodo, caminho] = chave.split(' ') as [string, string]
  return { chave, metodo, url: caminho.replace(':tenantId', TENANT_A) }
})

describe('nenhuma rota de /v1/admin serve quem não tem concessão', () => {
  it('a lista percorrida não está vazia — senão este arquivo passaria sem testar nada', () => {
    // A armadilha óbvia de um teste que itera uma constante: se a constante
    // ficar vazia, `for` de zero elementos passa e o arquivo vira decoração.
    expect(ROTAS.length).toBeGreaterThanOrEqual(16)
  })

  it('**sem sessão, todas recusam com 401**', async () => {
    for (const r of ROTAS) {
      const resposta = await api.pedir({
        metodo: r.metodo,
        url: r.url,
        cabecalhos: HIPOTESE,
        ...(CORPO[r.chave] === undefined ? {} : { corpo: CORPO[r.chave] }),
      })
      expect(resposta.statusCode, r.chave).toBe(401)
    }
  })

  it('**com sessão e sem concessão, todas recusam com 403**', async () => {
    // Este é o teste que teria pego o S-1. A rota defeituosa devolvia `200`
    // com o histórico de preços, enquanto todas as outras devolviam `403`.
    for (const r of ROTAS) {
      const resposta = await api.pedir({
        metodo: r.metodo,
        url: r.url,
        usuario: intruso,
        cabecalhos: HIPOTESE,
        ...(CORPO[r.chave] === undefined ? {} : { corpo: CORPO[r.chave] }),
      })
      expect(resposta.statusCode, r.chave).toBe(403)
    }
  })

  it('**nenhuma resposta ao intruso contém dado do painel**', async () => {
    // A asserção de status sozinha não basta: um `403` cujo corpo carregue a
    // linha que a rota ia devolver continua vazando. Os nomes abaixo são os
    // campos que a `0043` e a `0031` declaram fora do alcance do cliente.
    const VETADOS = ['motivo', 'criado_por', 'concedido_por', 'email_no_ato', 'valor_centavos']

    for (const r of ROTAS) {
      const resposta = await api.pedir({
        metodo: r.metodo,
        url: r.url,
        usuario: intruso,
        cabecalhos: HIPOTESE,
        ...(CORPO[r.chave] === undefined ? {} : { corpo: CORPO[r.chave] }),
      })
      const corpo = resposta.body
      for (const campo of VETADOS) {
        expect(corpo, `${r.chave} vazou ${campo}`).not.toContain(`"${campo}"`)
      }
    }
  })

  it('o operador legítimo continua passando — senão o teste acima provaria só que tudo quebrou', async () => {
    const r = await api.pedir({
      metodo: 'GET',
      url: '/v1/admin/clientes',
      usuario: USUARIO_A,
      cabecalhos: HIPOTESE,
    })
    expect(r.statusCode).toBe(200)

    const precos = await api.pedir({
      metodo: 'GET',
      url: '/v1/admin/precos',
      usuario: USUARIO_A,
      cabecalhos: HIPOTESE,
    })
    expect(precos.statusCode).toBe(200)
  })
})
