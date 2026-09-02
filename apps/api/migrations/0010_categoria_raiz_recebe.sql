-- 0010 — `analitica` deixa de significar "é folha".
--
-- Implementa o ADR 0021. Reverte uma decisão minha da migration 0006, e o
-- motivo importa mais que a mudança.
--
-- Eu tratei `analitica` como "é folha da árvore" e escrevi um gatilho que
-- recusa lançamento em categoria não analítica. Duas consequências, ambas
-- descobertas pelo `arquiteto-dominio-financeiro`:
--
-- 1. **A árvore ficou imutável na prática.** "Uso `Casa` há seis meses, agora
--    quero separar `Luz` e `Água`" — no instante em que a primeira filha
--    nasce, todo o histórico da raiz vira ilegal. As saídas eram recusar a
--    subcategoria, reclassificar o passado, ou tolerar linhas violando a
--    regra. Nenhuma é aceitável.
--
-- 2. **`Ajuste de saldo` ficou inalcançável.** Ele é `analitica = false` por
--    natureza — altera o saldo e não é gasto nem ganho — e o gatilho o
--    impedia de existir. O sétimo balde nunca foi escrito porque nada podia
--    cair nele.
--
-- `analitica` passa a significar exatamente uma coisa: **o lançamento não é
-- fato econômico**. A exclusão do relatório de gasto acontece no balde, que é
-- onde ela sempre pertenceu.

-- ---------------------------------------------------------------------------
-- O gatilho que recusa lançamento em categoria não analítica sai
-- ---------------------------------------------------------------------------
-- A verificação de sinal × natureza permanece: ela é sobre coerência do dado,
-- não sobre posição na árvore.
CREATE OR REPLACE FUNCTION lancamento_coerente() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_natureza natureza_de_categoria; v_existe BOOLEAN;
BEGIN
  IF NEW.categoria_id IS NOT NULL THEN
    SELECT TRUE, natureza INTO v_existe, v_natureza
      FROM categorias WHERE id = NEW.categoria_id AND tenant_id = NEW.tenant_id;

    IF v_existe IS NULL THEN
      RAISE EXCEPTION 'CATEGORIA_INEXISTENTE' USING ERRCODE = 'P0001';
    END IF;

    -- Raiz com filhas, raiz sem filhas e subcategoria recebem lançamento
    -- igualmente. Não existe regra de folha.
    --
    -- Categoria não analítica também recebe: é o caso do `Ajuste de saldo`,
    -- e o balde `nao_analitica` é quem o mantém fora do relatório de gasto.
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

-- ---------------------------------------------------------------------------
-- Categorias de sistema
-- ---------------------------------------------------------------------------
-- `Ajuste de saldo` agora é representável. Ele existe para o dia em que o saldo
-- do produto não bate com o do banco e o usuário concilia a diferença: é
-- movimento de saldo sem ser gasto nem ganho, e distorceria todo relatório de
-- categoria se entrasse nos baldes de despesa ou receita.
--
-- `sistema = true` impede a exclusão; `analitica = false` o mantém fora do
-- relatório de gasto e de todo `Planejamento`.
INSERT INTO categorias (tenant_id, nivel, nome, natureza, analitica, sistema)
SELECT t.id, 1, 'Ajuste de saldo', n.natureza, FALSE, TRUE
  FROM tenants t
 CROSS JOIN (VALUES ('receita'::natureza_de_categoria), ('despesa'::natureza_de_categoria)) AS n(natureza)
 WHERE t.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM categorias c
      WHERE c.tenant_id = t.id AND c.nome = 'Ajuste de saldo' AND c.natureza = n.natureza
   );

-- Índice para a agregação: ela passa a fazer JOIN com `categorias` para
-- particionar por natureza, e não mais pelo sinal do valor.
CREATE INDEX categorias_classificacao
  ON categorias (tenant_id, id) INCLUDE (natureza, analitica);
