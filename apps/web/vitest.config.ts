import { defineConfig } from 'vitest/config'

/**
 * O Vitest do app web cobre `src`, e **só** `src`.
 *
 * `e2e/` é do Playwright: o `test` de lá é outro, com outra assinatura e outro
 * runner. Sem esta exclusão o Vitest coleta os specs de E2E, falha no primeiro
 * `test.describe` e derruba `pnpm test` inteiro — que foi exatamente o que
 * aconteceu assim que o cache do Turbo invalidou.
 *
 * Os dois corredores são separados de propósito: o de unidade roda em segundos
 * e não precisa de banco nem de navegador; o de E2E precisa dos dois, e amarrar
 * um ao outro faria a suíte rápida deixar de ser rápida.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    passWithNoTests: true,
  },
})
