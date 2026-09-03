import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A, TENANT_B, USUARIO_A, USUARIO_B } from './postgres.js'
import { subirApi, type ApiDeTeste } from './aplicacao-de-teste.js'

/**
 * Importação de extrato contra Postgres real.
 *
 * As três propriedades que o épico 6 promete, e que só valem se forem provadas
 * juntas: reimportar não duplica, conciliação é sugestão, e desfazer devolve o
 * mês ao que era.
 */

let api: ApiDeTeste
let conta = ''
let categoria = ''

const DE = { usuario: USUARIO_A, tenant: TENANT_A }
const pedir = (metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, corpo?: unknown) =>
  api.pedir({ metodo, url, ...DE, ...(corpo === undefined ? {} : { corpo }) })

/** Um OFX com duas transações, no formato que os bancos entregam. */
const ofx = (
  transacoes: readonly { id: string; data: string; valor: string; memo: string }[],
) => `
OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>BRL
<BANKTRANLIST>
${transacoes
  .map(
    (t) => `<STMTTRN>
<TRNTYPE>${t.valor.startsWith('-') ? 'DEBIT' : 'CREDIT'}
<DTPOSTED>${t.data}
<TRNAMT>${t.valor}
<FITID>${t.id}
<MEMO>${t.memo}
</STMTTRN>`,
  )
  .join('\n')}
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`

const importar = (conteudo: string) =>
  pedir('POST', '/v1/importacoes', { contaId: conta, conteudo, nomeDoArquivo: 'extrato.ofx' })

async function noExtrato(descricao: string): Promise<number> {
  const r = await pedir(
    'GET',
    '/v1/lancamentos?de=2026-04-01T00:00:00.000Z&ate=2026-05-01T00:00:00.000Z',
  )
  return r.json().itens.filter((l: { descricao: string }) => l.descricao === descricao).length
}

beforeAll(async () => {
  api = await subirApi()

  const contas = await pedir('GET', '/v1/contas')
  conta = contas.json().itens[0].id

  const cats = await pedir('GET', '/v1/categorias')
  categoria = cats
    .json()
    .itens.find((c: { natureza: string; analitica: boolean }) => c.natureza === 'despesa' && c.analitica).id
}, 180_000)

afterAll(async () => {
  await api?.encerrar()
})

describe('a primeira importação', () => {
  it('cria os lançamentos, com `settled_at` preenchido', async () => {
    // O extrato **é** o registro de que o dinheiro se moveu. É o único lugar do
    // sistema em que a compensação vem de fora, e vem legitimamente: o banco
    // está atestando o fato.
    const r = await importar(
      ofx([
        { id: 'A1', data: '20260410', valor: '-150.00', memo: 'MERCADO CENTRAL' },
        { id: 'A2', data: '20260412', valor: '-89.90', memo: 'FARMACIA POPULAR' },
      ]),
    )

    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({ provider: 'ofx-import', registros: 2, criados: 2, repetidos: 0 })

    const extrato = await pedir(
      'GET',
      '/v1/lancamentos?de=2026-04-01T00:00:00.000Z&ate=2026-05-01T00:00:00.000Z',
    )
    const importado = extrato
      .json()
      .itens.find((l: { descricao: string }) => l.descricao === 'MERCADO CENTRAL')

    expect(importado.settledAt).not.toBeNull()
    expect(importado.valorCentavos).toBe('-15000')
  })

  it('**o extrato com receita e despesa no mesmo arquivo entra inteiro**', async () => {
    // O defeito que a primeira execução contra um extrato real revelou: a
    // categoria carrega natureza, e mandar a receita para uma de despesa faz o
    // gatilho de coerência recusar a linha e derrubar a **importação inteira**.
    // O teste original não pegou porque todas as transações eram negativas.
    const r = await importar(
      ofx([
        { id: 'MIX1', data: '20260405', valor: '-33.00', memo: 'MERCADO' },
        { id: 'MIX2', data: '20260405', valor: '7200.00', memo: 'SALARIO' },
      ]),
    )

    expect(r.statusCode).toBe(201)
    expect(r.json().criados).toBe(2)

    const extrato = await pedir(
      'GET',
      '/v1/lancamentos?de=2026-04-01T00:00:00.000Z&ate=2026-05-01T00:00:00.000Z',
    )
    const salario = extrato
      .json()
      .itens.find((l: { descricao: string }) => l.descricao === 'SALARIO')

    expect(salario.valorCentavos).toBe('720000')
  })

  it('**a categoria é analítica, e não `Ajuste de saldo`**', async () => {
    // A não-analítica sumiria de todo relatório e de todo planejamento, e o mês
    // importado apareceria vazio — o defeito mais silencioso que esta rota
    // poderia ter.
    const cats = await pedir('GET', '/v1/categorias')
    const aClassificar = cats
      .json()
      .itens.find((c: { nome: string }) => c.nome === 'A classificar')

    expect(aClassificar).toBeDefined()
    expect(aClassificar.analitica).toBe(true)
  })
})

describe('reimportar', () => {
  it('**o mesmo arquivo, de novo, não cria nada**', async () => {
    // A regra 13 do CLAUDE.md, no ponto em que ela é visível: a chave é
    // `(tenant, provider, external_id)`, e é o banco que a garante.
    const arquivo = ofx([
      { id: 'A1', data: '20260410', valor: '-150.00', memo: 'MERCADO CENTRAL' },
      { id: 'A2', data: '20260412', valor: '-89.90', memo: 'FARMACIA POPULAR' },
    ])

    const r = await importar(arquivo)

    expect(r.json()).toMatchObject({ registros: 2, criados: 0, repetidos: 2 })
    expect(await noExtrato('MERCADO CENTRAL')).toBe(1)
  })

  it('o arquivo do mês seguinte, com uma transação repetida, importa só a nova', async () => {
    // O caso real: o cliente baixa o extrato dos últimos 30 dias toda semana, e
    // os arquivos se sobrepõem.
    const r = await importar(
      ofx([
        { id: 'A2', data: '20260412', valor: '-89.90', memo: 'FARMACIA POPULAR' },
        { id: 'A3', data: '20260420', valor: '-45.00', memo: 'POSTO IPIRANGA' },
      ]),
    )

    expect(r.json()).toMatchObject({ criados: 1, repetidos: 1 })
  })
})

describe('conciliação', () => {
  let sugestaoId = ''

  it('**um registro parecido com um lançamento manual vira sugestão, não substituição**', async () => {
    // O sistema jamais apaga o registro do usuário sozinho.
    const manual = await pedir('POST', '/v1/lancamentos', {
      contaId: conta,
      categoriaId: categoria,
      valorCentavos: '-23050',
      postedAt: '2026-04-15T12:00:00.000Z',
      compensado: false,
      descricao: 'Almoço com a equipe',
    })
    expect(manual.statusCode).toBe(201)

    const r = await importar(
      ofx([{ id: 'B1', data: '20260416', valor: '-230.50', memo: 'RESTAURANTE XYZ' }]),
    )

    // Não criou lançamento: propôs casar com o que já existe.
    expect(r.json().criados).toBe(0)

    const sugestoes = await pedir('GET', '/v1/conciliacoes')
    const s = sugestoes.json().itens[0]

    expect(s).toBeDefined()
    expect(s.descricaoManual).toBe('Almoço com a equipe')
    expect(s.descricaoDoExtrato).toBe('RESTAURANTE XYZ')
    sugestaoId = s.id
  })

  it('confirmar preserva o lançamento do usuário e o marca como compensado', async () => {
    const r = await pedir('POST', `/v1/conciliacoes/${sugestaoId}/confirmar`)
    expect(r.statusCode).toBe(200)

    const extrato = await pedir(
      'GET',
      '/v1/lancamentos?de=2026-04-01T00:00:00.000Z&ate=2026-05-01T00:00:00.000Z',
    )
    const itens = extrato.json().itens

    // O registro do usuário continua lá, com o texto dele.
    const meu = itens.find((l: { descricao: string }) => l.descricao === 'Almoço com a equipe')
    expect(meu).toBeDefined()
    expect(meu.settledAt).not.toBeNull()

    // E o do extrato **não** virou um segundo lançamento.
    expect(await noExtrato('RESTAURANTE XYZ')).toBe(0)
  })

  it('**descartar não descarta o dinheiro: o registro do extrato vira lançamento**', async () => {
    const manual = await pedir('POST', '/v1/lancamentos', {
      contaId: conta,
      categoriaId: categoria,
      valorCentavos: '-7700',
      postedAt: '2026-04-18T12:00:00.000Z',
      compensado: false,
      descricao: 'Livro',
    })
    expect(manual.statusCode).toBe(201)

    await importar(ofx([{ id: 'C1', data: '20260419', valor: '-77.00', memo: 'LIVRARIA CULTURA' }]))

    const sugestoes = await pedir('GET', '/v1/conciliacoes')
    const s = sugestoes.json().itens[0]
    expect(s).toBeDefined()

    const r = await pedir('POST', `/v1/conciliacoes/${s.id}/descartar`)

    expect(r.statusCode).toBe(200)
    // Os dois passam a existir: eram fatos diferentes.
    expect(await noExtrato('Livro')).toBe(1)
    expect(await noExtrato('LIVRARIA CULTURA')).toBe(1)
  })
})

describe('desfazer', () => {
  it('apaga o que a importação criou e libera a chave', async () => {
    const arquivo = ofx([{ id: 'D1', data: '20260422', valor: '-33.00', memo: 'PADARIA DO ZE' }])
    const importacao = await importar(arquivo)
    expect(await noExtrato('PADARIA DO ZE')).toBe(1)

    const r = await pedir('POST', `/v1/importacoes/${importacao.json().id}/desfazer`)

    expect(r.statusCode).toBe(200)
    expect(r.json().apagados).toBe(1)
    expect(await noExtrato('PADARIA DO ZE')).toBe(0)

    // **A chave foi liberada**: dá para importar o mesmo arquivo de novo. Sem
    // isso, desfazer seria uma armadilha — o arquivo nunca mais entraria.
    const denovo = await importar(arquivo)
    expect(denovo.json().criados).toBe(1)
  })

  it('não desfaz duas vezes', async () => {
    const importacao = await importar(
      ofx([{ id: 'E1', data: '20260423', valor: '-12.00', memo: 'CAFE' }]),
    )
    const id = importacao.json().id

    expect((await pedir('POST', `/v1/importacoes/${id}/desfazer`)).statusCode).toBe(200)
    expect((await pedir('POST', `/v1/importacoes/${id}/desfazer`)).statusCode).toBe(400)
  })

  it('**não toca no que a pessoa digitou**', async () => {
    const manual = await pedir('POST', '/v1/lancamentos', {
      contaId: conta,
      categoriaId: categoria,
      valorCentavos: '-999',
      postedAt: '2026-04-25T12:00:00.000Z',
      compensado: true,
      descricao: 'Digitado à mão, e fica',
    })
    expect(manual.statusCode).toBe(201)

    const importacao = await importar(
      ofx([{ id: 'F1', data: '20260426', valor: '-55.00', memo: 'OUTRA COISA' }]),
    )
    await pedir('POST', `/v1/importacoes/${importacao.json().id}/desfazer`)

    expect(await noExtrato('Digitado à mão, e fica')).toBe(1)
  })
})

describe('problemas e recusas', () => {
  it('linha ilegível vira problema no resumo, e o resto entra', async () => {
    // Nada é descartado em silêncio: um parser que ignora a linha ruim produz
    // uma importação que parece completa e não é.
    const comLixo = `<OFX><CURDEF>BRL
<STMTTRN><FITID>G1<DTPOSTED>20260428<TRNAMT>-10.00<MEMO>BOA</STMTTRN>
<STMTTRN><DTPOSTED>20260428<TRNAMT>-20.00<MEMO>SEM FITID</STMTTRN>
</OFX>`

    const r = await importar(comLixo)

    expect(r.json().criados).toBe(1)
    expect(r.json().problemas).toHaveLength(1)
    expect(r.json().problemas[0].motivo).toContain('FITID')
  })

  it('conta de outro espaço é recusada', async () => {
    const r = await api.pedir({
      metodo: 'POST',
      url: '/v1/importacoes',
      usuario: USUARIO_B,
      tenant: TENANT_B,
      corpo: { contaId: conta, conteudo: ofx([]) },
    })

    expect(r.statusCode).toBe(404)
  })

  it('a importação de um espaço não aparece no outro', async () => {
    const r = await api.pedir({
      metodo: 'GET',
      url: '/v1/importacoes',
      usuario: USUARIO_B,
      tenant: TENANT_B,
    })

    expect(r.json().itens).toEqual([])
  })

  it('visualizador lê e não importa', async () => {
    const { pode } = await import('../src/autorizacao/politica-acesso.js')

    expect(pode({ metodo: 'GET', caminho: '/v1/importacoes' }, 'visualizador')).toBe(true)
    expect(pode({ metodo: 'POST', caminho: '/v1/importacoes' }, 'visualizador')).toBe(false)
    expect(pode({ metodo: 'POST', caminho: '/v1/conciliacoes/:id/confirmar' }, 'membro')).toBe(true)
  })
})
