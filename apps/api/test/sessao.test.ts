import { hash } from '@node-rs/argon2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, TENANT_B, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * Entrada na plataforma — `docs/produto/spec-autenticacao.md` §3.
 *
 * Esta é a porta de todo o resto do produto, e o único lugar onde o tempo de
 * resposta é parte do contrato: uma diferença mensurável entre "endereço não
 * existe" e "senha errada" transforma a rota num oráculo que enumera a base de
 * clientes. Os testes abaixo tratam vazamento por mensagem, por código de
 * status e por forma da resposta.
 */

let api: ApiDeTeste

const SENHA = 'uma senha longa o suficiente'

beforeAll(async () => {
  api = await subirApi()

  // A senha entra pelo caminho privilegiado, como o cadastro a gravaria.
  await api.banco.cliente.query(`UPDATE usuarios SET senha_hash = $1 WHERE id = $2`, [
    await hash(SENHA),
    USUARIO_A,
  ])
  // A Bruno fica **sem** senha: conta só federada, o caso que não pode virar
  // uma dica de "esta conta existe, use o Google".
}, 180_000)

afterAll(async () => {
  await api?.encerrar()
})

function entrar(corpo: Record<string, unknown>) {
  return api.pedir({ metodo: 'POST', url: '/v1/sessoes', corpo })
}

describe('POST /v1/sessoes', () => {
  it('credencial correta devolve token e os espaços do usuário', async () => {
    const r = await entrar({ email: 'ana@exemplo.com', senha: SENHA, plataforma: 'mobile' })

    expect(r.statusCode).toBe(201)
    expect(r.json().token).toEqual(expect.any(String))
    expect(r.json().usuario).toMatchObject({ id: USUARIO_A, nome: 'Ana' })
    expect(r.json().tenants).toEqual([
      expect.objectContaining({ id: TENANT_A, papel: 'proprietario' }),
    ])
  })

  it('o token emitido abre uma rota protegida', async () => {
    // O que prova que o login serve para alguma coisa: o token vale no resto
    // da API, e não só na resposta desta rota.
    const login = await entrar({ email: 'ana@exemplo.com', senha: SENHA, plataforma: 'mobile' })

    const r = await api.app.inject({
      method: 'GET',
      url: '/v1/contas',
      headers: {
        authorization: `Bearer ${login.json().token}`,
        'x-mavia-tenant': TENANT_A,
      },
    })

    expect(r.statusCode).toBe(200)
  })

  it('o token não abre o espaço de outro tenant', async () => {
    const login = await entrar({ email: 'ana@exemplo.com', senha: SENHA, plataforma: 'mobile' })

    const r = await api.app.inject({
      method: 'GET',
      url: '/v1/contas',
      headers: {
        authorization: `Bearer ${login.json().token}`,
        'x-mavia-tenant': TENANT_B,
      },
    })

    expect(r.statusCode).toBe(403)
  })

  it('a resposta nunca carrega o hash da senha', async () => {
    const r = await entrar({ email: 'ana@exemplo.com', senha: SENHA, plataforma: 'mobile' })

    expect(r.body).not.toContain('argon2')
    expect(r.body).not.toContain('senha')
  })

  it('senha errada e endereço inexistente são indistinguíveis', async () => {
    // Corpo e status idênticos. Qualquer diferença aqui — inclusive uma vírgula
    // na mensagem — vira enumeração da base de clientes.
    const errada = await entrar({
      email: 'ana@exemplo.com',
      senha: 'não é essa',
      plataforma: 'web',
    })
    const inexistente = await entrar({
      email: 'ninguem@exemplo.com',
      senha: SENHA,
      plataforma: 'web',
    })

    expect(errada.statusCode).toBe(401)
    expect(inexistente.statusCode).toBe(401)
    expect(errada.body).toBe(inexistente.body)
  })

  it('conta só federada responde igual, sem dizer "entre pelo Google"', async () => {
    // A dica seria útil ao titular e igualmente útil a quem varre endereços.
    // O aviso certo vai por e-mail, ao dono da caixa — não na resposta HTTP.
    const federada = await entrar({
      email: 'bruno@exemplo.com',
      senha: SENHA,
      plataforma: 'web',
    })
    const inexistente = await entrar({
      email: 'ninguem@exemplo.com',
      senha: SENHA,
      plataforma: 'web',
    })

    expect(federada.statusCode).toBe(401)
    expect(federada.body).toBe(inexistente.body)
  })

  it('endereço inexistente não responde mais rápido que senha errada', async () => {
    // Verificação fantasma: o caminho sem usuário roda um Argon2 contra um hash
    // constante. Sem isso, a diferença é de duas ordens de grandeza e a rota
    // vira um oráculo — mesmo com as duas respostas idênticas.
    const medir = async (email: string) => {
      const amostras: number[] = []
      for (let i = 0; i < 5; i++) {
        const inicio = process.hrtime.bigint()
        await entrar({ email, senha: SENHA, plataforma: 'web' })
        amostras.push(Number(process.hrtime.bigint() - inicio) / 1e6)
      }
      amostras.sort((a, b) => a - b)
      return amostras[2]!
    }

    const comUsuario = await medir('ana@exemplo.com')
    const semUsuario = await medir('ninguem@exemplo.com')

    // Mediana, e uma folga larga: o teste protege contra a ausência da
    // verificação fantasma, não contra ruído de agendamento do sistema.
    expect(semUsuario).toBeGreaterThan(comUsuario / 4)
  })

  it('e-mail confere sem diferenciar maiúsculas', async () => {
    const r = await entrar({ email: 'ANA@Exemplo.COM', senha: SENHA, plataforma: 'mobile' })

    expect(r.statusCode).toBe(201)
  })

  it('corpo inválido é 400, e não 401', async () => {
    // 401 aqui diria "a credencial está errada" sobre um corpo que nem chegou a
    // ser uma credencial.
    expect((await entrar({ email: 'não é e-mail', senha: SENHA, plataforma: 'web' })).statusCode).toBe(400)
    expect((await entrar({ email: 'ana@exemplo.com', plataforma: 'web' })).statusCode).toBe(400)
    expect((await entrar({ email: 'ana@exemplo.com', senha: SENHA })).statusCode).toBe(400)
  })

  it('no web o token vai em cookie, e não no corpo', async () => {
    // Token no corpo é token acessível a qualquer script da página. No web ele
    // viaja em cookie `HttpOnly`; no mobile, que não tem cookie jar, no corpo.
    const r = await entrar({ email: 'ana@exemplo.com', senha: SENHA, plataforma: 'web' })

    expect(r.statusCode).toBe(201)
    expect(r.json().token).toBeUndefined()

    const cookie = r.headers['set-cookie']
    const texto = Array.isArray(cookie) ? cookie.join(';') : String(cookie)
    expect(texto).toContain('__Host-mavia_sessao=')
    expect(texto).toContain('HttpOnly')
    expect(texto).toContain('Secure')
    expect(texto).toContain('SameSite=Lax')
    expect(texto).toContain('Path=/')
    // `__Host-` proíbe `Domain`. Com ele, um subdomínio comprometido fixa a
    // sessão do domínio inteiro.
    expect(texto).not.toContain('Domain=')
  })

  it('o cookie do web autentica sem cabeçalho Authorization', async () => {
    const login = await entrar({ email: 'ana@exemplo.com', senha: SENHA, plataforma: 'web' })
    const cookie = String(
      Array.isArray(login.headers['set-cookie'])
        ? login.headers['set-cookie'][0]
        : login.headers['set-cookie'],
    ).split(';')[0]

    const r = await api.app.inject({
      method: 'GET',
      url: '/v1/contas',
      headers: { cookie: cookie!, 'x-mavia-tenant': TENANT_A },
    })

    expect(r.statusCode).toBe(200)
  })
})

describe('GET /v1/eu', () => {
  it('devolve o usuário e os espaços dele, sem exigir X-Mavia-Tenant', async () => {
    // A rota que o cliente chama ANTES de saber qual espaço pedir. Exigir o
    // cabeçalho aqui seria exigir a resposta como pergunta.
    const login = await entrar({ email: 'ana@exemplo.com', senha: SENHA, plataforma: 'mobile' })

    const r = await api.app.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { authorization: `Bearer ${login.json().token}` },
    })

    expect(r.statusCode).toBe(200)
    expect(r.json().usuario).toMatchObject({ id: USUARIO_A, email: 'ana@exemplo.com' })
    expect(r.json().tenants).toHaveLength(1)
  })

  it('sem sessão é 401', async () => {
    expect((await api.app.inject({ method: 'GET', url: '/v1/eu' })).statusCode).toBe(401)
  })

  it('cada usuário enxerga só os próprios espaços', async () => {
    const r = await api.pedir({ metodo: 'GET', url: '/v1/eu', usuario: USUARIO_B })

    expect(r.json().tenants.map((t: { id: string }) => t.id)).toEqual([TENANT_B])
  })

  it('o espaço de outro não aparece nem pelo nome', async () => {
    // A policy nova é permissiva e se combina por OU com `tenant_proprio`. Se
    // ela fosse ampla demais, o nome do espaço de outro cliente vazaria aqui —
    // e nome de espaço costuma ser o nome de uma família.
    const r = await api.pedir({ metodo: 'GET', url: '/v1/eu', usuario: USUARIO_A })

    expect(r.body).not.toContain('Família B')
    expect(r.body).toContain('Família A')
  })
})

describe('DELETE /v1/sessoes/atual', () => {
  it('revoga a sessão, e o token deixa de valer no ato', async () => {
    const login = await entrar({ email: 'ana@exemplo.com', senha: SENHA, plataforma: 'mobile' })
    const token = login.json().token
    const cabecalhos = { authorization: `Bearer ${token}`, 'x-mavia-tenant': TENANT_A }

    expect(
      (await api.app.inject({ method: 'GET', url: '/v1/contas', headers: cabecalhos })).statusCode,
    ).toBe(200)

    const saida = await api.app.inject({
      method: 'DELETE',
      url: '/v1/sessoes/atual',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(saida.statusCode).toBe(204)

    // Sair tem de ser imediato. Uma sessão que continua valendo até expirar
    // torna o botão "sair" uma promessa que o servidor não cumpre.
    expect(
      (await api.app.inject({ method: 'GET', url: '/v1/contas', headers: cabecalhos })).statusCode,
    ).toBe(401)
  })

  it('sair no web limpa o cookie', async () => {
    const login = await entrar({ email: 'ana@exemplo.com', senha: SENHA, plataforma: 'web' })
    const cookie = String(
      Array.isArray(login.headers['set-cookie'])
        ? login.headers['set-cookie'][0]
        : login.headers['set-cookie'],
    ).split(';')[0]

    const saida = await api.app.inject({
      method: 'DELETE',
      url: '/v1/sessoes/atual',
      headers: { cookie: cookie! },
    })

    const limpeza = String(saida.headers['set-cookie'])
    expect(limpeza).toContain('__Host-mavia_sessao=')
    expect(limpeza).toContain('Max-Age=0')
  })

  it('sem sessão é 401, e não um 204 que mente', async () => {
    expect(
      (await api.app.inject({ method: 'DELETE', url: '/v1/sessoes/atual' })).statusCode,
    ).toBe(401)
  })
})
