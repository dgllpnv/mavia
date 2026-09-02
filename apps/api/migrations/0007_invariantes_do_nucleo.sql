-- 0007 — Duas invariantes que faltavam, ambas apontadas pela bateria do
-- `validador-financeiro` (docs/validacao/bateria-epico-2.md).
--
-- As duas têm a mesma assinatura: os números continuam somando, e ainda assim
-- há dinheiro criado ou movido sem que nada tenha acontecido. Nenhum teste de
-- soma detecta.

-- ---------------------------------------------------------------------------
-- ES-5 — excluir o original de um estorno cria dinheiro
-- ---------------------------------------------------------------------------
-- Despesa de R$ 100,00 estornada em R$ 100,00: o par soma zero. Excluindo o
-- original, sobra só o estorno de +R$ 100,00 — e o saldo ganha cem reais que
-- nunca existiram.
--
-- A regra correta não é "não exclua": é que **o par sai junto**. Quem desfaz
-- um lançamento estornado desfaz os dois lados do fato.
CREATE FUNCTION original_estornado_nao_some() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_estornos INTEGER;
BEGIN
  -- Só interessa a transição para excluído.
  IF NEW.deleted_at IS NULL OR OLD.deleted_at IS NOT NULL THEN RETURN NEW; END IF;

  SELECT count(*) INTO v_estornos
    FROM lancamentos e
   WHERE e.estorno_de_lancamento_id = NEW.id
     AND e.deleted_at IS NULL;

  IF v_estornos > 0 THEN
    RAISE EXCEPTION 'ORIGINAL_TEM_ESTORNO_VIVO' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER original_estornado_nao_some_trg
  BEFORE UPDATE ON lancamentos
  FOR EACH ROW EXECUTE FUNCTION original_estornado_nao_some();

-- ---------------------------------------------------------------------------
-- TR-7 — pernas com compensação divergente somem do saldo por um dia
-- ---------------------------------------------------------------------------
-- Transferência de R$ 500,00 com a perna de saída compensada e a de entrada
-- ainda não: o Saldo geral perde R$ 500,00 até a segunda compensar. O dinheiro
-- não sumiu — ele está entre duas contas do próprio usuário, e a tela diz que
-- ele empobreceu.
--
-- Entre contas próprias a transferência é instantânea por definição: as duas
-- pernas compensam juntas ou nenhuma compensa.
CREATE FUNCTION transferencia_compensa_junto() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_grupo UUID; v_distintos INTEGER;
BEGIN
  v_grupo := coalesce(NEW.transfer_group_id, OLD.transfer_group_id);
  IF v_grupo IS NULL THEN RETURN NULL; END IF;

  -- `IS NOT DISTINCT FROM` via count de valores distintos, contando NULL como
  -- valor: duas pernas com NULL são coerentes; uma com NULL e outra com data
  -- não são.
  SELECT count(DISTINCT coalesce(settled_at, 'epoch'::timestamptz))
    INTO v_distintos
    FROM lancamentos
   WHERE transfer_group_id = v_grupo AND deleted_at IS NULL;

  IF v_distintos > 1 THEN
    RAISE EXCEPTION 'TRANSFERENCIA_COMPENSA_JUNTO' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER transferencia_compensa_junto_trg
  AFTER INSERT OR UPDATE ON lancamentos
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION transferencia_compensa_junto();
