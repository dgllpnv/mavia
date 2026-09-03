import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { centavosDe, ValorIlegivel } from './dinheiro.js'

describe('notações que aparecem em arquivo de banco', () => {
  it('americana', () => {
    expect(centavosDe('1234.56')).toBe(123456n)
    expect(centavosDe('-1234.56')).toBe(-123456n)
  })

  it('brasileira, com milhar', () => {
    expect(centavosDe('1.234,56')).toBe(123456n)
    expect(centavosDe('-1.234,56')).toBe(-123456n)
  })

  it('americana com milhar', () => {
    expect(centavosDe('1,234.56')).toBe(123456n)
  })

  it('sem casas decimais', () => {
    expect(centavosDe('1234')).toBe(123400n)
  })

  it('**milhar redondo não vira valor mil vezes menor**', () => {
    // `1.234` é mil duzentos e trinta e quatro, não um e vinte e três. Sem essa
    // distinção o extrato importado fecha com o saldo errado e nenhum erro
    // aparece em lugar nenhum.
    expect(centavosDe('1.234')).toBe(123400n)
    expect(centavosDe('1,234')).toBe(123400n)
  })

  it('**parêntese é negativo**, herança de contabilidade', () => {
    // Um parser ingênuo lê como positivo e inverte o sinal de toda despesa do
    // arquivo — e o mês importado mostra a pessoa ganhando o que gastou.
    expect(centavosDe('(1.234,56)')).toBe(-123456n)
    expect(centavosDe('(1234.56)')).toBe(-123456n)
  })

  it('parêntese com sinal dentro nega duas vezes', () => {
    expect(centavosDe('(-10,00)')).toBe(1000n)
  })

  it('tolera R$, espaço e sinal explícito', () => {
    expect(centavosDe(' R$ 1.234,56 ')).toBe(123456n)
    expect(centavosDe('+50,00')).toBe(5000n)
  })

  it('uma casa decimal é completada', () => {
    expect(centavosDe('12,5')).toBe(1250n)
  })
})

describe('o que ele recusa', () => {
  it('mais de duas casas não é dinheiro', () => {
    // Taxa, cotação ou erro de exportação. Truncar em silêncio inventaria um
    // valor; recusar devolve o problema a quem pode resolvê-lo.
    expect(() => centavosDe('1,2345')).toThrow(ValorIlegivel)
  })

  it('texto, vazio e lixo', () => {
    expect(() => centavosDe('')).toThrow(ValorIlegivel)
    expect(() => centavosDe('abc')).toThrow(ValorIlegivel)
    expect(() => centavosDe('12a,00')).toThrow(ValorIlegivel)
    expect(() => centavosDe('--10')).toThrow(ValorIlegivel)
  })
})

describe('propriedades', () => {
  it('**a ida e a volta fecham, para qualquer valor**', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }),
        (centavos) => {
          const negativo = centavos < 0n
          const abs = negativo ? -centavos : centavos
          const texto = `${negativo ? '-' : ''}${abs / 100n},${(abs % 100n)
            .toString()
            .padStart(2, '0')}`

          expect(centavosDe(texto)).toBe(centavos)
        },
      ),
    )
  })

  it('nenhum valor passa por ponto flutuante', () => {
    // O caso que `parseFloat(x) * 100` erra: 1234.56 dá 123455.99999999999.
    // Aqui o resultado é exato por construção, e a propriedade cobre toda a
    // faixa em que o `double` já perdeu precisão.
    fc.assert(
      fc.property(fc.bigInt({ min: 10n ** 14n, max: 10n ** 17n }), (centavos) => {
        const texto = `${centavos / 100n}.${(centavos % 100n).toString().padStart(2, '0')}`
        expect(centavosDe(texto)).toBe(centavos)
      }),
    )
  })

  it('o sinal do texto é o sinal do resultado', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000 }), (n) => {
        expect(centavosDe(`-${n},00`)).toBe(BigInt(-n) * 100n)
        expect(centavosDe(`${n},00`)).toBe(BigInt(n) * 100n)
        expect(centavosDe(`(${n},00)`)).toBe(BigInt(-n) * 100n)
      }),
    )
  })
})
