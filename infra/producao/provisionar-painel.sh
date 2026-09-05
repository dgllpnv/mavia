#!/bin/sh
# Provisionamento do painel de administração — condição **C-9**.
#
# ## Por que isto não é uma migration
#
# `0029` cria os quatro papéis **`NOLOGIN`**, e isso é a condição C-9 inteira:
# uma migration que criasse papel com senha teria a senha dentro dela, no
# repositório, para sempre. Quem dá credencial é o provisionamento do ambiente —
# este arquivo — e ele lê a senha do `.env`, que não é versionado.
#
# É o mesmo desenho do `10-papeis.sh`, com uma diferença: aquele roda uma vez,
# na criação do volume, pelo `docker-entrypoint-initdb.d`. Este roda contra um
# banco **que já existe**, porque o painel foi construído depois.
#
# ## Dois papéis ganham login, e dois não — de propósito
#
#   mavia_admin           LOGIN   pool de leitura do painel
#   mavia_admin_escrita   LOGIN   pool de escrita do painel
#   mavia_admin_contrato  NOLOGIN dono das funções de escrita
#   mavia_admin_definer   NOLOGIN dono das funções de leitura
#
# Os dois donos **não podem** ter login, e a razão é o ponto do épico: eles são
# os papéis em nome de quem as funções `SECURITY DEFINER` rodam. Uma sessão
# aberta como `mavia_admin_contrato` escreveria direto nas tabelas, sem passar
# pelas funções — logo sem conferir concessão, sem hipótese declarada e sem
# auditoria. Toda a cadeia de controle do painel existe *dentro* daquelas
# funções, e um login para o dono delas é o caminho que contorna a cadeia
# inteira.
#
# **Idempotente.** Rodar de novo não troca senha de papel em uso: cada chave é
# acrescentada ao `.env` uma única vez, e o `ALTER ROLE` usa o valor que já está
# lá.
set -eu

cd "$(dirname "$0")"
AMBIENTE=.env

[ -f "$AMBIENTE" ] || { echo "ERRO: $AMBIENTE não existe. Rode ./implantar.sh antes." >&2; exit 1; }

acrescentar_segredo() {
  if ! grep -q "^$1=" "$AMBIENTE"; then
    echo "==> acrescentando $1 a $AMBIENTE"
    printf '%s=%s\n' "$1" "$(head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-40)" >> "$AMBIENTE"
  fi
}

acrescentar_linha() {
  if ! grep -q "^$1=" "$AMBIENTE"; then
    echo "==> acrescentando $1 a $AMBIENTE"
    printf '%s=%s\n' "$1" "$2" >> "$AMBIENTE"
  fi
}

acrescentar_segredo SENHA_PAINEL
acrescentar_segredo SENHA_PAINEL_ESCRITA

set -a
# shellcheck disable=SC1090
. "./$AMBIENTE"
set +a

# As duas URLs que a API procura. Sem elas, `main.ts` sobe dizendo "painel de
# administração desligado" — e é a resposta certa para uma instalação que não
# quer o painel. Estas linhas são o que o liga.
acrescentar_linha DATABASE_URL_PAINEL \
  "postgresql://mavia_admin:${SENHA_PAINEL}@postgres:5432/mavia"
acrescentar_linha DATABASE_URL_PAINEL_ESCRITA \
  "postgresql://mavia_admin_escrita:${SENHA_PAINEL_ESCRITA}@postgres:5432/mavia"

# Relê: as duas linhas acima podem ter acabado de nascer.
set -a
# shellcheck disable=SC1090
. "./$AMBIENTE"
set +a

echo "==> concedendo credencial aos dois papéis de sessão"
docker compose exec -T -e PGPASSWORD="$SENHA_POSTGRES" postgres \
  psql --username mavia --dbname mavia --single-transaction --set ON_ERROR_STOP=1 \
       --set senha_painel="$SENHA_PAINEL" \
       --set senha_escrita="$SENHA_PAINEL_ESCRITA" <<'SQL'

ALTER ROLE mavia_admin         LOGIN PASSWORD :'senha_painel';
ALTER ROLE mavia_admin_escrita LOGIN PASSWORD :'senha_escrita';

-- A asserção que vale mais que os dois comandos acima.
--
-- Se um dia alguém acrescentar `LOGIN` a um dos donos — por engano, ou para
-- "depurar mais rápido" —, este bloco derruba o provisionamento em vez de
-- deixar passar. Um dono de função `SECURITY DEFINER` com login é uma sessão
-- que escreve nas tabelas do painel sem passar por função nenhuma: sem
-- concessão conferida, sem hipótese declarada, sem auditoria.
DO $$
DECLARE
  v_com_login TEXT;
BEGIN
  SELECT string_agg(rolname, ', ') INTO v_com_login
    FROM pg_roles
   WHERE rolname IN ('mavia_admin_contrato', 'mavia_admin_definer')
     AND rolcanlogin;

  IF v_com_login IS NOT NULL THEN
    RAISE EXCEPTION 'DONO DE FUNCAO COM LOGIN: %. Isto contorna toda a cadeia de controle do painel.', v_com_login;
  END IF;
END
$$;

SQL

echo
echo "Painel provisionado. Falta **uma concessão** para alguém poder usá-lo:"
echo
echo "  ./conceder-operador.sh <email>"
echo
echo "Ser operador é uma concessão a um usuário que já existe — não há conta"
echo "separada, e não há senha de admin. Ver ADR 0024."
