import { describe, expect, it } from 'vitest'
import {
  chaveDeCompetencia,
  competenciaDoInstante,
  competenciaPorExtenso,
  dataEHoraNaTela,
  dataNaTela,
  diasEntre,
} from './formatos'

/**
 * O que se perde se estas regras sumirem: a competência da receita muda de mês
 * sozinha, e o operador não tem como saber.
 */

describe('competência é data civil, e não instante', () => {
  it('**não converte fuso**, venha a `DATE` como for serializada', () => {
    // As três formas em que a mesma competência de setembro pode atravessar o
    // driver, dependendo do fuso do processo da API. Se qualquer uma delas
    // passasse por uma conversão para `America/Sao_Paulo`, a primeira viraria
    // **agosto** — três horas antes da meia-noite de 1º de setembro em UTC é
    // 31 de agosto às 21h em São Paulo.
    expect(competenciaPorExtenso('2026-09-01')).toBe('setembro de 2026')
    expect(competenciaPorExtenso('2026-09-01T00:00:00.000Z')).toBe('setembro de 2026')
    expect(competenciaPorExtenso('2026-09-01T03:00:00.000Z')).toBe('setembro de 2026')
  })

  it('escreve o mês por extenso, e não o número', () => {
    // Item 9 da auditoria do ticket. `01/2026` e `2026-01` são lidos como dia
    // por metade das pessoas; "janeiro de 2026" não é lido de dois jeitos.
    expect(competenciaPorExtenso('2026-01-01')).toBe('janeiro de 2026')
    expect(competenciaPorExtenso('2026-12-01')).toBe('dezembro de 2026')
  })

  it('devolve a entrada intacta quando ela não é uma data', () => {
    // Preferimos exibir o valor cru a exibir "undefined de undefined": o
    // operador precisa poder copiar o que veio e perguntar.
    expect(competenciaPorExtenso('')).toBe('')
    expect(competenciaPorExtenso('2026-13-01')).toBe('2026-13-01')
  })

  it('a chave de comparação é `AAAA-MM` nas duas formas', () => {
    expect(chaveDeCompetencia('2026-09-01')).toBe('2026-09')
    expect(chaveDeCompetencia('2026-09-01T00:00:00.000Z')).toBe('2026-09')
  })
})

describe('a competência de um instante é calculada em São Paulo', () => {
  it('**22h de 30 de setembro em São Paulo é setembro**, não outubro', () => {
    // O exemplo é do próprio spec (§8.2 b, achado F-5): 30/09 22h em
    // `America/Sao_Paulo` é 01/10 01h em UTC. Derivar a competência do UTC nu
    // mandaria a receita para outubro, e a coluna gerada do banco a manteria em
    // setembro — a tela e a escrituração discordariam sobre o mesmo dinheiro.
    expect(competenciaDoInstante('2026-10-01T01:00:00.000Z')).toBe('2026-09')
  })

  it('a virada de mês em São Paulo acontece às 03h UTC', () => {
    expect(competenciaDoInstante('2026-10-01T02:59:59.000Z')).toBe('2026-09')
    expect(competenciaDoInstante('2026-10-01T03:00:00.000Z')).toBe('2026-10')
  })
})

describe('instantes na tela', () => {
  it('exibe o dia em São Paulo, não em UTC', () => {
    // 01/10 00h30 UTC é 30/09 21h30 em São Paulo. Sem a conversão, o operador
    // veria uma baixa registrada num dia em que ele não estava trabalhando.
    expect(dataNaTela('2026-10-01T00:30:00.000Z')).toBe('30/09/2026')
  })

  it('a hora acompanha a data, e no relógio de 24 horas', () => {
    expect(dataEHoraNaTela('2026-10-01T00:30:00.000Z')).toBe('30/09/2026 21:30')
  })

  it('**a meia-noite é 00:00, nunca 24:00**', () => {
    // `hour12: false` escreve `24:00` em algumas implementações, e um registro
    // carimbado às "24:07" faz duvidar do relógio inteiro.
    expect(dataEHoraNaTela('2026-09-15T03:00:00.000Z')).toBe('15/09/2026 00:00')
  })
})

describe('dias entre dois instantes', () => {
  it('conta o dia começado', () => {
    // Trinta dias e uma hora ainda faltam "31 dias" de calendário para quem
    // olha: arredondar para baixo diria 30 e a cortesia pareceria menor do que
    // foi concedida.
    const de = new Date('2026-09-01T12:00:00.000Z')
    expect(diasEntre(de, new Date('2026-10-01T12:00:00.000Z'))).toBe(30)
    expect(diasEntre(de, new Date('2026-10-01T13:00:00.000Z'))).toBe(31)
  })

  it('é negativo quando a data já passou', () => {
    // O fim efetivo no passado precisa aparecer como passado, e não como zero.
    const de = new Date('2026-09-10T12:00:00.000Z')
    expect(diasEntre(de, new Date('2026-09-08T12:00:00.000Z'))).toBe(-2)
  })
})
