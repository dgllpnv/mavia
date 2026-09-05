import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { TENANT_A, TENANT_B, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * Preço-base e desconto pelo painel — **ADR 0025**, com a D3 emendada.
 *
 * ## A emenda que define este arquivo
 *
 * A ADR original exigia `stripe_price_id NOT NULL` e `stripe_coupon_id NOT
 * NULL`, para que a ausência da Stripe se manifestasse como impossibilidade de
 * criar a linha. O dono perguntou se a função precisava mesmo da Stripe. **Não
 * precisava.**
 *
 * A invariante é *nenhum cliente é cobrado um valor diferente do que a gente
 * mostra*, e ela só equivale a "toda linha tem um `Price`" quando a Stripe é
 * quem cobra. Hoje não há cliente de saída, não há tabela `cobrancas`, e
 * nenhuma assinatura tem `stripe_subscription_id`. Ninguém é cobrado nada — a
 * nossa tabela é a **única** verdade sobre o preço.
 *
 * Por isso os testes abaixo criam preço e desconto **sem Stripe nenhuma**, e é
 * o comportamento correto. A trava contra cobrar errado vive na abertura da
 * assinatura, no épico 11.
 */

let api: ApiDeTeste

const HIPOTESE = { 'x-mavia-motivo': 'chamado', 'x-mavia-referencia': 'CH-9001' }

const comoOperador = (
  metodo: 'GET' | 'POST' | 'DELETE',
  url: string,
  corpo?: unknown,
) =>
  api.pedir({
    metodo,
    url,
    usuario: USUARIO_A,
    cabecalhos: HIPOTESE,
    ...(corpo === undefined ? {} : { corpo }),
  })

const criarPreco = (corpo: Record<string, unknown> = {}) =>
  comoOperador('POST', '/v1/admin/precos', {
    plano: 'pessoal',
    intervalo: 'mensal',
    centavos: '3900',
    motivo: 'reajuste anual combinado com o dono',
    ...corpo,
  })

const conceder = (tenant = TENANT_A, corpo: Record<string, unknown> = {}) =>
  comoOperador('POST', `/v1/admin/clientes/${tenant}/descontos`, {
    especie: 'percentual',
    pontosBase: 1500,
    duracao: 'sempre',
    motivo: 'indisponibilidade de tres dias em agosto',
    ...corpo,
  })

beforeAll(async () => {
  api = await subirApi()
  await api.banco.cliente.query('SELECT admin.conceder($1, $2)', [USUARIO_A, USUARIO_A])
  for (const t of [TENANT_A, TENANT_B]) {
    await api.banco.cliente.query(
      `INSERT INTO assinaturas (tenant_id, estado, plano, intervalo, periodo_inicio, periodo_fim)
       VALUES ($1, 'ativa', 'pessoal', 'mensal', now() - interval '5 days', now() + interval '25 days')
       ON CONFLICT (tenant_id) DO UPDATE SET estado = 'ativa', plano = 'pessoal'`,
      [t],
    )
  }
}, 180_000)

afterAll(async () => {
  await api.encerrar()
})

beforeEach(async () => {
  await api.banco.cliente.query('DELETE FROM precos_vigentes')
  await api.banco.cliente.query('DELETE FROM descontos_de_cliente')
})

describe('o preço-base', () => {
  it('**cria sem Stripe nenhuma — a D3 emendada**', async () => {
    const r = await criarPreco()

    expect(r.statusCode).toBe(201)
    expect(r.json().valorAnterior).toBeNull()

    const linhas = await api.banco.cliente.query<{ valor_centavos: string; stripe_price_id: null }>(
      'SELECT valor_centavos::text AS valor_centavos, stripe_price_id FROM precos_vigentes',
    )
    expect(linhas.rows).toHaveLength(1)
    expect(linhas.rows[0]?.valor_centavos).toBe('3900')
    expect(linhas.rows[0]?.stripe_price_id).toBeNull()
  })

  it('**diz que zero assinaturas são afetadas, e o número é do servidor**', async () => {
    // A ADR 0025 exige que a tela mostre esse número. Ele vem daqui e não da
    // tela: uma contagem que a interface afirma é uma contagem que ninguém
    // conferiu. Zero porque o preço novo vale para vendas futuras — quem já
    // contratou mantém o preço contratado.
    expect((await criarPreco()).json().assinaturasAfetadas).toBe(0)

    const vivas = await api.banco.cliente.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM assinaturas
        WHERE plano = 'pessoal' AND intervalo = 'mensal' AND estado = 'ativa'`,
    )
    // Há assinaturas vivas nesse par, e mesmo assim nenhuma é afetada.
    expect(Number(vivas.rows[0]!.n)).toBeGreaterThan(0)
  })

  it('trocar de novo devolve o valor anterior, e a linha velha fica', async () => {
    await criarPreco({ centavos: '3900' })
    const r = await criarPreco({ centavos: '4200' })

    expect(r.json().valorAnterior).toBe('3900')
    const linhas = await api.banco.cliente.query('SELECT id FROM precos_vigentes')
    expect(linhas.rows).toHaveLength(2)
  })

  it('**o mesmo preço é recusado** — uma linha que não muda nada mente na auditoria', async () => {
    await criarPreco({ centavos: '3900' })
    const r = await criarPreco({ centavos: '3900' })

    expect(r.statusCode).toBe(400)
    expect(r.json().message).toContain('já é o preço vigente')
  })

  it('motivo curto é recusado antes de tocar o banco', async () => {
    const r = await criarPreco({ motivo: 'pq sim' })
    expect(r.statusCode).toBe(400)
    expect((await api.banco.cliente.query('SELECT id FROM precos_vigentes')).rows).toHaveLength(0)
  })

  it('**não existe caminho para alterar uma linha de preço**', async () => {
    // A propriedade central da D2: retroatividade é *irrepresentável*, e não
    // desencorajada. Nenhum papel do painel tem `UPDATE`, então a madrugada de
    // que a ADR 0020 D3 tem medo não tem instrução disponível.
    await criarPreco()
    const p = await api.banco.cliente.query<{ p: string }>(
      `SELECT string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS p
         FROM information_schema.table_privileges
        WHERE table_name = 'precos_vigentes' AND grantee LIKE 'mavia_admin%'`,
    )
    expect(p.rows[0]?.p ?? '').not.toContain('UPDATE')
    expect(p.rows[0]?.p ?? '').not.toContain('DELETE')
  })

  it('a auditoria registra de → para, sem tenant, com o motivo', async () => {
    await criarPreco({ centavos: '3900' })
    await criarPreco({ centavos: '4200' })

    const a = await api.banco.cliente.query<{
      tenant_id: string | null
      de: { valor_centavos: string | null }
      para: { valor_centavos: string; razao: string }
    }>(`SELECT tenant_id, de, para FROM auditoria
         WHERE acao = 'criou_preco'
           -- auditoria e append-only: o beforeEach nao a limpa, e nao deveria.
           -- O recorte e pelas linhas de preco deste teste.
           AND entidade_id IN (SELECT id FROM precos_vigentes)
         ORDER BY ocorrido_em`)

    expect(a.rows).toHaveLength(2)
    // Preço não pertence a espaço nenhum — auditar um tenant aqui seria
    // registrar um acesso que não aconteceu.
    expect(a.rows[0]?.tenant_id).toBeNull()
    expect(a.rows[0]?.de.valor_centavos).toBeNull()
    expect(a.rows[1]?.de.valor_centavos).toBe('3900')
    expect(a.rows[1]?.para.valor_centavos).toBe('4200')
    expect(a.rows[1]?.para.razao).toContain('reajuste')
  })
})

describe('o desconto por cliente', () => {
  it('**concede sem Stripe, e o cupom fica nulo**', async () => {
    const r = await conceder()
    expect(r.statusCode).toBe(201)

    const l = await api.banco.cliente.query<{ pontos_base: number; stripe_coupon_id: null }>(
      'SELECT pontos_base, stripe_coupon_id FROM descontos_de_cliente WHERE revogado_em IS NULL',
    )
    expect(l.rows[0]?.pontos_base).toBe(1500)
    expect(l.rows[0]?.stripe_coupon_id).toBeNull()
  })

  it('**conceder sobre um ativo substitui, e as duas linhas ficam**', async () => {
    // O índice parcial recusaria o segundo de qualquer forma. Revogar antes é
    // o que transforma a recusa do banco numa substituição intencional — sem
    // isso o operador veria `23505` e o cliente ficaria com o desconto antigo.
    await conceder(TENANT_A, { pontosBase: 1000 })
    await conceder(TENANT_A, { pontosBase: 2000 })

    const todas = await api.banco.cliente.query<{ pontos_base: number; revogado_em: Date | null }>(
      'SELECT pontos_base, revogado_em FROM descontos_de_cliente ORDER BY concedido_em',
    )
    expect(todas.rows).toHaveLength(2)
    expect(todas.rows[0]?.revogado_em).not.toBeNull()
    expect(todas.rows[1]?.revogado_em).toBeNull()
    expect(todas.rows[1]?.pontos_base).toBe(2000)
  })

  it('revogar deixa a linha, nunca apaga', async () => {
    await conceder()
    const r = await comoOperador('DELETE', `/v1/admin/clientes/${TENANT_A}/descontos`, {
      motivo: 'cliente pediu o cancelamento do desconto',
    })

    expect(r.statusCode).toBe(200)
    const l = await api.banco.cliente.query('SELECT id FROM descontos_de_cliente')
    expect(l.rows).toHaveLength(1)
  })

  it('revogar sem desconto ativo é recusa, e não sucesso silencioso', async () => {
    const r = await comoOperador('DELETE', `/v1/admin/clientes/${TENANT_A}/descontos`, {
      motivo: 'tentando revogar o que nao existe',
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().message).toContain('não tem desconto ativo')
  })

  it('**percentual com centavos é recusado na borda** — a combinação é o que importa', async () => {
    const r = await conceder(TENANT_A, { centavos: '1000' })
    expect(r.statusCode).toBe(400)
  })

  it('percentual acima de 100% é recusado', async () => {
    expect((await conceder(TENANT_A, { pontosBase: 10_001 })).statusCode).toBe(400)
    expect((await conceder(TENANT_A, { pontosBase: 10_000 })).statusCode).toBe(201)
  })

  it('duração em meses sem meses é recusada', async () => {
    expect((await conceder(TENANT_A, { duracao: 'meses' })).statusCode).toBe(400)
    expect((await conceder(TENANT_A, { duracao: 'meses', meses: 3 })).statusCode).toBe(201)
  })

  it('**o desconto de um espaço não alcança o outro**', async () => {
    await conceder(TENANT_A)
    const doB = await api.banco.cliente.query(
      'SELECT id FROM descontos_de_cliente WHERE tenant_id = $1 AND revogado_em IS NULL',
      [TENANT_B],
    )
    expect(doB.rows).toHaveLength(0)
  })

  it('conceder abre o espaço do cliente e correlaciona as duas linhas', async () => {
    await conceder()

    // Parte do **efeito** e procura a intenção, e não o contrário: auditoria e
    // append-only, o beforeEach nao a limpa, e varrer por tenant traria as
    // linhas dos testes anteriores. O recorte e o desconto que este teste criou.
    const efeito = await api.banco.cliente.query<{ correlacao: string }>(
      `SELECT correlacao FROM auditoria
        WHERE acao = 'concedeu_desconto'
          AND entidade_id IN (SELECT id FROM descontos_de_cliente)`,
    )
    expect(efeito.rows).toHaveLength(1)
    const correlacao = efeito.rows[0]!.correlacao
    expect(correlacao).not.toBeNull()

    // O par: intenção e efeito compartilham a correlação, e nada mais a
    // compartilha. As duas carregam a mesma `acao` — quem abre o espaço recebe
    // o nome do ato —, então o que as distingue é a entidade.
    const par = await api.banco.cliente.query<{ entidade: string; tenant_id: string }>(
      'SELECT entidade, tenant_id FROM auditoria WHERE correlacao = $1 ORDER BY ocorrido_em',
      [correlacao],
    )
    expect(par.rows).toHaveLength(2)
    expect(par.rows.map((l) => l.entidade)).toContain('desconto')
    // As duas apontam para o mesmo espaço: é isto que impede auditar um espaço
    // e efetivar noutro.
    expect(new Set(par.rows.map((l) => l.tenant_id)).size).toBe(1)
    expect(par.rows[0]?.tenant_id).toBe(TENANT_A)
  })
})

describe('o que o cliente vê do próprio desconto', () => {
  it('**lê o desconto, e não lê o motivo nem quem concedeu**', async () => {
    // `motivo` é a nota interna do operador; `concedido_por` é um crachá de
    // funcionário. Os dois estão fora do `GRANT` de `mavia_app`, então a
    // recusa vem do banco e não de uma consulta que alguém lembrou de escrever.
    await conceder()

    const p = await api.banco.cliente.query<{ c: string }>(
      `SELECT string_agg(column_name, ',' ORDER BY column_name) AS c
         FROM information_schema.column_privileges
        WHERE table_name = 'descontos_de_cliente' AND grantee = 'mavia_app'
          AND privilege_type = 'SELECT'`,
    )
    const colunas = p.rows[0]?.c ?? ''
    expect(colunas).toContain('pontos_base')
    expect(colunas).not.toContain('motivo')
    expect(colunas).not.toContain('concedido_por')
    expect(colunas).not.toContain('revogado_por')
  })
})

describe('prorrogar teste — sem teto desde 2026-09-05', () => {
  /** Põe o espaço em teste, com o período terminando em N dias. */
  async function emTeste(dias: number, tenant = TENANT_B): Promise<void> {
    await api.banco.cliente.query(
      `UPDATE assinaturas
          SET estado = 'teste', cortesia_ate = NULL,
              periodo_inicio = now(),
              periodo_fim = now() + ($2 || ' days')::interval
        WHERE tenant_id = $1`,
      [tenant, dias],
    )
  }

  const prorrogar = (dias: number, tenant = TENANT_B) =>
    comoOperador('POST', `/v1/admin/clientes/${tenant}/teste/prorrogar`, {
      dias,
      razao: 'cliente pediu mais tempo para avaliar',
    })

  it('**noventa dias passam — o teto de sete caiu**', async () => {
    await emTeste(7)
    const r = await prorrogar(90)
    expect(r.statusCode).toBe(201)
  })

  it('**prorrogar de novo acumula, e não substitui**', async () => {
    // Com o uso único, `cortesia_ate = periodo_fim + dias` bastava. Permitindo
    // repetir, essa fórmula daria 30 para duas chamadas de 30 — e o operador
    // concluiria que a segunda não funcionou.
    await emTeste(7)
    const primeira = await prorrogar(30)
    const segunda = await prorrogar(30)

    expect(segunda.statusCode).toBe(201)
    const a = new Date(String(primeira.json().cortesiaAte)).getTime()
    const b = new Date(String(segunda.json().cortesiaAte)).getTime()
    const dias = Math.round((b - a) / 86_400_000)
    expect(dias).toBe(30)
  })

  it('o guarda de digitação continua, e a mensagem diz que é digitação', async () => {
    await emTeste(7)
    const r = await prorrogar(36_500)
    expect(r.statusCode).toBe(400)
    expect(String(r.json().message)).toContain('digitação')
  })

  it('**a cortesia continua com teto** — são políticas diferentes', async () => {
    // Prorrogar teste estende um produto grátis; conceder cortesia compensa um
    // cliente pagante. A decisão do dono foi sobre a primeira.
    await api.banco.cliente.query(
      `UPDATE assinaturas SET estado = 'ativa', cortesia_ate = NULL WHERE tenant_id = $1`,
      [TENANT_B],
    )
    const r = await comoOperador('POST', `/v1/admin/clientes/${TENANT_B}/cortesia`, {
      dias: 90,
      razao: 'tentando passar do teto da cortesia',
    })
    expect(r.statusCode).toBe(400)
  })
})

describe('conceder e revogar operadora pelo painel', () => {
  const conceder = (email: string) => comoOperador('POST', '/v1/admin/operadores', { email })
  const revogar = (email: string) => comoOperador('DELETE', '/v1/admin/operadores', { email })

  async function emailDe(usuario: string): Promise<string> {
    const r = await api.banco.cliente.query<{ email: string }>(
      'SELECT email FROM usuarios WHERE id = $1',
      [usuario],
    )
    return r.rows[0]!.email
  }

  it('**concede por e-mail, e quem concede é quem pediu**', async () => {
    const alvo = await emailDe(USUARIO_B)
    const r = await conceder(alvo)

    expect(r.statusCode).toBe(201)
    expect(r.json().operadoresAtivos).toBe(2)

    const c = await api.banco.cliente.query<{ concedida_por: string; email_no_ato: string }>(
      `SELECT concedida_por, email_no_ato FROM concessoes_de_admin
        WHERE usuario_id = $1 AND revogada_em IS NULL`,
      [USUARIO_B],
    )
    // A corrente de responsabilidade: cada operador tem um concedente nominal.
    expect(c.rows[0]?.concedida_por).toBe(USUARIO_A)
    expect(c.rows[0]?.email_no_ato).toBe(alvo)
  })

  it('conceder duas vezes é recusa legível, e não `23505`', async () => {
    const alvo = await emailDe(USUARIO_B)
    const r = await conceder(alvo)
    expect(r.statusCode).toBe(400)
    expect(String(r.json().message)).toContain('já é operadora')
  })

  it('e-mail sem conta é recusado, e a mensagem diz o que fazer', async () => {
    const r = await conceder('ninguem@exemplo.test')
    expect(r.statusCode).toBe(400)
    expect(String(r.json().message)).toContain('cadastrar')
  })

  it('id em vez de e-mail não passa pela validação da borda', async () => {
    const r = await comoOperador('POST', '/v1/admin/operadores', { email: USUARIO_B })
    expect(r.statusCode).toBe(400)
  })

  it('**a invariante barra descer para menos de dois**', async () => {
    // Com dois ativos, revogar um deixaria um. A migration 0031 recusa: perder
    // o acesso do único trancaria o painel, e o aviso entre pares não teria
    // para quem ir.
    const alvo = await emailDe(USUARIO_B)
    const r = await revogar(alvo)

    expect(r.statusCode).toBe(400)
    const ativos = await api.banco.cliente.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM concessoes_de_admin WHERE revogada_em IS NULL',
    )
    expect(ativos.rows[0]?.n).toBe('2')
  })

  it('**não existe rota para listar operadores** — a 0031 proíbe enumerar', async () => {
    // A migration diz por quê: uma policy ampla entregaria, numa conexão sem
    // segundo fator, a lista de todos os operadores com nome e e-mail. O painel
    // roda hoje sem MFA (DP-32 revista), então a conexão é literalmente essa.
    //
    // A asserção é sobre o **corpo**, e não sobre o código: a rota não está em
    // `ROTAS_DE_ADMIN`, então ela cai no caminho do cliente e morre pedindo
    // `X-Mavia-Tenant` — que o painel nunca manda. O status é consequência de
    // um detalhe de roteamento; o que precisa valer é que nenhuma lista sai.
    //
    // Conferir uma pessoa por vez continua possível pelas recusas de conceder;
    // enumerar, não. A diferença entre as duas coisas é o ataque.
    const r = await comoOperador('GET', '/v1/admin/operadores')
    expect(r.statusCode).not.toBe(200)
    expect(JSON.stringify(r.json())).not.toContain('email_no_ato')
  })
})
