import { describe, expect, it } from 'vitest'
import {
  cabecalhosDaHipotese,
  hipoteseDe,
  MOTIVOS,
  O_QUE_FICA_REGISTRADO,
  referenciaValida,
} from './hipotese'

/**
 * O que se perde se estas regras sumirem: o operador preenche um formulário
 * que a interface aprova e o servidor recusa com 400, sem dizer o quê.
 */

describe('a referência é medida depois do `trim`, como na API', () => {
  it('**recusa espaço em branco disfarçado de conteúdo**', () => {
    // `'  a  '` tem cinco caracteres crus e um depois do `trim`. A API faz
    // `z.string().trim().min(3)`, então ela recusa; uma validação que medisse a
    // string crua aprovaria e o operador levaria 400 de um formulário verde.
    expect(referenciaValida('  a  ')).toBe(false)
    expect(referenciaValida('   ')).toBe(false)
  })

  it('aceita a partir de três caracteres úteis', () => {
    expect(referenciaValida('  abc  ')).toBe(true)
    expect(referenciaValida('#4821')).toBe(true)
  })

  it('o teto é 80, contado depois do `trim`', () => {
    expect(referenciaValida('x'.repeat(80))).toBe(true)
    expect(referenciaValida('x'.repeat(81))).toBe(false)
    // Oitenta úteis com espaço em volta continua valendo: o `trim` os remove
    // dos dois lados antes de a API medir.
    expect(referenciaValida(`  ${'x'.repeat(80)}  `)).toBe(true)
  })

  it('a hipótese carrega a referência **já normalizada**', () => {
    // Enviar a string crua faria a auditoria guardar os espaços, e duas
    // referências que apontam para o mesmo chamado sairiam diferentes no
    // registro — que é a única coisa que liga uma leitura a um caso real.
    expect(hipoteseDe('chamado', '  #4821  ')).toEqual({
      motivo: 'chamado',
      referencia: '#4821',
    })
  })

  it('devolve nulo quando não serve, em vez de lançar', () => {
    expect(hipoteseDe('chamado', ' ')).toBeNull()
  })
})

describe('os cabeçalhos', () => {
  it('são exatamente os dois que a API exige', () => {
    // Um terceiro cabeçalho, ou um nome diferente, é 400 com mensagem de
    // validação — que se parece com "o formulário está errado".
    expect(cabecalhosDaHipotese({ motivo: 'incidente', referencia: 'INC-9' })).toEqual({
      'x-mavia-motivo': 'incidente',
      'x-mavia-referencia': 'INC-9',
    })
  })
})

describe('a lista de motivos', () => {
  it('**é fechada, e é a mesma da API**', () => {
    // Um valor a mais aqui não vira permissão: ele vira 400. Um a menos torna
    // um motivo legítimo inalcançável pela interface, e o operador escolhe o
    // motivo errado para conseguir trabalhar — que é pior que não registrar.
    expect(MOTIVOS.map(([v]) => v)).toEqual([
      'chamado',
      'incidente',
      'defeito',
      'ordem_judicial',
    ])
  })
})

describe('o texto do portão', () => {
  it('**nomeia o que fica registrado, item a item**', () => {
    // "Este acesso é auditado" não informa nada: auditado como, e contendo o
    // quê. A enumeração é o que transforma um aviso em informação.
    for (const parte of ['seu nome', 'instante', 'motivo', 'referência', 'cada tela']) {
      expect(O_QUE_FICA_REGISTRADO).toContain(parte)
    }
  })

  it('**não promete a contagem de registros consultados**', () => {
    // `admin.abrir_espaco` não recebe nem escreve `auditoria.registros`, e o
    // controlador não pode completar a linha depois porque `auditoria` não
    // aceita `UPDATE`. Verificado no banco local: as linhas `leu` das quatro
    // telas de cliente têm `registros` nulo.
    //
    // Este teste existe para o dia em que alguém quiser "melhorar" o texto: a
    // frase que promete a contagem só pode voltar junto com a função que a
    // grava. A interface afirmando um controle que não existe é pior do que a
    // ausência do controle.
    expect(O_QUE_FICA_REGISTRADO).not.toContain('quantos registros')
    expect(O_QUE_FICA_REGISTRADO).not.toContain('contagem')
  })

  it('diz que o registro não é editável', () => {
    // `auditoria` não aceita `UPDATE` de ninguém (spec §3.1). Dizer isso ao
    // operador é a metade do controle que é dissuasão.
    expect(O_QUE_FICA_REGISTRADO).toContain('não pode ser editado')
  })
})
