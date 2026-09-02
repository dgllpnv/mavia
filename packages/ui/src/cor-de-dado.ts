/**
 * Cor de dado por categoria — `docs/design/direcao-visual.md` §2.8.
 *
 * Seis slots, atribuídos por **entidade**. A assinatura desta função é a regra:
 * ela recebe um identificador e nada mais. Se recebesse a lista de categorias
 * do gráfico, alguém acabaria ordenando por valor lá dentro — e aí filtrar uma
 * categoria repintaria todas as outras, destruindo a única âncora que o usuário
 * tem para comparar dois meses.
 *
 * Nenhum hex aqui: a paleta de dados tem valores distintos no claro e no
 * escuro, e só o token conhece os dois. Hex solto no componente quebraria o
 * modo escuro em silêncio.
 *
 * "Outros" não aparece nesta lista de propósito. Ele é um agregado, vem sempre
 * por último e tem cor própria (`--dado-outros`); dar-lhe um slot tiraria a cor
 * de uma categoria real.
 */

export const SLOTS_DE_DADO = [
  'var(--dado-1)', // azul-aço
  'var(--dado-2)', // terracota
  'var(--dado-3)', // verde-mar
  'var(--dado-4)', // vinho
  'var(--dado-5)', // mostarda
  'var(--dado-6)', // rosa
] as const

export type SlotDeDado = (typeof SLOTS_DE_DADO)[number]

export function corDaCategoria(categoriaId: string): SlotDeDado {
  const slot = SLOTS_DE_DADO[digerir(categoriaId) % SLOTS_DE_DADO.length]
  // `noUncheckedIndexedAccess` está ligado, e com razão. O módulo garante o
  // índice, mas o compilador não tem como saber disso.
  return slot ?? SLOTS_DE_DADO[0]
}

/**
 * FNV-1a de 32 bits.
 *
 * Escolhido por ser estável entre execuções, entre plataformas e entre
 * versões: a cor de "Alimentação" precisa ser a mesma no navegador de hoje, no
 * aplicativo de amanhã e na captura de tela que o usuário mandou pelo suporte.
 * Qualquer coisa que dependa de ordem de inserção ou de `Math.random` falha
 * nesse requisito, e falha de um jeito que ninguém reporta como bug.
 */
function digerir(texto: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < texto.length; i++) {
    hash ^= texto.charCodeAt(i)
    // Multiplicação pelo primo 16777619, decomposta para caber em 32 bits.
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
