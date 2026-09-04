import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  COTAS_DO_TESTE,
  cotasVigentes,
  fimEfetivo,
  jobsAtivos,
  PLANOS,
  plano,
  podeEscrever,
  preco,
  transicao,
  type CodigoDoPlano,
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
  it('os seis preços são os decididos pelo dono (DP-41)', () => {
    // Os seis, e não os três mensais. A DP-27 conferia só o mensal porque o
    // anual era `10 ×` e o outro teste o cobria; sem a relação, um anual errado
    // não seria pego por ninguém.
    expect(PLANOS.pessoal.mensal.centavos).toBe(3500n)
    expect(PLANOS.pessoal.anual.centavos).toBe(19990n)
    expect(PLANOS.familia.mensal.centavos).toBe(4500n)
    expect(PLANOS.familia.anual.centavos).toBe(39990n)
    expect(PLANOS.negocio.mensal.centavos).toBe(6900n)
    expect(PLANOS.negocio.anual.centavos).toBe(59990n)
  })

  it('**o anual desconta, e o desconto é declarado — nunca calculado**', () => {
    // A DP-27 tinha `anual = 10 × mensal` e este teste conferia a igualdade.
    // A DP-41 a desfez: 5,7 · 8,9 · 8,7 mensalidades, três razões diferentes.
    //
    // O que sobrevive é a única propriedade que a vitrine promete e que uma
    // troca de preço pode quebrar em silêncio: **pagar o ano custa menos que
    // pagar doze meses**. Um anual maior que `12 ×` transformaria o botão
    // "economize" numa cobrança a mais, e nenhum outro teste veria.
    for (const p of Object.values(PLANOS)) {
      expect(p.anual.centavos).toBeLessThan(p.mensal.centavos * 12n)
    }
  })

  it('o anual do Pessoal cobre menos de seis mensalidades — a consequência da DP-41', () => {
    // Não é um desejo, é um fato registrado para não ser redescoberto na
    // primeira solicitação de reembolso.
    //
    // A fórmula de `spec-planos:305` é `max(0, pago − meses_iniciados ×
    // mensal)`. Com o desconto anual do concorrente (52% no Pessoal), ela
    // chega a zero no **sexto** mês: quem pagou R$ 199,90 e cancela em julho
    // recebe nada de volta, tendo usado metade do ano.
    //
    // Sob a DP-27 o piso era o décimo mês, e a fórmula parecia generosa. Ela
    // não mudou; o preço mudou. Este teste falha no dia em que os preços se
    // mexerem de novo, que é exatamente quando alguém precisa reolhar a
    // política de reembolso.
    const meses = (c: CodigoDoPlano) => Number(PLANOS[c].anual.centavos / PLANOS[c].mensal.centavos)
    expect(meses('pessoal')).toBe(5)
    expect(meses('familia')).toBe(8)
    expect(meses('negocio')).toBe(8)
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
    expect(preco('familia', 'mensal').centavos).toBe(4500n)
    expect(preco('familia', 'anual').centavos).toBe(39990n)
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

describe('fimEfetivo — a leitura normativa do fim do direito de uso', () => {
  const emJaneiro = new Date('2026-01-31T03:00:00.000Z')
  const emMarco = new Date('2026-03-31T03:00:00.000Z')

  it('sem cortesia, é o próprio fim do período', () => {
    expect(fimEfetivo(emJaneiro, null)).toBe(emJaneiro)
  })

  it('**a cortesia estende**, quando vai além do período', () => {
    expect(fimEfetivo(emJaneiro, emMarco)).toBe(emMarco)
  })

  it('**a fatura seguinte não encurta o cliente**', () => {
    // Se o webhook empurrar `periodo_fim` para além da cortesia, o cliente não
    // perde nada: ele deixou de precisar dela. `greatest`, e não soma — senão
    // cada leitura acumularia sobre a anterior.
    expect(fimEfetivo(emMarco, emJaneiro)).toBe(emMarco)
  })
})
