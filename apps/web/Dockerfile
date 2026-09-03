# A imagem do web — pendência 1D.
#
# Mesma estrutura da API: dependências numa camada própria, build num sistema de
# arquivos limpo, runtime com o mínimo. Ver `apps/api/Dockerfile` para por que o
# build não acontece na máquina de quem faz o deploy.

# ---------------------------------------------------------------------------
# 1 · dependências
# ---------------------------------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /repo

RUN corepack enable

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

RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# 2 · build
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /repo

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web

# `NEXT_TELEMETRY_DISABLED`: o build de um produto financeiro não manda
# estatística de uso para fora durante o deploy.
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# O destino do `rewrite` de `/api` entra no manifesto de rotas **aqui**, no
# build — não é lido do ambiente do container. `NODE_ENV=production` já faz o
# padrão apontar para `http://api:4711`, o nome do serviço na rede interna. O
# argumento existe para o dia em que a topologia mudar.
# **Sem `ENV` a partir deste `ARG`.** Um `ARG` não passado vira `ENV` com string
# vazia, e a leitura no `next.config` interpretava isso como "configurado como
# nada" — o destino do rewrite saía sem host. O `ARG` sozinho já fica visível
# como variável para o `next build`, e quando ausente fica de fato ausente.
ARG MAVIA_API_URL

RUN pnpm --filter @mavia/web build

# ---------------------------------------------------------------------------
# 3 · runtime
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# UTC no processo; a conversão para `America/Sao_Paulo` é do domínio (regra 7).
# No web isso importa duas vezes: o servidor renderiza data, e o navegador
# também.
ENV TZ=UTC
ENV PORT=4710
# Todas as interfaces **do container** — rede privada, sem porta publicada no
# host. Ver o comentário equivalente no Dockerfile da API.
ENV HOSTNAME=0.0.0.0

# O `standalone` do Next: um servidor com só o que a aplicação alcança de fato.
# Os três diretórios são o que ele exige, e cada um vem de um lugar diferente do
# build — trocar a ordem ou o dono quebra em runtime, não no build.
COPY --from=build /repo/apps/web/.next/standalone/ ./
COPY --from=build /repo/apps/web/.next/static/ ./apps/web/.next/static/
COPY --from=build /repo/apps/web/public/ ./apps/web/public/

USER node

EXPOSE 4710

# O `standalone` emite o servidor no caminho do app dentro do monorepo, e não na
# raiz — consequência de `outputFileTracingRoot` apontar para a raiz do
# workspace, que é o que faz `packages/` entrar no rastreamento.
CMD ["node", "apps/web/server.js"]
