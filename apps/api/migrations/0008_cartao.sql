-- 0008 — Cartão de crédito: ciclo, fatura e parcelamento.
--
-- Implementa docs/adr/0007-bases-temporais-do-cartao.md.
--
-- A decisão que esta migration materializa: uma compra de cartão não sai do
-- bolso — quem sai é a fatura. `settled_at` de lançamento de cartão só é
-- escrito quando a fatura é paga, e o eixo caixa agrega `faturas`, nunca
-- lançamentos de cartão.

-- `EXCLUDE` mistura igualdade (UUID) com sobreposição de intervalo, e o GiST
-- não sabe comparar UUID por igualdade sem esta extensão. Ela vem no
-- `postgresql-contrib`, que a imagem oficial já traz.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE estado_de_fatura AS ENUM
  ('aberta', 'fechada', 'parcialmente_paga', 'paga', 'vencida');

-- ---------------------------------------------------------------------------
-- Cartões
-- ---------------------------------------------------------------------------
CREATE TABLE cartoes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants (id),
  nome               TEXT NOT NULL,
  limite_centavos    BIGINT NOT NULL DEFAULT 0,
  closing_day        SMALLINT NOT NULL CHECK (closing_day BETWEEN 1 AND 31),
  due_day            SMALLINT NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  -- A conta que paga por padrão. Pode ser trocada, e trocar não reescreve
  -- fatura já emitida — ver `faturas.conta_pagamento_id`.
  conta_pagamento_id UUID REFERENCES contas (id),
  moeda              CHAR(3) NOT NULL DEFAULT 'BRL',
  origem             origem_do_dado NOT NULL DEFAULT 'manual',
  arquivado_em       TIMESTAMPTZ,
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em      TIMESTAMPTZ,
  deleted_at         TIMESTAMPTZ,

  -- Cartão não guarda dinheiro; acumula dívida. Não tem saldo inicial e não
  -- tem `incluir_no_saldo_geral` — não há saldo para incluir.
  CONSTRAINT limite_nao_negativo CHECK (limite_centavos >= 0)
);

CREATE INDEX cartoes_por_tenant ON cartoes (tenant_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Faturas
-- ---------------------------------------------------------------------------
CREATE TABLE faturas (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants (id),
  cartao_id          UUID NOT NULL REFERENCES cartoes (id),

  -- A janela, em instantes. `DATE` não representa instante, e a coerção
  -- depende do fuso da sessão que escreve.
  periodo_inicio     TIMESTAMPTZ NOT NULL,
  periodo_fim        TIMESTAMPTZ NOT NULL,

  -- Datas civis: nomeiam um dia, não um instante.
  data_fechamento    DATE NOT NULL,
  data_vencimento    DATE NOT NULL,
  -- Mês do vencimento — o mês em que o usuário paga.
  competencia        DATE NOT NULL,

  estado             estado_de_fatura NOT NULL DEFAULT 'aberta',
  total_centavos     BIGINT NOT NULL DEFAULT 0,
  pago_centavos      BIGINT NOT NULL DEFAULT 0,

  -- Congelada na criação, copiada do cartão. Sem isso, trocar a conta de
  -- pagamento padrão reescreveria a projeção de ciclos já abertos.
  conta_pagamento_id UUID REFERENCES contas (id),

  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em      TIMESTAMPTZ,
  deleted_at         TIMESTAMPTZ,

  CONSTRAINT janela_ordenada CHECK (periodo_inicio < periodo_fim),
  CONSTRAINT competencia_no_dia_um CHECK (extract(day FROM competencia) = 1),
  CONSTRAINT pago_nao_excede_total
    CHECK (abs(pago_centavos) <= abs(total_centavos) OR total_centavos = 0)
);

-- Uma janela por cartão. É o que impede duas faturas cobrindo o mesmo ciclo —
-- e, com elas, a mesma compra cobrada duas vezes.
CREATE UNIQUE INDEX faturas_ciclo_unico
  ON faturas (tenant_id, cartao_id, periodo_inicio) WHERE deleted_at IS NULL;

CREATE INDEX faturas_por_cartao
  ON faturas (tenant_id, cartao_id, competencia) WHERE deleted_at IS NULL;

-- O eixo caixa: faturas em aberto, pela conta que as paga, na data de
-- vencimento. Uma linha por ciclo em vez de N por compra.
CREATE INDEX faturas_eixo_caixa
  ON faturas (tenant_id, conta_pagamento_id, data_vencimento)
  WHERE estado <> 'paga' AND deleted_at IS NULL;

-- Nenhum instante pode cair em duas faturas do mesmo cartão. `EXCLUDE` com
-- intervalo semiaberto expressa exatamente a invariante que o ADR 0007 exige,
-- e o banco a verifica — em vez de a aplicação lembrar.
ALTER TABLE faturas ADD CONSTRAINT faturas_nao_se_sobrepoem
  EXCLUDE USING gist (
    cartao_id WITH =,
    tstzrange(periodo_inicio, periodo_fim, '[)') WITH &&
  ) WHERE (deleted_at IS NULL);

-- ---------------------------------------------------------------------------
-- Parcelamentos
-- ---------------------------------------------------------------------------
CREATE TABLE parcelamentos (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants (id),
  cartao_id            UUID REFERENCES cartoes (id),
  conta_id             UUID REFERENCES contas (id),

  -- O fato da compra, persistido UMA VEZ, no grupo. Nunca nos filhos: um fato
  -- pertence à compra, não a cada parcela, e replicá-lo permitiria N cópias
  -- divergentes de uma data só.
  data_compra          TIMESTAMPTZ NOT NULL,

  -- Com sinal. Guardar como magnitude positiva faria a invariante
  -- `Σ filhos = valor_total` falhar invertida — num teste que ninguém
  -- suspeitaria de estar errado.
  valor_total_centavos BIGINT NOT NULL,
  moeda                CHAR(3) NOT NULL,
  parcelas             SMALLINT NOT NULL CHECK (parcelas >= 1),
  descricao            TEXT NOT NULL,
  criado_por           UUID NOT NULL REFERENCES usuarios (id),
  criado_em            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ,

  CONSTRAINT parcelamento_tem_uma_origem CHECK (num_nonnulls(cartao_id, conta_id) = 1),
  CONSTRAINT valor_total_nao_zero CHECK (valor_total_centavos <> 0),
  -- `|total| >= N`: abaixo disso alguma parcela sairia zero, que `Lancamento`
  -- proíbe. Recusar é a única saída que não mente sobre o parcelamento.
  CONSTRAINT parcelamento_divisivel CHECK (abs(valor_total_centavos) >= parcelas)
);

CREATE INDEX parcelamentos_por_tenant ON parcelamentos (tenant_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Ligações que faltavam em `lancamentos`
-- ---------------------------------------------------------------------------
-- As colunas já nasceram na 0006 com as restrições certas; agora ganham a
-- integridade referencial, que só era possível com as tabelas existindo.
ALTER TABLE lancamentos
  ADD CONSTRAINT lancamentos_cartao_fk
    FOREIGN KEY (cartao_id) REFERENCES cartoes (id),
  ADD CONSTRAINT lancamentos_fatura_fk
    FOREIGN KEY (fatura_id) REFERENCES faturas (id),
  ADD CONSTRAINT lancamentos_parcelamento_fk
    FOREIGN KEY (installment_group_id) REFERENCES parcelamentos (id);

ALTER TABLE transferencias
  ADD CONSTRAINT transferencias_fatura_fk
    FOREIGN KEY (fatura_id) REFERENCES faturas (id);

-- Lançamento de cartão pertence a uma fatura se e somente se não for perna de
-- transferência. A perna de crédito de um pagamento de fatura NÃO entra na
-- fatura — se entrasse, zeraria o total dela.
ALTER TABLE lancamentos ADD CONSTRAINT cartao_tem_fatura
  CHECK (cartao_id IS NULL OR ((transfer_group_id IS NULL) = (fatura_id IS NOT NULL)));

CREATE INDEX lancamentos_por_fatura
  ON lancamentos (tenant_id, fatura_id) WHERE fatura_id IS NOT NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Fatura fechada é imutável
-- ---------------------------------------------------------------------------
-- Aceitar lançamento numa fatura já fechada muda um total que o usuário já viu
-- — e possivelmente já pagou. Retroativo entra na fatura aberta mais antiga,
-- com `posted_at` preservado.
CREATE FUNCTION fatura_fechada_nao_recebe() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_estado estado_de_fatura;
BEGIN
  IF NEW.fatura_id IS NULL THEN RETURN NEW; END IF;

  SELECT estado INTO v_estado FROM faturas
   WHERE id = NEW.fatura_id AND tenant_id = NEW.tenant_id;

  IF v_estado IS NULL THEN
    RAISE EXCEPTION 'FATURA_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;
  IF v_estado <> 'aberta' THEN
    RAISE EXCEPTION 'FATURA_FECHADA_NAO_RECEBE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fatura_fechada_nao_recebe_trg
  BEFORE INSERT ON lancamentos
  FOR EACH ROW EXECUTE FUNCTION fatura_fechada_nao_recebe();

-- ---------------------------------------------------------------------------
-- RLS e privilégios
-- ---------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['cartoes', 'faturas', 'parcelamentos']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    $f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO mavia_app', t);
    EXECUTE format('GRANT SELECT ON %I TO mavia_jobs', t);
  END LOOP;
END
$$;

-- O job de fechamento de fatura escreve estado e total.
GRANT UPDATE ON faturas TO mavia_jobs;
