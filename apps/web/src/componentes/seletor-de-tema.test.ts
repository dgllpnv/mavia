import { describe, expect, it } from 'vitest'
import { CHAVE_DO_TEMA, SCRIPT_ANTI_PISCADA } from './seletor-de-tema'

/**
 * O script anti-piscada é uma **string literal**, e por isso a chave do
 * `localStorage` aparece duas vezes no arquivo: uma na constante que o React
 * usa, outra dentro do script que roda antes do React existir.
 *
 * A duplicação é deliberada — interpolar num `dangerouslySetInnerHTML` obriga
 * quem revisa a rastrear a origem do valor para concluir o óbvio. O preço é que
 * as duas podem divergir, e divergir aqui tem um sintoma cruel: o tema salvo
 * simplesmente deixa de ser lido no carregamento, a tela pisca, e nada falha.
 *
 * Este arquivo é o que cobra o preço.
 */
describe('o script que roda antes do primeiro pixel', () => {
  it('**lê a mesma chave que o componente escreve**', () => {
    expect(SCRIPT_ANTI_PISCADA).toContain(`localStorage.getItem('${CHAVE_DO_TEMA}')`)
  })

  it('escreve o atributo que o CSS espera', () => {
    // Os tokens reagem a `data-tema`; qualquer outro nome pinta nada.
    expect(SCRIPT_ANTI_PISCADA).toContain("setAttribute('data-tema'")
  })

  it('**só aceita os dois valores explícitos**', () => {
    // `sistema` é a ausência do atributo, não um valor dele. Se o script
    // aceitasse qualquer string do `localStorage`, um valor plantado ali viraria
    // um atributo arbitrário no elemento raiz.
    expect(SCRIPT_ANTI_PISCADA).toContain("t === 'claro' || t === 'escuro'")
  })

  it('não interpola nada', () => {
    // A propriedade que torna a inspeção do `dangerouslySetInnerHTML` trivial:
    // o que vai para o HTML é exatamente o que está escrito no fonte.
    expect(SCRIPT_ANTI_PISCADA).not.toContain('${')
  })

  it('tolera `localStorage` bloqueado', () => {
    // Modo privativo lança ao ler. Sem o `try`, o script quebraria antes de
    // qualquer outra coisa da página carregar.
    expect(SCRIPT_ANTI_PISCADA).toContain('try {')
    expect(SCRIPT_ANTI_PISCADA).toContain('catch')
  })
})
