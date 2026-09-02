-- 0006 — O núcleo: categorias, lançamentos, transferências e snapshot de saldo.
--
-- Implementa a seção 3 de docs/arquitetura/sistema.md, na fatia do épico 2.
--
-- Sobre o que ficou de fora: `cartoes`, `faturas`, `parcelamentos`,
-- `recorrencias` e `lancamentos_brutos` são dos épicos 3, 6 e 8. As colunas
-- que apontam para elas **já nascem aqui**, com as restrições corretas, e
-- ganham a chave estrangeira quando a tabela existir. Criar a coluna depois
-- exigiria reescrever `CHECK`s que dependem dela — e reescrever restrição de
-- integridade sobre dado de cliente é o tipo de migration que ninguém quer.

CREATE TYPE natureza_de_categoria AS ENUM ('receita', 'despesa');
CREATE TYPE lancamento_origem     AS ENUM ('manual', 'importado', 'recorrencia', 'parcelamento', 'ajuste');
CREATE TYPE tipo_de_transferencia AS ENUM ('entre_contas', 'pagamento_fatura');
CREATE TYPE eixo_de_saldo         AS ENUM ('competencia', 'caixa');

-- ---------------------------------------------------------------------------
-- Categorias — árvore de exatamente dois níveis
-- ---------------------------------------------------------------------------
CREATE TABLE categorias (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants (id),
  parent_id     UUID REFERENCES categorias (id),
  nivel         SMALLINT NOT NULL CHECK (nivel IN (1, 2)),
  nome          TEXT NOT NULL,
  natureza      natureza_de_categoria NOT NULL,
  -- Só folha recebe lançamento. É `CHECK`, não convenção: uma categoria-pai
  -- que aceita lançamento faz a soma da árvore contar o mesmo dinheiro duas
  -- vezes, e a divergência aparece só no relatório.
  analitica     BOOLEAN NOT NULL DEFAULT TRUE,
  cor           TEXT,
  icone         TEXT,
  sistema       BOOLEAN NOT NULL DEFAULT FALSE,
  arquivada_em  TIMESTAMPTZ,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ,

  CONSTRAINT raiz_nao_tem_pai CHECK ((nivel = 1) = (parent_id IS NULL))
);

CREATE INDEX categorias_por_tenant ON categorias (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX categorias_por_pai    ON categorias (tenant_id, parent_id);

-- O pai precisa ser raiz, e a filha herda a natureza dele. Uma subcategoria de
-- despesa pendurada numa raiz de receita inverteria o sinal do relatório sem
-- que nada reclamasse.
CREATE FUNCTION categoria_coerente() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_nivel_pai SMALLINT; v_natureza_pai natureza_de_categoria;
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;

  SELECT nivel, natureza INTO v_nivel_pai, v_natureza_pai
    FROM categorias WHERE id = NEW.parent_id AND tenant_id = NEW.tenant_id;

  IF v_nivel_pai IS NULL THEN
    RAISE EXCEPTION 'CATEGORIA_PAI_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;
  IF v_nivel_pai <> 1 THEN
    RAISE EXCEPTION 'ARVORE_TEM_DOIS_NIVEIS' USING ERRCODE = 'P0001';
  END IF;
  IF v_natureza_pai <> NEW.natureza THEN
    RAISE EXCEPTION 'SUBCATEGORIA_HERDA_NATUREZA' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER categoria_coerente_trg
  BEFORE INSERT OR UPDATE ON categorias
  FOR EACH ROW EXECUTE FUNCTION categoria_coerente();

-- ---------------------------------------------------------------------------
-- Transferências — o grupo que une as duas pernas
-- ---------------------------------------------------------------------------
CREATE TABLE transferencias (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants (id),
  tipo        tipo_de_transferencia NOT NULL DEFAULT 'entre_contas',
  -- Preenchida no épico 3. É o ÚNICO vínculo entre pagamento e fatura:
  -- `lancamentos.fatura_id` nunca aponta para a fatura paga, senão a perna de
  -- crédito entraria no total da fatura e o zeraria.
  fatura_id   UUID,
  descricao   TEXT NOT NULL,
  criado_por  UUID NOT NULL REFERENCES usuarios (id),
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX transferencias_por_tenant ON transferencias (tenant_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Lançamentos — o átomo
-- ---------------------------------------------------------------------------
CREATE TABLE lancamentos (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants (id),
  conta_id                 UUID REFERENCES contas (id),
  -- Sem FK até `cartoes` existir (épico 3). A restrição de exclusividade
  -- abaixo já vale, e é ela que impede o estado inválido.
  cartao_id                UUID,
  categoria_id             UUID REFERENCES categorias (id),

  valor_centavos           BIGINT NOT NULL,
  moeda                    CHAR(3) NOT NULL,

  -- Competência: quando o fato econômico aconteceu. Imutável.
  posted_at                TIMESTAMPTZ NOT NULL,
  -- Compensação: quando o dinheiro DE FATO se moveu. NULL enquanto não se moveu.
  -- Não existe coluna de previsão de caixa, e não existe coluna `status`:
  -- ambos são derivados (ADR 0007).
  settled_at               TIMESTAMPTZ,

  descricao                TEXT NOT NULL,
  observacao               TEXT,
  transfer_group_id        UUID REFERENCES transferencias (id),
  installment_group_id     UUID,
  installment_number       SMALLINT,
  installment_total        SMALLINT,
  fatura_id                UUID,
  estorno_de_lancamento_id UUID REFERENCES lancamentos (id),
  origem                   lancamento_origem NOT NULL DEFAULT 'manual',
  editado_manualmente      BOOLEAN NOT NULL DEFAULT FALSE,
  criado_por               UUID NOT NULL REFERENCES usuarios (id),
  criado_em                TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em            TIMESTAMPTZ,
  deleted_at               TIMESTAMPTZ,

  CONSTRAINT uma_origem_de_dinheiro CHECK (num_nonnulls(conta_id, cartao_id) = 1),

  -- Valor zero não é lançamento: é ruído que aparece no extrato e não muda
  -- saldo nenhum. Rateio que produziria parte zero é recusado na entidade.
  CONSTRAINT valor_nao_zero CHECK (valor_centavos <> 0),

  -- Categoria é obrigatória FORA da perna de transferência e proibida DENTRO
  -- dela. Sem isso, despesa sem categoria não consome teto nenhum e some de
  -- todo Planejamento, em silêncio.
  CONSTRAINT categoria_obrigatoria_fora_de_transferencia
    CHECK ((transfer_group_id IS NULL) = (categoria_id IS NOT NULL)),

  CONSTRAINT estorno_nao_e_o_proprio CHECK (estorno_de_lancamento_id <> id),

  CONSTRAINT parcela_coerente
    CHECK ((installment_group_id IS NULL) = (installment_number IS NULL)
           AND (installment_number IS NULL
                OR installment_number BETWEEN 1 AND installment_total)),

  -- Compensar antes de acontecer é impossível no mundo.
  CONSTRAINT compensacao_nao_antecede_competencia
    CHECK (settled_at IS NULL OR settled_at >= posted_at)
);

-- Todo índice de tabela de negócio lidera por tenant_id: a RLS injeta o filtro
-- em toda consulta, e índice que não lidere por ele não é usado.
CREATE INDEX lancamentos_extrato
  ON lancamentos (tenant_id, posted_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX lancamentos_por_conta
  ON lancamentos (tenant_id, conta_id, posted_at) WHERE deleted_at IS NULL;
-- Eixo caixa: só o que já compensou, e só de conta.
CREATE INDEX lancamentos_caixa
  ON lancamentos (tenant_id, conta_id, settled_at)
  WHERE settled_at IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX lancamentos_por_categoria
  ON lancamentos (tenant_id, categoria_id, posted_at) WHERE deleted_at IS NULL;
CREATE INDEX lancamentos_por_transferencia
  ON lancamentos (tenant_id, transfer_group_id) WHERE transfer_group_id IS NOT NULL;
CREATE INDEX lancamentos_por_estorno
  ON lancamentos (tenant_id, estorno_de_lancamento_id)
  WHERE estorno_de_lancamento_id IS NOT NULL;

-- Só categoria analítica recebe lançamento, e a natureza tem de bater com o
-- sinal. `CHECK` não alcança outra tabela, então é trigger.
CREATE FUNCTION lancamento_coerente() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_analitica BOOLEAN; v_natureza natureza_de_categoria;
BEGIN
  IF NEW.categoria_id IS NOT NULL THEN
    SELECT analitica, natureza INTO v_analitica, v_natureza
      FROM categorias WHERE id = NEW.categoria_id AND tenant_id = NEW.tenant_id;

    IF v_analitica IS NULL THEN
      RAISE EXCEPTION 'CATEGORIA_INEXISTENTE' USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_analitica THEN
      RAISE EXCEPTION 'CATEGORIA_NAO_ANALITICA' USING ERRCODE = 'P0001';
    END IF;
    -- Sinal e natureza precisam concordar: despesa é negativa, receita é
    -- positiva (regra 6). Um estorno inverte o sinal, e por isso é a exceção.
    IF NEW.estorno_de_lancamento_id IS NULL THEN
      IF v_natureza = 'despesa' AND NEW.valor_centavos > 0 THEN
        RAISE EXCEPTION 'DESPESA_TEM_SINAL_NEGATIVO' USING ERRCODE = 'P0001';
      END IF;
      IF v_natureza = 'receita' AND NEW.valor_centavos < 0 THEN
        RAISE EXCEPTION 'RECEITA_TEM_SINAL_POSITIVO' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lancamento_coerente_trg
  BEFORE INSERT OR UPDATE ON lancamentos
  FOR EACH ROW EXECUTE FUNCTION lancamento_coerente();

-- A invariante que define a transferência: exatamente duas pernas vivas,
-- somando zero. É `CONSTRAINT TRIGGER ... DEFERRABLE` porque as duas pernas
-- nascem em INSERTs separados — checar a cada linha reprovaria a primeira.
CREATE FUNCTION transferencia_equilibrada() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_grupo UUID; v_pernas INTEGER; v_soma BIGINT; v_contas INTEGER;
BEGIN
  v_grupo := coalesce(NEW.transfer_group_id, OLD.transfer_group_id);
  IF v_grupo IS NULL THEN RETURN NULL; END IF;

  SELECT count(*), coalesce(sum(valor_centavos), 0), count(DISTINCT conta_id)
    INTO v_pernas, v_soma, v_contas
    FROM lancamentos
   WHERE transfer_group_id = v_grupo AND deleted_at IS NULL;

  -- Zero pernas é transferência inteira excluída: legítimo.
  IF v_pernas = 0 THEN RETURN NULL; END IF;

  IF v_pernas <> 2 THEN
    -- Pega tanto a perna faltando quanto a perna isolada excluída, que criaria
    -- ou destruiria dinheiro do nada.
    RAISE EXCEPTION 'TRANSFERENCIA_TEM_DUAS_PERNAS' USING ERRCODE = 'P0001';
  END IF;
  IF v_soma <> 0 THEN
    RAISE EXCEPTION 'TRANSFERENCIA_SOMA_ZERO' USING ERRCODE = 'P0001';
  END IF;
  IF v_contas <> 2 THEN
    -- Transferir de uma conta para ela mesma move nada e suja o extrato.
    RAISE EXCEPTION 'TRANSFERENCIA_ENTRE_CONTAS_DISTINTAS' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER transferencia_equilibrada_trg
  AFTER INSERT OR UPDATE OR DELETE ON lancamentos
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION transferencia_equilibrada();

-- ---------------------------------------------------------------------------
-- Snapshot de saldo — materialização, nunca verdade
-- ---------------------------------------------------------------------------
-- O eixo faz parte da chave primária de propósito: é impossível ler um saldo
-- sem nomear o eixo, e foi misturar os dois eixos que produziu o defeito B2.
CREATE TABLE saldo_snapshots (
  tenant_id            UUID NOT NULL REFERENCES tenants (id),
  conta_id             UUID NOT NULL REFERENCES contas (id),
  eixo                 eixo_de_saldo NOT NULL,
  data_civil           DATE NOT NULL,
  saldo_centavos       BIGINT NOT NULL,
  ultimo_lancamento_em TIMESTAMPTZ,
  calculado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, conta_id, eixo, data_civil)
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['categorias', 'transferencias', 'lancamentos', 'saldo_snapshots']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    $f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO mavia_app', t);
  END LOOP;
END
$$;

-- O worker calcula e materializa saldo; não escreve lançamento.
GRANT SELECT ON lancamentos, categorias, transferencias TO mavia_jobs;
GRANT SELECT, INSERT, UPDATE, DELETE ON saldo_snapshots TO mavia_jobs;
