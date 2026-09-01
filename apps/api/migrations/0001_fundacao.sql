-- 0001 — Fundação: papéis, tenancy e Row-Level Security.
--
-- Implementa o ADR 0004 e a seção 3.9 de docs/arquitetura/sistema.md.
-- A decisão que esta migration materializa: o banco recusa a consulta que
-- esqueceu de filtrar por cliente. O filtro na aplicação é a segunda camada,
-- nunca a única.

-- ---------------------------------------------------------------------------
-- Papéis
-- ---------------------------------------------------------------------------
-- Criados sem senha: quem define credencial é o provisionamento do ambiente,
-- não a migration, para que nenhuma senha exista no repositório (regra 19).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mavia_app') THEN
    CREATE ROLE mavia_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mavia_jobs') THEN
    CREATE ROLE mavia_jobs NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- mavia_migrate não é criado aqui: ele é quem roda esta migration, e um papel
-- não se concede privilégio a si mesmo. É provisionado fora, e o pg_hba.conf
-- restringe o acesso dele ao host do runner de deploy (achado A-04).

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
CREATE TYPE papel_no_tenant AS ENUM ('proprietario', 'membro', 'visualizador');
CREATE TYPE tipo_de_conta   AS ENUM ('corrente', 'poupanca', 'dinheiro',
                                     'investimento', 'digital', 'outra');
CREATE TYPE origem_do_dado  AS ENUM ('manual', 'conectado');

-- ---------------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------------

-- UUID v4 e não v7: o ADR 0004 exige identificador não sequencial, e o v7 é
-- ordenado por tempo, o que vaza ordem de criação.
CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome        TEXT        NOT NULL,
  -- CHECK e não texto livre: nenhum código escreve a zona literal, e hoje
  -- toda Data civil do sistema é interpretada em São Paulo.
  timezone    TEXT        NOT NULL DEFAULT 'America/Sao_Paulo'
                          CHECK (timezone = 'America/Sao_Paulo'),
  moeda_base  CHAR(3)     NOT NULL DEFAULT 'BRL',
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE usuarios (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT        NOT NULL,
  nome        TEXT        NOT NULL,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX usuarios_email_unico ON usuarios (lower(email))
  WHERE deleted_at IS NULL;

CREATE TABLE tenant_usuarios (
  tenant_id   UUID NOT NULL REFERENCES tenants (id),
  usuario_id  UUID NOT NULL REFERENCES usuarios (id),
  papel       papel_no_tenant NOT NULL,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, usuario_id)
);
CREATE INDEX tenant_usuarios_por_usuario ON tenant_usuarios (usuario_id);

-- Primeira tabela de negócio. Serve de prova viva do padrão: toda tabela de
-- negócio nasce com tenant_id NOT NULL, RLS e índice liderado por tenant_id.
CREATE TABLE contas (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID    NOT NULL REFERENCES tenants (id),
  nome                   TEXT    NOT NULL,
  tipo                   tipo_de_conta   NOT NULL DEFAULT 'corrente',
  origem                 origem_do_dado  NOT NULL DEFAULT 'manual',
  -- Dinheiro é BIGINT de centavos. Nunca NUMERIC, nunca float (regra 1).
  saldo_inicial_centavos BIGINT  NOT NULL DEFAULT 0,
  moeda                  CHAR(3) NOT NULL DEFAULT 'BRL',
  -- O tipo define apenas o valor inicial deste campo; quem decide é o usuário.
  incluir_no_saldo_geral BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em              TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em          TIMESTAMPTZ,
  deleted_at             TIMESTAMPTZ
);

-- Todo índice de tabela de negócio começa por tenant_id: a RLS injeta
-- tenant_id = ... em toda consulta, e índice que não lidere por ele não é usado.
CREATE INDEX contas_por_tenant ON contas (tenant_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
-- FORCE também: sem ele, o dono da tabela ignora as policies, e o dono é
-- justamente quem roda as migrations.

ALTER TABLE contas ENABLE ROW LEVEL SECURITY;
ALTER TABLE contas FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contas
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- O `nullif(..., '')` não é enfeite. Numa conexão de pool onde `app.tenant_id`
-- já foi definido por uma requisição anterior, `current_setting(..., true)`
-- devolve string vazia em vez de NULL, e `''::uuid` **lança erro** em vez de
-- esconder linha. O comportamento passaria a depender de a conexão ser nova ou
-- reaproveitada — não determinístico, e descoberto só sob carga.
-- Com o nullif, os dois casos convergem: comparação com NULL, zero linhas.
-- Encontrado testando a migration contra Postgres real antes de escrever a
-- aplicação.

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_proprio ON tenants
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios FORCE  ROW LEVEL SECURITY;
CREATE POLICY usuario_proprio ON usuarios
  USING (id = nullif(current_setting('app.usuario_id', true), '')::uuid
         OR EXISTS (SELECT 1 FROM tenant_usuarios tu
                    WHERE tu.usuario_id = usuarios.id
                      AND tu.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid));

-- Precisa ser legível por app.usuario_id sozinho: é esta consulta que a etapa
-- 3 da resolução de tenant faz, antes de app.tenant_id existir.
ALTER TABLE tenant_usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_usuarios FORCE  ROW LEVEL SECURITY;
CREATE POLICY pertencimento ON tenant_usuarios
  USING (usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid
         OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO mavia_app, mavia_jobs;

GRANT SELECT, INSERT, UPDATE, DELETE ON contas TO mavia_app;
GRANT SELECT ON tenants, usuarios, tenant_usuarios TO mavia_app;

GRANT SELECT ON contas TO mavia_jobs;

-- Uma consulta que varre a tabela inteira é sinal de RLS mal configurada ou de
-- consulta sem índice. Cinco segundos é o suficiente para o caminho legítimo.
ALTER ROLE mavia_app  SET statement_timeout = '5s';
ALTER ROLE mavia_jobs SET statement_timeout = '60s';
