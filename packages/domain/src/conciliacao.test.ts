import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { conciliar, semelhanca, PISO_DE_CONFIANCA, type Candidato } from './conciliacao.js'

const dia = (d: number) => ({ ano: 2026, mes: 9, dia: d })

const candidato = (over: Partial<Candidato> = {}): Candidato => ({
  id: 'c1',
  centavos: -15000n,
  data: dia(3),
  descricao: 'Mercado',
  jaConciliado: false,
  ...over,
})

const importado = { centavos: -15000n, data: dia(3), descricao: 'SUPERMERCADO BOM PRECO' }

describe('valor exato', () => {
  it('mesmo valor e mesmo dia é a sugestão mais forte', () => {
    const s = conciliar(importado, [candidato()])

    expect(s?.candidatoId).toBe('c1')
    expect(s?.confianca).toBeGreaterThanOrEqual(PISO_DE_CONFIANCA)
    expect(s?.motivo).toBe('Mesmo valor, mesmo dia.')
  })

  it('**um centavo de diferença não casa**', () => {
    // Dinheiro é exato. Um candidato com valor diferente é outro fato, por mais
    // parecido que seja o resto — e tolerar um centavo aqui abriria a porta para
    // tolerar dez.
    expect(conciliar(importado, [candidato({ centavos: -15001n })])).toBeNull()
  })

  it('sinal diferente não casa', () => {
    expect(conciliar(importado, [candidato({ centavos: 15000n })])).toBeNull()
  })

  it('candidato já conciliado está fora do jogo', () => {
    expect(conciliar(importado, [candidato({ jaConciliado: true })])).toBeNull()
  })
})

describe('a folga de data, e por que ela é assimétrica', () => {
  it('o manual pode anteceder o extrato em vários dias', () => {
    // A pessoa digita no dia da compra; o banco lança um a três dias depois.
    expect(conciliar(importado, [candidato({ data: dia(1) })])).not.toBeNull()
  })

  it('mas o banco raramente lança adiantado', () => {
    // Cinco dias **depois** do extrato não é a mesma compra: é outra.
    expect(conciliar(importado, [candidato({ data: dia(8) })])).toBeNull()
  })

  it('muito antes também não casa', () => {
    expect(conciliar(importado, [candidato({ data: dia(3 - 10) })])).toBeNull()
  })

  it('quanto mais perto, mais confiança', () => {
    const perto = conciliar(importado, [candidato({ data: dia(3) })])
    const longe = conciliar(importado, [candidato({ id: 'c2', data: dia(1) })])

    expect(perto!.confianca).toBeGreaterThan(longe!.confianca)
  })
})

describe('empate', () => {
  it('**dois candidatos igualmente bons não viram sugestão**', () => {
    // A informação disponível não decide. Uma sugestão errada confirmada no
    // automático é pior do que nenhuma sugestão.
    const s = conciliar(importado, [
      candidato({ id: 'a', descricao: 'Mercado' }),
      candidato({ id: 'b', descricao: 'Mercado' }),
    ])

    expect(s).toBeNull()
  })

  it('a descrição desempata quando ela de fato distingue', () => {
    const s = conciliar(importado, [
      candidato({ id: 'a', descricao: 'Supermercado Bom Preco' }),
      candidato({ id: 'b', descricao: 'Farmácia' }),
    ])

    expect(s?.candidatoId).toBe('a')
  })

  it('**a descrição sozinha nunca sustenta o casamento**', () => {
    // `Deduplicacao nunca depende só da descrição`. Descrição idêntica e data
    // fora da folga continua não casando.
    const s = conciliar(importado, [
      candidato({ descricao: 'SUPERMERCADO BOM PRECO', data: dia(25) }),
    ])

    expect(s).toBeNull()
  })
})

describe('semelhança de texto', () => {
  it('ignora acento e caixa', () => {
    expect(semelhanca('FARMÁCIA', 'farmacia')).toBe(1)
  })

  it('**"MERCADO SP" e "MERCADO RJ" não são a mesma coisa**', () => {
    // Uma métrica de caracteres daria 0,6 para lugares diferentes.
    expect(semelhanca('MERCADO SP', 'MERCADO RJ')).toBeLessThan(0.7)
  })

  it('descarta palavras de até duas letras', () => {
    // `DE`, `DA`, `LT` aparecem em tudo e não distinguem nada.
    expect(semelhanca('POSTO DE GASOLINA', 'POSTO DA ESQUINA')).toBeLessThan(0.6)
  })

  it('sem palavras significativas, semelhança zero', () => {
    expect(semelhanca('DE DA', 'DO NO')).toBe(0)
  })
})

describe('propriedades', () => {
  const centavos = fc.bigInt({ min: -(10n ** 9n), max: 10n ** 9n }).filter((c) => c !== 0n)

  it('**nenhum candidato de valor diferente é sugerido, nunca**', () => {
    fc.assert(
      fc.property(centavos, centavos, fc.integer({ min: 1, max: 28 }), (a, b, d) => {
        fc.pre(a !== b)
        const s = conciliar(
          { centavos: a, data: dia(15), descricao: 'X' },
          [candidato({ centavos: b, data: dia(d), descricao: 'X' })],
        )
        expect(s).toBeNull()
      }),
    )
  })

  it('a confiança fica entre o piso e 100', () => {
    fc.assert(
      fc.property(centavos, fc.integer({ min: 10, max: 20 }), (v, d) => {
        const s = conciliar(
          { centavos: v, data: dia(15), descricao: 'MERCADO CENTRAL' },
          [candidato({ centavos: v, data: dia(d), descricao: 'Mercado Central' })],
        )
        if (s) {
          expect(s.confianca).toBeGreaterThanOrEqual(PISO_DE_CONFIANCA)
          expect(s.confianca).toBeLessThanOrEqual(100)
        }
      }),
    )
  })

  it('a semelhança é simétrica e vai de 0 a 1', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (a, b) => {
        const s = semelhanca(a, b)
        expect(s).toBe(semelhanca(b, a))
        expect(s).toBeGreaterThanOrEqual(0)
        expect(s).toBeLessThanOrEqual(1)
      }),
    )
  })
})
