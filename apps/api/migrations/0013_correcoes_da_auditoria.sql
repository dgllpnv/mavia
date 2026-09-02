-- 0013 — Quatro bloqueios da auditoria do épico 3.
--
-- Fonte: docs/validacao/auditoria-epico-3.md. Todos reproduzidos contra
-- Postgres real, com contraexemplo medido.

-- ---------------------------------------------------------------------------
-- CT-1 — a fatura aberta valia zero
-- ---------------------------------------------------------------------------
-- `total_centavos` só era escrito por `fechar_fatura`. Enquanto a fatura
-- estava aberta ela valia zero, e uma compra de R$ 300,00 sumia da projeção e
-- do Saldo geral: a conta projetava R$ 1.000,00 quando o usuário devia
-- R$ 700,00.
--
-- A correção não é a projeção somar lançamentos por fora — isso criaria uma
-- segunda regra de "quanto vale uma fatura", e duas regras divergem. O total
-- passa a ser mantido por gatilho enquanto a fatura está aberta, e
-- `fechar_fatura` apenas **congela** o que já estava certo.
CREATE FUNCTION recalcular_total_da_fatura() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_fatura UUID; v_estado estado_de_fatura;
BEGIN
  v_fatura := coalesce(NEW.fatura_id, OLD.fatura_id);
  IF v_fatura IS NULL THEN RETURN NULL; END IF;

  SELECT estado INTO v_estado FROM faturas WHERE id = v_fatura;
  -- Fatura fechada tem total travado, e é isso que a torna confiável.
  IF v_estado IS DISTINCT FROM 'aberta' THEN RETURN NULL; END IF;

  UPDATE faturas f
     SET total_centavos = coalesce((SELECT sum(l.valor_centavos) FROM lancamentos l
                                     WHERE l.fatura_id = v_fatura AND l.deleted_at IS NULL), 0),
         atualizado_em = now()
   WHERE f.id = v_fatura;
  RETURN NULL;
END;
$$;

CREATE TRIGGER recalcular_total_da_fatura_trg
  AFTER INSERT OR UPDATE OR DELETE ON lancamentos
  FOR EACH ROW EXECUTE FUNCTION recalcular_total_da_fatura();

-- ---------------------------------------------------------------------------
-- CT-3 — a fatura fechada era imutável só contra INSERT
-- ---------------------------------------------------------------------------
-- O gatilho era `BEFORE INSERT`. Um `UPDATE` de valor deixava o total travado
-- em −R$ 100,00 com soma real de −R$ 999,99; um soft delete deixava a fatura
-- cobrando R$ 150,00 com R$ 50,00 de compras vivas — e o pagamento de
-- R$ 150,00 era aceito.
CREATE OR REPLACE FUNCTION fatura_fechada_nao_recebe() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_estado estado_de_fatura; v_fatura UUID;
BEGIN
  -- Vale para a fatura de destino e para a de origem: mover um lançamento
  -- para fora de uma fatura fechada a altera tanto quanto acrescentar nele.
  FOREACH v_fatura IN ARRAY ARRAY[NEW.fatura_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.fatura_id END]
  LOOP
    IF v_fatura IS NULL THEN CONTINUE; END IF;

    SELECT estado INTO v_estado FROM faturas
     WHERE id = v_fatura AND tenant_id = NEW.tenant_id;

    IF v_estado IS NULL THEN
      RAISE EXCEPTION 'FATURA_INEXISTENTE' USING ERRCODE = 'P0001';
    END IF;

    IF v_estado <> 'aberta' THEN
      -- O `UPDATE` que só compensa é permitido: é exatamente o que
      -- `registrar_pagamento_de_fatura` faz ao quitar, e ele não muda o total.
      IF TG_OP = 'UPDATE'
         AND NEW.valor_centavos = OLD.valor_centavos
         AND NEW.fatura_id IS NOT DISTINCT FROM OLD.fatura_id
         AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at
      THEN
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'FATURA_FECHADA_NAO_RECEBE' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER fatura_fechada_nao_recebe_trg ON lancamentos;
CREATE TRIGGER fatura_fechada_nao_recebe_trg
  BEFORE INSERT OR UPDATE ON lancamentos
  FOR EACH ROW EXECUTE FUNCTION fatura_fechada_nao_recebe();

-- ---------------------------------------------------------------------------
-- CT-4 — a fatura credora
-- ---------------------------------------------------------------------------
-- Um reembolso maior que as compras deixa a fatura **a favor** do usuário: o
-- cartão deve a ele. `abs(v_total)` apagava o sinal, e a fatura credora era
-- aceita para pagamento — tirando dinheiro da conta em vez de devolver.
--
-- O contraexemplo mediu R$ 200,00 de erro: R$ 100,00 entrando como se fosse
-- dinheiro na conta, mais R$ 100,00 saindo num "pagamento" que não existe.
CREATE OR REPLACE FUNCTION registrar_pagamento_de_fatura(
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
    RAISE EXCEPTION 'FATURA_AINDA_ABERTA' USING ERRCODE = 'P0001';
  END IF;
  IF v_estado = 'paga' THEN
    RAISE EXCEPTION 'FATURA_JA_PAGA' USING ERRCODE = 'P0001';
  END IF;

  -- Fatura credora não se paga: o cartão é que deve. O saldo vira crédito na
  -- fatura seguinte, e forçar um pagamento aqui tiraria dinheiro da conta.
  IF v_total >= 0 THEN
    RAISE EXCEPTION 'FATURA_CREDORA_NAO_SE_PAGA' USING ERRCODE = 'P0001';
  END IF;

  IF p_valor <= 0 THEN
    RAISE EXCEPTION 'PAGAMENTO_TEM_MAGNITUDE_POSITIVA' USING ERRCODE = 'P0001';
  END IF;
  IF v_pago + p_valor > -v_total THEN
    RAISE EXCEPTION 'PAGAMENTO_EXCEDE_A_FATURA' USING ERRCODE = 'P0001';
  END IF;

  -- CT-5 — a data de pagamento vem do servidor, e o futuro é recusado.
  -- Aceitar `2099-01-01` derrubava o saldo hoje por um fato que não aconteceu
  -- (regras 8 e 9 do CLAUDE.md).
  IF p_quando > now() THEN
    RAISE EXCEPTION 'PAGAMENTO_NAO_ACONTECE_NO_FUTURO' USING ERRCODE = 'P0001';
  END IF;

  v_pago := v_pago + p_valor;
  v_novo := CASE WHEN v_pago = -v_total THEN 'paga'::estado_de_fatura
                 ELSE 'parcialmente_paga'::estado_de_fatura END;

  UPDATE faturas
     SET pago_centavos = v_pago, estado = v_novo, atualizado_em = now()
   WHERE id = p_fatura AND tenant_id = p_tenant;

  IF v_novo = 'paga' THEN
    UPDATE lancamentos
       SET settled_at = p_quando, atualizado_em = now()
     WHERE tenant_id = p_tenant AND fatura_id = p_fatura AND deleted_at IS NULL;
  END IF;

  RETURN v_novo;
END;
$$;

-- `fechar_fatura` deixa de recalcular: o total já está certo pelo gatilho, e
-- recalcular aqui seria a segunda regra que diverge da primeira.
CREATE OR REPLACE FUNCTION fechar_fatura(p_tenant UUID, p_fatura UUID)
RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE v_estado estado_de_fatura; v_total BIGINT;
BEGIN
  SELECT estado, total_centavos INTO v_estado, v_total
    FROM faturas WHERE id = p_fatura AND tenant_id = p_tenant AND deleted_at IS NULL
    FOR UPDATE;

  IF v_estado IS NULL THEN
    RAISE EXCEPTION 'FATURA_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;
  IF v_estado <> 'aberta' THEN
    RAISE EXCEPTION 'FATURA_JA_FECHADA' USING ERRCODE = 'P0001';
  END IF;

  -- Fatura de total zero fecha direto como paga: não há o que cobrar, e
  -- deixá-la `fechada` esperaria um pagamento de R$ 0,00 que ninguém faz.
  UPDATE faturas
     SET estado = CASE WHEN v_total = 0 THEN 'paga'::estado_de_fatura
                       ELSE 'fechada'::estado_de_fatura END,
         atualizado_em = now()
   WHERE id = p_fatura AND tenant_id = p_tenant;

  RETURN v_total;
END;
$$;
