import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { lerCsv } from './csv.js'
import { lerOfx } from './ofx.js'

/**
 * Os arquivos que os bancos de verdade entregam.
 *
 * As amostras abaixo têm as irregularidades que aparecem no mundo — tag sem
 * fechamento, acento no cabeçalho, ponto e vírgula como separador, colunas de
 * crédito e débito separadas — porque um parser que só lê o arquivo bonito não
 * importa o extrato de ninguém.
 */

const OFX_TIPICO = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>BRL
<BANKACCTFROM><BANKID>001<ACCTID>12345-6<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260901
<DTEND>20260930
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260903120000[-3:BRT]
<TRNAMT>-150.00
<FITID>202609030001
<MEMO>SUPERMERCADO BOM PRECO
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260905
<TRNAMT>7200.00
<FITID>202609050002
<MEMO>SALARIO
</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`

describe('OFX', () => {
  it('lê tag sem fechamento, que é a norma e não a exceção', () => {
    // Um parser de XML de prateleira recusa metade dos extratos reais do
    // Brasil, e insistir nele produziria um produto que não importa o extrato
    // do cliente.
    const r = lerOfx(OFX_TIPICO)

    expect(r.problemas).toEqual([])
    expect(r.registros).toHaveLength(2)
    expect(r.registros[0]).toMatchObject({
      externalId: '202609030001',
      centavos: -15000n,
      descricao: 'SUPERMERCADO BOM PRECO',
      tipo: 'DEBIT',
    })
    expect(r.registros[0]?.data).toEqual({ ano: 2026, mes: 9, dia: 3 })
  })

  it('**ignora o fuso declarado, e o dia é o do banco**', () => {
    // Converter `[-3:BRT]` para UTC e de volta produziria 02/09 em metade dos
    // casos, e o lançamento apareceria no mês errado na virada.
    const r = lerOfx(OFX_TIPICO)

    expect(r.registros[0]?.data.dia).toBe(3)
  })

  it('a receita mantém o sinal positivo', () => {
    expect(lerOfx(OFX_TIPICO).registros[1]?.centavos).toBe(720000n)
  })

  it('**transação sem identificador vira problema, e não some**', () => {
    const semFitid = `<OFX><STMTTRN><DTPOSTED>20260903<TRNAMT>-10.00<MEMO>X</STMTTRN></OFX>`
    const r = lerOfx(semFitid)

    expect(r.registros).toEqual([])
    expect(r.problemas).toHaveLength(1)
    expect(r.problemas[0]?.motivo).toContain('FITID')
  })

  it('data impossível vira problema', () => {
    const trintaEUmDeFevereiro = `<OFX><STMTTRN><FITID>1<DTPOSTED>20260231<TRNAMT>-10.00</STMTTRN></OFX>`

    expect(lerOfx(trintaEUmDeFevereiro).problemas[0]?.motivo).toBe('Data ilegível.')
  })

  it('arquivo vazio não é erro: é um extrato sem movimento', () => {
    expect(lerOfx('<OFX></OFX>')).toEqual({ registros: [], problemas: [] })
  })

  it('decodifica entidades no memo', () => {
    const comEntidade = `<OFX><STMTTRN><FITID>1<DTPOSTED>20260903<TRNAMT>-10.00<MEMO>PADARIA P&amp;A</STMTTRN></OFX>`

    expect(lerOfx(comEntidade).registros[0]?.descricao).toBe('PADARIA P&A')
  })
})

describe('CSV', () => {
  const COM_VALOR_UNICO = `Data;Descrição;Valor
03/09/2026;SUPERMERCADO BOM PRECO;-150,00
05/09/2026;SALARIO;7.200,00`

  const COM_CREDITO_E_DEBITO = `Data;Histórico;Crédito;Débito
03/09/2026;SUPERMERCADO;;150,00
05/09/2026;SALARIO;7.200,00;`

  it('detecta ponto e vírgula, acento no cabeçalho e decimal com vírgula', () => {
    const r = lerCsv(COM_VALOR_UNICO)

    expect(r.problemas).toEqual([])
    expect(r.registros.map((x) => x.centavos)).toEqual([-15000n, 720000n])
    expect(r.registros[0]?.data).toEqual({ ano: 2026, mes: 9, dia: 3 })
  })

  it('**colunas separadas: o sinal vem da coluna, não do texto**', () => {
    // Um banco exporta `-150,00` na coluna de débito e outro exporta `150,00`.
    // São o mesmo fato, e deixar o sinal vir do texto faria metade dos extratos
    // importar despesa como receita.
    const r = lerCsv(COM_CREDITO_E_DEBITO)

    expect(r.registros.map((x) => x.centavos)).toEqual([-15000n, 720000n])
  })

  it('**`DD/MM`, nunca `MM/DD`**', () => {
    // Aceitar as duas leituras faria `03/09` virar março ou setembro conforme o
    // dia, e o erro só apareceria nos doze dias do ano em que ambos são
    // válidos — precisamente quando ninguém suspeita do parser.
    const r = lerCsv('Data;Descrição;Valor\n03/09/2026;X;-1,00')

    expect(r.registros[0]?.data).toEqual({ ano: 2026, mes: 9, dia: 3 })
  })

  it('respeita aspas na descrição', () => {
    const r = lerCsv('Data;Descrição;Valor\n03/09/2026;"MERCADO, LTDA";-1,00')

    expect(r.registros[0]?.descricao).toBe('MERCADO, LTDA')
  })

  it('**duas linhas idênticas produzem identificadores distintos**', () => {
    // Duas compras iguais no mesmo dia e no mesmo valor são duas compras. Um
    // identificador só de conteúdo as fundiria numa, e o extrato importado
    // ficaria com metade do almoço.
    const r = lerCsv('Data;Descrição;Valor\n03/09/2026;CAFE;-5,00\n03/09/2026;CAFE;-5,00')

    expect(r.registros).toHaveLength(2)
    expect(r.registros[0]?.externalId).not.toBe(r.registros[1]?.externalId)
  })

  it('linha de saldo, com valor zero, é ignorada', () => {
    const r = lerCsv('Data;Descrição;Valor\n03/09/2026;SALDO ANTERIOR;0,00\n03/09/2026;CAFE;-5,00')

    expect(r.registros).toHaveLength(1)
  })

  it('cabeçalho irreconhecível pede escolha manual, e não adivinha', () => {
    // Adivinhar errado produz um extrato plausível com sinal invertido ou dia e
    // mês trocados — a pior falha possível, porque não parece falha.
    const r = lerCsv('A;B;C\n1;2;3')

    expect(r.registros).toEqual([])
    expect(r.problemas[0]?.motivo).toContain('Escolha manualmente')
  })

  it('mapa informado à mão dispensa cabeçalho', () => {
    const r = lerCsv('03/09/2026;CAFE;-5,00', { data: 0, descricao: 1, valor: 2 })

    expect(r.registros).toHaveLength(1)
  })

  it('linha ruim no meio não derruba o arquivo', () => {
    const r = lerCsv('Data;Descrição;Valor\n03/09/2026;A;-1,00\nlixo;B;x\n05/09/2026;C;-2,00')

    expect(r.registros).toHaveLength(2)
    expect(r.problemas).toHaveLength(1)
    expect(r.problemas[0]?.linha).toBe(3)
  })
})

describe('propriedades', () => {
  it('**o identificador do CSV é estável para o mesmo arquivo**', () => {
    // A idempotência da importação depende disso: reimportar o mesmo arquivo
    // precisa produzir as mesmas chaves, senão tudo duplica.
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 99999 }), { minLength: 1, maxLength: 30 }),
        (valores) => {
          const csv =
            'Data;Descrição;Valor\n' +
            valores.map((v, i) => `0${(i % 9) + 1}/09/2026;LINHA ${v};-${v},00`).join('\n')

          const primeira = lerCsv(csv).registros.map((r) => r.externalId)
          const segunda = lerCsv(csv).registros.map((r) => r.externalId)

          expect(segunda).toEqual(primeira)
          expect(new Set(primeira).size).toBe(primeira.length)
        },
      ),
    )
  })

  it('nenhuma entrada faz o parser lançar', () => {
    // O arquivo vem de fora e é hostil por definição. Ele pode produzir zero
    // registros e muitos problemas; **explodir** não é um desfecho aceitável,
    // porque derrubaria o processo que o lê.
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (lixo) => {
        expect(() => lerOfx(lixo)).not.toThrow()
        expect(() => lerCsv(lixo)).not.toThrow()
      }),
    )
  })
})
