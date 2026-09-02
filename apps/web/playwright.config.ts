import { defineConfig, devices } from '@playwright/test'

/**
 * Seam S5 — o fluxo crítico do web, ponta a ponta.
 *
 * Sem servidor de mentira e sem API interceptada: o navegador fala com o Next,
 * que fala com a API, que fala com o Postgres local. Um E2E que responde a
 * `route.fulfill` prova que o componente sabe desenhar um JSON — e é
 * exatamente o que os testes de unidade já provam, mais barato.
 *
 * O que estes testes existem para pegar é o que só aparece quando as peças se
 * encontram: o cookie que não viaja, o cabeçalho de espaço que falta, o
 * `posted_at` que muda de dia entre o formulário e o banco.
 *
 * **Pré-requisito:** `mavia up`, `pnpm db:migrate`, `pnpm db:seed`, e a API em
 * `127.0.0.1:4711`. O `webServer` abaixo sobe só o Next; a API fica de fora de
 * propósito, porque subi-la aqui esconderia a dependência.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // Serial, e com um worker: os testes compartilham o mesmo espaço semeado, e
  // dois lançando ao mesmo tempo fariam as asserções de total dependerem de
  // ordem de escalonamento.
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: process.env['CI'] ? 'list' : [['list']],

  use: {
    baseURL: 'http://127.0.0.1:4710',
    // Bloco 47xx, e sempre em 127.0.0.1 — ver infra/README.md.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'pt-BR',
    // O fuso do navegador é o do usuário brasileiro. Rodar o E2E em UTC
    // esconderia justamente os erros de borda de dia que a regra 7 previne.
    timezoneId: 'America/Sao_Paulo',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:4710/entrar',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
