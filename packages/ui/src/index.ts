/**
 * @mavia/ui — o design system compartilhado entre web e mobile.
 *
 * O que mora aqui é o que **pode estar errado**: a geometria do trilho e a
 * atribuição de cor de dado. Cor, altura e hachura são CSS, e CSS errado se vê;
 * uma carga de 140% desenhada como 100% não se vê, e é exatamente o número que
 * o usuário abriu o produto para conferir.
 *
 * Os tokens são CSS puro, importados por caminho:
 *
 * ```ts
 * import '@mavia/ui/tokens.css'
 * ```
 */

export {
  geometriaDoTrilho,
  type DadosDoTrilho,
  type GeometriaDoTrilho,
} from './trilho.js'

export { corDaCategoria, SLOTS_DE_DADO, type SlotDeDado } from './cor-de-dado.js'
