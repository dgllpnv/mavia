import { build } from 'esbuild'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Todos os caminhos daqui são relativos a **este arquivo**, e não ao diretório
 * de trabalho. Rodar `node apps/api/construir.mjs` da raiz do repositório é
 * exatamente o que o Dockerfile faz, e a primeira versão deste script quebrava
 * ali — funcionava só quando invocado de dentro de `apps/api`.
 */
const AQUI = dirname(fileURLToPath(import.meta.url))

/**
 * O build da API para produção — pendência 1D.
 *
 * **Um bundle, e não `tsc`.** A razão é o monorepo: `packages/domain`,
 * `contracts`, `parser` e `guardiao` publicam **TypeScript de origem**
 * (`"exports": "./src/index.ts"`), de propósito — é o que faz "ir à definição"
 * cair no código e não num `.d.ts`, e o que evita rebuild a cada mudança no
 * domínio. Compilar com `tsc` exigiria dar a cada pacote um `dist` e reescrever
 * os `exports`, trocando a ergonomia de desenvolvimento pela do deploy.
 *
 * O bundle resolve os quatro pacotes em tempo de build e emite um arquivo. O
 * container de produção não precisa de pnpm, de workspace, nem de `node_modules`
 * para o nosso próprio código.
 *
 * ## Por que isto funciona com o Nest
 *
 * O esbuild **não** emite `emitDecoratorMetadata`, e a injeção do Nest que
 * depende disso é a que declara dependência **só pelo tipo** do parâmetro. Este
 * código não tem nenhuma: toda injeção usa `@Inject(TOKEN)` explícito, e há
 * teste de boot que reprova se uma rota ficar sem regra na matriz — ou seja, um
 * erro de DI aparece na inicialização, não em produção.
 *
 * ## O que fica fora do bundle
 *
 * As dependências nativas e as que carregam arquivo próprio em runtime:
 * `@node-rs/argon2` (binário), `pg`, `ioredis`, `bullmq`. Empacotá-las custaria
 * mais do que entrega — elas vêm do `node_modules` de produção, instalado sem
 * as de desenvolvimento.
 */

const externos = [
  // Binário nativo. Empacotar não faz sentido.
  '@node-rs/argon2',
  // Drivers com carregamento dinâmico.
  'pg',
  'pg-native',
  'ioredis',
  'bullmq',
  // O Nest resolve pacotes opcionais por `require` condicional; deixá-los
  // externos evita que o esbuild tente resolver o que não instalamos.
  '@nestjs/microservices',
  '@nestjs/websockets',
  '@nestjs/platform-express',
  // Extras opcionais do adaptador Fastify. Servir arquivo estático e renderizar
  // template não são coisas que esta API faz — ela devolve JSON.
  //
  // Marcá-los externos não é cosmético: sem isso o esbuild **sobe a árvore de
  // diretórios** procurando por eles, sai do repositório, e chega na pasta de
  // extensões do editor do desenvolvedor — onde encontra uma cópia embutida de
  // `consolidate` dentro de uma delas. O build passava a depender de quais
  // extensões estão instaladas na máquina, e o artefato de produção passava a
  // carregar instrumentação de editor.
  '@fastify/static',
  '@fastify/view',
  'class-transformer',
  'class-validator',
  'cache-manager',
]

const comum = {
  absWorkingDir: AQUI,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: externos,
  // `inline` e não `external`: o mapa vai dentro do arquivo, e o rastro de
  // pilha de um 500 em produção aponta para a linha do fonte. Sem isso o
  // `ErroInesperadoFilter` registraria uma pilha ilegível.
  sourcemap: 'inline',
  // Sem minificação: o ganho de tamanho não paga a perda de legibilidade do
  // rastro de pilha num produto que lida com dinheiro.
  minify: false,
  logLevel: 'info',
  /**
   * `import.meta.url` e `require` em ESM empacotado.
   *
   * Algumas dependências do Nest usam `require` mesmo sob ESM. O `banner`
   * reconstrói o `require` a partir de `createRequire`, que é o caminho
   * oficial — sem isso o bundle quebra na primeira dependência que o usa.
   */
  banner: {
    js: [
      "import { createRequire as __criarRequire } from 'node:module'",
      'const require = __criarRequire(import.meta.url)',
    ].join('\n'),
  },
}

await build({
  ...comum,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/api.js',
})

/**
 * O executor de migrations, num arquivo próprio.
 *
 * Ele **não** roda dentro do processo da API: migration é um passo do deploy,
 * com credencial diferente (`mavia_migrate`, o único papel com `BYPASSRLS`).
 * Aplicá-la na inicialização faria dois containers subindo em paralelo tentarem
 * migrar ao mesmo tempo, e daria à API um papel que ela não deve ter.
 */
await build({
  ...comum,
  entryPoints: ['src/db/migrar-cli.ts'],
  outfile: 'dist/migrar.js',
})

/**
 * A semente, junto do migrador e pelo mesmo motivo.
 *
 * Ela é ferramenta de **deploy**, não da aplicação: cria o espaço de
 * demonstração uma vez, com credencial própria, e nunca é chamada por uma rota.
 * Sem ela na imagem, semear um ambiente remoto exigiria clonar o repositório e
 * instalar as dependências na máquina de destino — e aí a semente que roda
 * deixa de ser a que foi testada.
 *
 * A trava dela continua valendo: contra um banco que não é local, sem
 * `SENHA_DEMO` ela recusa.
 */
await build({
  ...comum,
  entryPoints: ['src/db/semear.ts'],
  outfile: 'dist/semear.js',
})

/**
 * O parser, num arquivo **separado**.
 *
 * Ele não é importado pela API: é **executado** como processo filho, um por
 * arquivo, com `env: {}`. Empacotá-lo junto o traria de volta para dentro do
 * processo que tem a `DATABASE_URL` — exatamente o que o ADR 0016 separou.
 *
 * Sem `banner`: este arquivo não usa `require`, e não deve passar a usar. Ele é
 * o pacote sem dependências que cabe no processo descartável.
 */
await build({
  ...comum,
  banner: {},
  entryPoints: ['../../packages/parser/src/cli.ts'],
  outfile: 'dist/parser-cli.js',
})

console.log('\nAPI e parser construídos em dist/.')
