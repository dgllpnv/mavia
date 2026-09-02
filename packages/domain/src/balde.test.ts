import { describe, expect, it } from 'vitest'
import { baldeDe, BALDES, type Balde, type LancamentoClassificavel } from './balde.js'

/**
 * A classificação em baldes — `docs/adr/0022-balde-exaustivo.md`.
 *
 * O enum é fechado e a função é total. Isso não é rigor decorativo: a grandeza
 * que não tem balde é a que altera o saldo e não aparece no rodapé, e foi
 * exatamente assim que o defeito B1 nasceu — e reapareceu um nível abaixo.
 */

const lanc = (p: Partial<LancamentoClassificavel>): LancamentoClassificavel => ({
  transferGroupId: null,
  categoria: { analitica: true, natureza: 'despesa' },
  ...p,
})

describe('baldeDe', () => {
  it('perna de transferência vai para o balde próprio', () => {
    expect(baldeDe(lanc({ transferGroupId: 'grupo-1' }))).toBe('transferencia')
  })

  it('categoria não analítica tem balde próprio', () => {
    // "Ajuste de saldo" altera o saldo e não é gasto nem ganho. Sem balde, ele
    // move o saldo sem aparecer no rodapé — a identidade não fecha.
    expect(baldeDe(lanc({ categoria: { analitica: false, natureza: 'despesa' } }))).toBe(
      'nao_analitica',
    )
  })

  it('classifica pela natureza da categoria, nunca pelo sinal', () => {
    expect(baldeDe(lanc({ categoria: { analitica: true, natureza: 'receita' } }))).toBe('receita')
    expect(baldeDe(lanc({ categoria: { analitica: true, natureza: 'despesa' } }))).toBe('despesa')
  })

  it('um estorno de despesa continua no balde de despesa, mesmo sendo positivo', () => {
    // O defeito ES-1. Particionando por sinal, um estorno de R$ 100,00 numa
    // categoria de despesa vira `receita_realizada = +10000` — receita
    // inventada — e deixa `despesa_realizada` maior do que o usuário gastou.
    //
    // O sinal governa a SOMA. A natureza governa o BALDE.
    const estornoDeDespesa = lanc({ categoria: { analitica: true, natureza: 'despesa' } })

    expect(baldeDe(estornoDeDespesa)).toBe('despesa')
  })

  it('transferência vence a natureza: perna de transferência não tem categoria', () => {
    expect(
      baldeDe({ transferGroupId: 'g', categoria: { analitica: true, natureza: 'receita' } }),
    ).toBe('transferencia')
  })
})

describe('a função é total', () => {
  it('toda combinação de entrada produz um balde conhecido', () => {
    const conhecidos = new Set<Balde>(BALDES)

    for (const transferGroupId of [null, 'g']) {
      for (const analitica of [true, false]) {
        for (const natureza of ['receita', 'despesa'] as const) {
          const b = baldeDe({ transferGroupId, categoria: { analitica, natureza } })
          expect(conhecidos.has(b)).toBe(true)
        }
      }
    }
  })

  it('BALDES lista exatamente os quatro valores do enum', () => {
    // A lista existe para percorrer o resumo sem escrever campo à mão. Se um
    // balde novo nascer e não entrar aqui, o resumo o esqueceria em silêncio.
    expect([...BALDES].sort()).toEqual(['despesa', 'nao_analitica', 'receita', 'transferencia'])
  })
})
