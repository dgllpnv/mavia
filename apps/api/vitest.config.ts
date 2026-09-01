import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Subir um Postgres real leva mais que o padrão de 5s do vitest. O
    // tempo é do hook de setup, não do teste em si.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
})
