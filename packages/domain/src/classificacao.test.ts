import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  assinatura,
  classificar,
  PISO_DE_CONFIANCA,
  REPETICOES_MINIMAS,
  type Historico,
  type RegraDoUsuario,
} from './classificacao.js'

const regra = (over: Partial<RegraDoUsuario> = {}): RegraDoUsuario => ({
  id: 'r1',
  tipo: 'contem',
  padrao: 'mercado',
  categoriaId: 'alimentacao',
  prioridade: 100,
  ...over,
})

const h = (assinatura: string, categoriaId: string, vezes: number): Historico => ({
  assinatura,
  categoriaId,
  vezes,
})

describe('assinatura', () => {
  it('**remove o que varia entre ocorrências do mesmo lugar**', () => {
    // Extratos repetem o estabelecimento e variam o resto. Sem isso, o
    // histórico nunca acumula repetição e o sistema não aprende nada.
    expect(assinatura('MERCADO SAO JOSE 0912')).toBe('mercado sao jose')
    expect(assinatura('MERCADO SAO JOSE 1014')).toBe('mercado sao jose')
    expect(assinatura('MERCADO SAO JOSE*PARC 2/3')).toBe('mercado sao jose parc')
  })

  it('**números somem inteiros, e não só os longos**', () => {
    // Um filtro por comprimento deixaria `LOJA 5` e `LOJA 7` distintos.
    expect(assinatura('LOJA 5')).toBe(assinatura('LOJA 7'))
  })

  it('ignora acento e caixa', () => {
    expect(assinatura('FARMÁCIA')).toBe(assinatura('farmacia'))
  })

  it('descrição sem palavra vira vazio', () => {
    expect(assinatura('12345 -- 99')).toBe('')
  })
})

describe('regra do usuário', () => {
  it('classifica pelo que a pessoa escreveu, com o motivo em português', () => {
    const c = classificar('MERCADO SAO JOSE 0912', [regra()], [])

    expect(c?.categoriaId).toBe('alimentacao')
    expect(c?.origem).toBe('regra')
    expect(c?.confianca).toBe(100)
    expect(c?.motivo).toBe('Pela sua regra: descrição contém "mercado".')
  })

  it('**regra vence histórico, mesmo com histórico unânime**', () => {
    // Quem escreveu a regra decidiu; o histórico é inferência. Inverter a
    // ordem faria o sistema discordar de uma instrução explícita.
    const c = classificar(
      'MERCADO SAO JOSE',
      [regra({ categoriaId: 'da-regra' })],
      [h('mercado sao jose', 'do-historico', 30)],
    )

    expect(c?.categoriaId).toBe('da-regra')
  })

  it('a de menor prioridade numérica vence', () => {
    const c = classificar(
      'MERCADO SAO JOSE',
      [regra({ id: 'a', prioridade: 200, categoriaId: 'segunda' }),
       regra({ id: 'b', prioridade: 1, categoriaId: 'primeira' })],
      [],
    )

    expect(c?.categoriaId).toBe('primeira')
  })

  it('**no empate de prioridade, a mais específica ganha**', () => {
    // "mercado sao jose" é mais informativa que "mercado", e quem escreveu as
    // duas quis a exceção.
    const c = classificar(
      'MERCADO SAO JOSE',
      [regra({ id: 'a', padrao: 'mercado', categoriaId: 'generica' }),
       regra({ id: 'b', padrao: 'mercado sao jose', categoriaId: 'especifica' })],
      [],
    )

    expect(c?.categoriaId).toBe('especifica')
  })

  it('`começa com` não casa no meio', () => {
    const c = classificar('PAGAMENTO MERCADO', [regra({ tipo: 'comeca_com' })], [])

    expect(c).toBeNull()
  })

  it('`igual` exige a assinatura inteira', () => {
    expect(classificar('MERCADO SAO JOSE', [regra({ tipo: 'igual' })], [])).toBeNull()
    expect(
      classificar('MERCADO 123', [regra({ tipo: 'igual', padrao: 'mercado' })], []),
    ).not.toBeNull()
  })
})

describe('histórico do próprio espaço', () => {
  it('classifica depois de repetição suficiente', () => {
    const c = classificar('MERCADO SAO JOSE 99', [], [h('mercado sao jose', 'alimentacao', 4)])

    expect(c?.categoriaId).toBe('alimentacao')
    expect(c?.origem).toBe('historico')
    expect(c?.motivo).toBe('Você classificou assim as 4 vezes anteriores.')
  })

  it('**uma ocorrência só não ensina nada**', () => {
    // Classificar pela primeira faria um erro se propagar para sempre a partir
    // de si mesmo.
    expect(classificar('MERCADO', [], [h('mercado', 'x', 1)])).toBeNull()
    expect(classificar('MERCADO', [], [h('mercado', 'x', REPETICOES_MINIMAS)])).not.toBeNull()
  })

  it('**histórico dividido não decide**', () => {
    // Dez ocorrências cinco a cinco não sabem nada; três iguais sabem.
    const c = classificar('MERCADO', [], [h('mercado', 'a', 5), h('mercado', 'b', 5)])

    expect(c).toBeNull()
  })

  it('maioria folgada decide, e o motivo diz a proporção', () => {
    const c = classificar('MERCADO', [], [h('mercado', 'a', 9), h('mercado', 'b', 1)])

    expect(c?.categoriaId).toBe('a')
    expect(c?.motivo).toBe('Você classificou assim 9 de 10 vezes anteriores.')
  })

  it('**só a assinatura exata**', () => {
    // Casar por prefixo espalharia a classificação de "MERCADO SAO JOSE" para
    // todo "MERCADO", e o usuário veria uma decisão que não consegue explicar.
    expect(classificar('MERCADO CENTRAL', [], [h('mercado sao jose', 'x', 10)])).toBeNull()
  })

  it('espaço novo não classifica nada, e é honesto sobre isso', () => {
    expect(classificar('QUALQUER COISA', [], [])).toBeNull()
  })
})

describe('propriedades', () => {
  it('**toda classificação tem motivo não vazio**', () => {
    // A garantia do glossário: "sempre com o motivo visível". Uma sugestão sem
    // explicação é uma sugestão que ninguém consegue contestar.
    fc.assert(
      fc.property(
        fc.string({ minLength: 3, maxLength: 30 }),
        fc.integer({ min: 2, max: 50 }),
        (texto, vezes) => {
          const assinada = assinatura(texto)
          fc.pre(assinada !== '')

          const c = classificar(texto, [], [h(assinada, 'cat', vezes)])
          if (c) {
            expect(c.motivo.length).toBeGreaterThan(0)
            expect(c.confianca).toBeGreaterThanOrEqual(PISO_DE_CONFIANCA)
          }
        },
      ),
    )
  })

  it('a assinatura é estável: mesma entrada, mesma saída', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (t) => {
        expect(assinatura(t)).toBe(assinatura(t))
      }),
    )
  })

  it('nenhuma entrada faz a classificação lançar', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (t) => {
        expect(() => classificar(t, [regra()], [h('x', 'y', 3)])).not.toThrow()
      }),
    )
  })
})
