#!/bin/sh
# Provisionamento dos papéis, em produção — pendência 1D.
#
# É o equivalente de `infra/bootstrap-papeis.sql`, com uma diferença que decide
# tudo: **as senhas vêm do ambiente, não do arquivo.** O bootstrap local tem
# `mavia_local_dev` escrito nele porque aquele container escuta em 127.0.0.1 e o
# `mavia reset` apaga os dados; aqui as senhas são segredo, e segredo não entra
# em arquivo versionado.
#
# Roda **uma vez**, na criação do volume, pelo `docker-entrypoint-initdb.d` do
# Postgres. Se o volume já existir, este arquivo é ignorado — o que é o
# comportamento certo: reexecutar trocaria a senha de papéis em uso.
set -eu

: "${SENHA_MIGRATE:?SENHA_MIGRATE não definida}"
: "${SENHA_APP:?SENHA_APP não definida}"

# `--single-transaction`: ou os papéis todos existem, ou nenhum. Um
# provisionamento pela metade deixa o banco num estado que a primeira migration
# não sabe interpretar.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     --single-transaction --set ON_ERROR_STOP=1 \
     --set senha_migrate="$SENHA_MIGRATE" \
     --set senha_app="$SENHA_APP" <<'SQL'

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mavia_migrate') THEN
    -- BYPASSRLS: é o único papel que o tem, e só ele roda migration.
    -- CREATEROLE: a migration 0001 cria `mavia_app` e `mavia_jobs`, e a 0004
    -- cria `mavia_auth`. No PostgreSQL 16+ o CREATEROLE é restrito aos papéis
    -- que ele mesmo criou, o que mantém o privilégio estreito.
    CREATE ROLE mavia_migrate LOGIN BYPASSRLS CREATEROLE;
  END IF;
END
$$;

-- `:'var'` é a forma do psql para literal com aspas. A senha entra por variável
-- e não por interpolação de shell: assim ela não aparece na lista de processos
-- nem num `set -x`.
ALTER ROLE mavia_migrate PASSWORD :'senha_migrate';

-- `mavia_migrate` precisa ser DONO do esquema, e não apenas ter CREATE nele.
--
-- O motivo é um comportamento traiçoeiro do PostgreSQL: um `GRANT` executado
-- por quem não é dono nem tem grant option **não falha**. Devolve `GRANT` com um
-- `WARNING: no privileges were granted`, e a transação segue. A migration
-- reporta sucesso, o privilégio não existe, e a aplicação perde acesso a todas
-- as tabelas sem nenhum erro para investigar.
ALTER SCHEMA public OWNER TO mavia_migrate;

DO $$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO mavia_migrate', current_database());
END
$$;
SQL

# `mavia_app` é criado pela migration 0001, **NOLOGIN** — quem concede
# credencial é o provisionamento, não a migration. Como ele só passa a existir
# depois das migrations, e as migrations rodam de outro container, a senha dele
# é aplicada pelo `implantar.sh`, logo após elas. Não dá para fazer aqui: este
# gancho roda na criação do volume, antes de qualquer migration.
echo "papéis provisionados"
