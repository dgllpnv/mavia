import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  aposTentativa,
  criarMutacao,
  precisamDeAtencao,
  pendentes,
  proxima,
  recuoEmMs,
  tentarDeNovo,
  TENTATIVAS_ATE_DESISTIR,
  type Mutacao,
} from './fila.js'

const nova = (id: string, criadaEm: number): Mutacao =>
  criarMutacao(
    { id, metodo: 'POST', caminho: '/lancamentos', corpo: { v: id }, tenantId: 't' },
    criadaEm,
  )

describe('ordem', () => {
  it('a mais antiga sobe primeiro, independentemente da ordem na lista', () => {
    // Uma transferência criada depois de uma conta depende dela. Subir fora de
    // ordem produziria erros que o usuário não causou.
    const fila = [nova('c', 300), nova('a', 100), nova('b', 200)]

    expect(proxima(fila, 1000)?.id).toBe('a')
  })

  it('**a primeira da ordem em recuo segura as de trás**', () => {
    // Furar a ordem para "adiantar" a próxima é exatamente o erro que a ordem
    // existe para evitar.
    const primeira = { ...nova('a', 100), tentativas: 1, tentarApos: 5000 }
    const fila = [primeira, nova('b', 200)]

    expect(proxima(fila, 1000)).toBeNull()
    expect(proxima(fila, 6000)?.id).toBe('a')
  })

  it('quem precisa de atenção não bloqueia a fila', () => {
    // Ela já não vai subir sozinha: segurar as de trás por causa dela pararia o
    // app inteiro por causa de um lançamento recusado.
    const travada: Mutacao = { ...nova('a', 100), estado: 'precisa_de_atencao' }
    const fila = [travada, nova('b', 200)]

    expect(proxima(fila, 1000)?.id).toBe('b')
  })

  it('fila vazia devolve nada', () => {
    expect(proxima([], 1000)).toBeNull()
  })
})

describe('depois da tentativa', () => {
  const m = nova('a', 100)

  it('sucesso tira da fila', () => {
    expect(aposTentativa(m, { status: 201 }, 1000)).toBeNull()
  })

  it('**409 pede atenção, e não é tratado como "já aconteceu"**', () => {
    // A retentativa de algo que já subiu não recebe 409: recebe a resposta
    // guardada, com o status original. O 409 significa a outra coisa — esta
    // chave já foi usada para outra operação —, e tratá-lo como sucesso
    // descartaria em silêncio uma intenção que nunca chegou a acontecer.
    const depois = aposTentativa(m, { status: 409 }, 1000)

    expect(depois).not.toBeNull()
    expect(depois?.estado).toBe('precisa_de_atencao')
  })

  it('a retentativa do que já subiu recebe 201 e sai limpa', () => {
    // O desfecho de verdade da fila offline: o servidor devolve a resposta
    // guardada, e para o app é indistinguível de ter dado certo de primeira.
    expect(aposTentativa({ ...m, tentativas: 3 }, { status: 201 }, 1000)).toBeNull()
  })

  it('sem rede tenta de novo, com recuo', () => {
    const depois = aposTentativa(m, { status: 0, semRede: true }, 1000)

    expect(depois?.estado).toBe('pendente')
    expect(depois?.tentativas).toBe(1)
    expect(depois?.tentarApos).toBe(1000 + recuoEmMs(1))
  })

  it('500 tenta de novo: o servidor errou, e a intenção continua válida', () => {
    expect(aposTentativa(m, { status: 503 }, 1000)?.estado).toBe('pendente')
  })

  it('429 tenta de novo: é "espere", não "não faça"', () => {
    expect(aposTentativa(m, { status: 429 }, 1000)?.estado).toBe('pendente')
  })

  it('**400 não tenta de novo, e não some**', () => {
    // Reenviar não vai mudar a recusa. Mas descartar em silêncio uma despesa
    // que a pessoa registrou é a pior coisa que este app pode fazer: ela lança
    // no mercado e o dinheiro nunca aparece.
    const depois = aposTentativa(m, { status: 400, mensagem: 'Categoria inválida.' }, 1000)

    expect(depois?.estado).toBe('precisa_de_atencao')
    expect(depois?.motivo).toBe('Categoria inválida.')
  })

  it('depois de muitas tentativas, desiste e pede atenção', () => {
    let atual: Mutacao | null = m
    for (let i = 0; i < TENTATIVAS_ATE_DESISTIR; i++) {
      atual = aposTentativa(atual!, { status: 0, semRede: true }, 1000)
    }

    expect(atual?.estado).toBe('precisa_de_atencao')
  })

  it('tentar de novo zera o contador', () => {
    const travada: Mutacao = { ...m, estado: 'precisa_de_atencao', tentativas: 8, motivo: 'x' }
    const solta = tentarDeNovo(travada)

    expect(solta.estado).toBe('pendente')
    expect(solta.tentativas).toBe(0)
    expect(solta.motivo).toBeUndefined()
  })
})

describe('contagem', () => {
  it('separa pendentes de quem pede atenção', () => {
    const fila: Mutacao[] = [
      nova('a', 1),
      { ...nova('b', 2), estado: 'precisa_de_atencao', motivo: 'x' },
      nova('c', 3),
    ]

    expect(pendentes(fila)).toBe(2)
    expect(precisamDeAtencao(fila).map((m) => m.id)).toEqual(['b'])
  })
})

describe('propriedades', () => {
  it('o recuo cresce e nunca passa do teto', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), (n) => {
        expect(recuoEmMs(n)).toBeLessThanOrEqual(10 * 60 * 1000)
        expect(recuoEmMs(n)).toBeGreaterThanOrEqual(recuoEmMs(n - 1))
      }),
    )
  })

  it('**nenhuma mutação desaparece sem desfecho**', () => {
    // A invariante que protege o dinheiro: toda tentativa termina em "saiu
    // porque deu certo" ou "continua na fila, de um jeito ou de outro".
    const status = fc.constantFrom(0, 200, 201, 204, 400, 401, 404, 408, 409, 422, 429, 500, 503)

    fc.assert(
      fc.property(status, fc.integer({ min: 0, max: 20 }), (s, tentativas) => {
        const m: Mutacao = { ...nova('a', 1), tentativas }
        const depois = aposTentativa(m, { status: s, semRede: s === 0 }, 1000)

        const deuCerto = s >= 200 && s < 300
        if (deuCerto) {
          expect(depois).toBeNull()
        } else {
          expect(depois).not.toBeNull()
          expect(['pendente', 'precisa_de_atencao']).toContain(depois!.estado)
        }
      }),
    )
  })

  it('a ordem de chegada é respeitada para qualquer permutação da lista', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 20 }),
        (instantes) => {
          const fila = instantes.map((t) => nova(`m${t}`, t))
          const maisAntigo = Math.min(...instantes)

          expect(proxima(fila, 1_000_000)?.id).toBe(`m${maisAntigo}`)
        },
      ),
    )
  })
})
