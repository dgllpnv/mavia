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

  async rewrites() {
    const api = process.env.MAVIA_API_URL ?? 'http://127.0.0.1:4711'
    return [{ source: '/api/:caminho*', destination: `${api}/:caminho*` }]
  },
}

export default config
