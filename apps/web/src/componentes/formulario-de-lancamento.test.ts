import { describe, expect, it } from 'vitest'
import { naturezaDe } from './formulario-de-lancamento'

/**
 * A natureza que vem do endereço.
 *
 * A rota `/lancar?tipo=` existe porque a aba central do rodapé chama o
 * formulário já sabendo o que a pessoa quer lançar, e porque recarregar a
 * página no meio do preenchimento não pode devolver `despesa` a quem estava
 * lançando uma receita.
 *
 * O endereço é entrada **de fora**: alguém digita, alguém guarda nos favoritos,
 * alguém cola um link antigo. O que este arquivo trava é que nada além das três
 * naturezas do domínio atravessa essa borda — um `?tipo=` inventado abre o
 * formulário de despesa, e não um formulário num estado que o resto do código
 * não sabe tratar.
 */
describe('a natureza lida do endereço', () => {
  it('aceita as três naturezas do domínio', () => {
    expect(naturezaDe('despesa')).toBe('despesa')
    expect(naturezaDe('receita')).toBe('receita')
    expect(naturezaDe('transferencia')).toBe('transferencia')
  })

  it('cai em despesa quando o parâmetro não veio', () => {
    expect(naturezaDe(null)).toBe('despesa')
    expect(naturezaDe(undefined)).toBe('despesa')
    expect(naturezaDe('')).toBe('despesa')
  })

  it('cai em despesa diante de qualquer coisa que não seja uma natureza', () => {
    expect(naturezaDe('DESPESA')).toBe('despesa')
    expect(naturezaDe('transferência')).toBe('despesa')
    expect(naturezaDe('estorno')).toBe('despesa')
    expect(naturezaDe('__proto__')).toBe('despesa')
  })
})
