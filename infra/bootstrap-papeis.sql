-- Provisionamento de papéis que NÃO nascem de migration.
--
-- A migration 0001 declara o motivo: `mavia_migrate` é quem *roda* as
-- migrations, e um papel não se concede privilégio a si mesmo. Em produção ele
-- é provisionado pelo `sre-devops-vps`, com o `pg_hba.conf` restringindo o
-- acesso ao host do runner de deploy (achado A-04).
--
-- Este arquivo é o equivalente local disso. Roda uma vez, antes da primeira
-- migration, e existe para que o ambiente de desenvolvimento tenha a mesma
-- topologia de papéis da produção — e não uma versão simplificada que esconde
-- justamente os erros de permissão que só aparecem lá.
--
-- A senha vale só para o container local, que escuta em 127.0.0.1 e cujos
-- dados o `mavia reset` apaga. Ver infra/README.md.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mavia_migrate') THEN
    -- BYPASSRLS: é o único papel que o tem, e só ele roda migration.
    -- CREATEROLE: a migration 0001 cria `mavia_app` e `mavia_jobs`, e a 0004
    -- cria `mavia_auth`. Sem este atributo a primeira migration falha com
    -- "permission denied to create role". Nenhum documento de arquitetura
    -- dizia isso — apareceu ao rodar as migrations como o papel real em vez
    -- de como superusuário.
    -- No PostgreSQL 16+ o CREATEROLE é restrito aos papéis que ele mesmo
    -- criou, o que mantém o privilégio estreito.
    CREATE ROLE mavia_migrate LOGIN BYPASSRLS CREATEROLE PASSWORD 'mavia_local_dev';
  END IF;
END
$$;

-- `mavia_migrate` precisa ser DONO do esquema que ele gerencia, não apenas ter
-- CREATE nele.
--
-- O motivo é um comportamento traiçoeiro do PostgreSQL: um `GRANT` executado
-- por quem não é dono nem tem grant option **não falha**. Ele devolve `GRANT`,
-- com um mero `WARNING: no privileges were granted`, e a transação segue. A
-- migration reporta sucesso, o privilégio não existe, e a aplicação perde
-- acesso a todas as tabelas sem nenhum erro para investigar.
--
-- Hoje isso fica mascarado porque o esquema `public` concede `USAGE` a PUBLIC
-- por padrão — então a aplicação funciona *apesar* de o GRANT da migration não
-- ter efeito. A máscara cai no dia em que alguém endurecer o esquema, que é
-- justamente uma boa prática de segurança.
ALTER SCHEMA public OWNER TO mavia_migrate;

-- E removemos a máscara agora, de propósito: sem `USAGE` para PUBLIC, todo
-- acesso passa a depender de concessão explícita. Se uma migration futura
-- esquecer de conceder, a falha aparece no teste em vez de aparecer no dia em
-- que alguém endurecer a produção.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- E criar esquema: a migration 0004 cria o esquema `auth`, onde vivem as
-- funções SECURITY DEFINER do cadastro. `CREATE SCHEMA` exige privilégio na
-- base, não no esquema — outro requisito que só aparece rodando como o papel
-- real, e que o `sre-devops-vps` precisa reproduzir no provisionamento da VPS.
-- `current_database()` e não o nome fixo: este mesmo arquivo roda no ambiente
-- local (base `mavia`) e no container efêmero dos testes, que nomeia a base de
-- outro jeito. Nome fixo aqui faria a suíte falhar por um motivo que não é o
-- que ela testa.
DO $$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO mavia_migrate', current_database());
END
$$;
