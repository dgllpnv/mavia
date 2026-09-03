import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, TENANT_B, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * Objetivo contra Postgres real.
 *
 * A travessia de `concluido_em` **não pode** ser testada por unidade: ela mora
 * num gatilho, e mora lá porque o progresso muda por caminhos que não conhecem
 * Objetivo nenhum. Um teste que a apurasse na leitura provaria exatamente o
 * defeito que o ADR 0009 emendou.
 *
 * Os contraexemplos Z, AA e AB da auditoria do spec estão aqui, nomeados.
 */

let api: ApiDeTeste
let poupanca = ''
let corrente = ''
let renda = ''

const DE = { usuario: USUARIO_A, tenant: TENANT_A }

const pedir = (metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, corpo?: unknown) =>
  api.pedir({ metodo, url, ...DE, ...(corpo === undefined ? {} : { corpo }) })

const criarConta = async (nome: string, saldoInicial: string) => {
  const r = await pedir('POST', '/v1/contas', {
    nome,
    tipo: 'poupanca',
    saldoInicialCentavos: saldoInicial,
  })
  return r.json().id as string
}

/** Um depósito compensado na conta, na data pedida. */
const depositar = (contaId: string, valor: string, quando: string, descricao = 'Depósito') =>
  pedir('POST', '/v1/lancamentos', {
    contaId,
    categoriaId: renda,
    valorCentavos: valor,
    postedAt: quando,
    compensado: true,
    descricao,
  })

beforeAll(async () => {
  api = await subirApi()

  poupanca = await criarConta('Poupança do objetivo', '200000')
  corrente = await criarConta('Corrente do objetivo', '0')

  const cats = await pedir('GET', '/v1/categorias')
  renda = cats
    .json()
    .itens.find((c: { natureza: string; analitica: boolean }) => c.natureza === 'receita' && c.analitica).id
}, 180_000)

afterAll(async () => {
  await api?.encerrar()
})

describe('criar', () => {
  it('ancorado captura o saldo da conta como marco, e nasce com progresso zero', async () => {
    const r = await pedir('POST', '/v1/objetivos', {
      nome: 'Viagem',
      valorAlvoCentavos: '1000000',
      contaId: poupanca,
    })

    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({
      saldoBaseCentavos: '200000',
      progressoCentavos: '0',
      consumoBp: 0,
      estado: 'ativo',
    })
  })

  it('marco zero conta o que já estava lá', async () => {
    const r = await pedir('POST', '/v1/objetivos', {
      nome: 'Reserva',
      valorAlvoCentavos: '5000000',
      contaId: poupanca,
      saldoBaseCentavos: '0',
    })

    // Dois objetivos ancorados na mesma conta são permitidos: ambos leem o
    // mesmo saldo com marcos distintos.
    expect(r.statusCode).toBe(201)
    expect(r.json().progressoCentavos).toBe('200000')
  })

  it('por aportes não tem marco', async () => {
    const r = await pedir('POST', '/v1/objetivos', {
      nome: 'Notebook',
      valorAlvoCentavos: '800000',
    })

    expect(r.statusCode).toBe(201)
    expect(r.json().saldoBaseCentavos).toBeNull()
    expect(r.json().progressoCentavos).toBe('0')
  })

  it('recusa alvo zero ou negativo', async () => {
    expect((await pedir('POST', '/v1/objetivos', { nome: 'X', valorAlvoCentavos: '0' })).statusCode).toBe(400)
    expect(
      (await pedir('POST', '/v1/objetivos', { nome: 'X', valorAlvoCentavos: '-1' })).statusCode,
    ).toBe(400)
  })

  it('recusa prazo no passado, e aceita o de hoje', async () => {
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
    const ontem = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', {
      timeZone: 'America/Sao_Paulo',
    })

    expect(
      (await pedir('POST', '/v1/objetivos', { nome: 'Tarde', valorAlvoCentavos: '1', prazo: ontem }))
        .statusCode,
    ).toBe(400)

    // O último dia conta, e o dia é apurado em America/Sao_Paulo.
    const r = await pedir('POST', '/v1/objetivos', {
      nome: 'Hoje ainda vale',
      valorAlvoCentavos: '1000000',
      prazo: hoje,
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().estado).toBe('ativo')
  })

  it('recusa marco sem conta', async () => {
    const r = await pedir('POST', '/v1/objetivos', {
      nome: 'Sem conta',
      valorAlvoCentavos: '100',
      saldoBaseCentavos: '100',
    })

    expect(r.statusCode).toBe(400)
  })
})

describe('progresso ancorado', () => {
  let objetivo = ''

  beforeAll(async () => {
    const r = await pedir('POST', '/v1/objetivos', {
      nome: 'Carro',
      valorAlvoCentavos: '300000',
      contaId: corrente,
    })
    objetivo = r.json().id
  })

  const ler = async () => {
    const itens = (await pedir('GET', '/v1/objetivos')).json().itens
    return itens.find((o: { id: string }) => o.id === objetivo)
  }

  it('um depósito depois da criação move o progresso', async () => {
    await depositar(corrente, '100000', new Date().toISOString(), 'Aporte de hoje')

    expect((await ler()).progressoCentavos).toBe('100000')
  })

  it('**retroativo ANTERIOR à criação não move o progresso** (contraexemplos Z e AA)', async () => {
    // O caso que a versão original do ADR deixava passar: em setembro entra um
    // depósito feito em agosto, antes de o objetivo existir. O saldo sobe, e o
    // progresso **não pode** subir — o dinheiro já estava na conta quando o
    // marco foi capturado; só não estava registrado.
    //
    // Sem o reajuste, uma importação de OFX daria 30% de progresso sem que a
    // pessoa tivesse guardado um centavo. Com alvo baixo, gravaria
    // `concluido_em` em definitivo por um depósito de agosto.
    const antes = await ler()

    await depositar(corrente, '500000', '2025-08-15T12:00:00.000Z', 'Depósito de agosto')

    const depois = await ler()
    expect(depois.progressoCentavos).toBe(antes.progressoCentavos)
    // O marco subiu pelo mesmo valor: é ele que absorve o retroativo.
    expect(BigInt(depois.saldoBaseCentavos) - BigInt(antes.saldoBaseCentavos)).toBe(500000n)
    expect(depois.estado).toBe('ativo')
  })

  it('resgate leva o progresso a negativo, e isso é exibível', async () => {
    await pedir('POST', '/v1/lancamentos', {
      contaId: corrente,
      categoriaId: (await pedir('GET', '/v1/categorias')).json().itens.find(
        (c: { natureza: string; analitica: boolean; nome: string }) =>
          c.natureza === 'despesa' && c.analitica,
      ).id,
      valorCentavos: '-150000',
      postedAt: new Date().toISOString(),
      compensado: true,
      descricao: 'Resgate',
    })

    const o = await ler()
    expect(o.progressoCentavos).toBe('-50000')
    // Invariante 7: o domínio devolve o número real. Travar em 0% é da tela.
    expect(o.consumoBp).toBeLessThan(0)
  })
})

describe('a travessia, e por que ela não pode morar na leitura', () => {
  let objetivo = ''
  let conta = ''

  beforeAll(async () => {
    conta = await criarConta('Conta da travessia', '0')
    const r = await pedir('POST', '/v1/objetivos', {
      nome: 'Alvo pequeno',
      valorAlvoCentavos: '100000',
      contaId: conta,
    })
    objetivo = r.json().id
  })

  const ler = async () => {
    const itens = (await pedir('GET', '/v1/objetivos')).json().itens
    return itens.find((o: { id: string }) => o.id === objetivo)
  }

  it('**atingir e resgatar, sem nenhuma leitura no meio, conclui** (contraexemplo AB)', async () => {
    // As duas escritas acontecem sem que a listagem seja chamada entre elas.
    // Apurada na leitura, "primeira travessia" viraria "primeira vez que
    // alguém abriu a tela", e este objetivo nunca seria concluído.
    await depositar(conta, '120000', new Date().toISOString(), 'Atingiu')
    await pedir('POST', '/v1/lancamentos', {
      contaId: conta,
      categoriaId: (await pedir('GET', '/v1/categorias')).json().itens.find(
        (c: { natureza: string; analitica: boolean }) => c.natureza === 'despesa' && c.analitica,
      ).id,
      valorCentavos: '-50000',
      postedAt: new Date().toISOString(),
      compensado: true,
      descricao: 'Sacou depois',
    })

    const o = await ler()

    // Progresso caiu para R$ 700 de R$ 1.000 — e mesmo assim está concluído.
    expect(o.progressoCentavos).toBe('70000')
    expect(o.estado).toBe('concluido')
    expect(o.concluidoEm).not.toBeNull()
  })

  it('**subir o alvo acima do progresso desfaz a conclusão**', async () => {
    // A assimetria: a fixidez protege contra o movimento do dinheiro, não
    // contra a redefinição do alvo. Quem eleva o alvo diz que o objetivo é
    // outro; quem saca diz que gastou.
    const r = await pedir('PATCH', `/v1/objetivos/${objetivo}`, {
      valorAlvoCentavos: '2000000',
    })

    expect(r.statusCode).toBe(200)
    expect(r.json().estado).toBe('ativo')
    expect(r.json().concluidoEm).toBeNull()
  })

  it('baixar o alvo para valor já alcançado conclui na hora, com data nova', async () => {
    const r = await pedir('PATCH', `/v1/objetivos/${objetivo}`, { valorAlvoCentavos: '60000' })

    expect(r.json().estado).toBe('concluido')
    expect(r.json().concluidoEm).not.toBeNull()
  })

  it('o modo de apuração não muda depois de criado', async () => {
    // `contaId` não está no contrato de alteração; o banco recusa de qualquer
    // forma, e é a recusa dele que vale.
    const r = await pedir('PATCH', `/v1/objetivos/${objetivo}`, { contaId: null })

    expect(r.statusCode).toBe(400)
  })
})

describe('aportes', () => {
  let objetivo = ''
  let ancorado = ''
  let lancamento = ''

  beforeAll(async () => {
    objetivo = (
      await pedir('POST', '/v1/objetivos', { nome: 'Bicicleta', valorAlvoCentavos: '200000' })
    ).json().id
    ancorado = (
      await pedir('POST', '/v1/objetivos', {
        nome: 'Ancorado sem aporte',
        valorAlvoCentavos: '100',
        contaId: poupanca,
      })
    ).json().id

    const r = await depositar(corrente, '150000', new Date().toISOString(), 'Para a bicicleta')
    lancamento = r.json().id
  })

  it('vincular soma ao progresso com o sinal do domínio', async () => {
    const r = await pedir('POST', `/v1/objetivos/${objetivo}/aportes`, { lancamentoId: lancamento })

    expect(r.statusCode).toBe(201)
    expect(r.json().progressoCentavos).toBe('150000')
    expect(r.json().aportes).toBe(1)
  })

  it('**vincular não altera o lançamento** (invariante 12)', async () => {
    const l = (await pedir('GET', `/v1/lancamentos/${lancamento}`)).json()

    expect(l.valorCentavos).toBe('150000')
    expect(l.categoriaId).toBe(renda)
  })

  it('um lançamento pertence a no máximo um objetivo', async () => {
    const outro = (
      await pedir('POST', '/v1/objetivos', { nome: 'Outro', valorAlvoCentavos: '100000' })
    ).json().id

    const r = await pedir('POST', `/v1/objetivos/${outro}/aportes`, { lancamentoId: lancamento })

    expect(r.statusCode).toBe(409)
  })

  it('objetivo ancorado não aceita aporte', async () => {
    // Seu progresso já é o saldo da conta: aceitar os dois contaria o mesmo
    // dinheiro duas vezes.
    const r = await pedir('POST', `/v1/objetivos/${ancorado}/aportes`, {
      lancamentoId: lancamento,
    })

    expect(r.statusCode).toBe(400)
  })

  it('desvincular devolve o progresso', async () => {
    const r = await pedir('DELETE', `/v1/objetivos/${objetivo}/aportes/${lancamento}`)

    expect(r.statusCode).toBe(200)
    expect(r.json().progressoCentavos).toBe('0')
    expect(r.json().aportes).toBe(0)
  })

  it('**o aporte não mexe em nenhum realizado de Planejamento** (invariante 14)', async () => {
    const competencia = new Date().toISOString().slice(0, 7)
    const antes = (await pedir('GET', `/v1/planejamentos?competencia=${competencia}`)).json()

    await pedir('POST', `/v1/objetivos/${objetivo}/aportes`, { lancamentoId: lancamento })

    const depois = (await pedir('GET', `/v1/planejamentos?competencia=${competencia}`)).json()
    expect(depois.itens.map((p: { realizadoCentavos: string }) => p.realizadoCentavos)).toEqual(
      antes.itens.map((p: { realizadoCentavos: string }) => p.realizadoCentavos),
    )
  })
})

describe('a conta ancorada não some por baixo do objetivo', () => {
  it('excluir a conta é recusado, e a mensagem nomeia o objetivo', async () => {
    const conta = await criarConta('Conta que não some', '0')
    await pedir('POST', '/v1/objetivos', {
      nome: 'Segura a conta',
      valorAlvoCentavos: '100000',
      contaId: conta,
    })

    const r = await pedir('DELETE', `/v1/contas/${conta}`)

    expect(r.statusCode).toBeGreaterThanOrEqual(400)
    expect(r.body).toContain('Segura a conta')
  })
})

describe('isolamento e acesso', () => {
  it('o objetivo de um espaço não aparece no outro', async () => {
    const r = await api.pedir({
      metodo: 'GET',
      url: '/v1/objetivos',
      usuario: USUARIO_B,
      tenant: TENANT_B,
    })

    expect(r.statusCode).toBe(200)
    expect(r.json().itens).toEqual([])
  })

  it('visualizador lê e não escreve', async () => {
    const { pode } = await import('../src/autorizacao/politica-acesso.js')

    expect(pode({ metodo: 'GET', caminho: '/v1/objetivos' }, 'visualizador')).toBe(true)
    expect(pode({ metodo: 'POST', caminho: '/v1/objetivos' }, 'visualizador')).toBe(false)
    // A matriz é indexada pelo **padrão** da rota, não pelo caminho concreto:
    // é o padrão que o roteador informa ao guardião.
    expect(
      pode({ metodo: 'POST', caminho: '/v1/objetivos/:id/aportes' }, 'visualizador'),
    ).toBe(false)
    expect(pode({ metodo: 'POST', caminho: '/v1/objetivos/:id/aportes' }, 'membro')).toBe(true)
  })
})
