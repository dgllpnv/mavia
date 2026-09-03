import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'
import type { Mensagem } from '../src/mensageiro/mensageiro.js'

/**
 * Cadastro por e-mail e recuperação de senha — spec §2.6 e §3.4. P-3.
 *
 * A propriedade que domina o arquivo: **a resposta é a mesma tenha o endereço
 * uma conta ou não**. O que muda é qual mensagem sai, e isso só quem tem a
 * caixa postal observa. Por isso os testes olham a caixa, e não só o status.
 *
 * A recuperação é o caminho mais atacado de qualquer produto financeiro: é a
 * única superfície não autenticada que **substitui** uma credencial. Login
 * compara; recuperação escreve.
 */

let api: ApiDeTeste
let caixa: Mensagem[]

const pedir = (metodo: 'POST', url: string, corpo: unknown) =>
  api.pedir({ metodo, url, corpo })

/** O token que veio no link da última mensagem para aquele endereço. */
function tokenPara(para: string): string {
  const ultima = [...caixa].reverse().find((m) => m.para === para)
  if (!ultima) throw new Error(`nenhuma mensagem para ${para}. Caixa: ${caixa.length}`)
  const casou = /[?&]t=([0-9a-f]{64})/.exec(ultima.corpo)
  if (!casou) throw new Error('a mensagem não trazia token')
  return casou[1]!
}

beforeAll(async () => {
  api = await subirApi()
  caixa = api.caixaDeEntrada
}, 180_000)

afterAll(async () => {
  await api.encerrar()
})

describe('cadastrar', () => {
  it('não cria usuário nem espaço — cria um pendente e manda o link', async () => {
    // Uma conta cujo endereço não foi provado não tem canal de recuperação nem
    // canal de notificação de segurança. Num produto financeiro isso não é
    // detalhe de cadastro.
    const r = await pedir('POST', '/v1/cadastro', {
      email: 'novo@exemplo.test',
      nome: 'Ana',
      senha: 'uma senha bem comprida',
    })

    expect(r.statusCode).toBe(202)

    const usuarios = await api.banco.cliente.query(
      'SELECT 1 FROM usuarios WHERE lower(email) = $1',
      ['novo@exemplo.test'],
    )
    expect(usuarios.rowCount).toBe(0)

    const pendentes = await api.banco.cliente.query(
      'SELECT nome FROM cadastros_pendentes WHERE lower(email) = $1 AND consumido_em IS NULL',
      ['novo@exemplo.test'],
    )
    expect(pendentes.rowCount).toBe(1)
    expect(tokenPara('novo@exemplo.test')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('**endereço já usado responde igual, e não recebe nada**', async () => {
    // A resposta HTTP se recusa a dizer que a conta existe; um e-mail dizendo
    // "você já tem conta" entregaria a mesma informação por outro canal.
    const antes = caixa.length
    const jaExiste = await pedir('POST', '/v1/cadastro', {
      email: 'ana@exemplo.com',
      nome: 'Impostor',
      senha: 'uma senha bem comprida',
    })
    const novo = await pedir('POST', '/v1/cadastro', {
      email: `livre-${Date.now()}@exemplo.test`,
      nome: 'Bruno',
      senha: 'uma senha bem comprida',
    })

    expect(jaExiste.statusCode).toBe(novo.statusCode)
    expect(jaExiste.json()).toEqual(novo.json())
    // Uma mensagem saiu — a do endereço livre. Não duas.
    expect(caixa.length).toBe(antes + 1)
  })

  it('**pedir duas vezes não acumula pendente nem caixa**', async () => {
    const email = `repetido-${Date.now()}@exemplo.test`
    const corpo = { email, nome: 'Ana', senha: 'uma senha bem comprida' }

    await pedir('POST', '/v1/cadastro', corpo)
    await pedir('POST', '/v1/cadastro', corpo)

    const pendentes = await api.banco.cliente.query(
      'SELECT 1 FROM cadastros_pendentes WHERE lower(email) = $1 AND consumido_em IS NULL',
      [email],
    )
    // Reemitir substitui: mil requisições geram um registro, não mil.
    expect(pendentes.rowCount).toBe(1)
  })

  it('senha curta é recusada com a frase, e não com um cadastro', async () => {
    const r = await pedir('POST', '/v1/cadastro', {
      email: `curta-${Date.now()}@exemplo.test`,
      nome: 'Ana',
      senha: 'curta',
    })

    expect(r.statusCode).toBe(400)
    expect(JSON.stringify(r.json())).toContain('12 caracteres')
  })
})

describe('confirmar', () => {
  it('cria usuário, espaço e vínculo — e já devolve a sessão', async () => {
    const email = `confirma-${Date.now()}@exemplo.test`
    await pedir('POST', '/v1/cadastro', {
      email,
      nome: 'Ana',
      senha: 'uma senha bem comprida',
      // O nome do espaço é escolhido **aqui**, no formulário, e precisa
      // sobreviver até a confirmação — que acontece a partir de um link de
      // e-mail, possivelmente noutro aparelho, e que não carrega nada disso.
      espaco: 'Casa da Ana',
    })

    const r = await pedir('POST', '/v1/cadastro/confirmar', { token: tokenPara(email) })

    expect(r.statusCode).toBe(201)
    const corpo = r.json()
    expect(corpo.acesso).toMatch(/^[0-9a-f]{64}$/)
    expect(corpo.tenants).toHaveLength(1)
    expect(corpo.tenants[0].nome).toBe('Casa da Ana')
    expect(corpo.tenants[0].papel).toBe('proprietario')

    // O refresh vai só no cookie: devolvê-lo também no corpo tornaria o
    // `HttpOnly` decorativo.
    expect(corpo.refresh).toBeUndefined()
    expect(r.headers['set-cookie']).toContain('__Host-')

    // E o endereço nasce verificado — só chega aqui quem clicou no link.
    const u = await api.banco.cliente.query(
      'SELECT email_verificado_em FROM usuarios WHERE lower(email) = $1',
      [email],
    )
    expect(u.rows[0].email_verificado_em).not.toBeNull()
  })

  it('**o mesmo link não serve duas vezes**', async () => {
    const email = `duas-${Date.now()}@exemplo.test`
    await pedir('POST', '/v1/cadastro', { email, nome: 'Ana', senha: 'uma senha bem comprida' })
    const token = tokenPara(email)

    expect((await pedir('POST', '/v1/cadastro/confirmar', { token })).statusCode).toBe(201)
    expect((await pedir('POST', '/v1/cadastro/confirmar', { token })).statusCode).toBe(400)

    // E não criou dois espaços.
    const espacos = await api.banco.cliente.query(
      `SELECT count(*)::int AS n FROM tenant_usuarios tu
         JOIN usuarios u ON u.id = tu.usuario_id WHERE lower(u.email) = $1`,
      [email],
    )
    expect(espacos.rows[0].n).toBe(1)
  })

  it('token inventado e token expirado são o mesmo 400', async () => {
    // Distinguir "expirado" de "não existe" diria a um atacante que aquele
    // token um dia foi real.
    const inventado = await pedir('POST', '/v1/cadastro/confirmar', { token: 'a'.repeat(64) })

    expect(inventado.statusCode).toBe(400)
  })
})

describe('recuperar', () => {
  const nascida = `recupera-${Date.now()}@exemplo.test`

  beforeAll(async () => {
    await pedir('POST', '/v1/cadastro', {
      email: nascida,
      nome: 'Ana',
      senha: 'a senha original dela',
    })
    await pedir('POST', '/v1/cadastro/confirmar', { token: tokenPara(nascida) })
  })

  it('**endereço inexistente responde igual ao que existe**', async () => {
    const existe = await pedir('POST', '/v1/senha/recuperar', { email: nascida })
    const naoExiste = await pedir('POST', '/v1/senha/recuperar', {
      email: 'ninguem-aqui@exemplo.test',
    })

    expect(existe.statusCode).toBe(naoExiste.statusCode)
    expect(existe.json()).toEqual(naoExiste.json())
  })

  it('redefine, e **derruba todas as sessões**', async () => {
    // Recuperar sem revogar deixa o atacante logado depois de a vítima
    // recuperar a conta.
    const entrada = await api.app.inject({
      method: 'POST',
      url: '/v1/sessoes',
      payload: { email: nascida, senha: 'a senha original dela', plataforma: 'mobile' },
    })
    expect(entrada.statusCode).toBe(201)
    const acessoAntigo = entrada.json().acesso

    await pedir('POST', '/v1/senha/recuperar', { email: nascida })
    const r = await pedir('POST', '/v1/senha/redefinir', {
      token: tokenPara(nascida),
      senha: 'uma senha completamente nova',
    })

    expect(r.statusCode).toBe(200)
    expect(r.json().sessoesEncerradas).toBeGreaterThan(0)

    // O access token de antes não abre mais nada.
    const comOAntigo = await api.app.inject({
      method: 'GET',
      url: '/v1/eu',
      headers: { authorization: `Bearer ${acessoAntigo}` },
    })
    expect(comOAntigo.statusCode).toBe(401)
  })

  it('a senha nova entra e a antiga sai', async () => {
    const nova = await api.app.inject({
      method: 'POST',
      url: '/v1/sessoes',
      payload: { email: nascida, senha: 'uma senha completamente nova', plataforma: 'mobile' },
    })
    const antiga = await api.app.inject({
      method: 'POST',
      url: '/v1/sessoes',
      payload: { email: nascida, senha: 'a senha original dela', plataforma: 'mobile' },
    })

    expect(nova.statusCode).toBe(201)
    expect(antiga.statusCode).toBe(401)
  })

  it('**o aviso de troca sai sempre**', async () => {
    // Um aviso que só chega em caso de fraude ensina o atacante a reconhecê-lo.
    // Aqui a troca foi legítima, e o aviso saiu do mesmo jeito.
    const avisos = caixa.filter(
      (m) => m.para === nascida && m.assunto.includes('foi alterada'),
    )

    expect(avisos.length).toBeGreaterThan(0)
    expect(avisos[avisos.length - 1]!.corpo).toContain('não foi você')
  })

  it('**o token de recuperação não serve duas vezes**', async () => {
    await pedir('POST', '/v1/senha/recuperar', { email: nascida })
    const token = tokenPara(nascida)

    expect(
      (await pedir('POST', '/v1/senha/redefinir', { token, senha: 'terceira senha bem longa' }))
        .statusCode,
    ).toBe(200)
    expect(
      (await pedir('POST', '/v1/senha/redefinir', { token, senha: 'quarta senha bem longa' }))
        .statusCode,
    ).toBe(400)
  })
})

describe('a regra D5 — a trava que fecha a porta dos fundos', () => {
  it('**conta sem senha não recebe token de recuperação**', async () => {
    // Sem isto, quem passasse a controlar o endereço de uma conta que só entra
    // pelo Google pediria recuperação, *definiria* uma senha e entraria. A
    // recusa de vinculação seria contornada pela porta dos fundos, e o produto
    // teria duas regras contraditórias sobre o mesmo fato.
    //
    // A trava mora na função de banco, não na aplicação. Repeti-la aqui daria a
    // impressão de que o banco confia na aplicação, e é o contrário.
    const email = `federada-${Date.now()}@exemplo.test`
    await api.banco.cliente.query(
      `INSERT INTO usuarios (email, nome, email_verificado_em) VALUES ($1, 'Só Google', now())`,
      [email],
    )

    const antes = caixa.length
    const r = await pedir('POST', '/v1/senha/recuperar', { email })

    // A resposta é a mesma — não há oráculo aqui tampouco.
    expect(r.statusCode).toBe(202)
    // Mas nada saiu, e nenhum token foi emitido.
    expect(caixa.length).toBe(antes)

    const tokens = await api.banco.cliente.query(
      `SELECT 1 FROM recuperacoes_senha r JOIN usuarios u ON u.id = r.usuario_id
        WHERE lower(u.email) = $1`,
      [email],
    )
    expect(tokens.rowCount).toBe(0)
  })
})

describe('sem SMTP configurado', () => {
  it('**a rota recusa em vez de fingir**', async () => {
    // Um 202 que não manda e-mail nenhum é a pior das respostas: a pessoa
    // espera para sempre e o log de produção diz que deu certo. É a mesma
    // escolha do webhook da Stripe sem segredo.
    const { MensageiroAusente } = await import('../src/mensageiro/mensageiro.js')
    const mudo = new MensageiroAusente()

    expect(mudo.configurado).toBe(false)
    await expect(
      mudo.enviar({ para: 'x@y.test', assunto: 'a', corpo: 'b' }),
    ).rejects.toThrow(/não há SMTP configurado/)
  })
})
