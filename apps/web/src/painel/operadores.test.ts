import { describe, expect, it } from 'vitest'
import {
  administraOperadores,
  emailNormalizado,
  emailValido,
  O_QUE_A_REVOGACAO_FAZ,
  oQueAConcessaoFaz,
  POR_QUE_NAO_HA_LISTAGEM,
} from './operadores'

/**
 * O que se perde se estas regras sumirem: um operador comum vê um botão que
 * sempre recusa, ou alguém constrói a listagem "por conveniência" e reconstrói
 * pelo painel exatamente a enumeração que a migration `0031` recusa a entregar.
 */

describe('o e-mail — e nunca o id', () => {
  it('**um UUID não passa por endereço**', () => {
    // Um identificador que ninguém confere a olho: colar o errado torna
    // administrador alguém que o operador nem sabe quem é.
    expect(emailValido('22222222-2222-4222-8222-222222222222')).toBe(false)
  })

  it('apara antes de medir, como o Zod da rota', () => {
    expect(emailNormalizado('  alguem@exemplo.test  ')).toBe('alguem@exemplo.test')
    expect(emailValido('  alguem@exemplo.test  ')).toBe(true)
  })

  it('recusa o vazio e o comprimento acima do que a rota aceita', () => {
    expect(emailValido('   ')).toBe(false)
    expect(emailValido(`${'a'.repeat(320)}@exemplo.test`)).toBe(false)
  })

  it('**não é mais estrita que a API**, e isso é deliberado', () => {
    // Uma tela mais estrita que o servidor recusa endereços válidos sem que
    // exista regra que os recuse, e a pessoa fica sem entender por que o botão
    // não liga. Mais frouxa, o pior caso é uma ida que volta com a frase do
    // servidor.
    expect(emailValido("o'brien+painel@sub.dominio.test")).toBe(true)
  })
})

describe('quem administra operadores', () => {
  it('**só o super**, e esconder o formulário não é o controle', () => {
    // `admin.conceder_operador` exige `super` de qualquer jeito, e a recusa vem
    // do banco. O que isto evita é uma interface que mente: um botão que sempre
    // recusa ensina o operador a duvidar de todos os outros.
    expect(administraOperadores('super')).toBe(true)
    expect(administraOperadores('operador')).toBe(false)
  })

  it('**conceder `super` diz que é o mesmo poder de quem concede**', () => {
    // Escalada de privilégio por desenho. A frase é o que faz alguém parar
    // antes de promover por hábito.
    expect(oQueAConcessaoFaz('super')).toContain('revogar o seu')
    expect(oQueAConcessaoFaz('operador')).toContain('não faz')
  })

  it('a revogação nomeia a invariante dos dois ativos', () => {
    expect(O_QUE_A_REVOGACAO_FAZ).toContain('menos de dois')
  })

  it('**a tela diz por que não há listagem**', () => {
    // A ausência é a decisão, e uma tela que não a explica é uma tela em que
    // alguém vai acrescentar a lista por conveniência.
    expect(POR_QUE_NAO_HA_LISTAGEM).toContain('Enumerar, não')
  })
})
