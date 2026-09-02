import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { dinheiro } from './money.js'
import { partesDoValor, rotuloAcessivel, valorEmTexto } from './formatar.js'

/**
 * Composição de valor monetário — `docs/design/direcao-visual.md` §3.4 e §3.5.
 *
 * O formatador devolve **partes**, não uma string. A direção visual pede que o
 * símbolo, o sinal e os centavos tenham tamanho e cor próprios em contexto
 * isolado, e uma string pronta obrigaria a interface a fatiá-la de volta com
 * expressão regular — que é onde o `R$` de um valor negativo vira o `−`.
 */

const brl = (c: bigint) => dinheiro(c, 'BRL')

describe('partesDoValor', () => {
  it('decompõe uma despesa em sinal, símbolo, inteiro e decimais', () => {
    expect(partesDoValor(brl(-111600n))).toEqual({
      sinal: '−',
      simbolo: 'R$',
      inteiro: '1.116',
      separador: ',',
      decimais: '00',
    })
  })

  it('rende o `+` da receita, e não só o `−` da despesa', () => {
    // O Organizze só mostra o `−`. A ausência de sinal é sinal fraco demais
    // para quem não distingue verde de vermelho (§3.5, canal 1).
    expect(partesDoValor(brl(720000n)).sinal).toBe('+')
  })

  it('usa o sinal de menos tipográfico, nunca o hífen', () => {
    // U+2212 alinha com os dígitos; U+002D é mais curto e sobe a linha de
    // base, o que estraga a coluna de sinal que a §3.3 reserva.
    expect(partesDoValor(brl(-100n)).sinal).toBe('−')
    expect(partesDoValor(brl(-100n)).sinal).not.toBe('-')
  })

  it('zero não tem sinal, mas a posição continua reservada', () => {
    // Zero não é receita nem despesa. Um `+` aqui afirmaria entrada de
    // dinheiro que não houve.
    expect(partesDoValor(brl(0n)).sinal).toBe('')
  })

  it('agrupa o milhar com ponto, à brasileira', () => {
    expect(partesDoValor(brl(100000n)).inteiro).toBe('1.000')
    expect(partesDoValor(brl(99999999n)).inteiro).toBe('999.999')
    expect(partesDoValor(brl(123456789n)).inteiro).toBe('1.234.567')
  })

  it('mantém os dois decimais em valores abaixo de um real', () => {
    expect(partesDoValor(brl(5n))).toMatchObject({ inteiro: '0', decimais: '05' })
    expect(partesDoValor(brl(-5n))).toMatchObject({ sinal: '−', inteiro: '0', decimais: '05' })
  })

  it('nunca leva o sinal para dentro do número', () => {
    // O sinal mora em coluna própria (§3.3). Se ele vazasse para `inteiro`, a
    // coluna de valor perderia o alinhamento pelo `R$` em toda linha negativa.
    const p = partesDoValor(brl(-111600n))

    expect(p.inteiro).not.toContain('-')
    expect(p.inteiro).not.toContain('−')
  })

  it('formata o valor mais alto que o produto admite sem perder dígito', () => {
    // `bigint` e não `number`: em ponto flutuante este valor já perdeu
    // precisão antes de chegar aqui.
    expect(partesDoValor(brl(999999999999999n))).toMatchObject({
      inteiro: '9.999.999.999.999',
      decimais: '99',
    })
  })

  it('cada moeda traz o próprio símbolo', () => {
    expect(partesDoValor(dinheiro(1000n, 'USD')).simbolo).toBe('US$')
    expect(partesDoValor(dinheiro(1000n, 'EUR')).simbolo).toBe('€')
  })
})

describe('valorEmTexto', () => {
  it('junta as partes na ordem em que se lê', () => {
    expect(valorEmTexto(brl(-111600n))).toBe('−R$ 1.116,00')
    expect(valorEmTexto(brl(720000n))).toBe('+R$ 7.200,00')
    expect(valorEmTexto(brl(0n))).toBe('R$ 0,00')
  })
})

describe('rotuloAcessivel', () => {
  it('nomeia a natureza em palavras, e não deixa o leitor soletrar o glifo', () => {
    expect(rotuloAcessivel(brl(-111600n), { status: 'efetivado' })).toBe(
      'despesa de R$ 1.116,00, efetivado',
    )
  })

  it('receita é receita, não "mais"', () => {
    expect(rotuloAcessivel(brl(720000n), { status: 'previsto' })).toBe(
      'receita de R$ 7.200,00, previsto',
    )
  })

  it('transferência não é receita nem despesa, mesmo tendo sinal', () => {
    // Ler a perna de débito de uma transferência como "despesa" reintroduz,
    // no áudio, exatamente a confusão que a regra 12b evita nos totais.
    expect(rotuloAcessivel(brl(-50000n), { status: 'efetivado', transferencia: true })).toBe(
      'transferência de R$ 500,00, efetivado',
    )
  })

  it('sem status, não inventa um', () => {
    expect(rotuloAcessivel(brl(-111600n), {})).toBe('despesa de R$ 1.116,00')
  })

  it('o rótulo não contém o glifo de menos', () => {
    // O leitor de tela diria "menos" solto antes de "despesa", que é ruído.
    expect(rotuloAcessivel(brl(-111600n), {})).not.toContain('−')
  })
})

describe('propriedades do formatador', () => {
  /**
   * A propriedade que vale a pena: **o formato não perde informação.**
   *
   * Um exemplo escolhido a dedo prova que `1.116,00` sai certo. Só o ida-e-volta
   * sobre entrada arbitrária prova que não existe magnitude em que o
   * agrupamento come um dígito — que é o defeito que um formatador escrito à
   * mão tem, e sempre na casa dos milhões.
   */
  const desformatar = (p: {
    sinal: string
    inteiro: string
    decimais: string
  }): bigint => {
    const magnitude = BigInt(p.inteiro.replaceAll('.', '') + p.decimais)
    return p.sinal === '−' ? -magnitude : magnitude
  }

  it('formatar e ler de volta devolve exatamente os mesmos centavos', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), (centavos) => {
        const m = dinheiro(centavos, 'BRL')

        expect(desformatar(partesDoValor(m))).toBe(centavos)
      }),
      { numRuns: 2000 },
    )
  })

  it('o sinal concorda com o sinal do valor, sempre', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), (centavos) => {
        const sinal = partesDoValor(dinheiro(centavos, 'BRL')).sinal

        if (centavos < 0n) expect(sinal).toBe('−')
        else if (centavos > 0n) expect(sinal).toBe('+')
        else expect(sinal).toBe('')
      }),
      { numRuns: 1000 },
    )
  })

  it('os decimais têm sempre exatamente dois dígitos', () => {
    // `padStart` errado aqui produz "R$ 10,5" em vez de "R$ 10,05" — um fator
    // de dez na tela, com o número certo no banco.
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), (centavos) => {
        expect(partesDoValor(dinheiro(centavos, 'BRL')).decimais).toMatch(/^\d{2}$/)
      }),
      { numRuns: 1000 },
    )
  })

  it('o agrupamento nunca começa nem termina com ponto', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), (centavos) => {
        const inteiro = partesDoValor(dinheiro(centavos, 'BRL')).inteiro

        expect(inteiro.startsWith('.')).toBe(false)
        expect(inteiro.endsWith('.')).toBe(false)
        expect(inteiro).not.toContain('..')
      }),
      { numRuns: 1000 },
    )
  })
})
