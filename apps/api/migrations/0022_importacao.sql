-- 0022 — Importação: `LancamentoBruto`, deduplicação, conciliação e desfazer.
--
-- Implementa o épico 6 e a regra 13 do `CLAUDE.md`: **toda ingestão externa é
-- idempotente**, com chave `(tenant_id, provider, external_id)` mais hash de
-- conteúdo. Reimportar o mesmo OFX duas vezes não pode duplicar nada.

-- ---------------------------------------------------------------------------
-- A importação
-- ---------------------------------------------------------------------------
-- Existe como entidade própria — e não só como uma coluna nos lançamentos —
-- por causa do **desfazer**. Sem ela, "desfazer a importação de ontem" viraria
-- "apagar os lançamentos que parecem ter vindo de ontem", que é um critério que
-- erra no dia em que a pessoa lançou algo parecido à mão.
CREATE TABLE importacoes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants (id),
  conta_id       UUID NOT NULL REFERENCES contas (id),

  -- Nunca `'ofx'` no código de aplicação: quem sabe o nome do adapter é a borda
  -- (ADR 0003). Aqui é só um rótulo para a tela e a auditoria.
  provider       TEXT NOT NULL,
  nome_do_arquivo TEXT,

  -- Hash do arquivo inteiro. Reenviar **o mesmo arquivo** não é erro — pode ser
  -- retentativa —, mas a tela avisa, e o registro permite auditar.
  arquivo_hash   BYTEA NOT NULL,

  registros      INTEGER NOT NULL DEFAULT 0,
  criados        INTEGER NOT NULL DEFAULT 0,
  repetidos      INTEGER NOT NULL DEFAULT 0,
  problemas      JSONB   NOT NULL DEFAULT '[]'::jsonb,

  criado_por     UUID NOT NULL REFERENCES usuarios (id),
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  desfeita_em    TIMESTAMPTZ
);

CREATE INDEX importacoes_por_tenant ON importacoes (tenant_id, criado_em DESC);

-- ---------------------------------------------------------------------------
-- O registro cru
-- ---------------------------------------------------------------------------
-- Preservado para auditoria e reprocessamento (`CONTEXT.md`). O `bruto` é o
-- trecho original do arquivo: se um dia a interpretação mudar — um banco que
-- passa a mandar o tipo noutro campo —, dá para reinterpretar sem pedir o
-- arquivo de volta ao cliente.
CREATE TABLE lancamentos_brutos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants (id),
  importacao_id  UUID NOT NULL REFERENCES importacoes (id),
  conta_id       UUID NOT NULL REFERENCES contas (id),

  provider       TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  -- Hash do conteúdo normalizado. A segunda metade da chave da regra 13: se o
  -- banco reusar um `FITID` com conteúdo diferente — acontece —, é registro
  -- novo, e não o mesmo.
  conteudo_hash  BYTEA NOT NULL,

  data           DATE   NOT NULL,
  valor_centavos BIGINT NOT NULL,
  moeda          CHAR(3) NOT NULL,
  descricao      TEXT   NOT NULL,
  tipo           TEXT,
  bruto          TEXT   NOT NULL,

  -- O lançamento que este registro virou. Nulo enquanto não virou nenhum —
  -- estado real quando a conciliação sugere casá-lo com um lançamento que já
  -- existe.
  lancamento_id  UUID REFERENCES lancamentos (id),

  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);

-- **A chave da regra 13.** É ela que faz reimportar o mesmo arquivo não
-- duplicar nada — e é parcial em `deleted_at` para que desfazer uma importação
-- libere a chave e permita importar de novo.
CREATE UNIQUE INDEX bruto_por_origem
  ON lancamentos_brutos (tenant_id, provider, external_id)
  WHERE deleted_at IS NULL;

CREATE INDEX brutos_por_importacao ON lancamentos_brutos (tenant_id, importacao_id)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- A conciliação
-- ---------------------------------------------------------------------------
-- **Sugestão, nunca sobrescrita.** O sistema jamais apaga o registro do usuário
-- sozinho (`CONTEXT.md`). A linha aqui é a proposta; `confirmada_em` é o
-- momento em que um humano concordou.
CREATE TYPE estado_da_conciliacao AS ENUM ('sugerida', 'confirmada', 'descartada');

CREATE TABLE conciliacoes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants (id),
  bruto_id       UUID NOT NULL REFERENCES lancamentos_brutos (id),
  -- O lançamento **manual** que a sugestão propõe casar.
  lancamento_id  UUID NOT NULL REFERENCES lancamentos (id),

  confianca      SMALLINT NOT NULL CHECK (confianca BETWEEN 0 AND 100),
  motivo         TEXT NOT NULL,
  estado         estado_da_conciliacao NOT NULL DEFAULT 'sugerida',

  decidido_por   UUID REFERENCES usuarios (id),
  decidido_em    TIMESTAMPTZ,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Um bruto tem no máximo uma sugestão viva, e um lançamento manual só pode ser
-- casado uma vez: sem isto, dois registros do extrato reivindicariam o mesmo
-- lançamento e um deles ficaria órfão sem que ninguém notasse.
CREATE UNIQUE INDEX conciliacao_por_bruto
  ON conciliacoes (tenant_id, bruto_id) WHERE estado <> 'descartada';
CREATE UNIQUE INDEX conciliacao_por_lancamento
  ON conciliacoes (tenant_id, lancamento_id) WHERE estado = 'confirmada';

-- ---------------------------------------------------------------------------
-- A marca no lançamento
-- ---------------------------------------------------------------------------
-- Quem veio da importação carrega de qual. É o que o desfazer usa, e o que
-- permite ao extrato dizer "isto veio do banco" sem consultar outra tabela.
ALTER TABLE lancamentos
  ADD COLUMN importacao_id UUID REFERENCES importacoes (id);

CREATE INDEX lancamentos_por_importacao
  ON lancamentos (tenant_id, importacao_id) WHERE importacao_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Isolamento
-- ---------------------------------------------------------------------------
ALTER TABLE importacoes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE importacoes        FORCE  ROW LEVEL SECURITY;
ALTER TABLE lancamentos_brutos ENABLE ROW LEVEL SECURITY;
ALTER TABLE lancamentos_brutos FORCE  ROW LEVEL SECURITY;
ALTER TABLE conciliacoes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE conciliacoes       FORCE  ROW LEVEL SECURITY;

CREATE POLICY importacao_do_tenant ON importacoes
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY bruto_do_tenant ON lancamentos_brutos
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY conciliacao_do_tenant ON conciliacoes
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON importacoes        TO mavia_app;
GRANT SELECT, INSERT, UPDATE ON lancamentos_brutos TO mavia_app;
GRANT SELECT, INSERT, UPDATE ON conciliacoes       TO mavia_app;
