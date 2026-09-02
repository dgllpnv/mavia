/**
 * Tailwind v4 entra pelo PostCSS, e é a única transformação de CSS do projeto.
 *
 * A configuração de tema não vive num arquivo JavaScript: ela é o bloco
 * `@theme inline` de `globais.css`, que **lê** os tokens de `@mavia/ui`. Um
 * `tailwind.config.ts` duplicaria a paleta, e duas paletas divergem — a do
 * mobile ficaria com a cor certa e a da web com a antiga, ou o contrário.
 */
const config = {
  plugins: { '@tailwindcss/postcss': {} },
}

export default config
