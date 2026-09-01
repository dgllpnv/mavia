import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { dinheiro, ehZero, negar, somar, somarLista, type Moeda, type Money } from './money.js'
import { ratear } from './ratear.js'

/**
 * Testes baseados em propriedade — obrigatórios onde há aritmética monetária
 * (`CLAUDE.md` §2, regra 3; ADR 0005).
 *
 * Exemplo escolhido a dedo não prova propriedade aritmética. Estes testes
 * guardam as invariantes contra *qualquer* entrada, e não contra a meia dúzia
 * de casos que alguém lembrou de escrever.
 */

const centavos = fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n })
const numeroDePartes = fc.integer({ min: 1, max: 360 }) // 360 = 30 anos de parcelas
const moedas = fc.constantFrom<Moeda>('BRL', 'USD', 'EUR')
const brl = (v: bigint): Money => dinheiro(v, 'BRL')

const somaDe = (partes: readonly Money[]): bigint =>
  partes.reduce((acc, p) => acc + p.centavos, 0n)

const maiorMenos = (partes: readonly Money[]): bigint => {
  const valores = partes.map((p) => p.centavos)
  const primeiro = valores[0]
  if (primeiro === undefined) return 0n
  let maior = primeiro
  let menor = primeiro
  for (const v of valores) {
    if (v > maior) maior = v
    if (v < menor) menor = v
  }
  return maior - menor
}

describe('ratear — invariantes', () => {
  it('a soma das partes é exatamente igual ao total', () => {
    fc.assert(
      fc.property(centavos, numeroDePartes, (total, partes) => {
        const r = ratear(brl(total), partes)
        expect(r.ok).toBe(true)
        if (!r.ok) return
        expect(somaDe(r.valor)).toBe(total)
      }),
    )
  })

  it('nenhuma parte difere de outra em mais de um centavo', () => {
    // Esta é a propriedade que distingue a regra adotada da regra rejeitada.
    // A propriedade da soma passa nas duas; só esta reprova a outra.
    fc.assert(
      fc.property(centavos, numeroDePartes, (total, partes) => {
        const r = ratear(brl(total), partes)
        if (!r.ok) return
        expect(maiorMenos(r.valor) <= 1n).toBe(true)
      }),
    )
  })

  it('devolve exatamente o número de partes pedido', () => {
    fc.assert(
      fc.property(centavos, numeroDePartes, (total, partes) => {
        const r = ratear(brl(total), partes)
        expect(r.ok && r.valor.length).toBe(partes)
      }),
    )
  })

  it('ratear o negativo é negar cada parte do positivo', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), numeroDePartes, (magnitude, partes) => {
        const positivo = ratear(brl(magnitude), partes)
        const negativo = ratear(brl(-magnitude), partes)
        if (!positivo.ok || !negativo.ok) return
        expect(negativo.valor.map((p) => p.centavos)).toEqual(
          positivo.valor.map((p) => negar(p).centavos),
        )
      }),
    )
  })

  it('nenhuma parte tem sinal contrário ao do total', () => {
    fc.assert(
      fc.property(centavos, numeroDePartes, (total, partes) => {
        const r = ratear(brl(total), partes)
        if (!r.ok) return
        for (const parte of r.valor) {
          if (total >= 0n) expect(parte.centavos >= 0n).toBe(true)
          else expect(parte.centavos <= 0n).toBe(true)
        }
      }),
    )
  })

  it('as partes são não-crescentes em magnitude', () => {
    fc.assert(
      fc.property(centavos, numeroDePartes, (total, partes) => {
        const r = ratear(brl(total), partes)
        if (!r.ok) return
        const magnitudes = r.valor.map((p) => (p.centavos < 0n ? -p.centavos : p.centavos))
        for (let i = 1; i < magnitudes.length; i++) {
          const anterior = magnitudes[i - 1]
          const atual = magnitudes[i]
          if (anterior === undefined || atual === undefined) continue
          expect(anterior >= atual).toBe(true)
        }
      }),
    )
  })

  it('preserva a moeda em todas as partes', () => {
    fc.assert(
      fc.property(centavos, numeroDePartes, moedas, (total, partes, moeda) => {
        const r = ratear(dinheiro(total, moeda), partes)
        if (!r.ok) return
        expect(r.valor.every((p) => p.moeda === moeda)).toBe(true)
      }),
    )
  })

  it('é determinístico: a mesma entrada produz sempre a mesma saída', () => {
    fc.assert(
      fc.property(centavos, numeroDePartes, (total, partes) => {
        const a = ratear(brl(total), partes)
        const b = ratear(brl(total), partes)
        expect(a).toEqual(b)
      }),
    )
  })
})

describe('a propriedade tem dentes', () => {
  it('a regra rejeitada — todo o resto na primeira parte — viola max menos min <= 1', () => {
    // Prova que a asserção acima não é decorativa: ela reprova a outra regra.
    const regraRejeitada = (total: bigint, partes: number): bigint[] => {
      const n = BigInt(partes)
      const base = total / n
      const resto = total % n
      return Array.from({ length: partes }, (_, i) => (i === 0 ? base + resto : base))
    }

    const rejeitada = regraRejeitada(10000n, 7)
    const adotada = ratear(brl(10000n), 7)

    expect(rejeitada.reduce((a, b) => a + b, 0n)).toBe(10000n) // soma certo, e ainda assim
    expect(Math.max(...rejeitada.map(Number)) - Math.min(...rejeitada.map(Number))).toBe(4)
    expect(adotada.ok && maiorMenos(adotada.valor)).toBe(1n)
  })
})

describe('somar — invariantes', () => {
  it('é comutativa', () => {
    fc.assert(
      fc.property(centavos, centavos, (a, b) => {
        const ab = somar(brl(a), brl(b))
        const ba = somar(brl(b), brl(a))
        expect(ab.ok && ab.valor.centavos).toBe(ba.ok && ba.valor.centavos)
      }),
    )
  })

  it('é associativa', () => {
    fc.assert(
      fc.property(centavos, centavos, centavos, (a, b, c) => {
        const esquerda = somar(brl(a), brl(b))
        const direita = somar(brl(b), brl(c))
        if (!esquerda.ok || !direita.ok) return
        const um = somar(esquerda.valor, brl(c))
        const outro = somar(brl(a), direita.valor)
        expect(um.ok && um.valor.centavos).toBe(outro.ok && outro.valor.centavos)
      }),
    )
  })

  it('somar o oposto devolve zero', () => {
    fc.assert(
      fc.property(centavos, (a) => {
        const r = somar(brl(a), negar(brl(a)))
        expect(r.ok && ehZero(r.valor)).toBe(true)
      }),
    )
  })
})

describe('somarLista — invariantes', () => {
  it('independe da ordem dos lançamentos', () => {
    fc.assert(
      fc.property(fc.array(centavos, { maxLength: 200 }), (valores) => {
        const original = somarLista(valores.map(brl), 'BRL')
        const invertida = somarLista([...valores].reverse().map(brl), 'BRL')
        expect(original.ok && original.valor.centavos).toBe(invertida.ok && invertida.valor.centavos)
      }),
    )
  })

  it('somar as partes de um rateio devolve o total de volta', () => {
    // Fecha o ciclo: rateio e soma são inversos, e é isso que faz uma compra
    // parcelada nunca criar nem sumir com centavo ao longo do parcelamento.
    fc.assert(
      fc.property(centavos, numeroDePartes, (total, partes) => {
        const r = ratear(brl(total), partes)
        if (!r.ok) return
        const devolta = somarLista(r.valor, 'BRL')
        expect(devolta.ok && devolta.valor.centavos).toBe(total)
      }),
    )
  })
})
