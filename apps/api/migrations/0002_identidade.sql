-- 0002 — Identidade: credenciais, identidades federadas e cadastro pendente.
--
-- Implementa docs/produto/spec-autenticacao.md §1, §2, §3 e §6.
-- A decisão que esta migration materializa: a chave de identidade federada é
-- (provedor, issuer, subject) — nunca o e-mail. O e-mail é atributo mutável e,
-- em domínio corporativo, reatribuível a outra pessoa.

-- ---------------------------------------------------------------------------
-- Colunas de credencial em `usuarios`
-- ---------------------------------------------------------------------------
-- `usuarios.email` continua TEXT com índice único sobre lower(email), como em
-- 0001. `sistema.md` §3.1 dizia CITEXT; migrar o tipo exigiria a extensão e não
-- compraria nada — o índice funcional já garante a unicidade insensível a
-- caixa. A divergência fica registrada aqui, não corrigida em silêncio.
ALTER TABLE usuarios
  ADD COLUMN senha_hash           TEXT,          -- string PHC do Argon2id; NULL = conta só federada
  ADD COLUMN senha_atualizada_em  TIMESTAMPTZ,
  ADD COLUMN email_verificado_em  TIMESTAMPTZ,   -- toda linha nasce com valor (ver §6.3, camada 1)
  ADD COLUMN mfa_segredo_cifrado  BYTEA,         -- envelope, proposito = usuario.mfa (ADR 0018)
  ADD COLUMN mfa_kek_versao       SMALLINT,
  ADD COLUMN mfa_ativado_em       TIMESTAMPTZ,
  ADD COLUMN mfa_ultimo_passo     BIGINT,        -- anti-replay dentro da janela de 30 s
  ADD COLUMN ultimo_acesso_em     TIMESTAMPTZ;

-- Se há segredo de MFA, há versão de KEK. Sem isso a rotação incremental de
-- KEK (A-37) não sabe o que reembrulhar.
ALTER TABLE usuarios
  ADD CONSTRAINT mfa_tem_versao_de_kek
  CHECK (num_nonnulls(mfa_segredo_cifrado, mfa_kek_versao) <> 1);

-- ---------------------------------------------------------------------------
-- Identidades federadas
-- ---------------------------------------------------------------------------
CREATE TYPE provedor_federado AS ENUM ('google');

CREATE TABLE identidades_federadas (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id                   UUID NOT NULL REFERENCES usuarios (id),
  provedor                     provedor_federado NOT NULL,
  -- `issuer` guardado hoje, com um provedor só, é o que permite acrescentar um
  -- segundo provedor sem migrar identidade nenhuma.
  issuer                       TEXT NOT NULL,
  subject                      TEXT NOT NULL,
  -- Dica de vinculação e de exibição. NUNCA entra em consulta que decide quem
  -- é o usuário — ver §1.3.
  email_no_provedor            TEXT,
  email_verificado_no_provedor BOOLEAN NOT NULL DEFAULT FALSE,
  vinculado_em                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_login_em              TIMESTAMPTZ
);

-- A identidade. Sem `WHERE deleted_at IS NULL`: `identidades_federadas` não
-- tem soft delete de propósito — desvincular é DELETE físico, porque uma linha
-- morta aqui reservaria um `subject` para sempre e deixaria a pessoa sem poder
-- vincular a própria conta Google de novo.
CREATE UNIQUE INDEX identidade_federada_unica
  ON identidades_federadas (provedor, issuer, subject);

CREATE INDEX identidades_por_usuario ON identidades_federadas (usuario_id);

-- Detecta o caso C5 (reatribuição de endereço, §1.6) em uma consulta:
-- "existe identidade deste provedor com este e-mail e outro subject?"
CREATE INDEX identidades_por_email_no_provedor
  ON identidades_federadas (provedor, lower(email_no_provedor));

-- ---------------------------------------------------------------------------
-- Cadastro pendente — a camada 1 do teto de taxa (§6.3)
-- ---------------------------------------------------------------------------
-- Nenhuma linha em `tenants` nasce de um e-mail não provado. Enquanto o clique
-- no link não acontece, o cadastro vive aqui e não existe usuário nem tenant.
CREATE TABLE cadastros_pendentes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL,
  nome          TEXT        NOT NULL,
  senha_hash    TEXT        NOT NULL,   -- Argon2id já aplicado; a senha em claro nunca chega aqui
  token_hash    BYTEA       NOT NULL,   -- SHA-256 de 256 bits de CSPRNG
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em     TIMESTAMPTZ NOT NULL,
  consumido_em  TIMESTAMPTZ
);
CREATE UNIQUE INDEX cadastro_pendente_por_token ON cadastros_pendentes (token_hash);
-- Um cadastro pendente vivo por endereço: sem isso, mil requisições geram mil
-- e-mails para a mesma vítima, e o produto vira ferramenta de assédio.
CREATE UNIQUE INDEX cadastro_pendente_por_email
  ON cadastros_pendentes (lower(email)) WHERE consumido_em IS NULL;

-- ---------------------------------------------------------------------------
-- Recuperação de senha
-- ---------------------------------------------------------------------------
CREATE TABLE recuperacoes_senha (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id    UUID        NOT NULL REFERENCES usuarios (id),
  token_hash    BYTEA       NOT NULL,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em     TIMESTAMPTZ NOT NULL,
  consumido_em  TIMESTAMPTZ,
  ip_hash       BYTEA                   -- pepper no guardião (A-39). Nunca sai em resposta
);
CREATE UNIQUE INDEX recuperacao_por_token ON recuperacoes_senha (token_hash);
CREATE INDEX recuperacao_por_usuario ON recuperacoes_senha (usuario_id)
  WHERE consumido_em IS NULL;

-- ---------------------------------------------------------------------------
-- Códigos de recuperação de MFA
-- ---------------------------------------------------------------------------
-- SHA-256 e não Argon2id: são 128 bits de CSPRNG. Argon2 protege segredo de
-- baixa entropia; aqui só encareceria a verificação.
CREATE TABLE mfa_codigos_recuperacao (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id    UUID        NOT NULL REFERENCES usuarios (id),
  codigo_hash   BYTEA       NOT NULL,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumido_em  TIMESTAMPTZ
);
CREATE UNIQUE INDEX mfa_codigo_unico ON mfa_codigos_recuperacao (codigo_hash);
CREATE INDEX mfa_codigos_por_usuario ON mfa_codigos_recuperacao (usuario_id)
  WHERE consumido_em IS NULL;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Estas quatro tabelas são globais como `usuarios` e `sessoes`: a policy é por
-- app.usuario_id, nunca por app.tenant_id. Ver matriz-de-acesso.md §3.1.
ALTER TABLE identidades_federadas   ENABLE ROW LEVEL SECURITY;
ALTER TABLE identidades_federadas   FORCE  ROW LEVEL SECURITY;
CREATE POLICY identidade_do_usuario ON identidades_federadas
  USING      (usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid)
  WITH CHECK (usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid);

ALTER TABLE mfa_codigos_recuperacao ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_codigos_recuperacao FORCE  ROW LEVEL SECURITY;
CREATE POLICY mfa_codigo_do_usuario ON mfa_codigos_recuperacao
  USING      (usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid)
  WITH CHECK (usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid);

-- `cadastros_pendentes` e `recuperacoes_senha` são pré-autenticação: não existe
-- app.usuario_id no momento em que são lidas. RLS ligada e NENHUMA policy:
-- com RLS ligada e sem policy, todo papel lê zero linhas. O acesso passa a ser
-- exclusivamente pelas funções de 0004, que trazem a única policy que existirá
-- sobre estas duas tabelas, nomeada e restrita a `mavia_auth`. Assim, um GRANT
-- indevido no futuro continua não lendo nada.
ALTER TABLE cadastros_pendentes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cadastros_pendentes FORCE  ROW LEVEL SECURITY;
ALTER TABLE recuperacoes_senha  ENABLE ROW LEVEL SECURITY;
ALTER TABLE recuperacoes_senha  FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------------
-- mavia_app enxerga a própria identidade federada (tela Config › Segurança) e
-- desvincula. Não recebe nada em cadastros_pendentes nem recuperacoes_senha.
GRANT SELECT, INSERT, DELETE ON identidades_federadas   TO mavia_app;
GRANT SELECT, INSERT, UPDATE ON mfa_codigos_recuperacao TO mavia_app;

-- GRANT por COLUNA, e não na tabela: os fluxos pós-autenticação (definir senha,
-- inscrever MFA, carimbar último acesso) precisam escrever em `usuarios`, mas
-- `email` NÃO está na lista. Trocar o endereço de recuperação é um fluxo
-- próprio, autenticado e com step-up (§1.5) — e enquanto ele não existir,
-- nenhum caminho da API consegue alterar `usuarios.email`. A policy
-- `usuario_proprio` de 0001 limita a linha; o GRANT por coluna limita o campo.
GRANT UPDATE (nome, senha_hash, senha_atualizada_em, mfa_segredo_cifrado,
              mfa_kek_versao, mfa_ativado_em, mfa_ultimo_passo, ultimo_acesso_em)
  ON usuarios TO mavia_app;

-- ATENÇÃO — sem esta policy, o GRANT acima é uma escalada de privilégio.
-- A policy `usuario_proprio` de 0001 é:
--     id = app.usuario_id OR EXISTS (vínculo no mesmo tenant)
-- Ela foi escrita para LEITURA (mostrar o nome dos membros do espaço). Como ela
-- não tem WITH CHECK, o Postgres reusa o USING como check no UPDATE — e o ramo
-- do EXISTS passaria a autorizar um `membro` a escrever `senha_hash` de OUTRO
-- membro do mesmo tenant. RESTRICTIVE porque policies restritivas são
-- combinadas por AND: esta corta o ramo do EXISTS sem alterar a leitura.
CREATE POLICY usuario_escreve_so_a_propria_linha ON usuarios
  AS RESTRICTIVE FOR UPDATE TO mavia_app
  USING      (id = nullif(current_setting('app.usuario_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.usuario_id', true), '')::uuid);
