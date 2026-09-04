import { describe, expect, it } from 'vitest'
import { podeEstornar, razaoParaNao } from './detalhe-do-lancamento'

/**
 * Quem pode ser estornado — a regra que a tela usa para mostrar ou esconder o
 * botão.
 *
 * Ela mora numa função pura de propósito. Enquanto viveu dentro do JSX, mudar
 * a condição era mudar uma expressão no meio de uma árvore de elementos, e o
 * único jeito de saber se ela continuava certa era abrir a tela e olhar.
 *
 * O que este arquivo trava é uma **decisão**, não um detalhe de render: o
 * [ADR 0023](../../../../docs/adr/0023-estorno-de-compra-no-cartao.md) fechou
 * a pendência P-6, e compra de cartão passou a ser estornável. Reintroduzir
 * `ehDeCartao` na condição seria desfazer a decisão do dono do produto sem
 * que ninguém percebesse — a tela simplesmente deixaria de oferecer o botão,
 * e nada quebraria.
 */
describe('quem pode ser estornado', () => {
  const nada = { ehTransferencia: false, ehEstorno: false, ehDeCartao: false }

  it('um lançamento comum de conta pode', () => {
    expect(podeEstornar(nada)).toBe(true)
  })

  it('**uma compra de cartão pode** — ADR 0023, e é o que fechou a P-6', () => {
    expect(podeEstornar({ ...nada, ehDeCartao: true })).toBe(true)
  })

  it('uma transferência não pode: desfazer uma perna criaria dinheiro', () => {
    expect(podeEstornar({ ...nada, ehTransferencia: true })).toBe(false)
    expect(razaoParaNao({ ...nada, ehTransferencia: true })).toBe('transferencia')
  })

  it('um estorno não pode: estornar um estorno refaz o original', () => {
    expect(podeEstornar({ ...nada, ehEstorno: true })).toBe(false)
    expect(razaoParaNao({ ...nada, ehEstorno: true })).toBe('estorno')
  })

  it('**transferência no cartão continua recusada pelo motivo certo**', () => {
    // Importa qual das duas razões aparece: a frase da transferência explica
    // a partida dobrada, e é ela que a pessoa precisa ler. Se `ehDeCartao`
    // voltasse a pesar, esta asserção mudaria de valor sem que a de cima
    // mudasse — daí ela existir separada.
    const t = { ...nada, ehTransferencia: true, ehDeCartao: true }
    expect(podeEstornar(t)).toBe(false)
    expect(razaoParaNao(t)).toBe('transferencia')
  })

  it('sem impedimento, não há razão a mostrar', () => {
    expect(razaoParaNao(nada)).toBe('nenhuma')
  })
})
