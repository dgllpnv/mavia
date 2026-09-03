-- 0018 — Recorrencia: a regra que gera lançamentos repetidos.
--
-- Ver `CONTEXT.md`, verbete **Recorrencia**. A tabela guarda **a regra**, nunca
-- as ocorrências: quem materializa é a aplicação, dentro de um horizonte, e a
-- identidade de cada ocorrência é a **competência**, não a data.

CREATE TABLE recorrencias (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants (id),

  -- Uma origem de dinheiro, como no lançamento que ela gera. Assinatura no
  -- cartão é o caso que o glossário nomeia, e ela não é um lançamento de conta.
  conta_id        UUID REFERENCES contas (id),
  cartao_id       UUID REFERENCES cartoes (id),

  categoria_id    UUID NOT NULL REFERENCES categorias (id),
  valor_centavos  BIGINT NOT NULL,
  moeda           CHAR(3) NOT NULL DEFAULT 'BRL',
  descricao       TEXT NOT NULL,

  -- 1 a 31. Dia 31 em fevereiro é **ancorado**, nunca transborda.
  dia_do_mes      SMALLINT NOT NULL,
  -- 1 é mensal, 12 é anual. Reaproveita a mesma ancoragem em vez de introduzir
  -- uma segunda regra de data.
  intervalo_meses SMALLINT NOT NULL DEFAULT 1,

  -- Competências, guardadas no dia 1. `fim` é **inclusivo** e nulo é perpétua.
  inicio          DATE NOT NULL,
  fim             DATE,

  -- Pausar não é excluir: a regra para de produzir e o que já foi materializado
  -- fica. Sem isto, quem quer suspender o aluguel por dois meses tem de apagar
  -- a regra e perder o histórico dela.
  pausada_em      TIMESTAMPTZ,

  criado_por      UUID NOT NULL REFERENCES usuarios (id),
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em   TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,

  CONSTRAINT uma_origem_de_dinheiro CHECK (num_nonnulls(conta_id, cartao_id) = 1),
  CONSTRAINT valor_nao_zero         CHECK (valor_centavos <> 0),
  CONSTRAINT dia_do_mes_valido      CHECK (dia_do_mes BETWEEN 1 AND 31),
  CONSTRAINT intervalo_valido       CHECK (intervalo_meses BETWEEN 1 AND 12),
  CONSTRAINT competencias_no_dia_um
    CHECK (extract(day FROM inicio) = 1 AND (fim IS NULL OR extract(day FROM fim) = 1)),
  CONSTRAINT fim_nao_precede_inicio CHECK (fim IS NULL OR fim >= inicio)
);

CREATE INDEX recorrencias_por_tenant ON recorrencias (tenant_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- A ocorrência materializada
-- ---------------------------------------------------------------------------
-- **A identidade mora no lançamento**, e não numa tabela de ocorrências à parte.
-- Uma tabela separada teria de ser mantida em sincronia com `lancamentos` a
-- cada exclusão e a cada estorno; a coluna não tem como divergir dela mesma.
ALTER TABLE lancamentos
  ADD COLUMN recorrencia_id          UUID REFERENCES recorrencias (id),
  ADD COLUMN recorrencia_competencia DATE,
  ADD CONSTRAINT ocorrencia_coerente
    CHECK ((recorrencia_id IS NULL) = (recorrencia_competencia IS NULL)),
  ADD CONSTRAINT ocorrencia_no_dia_um
    CHECK (recorrencia_competencia IS NULL
           OR extract(day FROM recorrencia_competencia) = 1);

-- A identidade é `(tenant, recorrencia, competência)` — a **competência**, e não
-- a data exata. Com a data na chave, alterar `dia_do_mes` faria o materializador
-- gerar tudo de novo e o mês ganharia uma segunda ocorrência da mesma regra.
CREATE UNIQUE INDEX ocorrencia_da_recorrencia
  ON lancamentos (tenant_id, recorrencia_id, recorrencia_competencia)
  WHERE recorrencia_id IS NOT NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Coerência
-- ---------------------------------------------------------------------------
CREATE FUNCTION recorrencia_e_coerente() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_natureza natureza_de_categoria; v_analitica BOOLEAN;
BEGIN
  SELECT natureza, analitica INTO v_natureza, v_analitica
    FROM categorias
   WHERE id = NEW.categoria_id AND tenant_id = NEW.tenant_id AND deleted_at IS NULL;

  IF v_natureza IS NULL THEN
    RAISE EXCEPTION 'CATEGORIA_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_analitica THEN
    RAISE EXCEPTION 'CATEGORIA_NAO_ANALITICA' USING ERRCODE = 'P0001';
  END IF;

  -- O sinal concorda com a natureza, exatamente como no lançamento que a regra
  -- vai gerar. Recusar aqui é recusar **uma** vez; recusar na materialização
  -- seria recusar todo mês, depois de a regra já existir.
  IF v_natureza = 'despesa' AND NEW.valor_centavos > 0 THEN
    RAISE EXCEPTION 'DESPESA_TEM_VALOR_NEGATIVO' USING ERRCODE = 'P0001';
  END IF;
  IF v_natureza = 'receita' AND NEW.valor_centavos < 0 THEN
    RAISE EXCEPTION 'RECEITA_TEM_VALOR_POSITIVO' USING ERRCODE = 'P0001';
  END IF;

  -- Cartão é dívida: uma recorrência de **receita** no cartão não existe.
  IF NEW.cartao_id IS NOT NULL AND v_natureza = 'receita' THEN
    RAISE EXCEPTION 'CARTAO_NAO_RECEBE_RECEITA' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER recorrencia_e_coerente_trg
  BEFORE INSERT OR UPDATE ON recorrencias
  FOR EACH ROW EXECUTE FUNCTION recorrencia_e_coerente();

-- ---------------------------------------------------------------------------
-- Isolamento
-- ---------------------------------------------------------------------------
ALTER TABLE recorrencias ENABLE ROW LEVEL SECURITY;
ALTER TABLE recorrencias FORCE  ROW LEVEL SECURITY;
CREATE POLICY recorrencia_do_tenant ON recorrencias
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON recorrencias TO mavia_app;
