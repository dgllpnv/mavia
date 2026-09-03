import { hash } from '@node-rs/argon2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, TENANT_B, USUARIO_A } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * Entrada, renovação e saída — `docs/produto/spec-autenticacao.md` §3 e §4.
 *
 * Esta é a porta de todo o resto do produto, e o único lugar onde o tempo de
 * resposta é parte do contrato: uma diferença mensurável entre "endereço não
 * existe" e "senha errada" transforma a rota num oráculo que enumera a base de
 * clientes. Os testes abaixo tratam vazamento por mensagem, por código de
 * status e por forma da resposta.
 *
 * A partir da decisão D6 há **dois** tokens, e a separação entre eles é o que
 * estes testes precisam provar de verdade: o access vale quinze minutos e vive
 * no Redis; o refresh vale semanas, vive no Postgres, é rotacionado a cada uso
 * e **não autentica requisição nenhuma**.
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

const credencial = { email: 'ana@exemplo.com', senha: SENHA }

/** O cookie de refresh emitido na resposta, pronto para voltar num header. */
function cookieDa(resposta: { headers: Record<string, unknown> }): string {
  const bruto = resposta.headers['set-cookie']
  const texto = Array.isArray(bruto) ? (bruto[0] as string) : (bruto as string)
  return texto.split(';')[0] ?? ''
}

describe('POST /v1/sessoes', () => {
  it('credencial correta devolve o access token e os espaços do usuário', async () => {
    const r = await entrar({ ...credencial, plataforma: 'mobile' })

    expect(r.statusCode).toBe(201)
    expect(r.json().acesso).toMatch(/^[0-9a-f]{64}$/)
    expect(r.json().expiraEmSegundos).toBe(900)
    expect(r.json().usuario).toMatchObject({ id: USUARIO_A, nome: 'Ana' })
    expect(r.json().tenants).toEqual([
      expect.objectContaining({ id: TENANT_A, papel: 'proprietario' }),
    ])
  })

  it('o access token emitido abre uma rota protegida', async () => {
    const login = await entrar({ ...credencial, plataforma: 'mobile' })

    const r = await api.app.inject({
      method: 'GET',
      url: '/v1/contas',
      headers: {
        authorization: `Bearer ${login.json().acesso}`,
        'x-mavia-tenant': TENANT_A,
      },
    })

    expect(r.statusCode).toBe(200)
  })

  it('**o refresh não autentica requisição**', async () => {
    // A separação inteira depende disto. Se o refresh servisse como access,
    // teríamos uma credencial de semanas aceita em toda rota — que é o mesmo
    // que não ter expiração.
    const login = await entrar({ ...credencial, plataforma: 'mobile' })

    const r = await api.app.inject({
      method: 'GET',
      url: '/v1/contas',
      headers: {
        authorization: `Bearer ${login.json().refresh}`,
        'x-mavia-tenant': TENANT_A,
      },
    })

    expect(r.statusCode).toBe(401)
  })

  it('o access token não abre o espaço de outro tenant', async () => {
    const login = await entrar({ ...credencial, plataforma: 'mobile' })

    const r = await api.app.inject({
      method: 'GET',
      url: '/v1/contas',
      headers: {
        authorization: `Bearer ${login.json().acesso}`,
        'x-mavia-tenant': TENANT_B,
      },
    })

    expect(r.statusCode).toBe(403)
  })

  it('no web o **refresh** vai em cookie, e nunca no corpo', async () => {
    // Devolvê-lo no corpo tornaria o `HttpOnly` decorativo: bastaria um XSS ler
    // a resposta do próprio login.
    const r = await entrar({ ...credencial, plataforma: 'web' })

    expect(r.json().refresh).toBeUndefined()
    expect(r.json().acesso).toMatch(/^[0-9a-f]{64}$/)

    const cookie = String(r.headers['set-cookie'])
    expect(cookie).toContain('__Host-mavia_rt=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
  })

  it('**o cookie sozinho não autentica**', async () => {
    // Ele carrega o refresh, e refresh não é credencial de requisição.
    const login = await entrar({ ...credencial, plataforma: 'web' })

    const r = await api.app.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { cookie: cookieDa(login) },
    })

    expect(r.statusCode).toBe(401)
  })

  it('senha errada e endereço inexistente respondem igual', async () => {
    const errada = await entrar({ ...credencial, senha: 'outra coisa', plataforma: 'web' })
    const inexistente = await entrar({
      email: 'ninguem@exemplo.com',
      senha: SENHA,
      plataforma: 'web',
    })

    expect(errada.statusCode).toBe(inexistente.statusCode)
    expect(errada.json().message).toBe(inexistente.json().message)
  })
})

describe('POST /v1/sessoes/renovar', () => {
  it('rotaciona: devolve access novo e refresh novo', async () => {
    const login = await entrar({ ...credencial, plataforma: 'mobile' })
    const primeiro = login.json().refresh

    const r = await api.pedir({
      metodo: 'POST',
      url: '/v1/sessoes/renovar',
      corpo: { refresh: primeiro },
    })

    expect(r.statusCode).toBe(200)
    expect(r.json().acesso).toMatch(/^[0-9a-f]{64}$/)
    expect(r.json().refresh).toMatch(/^[0-9a-f]{64}$/)
    expect(r.json().refresh).not.toBe(primeiro)
  })

  it('**o access antigo morre na rotação**', async () => {
    // Sem isto, cada renovação deixaria para trás um access token válido por
    // até quinze minutos — e uma sessão comprometida acumularia credenciais.
    const login = await entrar({ ...credencial, plataforma: 'mobile' })
    const acessoAntigo = login.json().acesso

    await api.pedir({
      metodo: 'POST',
      url: '/v1/sessoes/renovar',
      corpo: { refresh: login.json().refresh },
    })

    const r = await api.app.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { authorization: `Bearer ${acessoAntigo}` },
    })

    expect(r.statusCode).toBe(401)
  })

  it('**reapresentar um refresh já consumido derruba a família inteira**', async () => {
    // Duas cópias do mesmo token no mundo é roubo até prova em contrário, e a
    // prova não existe. A linha antiga fica no banco justamente para ser a
    // armadilha.
    const login = await entrar({ ...credencial, plataforma: 'mobile' })
    const roubado = login.json().refresh

    const legitima = await api.pedir({
      metodo: 'POST',
      url: '/v1/sessoes/renovar',
      corpo: { refresh: roubado },
    })
    const refreshVivo = legitima.json().refresh

    // O ladrão usa a cópia velha.
    const reuso = await api.pedir({
      metodo: 'POST',
      url: '/v1/sessoes/renovar',
      corpo: { refresh: roubado },
    })
    expect(reuso.statusCode).toBe(401)
    expect(reuso.json().message).toContain('duas vezes')

    // E o refresh legítimo, que estava vivo, morre junto: a vítima é
    // desconectada, que é o desfecho certo quando há um ladrão com token.
    const depois = await api.pedir({
      metodo: 'POST',
      url: '/v1/sessoes/renovar',
      corpo: { refresh: refreshVivo },
    })
    expect(depois.statusCode).toBe(401)
  })

  it('refresh desconhecido é 401 seco, e não incidente', async () => {
    const r = await api.pedir({
      metodo: 'POST',
      url: '/v1/sessoes/renovar',
      corpo: { refresh: 'a'.repeat(64) },
    })

    expect(r.statusCode).toBe(401)
    expect(r.json().message).not.toContain('duas vezes')
  })
})

describe('GET /v1/eu', () => {
  it('devolve o usuário e os espaços dele, sem exigir X-Mavia-Tenant', async () => {
    const login = await entrar({ ...credencial, plataforma: 'mobile' })

    const r = await api.app.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { authorization: `Bearer ${login.json().acesso}` },
    })

    expect(r.statusCode).toBe(200)
    expect(r.json().usuario).toMatchObject({ id: USUARIO_A })
  })
})

describe('DELETE /v1/sessoes/atual', () => {
  it('revoga a sessão, e o access deixa de valer no ato', async () => {
    const login = await entrar({ ...credencial, plataforma: 'mobile' })
    const acesso = login.json().acesso

    const saida = await api.app.inject({
      method: 'DELETE',
      url: '/v1/sessoes/atual',
      headers: { authorization: `Bearer ${acesso}` },
    })
    expect(saida.statusCode).toBe(204)

    const r = await api.app.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { authorization: `Bearer ${acesso}` },
    })
    expect(r.statusCode).toBe(401)
  })

  it('**sair no web também mata o refresh**', async () => {
    // Sem isto, sair mataria quinze minutos de access e deixaria semanas de
    // refresh vivas no cookie que o navegador ainda tem.
    const login = await entrar({ ...credencial, plataforma: 'web' })
    const cookie = cookieDa(login)

    await api.app.inject({
      method: 'DELETE',
      url: '/v1/sessoes/atual',
      headers: { authorization: `Bearer ${login.json().acesso}`, cookie },
    })

    const r = await api.app.inject({
      method: 'POST',
      url: '/v1/sessoes/renovar',
      headers: { cookie },
    })
    expect(r.statusCode).toBe(401)
  })

  it('sair no web limpa o cookie', async () => {
    const login = await entrar({ ...credencial, plataforma: 'web' })

    const r = await api.app.inject({
      method: 'DELETE',
      url: '/v1/sessoes/atual',
      headers: { authorization: `Bearer ${login.json().acesso}`, cookie: cookieDa(login) },
    })

    expect(String(r.headers['set-cookie'])).toContain('Max-Age=0')
  })
})

describe('POST /v1/sessoes/revogar-outras', () => {
  it('derruba os outros dispositivos e preserva o atual', async () => {
    const outro = await entrar({ ...credencial, plataforma: 'mobile' })
    const atual = await entrar({ ...credencial, plataforma: 'web' })

    const r = await api.app.inject({
      method: 'POST',
      url: '/v1/sessoes/revogar-outras',
      headers: { authorization: `Bearer ${atual.json().acesso}`, cookie: cookieDa(atual) },
    })

    expect(r.statusCode).toBe(200)
    expect(r.json().revogadas).toBeGreaterThan(0)

    // O outro dispositivo perdeu o access **imediatamente** — é o requisito
    // que dispensou o JWT.
    const doOutro = await api.app.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { authorization: `Bearer ${outro.json().acesso}` },
    })
    expect(doOutro.statusCode).toBe(401)

    // E o atual continua de pé.
    const doAtual = await api.app.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { authorization: `Bearer ${atual.json().acesso}` },
    })
    expect(doAtual.statusCode).toBe(200)
  })
})

describe('limite de tentativas', () => {
  it('**o endereço é bloqueado depois de dez tentativas, e o 429 diz quando volta**', async () => {
    // Um endereço só deste teste: o contador é por endereço, e reaproveitar o
    // da Ana derrubaria os outros casos.
    const alvo = 'alvo-do-limite@exemplo.com'

    let ultima = 0
    for (let i = 0; i < 12; i++) {
      const r = await entrar({ email: alvo, senha: 'errada', plataforma: 'web' })
      ultima = r.statusCode
      if (r.statusCode === 429) {
        expect(r.json().retryAfter).toBeGreaterThan(0)
        break
      }
    }

    expect(ultima).toBe(429)
  })

  it('**muitos logins bem-sucedidos da mesma origem não bloqueiam**', async () => {
    // A janela por origem conta **falhas**, não tentativas. Contar acertos
    // trancaria um escritório inteiro atrás do mesmo NAT — e trancava a própria
    // suíte E2E, que foi como este defeito apareceu: falhas diferentes a cada
    // execução, todas depois da sexagésima entrada bem-sucedida.
    for (let i = 0; i < 25; i++) {
      const r = await entrar({ ...credencial, plataforma: 'web' })
      expect(r.statusCode).toBe(201)
    }
  })

  it('o contador conta também endereço inexistente', async () => {
    // Não contar seria um oráculo de existência com outro nome: o atacante
    // saberia que travou porque a conta existe.
    const fantasma = 'fantasma-do-limite@exemplo.com'

    let bloqueou = false
    for (let i = 0; i < 12; i++) {
      const r = await entrar({ email: fantasma, senha: 'errada', plataforma: 'web' })
      if (r.statusCode === 429) {
        bloqueou = true
        break
      }
    }

    expect(bloqueou).toBe(true)
  })
})
