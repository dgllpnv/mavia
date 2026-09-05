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
SENHA_REDIS=$(segredo)
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

# Sem estas, o checkout responde 503 e o webhook recusa com 400 — que é o
# comportamento certo, e não uma degradação. Ver docs/o-que-depende-de-voce.md
# §4 para onde pegar cada uma.
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PUBLISHABLE_KEY=
FIM
  chmod 600 "$AMBIENTE"
else
  echo "==> $AMBIENTE já existe; mantendo os segredos"
fi

# Segredos acrescentados depois da primeira instalação.
#
# Sem este bloco, um segredo novo só existiria em instalação nova — e a que está
# no ar, que é justamente a que precisa dele, subiria quebrada no `:?` do
# compose. Cada chave é acrescentada **uma vez**, e nunca sobrescrita: quem já
# tem valor definido continua com o dele.
acrescentar_segredo() {
  if ! grep -q "^$1=" "$AMBIENTE"; then
    echo "==> acrescentando $1 a $AMBIENTE"
    printf '%s=%s
' "$1" "$(head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-40)" >> "$AMBIENTE"
  fi
}
# Ligar a senha reinicia o Redis, e o `appendonly` faz os dados voltarem — nem
# as sessões ativas nem a fila do BullMQ se perdem. O que muda é só quem
# consegue falar com ele.
acrescentar_segredo SENHA_REDIS

# Chaves de configuração acrescentadas depois da primeira instalação. Diferente
# de `acrescentar_segredo`: estas nascem **vazias**, porque o valor vem de fora
# e um valor gerado por nós seria uma credencial que não abre nada — e que
# pareceria configurada.
acrescentar_vazia() {
  if ! grep -q "^$1=" "$AMBIENTE"; then
    echo "==> acrescentando $1= (vazia) a $AMBIENTE"
    printf '%s=
' "$1" >> "$AMBIENTE"
  fi
}
acrescentar_vazia STRIPE_SECRET_KEY
acrescentar_vazia STRIPE_WEBHOOK_SECRET
acrescentar_vazia STRIPE_PUBLISHABLE_KEY

# Chave que nasce com **valor fechado**, e não vazia — é a terceira categoria, e
# a diferença é de segurança, não de estilo.
#
# `acrescentar_vazia` estaria errado aqui por dois motivos. Uma linha
# `IPS_DO_PAINEL=` lê-se, para quem abre o `.env`, como "sem restrição" — e é o
# contrário. E a recuperação de lockout (D4 do spec) reescreve esta linha com
# `sed`; **sem linha, o `sed` não casa nada e falha em silêncio**, deixando o
# operador convencido de que se liberou.
#
# `127.0.0.1/32` é sintaticamente válido e semanticamente inútil pela internet:
# ele não é alcançável nem a partir do próprio host, porque uma conexão do host
# para uma porta publicada chega ao container com o endereço do gateway da
# bridge, não com `127.0.0.1`. Quem tem shell na VPS já tem root — a allowlist
# nunca teve como defender contra ele.
acrescentar_linha() {
  if ! grep -q "^$1=" "$AMBIENTE"; then
    echo "==> acrescentando $1=$2 a $AMBIENTE"
    printf '%s=%s\n' "$1" "$2" >> "$AMBIENTE"
  fi
}
acrescentar_linha IPS_DO_PAINEL 127.0.0.1/32

set -a
# shellcheck disable=SC1090
. "./$AMBIENTE"
set +a

# ---------------------------------------------------------------------------
# 1c · a guarda da allowlist do painel
# ---------------------------------------------------------------------------
# **Falhar aqui é barato; falhar no Traefik é falhar aberto.**
#
# Um `sourceRange` vazio ou com CIDR malformado impede o Traefik de construir o
# middleware, e um roteador cuja cadeia de middlewares falhou **não entra na
# árvore de roteamento** — ele não passa a bloquear, deixa de existir. A
# negação na regra do roteador do produto (ver o compose) contém isso: o painel
# vira 404 em vez de ficar aberto. Esta guarda é a segunda camada, e é a que
# diz **por que** em vez de devolver um 404 que ninguém sabe ler.
#
# O formato aceito é uma lista de CIDRs separados por vírgula. Um IP nu —
# `203.0.113.7` sem `/32` — é o erro mais comum e é recusado aqui: o Traefik
# também o recusaria, e três linhas de shell no lugar certo poupam a viagem.
IPS_DO_PAINEL=${IPS_DO_PAINEL:-127.0.0.1/32}
if ! printf '%s' "$IPS_DO_PAINEL" \
   | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}(,[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2})*$'; then
  echo "ERRO: IPS_DO_PAINEL não é uma lista de CIDRs válida: '$IPS_DO_PAINEL'" >&2
  echo "      Formato: 203.0.113.7/32  ou  203.0.113.7/32,198.51.100.0/24" >&2
  echo "      Para fechar o painel para todos: 127.0.0.1/32" >&2
  exit 1
fi
# Faixa larga demais é o erro que **passa no aceite e não filtra nada** — e ele
# tem um caminho conhecido: o operador vê 403 onde esperava 200, conclui que "o
# IP não está chegando", e alarga a faixa até funcionar. `10.0.0.0/8` libera os
# vinte e quatro containers vizinhos; `0.0.0.0/0` libera a internet.
#
# Não recusamos: `0.0.0.0/0` é o desligamento deliberado do rollback R1, e um
# script que impede o rollback é pior que o risco. Avisamos alto.
for faixa in ${IPS_DO_PAINEL//,/ }; do
  prefixo=${faixa#*/}
  if [ "$prefixo" -lt 24 ] 2>/dev/null; then
    echo "  ATENÇÃO: $faixa é uma faixa larga (/$prefixo)." >&2
    echo "  Se você chegou a ela porque o teste dava 403, o problema não era a" >&2
    echo "  faixa: confira se o IP do cliente chega ao Traefik. Uma allowlist" >&2
    echo "  que passa no aceite e não filtra nada é pior do que nenhuma." >&2
  fi
done
echo "==> allowlist do painel: $IPS_DO_PAINEL"

# ---------------------------------------------------------------------------
# 1b · a configuração do Redis, renderizada do modelo
# ---------------------------------------------------------------------------
# O Redis **não** interpola variável de ambiente em arquivo de configuração:
# `${SENHA_REDIS}` chegaria literal ao servidor, e a senha viraria a string
# `${SENHA_REDIS}` — pior que senha nenhuma, porque pareceria ter uma.
#
# Daí o modelo e esta renderização. O resultado fica fora do repositório
# (`.gitignore`) e é montado no container em vez de a senha ir na linha de
# comando, onde `docker inspect` a mostraria.
echo "==> renderizando redis.conf"
# O hash de antes: o Redis lê a configuração **uma vez, ao iniciar**, e o
# `docker compose up -d` não recria um container cuja *definição* não mudou.
# Editar o modelo e reimplantar deixava o servidor rodando a ACL velha em
# silêncio — o arquivo novo montado, e nenhum efeito. Custou uma
# indisponibilidade para descobrir.
antes=$(md5sum redis.conf 2>/dev/null | cut -d' ' -f1 || echo vazio)
sed "s|\${SENHA_REDIS}|${SENHA_REDIS}|g" redis.conf.modelo > redis.conf

# `600` era o reflexo certo e o resultado errado: o `redis-server` roda como
# `redis` (uid 999) dentro do container, e um arquivo que só o root do host lê
# faz o container morrer em laço com `can't open config file: Permission
# denied` — verificado em produção, não deduzido.
#
# `400` com dono `999:1000` é mais restrito que os `644` que a correção óbvia
# usaria: nem o grupo, nem outros, nem o próprio processo do Redis conseguem
# **escrever** nele. Os números são os da imagem `redis:7-alpine` (`id redis`),
# e mudam se a imagem mudar — daí estarem aqui, e não num comentário distante.
chown 999:1000 redis.conf
chmod 400 redis.conf
depois=$(md5sum redis.conf | cut -d' ' -f1)

# ---------------------------------------------------------------------------
# 2 · dados
# ---------------------------------------------------------------------------
echo "==> subindo Postgres e Redis"
docker compose up -d postgres redis

# `restart` e não `up --force-recreate`: recriar perderia o container e, com
# ele, o tempo de `appendonly` recarregar. Reiniciar relê a configuração e
# mantém o volume — as sessões ativas e a fila do BullMQ atravessam.
if [ "$antes" != "$depois" ]; then
  echo "==> redis.conf mudou; reiniciando o Redis para relê-lo"
  docker compose restart redis
fi

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
# Pela **entrada padrão**, e não com `-c`: o `psql -c` não interpola variável, e
# `:'senha'` chegaria literal ao servidor. Custou uma execução do deploy
# descobrir, e a mensagem — `syntax error at or near ":"` — não menciona isso.
#
# A senha continua vindo por variável do psql, e não interpolada pelo shell:
# assim ela não aparece na lista de processos nem num `set -x`.
docker compose exec -T \
  -e PGPASSWORD="$SENHA_POSTGRES" \
  postgres psql -U mavia -d mavia -v ON_ERROR_STOP=1 \
    -v senha="$SENHA_APP" > /dev/null <<'SQL'
ALTER ROLE mavia_app LOGIN PASSWORD :'senha';
SQL

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

# A quarta asserção: a allowlist do painel (C-6a).
#
# Roda a partir do host da VPS, que **não** está na lista — uma conexão do host
# para uma porta publicada chega ao container com o endereço do gateway da
# bridge, não com `127.0.0.1`. Então o esperado aqui é recusa.
#
# Os três resultados possíveis significam coisas diferentes, e colapsá-los num
# "ok/erro" esconderia justamente a falha que importa:
codigo_painel=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${DOMINIO}" \
                --resolve "${DOMINIO}:443:127.0.0.1" "https://${DOMINIO}/admin" || echo 000)
case "$codigo_painel" in
  403)
    echo "  ok  o painel recusa origem fora da allowlist (403 do Traefik)"
    ;;
  404)
    echo "  ATENÇÃO: /admin devolveu 404." >&2
    echo "  O roteador do painel não está na árvore — provavelmente o middleware" >&2
    echo "  não pôde ser construído. Está **fechado**, que é o modo de falha certo," >&2
    echo "  mas o painel não sobe assim. Confira IPS_DO_PAINEL e os logs do Traefik." >&2
    ;;
  200)
    echo "  ERRO: /admin respondeu 200 de uma origem fora da allowlist." >&2
    echo "  O controle da C-6a NÃO está no ar. Não ligue o painel" >&2
    echo "  (provisionar-painel.sh) até isto responder 403." >&2
    exit 1
    ;;
  *)
    echo "  ATENÇÃO: /admin devolveu $codigo_painel; esperado 403." >&2
    ;;
esac

echo
echo "Mavia em https://${DOMINIO}"
echo "Segredos em $(pwd)/$AMBIENTE — modo 600, fora do repositório."
