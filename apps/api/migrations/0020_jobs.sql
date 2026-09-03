-- 0020 — A exceção declarada que o job agendado precisa.
--
-- Um job do sistema atravessa todos os espaços por definição: ele não é de um
-- usuário. Mas `mavia_app` opera sob RLS forçada, e uma consulta sem
-- `app.tenant_id` devolve zero linhas — corretamente.
--
-- **Uma exceção escrita é auditável; uma exceção implícita não é.** É o mesmo
-- padrão de `auth.*` e da exceção de `outbox_pendencias` em `sistema.md` §3.9:
-- em vez de dar `BYPASSRLS` ao papel da aplicação — o que destruiria a garantia
-- de todo o resto —, existe **uma** função `SECURITY DEFINER`, estreita,
-- nominal, e que devolve o mínimo possível.
--
-- O mínimo, aqui, é literalmente três colunas de identificação. A função
-- **não** devolve valor, descrição, categoria nem qualquer coisa que descreva
-- dinheiro: uma conexão comprometida que a chame descobre que existem regras de
-- recorrência e nada sobre o que elas cobram.

CREATE SCHEMA jobs;

-- O futuro dono da função precisa poder criá-la no esquema: `ALTER FUNCTION …
-- OWNER TO` exige que o novo dono tenha CREATE ali. Sem isto a migration falha
-- com "permission denied for schema jobs", e falha **bem** — é o tipo de erro
-- que se quer no deploy, não em produção.
GRANT USAGE, CREATE ON SCHEMA jobs TO mavia_auth;

CREATE FUNCTION jobs.recorrencias_a_materializar()
RETURNS TABLE (tenant_id UUID, recorrencia_id UUID, criado_por UUID)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT r.tenant_id, r.id, r.criado_por
    FROM recorrencias r
   WHERE r.deleted_at IS NULL
     AND r.pausada_em IS NULL
   ORDER BY r.tenant_id, r.id;
$$;

-- Dono `mavia_auth`, pelo mesmo motivo das funções de autenticação: a migration
-- roda como `mavia_migrate`, que **tem** `BYPASSRLS`, e uma função
-- `SECURITY DEFINER` criada por ele executaria com `BYPASSRLS` — a "função
-- estreita" teria acesso irrestrito à base. `mavia_auth` é NOLOGIN NOBYPASSRLS.
ALTER FUNCTION jobs.recorrencias_a_materializar() OWNER TO mavia_auth;
REVOKE ALL ON FUNCTION jobs.recorrencias_a_materializar() FROM PUBLIC;
GRANT USAGE ON SCHEMA jobs TO mavia_app;
GRANT EXECUTE ON FUNCTION jobs.recorrencias_a_materializar() TO mavia_app;

-- `mavia_auth` precisa enxergar a tabela para que a função possa lê-la. Sem
-- isto a função falharia com "permission denied", e a falha só apareceria na
-- primeira execução do job — de madrugada.
GRANT SELECT ON recorrencias TO mavia_auth;
