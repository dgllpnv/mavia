import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { corDaCategoria, SLOTS_DE_DADO } from './cor-de-dado.js'

/**
 * Atribuição de cor de dado — `docs/design/direcao-visual.md` §2.8.
 *
 * A regra: a cor é atribuída por **entidade**, nunca por posição ou por rank.
 * É a diferença entre um gráfico que se pode ler duas vezes e um que se lê uma
 * vez só — se filtrar uma categoria repinta as sobreviventes, o usuário perde
 * a única âncora que tinha para comparar dois meses.
 */

const ALIMENTACAO = 'c1a4f0de-0000-4000-8000-000000000001'
const TRANSPORTE = 'c1a4f0de-0000-4000-8000-000000000002'

describe('corDaCategoria', () => {
  it('a mesma categoria recebe sempre a mesma cor', () => {
    expect(corDaCategoria(ALIMENTACAO)).toBe(corDaCategoria(ALIMENTACAO))
  })

  it('a cor não depende de quem mais está no gráfico', () => {
    // O teste que expressa a regra inteira: a função não recebe a lista. Se
    // recebesse, alguém acabaria ordenando por valor lá dentro.
    expect(corDaCategoria.length).toBe(1)
  })

  it('devolve sempre um dos seis slots, e nunca a cor de "Outros"', () => {
    // "Outros" é um agregado, não uma categoria: ele vem por último e não
    // ocupa slot. Emprestar um slot a ele tiraria a cor de uma categoria real.
    for (const id of [ALIMENTACAO, TRANSPORTE, 'qualquer-coisa', '']) {
      expect(SLOTS_DE_DADO).toContain(corDaCategoria(id))
    }
  })

  it('devolve a variável de token, não um hex solto', () => {
    // Hex no componente quebraria o modo escuro em silêncio: a paleta de dados
    // tem valores distintos nos dois temas, e só o token conhece os dois.
    expect(corDaCategoria(ALIMENTACAO)).toMatch(/^var\(--dado-[1-6]\)$/)
  })

  it('duas categorias comuns não caem na mesma cor', () => {
    expect(corDaCategoria(ALIMENTACAO)).not.toBe(corDaCategoria(TRANSPORTE))
  })
})

describe('propriedades da atribuição', () => {
  it('é uma função total: qualquer identificador recebe cor', () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        expect(SLOTS_DE_DADO).toContain(corDaCategoria(id))
      }),
      { numRuns: 1000 },
    )
  })

  it('é determinística: mil chamadas, um resultado', () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        expect(corDaCategoria(id)).toBe(corDaCategoria(id))
      }),
      { numRuns: 1000 },
    )
  })

  it('distribui razoavelmente pelos seis slots', () => {
    // Não é uma exigência estética: se 80% das categorias caíssem no slot 1, o
    // gráfico teria seis fatias da mesma cor e a paleta não serviria para nada.
    const contagem = new Map<string, number>()
    for (let i = 0; i < 600; i++) {
      const cor = corDaCategoria(`categoria-${i}`)
      contagem.set(cor, (contagem.get(cor) ?? 0) + 1)
    }

    expect(contagem.size).toBe(6)
    for (const n of contagem.values()) {
      // Uniforme daria 100. Uma folga larga: o teste protege contra hash
      // degenerado, não contra desvio estatístico.
      expect(n).toBeGreaterThan(40)
      expect(n).toBeLessThan(180)
    }
  })
})
