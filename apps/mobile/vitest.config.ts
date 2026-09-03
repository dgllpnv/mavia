import { defineConfig } from 'vitest/config'

/**
 * Só o núcleo puro entra na suíte.
 *
 * As telas dependem do runtime do React Native, que não roda em Node — testá-las
 * aqui exigiria um dublê do dispositivo inteiro, e um teste contra dublê prova
 * que o dublê funciona. O que dá para provar sem dispositivo é a fila, e é
 * justamente ela que decide o que acontece com o dinheiro de alguém quando a
 * rede cai.
 */
export default defineConfig({
  test: { include: ['src/nucleo/**/*.test.ts'] },
})
