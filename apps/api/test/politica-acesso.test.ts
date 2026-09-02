import { describe, expect, it } from 'vitest'
import {
  MATRIZ,
  RotaSemRegra,
  chaveDaRota,
  pode,
  verificarCoberturaDaMatriz,
  type Rota,
} from '../src/autorizacao/politica-acesso.js'

/**
 * A política de acesso é função pura sobre uma tabela — testa-se sem banco e
 * sem HTTP.
 *
 * O que estes testes protegem não é a tabela, que muda. É o comportamento na
 * ausência de entrada: **negar**, e **falar alto sobre a omissão**.
 */

describe('nega por padrão', () => {
  it('rota que não está na matriz é negada para todos os papéis', () => {
    const desconhecida: Rota = { metodo: 'GET', caminho: '/v1/lancamentos' }

    expect(pode(desconhecida, 'proprietario')).toBe(false)
    expect(pode(desconhecida, 'membro')).toBe(false)
    expect(pode(desconhecida, 'visualizador')).toBe(false)
  })

  it('nem o proprietário escapa da omissão', () => {
    // Um `if (papel === 'proprietario') return true` em algum lugar tornaria
    // toda rota esquecida acessível ao papel mais poderoso. Não existe atalho.
    expect(pode({ metodo: 'DELETE', caminho: '/v1/tudo' }, 'proprietario')).toBe(false)
  })
})

describe('a cobertura falha no boot', () => {
  it('lança quando uma rota registrada não tem regra', () => {
    // Este é o mecanismo inteiro do 1C: negar por padrão protege, mas
    // silenciar a omissão esconde o buraco. A aplicação não sobe.
    expect(() =>
      verificarCoberturaDaMatriz([
        { metodo: 'GET', caminho: '/v1/contas' },
        { metodo: 'GET', caminho: '/v1/rota-esquecida' },
      ]),
    ).toThrow(RotaSemRegra)
  })

  it('a mensagem diz exatamente qual rota falta', () => {
    // Erro de boot que não diz o que corrigir custa uma hora de investigação
    // num deploy travado.
    try {
      verificarCoberturaDaMatriz([{ metodo: 'POST', caminho: '/v1/esquecida' }])
      expect.unreachable('deveria ter lançado')
    } catch (erro) {
      expect(String(erro)).toContain('POST /v1/esquecida')
    }
  })

  it('não lança quando todas as rotas têm regra', () => {
    const registradas = [...MATRIZ.keys()].map((chave) => {
      const [metodo, caminho] = chave.split(' ')
      return { metodo, caminho } as Rota
    })

    expect(() => verificarCoberturaDaMatriz(registradas)).not.toThrow()
  })
})

describe('os papéis', () => {
  it('visualizador lê e não escreve', () => {
    expect(pode({ metodo: 'GET', caminho: '/v1/contas' }, 'visualizador')).toBe(true)
    expect(pode({ metodo: 'POST', caminho: '/v1/contas' }, 'visualizador')).toBe(false)
  })

  it('membro escreve, mas não exclui conta', () => {
    // Excluir some com o histórico da vista de todo o espaço; `membro` não
    // decide isso pelos outros. Ver a decisão DP-4, que permite ao membro
    // excluir *lançamento* — que é reversível e rastreável.
    expect(pode({ metodo: 'POST', caminho: '/v1/contas' }, 'membro')).toBe(true)
    expect(pode({ metodo: 'DELETE', caminho: '/v1/contas/:id' }, 'membro')).toBe(false)
    expect(pode({ metodo: 'DELETE', caminho: '/v1/contas/:id' }, 'proprietario')).toBe(true)
  })
})

describe('a chave da rota', () => {
  it('usa o padrão do roteador, não a URL concreta', () => {
    // Se a chave fosse a URL concreta, cada id viraria uma rota diferente e a
    // matriz nunca casaria — o que, com "nega por padrão", derrubaria tudo.
    expect(chaveDaRota({ metodo: 'GET', caminho: '/v1/contas/:id' })).toBe('GET /v1/contas/:id')
  })
})
