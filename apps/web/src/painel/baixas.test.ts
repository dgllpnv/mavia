import type { BaixaAnterior } from '@mavia/contracts'
import { describe, expect, it } from 'vitest'
import {
  A_OBSERVACAO_SAI_NA_EXPORTACAO,
  aceitaBaixa,
  avaliarBaixa,
  instanteDoRecebimento,
  O_QUE_A_BAIXA_NAO_FAZ,
  oQueEstaBaixaFaz,
} from './baixas'
import { competenciaDoInstante } from './formatos'

/**
 * O que se perde se estas regras sumirem: dois operadores dão baixa no mesmo
 * Pix em horas diferentes e a escrituração soma R$ 198,00 sobre R$ 99,00
 * recebidos. É o achado F-3, e ele é a razão de a lista ficar acima do botão.
 */

function baixa(campos: Partial<BaixaAnterior> = {}): BaixaAnterior {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    valor_centavos: '9900',
    moeda: 'BRL',
    competencia: '2026-09-01',
    recebido_em: '2026-09-10T14:00:00.000Z',
    meio: 'pix',
    referencia_externa: 'E2E0001',
    observacao: null,
    registrado_em: '2026-09-10T14:05:00.000Z',
    ...campos,
  }
}

const rascunho = {
  valorCentavos: '9900',
  meio: 'pix' as const,
  referenciaExterna: 'E2E0001',
  recebidoEm: '2026-09-10T14:00:00.000Z',
}

describe('a repetição exata — a que o índice único recusa', () => {
  it('**é encontrada antes do envio, com a linha existente**', () => {
    // Sem isto o operador manda, leva 409, e a mensagem que ele lê é a de uma
    // violação de restrição. O critério de aceite 3 do ticket é explícito:
    // "mostra a linha existente e a data em que foi registrada — nunca 'erro ao
    // salvar'". Para mostrar a data, é preciso ter a linha.
    const a = avaliarBaixa([baixa()], rascunho)
    expect(a.repetida?.registrado_em).toBe('2026-09-10T14:05:00.000Z')
    expect(a.podeEnviar).toBe(false)
  })

  it('a chave é `(meio, referencia)`, como o índice', () => {
    // A mesma referência por meios diferentes são duas linhas legítimas para o
    // banco: um boleto e um Pix podem carregar o mesmo número de documento.
    const a = avaliarBaixa([baixa({ meio: 'boleto' })], rascunho)
    expect(a.repetida).toBeNull()
  })

  it('ignora espaço em volta, porque o Zod da API faz `trim` antes de gravar', () => {
    const a = avaliarBaixa([baixa()], { ...rascunho, referenciaExterna: '  E2E0001  ' })
    expect(a.repetida).not.toBeNull()
  })

  it('**é sensível a maiúsculas, porque o índice é**', () => {
    // `e2e0001` e `E2E0001` são duas linhas para o Postgres. Tratá-las como
    // iguais aqui bloquearia um envio que o banco aceitaria — a tela mentiria
    // sobre o que o banco vai fazer. A divergência de digitação é tratada como
    // semelhança, logo abaixo, que é onde ela pertence.
    const a = avaliarBaixa([baixa()], { ...rascunho, referenciaExterna: 'e2e0001' })
    expect(a.repetida).toBeNull()
    expect(a.semelhantes).toHaveLength(1)
  })
})

describe('a semelhança — a que o índice único **não** recusa', () => {
  it('**mesma quantia, mesma competência, referência diferente**', () => {
    // É a forma que a duplicidade toma quando duas pessoas leem o mesmo
    // comprovante e digitam o identificador de jeitos diferentes. Nenhuma
    // restrição do banco a impede.
    const a = avaliarBaixa([baixa()], { ...rascunho, referenciaExterna: 'E2E-0001' })
    expect(a.semelhantes).toHaveLength(1)
    expect(a.podeEnviar).toBe(false)
  })

  it('só prossegue com confirmação explícita', () => {
    // Sugestão, não sobrescrita — regra 15. O operador pode ter recebido duas
    // vezes a mesma quantia no mesmo mês, e isso é legítimo.
    const a = avaliarBaixa([baixa()], { ...rascunho, referenciaExterna: 'E2E-0001' }, true)
    expect(a.semelhantes).toHaveLength(1)
    expect(a.podeEnviar).toBe(true)
  })

  it('**a confirmação não libera uma repetição exata**', () => {
    // A repetição exata é recusada pelo banco. Deixá-la passar por confirmação
    // trocaria uma mensagem clara por um 409 no meio da tela.
    const a = avaliarBaixa([baixa()], rascunho, true)
    expect(a.podeEnviar).toBe(false)
  })

  it('a competência do rascunho sai de `recebido_em`, **em São Paulo**', () => {
    // 30/09 22h em São Paulo é 01/10 01h em UTC. Derivar a competência do UTC
    // nu daria outubro, e a baixa de setembro do banco não seria reconhecida
    // como semelhante — a defesa deixaria de funcionar exatamente nas últimas
    // horas de cada mês.
    const a = avaliarBaixa([baixa({ referencia_externa: 'OUTRA' })], {
      ...rascunho,
      referenciaExterna: 'E2E-9',
      recebidoEm: '2026-10-01T01:00:00.000Z',
    })
    expect(a.semelhantes).toHaveLength(1)
  })

  it('quantia diferente na mesma competência não é semelhante', () => {
    const a = avaliarBaixa([baixa({ valor_centavos: '5900' })], {
      ...rascunho,
      referenciaExterna: 'E2E-9',
    })
    expect(a.semelhantes).toHaveLength(0)
    expect(a.podeEnviar).toBe(true)
  })

  it('compara centavos como inteiro, não como texto', () => {
    // `'09900'` e `'9900'` são a mesma quantia. Depender da forma canônica do
    // driver é depender de um detalhe do driver para decidir se dois pagamentos
    // são o mesmo.
    const a = avaliarBaixa([baixa({ valor_centavos: '09900', referencia_externa: 'X' })], {
      ...rascunho,
      referenciaExterna: 'E2E-9',
    })
    expect(a.semelhantes).toHaveLength(1)
  })

  it('a lista vazia libera o envio', () => {
    const a = avaliarBaixa([], rascunho)
    expect(a).toEqual({ repetida: null, semelhantes: [], podeEnviar: true })
  })
})

describe('o que a baixa faz, e o que ela não faz', () => {
  it('**diz que reativa o acesso quando o cliente está em atraso**', () => {
    // Exigência 2 da §9, e a armadilha F-1: o operador que dá baixa num cliente
    // `em_atraso` está reativando o acesso. Se a tela não disser isso, ele não
    // sabe o que fez.
    expect(oQueEstaBaixaFaz('em_atraso')).toContain('reativa o acesso')
  })

  it('não promete reativação para quem já está ativo', () => {
    // Prometer o que não acontece é a mesma falha, invertida: o operador
    // procuraria a mudança de estado no registro e não a encontraria.
    expect(oQueEstaBaixaFaz('ativa')).not.toContain('reativa')
  })

  it('só `ativa` e `em_atraso` aceitam baixa', () => {
    // `expirada` e `teste` recusam na função: registrar dinheiro que não muda
    // contrato nenhum é pior que recusar — o cliente pagaria e continuaria
    // expirando.
    expect(aceitaBaixa('em_atraso')).toBe(true)
    expect(aceitaBaixa('ativa')).toBe(true)
    expect(aceitaBaixa('expirada')).toBe(false)
    expect(aceitaBaixa('teste')).toBe(false)
    expect(aceitaBaixa(null)).toBe(false)
  })

  it('**o texto do reembolso é literal, e a literalidade é o requisito**', () => {
    // Exigência 3 da §9. A frase está no spec entre aspas porque ela é a metade
    // do F-10 que este épico consegue fechar sozinho — e ela fecha por ser
    // exatamente esta frase, não uma paráfrase amigável.
    expect(O_QUE_A_BAIXA_NAO_FAZ).toBe(
      'Este pagamento não entra no cálculo automático de reembolso; se este ' +
        'cliente pedir cancelamento com devolução, o valor é conferido à mão.',
    )
  })

  it('**o aviso da observação é literal**', () => {
    // Do Modelo de dados do spec, e ela é a única defesa contra o operador
    // anotar no campo o que não gostaria que o titular lesse.
    expect(A_OBSERVACAO_SAI_NA_EXPORTACAO).toBe(
      'Esta observação pode ser lida pelo cliente se ele pedir os dados dele.',
    )
  })
})

describe('o instante do recebimento sai do dia informado', () => {
  it('**é o fim do dia em São Paulo**, e não a meia-noite UTC', () => {
    // Meia-noite UTC de 30/09 é 21h de **29/09** em São Paulo, e a competência
    // sairia certa por sorte na maior parte do mês e errada na virada. O fim do
    // dia civil resolve os dois: o dia é o informado, e a competência que a
    // coluna gerada calcula é a mesma que a tela mostrou.
    const agora = new Date('2026-10-15T12:00:00.000Z')
    const iso = instanteDoRecebimento('2026-09-30', agora)
    expect(iso).toBe('2026-10-01T02:59:59.999Z')
    expect(competenciaDoInstante(iso)).toBe('2026-09')
  })

  it('**nunca devolve instante no futuro**', () => {
    // `fimDoDiaCivil` de hoje é 23h59, depois de agora — e
    // `admin.registrar_pagamento` levanta `RECEBIMENTO_NO_FUTURO`. Sem o corte,
    // toda baixa dada no mesmo dia do recebimento seria recusada, que é o caso
    // mais comum que existe.
    const agora = new Date('2026-09-30T13:00:00.000Z')
    expect(instanteDoRecebimento('2026-09-30', agora)).toBe(agora.toISOString())
  })

  it('um dia impossível de ler cai em agora, em vez de produzir `Invalid Date`', () => {
    const agora = new Date('2026-09-30T13:00:00.000Z')
    expect(instanteDoRecebimento('', agora)).toBe(agora.toISOString())
  })
})
