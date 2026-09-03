-- 0016 — Planejamento: teto de despesa e piso de receita, por competência.
--
-- Substitui **Limite** e **meta de receita mensal** por uma entidade só. Ver
-- ADR 0008 e o verbete `Planejamento` no `CONTEXT.md`.
--
-- **O sinal do valor é a natureza.** Negativo é teto, positivo é piso. Não há
-- coluna `natureza`, e a ausência é o ponto: com o enum, cada regra vinha em
-- duas metades que precisavam ser mantidas simétricas à mão, e não ficaram.

CREATE TABLE planejamentos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants (id),

  -- Competência é o mês, guardado no dia 1 — a mesma convenção de `faturas`.
  competencia    DATE NOT NULL,

  -- Nulo é o **planejamento global**, e é um valor legítimo da identidade.
  categoria_id   UUID REFERENCES categorias (id),

  -- Com sinal, sempre. É ele que carrega a natureza.
  valor_centavos BIGINT NOT NULL,
  moeda          CHAR(3) NOT NULL DEFAULT 'BRL',

  -- Percentuais em que o domínio emite evento. O padrão vem do CONTEXT.md.
  alertas_percentuais SMALLINT[] NOT NULL DEFAULT ARRAY[80, 100],

  criado_por     UUID NOT NULL REFERENCES usuarios (id),
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ,
  deleted_at     TIMESTAMPTZ,

  CONSTRAINT competencia_no_dia_um CHECK (extract(day FROM competencia) = 1),

  -- `valor ≠ 0`, e não é preciosismo: é o que garante que a razão de consumo
  -- nunca divide por zero. Um planejamento de R$ 0,00 também não significa
  -- nada — "não gastar nada" se expressa não criando o planejamento.
  CONSTRAINT valor_nao_zero CHECK (valor_centavos <> 0)

  -- O intervalo dos alertas é verificado no gatilho abaixo, e não aqui:
  -- percorrer um array exige `unnest`, `unnest` é subconsulta, e `CHECK` não
  -- aceita subconsulta. Gatilho pode.
);

-- ---------------------------------------------------------------------------
-- A identidade, e por que ela precisa de DOIS índices
-- ---------------------------------------------------------------------------
-- A identidade é `(tenant_id, competencia, natureza, categoria_id)`, com
-- `categoria_id` nulo sendo um valor legítimo e único.
--
-- `NULL` não colide em índice único no Postgres: uma restrição `UNIQUE` sobre
-- as quatro colunas deixaria criar **dois** planejamentos globais de despesa
-- para o mesmo mês, e o segundo passaria despercebido até o total do mês vir
-- dobrado. Daí os dois índices **parciais**: um para o escopo de categoria,
-- outro para o global.
--
-- A natureza entra como expressão do sinal, e não como coluna: teto e piso são
-- linhas distintas da mesma identidade.
CREATE UNIQUE INDEX planejamento_por_categoria
  ON planejamentos (tenant_id, competencia, categoria_id, (valor_centavos < 0))
  WHERE deleted_at IS NULL AND categoria_id IS NOT NULL;

CREATE UNIQUE INDEX planejamento_global
  ON planejamentos (tenant_id, competencia, (valor_centavos < 0))
  WHERE deleted_at IS NULL AND categoria_id IS NULL;

CREATE INDEX planejamentos_por_competencia
  ON planejamentos (tenant_id, competencia) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- O sinal concorda com a natureza da categoria
-- ---------------------------------------------------------------------------
-- Com `categoria_id` preenchido, despesa exige valor negativo e receita exige
-- positivo. Sem isso, um "teto" numa categoria de receita agregaria despesa
-- nenhuma e ficaria eternamente em 0% — um planejamento que nunca dispara e
-- nunca é notado.
--
-- Com `categoria_id` nulo não há categoria contra a qual conferir: ali o sinal
-- **define** a natureza do escopo em vez de ser conferido por ela.
--
-- É gatilho, e não `CHECK`: a natureza mora noutra tabela, e `CHECK` não
-- consulta.
CREATE FUNCTION planejamento_e_coerente() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_natureza natureza_de_categoria; v_analitica BOOLEAN; v_fora INTEGER;
BEGIN
  -- Alertas entre 1% e 1000%. Acima de 100% é legítimo — avisar aos 150% de um
  -- teto já estourado é útil —, mas zero e negativo não são percentuais.
  SELECT count(*) INTO v_fora
    FROM unnest(NEW.alertas_percentuais) AS p
   WHERE p < 1 OR p > 1000;

  IF v_fora > 0 THEN
    RAISE EXCEPTION 'ALERTA_FORA_DO_INTERVALO' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.categoria_id IS NULL THEN RETURN NEW; END IF;

  SELECT natureza, analitica INTO v_natureza, v_analitica
    FROM categorias
   WHERE id = NEW.categoria_id AND tenant_id = NEW.tenant_id AND deleted_at IS NULL;

  IF v_natureza IS NULL THEN
    RAISE EXCEPTION 'CATEGORIA_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;

  -- Categoria não analítica está fora de todo Planejamento (`CONTEXT.md`):
  -- `Ajuste de saldo` é correção de registro, não gasto, e um teto sobre ela
  -- mediria a frequência com que o usuário concilia o saldo.
  IF NOT v_analitica THEN
    RAISE EXCEPTION 'CATEGORIA_NAO_ANALITICA_NAO_SE_PLANEJA' USING ERRCODE = 'P0001';
  END IF;

  IF v_natureza = 'despesa' AND NEW.valor_centavos > 0 THEN
    RAISE EXCEPTION 'TETO_DE_DESPESA_TEM_VALOR_NEGATIVO' USING ERRCODE = 'P0001';
  END IF;
  IF v_natureza = 'receita' AND NEW.valor_centavos < 0 THEN
    RAISE EXCEPTION 'PISO_DE_RECEITA_TEM_VALOR_POSITIVO' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER planejamento_e_coerente_trg
  BEFORE INSERT OR UPDATE ON planejamentos
  FOR EACH ROW EXECUTE FUNCTION planejamento_e_coerente();

-- ---------------------------------------------------------------------------
-- Copiar planejamento de uma competência para outra
-- ---------------------------------------------------------------------------
-- O "copiar os últimos definidos" que o Organizze oferece na tela vazia, e que
-- existe porque o planejamento é **mensal e não perpétuo**.
--
-- Três propriedades, e a primeira é a que a versão ingênua quebra:
--
-- 1. **Idempotente, inclusive com um global na origem.** A verificação de
--    existência compara a identidade inteira com `IS NOT DISTINCT FROM`.
--    Escrita como `categoria_id = origem.categoria_id`, o global nunca é
--    encontrado — `NULL = NULL` é `NULL` —, o `INSERT` é tentado, o índice
--    parcial o rejeita, e a transação aborta levando junto as categorias que já
--    tinham sido copiadas.
-- 2. **Não destrutiva.** Só cria o que não existe no destino. Nunca sobrescreve
--    valor que o usuário editou.
-- 3. **Ignora categoria arquivada** no momento da cópia.
--
-- Copia o valor literalmente: sem correção monetária e sem projeção.
CREATE FUNCTION copiar_planejamentos(
  p_tenant UUID, p_de DATE, p_para DATE, p_usuario UUID)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_copiados INTEGER;
BEGIN
  INSERT INTO planejamentos
    (tenant_id, competencia, categoria_id, valor_centavos, moeda,
     alertas_percentuais, criado_por)
  SELECT o.tenant_id, p_para, o.categoria_id, o.valor_centavos, o.moeda,
         o.alertas_percentuais, p_usuario
    FROM planejamentos o
    LEFT JOIN categorias c
      ON c.id = o.categoria_id AND c.tenant_id = o.tenant_id
   WHERE o.tenant_id = p_tenant
     AND o.competencia = p_de
     AND o.deleted_at IS NULL
     -- Arquivada não vem junto; o global (sem categoria) vem sempre.
     AND (o.categoria_id IS NULL OR (c.arquivada_em IS NULL AND c.deleted_at IS NULL))
     AND NOT EXISTS (
       SELECT 1 FROM planejamentos d
        WHERE d.tenant_id = o.tenant_id
          AND d.competencia = p_para
          AND d.deleted_at IS NULL
          -- `IS NOT DISTINCT FROM`, e não `=`: é o que faz o global ser
          -- encontrado quando já existe no destino.
          AND d.categoria_id IS NOT DISTINCT FROM o.categoria_id
          AND (d.valor_centavos < 0) = (o.valor_centavos < 0)
     );

  GET DIAGNOSTICS v_copiados = ROW_COUNT;
  RETURN v_copiados;
END;
$$;

-- ---------------------------------------------------------------------------
-- Isolamento
-- ---------------------------------------------------------------------------
ALTER TABLE planejamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE planejamentos FORCE  ROW LEVEL SECURITY;
CREATE POLICY planejamento_do_tenant ON planejamentos
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON planejamentos TO mavia_app;
GRANT EXECUTE ON FUNCTION copiar_planejamentos(UUID, DATE, DATE, UUID) TO mavia_app;
