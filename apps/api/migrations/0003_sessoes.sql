-- 0003 — Sessões, famílias de refresh e detecção de reuso.
--
-- Implementa docs/produto/spec-autenticacao.md §4 e sistema.md §3.1/§3.9.

CREATE TYPE plataforma_de_sessao AS ENUM ('web', 'mobile');

CREATE TABLE sessoes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id          UUID NOT NULL REFERENCES usuarios (id),
  -- A família é o login. Rotacionar o refresh cria linha nova na MESMA família;
  -- detectar reuso revoga a família inteira, não só a linha (sistema.md §3.1).
  familia_id          UUID NOT NULL,
  refresh_hash        BYTEA NOT NULL,          -- SHA-256 de 256 bits de CSPRNG
  geracao             INTEGER NOT NULL DEFAULT 1,
  substituida_por     UUID REFERENCES sessoes (id),
  plataforma          plataforma_de_sessao NOT NULL,
  dispositivo         TEXT,                    -- rótulo legível, nunca o user agent cru
  ip_hash             BYTEA,                   -- pepper no guardião (A-39)
  user_agent_hash     BYTEA,
  -- Marca o instante em que o segundo fator foi apresentado NESTE login. É o
  -- que permite a M-2 sem consultar o Redis.
  mfa_verificada_em   TIMESTAMPTZ,
  criada_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_uso_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em           TIMESTAMPTZ NOT NULL,    -- deslizante
  expira_absoluto_em  TIMESTAMPTZ NOT NULL,    -- teto; nunca estendido
  revogada_em         TIMESTAMPTZ,
  motivo_revogacao    TEXT,

  CONSTRAINT deslizante_nao_passa_do_absoluto CHECK (expira_em <= expira_absoluto_em)
);

CREATE UNIQUE INDEX sessao_por_refresh ON sessoes (refresh_hash);
CREATE INDEX sessoes_vivas_por_usuario ON sessoes (usuario_id, expira_em)
  WHERE revogada_em IS NULL;
CREATE INDEX sessoes_por_familia ON sessoes (familia_id);
-- Purga da retenção: sessoes.* vive 90 dias após expirar ou ser revogada
-- (retencao-e-eliminacao.md §3.1). A janela existe para investigar reuso.
CREATE INDEX sessoes_para_purga ON sessoes (expira_absoluto_em);

ALTER TABLE sessoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessoes FORCE  ROW LEVEL SECURITY;
CREATE POLICY sessao_do_usuario ON sessoes
  USING      (usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid)
  WITH CHECK (usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid);

-- Pós-autenticação, mavia_app opera as próprias sessões sob a policy acima:
-- GET /auth/sessoes, DELETE /auth/sessoes/:id, revogar-todas, rotação.
-- A LEITURA pré-autenticação (resolver o refresh apresentado) NÃO passa por
-- aqui — passa por auth.resolver_sessao, em 0004. Ver §4.2.
GRANT SELECT, INSERT, UPDATE ON sessoes TO mavia_app;
