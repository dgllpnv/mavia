-- 0012 — Fechar e pagar fatura, no banco.
--
-- Estas duas operações são as que mais mexem em dinheiro de uma vez, e as
-- duas precisam ser atômicas: fechar pela metade deixa um total que ninguém
-- sabe se é final, e pagar pela metade deixa lançamentos compensados numa
-- fatura que continua devendo.
--
-- Vivem no banco, e não na aplicação, porque a atomicidade é do banco. Fazer
-- em duas viagens deixaria uma janela em que o estado é inconsistente e
-- visível.

-- ---------------------------------------------------------------------------
-- Fechar
-- ---------------------------------------------------------------------------
-- Trava o total. Depois disto, a fatura não recebe lançamento novo — o gatilho
-- `fatura_fechada_nao_recebe` cuida disso — e o número que o usuário vê para
-- de mudar.
CREATE FUNCTION fechar_fatura(p_tenant UUID, p_fatura UUID)
RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE v_estado estado_de_fatura; v_total BIGINT;
BEGIN
  SELECT estado INTO v_estado
    FROM faturas WHERE id = p_fatura AND tenant_id = p_tenant AND deleted_at IS NULL
    FOR UPDATE;

  IF v_estado IS NULL THEN
    RAISE EXCEPTION 'FATURA_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;
  IF v_estado <> 'aberta' THEN
    -- Fechar duas vezes recalcularia o total de uma fatura que já pode ter
    -- sido paga. Idempotente seria pior: esconderia o erro de quem chamou.
    RAISE EXCEPTION 'FATURA_JA_FECHADA' USING ERRCODE = 'P0001';
  END IF;

  -- Soma só o que pertence à fatura. Perna de transferência não tem
  -- `fatura_id` — é o que impede o pagamento de zerar o próprio total.
  SELECT coalesce(sum(valor_centavos), 0) INTO v_total
    FROM lancamentos
   WHERE tenant_id = p_tenant AND fatura_id = p_fatura AND deleted_at IS NULL;

  UPDATE faturas
     SET estado = 'fechada', total_centavos = v_total, atualizado_em = now()
   WHERE id = p_fatura AND tenant_id = p_tenant;

  RETURN v_total;
END;
$$;

-- ---------------------------------------------------------------------------
-- Registrar pagamento
-- ---------------------------------------------------------------------------
-- Quando a fatura é quitada, e **só** então, os lançamentos dela ganham
-- `settled_at`: é o pagamento que move o dinheiro, não a compra.
--
-- Pagamento parcial não compensa nada. Metade do dinheiro ter saído não torna
-- metade das compras compensadas — não há como dizer quais.
CREATE FUNCTION registrar_pagamento_de_fatura(
  p_tenant UUID, p_fatura UUID, p_valor BIGINT, p_quando TIMESTAMPTZ)
RETURNS estado_de_fatura
LANGUAGE plpgsql AS $$
DECLARE v_estado estado_de_fatura; v_total BIGINT; v_pago BIGINT; v_novo estado_de_fatura;
BEGIN
  SELECT estado, total_centavos, pago_centavos INTO v_estado, v_total, v_pago
    FROM faturas WHERE id = p_fatura AND tenant_id = p_tenant AND deleted_at IS NULL
    FOR UPDATE;

  IF v_estado IS NULL THEN
    RAISE EXCEPTION 'FATURA_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;
  IF v_estado = 'aberta' THEN
    -- Pagar antes de fechar é pagar um total que ainda pode mudar.
    RAISE EXCEPTION 'FATURA_AINDA_ABERTA' USING ERRCODE = 'P0001';
  END IF;
  IF v_estado = 'paga' THEN
    RAISE EXCEPTION 'FATURA_JA_PAGA' USING ERRCODE = 'P0001';
  END IF;

  -- O total é negativo (é dívida); o pagamento chega como magnitude positiva.
  IF p_valor <= 0 THEN
    RAISE EXCEPTION 'PAGAMENTO_TEM_MAGNITUDE_POSITIVA' USING ERRCODE = 'P0001';
  END IF;
  IF v_pago + p_valor > abs(v_total) THEN
    RAISE EXCEPTION 'PAGAMENTO_EXCEDE_A_FATURA' USING ERRCODE = 'P0001';
  END IF;

  v_pago := v_pago + p_valor;
  v_novo := CASE WHEN v_pago = abs(v_total) THEN 'paga'::estado_de_fatura
                 ELSE 'parcialmente_paga'::estado_de_fatura END;

  UPDATE faturas
     SET pago_centavos = v_pago, estado = v_novo, atualizado_em = now()
   WHERE id = p_fatura AND tenant_id = p_tenant;

  -- A quitação é o instante em que o dinheiro se move. Antes disso, os
  -- lançamentos da fatura são `pendente` — estão no Realizado do mês e fora
  -- do Saldo, e as duas coisas estão certas.
  IF v_novo = 'paga' THEN
    UPDATE lancamentos
       SET settled_at = p_quando, atualizado_em = now()
     WHERE tenant_id = p_tenant AND fatura_id = p_fatura AND deleted_at IS NULL;
  END IF;

  RETURN v_novo;
END;
$$;

GRANT EXECUTE ON FUNCTION fechar_fatura(UUID, UUID) TO mavia_app;
GRANT EXECUTE ON FUNCTION registrar_pagamento_de_fatura(UUID, UUID, BIGINT, TIMESTAMPTZ) TO mavia_app;
-- O job de fechamento roda pelo calendário, sem requisição.
GRANT EXECUTE ON FUNCTION fechar_fatura(UUID, UUID) TO mavia_jobs;
