-- 0009 — A transferência também vai de conta para cartão.
--
-- Defeito do épico 2, exposto ao construir o épico 3.
--
-- O gatilho `transferencia_equilibrada` da migration 0006 exigia
-- `count(DISTINCT conta_id) = 2`. Isso assumia, sem dizer, que **toda**
-- transferência é entre duas contas.
--
-- Mas o pagamento de fatura — que a regra 12 do `CLAUDE.md` define como
-- transferência, e que é a razão de a transferência existir neste produto — vai
-- de uma `Conta` para um `Cartao`. A perna do cartão tem `conta_id` nulo, então
-- a contagem dava 1 e o pagamento era recusado.
--
-- O erro tem a forma clássica: a invariante estava certa sobre o caso que eu
-- tinha em mente e silenciosamente errada sobre o caso que ainda não existia.
--
-- A regra correta não fala de contas: fala de **onde o dinheiro está**. As duas
-- pernas precisam tocar recipientes distintos, seja conta-conta ou
-- conta-cartão. Continua recusando A → A, que era o ponto original.

CREATE OR REPLACE FUNCTION transferencia_equilibrada() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_grupo UUID; v_pernas INTEGER; v_soma BIGINT; v_recipientes INTEGER;
BEGIN
  v_grupo := coalesce(NEW.transfer_group_id, OLD.transfer_group_id);
  IF v_grupo IS NULL THEN RETURN NULL; END IF;

  SELECT count(*),
         coalesce(sum(valor_centavos), 0),
         -- O recipiente é a conta OU o cartão. O prefixo impede que um id de
         -- conta e um de cartão colidam se um dia forem iguais por acaso.
         count(DISTINCT coalesce('conta:' || conta_id::text, 'cartao:' || cartao_id::text))
    INTO v_pernas, v_soma, v_recipientes
    FROM lancamentos
   WHERE transfer_group_id = v_grupo AND deleted_at IS NULL;

  -- Zero pernas é transferência inteira excluída: legítimo.
  IF v_pernas = 0 THEN RETURN NULL; END IF;

  IF v_pernas <> 2 THEN
    RAISE EXCEPTION 'TRANSFERENCIA_TEM_DUAS_PERNAS' USING ERRCODE = 'P0001';
  END IF;
  IF v_soma <> 0 THEN
    RAISE EXCEPTION 'TRANSFERENCIA_SOMA_ZERO' USING ERRCODE = 'P0001';
  END IF;
  IF v_recipientes <> 2 THEN
    -- Transferir de um recipiente para ele mesmo move nada e suja o extrato.
    RAISE EXCEPTION 'TRANSFERENCIA_ENTRE_RECIPIENTES_DISTINTOS' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- A compensação conjunta (migration 0007) continua valendo e não muda: as duas
-- pernas de um pagamento de fatura também compensam juntas.
