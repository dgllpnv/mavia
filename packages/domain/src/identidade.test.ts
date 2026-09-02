import { describe, expect, it } from 'vitest'
import { decidirEntradaFederada, type FatosDaEntrada } from './identidade.js'

/**
 * A matriz de vinculação — `docs/produto/spec-autenticacao.md` §2.4.
 *
 * É o ponto onde produtos entregam a conta de uma pessoa a outra. Por isso é
 * função pura: a decisão inteira cabe numa tabela, e uma tabela se testa.
 */

const fatos = (parcial: Partial<FatosDaEntrada>): FatosDaEntrada => ({
  subConhecido: false,
  emailVerificadoNoProvedor: true,
  existeUsuarioComEsseEmail: false,
  usuarioTemSenhaOuMfa: false,
  emailPertenceAOutroSubject: false,
  ...parcial,
})

describe('C1 — sub conhecido', () => {
  it('entra, independentemente do e-mail estar verificado', () => {
    expect(decidirEntradaFederada(fatos({ subConhecido: true }))).toEqual({ acao: 'entrar' })
    expect(
      decidirEntradaFederada(fatos({ subConhecido: true, emailVerificadoNoProvedor: false })),
    ).toEqual({ acao: 'entrar' })
  })

  it('entra mesmo que exista conflito de e-mail, porque a identidade não depende do e-mail', () => {
    const decisao = decidirEntradaFederada(
      fatos({ subConhecido: true, emailPertenceAOutroSubject: true }),
    )

    expect(decisao.acao).toBe('entrar')
  })
})

describe('C2 — sub novo, e-mail não verificado', () => {
  it('recusa sem consultar nada por e-mail', () => {
    const decisao = decidirEntradaFederada(fatos({ emailVerificadoNoProvedor: false }))

    expect(decisao).toEqual({
      acao: 'recusar',
      mensagem: 'generica',
      motivoInterno: 'email-nao-verificado',
    })
  })

  it('recusa mesmo que exista conta com aquele endereço — o endereço não foi provado', () => {
    const decisao = decidirEntradaFederada(
      fatos({ emailVerificadoNoProvedor: false, existeUsuarioComEsseEmail: true }),
    )

    expect(decisao.acao).toBe('recusar')
  })
})

describe('C3 — sub novo, e-mail verificado, ninguém usa o endereço', () => {
  it('cadastra', () => {
    expect(decidirEntradaFederada(fatos({}))).toEqual({ acao: 'cadastrar' })
  })
})

describe('C4 — a conta existe e tem credencial própria', () => {
  it('exige prova da credencial que a conta já possui', () => {
    const decisao = decidirEntradaFederada(
      fatos({ existeUsuarioComEsseEmail: true, usuarioTemSenhaOuMfa: true }),
    )

    expect(decisao).toEqual({ acao: 'exigir-prova', podeRevelarQueContaExiste: true })
  })

  it('nunca vincula automaticamente, que é o desenho do sequestro de conta', () => {
    // Vincular por e-mail verificado permitiria a alguém registrar o endereço
    // da vítima com senha ANTES de ela usar o produto, e passar a dividir o
    // espaço financeiro com ela.
    const decisao = decidirEntradaFederada(
      fatos({ existeUsuarioComEsseEmail: true, usuarioTemSenhaOuMfa: true }),
    )

    expect(decisao.acao).not.toBe('entrar')
    expect(decisao.acao).not.toBe('cadastrar')
  })
})

describe('C5 — reatribuição de endereço', () => {
  it('recusa definitivamente quando o e-mail pertence a outro subject do mesmo provedor', () => {
    const decisao = decidirEntradaFederada(
      fatos({
        existeUsuarioComEsseEmail: true,
        usuarioTemSenhaOuMfa: false,
        emailPertenceAOutroSubject: true,
      }),
    )

    expect(decisao).toEqual({
      acao: 'recusar',
      mensagem: 'generica',
      motivoInterno: 'reatribuicao-de-endereco',
    })
  })
})

describe('C6 — estado impossível por construção', () => {
  it('recusa e alerta quando a conta não tem credencial nenhuma', () => {
    // Todo usuário nasce com ao menos uma credencial. Chegar aqui é corrupção
    // de dado, e silenciar seria pior que recusar.
    const decisao = decidirEntradaFederada(
      fatos({
        existeUsuarioComEsseEmail: true,
        usuarioTemSenhaOuMfa: false,
        emailPertenceAOutroSubject: false,
      }),
    )

    expect(decisao).toEqual({
      acao: 'recusar',
      mensagem: 'generica',
      motivoInterno: 'estado-impossivel',
      alertarOperador: true,
    })
  })
})

describe('a propriedade que protege a vítima', () => {
  it('C2 e C5 são indistinguíveis para quem está do outro lado', () => {
    // C5 é o oposto de C4: quem está no teclado controla a caixa HOJE e não
    // controlava quando a conta foi criada. Dizer "existe uma conta com este
    // endereço" entregaria a existência da vítima e, a partir daí, o alvo.
    const c2 = decidirEntradaFederada(fatos({ emailVerificadoNoProvedor: false }))
    const c5 = decidirEntradaFederada(
      fatos({
        existeUsuarioComEsseEmail: true,
        emailPertenceAOutroSubject: true,
      }),
    )

    expect(c2.acao).toBe('recusar')
    expect(c5.acao).toBe('recusar')
    if (c2.acao !== 'recusar' || c5.acao !== 'recusar') return
    // A mensagem é o que sai para o usuário. O motivo interno é de auditoria e
    // nunca deve chegar à resposta — são campos diferentes de propósito.
    expect(c2.mensagem).toBe(c5.mensagem)
    expect(c2.motivoInterno).not.toBe(c5.motivoInterno)
  })

  it('só C4 permite revelar que a conta existe', () => {
    const decisoes = [
      decidirEntradaFederada(fatos({ subConhecido: true })),
      decidirEntradaFederada(fatos({ emailVerificadoNoProvedor: false })),
      decidirEntradaFederada(fatos({})),
      decidirEntradaFederada(fatos({ existeUsuarioComEsseEmail: true, emailPertenceAOutroSubject: true })),
    ]

    for (const d of decisoes) {
      expect('podeRevelarQueContaExiste' in d).toBe(false)
    }
  })
})

describe('a matriz inteira — 32 combinações, todas enumeradas', () => {
  const todasAsCombinacoes = (): FatosDaEntrada[] => {
    const bools = [false, true]
    const saida: FatosDaEntrada[] = []
    for (const subConhecido of bools)
      for (const emailVerificadoNoProvedor of bools)
        for (const existeUsuarioComEsseEmail of bools)
          for (const usuarioTemSenhaOuMfa of bools)
            for (const emailPertenceAOutroSubject of bools)
              saida.push({
                subConhecido,
                emailVerificadoNoProvedor,
                existeUsuarioComEsseEmail,
                usuarioTemSenhaOuMfa,
                emailPertenceAOutroSubject,
              })
    return saida
  }

  it('é total: toda combinação de fatos produz uma decisão conhecida', () => {
    const acoes = new Set(['entrar', 'cadastrar', 'exigir-prova', 'recusar'])
    const combinacoes = todasAsCombinacoes()

    expect(combinacoes).toHaveLength(32)
    for (const f of combinacoes) {
      expect(acoes.has(decidirEntradaFederada(f).acao)).toBe(true)
    }
  })

  it('nenhuma combinação entra ou cadastra sobre conta alheia com credencial', () => {
    // A invariante de segurança, verificada em todo o espaço de entrada e não
    // só nos seis exemplos: com `sub` novo e uma conta que já tem credencial,
    // a única saída possível é exigir prova.
    for (const f of todasAsCombinacoes()) {
      if (!f.subConhecido && f.emailVerificadoNoProvedor && f.existeUsuarioComEsseEmail && f.usuarioTemSenhaOuMfa) {
        expect(decidirEntradaFederada(f).acao).toBe('exigir-prova')
      }
    }
  })

  it('toda recusa usa a mesma mensagem, qualquer que seja o motivo', () => {
    for (const f of todasAsCombinacoes()) {
      const d = decidirEntradaFederada(f)
      if (d.acao === 'recusar') expect(d.mensagem).toBe('generica')
    }
  })

  it('a permissão de revelar aparece só em exigir-prova', () => {
    for (const f of todasAsCombinacoes()) {
      const d = decidirEntradaFederada(f)
      expect('podeRevelarQueContaExiste' in d).toBe(d.acao === 'exigir-prova')
    }
  })
})
