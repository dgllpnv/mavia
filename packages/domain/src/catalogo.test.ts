import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  COTAS_DO_TESTE,
  cotasVigentes,
  jobsAtivos,
  PLANOS,
  plano,
  podeEscrever,
  preco,
  transicao,
  type EstadoDaAssinatura,
  type EventoDaAssinatura,
} from './catalogo.js'

const ESTADOS: readonly EstadoDaAssinatura[] = [
  'teste',
  'ativa',
  'em_atraso',
  'cancelada',
  'expirada',
]

const EVENTOS: readonly EventoDaAssinatura[] = [
  'assinou',
  'pagamento_falhou',
  'pagamento_recuperado',
  'cancelou',
  'desfez_cancelamento',
  'periodo_terminou',
  'prazo_de_teste_acabou',
  'graca_acabou',
  'reativou',
]

describe('o catálogo', () => {
  it('os preços são os decididos pelo dono (DP-27)', () => {
    expect(PLANOS.pessoal.mensal.centavos).toBe(5900n)
    expect(PLANOS.familia.mensal.centavos).toBe(7900n)
    expect(PLANOS.negocio.mensal.centavos).toBe(9900n)
  })

  it('**o anual é dez vezes o mensal, e ainda assim é declarado**', () => {
    // A igualdade vale, e o teste a confere — mas o valor não é obtido por
    // multiplicação em tempo de execução. Preço derivado por aritmética é preço
    // que diverge entre a vitrine, a Stripe e o reembolso.
    for (const p of Object.values(PLANOS)) {
      expect(p.anual.centavos).toBe(p.mensal.centavos * 10n)
    }
  })

  it('nenhum preço tem centavo quebrado', () => {
    // Propriedade (b) da decisão do desconto: preços redondos nos três níveis,
    // sem centavo quebrado em nenhuma tela.
    for (const p of Object.values(PLANOS)) {
      expect(p.mensal.centavos % 100n).toBe(0n)
      expect(p.anual.centavos % 100n).toBe(0n)
    }
  })

  it('as cotas crescem com o plano', () => {
    expect(PLANOS.pessoal.cotas.pessoas).toBeLessThan(PLANOS.familia.cotas.pessoas)
    expect(PLANOS.familia.cotas.pessoas).toBeLessThan(PLANOS.negocio.cotas.pessoas)
  })

  it('**o teste usa as cotas do Família**', () => {
    // Quem testa precisa poder convidar a família, senão o teste não exercita o
    // produto que ele está avaliando.
    expect(COTAS_DO_TESTE).toEqual(PLANOS.familia.cotas)
    expect(cotasVigentes('teste', 'pessoal')).toEqual(PLANOS.familia.cotas)
  })

  it('plano desconhecido devolve nulo, e não um plano vazio', () => {
    expect(plano('premium')).toBeNull()
    expect(plano('pessoal')).not.toBeNull()
  })

  it('o preço vem do intervalo', () => {
    expect(preco('familia', 'mensal').centavos).toBe(7900n)
    expect(preco('familia', 'anual').centavos).toBe(79000n)
  })
})

describe('a máquina de estados', () => {
  it('o caminho feliz: teste → ativa', () => {
    expect(transicao('teste', 'assinou')).toBe('ativa')
  })

  it('o oitavo dia sem assinar', () => {
    expect(transicao('teste', 'prazo_de_teste_acabou')).toBe('expirada')
  })

  it('falha de pagamento não expira: dá catorze dias', () => {
    expect(transicao('ativa', 'pagamento_falhou')).toBe('em_atraso')
    expect(transicao('em_atraso', 'pagamento_recuperado')).toBe('ativa')
    expect(transicao('em_atraso', 'graca_acabou')).toBe('expirada')
  })

  it('cancelar não corta no ato: vale até o fim do período pago', () => {
    expect(transicao('ativa', 'cancelou')).toBe('cancelada')
    expect(transicao('cancelada', 'periodo_terminou')).toBe('expirada')
  })

  it('desfazer o cancelamento é sem atrito', () => {
    expect(transicao('cancelada', 'desfez_cancelamento')).toBe('ativa')
  })

  it('**expirada volta, e volta inteira**', () => {
    // Nunca apagamos nada (DP-5): reativar devolve o produto com o histórico
    // no lugar.
    expect(transicao('expirada', 'reativou')).toBe('ativa')
  })

  it('**evento que não se aplica devolve nulo, e não um estado plausível**', () => {
    // Uma máquina que "conserta" um evento impossível esconde o defeito de quem
    // o emitiu — e o webhook da Stripe emite eventos fora de ordem.
    expect(transicao('expirada', 'pagamento_falhou')).toBeNull()
    expect(transicao('teste', 'cancelou')).toBeNull()
    expect(transicao('ativa', 'reativou')).toBeNull()
  })
})

describe('o que cada estado permite', () => {
  it('**quatro dos cinco escrevem; só `expirada` bloqueia**', () => {
    expect(podeEscrever('teste')).toBe(true)
    expect(podeEscrever('ativa')).toBe(true)
    // A propriedade que domina o desenho: bloquear no instante em que o cartão
    // falha é a forma mais comum de perder um cliente que queria ficar.
    expect(podeEscrever('em_atraso')).toBe(true)
    expect(podeEscrever('cancelada')).toBe(true)
    expect(podeEscrever('expirada')).toBe(false)
  })

  it('os jobs pausam só na expirada', () => {
    // Eles geram dado novo, e gerar dado novo para quem não paga é continuar
    // prestando o serviço.
    for (const e of ESTADOS) expect(jobsAtivos(e)).toBe(e !== 'expirada')
  })
})

describe('propriedades', () => {
  it('**nenhuma transição leva a um estado desconhecido**', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ESTADOS), fc.constantFrom(...EVENTOS), (estado, evento) => {
        const destino = transicao(estado, evento)
        if (destino !== null) expect(ESTADOS).toContain(destino)
      }),
    )
  })

  it('**nenhum evento é identidade**: transição sempre muda o estado', () => {
    // Uma transição que devolve o mesmo estado é um evento que não deveria
    // existir, e ela esconderia um caminho morto na tabela.
    fc.assert(
      fc.property(fc.constantFrom(...ESTADOS), fc.constantFrom(...EVENTOS), (estado, evento) => {
        const destino = transicao(estado, evento)
        if (destino !== null) expect(destino).not.toBe(estado)
      }),
    )
  })

  it('**toda expirada tem volta**', () => {
    // Não existe estado terminal: quem parou de pagar pode voltar, e o produto
    // que ele deixou está inteiro.
    let atual: EstadoDaAssinatura = 'expirada'
    atual = transicao(atual, 'reativou')!
    expect(atual).toBe('ativa')
  })

  it('a cota nunca é negativa nem fracionária', () => {
    for (const p of Object.values(PLANOS)) {
      for (const valor of Object.values(p.cotas)) {
        expect(Number.isInteger(valor)).toBe(true)
        expect(valor).toBeGreaterThanOrEqual(0)
      }
    }
  })
})
