-- 0015 — Quem fecha uma fatura é o calendário, e um pagamento não antecede a
-- compra que ele paga.
--
-- **Como isto foi descoberto:** clicando em "fechar a fatura" na interface, num
-- dia 2, numa fatura que fecha dia 25 e já continha compras dos dias 12 e 14.
-- O fechamento passou sem reclamar. O pagamento seguinte devolveu 500 — o banco
-- recusou `settled_at < posted_at` pela restrição
-- `compensacao_nao_antecede_competencia`, que existe justamente para impedir
-- que algo se compense antes de acontecer.
--
-- A restrição estava certa; faltava a regra acima dela.

-- ---------------------------------------------------------------------------
-- Fechar é do calendário
-- ---------------------------------------------------------------------------
-- Uma fatura fechada antes da própria data de fechamento é incoerente de duas
-- maneiras ao mesmo tempo:
--
-- 1. Ela já contém compras **posteriores** ao seu fechamento — as que caíram na
--    janela e ainda estavam por vir.
-- 2. Toda compra seguinte do ciclo, que pertenceria a ela, passa a ser empurrada
--    para a fatura seguinte pelo gatilho `fatura_fechada_nao_recebe`. Em
--    silêncio: nada no sistema tem como saber que aquilo não devia ter
--    acontecido.
--
-- O fechamento não é uma escolha do usuário. É o ciclo do cartão, que o banco
-- emissor define e o produto apenas reflete. Um botão que antecipa isso é um
-- botão que corrompe o mês em curso.
CREATE OR REPLACE FUNCTION fechar_fatura(p_tenant UUID, p_fatura UUID)
RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE v_estado estado_de_fatura; v_total BIGINT; v_fechamento DATE;
BEGIN
  SELECT estado, total_centavos, data_fechamento
    INTO v_estado, v_total, v_fechamento
    FROM faturas WHERE id = p_fatura AND tenant_id = p_tenant AND deleted_at IS NULL
    FOR UPDATE;

  IF v_estado IS NULL THEN
    RAISE EXCEPTION 'FATURA_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;
  IF v_estado <> 'aberta' THEN
    RAISE EXCEPTION 'FATURA_JA_FECHADA' USING ERRCODE = 'P0001';
  END IF;

  -- O dia do fechamento **conta**: a fatura que fecha em 25 fecha no fim do dia
  -- 25, e uma compra feita naquele dia entra nela (regra 10). Por isso a
  -- comparação é com o dia civil de hoje, e não com um instante.
  IF (now() AT TIME ZONE 'America/Sao_Paulo')::date < v_fechamento THEN
    RAISE EXCEPTION 'FATURA_AINDA_NAO_FECHOU: %', to_char(v_fechamento, 'DD/MM/YYYY')
      USING ERRCODE = 'P0001';
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

-- ---------------------------------------------------------------------------
-- Pagar não antecede comprar
-- ---------------------------------------------------------------------------
-- Mesmo com o fechamento na data certa, resta um caminho: informar uma data de
-- pagamento anterior a alguma compra do ciclo. Antes desta guarda, o desfecho
-- era a violação crua de `compensacao_nao_antecede_competencia` — que a API não
-- traduzia, e o usuário recebia 500.
--
-- A guarda vem **antes** de qualquer escrita, e não como tratamento do erro do
-- banco: o `UPDATE` que grava `settled_at` acontece no fim da função, e deixar
-- a restrição falhar ali significaria descobrir o problema depois de já ter
-- gravado o pagamento na fatura.
CREATE OR REPLACE FUNCTION registrar_pagamento_de_fatura(
  p_tenant UUID, p_fatura UUID, p_valor BIGINT, p_quando TIMESTAMPTZ)
RETURNS estado_de_fatura
LANGUAGE plpgsql AS $$
DECLARE
  v_estado estado_de_fatura; v_total BIGINT; v_pago BIGINT; v_novo estado_de_fatura;
  v_ultima TIMESTAMPTZ;
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

  -- Fatura credora não se paga: o cartão é que deve. Forçar um pagamento aqui
  -- tiraria dinheiro da conta em vez de devolver.
  IF v_total >= 0 THEN
    RAISE EXCEPTION 'FATURA_CREDORA_NAO_SE_PAGA' USING ERRCODE = 'P0001';
  END IF;

  IF p_valor <= 0 THEN
    RAISE EXCEPTION 'PAGAMENTO_TEM_MAGNITUDE_POSITIVA' USING ERRCODE = 'P0001';
  END IF;
  IF v_pago + p_valor > -v_total THEN
    RAISE EXCEPTION 'PAGAMENTO_EXCEDE_A_FATURA' USING ERRCODE = 'P0001';
  END IF;

  -- A data de pagamento vem do servidor, e o futuro é recusado: aceitar
  -- `2099-01-01` derrubaria o saldo de hoje por um fato que não aconteceu.
  IF p_quando > now() THEN
    RAISE EXCEPTION 'PAGAMENTO_NAO_ACONTECE_NO_FUTURO' USING ERRCODE = 'P0001';
  END IF;

  -- E o passado tem um piso: a compra mais recente da fatura. Pagar antes de
  -- comprar não é um estado que o sistema deva conseguir representar.
  SELECT max(posted_at) INTO v_ultima
    FROM lancamentos
   WHERE tenant_id = p_tenant AND fatura_id = p_fatura AND deleted_at IS NULL;

  IF v_ultima IS NOT NULL AND p_quando < v_ultima THEN
    RAISE EXCEPTION 'PAGAMENTO_ANTES_DA_COMPRA: %',
      to_char(v_ultima AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY')
      USING ERRCODE = 'P0001';
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
