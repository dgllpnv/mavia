# A imagem da API — pendência 1D.
#
# **O build acontece aqui, e não na máquina de quem faz o deploy.** Não é
# preferência: ao montar este arquivo, o build local revelou que uma extensão de
# editor instalada no ambiente do desenvolvedor entrava no grafo do bundler e
# quase foi para dentro do artefato. Um artefato que depende de quais extensões
# alguém tem instaladas não é reproduzível, e "compilou na minha máquina" deixa
# de significar qualquer coisa.
#
# Debian `slim`, e não Alpine: `@node-rs/argon2` é binário nativo, e a diferença
# entre glibc e musl é o tipo de problema que aparece na primeira tentativa de
# login em produção. Alguns megabytes a mais valem menos que essa certeza.

# ---------------------------------------------------------------------------
# 1 · dependências — a camada que o cache guarda
# ---------------------------------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /repo

RUN corepack enable

# **Só os manifestos, antes do código.** É o que faz uma mudança em `.ts` não
# reinstalar 1200 pacotes: o Docker só invalida esta camada quando um
# `package.json` ou o lockfile muda de verdade.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json                 apps/api/
COPY apps/web/package.json                 apps/web/
COPY apps/mobile/package.json              apps/mobile/
COPY apps/guardiao/package.json            apps/guardiao/
COPY packages/domain/package.json          packages/domain/
COPY packages/contracts/package.json       packages/contracts/
COPY packages/parser/package.json          packages/parser/
COPY packages/ui/package.json              packages/ui/
COPY packages/guardiao/package.json        packages/guardiao/

# `--frozen-lockfile`: se o lockfile não corresponder aos manifestos, o build
# **falha** em vez de resolver versões novas por conta própria. Um deploy que
# instala uma versão diferente da testada é um deploy que não foi testado.
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# 2 · build — o bundle
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /repo

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api

# O bundle resolve `@mavia/domain`, `contracts`, `parser` e `guardiao` em tempo
# de build. Ver `apps/api/construir.mjs` para por que não é `tsc`.
RUN node apps/api/construir.mjs

# **A verificação que este build existe para garantir.** Se instrumentação de
# editor tiver entrado no artefato, o deploy para aqui.
#
# Os três marcadores são específicos de propósito. A primeira versão desta linha
# incluía `buildHook`, que casou com código legítimo de dependência e reprovou um
# artefato limpo. Uma verificação que dá falso positivo é desligada por quem tem
# pressa, e aí deixa de verificar qualquer coisa.
RUN set -eu; \
    for proibido in console-ninja wallabyjs .vscode; do \
      if grep -qF "$proibido" apps/api/dist/api.js apps/api/dist/parser-cli.js; then \
        echo "ERRO: '$proibido' entrou no artefato de producao." >&2; exit 1; \
      fi; \
    done; \
    echo "artefato limpo"

# O `node_modules` de produção, podado e sem links simbólicos, para o estágio
# final copiar. `hoisted` porque a imagem final não tem pnpm para resolver o
# store — ela só tem `node`.
# `--legacy` porque o pnpm 10+ só faz `deploy` de workspace com
# `inject-workspace-packages`, e ligar isso mudaria como **todo** o
# desenvolvimento resolve os pacotes internos por causa do deploy. O modo legado
# faz exatamente o que se quer aqui: resolver pelo lockfile e desmontar os links.
RUN pnpm --filter @mavia/api --prod --legacy --config.node-linker=hoisted deploy /prod

# ---------------------------------------------------------------------------
# 3 · runtime — só o que roda
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
# UTC no processo. A conversão para `America/Sao_Paulo` é do domínio, nunca do
# servidor — `CLAUDE.md` regra 7. Um container em outro fuso deslocaria a borda
# de todo dia civil.
ENV TZ=UTC
# Todas as interfaces **do container**, que é uma rede privada onde só o Traefik
# e o web entram — e nenhuma porta é publicada no host. Ligado em `127.0.0.1`,
# como no ambiente local, nem o web do lado alcançaria a API. Ver `main.ts`.
ENV HOST=0.0.0.0

# As dependências que ficam **fora** do bundle, por serem binário nativo ou por
# carregarem arquivo em runtime: `pg`, `ioredis`, `bullmq`, `@node-rs/argon2`.
#
# Vêm do `pnpm deploy`, feito no estágio de build: ele resolve **pelo lockfile**,
# poda as de desenvolvimento e desmonta os links simbólicos do store. Instalar
# aqui com `npm install pg@8` pegaria a última versão compatível do dia do
# build, e não a versão que a suíte de testes exercitou.
COPY --from=build /prod/node_modules ./node_modules
COPY --from=build /prod/package.json ./package.json

COPY --from=build /repo/apps/api/dist/ ./

# As migrations viajam com a imagem: aplicar migration de uma versão diferente
# da que está rodando é a forma mais direta de quebrar produção.
COPY --from=build /repo/apps/api/migrations/ ./migrations/

# **Não roda como root.** O `node` da imagem oficial já tem um usuário `node`
# sem privilégio; usá-lo é gratuito, e é o que limita o dano de um RCE.
USER node

EXPOSE 4711

# Sem `--enable-source-maps`: o `sourcemap: 'inline'` do bundle já resolve, e a
# flag duplicaria o custo de memória.
CMD ["node", "api.js"]
