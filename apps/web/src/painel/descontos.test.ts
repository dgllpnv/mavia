import type { DescontoDoCliente } from '@mavia/contracts'
import { describe, expect, it } from 'vitest'
import {
  aceitaDesconto,
  corpoDoDesconto,
  descontoAtivo,
  digitarPontosBase,
  duracaoPorExtenso,
  estimativa,
  historicoDeDescontos,
  motivoDaRecusa,
  O_QUE_O_DESCONTO_NAO_FAZ,
  oQueAConcessaoFaz,
  pontosBaseNaTela,
  ROTULO_DA_ESTIMATIVA,
  type RascunhoDoDesconto,
} from './descontos'

/**
 * O que se perde se estas regras sumirem: um `0.15` entra a dois passos de uma
 * `Money`, ou o operador concede um desconto sobre outro sem saber que apagou
 * uma negociação. E a estimativa, se errar por um centavo, faz alguém conferir
 * a fatura e concluir que a fatura está errada.
 */

function desconto(campos: Partial<DescontoDoCliente> = {}): DescontoDoCliente {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    especie: 'percentual',
    pontos_base: 1500,
    valor_centavos: null,
    moeda: 'BRL',
    duracao: 'sempre',
    meses: null,
    stripe_coupon_id: null,
    motivo: 'indisponibilidade de tres dias em agosto',
    concedido_em: '2026-09-01T12:00:00.000Z',
    revogado_em: null,
    ...campos,
  }
}

const rascunho: RascunhoDoDesconto = {
  especie: 'percentual',
  pontosBase: '1500',
  centavos: '0',
  duracao: 'sempre',
  meses: '',
  motivo: 'indisponibilidade de tres dias em agosto',
}

describe('o desconto ativo, e o histórico', () => {
  it('**o ativo é o de `revogado_em` nulo, e é um só**', () => {
    // O índice parcial `descontos_um_ativo_por_espaco` garante a unicidade no
    // banco. A tela precisa achar o mesmo: mostrar o revogado como vigente
    // faria o operador prometer ao cliente um desconto que já acabou.
    const itens = [desconto({ id: 'velho', revogado_em: '2026-09-02T00:00:00.000Z' }), desconto({ id: 'novo' })]
    expect(descontoAtivo(itens)?.id).toBe('novo')
  })

  it('sem nenhum ativo, é nulo — e não a primeira linha', () => {
    expect(descontoAtivo([desconto({ revogado_em: '2026-09-02T00:00:00.000Z' })])).toBeNull()
    expect(descontoAtivo([])).toBeNull()
  })

  it('o histórico vem do mais recente para o mais antigo', () => {
    const h = historicoDeDescontos([
      desconto({ id: 'a', concedido_em: '2026-03-01T00:00:00.000Z' }),
      desconto({ id: 'b', concedido_em: '2026-09-01T00:00:00.000Z' }),
    ])
    expect(h.map((d) => d.id)).toEqual(['b', 'a'])
  })
})

describe('pontos-base — 15% é 1500, e nunca 0,15', () => {
  it('**o dígito entra pela direita, como numa calculadora**', () => {
    // Quem digita 1, 5, 0, 0 quer 15,00%. Pedir que a pessoa acerte a vírgula é
    // pedir que ela pense no formato em vez de no número — e é por aí que um
    // `parseFloat` entra num arquivo que fala de dinheiro.
    let pb = ''
    for (const t of ['1', '5', '0', '0']) pb = digitarPontosBase(pb, t)
    expect(pb).toBe('1500')
    expect(pontosBaseNaTela(pb)).toBe('15,00')
  })

  it('apagar tira o último dígito', () => {
    expect(digitarPontosBase('1500', 'Backspace')).toBe('150')
    expect(digitarPontosBase('', 'Backspace')).toBe('0')
  })

  it('tecla que não é dígito não muda nada', () => {
    expect(digitarPontosBase('1500', 'e')).toBe('1500')
    expect(digitarPontosBase('1500', ',')).toBe('1500')
  })

  it('**para no quinto dígito — o teto do banco tem cinco**', () => {
    // Com seis, o campo aceitaria um número que só o `CHECK` recusaria, depois
    // de uma ida e volta ao servidor.
    expect(digitarPontosBase('10000', '7')).toBe('10000')
  })

  it('a exibição não passa por ponto flutuante', () => {
    expect(pontosBaseNaTela('750')).toBe('7,50')
    expect(pontosBaseNaTela('1')).toBe('0,01')
    expect(pontosBaseNaTela('10000')).toBe('100,00')
  })
})

describe('o corpo da requisição', () => {
  it('percentual leva pontos-base e **nunca centavos**', () => {
    // A combinação é o que o `superRefine` da rota recusa e o `CHECK`
    // `valor_combina_com_especie` recusa embaixo. Aqui ela é irrepresentável.
    const c = corpoDoDesconto({ ...rascunho, centavos: '1000' })
    expect(c).toEqual({
      especie: 'percentual',
      pontosBase: 1500,
      duracao: 'sempre',
      motivo: 'indisponibilidade de tres dias em agosto',
    })
  })

  it('quantia fixa leva centavos como string', () => {
    const c = corpoDoDesconto({ ...rascunho, especie: 'valor', centavos: '1000' })
    expect(c).toEqual({
      especie: 'valor',
      centavos: '1000',
      duracao: 'sempre',
      motivo: 'indisponibilidade de tres dias em agosto',
    })
  })

  it('duração em meses leva meses, e as outras não levam', () => {
    expect(corpoDoDesconto({ ...rascunho, duracao: 'meses', meses: '3' })).toMatchObject({
      duracao: 'meses',
      meses: 3,
    })
    expect(corpoDoDesconto({ ...rascunho, duracao: 'uma_vez', meses: '3' })).toEqual({
      especie: 'percentual',
      pontosBase: 1500,
      duracao: 'uma_vez',
      motivo: 'indisponibilidade de tres dias em agosto',
    })
  })

  it('**rascunho incompleto não vira corpo**', () => {
    expect(corpoDoDesconto({ ...rascunho, motivo: 'curto' })).toBeNull()
    expect(corpoDoDesconto({ ...rascunho, pontosBase: '0' })).toBeNull()
    expect(corpoDoDesconto({ ...rascunho, pontosBase: '10001' })).toBeNull()
    expect(corpoDoDesconto({ ...rascunho, duracao: 'meses', meses: '' })).toBeNull()
    expect(corpoDoDesconto({ ...rascunho, especie: 'valor', centavos: '0' })).toBeNull()
  })

  it('o motivo vai aparado, como o banco o grava', () => {
    expect(corpoDoDesconto({ ...rascunho, motivo: '  tres dias fora do ar  ' })).toMatchObject({
      motivo: 'tres dias fora do ar',
    })
  })
})

describe('a recusa nomeada antes do envio', () => {
  it('**diz que o desconto não passa de 100%**', () => {
    expect(motivoDaRecusa({ ...rascunho, pontosBase: '10001' })).toContain('100%')
    expect(motivoDaRecusa({ ...rascunho, pontosBase: '10000' })).toBeNull()
  })

  it('diz o mínimo do motivo, e por que ele existe', () => {
    expect(motivoDaRecusa({ ...rascunho, motivo: 'curto' })).toContain('registro')
  })

  it('cobra os meses quando a duração é em meses', () => {
    expect(motivoDaRecusa({ ...rascunho, duracao: 'meses', meses: '0' })).toContain('meses')
    expect(motivoDaRecusa({ ...rascunho, duracao: 'meses', meses: '121' })).toContain('120')
  })

  it('rascunho bom não tem recusa', () => {
    expect(motivoDaRecusa(rascunho)).toBeNull()
  })
})

describe('a estimativa — do domínio, e rotulada', () => {
  it('**15% sobre R$ 199,90: o desconto é que arredonda, e a subtração fecha**', () => {
    // 2998,5 centavos é meio centavo, e nenhuma escolha é neutra. O domínio
    // arredonda **o desconto**, meio para cima — 2999 —, e o final é a
    // subtração exata: 16991. Refazer a conta aqui é o que faria a tela
    // divergir por um centavo do que o domínio prova.
    //
    // **A ADR 0025 D1 ilustra esta mesma conta com "≈ R$ 169,92".** O número
    // do texto é 169,91 com o arredondamento que o domínio implementa e testa;
    // 169,92 sairia de arredondar o **final** para cima, que é a escolha que a
    // ADR descarta duas linhas antes. O que é normativo na D1 é o rótulo, e é
    // ele que a tela repete; o valor vem do domínio.
    const e = estimativa('19990', { especie: 'percentual', pontosBase: 1500, duracao: 'sempre', motivo: 'x' })
    expect(e).toEqual({ descontoCentavos: '2999', finalCentavos: '16991' })
  })

  it('a quantia fixa desconta a quantia', () => {
    const e = estimativa('3500', { especie: 'valor', centavos: '1000', duracao: 'sempre', motivo: 'x' })
    expect(e).toEqual({ descontoCentavos: '1000', finalCentavos: '2500' })
  })

  it('**um cupom maior que o preço não produz preço negativo**', () => {
    // R$ 100,00 sobre R$ 35,00 desconta R$ 35,00. O valor reportado encolhe
    // junto com o efeito: devolver os R$ 100,00 nominais faria qualquer tela
    // que refizesse a conta mostrar −R$ 65,00, e alguma tela sempre refaz.
    const e = estimativa('3500', { especie: 'valor', centavos: '10000', duracao: 'sempre', motivo: 'x' })
    expect(e).toEqual({ descontoCentavos: '3500', finalCentavos: '0' })
  })

  it('**sem preço não há estimativa, e nunca um zero**', () => {
    // Um zero na tela seria lido como "sai de graça". O que existe é ausência
    // de estimativa, e a tela precisa poder dizer isso.
    expect(estimativa('0', { especie: 'percentual', pontosBase: 1500, duracao: 'sempre', motivo: 'x' })).toBeNull()
  })

  it('desconto fora de faixa não estima', () => {
    expect(estimativa('19990', { especie: 'percentual', pontosBase: 0, duracao: 'sempre', motivo: 'x' })).toBeNull()
  })

  it('**o rótulo é literal, e a literalidade é o requisito**', () => {
    // A D1 escreve a frase entre aspas: é ela que impede o operador de tratar a
    // estimativa como o valor cobrado. Sem o rótulo, a tela afirmaria uma
    // cobrança que nós não fazemos.
    expect(ROTULO_DA_ESTIMATIVA).toBe('valor final confirmado pela Stripe')
  })
})

describe('o que a tela diz antes do botão', () => {
  it('**com desconto ativo, diz que conceder substitui**', () => {
    // Sem esta frase o operador desfaz uma negociação que ele não conhece — e o
    // cliente descobre pela fatura.
    const texto = oQueAConcessaoFaz(desconto())
    expect(texto).toContain('já tem um desconto ativo')
    expect(texto).toContain('revoga o atual')
    expect(texto).toContain('histórico')
  })

  it('sem desconto ativo, não promete substituição nenhuma', () => {
    expect(oQueAConcessaoFaz(null)).not.toContain('revoga o atual')
  })

  it('**diz que hoje o desconto não é aplicado a cobrança nenhuma**', () => {
    // A D3 emendada: sem Stripe, o desconto fica registrado e não desconta
    // nada, porque não existe cobrança. Prometer o contrário ao cliente é o
    // dano que a frase evita.
    expect(O_QUE_O_DESCONTO_NAO_FAZ).toContain('não existe cobrança')
    expect(O_QUE_O_DESCONTO_NAO_FAZ).toContain('recusada até o cupom')
  })

  it('a duração é dita em português, com o plural certo', () => {
    expect(duracaoPorExtenso('uma_vez', null)).toBe('uma vez')
    expect(duracaoPorExtenso('sempre', null)).toBe('para sempre')
    expect(duracaoPorExtenso('meses', 1)).toBe('por 1 mês')
    expect(duracaoPorExtenso('meses', 3)).toBe('por 3 meses')
  })

  it('**sem assinatura a função recusa, e a tela sabe disso antes**', () => {
    // `ASSINATURA_INEXISTENTE` é a única condição de estado que
    // `admin.conceder_desconto` impõe. Espelhar mais do que ela impõe faria a
    // tela recusar o que o servidor aceita.
    expect(aceitaDesconto(null)).toBe(false)
    expect(aceitaDesconto('expirada')).toBe(true)
    expect(aceitaDesconto('teste')).toBe(true)
  })
})
