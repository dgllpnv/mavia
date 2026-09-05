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

  /**
   * **A guarda que precede tudo.**
   *
   * `reuseExistingServer` abaixo é o que evita subir um Next por execução — e é
   * também o que deixa a suíte se pendurar num servidor que não é o deste
   * worktree, se houver um ocupando a porta. Quando isso acontece, os testes
   * medem outro código e **passam em verde**.
   *
   * Não é hipótese: em 2026-09-05 a primeira execução da suíte de largura rodou
   * oito minutos contra o `pnpm dev` do diretório principal. A guarda roda
   * depois do `webServer` e antes de qualquer teste, e aborta tudo se o
   * servidor não conhecer as rotas que existem em `src/app` aqui. O porquê
   * inteiro está em `e2e/guarda-do-servidor.ts`.
   */
  globalSetup: './e2e/guarda-do-servidor.ts',
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

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },

    /**
     * O navegador do celular — 390×844, com toque.
     *
     * **390 não é um número redondo escolhido por gosto:** é a largura do
     * aparelho de referência do épico (`.scratch/mobile-web/issues/README.md`),
     * e o piso prático do mercado atual. Quem cabe em 390 cabe em 393, 412 e
     * 430; o contrário não vale.
     *
     * `devices['iPhone 12']` dá exatamente essa métrica, mais `isMobile` e
     * `hasTouch` — e `isMobile` importa mais do que parece: sem ele o Chromium
     * **ignora a `<meta name="viewport">`**, e a suíte mediria um desktop
     * estreito em vez de um telefone. O diagnóstico do épico registra que essa
     * meta está correta em produção; é justamente por isso que o teste precisa
     * exercitá-la.
     *
     * O motor é Chromium e não WebKit, de propósito: o que se mede aqui é
     * **layout**, e trocar de motor traria diferenças de renderização que
     * ninguém pediu para vigiar agora. A cobertura de Safari real é do telefone
     * do dono, que é a outra metade da decisão 8.
     */
    {
      name: 'mobile',
      // Só a invariante de largura, e isto é escopo, não indulgência. Os
      // fluxos de `fluxo-critico.spec.ts` procuram a barra de navegação do
      // desktop; rodá-los a 390px hoje produziria vermelho de seletor, e não
      // vermelho de produto — e vermelho que não é produto ensina o time a
      // ignorar vermelho. Ampliar este `testMatch` é entrega do ticket 05,
      // depois que as telas forem convertidas.
      testMatch: /largura\.spec\.ts$/,
      use: {
        ...devices['iPhone 12'],
        browserName: 'chromium',
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
      },
    },
  ],

  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:4710/entrar',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
