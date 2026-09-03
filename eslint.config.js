// @ts-check
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * O lint da Mavia — pendência P-7.
 *
 * **Ele não repete o compilador.** `pnpm typecheck` já roda com `strict` e
 * `noUncheckedIndexedAccess`, e pega a maior parte do que um lint genérico
 * pegaria. O que sobra são as regras que o compilador **não tem**, e é só nelas
 * que este arquivo mexe:
 *
 * | Regra | O que ela pega |
 * |---|---|
 * | `no-floating-promises` | o `await` esquecido — num `INSERT` financeiro, a linha que não foi gravada |
 * | `no-misused-promises` | `async` passado onde se espera função síncrona, como um `onClick` que engole a rejeição |
 * | `no-explicit-any` | a proibição do `CLAUDE.md` §6, agora verificada |
 * | `react-hooks/exhaustive-deps` | a dependência faltando — a que mais dói no `apps/web` |
 *
 * ## Por que sem `stylistic`
 *
 * Estilo aqui é resolvido por convenção e revisão, e um conjunto de regras de
 * formatação produz ruído que ensina a ignorar a saída do lint. A primeira
 * regra de um lint que serve para alguma coisa é que a sua saída seja lida.
 *
 * ## Por que `no-explicit-any` é erro e não aviso
 *
 * `CLAUDE.md` §6 diz "`any` é proibido — use `unknown` e estreite". Uma
 * proibição que sai como aviso é uma sugestão, e sugestões acumulam.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.expo/**',
      '**/build/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/*.config.js',
      '**/*.config.mjs',
      // Gerado pelo Next a cada build, e sobrescrito se alguém o editar.
      'apps/web/next-env.d.ts',
    ],
  },

  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // `projectService` em vez de listar cada `tsconfig.json`: um monorepo
        // com nove pacotes teria nove entradas a manter em sincronia, e a que
        // faltasse sairia como "arquivo fora do projeto" em vez de erro.
        projectService: {
          // Os arquivos de configuração e os `.spec` do Playwright ficam fora
          // do `include` dos `tsconfig.json` — corretamente, porque não entram
          // no build. Sem esta linha o lint os recusa com "não encontrado pelo
          // project service", e um arquivo que o lint não lê é um arquivo sem
          // lint.
          allowDefaultProject: [
            '*.config.ts',
            '*.config.js',
            'apps/web/*.config.ts',
            'apps/api/*.config.ts',
            'apps/web/e2e/*.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // O que o compilador não pega, e o que mais custa perto de dinheiro.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // **`require-await` foi desligada.** As nove ocorrências deste código são
      // todas o mesmo caso legítimo: implementar um método que a *interface*
      // declara como `Promise` sem precisar esperar nada — o adapter de arquivo
      // que revoga sem tocar em rede, o mensageiro que não tem SMTP. Marcar
      // isso como defeito ensinaria a escrever `await Promise.resolve()` para
      // calar o lint, que é pior do que o que ela queria evitar.
      //
      // Ela vem ligada em `recommendedTypeChecked`: desligar exige a linha, e
      // não a ausência dela.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-explicit-any': 'error',

      // **`unbound-method` foi desligada, e não é preguiça.** Ela dispara 39
      // vezes neste código, e todas as 39 são o mesmo padrão: o `setX` que o
      // `useState` devolve, passado adiante. Esses setters não têm `this` — a
      // regra não sabe disso, e o React garante a identidade deles.
      //
      // Uma regra que erra em todas as ocorrências ensina a ignorar a saída do
      // lint, e um lint cuja saída ninguém lê não protege nada.
      '@typescript-eslint/unbound-method': 'off',

      // Ruído que o `strict` já cobre por outro caminho, ou que este código usa
      // de propósito.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // O `_` inicial é a convenção deste código para o parâmetro que existe
      // por contrato de interface e não é usado.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    files: ['apps/web/**/*.tsx', 'apps/mobile/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // A dependência faltando é o defeito de React mais caro que existe: ela
      // não quebra, ela mostra o número de ontem.
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  {
    // Nos testes, a promessa solta é quase sempre um `expect(...).rejects` já
    // tratado pelo runner, e o `any` aparece em dublê de tipo estranho.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/e2e/**', '**/test/**'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
)
