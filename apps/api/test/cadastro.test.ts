import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { comoApp, subirPostgres, type BancoDeTeste } from './postgres.js'

/**
 * O caminho de cadastro — e a prova de que ele não afrouxa o isolamento.
 *
 * A lacuna que estes testes fecham foi descoberta implementando, não
 * projetando: `mavia_app` não tem `INSERT` em `tenants`, então o cadastro
 * simplesmente não funcionava. A solução da spec de autenticação §6 é dar a ele
 * `EXECUTE` em funções `SECURITY DEFINER` estreitas de um papel próprio, em vez
 * de conceder a tabela.
 *
 * A propriedade que estes testes existem para proteger: **conceder o caminho
 * não é conceder a tabela.**
 */

let banco: BancoDeTeste

beforeAll(async () => {
  banco = await subirPostgres()
})

afterAll(async () => {
  await banco?.encerrar()
})

const hash = (): Buffer => randomBytes(32)
const daquiAUmaHora = (): Date => new Date(Date.now() + 3_600_000)

describe('o privilégio que NÃO foi concedido', () => {
  it('mavia_app continua sem INSERT em tenants, usuarios e tenant_usuarios', async () => {
    const r = await banco.cliente.query<{ t: boolean; u: boolean; tu: boolean }>(
      `SELECT has_table_privilege('mavia_app','tenants','INSERT')          AS t,
              has_table_privilege('mavia_app','usuarios','INSERT')         AS u,
              has_table_privilege('mavia_app','tenant_usuarios','INSERT')  AS tu`,
    )

    expect(r.rows[0]).toEqual({ t: false, u: false, tu: false })
  })

  it('o INSERT direto em tenants é recusado, mesmo com o cadastro funcionando', async () => {
    await expect(
      comoApp(banco.cliente, {}, async () => {
        await banco.cliente.query(`INSERT INTO tenants (nome) VALUES ('Direto')`)
      }),
    ).rejects.toThrow(/permission denied|permissão negada/i)
  })

  it('as funções de cadastro pertencem a mavia_auth, que não tem BYPASSRLS', async () => {
    // Esta é a asserção estrutural que impede a regressão mais perigosa: se as
    // funções ficassem com mavia_migrate, cada SECURITY DEFINER viraria um
    // furo com BYPASSRLS embutido.
    const r = await banco.cliente.query<{ dono: string; bypass: boolean; secdef: boolean }>(
      `SELECT r.rolname AS dono, r.rolbypassrls AS bypass, p.prosecdef AS secdef
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_roles r     ON r.oid = p.proowner
        WHERE n.nspname = 'auth'`,
    )

    // Sem número cravado: o que importa é que *toda* função do esquema `auth`
    // obedeça à regra, e não que existam exatamente N delas. Cravar o número
    // faria uma função nova quebrar o teste pelo motivo errado.
    expect(r.rows.length).toBeGreaterThanOrEqual(9)
    for (const f of r.rows) {
      expect(f.dono).toBe('mavia_auth')
      expect(f.bypass).toBe(false)
      expect(f.secdef).toBe(true)
    }
  })
})

describe('cadastro por e-mail e senha', () => {
  it('registrar pendente não cria usuário nem tenant', async () => {
    // A camada 1 do teto de taxa é estrutural: `tenants` só ganha linha depois
    // do e-mail provado. Cadastro não confirmado não existe no sistema.
    const token = hash()

    const aceito = await comoApp(banco.cliente, {}, async () => {
      const r = await banco.cliente.query<{ registrar_pendente: boolean }>(
        'SELECT auth.registrar_pendente($1, $2, $3, $4, $5) AS registrar_pendente',
        ['pendente@exemplo.com', 'Pendente', '$argon2id$fake', token, daquiAUmaHora()],
      )
      return r.rows[0]?.registrar_pendente
    })

    expect(aceito).toBe(true)

    const contagens = await banco.cliente.query<{ usuarios: string; tenants: string }>(
      `SELECT (SELECT count(*) FROM usuarios WHERE lower(email) = 'pendente@exemplo.com') AS usuarios,
              (SELECT count(*) FROM tenants) AS tenants`,
    )
    expect(Number(contagens.rows[0]?.usuarios)).toBe(0)
    expect(Number(contagens.rows[0]?.tenants)).toBe(0)
  })

  it('confirmar o cadastro cria usuário, tenant e o vínculo de proprietário', async () => {
    const token = hash()

    await comoApp(banco.cliente, {}, async () => {
      await banco.cliente.query('SELECT auth.registrar_pendente($1, $2, $3, $4, $5)', [
        'ana@exemplo.com',
        'Ana',
        '$argon2id$fake',
        token,
        daquiAUmaHora(),
      ])
    })

    const criado = await comoApp(banco.cliente, {}, async () => {
      const r = await banco.cliente.query<{ usuario_id: string; tenant_id: string }>(
        'SELECT * FROM auth.confirmar_cadastro($1, $2)',
        [token, 'Finanças da Ana'],
      )
      return r.rows[0]
    })

    expect(criado?.usuario_id).toBeTruthy()
    expect(criado?.tenant_id).toBeTruthy()

    const vinculo = await banco.cliente.query<{ papel: string; verificado: Date | null }>(
      `SELECT tu.papel, u.email_verificado_em AS verificado
         FROM tenant_usuarios tu
         JOIN usuarios u ON u.id = tu.usuario_id
        WHERE tu.usuario_id = $1 AND tu.tenant_id = $2`,
      [criado?.usuario_id, criado?.tenant_id],
    )

    expect(vinculo.rows[0]?.papel).toBe('proprietario')
    // Toda linha em `usuarios` nasce com o e-mail já provado — é o que torna a
    // camada 1 do teto de taxa estrutural em vez de uma checagem esquecível.
    expect(vinculo.rows[0]?.verificado).not.toBeNull()
  })

  it('o mesmo token não confirma duas vezes', async () => {
    const token = hash()

    await comoApp(banco.cliente, {}, async () => {
      await banco.cliente.query('SELECT auth.registrar_pendente($1, $2, $3, $4, $5)', [
        'bis@exemplo.com',
        'Bis',
        '$argon2id$fake',
        token,
        daquiAUmaHora(),
      ])
      await banco.cliente.query('SELECT * FROM auth.confirmar_cadastro($1, $2)', [token, 'Bis'])
    })

    // A função sinaliza por exceção, não devolvendo vazio — e é o certo:
    // "confirmei nada" e "confirmei" não podem ter a mesma forma de resposta.
    await expect(
      comoApp(banco.cliente, {}, async () => {
        await banco.cliente.query('SELECT * FROM auth.confirmar_cadastro($1, $2)', [
          token,
          'Bis de novo',
        ])
      }),
    ).rejects.toThrow(/CADASTRO_INVALIDO/)
  })

  it('token expirado não confirma nada', async () => {
    const token = hash()
    const ontem = new Date(Date.now() - 86_400_000)

    await comoApp(banco.cliente, {}, async () => {
      await banco.cliente.query('SELECT auth.registrar_pendente($1, $2, $3, $4, $5)', [
        'tarde@exemplo.com',
        'Tarde',
        '$argon2id$fake',
        token,
        ontem,
      ])
    })

    await expect(
      comoApp(banco.cliente, {}, async () => {
        await banco.cliente.query('SELECT * FROM auth.confirmar_cadastro($1, $2)', [token, 'Tarde'])
      }),
    ).rejects.toThrow(/CADASTRO_INVALIDO/)
  })

  it('token desconhecido não confirma nada', async () => {
    await expect(
      comoApp(banco.cliente, {}, async () => {
        await banco.cliente.query('SELECT * FROM auth.confirmar_cadastro($1, $2)', [
          hash(),
          'Ninguém',
        ])
      }),
    ).rejects.toThrow(/CADASTRO_INVALIDO/)
  })
})

describe('cadastro por Google', () => {
  it('cria usuário, tenant e a identidade federada', async () => {
    const criado = await comoApp(banco.cliente, {}, async () => {
      const r = await banco.cliente.query<{ usuario_id: string; tenant_id: string }>(
        'SELECT * FROM auth.cadastrar_federado($1, $2, $3, $4, $5)',
        [
          'https://accounts.google.com',
          'sub-do-carlos-123',
          'carlos@exemplo.com',
          'Carlos',
          'Finanças do Carlos',
        ],
      )
      return r.rows[0]
    })

    expect(criado?.usuario_id).toBeTruthy()

    const identidade = await banco.cliente.query<{ subject: string; provedor: string }>(
      'SELECT subject, provedor::text FROM identidades_federadas WHERE usuario_id = $1',
      [criado?.usuario_id],
    )
    expect(identidade.rows[0]).toEqual({ subject: 'sub-do-carlos-123', provedor: 'google' })
  })

  it('resolver identidade devolve vazio para subject desconhecido, e não erro', async () => {
    // "não achei" é resposta, não ausência de resposta. Obrigar o chamador a
    // distinguir linha ausente de campo nulo é onde nasce o `if` esquecido.
    const r = await comoApp(banco.cliente, {}, async () => {
      const q = await banco.cliente.query<{ usuario_id: string | null }>(
        'SELECT * FROM auth.resolver_identidade_federada($1, $2, $3)',
        ['https://accounts.google.com', 'sub-que-nao-existe', 'x@exemplo.com'],
      )
      return q.rows[0]
    })

    expect(r?.usuario_id).toBeNull()
  })

  it('entrar de novo com a mesma Conta Google é login, não cadastro', async () => {
    const cadastrado = await comoApp(banco.cliente, {}, async () => {
      const q = await banco.cliente.query<{ usuario_id: string }>(
        'SELECT * FROM auth.cadastrar_federado($1, $2, $3, $4, $5)',
        ['https://accounts.google.com', 'sub-repetido', 'rep@exemplo.com', 'Rep', 'Espaço'],
      )
      return q.rows[0]?.usuario_id
    })

    // Na segunda entrada, a aplicação resolve antes de cadastrar.
    const resolvido = await comoApp(banco.cliente, {}, async () => {
      const q = await banco.cliente.query<{ usuario_id: string }>(
        'SELECT * FROM auth.resolver_identidade_federada($1, $2, $3)',
        ['https://accounts.google.com', 'sub-repetido', 'rep@exemplo.com'],
      )
      return q.rows[0]?.usuario_id
    })

    expect(resolvido).toBe(cadastrado)

    const quantos = await banco.cliente.query<{ n: string }>(
      `SELECT count(*) AS n FROM usuarios WHERE lower(email) = 'rep@exemplo.com'`,
    )
    expect(Number(quantos.rows[0]?.n)).toBe(1)
  })

  it('detecta reatribuição de endereço: e-mail conhecido com subject novo', async () => {
    // Caso C5 da spec §1.6. O e-mail corporativo foi para outra pessoa; o
    // subject é novo. A função entrega o fato, e o domínio recusa.
    const r = await comoApp(banco.cliente, {}, async () => {
      const q = await banco.cliente.query<{
        usuario_id: string | null
        email_de_outro_subject: boolean
      }>('SELECT * FROM auth.resolver_identidade_federada($1, $2, $3)', [
        'https://accounts.google.com',
        'sub-do-sucessor',
        'rep@exemplo.com',
      ])
      return q.rows[0]
    })

    expect(r?.usuario_id).toBeNull()
    expect(r?.email_de_outro_subject).toBe(true)
  })

  it('registrar login atualiza o carimbo sem criar nada', async () => {
    const antes = await banco.cliente.query<{ n: string }>('SELECT count(*) AS n FROM usuarios')

    const ok = await comoApp(banco.cliente, {}, async () => {
      const q = await banco.cliente.query<{ registrar_login_federado: boolean }>(
        'SELECT auth.registrar_login_federado($1, $2, $3) AS registrar_login_federado',
        ['https://accounts.google.com', 'sub-repetido', 'rep-novo@exemplo.com'],
      )
      return q.rows[0]?.registrar_login_federado
    })

    const depois = await banco.cliente.query<{ n: string }>('SELECT count(*) AS n FROM usuarios')

    expect(ok).toBe(true)
    expect(depois.rows[0]?.n).toBe(antes.rows[0]?.n)
  })
})

describe('buscar credencial', () => {
  it('não devolve linha para e-mail desconhecido', async () => {
    const r = await comoApp(banco.cliente, {}, async () => {
      const q = await banco.cliente.query('SELECT * FROM auth.buscar_credencial($1)', [
        'ninguem@exemplo.com',
      ])
      return q.rowCount
    })

    expect(r).toBe(0)
  })

  it('conta criada só pelo Google não tem senha para conferir', async () => {
    // É isto que fecha a porta dos fundos da recuperação: sem senha, não há
    // token de recuperação a emitir, e a posse do e-mail não vira acesso.
    const r = await comoApp(banco.cliente, {}, async () => {
      const q = await banco.cliente.query<{ senha_hash: string | null; tem_identidade: boolean }>(
        'SELECT * FROM auth.buscar_credencial($1)',
        ['carlos@exemplo.com'],
      )
      return q.rows[0]
    })

    expect(r?.senha_hash).toBeNull()
    expect(r?.tem_identidade).toBe(true)
  })
})
