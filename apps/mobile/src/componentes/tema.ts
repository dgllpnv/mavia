/**
 * Os tokens do app, em objeto.
 *
 * O React Native não tem CSS, então o design system compartilhado não atravessa
 * como está — os valores são os mesmos de `packages/ui`, transcritos. É
 * duplicação, e ela é declarada: a alternativa seria um gerador que converte os
 * tokens CSS em objeto, e um gerador para nove cores é mais peça para manter do
 * que ganho.
 *
 * Quando o design system crescer, o gerador passa a valer a pena. Hoje não.
 */
export const cor = {
  marca: '#0F3B3A',
  fundo: '#111110',
  superficie: '#1A1A18',
  superficie2: '#232320',
  linha: '#33332E',
  tinta0: '#F5F4F0',
  tinta1: '#D9D7D0',
  tinta2: '#A3A099',
  tinta3: '#75736D',
  receita: '#4E9A6B',
  despesa: '#D6604D',
  atencao: '#C89A3C',
} as const

export const espaco = { x1: 4, x2: 8, x3: 12, x4: 16, x5: 20, x6: 24, x8: 32 } as const
