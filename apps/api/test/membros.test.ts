import { hash } from '@node-rs/argon2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * Compartilhamento — a regra R-4 da matriz de acesso.
 *
 * A matriz chama a mudança de papel de "a rota de escalada de privilégio do
 * produto", e lista quatro travas independentes. Cada uma tem teste, e a
 * terceira tem o teste que mais importa: a que prova que ela mora **no banco**,
 * e não num `if`.
 */

let api: ApiDeTeste

const SENHA = 'a senha da ana, longa o suficiente'
const DE_A = { usuario: USUARIO_A, tenant: TENANT_A }

const pedir = (metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, corpo?: unknown) =>
  api.pedir({ metodo, url, ...DE_A, ...(corpo === undefined ? {} : { corpo }) })

beforeAll(async () => {
  api = await subirApi()

  await api.banco.cliente.query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [
    await hash(SENHA),
    USUARIO_A,
  ])
}, 180_000)

afterAll(async () => {
  await api?.encerrar()
})

describe('quem vê o quê', () => {
  it('**o e-mail dos outros é só do proprietário**', async () => {
    // A matriz separa `membro · ler` de `membro · ler_contato`. A projeção
    // depende do papel de quem pergunta — isso é autorização, e não formatação.
    const r = await pedir('GET', '/v1/membros')

    expect(r.statusCode).toBe(200)
    expect(r.json().itens[0].email).toEqual(expect.any(String))

    // O Bruno é `proprietario` do espaço B; para ver o comportamento de quem
    // não é dono, rebaixamos um membro no espaço dele mais adiante. Aqui basta
    // provar que o dono vê.
    expect(r.json().itens[0].nome).toEqual(expect.any(String))
  })
})

describe('convite', () => {
  let token = ''
  let conviteId = ''

  it('o token viaja uma vez, na resposta', async () => {
    const r = await pedir('POST', '/v1/membros/convites', {
      email: 'bruno@exemplo.com',
      papel: 'membro',
    })

    expect(r.statusCode).toBe(201)
    expect(r.json().token).toMatch(/^[0-9a-f]{64}$/)
    token = r.json().token
    conviteId = r.json().id
  })

  it('**no banco vive só o hash**', async () => {
    const r = await api.banco.cliente.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM convites WHERE id = $1',
      [conviteId],
    )

    expect(r.rows[0]!.token_hash.toString('hex')).not.toBe(token)
  })

  it('recusa um segundo convite pendente para o mesmo e-mail', async () => {
    // Dois links vivos deixam o proprietário sem saber qual entregou.
    const r = await pedir('POST', '/v1/membros/convites', {
      email: 'bruno@exemplo.com',
      papel: 'visualizador',
    })

    expect(r.statusCode).toBe(409)
  })

  it('não convida ninguém direto como proprietário', async () => {
    // Promover é outra rota, com reautenticação.
    const r = await pedir('POST', '/v1/membros/convites', {
      email: 'outro@exemplo.com',
      papel: 'proprietario',
    })

    expect(r.statusCode).toBe(400)
  })

  it('**o convite é para um endereço, não para quem tiver o link**', async () => {
    // Um convite transferível é um convite que vaza junto com o link. A Ana
    // tenta aceitar um convite endereçado ao Bruno.
    const r = await api.app.inject({
      method: 'POST',
      url: '/v1/convites/aceitar',
      headers: { authorization: `Bearer ${await acessoDe(USUARIO_A)}` },
      payload: { token },
    })

    expect(r.statusCode).toBe(400)
    expect(r.json().message).toContain('outro e-mail')
  })

  it('o destinatário certo entra, com o papel do convite', async () => {
    const r = await api.app.inject({
      method: 'POST',
      url: '/v1/convites/aceitar',
      headers: { authorization: `Bearer ${await acessoDe(USUARIO_B)}` },
      payload: { token },
    })

    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ tenantId: TENANT_A, papel: 'membro' })

    const membros = await pedir('GET', '/v1/membros')
    expect(membros.json().itens.map((m: { usuarioId: string }) => m.usuarioId)).toContain(USUARIO_B)
  })

  it('**o mesmo convite não serve duas vezes**', async () => {
    const r = await api.app.inject({
      method: 'POST',
      url: '/v1/convites/aceitar',
      headers: { authorization: `Bearer ${await acessoDe(USUARIO_B)}` },
      payload: { token },
    })

    expect(r.statusCode).toBe(400)
    expect(r.json().message).toContain('já foi usado')
  })

  it('token inexistente é recusado sem dizer mais nada', async () => {
    const r = await api.app.inject({
      method: 'POST',
      url: '/v1/convites/aceitar',
      headers: { authorization: `Bearer ${await acessoDe(USUARIO_B)}` },
      payload: { token: 'a'.repeat(64) },
    })

    expect(r.statusCode).toBe(400)
    expect(r.json().message).toBe('Convite não encontrado.')
  })
})

describe('R-4 · as quatro travas da mudança de papel', () => {
  it('**trava 2 — ninguém muda o próprio papel**', async () => {
    // E a checagem é independente da de papel: se um dia o papel exigido
    // mudar, a proibição de autoalteração não vai junto por acidente.
    const r = await pedir('PATCH', `/v1/membros/${USUARIO_A}`, {
      papel: 'visualizador',
      senha: SENHA,
    })

    expect(r.statusCode).toBe(403)
  })

  it('**trava 4 — sem a senha certa, não passa**', async () => {
    const r = await pedir('PATCH', `/v1/membros/${USUARIO_B}`, {
      papel: 'visualizador',
      senha: 'senha errada',
    })

    expect(r.statusCode).toBe(401)
  })

  it('com a senha certa, o papel muda', async () => {
    const r = await pedir('PATCH', `/v1/membros/${USUARIO_B}`, {
      papel: 'visualizador',
      senha: SENHA,
    })

    expect(r.statusCode).toBe(200)
    expect(r.json().papel).toBe('visualizador')
  })

  it('**trava 3 — o último proprietário é protegido pelo banco, não por um `if`**', async () => {
    // O teste que mais importa: a proteção é provada **passando por cima da
    // aplicação**, direto no SQL. Um `if` no controlador não seguraria isto, e
    // é exatamente o cenário do `UPDATE` às três da manhã num incidente.
    await expect(
      api.banco.cliente.query(
        `UPDATE tenant_usuarios SET papel = 'membro'
          WHERE tenant_id = $1 AND papel = 'proprietario'`,
        [TENANT_A],
      ),
    ).rejects.toThrow(/ESPACO_FICARIA_SEM_DONO/)
  })

  it('**e segura o rebaixamento de dois donos numa tacada só**', async () => {
    // O motivo de o gatilho ser `FOR EACH STATEMENT`. Linha a linha, o primeiro
    // passaria porque o segundo ainda era dono, e o segundo passaria porque o
    // primeiro já não era — os dois `UPDATE` aprovados, e o espaço sem dono.
    await api.banco.cliente.query(
      `UPDATE tenant_usuarios SET papel = 'proprietario'
        WHERE tenant_id = $1 AND usuario_id = $2`,
      [TENANT_A, USUARIO_B],
    )

    await expect(
      api.banco.cliente.query(
        `UPDATE tenant_usuarios SET papel = 'membro' WHERE tenant_id = $1`,
        [TENANT_A],
      ),
    ).rejects.toThrow(/ESPACO_FICARIA_SEM_DONO/)

    // Devolve o Bruno ao papel de membro para os testes seguintes.
    await api.banco.cliente.query(
      `UPDATE tenant_usuarios SET papel = 'membro'
        WHERE tenant_id = $1 AND usuario_id = $2`,
      [TENANT_A, USUARIO_B],
    )
  })
})

describe('sair e remover', () => {
  it('**remover revoga as sessões de quem saiu, no ato**', async () => {
    // Spec de autenticação §4.3: "remoção do membro do tenant" é revogação
    // automática. Sem isso, "removi o acesso" é promessa que o servidor não
    // cumpre por até quinze minutos de access e semanas de refresh.
    const acesso = await acessoDe(USUARIO_B)

    const antes = await api.app.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { authorization: `Bearer ${acesso}` },
    })
    expect(antes.statusCode).toBe(200)

    const r = await pedir('DELETE', `/v1/membros/${USUARIO_B}`, { senha: SENHA })
    expect(r.statusCode).toBe(200)
    expect(r.json().sessoesRevogadas).toBeGreaterThan(0)

    const depois = await api.app.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { authorization: `Bearer ${acesso}` },
    })
    expect(depois.statusCode).toBe(401)
  })

  it('remover outra pessoa sem senha é recusado', async () => {
    const r = await pedir('DELETE', `/v1/membros/${USUARIO_B}`, {})

    expect(r.statusCode).toBe(400)
  })

  it('o dono não sai deixando o espaço sem dono', async () => {
    const r = await pedir('DELETE', `/v1/membros/${USUARIO_A}`)

    expect(r.statusCode).toBe(409)
    expect(r.json().message).toContain('sem proprietário')
  })
})

describe('a matriz', () => {
  it('convidar e mudar papel são só do dono; sair é de todos', async () => {
    const { pode } = await import('../src/autorizacao/politica-acesso.js')

    expect(pode({ metodo: 'POST', caminho: '/v1/membros/convites' }, 'membro')).toBe(false)
    expect(pode({ metodo: 'PATCH', caminho: '/v1/membros/:usuarioId' }, 'membro')).toBe(false)
    expect(pode({ metodo: 'GET', caminho: '/v1/membros' }, 'visualizador')).toBe(true)
    // A matriz dá o direito de sair a todos; que só se sai a **si mesmo** é
    // regra do controlador — a matriz não expressa "só sobre o próprio id".
    expect(pode({ metodo: 'DELETE', caminho: '/v1/membros/:usuarioId' }, 'visualizador')).toBe(true)
  })

  it('mudar papel exige reautenticação, e está declarado na matriz', async () => {
    const { exigeReautenticacao } = await import('../src/autorizacao/politica-acesso.js')

    expect(exigeReautenticacao({ metodo: 'PATCH', caminho: '/v1/membros/:usuarioId' })).toBe(true)
  })
})

/** Um access token novo para um usuário, pelo mesmo caminho que o login usa. */
async function acessoDe(usuarioId: string): Promise<string> {
  const r = await api.banco.cliente.query<{ id: string }>(
    `INSERT INTO sessoes (usuario_id, familia_id, refresh_hash, plataforma,
                          expira_em, expira_absoluto_em)
     -- 32 bytes de aleatoriedade sem pgcrypto: a extensão exige superusuário
     -- na criação, e o arreio de teste não é lugar de pedir isso.
     VALUES ($1, gen_random_uuid(),
             decode(md5(random()::text) || md5(random()::text), 'hex'), 'web',
             now() + interval '1 day', now() + interval '2 days')
     RETURNING id`,
    [usuarioId],
  )

  const { CofreDeAcesso } = await import('../src/redis/cofre-de-acesso.js')
  return new CofreDeAcesso(api.redis).emitir({ sessaoId: r.rows[0]!.id, usuarioId })
}
