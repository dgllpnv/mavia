/**
 * Configuração do app web da Mavia.
 *
 * `transpilePackages` porque `@mavia/domain`, `@mavia/contracts` e `@mavia/ui`
 * são publicados como **TypeScript de origem**, sem passo de build. É de
 * propósito: um `dist` no meio faria "ir à definição" cair em `.d.ts`, e faria
 * toda mudança no domínio exigir rebuild antes de aparecer na tela.
 */
const config = {
  reactStrictMode: true,

  /**
   * `standalone` — o que torna a imagem de produção viável.
   *
   * Sem isto, servir o Next exige o `node_modules` inteiro do monorepo dentro
   * da imagem: centenas de megabytes, com dependências de desenvolvimento e
   * binários nativos compilados para o sistema de quem construiu. Com
   * `standalone`, o Next emite um servidor com **só** o que a aplicação
   * alcança de fato, e a imagem final não precisa de pnpm nem de workspace.
   */
  output: 'standalone',
  /**
   * A raiz do monorepo, e não a do app. Sem isto o rastreamento de arquivos do
   * `standalone` para na pasta do `apps/web` e deixa fora `packages/domain`,
   * `contracts` e `ui` — que são justamente os que o `transpilePackages`
   * compila para dentro.
   */
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,

  transpilePackages: ['@mavia/domain', '@mavia/contracts', '@mavia/ui'],
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    // O pacote de UI traz CSS que o Next precisa processar do workspace.
    externalDir: true,
  },

  /**
   * A API é servida **pela mesma origem**, sob `/api`.
   *
   * Não é conveniência: é o que faz o cookie de sessão funcionar sem CORS e
   * sem exceção de `SameSite`. O navegador só conhece `127.0.0.1:4710`; quem
   * fala com `:4711` é o servidor do Next.
   *
   * E é a mesma topologia da produção — um domínio, roteamento por caminho no
   * Traefik. Configuração de CORS que existe só em desenvolvimento é
   * configuração que ninguém testa antes do deploy.
   */
  /**
   * Ensina o resolvedor o que o TypeScript já sabe.
   *
   * `packages/domain` importa `./result.js` — a forma **correta** de ESM em
   * TypeScript, em que o especificador aponta para o arquivo emitido. O
   * `transpilePackages` compila esses pacotes, mas não traduz o especificador,
   * e o webpack vai procurar um `result.js` que não existe no repositório.
   *
   * A alternativa seria apagar as extensões nos pacotes compartilhados, o que
   * quebraria o consumo por Node em ESM puro — e os pacotes existem justamente
   * para ser consumidos por web, mobile e API, cada um com um resolvedor.
   *
   * O código do próprio app não usa `.js`: ali a convenção é a do Next.
   */
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    }
    return config
  },

  /**
   * **O destino é resolvido no build, não em runtime.** Isto custou um ciclo de
   * depuração: `rewrites()` entra no manifesto de rotas que o `next build`
   * emite, então passar `MAVIA_API_URL` ao container **não** tem efeito — o
   * valor lido foi o do momento em que a imagem foi construída.
   *
   * Daí o padrão depender de `NODE_ENV` em vez de exigir configuração:
   *
   * - em produção, `api` é o nome do serviço na rede interna do compose, e é
   *   sempre o endereço certo lá;
   * - fora dela, `127.0.0.1:4711` é sempre o endereço certo.
   *
   * As duas situações ficam corretas sem ninguém configurar nada, e
   * `MAVIA_API_URL` continua existindo para o caso de a topologia mudar — mas
   * como **argumento de build**, que é o que ela de fato é.
   */
  async rewrites() {
    const padrao =
      process.env.NODE_ENV === 'production' ? 'http://api:4711' : 'http://127.0.0.1:4711'
    // **`||` e não `??`, e a diferença custou um deploy.** Um `ARG` do Docker
    // que não é passado vira `ENV` com string **vazia**, não indefinida — e o
    // `??` só cai no padrão para `null` e `undefined`. O destino do rewrite
    // ficou `/:caminho*`, sem host, e `/api/...` respondia 404 em produção
    // enquanto todas as telas funcionavam.
    const api = process.env.MAVIA_API_URL || padrao
    return [{ source: '/api/:caminho*', destination: `${api}/:caminho*` }]
  },
}

export default config
