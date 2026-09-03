#!/usr/bin/env bash
# O deploy da Mavia — pendência 1D.
#
# Roda **na VPS**, do diretório que contém este arquivo. É idempotente: rodar
# duas vezes não recria segredo, não reaplica migration e não perde dado.
#
# ## A ordem, e por que ela é essa
#
# 1. segredos — gerados uma vez, e nunca no repositório
# 2. Postgres e Redis, e esperar ficarem saudáveis
# 3. migrations, como `mavia_migrate` — o único papel com `BYPASSRLS`
# 4. a credencial de `mavia_app`, que só existe **depois** das migrations
# 5. API e web
# 6. verificação
#
# O passo 4 não pode subir para o 1: `mavia_app` é criado pela migration 0001,
# NOLOGIN, porque um papel que a migration já entrega logando é um papel cuja
# senha vive no histórico do repositório.
set -euo pipefail

cd "$(dirname "$0")"

AMBIENTE=.env

# ---------------------------------------------------------------------------
# 1 · segredos
# ---------------------------------------------------------------------------
# Gerados **na máquina**, uma vez, com 32 bytes de urandom. Nunca passam por
# esta conversa, por commit, nem por variável de ambiente de CI.
if [ ! -f "$AMBIENTE" ]; then
  echo "==> gerando segredos em $AMBIENTE"
  segredo() { head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-40; }

  cat > "$AMBIENTE" <<FIM
# Gerado por implantar.sh. **Não versionar.**
# Perder este arquivo com o volume do Postgres vivo torna o banco inacessível:
# as senhas estão dentro dele, e só dentro dele.
DOMINIO=${DOMINIO:-mavia.o9cmue.easypanel.host}
URL_PUBLICA=https://${DOMINIO:-mavia.o9cmue.easypanel.host}
VERSAO=mais-recente

SENHA_POSTGRES=$(segredo)
SENHA_MIGRATE=$(segredo)
SENHA_APP=$(segredo)
PEPPER_TENTATIVAS=$(segredo)

# Sem estas, cadastro e recuperação respondem 503 em vez de fingir — ver P-3.
SMTP_HOST=
SMTP_PORTA=587
SMTP_USUARIO=
SMTP_SENHA=
SMTP_REMETENTE=

# Sem estas, a entrada pelo Google responde 503 e a tela diz para usar e-mail
# e senha — ver P-4.
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
FIM
  chmod 600 "$AMBIENTE"
else
  echo "==> $AMBIENTE já existe; mantendo os segredos"
fi

set -a
# shellcheck disable=SC1090
. "./$AMBIENTE"
set +a

# ---------------------------------------------------------------------------
# 2 · dados
# ---------------------------------------------------------------------------
echo "==> subindo Postgres e Redis"
docker compose up -d postgres redis

echo "==> esperando ficarem saudáveis"
for _ in $(seq 1 60); do
  saudaveis=$(docker compose ps --format '{{.Service}} {{.Health}}' \
              | grep -c 'healthy' || true)
  [ "$saudaveis" -ge 2 ] && break
  sleep 3
done
if [ "${saudaveis:-0}" -lt 2 ]; then
  echo "ERRO: Postgres ou Redis não ficaram saudáveis." >&2
  docker compose logs --tail 40 postgres redis >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 3 · migrations
# ---------------------------------------------------------------------------
# Container descartável, na rede dos dados, com a imagem da API — as migrations
# viajam **dentro** dela, para que nunca se aplique migration de uma versão
# diferente da que vai rodar.
#
# Como `mavia_migrate`, nunca como superusuário: rodar migration com
# superusuário faz tudo passar, e passar assim esconde os erros de permissão que
# aparecem só no primeiro deploy.
echo "==> aplicando migrations"
docker compose run --rm --no-deps \
  -e DATABASE_URL_MIGRATE="postgresql://mavia_migrate:${SENHA_MIGRATE}@postgres:5432/mavia" \
  --entrypoint node api migrar.js

# ---------------------------------------------------------------------------
# 4 · a credencial de mavia_app
# ---------------------------------------------------------------------------
# `mavia_app` nasce NOLOGIN na migration 0001. Aqui ele ganha senha — e só aqui.
# `ALTER ROLE` é idempotente, então rodar de novo não quebra nada.
echo "==> concedendo credencial a mavia_app"
docker compose exec -T \
  -e PGPASSWORD="$SENHA_POSTGRES" \
  postgres psql -U mavia -d mavia -v ON_ERROR_STOP=1 \
    -v senha="$SENHA_APP" \
    -c "ALTER ROLE mavia_app LOGIN PASSWORD :'senha'" > /dev/null

# ---------------------------------------------------------------------------
# 5 · aplicação
# ---------------------------------------------------------------------------
echo "==> subindo API e web"
docker compose up -d api web

# ---------------------------------------------------------------------------
# 6 · verificação
# ---------------------------------------------------------------------------
# **Um deploy que não é verificado não é um deploy.** As três asserções abaixo
# cobrem o que quebra na prática: a API não subiu, o web não alcança a API, e o
# Traefik não achou o container.
echo "==> verificando"

esperar_api() {
  for _ in $(seq 1 40); do
    if docker compose exec -T api node -e \
      "fetch('http://127.0.0.1:4711/v1/eu').then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))" \
      2>/dev/null; then return 0; fi
    sleep 3
  done
  return 1
}

if esperar_api; then
  echo "  ok  API responde 401 em /v1/eu (sem sessão, como deve)"
else
  echo "  ERRO: a API não respondeu." >&2
  docker compose logs --tail 40 api >&2
  exit 1
fi

if docker compose exec -T web node -e \
  "fetch('http://api:4711/v1/eu').then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))" \
  2>/dev/null; then
  echo "  ok  o web alcança a API pela rede interna"
else
  echo "  ERRO: o web não alcança a API." >&2
  exit 1
fi

codigo=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${DOMINIO}" \
         --resolve "${DOMINIO}:443:127.0.0.1" "https://${DOMINIO}/entrar" || echo 000)
if [ "$codigo" = "200" ]; then
  echo "  ok  o Traefik serve https://${DOMINIO}/entrar"
else
  echo "  ATENÇÃO: o Traefik devolveu $codigo em /entrar." >&2
  echo "  O Traefik demora alguns segundos para ver um container novo." >&2
  echo "  Confira com: docker logs \$(docker ps -qf name=easypanel-traefik)" >&2
fi

echo
echo "Mavia em https://${DOMINIO}"
echo "Segredos em $(pwd)/$AMBIENTE — modo 600, fora do repositório."
