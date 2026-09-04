-- 0035 · As correções do parecer financeiro sobre o código
--
-- O validador revisou a implementação dos tickets 07, 08 e 11 e encontrou doze
-- defeitos, seis deles bloqueantes. Esta migration fecha os que são de banco.
--
-- ## O erro de método que produziu três deles
--
-- Eu reimplementei a máquina de estados da assinatura **em SQL**, com um
-- `CASE`. O ticket 07 dizia, por escrito, para não fazer isso — e a cópia
-- divergiu do original em exatamente um ponto, que é o suficiente:
--
--   `transicao('expirada', 'pagamento_recuperado')` é **`null`** no domínio
--   (`packages/domain/src/catalogo.ts`), e o meu `CASE` produzia `ativa`.
--
-- A consequência, com números: tenant `expirada` desde 10/06, `periodo_fim` em
-- 10/06. O operador registra um Pix de **R$ 79,00**. A função grava
-- `estado = 'ativa'` e **não pode** tocar `periodo_fim` — o campo está fora de
-- todo `GRANT`, de propósito. Resultado: `podeEscrever` verdadeiro para sempre,
-- com o período pago encerrado há três meses. Setenta e nove reais compraram
-- acesso indefinido.
--
-- E eu escrevi um **teste que consagrava o defeito** ("quem expirou reativa").
-- Uma suíte verde não prova que o comportamento está certo; prova que ele é o
-- que alguém escreveu que deveria ser.

-- ---------------------------------------------------------------------------
-- 1 · A idempotência: o `meio` sai da chave (FC-6)
-- ---------------------------------------------------------------------------
-- Um Pix chega no extrato de alguns bancos como "transferência", e a lista da
-- tela tem os dois. Com o `meio` na chave, o **mesmo** end-to-end id entra duas
-- vezes sob rótulos diferentes: R$ 158,00 escriturados sobre R$ 79,00
-- recebidos, e as duas linhas saem ao cliente na exportação.
--
-- O comprovante identifica o pagamento; o rótulo que alguém escolheu para ele
-- não faz parte da identidade.
DROP INDEX pagamento_manual_unico;
CREATE UNIQUE INDEX pagamento_manual_unico
  ON pagamentos_manuais (tenant_id, referencia_externa)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2 · Uma baixa errada precisa ter correção (FC-5)
-- ---------------------------------------------------------------------------
-- O comentário da coluna prometia *"marca estorno de baixa registrada por
-- engano"* e **nenhum papel tinha `UPDATE`**. O operador digita `790000` no
-- lugar de `7900` e a escrituração fica R$ 7.821,00 errada por cinco anos —
-- com o índice único impedindo até reinserir a referência certa.
--
-- É o `Estorno` do glossário aplicado ao dinheiro da Mavia: o fato aconteceu e
-- depois foi desfeito, e os dois ficam registrados.
GRANT UPDATE (deleted_at) ON pagamentos_manuais TO mavia_admin_contrato;

CREATE FUNCTION admin.estornar_baixa(
  p_pagamento  UUID,
  p_razao      TEXT,
  p_correlacao UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE
  v_operador UUID := nullif(current_setting('app.usuario_id', true), '')::uuid;
  v_tenant   UUID;
  v_valor    BIGINT;
BEGIN
  IF v_operador IS NULL OR NOT admin.tem_concessao_ativa() THEN
    RAISE EXCEPTION 'SEM_CONCESSAO_DE_ADMIN' USING ERRCODE = 'P0001';
  END IF;
  IF length(btrim(coalesce(p_razao, ''))) < 3 THEN
    RAISE EXCEPTION 'RAZAO_AUSENTE' USING ERRCODE = 'P0001';
  END IF;

  UPDATE pagamentos_manuais SET deleted_at = now()
   WHERE id = p_pagamento AND deleted_at IS NULL
  RETURNING tenant_id, valor_centavos INTO v_tenant, v_valor;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'BAIXA_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;

  -- **O estado da assinatura não é revertido**, e é decisão.
  --
  -- Reverter seria uma segunda transição, e ela precisa do mesmo par
  -- `de → para` conferido que a primeira tem: entre a baixa e o estorno o
  -- webhook pode ter movido o contrato, e desfazer às cegas produziria o
  -- defeito que esta migration está corrigindo, do outro lado.
  --
  -- Quem estornou a baixa decide o estado no ato seguinte, com o registro dele.
  INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, entidade_id,
                         acao, classe, correlacao, de, para)
  VALUES (v_tenant, v_operador, 'operador', 'pagamento_manual', p_pagamento,
          'estornou_baixa', 'escrita_financeira', p_correlacao,
          jsonb_build_object('valor_centavos', v_valor, 'ativo', true),
          jsonb_build_object('ativo', false,
                             'razao_hash', encode(sha256(convert_to(p_razao, 'UTF8')), 'hex'),
                             'razao_comprimento', length(p_razao)));
END;
$$;

ALTER FUNCTION admin.estornar_baixa(UUID, TEXT, UUID) OWNER TO mavia_admin_contrato;

-- ---------------------------------------------------------------------------
-- 3 · A baixa deixa de reimplementar a máquina de estados (FC-1, FC-8, FC-7)
-- ---------------------------------------------------------------------------
-- ⚠️ **`CREATE OR REPLACE` exige ser dono, e `mavia_migrate` não é mais.**
--
-- As três funções abaixo pertencem a `mavia_admin_contrato` desde a `0033` e a
-- `0034`. Substituí-las como `mavia_migrate` responde *"must be owner of
-- function"* — que é a terceira aparição da mesma armadilha nesta base: quem
-- transfere a posse perde o direito de mexer no objeto, e o `GRANT`/`REVOKE`
-- dele passa a falhar (em silêncio, no caso do `REVOKE`).
SET ROLE mavia_admin_contrato;

CREATE OR REPLACE FUNCTION admin.registrar_pagamento(
  p_alvo        UUID,
  p_centavos    BIGINT,
  p_meio        meio_de_pagamento,
  p_referencia  TEXT,
  p_recebido_em TIMESTAMPTZ,
  p_observacao  TEXT,
  p_correlacao  UUID
) RETURNS TABLE (id_do_pagamento UUID, estado_novo TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE
  v_operador UUID := nullif(current_setting('app.usuario_id', true), '')::uuid;
  v_estado   TEXT;
  v_novo     TEXT;
  v_id       UUID;
  v_linhas   INT;
BEGIN
  IF v_operador IS NULL OR NOT admin.tem_concessao_ativa() THEN
    RAISE EXCEPTION 'SEM_CONCESSAO_DE_ADMIN' USING ERRCODE = 'P0001';
  END IF;
  IF p_centavos IS NULL OR p_centavos <= 0 THEN
    RAISE EXCEPTION 'VALOR_INVALIDO' USING ERRCODE = 'P0001';
  END IF;
  IF p_recebido_em IS NULL OR p_recebido_em > now() THEN
    RAISE EXCEPTION 'RECEBIMENTO_NO_FUTURO' USING ERRCODE = 'P0001';
  END IF;

  -- **`FOR UPDATE`** — achado FC-7. Sem ele, um webhook de cancelamento
  -- chegando entre o `SELECT` e o `UPDATE` faz a função sobrescrever
  -- `cancelada` com `ativa`, e gravar um `de` que nunca foi o estado no
  -- instante da escrita.
  SELECT estado::text INTO v_estado
    FROM assinaturas WHERE tenant_id = p_alvo FOR UPDATE;

  IF v_estado IS NULL THEN
    RAISE EXCEPTION 'ASSINATURA_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;

  -- **Só a transição que o domínio permite para "o dinheiro chegou".**
  --
  --   `transicao('em_atraso', 'pagamento_recuperado') = 'ativa'`  → aplica
  --   `transicao('expirada',  'pagamento_recuperado') = null`     → recusa
  --   `transicao('teste',     'pagamento_recuperado') = null`     → recusa
  --   `transicao('cancelada', 'pagamento_recuperado') = null`     → recusa
  --
  -- `ativa` é o único caso em que registrar sem mover o contrato é honesto: o
  -- cliente pagou em dia, por fora, e não há transição a fazer.
  --
  -- Recusar os outros três é melhor que aceitar: **registrar dinheiro que não
  -- muda contrato nenhum é pior do que recusar** — o cliente em teste que paga
  -- e continua em teste expira tendo pago (FC-8), e o expirado que "reativa"
  -- ganha acesso sem período pago (FC-1).
  IF v_estado = 'em_atraso' THEN
    v_novo := 'ativa';
  ELSIF v_estado = 'ativa' THEN
    v_novo := 'ativa';
  ELSE
    RAISE EXCEPTION 'ESTADO_NAO_PERMITE_BAIXA' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO pagamentos_manuais (tenant_id, registrado_por, recebido_em,
                                  valor_centavos, moeda, meio, referencia_externa,
                                  observacao)
  VALUES (p_alvo, v_operador, p_recebido_em, p_centavos, 'BRL', p_meio,
          p_referencia, nullif(btrim(coalesce(p_observacao, '')), ''))
  RETURNING id INTO v_id;

  IF v_novo <> v_estado THEN
    -- `AND estado = v_estado`: a escrita só vale se o estado for o mesmo que a
    -- decisão leu. Com `FOR UPDATE` acima isto é cinto e suspensório, e é o que
    -- garante que o `de` da auditoria é o estado do instante da escrita.
    UPDATE assinaturas
       SET estado = v_novo::estado_da_assinatura,
           graca_ate = NULL,
           origem_da_ultima_escrita = 'painel'
     WHERE tenant_id = p_alvo AND estado = v_estado::estado_da_assinatura;

    GET DIAGNOSTICS v_linhas = ROW_COUNT;
    IF v_linhas = 0 THEN
      RAISE EXCEPTION 'TRANSICAO_OBSOLETA' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    -- Mesmo sem mudar o estado, a origem é marcada: o critério do ticket é que
    -- **toda** escrita do painel diga quem a fez, e o caminho de quem paga em
    -- dia por Pix é o mais comum de todos (FC-11, irmã menor).
    UPDATE assinaturas SET origem_da_ultima_escrita = 'painel'
     WHERE tenant_id = p_alvo;
  END IF;

  -- **`referencia_externa` entra hasheada.** É o end-to-end id do Pix do
  -- titular, que a política classifica como dado pessoal. Em claro na
  -- `auditoria`, o mesmo identificador passaria a existir sob duas políticas de
  -- retenção diferentes — cinco anos fiscais aqui, outro regime lá (FC-9).
  --
  -- Estado, valor e moeda **continuam em claro**, e isso está autorizado por
  -- escrito: a política diz "em claro apenas quando o valor é o objeto da
  -- mudança", e dar baixa em pagamento é exatamente esse caso.
  INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, entidade_id,
                         acao, classe, correlacao, de, para)
  VALUES (p_alvo, v_operador, 'operador', 'pagamento_manual', v_id,
          'deu_baixa', 'escrita_financeira', p_correlacao,
          jsonb_build_object('estado', v_estado),
          jsonb_build_object('estado', v_novo, 'valor_centavos', p_centavos,
                             'moeda', 'BRL', 'meio', p_meio,
                             'referencia_sha256',
                             encode(sha256(convert_to(p_referencia, 'UTF8')), 'hex')));

  RETURN QUERY SELECT v_id, v_novo;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4 · A cortesia acumula sobre o fim **efetivo** (FC-2)
-- ---------------------------------------------------------------------------
-- O defeito, com datas: cortesia de 5 dias em 15/jan põe `cortesia_ate` em
-- 15/02. A fatura de 10/fev empurra `periodo_fim` para 10/03 e a cortesia fica
-- **obsoleta**. Em 20/fev o operador concede 10 dias: a base era `cortesia_ate`
-- (15/02), o novo valor vira 25/02, e o fim efetivo — que é `greatest` — segue
-- 10/03.
--
-- **O cliente recebeu zero dos dez dias, e as três evidências dizem que
-- recebeu:** a resposta da rota, a coluna, e a linha de auditoria.
--
-- A base passa a ser o fim efetivo, que é a mesma regra que a leitura usa.
CREATE OR REPLACE FUNCTION admin.conceder_cortesia(
  p_alvo       UUID,
  p_dias       INT,
  p_razao      TEXT,
  p_correlacao UUID
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE
  v_operador UUID := nullif(current_setting('app.usuario_id', true), '')::uuid;
  v_estado   TEXT;
  v_fim_base TIMESTAMPTZ;
  v_antes    TIMESTAMPTZ;
  v_efetivo  TIMESTAMPTZ;
  v_fim      TIMESTAMPTZ;
BEGIN
  IF v_operador IS NULL OR NOT admin.tem_concessao_ativa() THEN
    RAISE EXCEPTION 'SEM_CONCESSAO_DE_ADMIN' USING ERRCODE = 'P0001';
  END IF;
  IF p_dias IS NULL OR p_dias < 1 OR p_dias > 30 THEN
    RAISE EXCEPTION 'CORTESIA_ALEM_DO_TETO' USING ERRCODE = 'P0001';
  END IF;
  IF length(btrim(coalesce(p_razao, ''))) < 3 THEN
    RAISE EXCEPTION 'RAZAO_AUSENTE' USING ERRCODE = 'P0001';
  END IF;

  SELECT estado::text, periodo_fim, cortesia_ate
    INTO v_estado, v_fim_base, v_antes
    FROM assinaturas WHERE tenant_id = p_alvo FOR UPDATE;

  IF v_estado IS NULL THEN
    RAISE EXCEPTION 'ASSINATURA_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;
  IF v_estado NOT IN ('ativa', 'em_atraso', 'cancelada') THEN
    RAISE EXCEPTION 'ESTADO_NAO_PERMITE_CORTESIA' USING ERRCODE = 'P0001';
  END IF;

  -- A mesma regra que `fimEfetivo` usa na leitura. Duas regras diferentes para
  -- a mesma pergunta é como a cortesia passou a valer zero.
  v_efetivo := greatest(v_fim_base, coalesce(v_antes, v_fim_base));
  v_fim := v_efetivo + (p_dias || ' days')::interval;

  IF v_fim > v_fim_base + INTERVAL '60 days' THEN
    RAISE EXCEPTION 'CORTESIA_ACUMULADA_ALEM_DO_TETO' USING ERRCODE = 'P0001';
  END IF;

  UPDATE assinaturas
     SET cortesia_ate = v_fim, origem_da_ultima_escrita = 'painel'
   WHERE tenant_id = p_alvo;

  INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, entidade_id,
                         acao, classe, correlacao, de, para)
  VALUES (p_alvo, v_operador, 'operador', 'assinatura', p_alvo,
          'concedeu_cortesia', 'escrita_financeira', p_correlacao,
          jsonb_build_object('cortesia_ate', v_antes, 'fim_efetivo', v_efetivo),
          jsonb_build_object('cortesia_ate', v_fim, 'dias', p_dias,
                             'razao_hash', encode(sha256(convert_to(p_razao, 'UTF8')), 'hex'),
                             'razao_comprimento', length(p_razao)));

  RETURN v_fim;
END;
$$;

-- A prorrogação do teste ganha `FOR UPDATE` e a razão hasheada, pelas mesmas
-- razões. A base dela é `periodo_fim` e não muda: em teste não há renovação.
CREATE OR REPLACE FUNCTION admin.prorrogar_teste(
  p_alvo       UUID,
  p_dias       INT,
  p_razao      TEXT,
  p_correlacao UUID
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE
  v_operador UUID := nullif(current_setting('app.usuario_id', true), '')::uuid;
  v_estado   TEXT;
  v_antes    TIMESTAMPTZ;
  v_fim      TIMESTAMPTZ;
BEGIN
  IF v_operador IS NULL OR NOT admin.tem_concessao_ativa() THEN
    RAISE EXCEPTION 'SEM_CONCESSAO_DE_ADMIN' USING ERRCODE = 'P0001';
  END IF;
  IF p_dias IS NULL OR p_dias < 1 OR p_dias > 7 THEN
    RAISE EXCEPTION 'PRORROGACAO_ALEM_DO_TETO' USING ERRCODE = 'P0001';
  END IF;
  IF length(btrim(coalesce(p_razao, ''))) < 3 THEN
    RAISE EXCEPTION 'RAZAO_AUSENTE' USING ERRCODE = 'P0001';
  END IF;

  SELECT estado::text, cortesia_ate INTO v_estado, v_antes
    FROM assinaturas WHERE tenant_id = p_alvo FOR UPDATE;

  IF v_estado IS NULL THEN
    RAISE EXCEPTION 'ASSINATURA_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;
  IF v_estado <> 'teste' THEN
    RAISE EXCEPTION 'ESTADO_NAO_PERMITE_PRORROGACAO' USING ERRCODE = 'P0001';
  END IF;
  IF v_antes IS NOT NULL THEN
    RAISE EXCEPTION 'TESTE_JA_PRORROGADO' USING ERRCODE = 'P0001';
  END IF;

  UPDATE assinaturas
     SET cortesia_ate = periodo_fim + (p_dias || ' days')::interval,
         origem_da_ultima_escrita = 'painel'
   WHERE tenant_id = p_alvo
  RETURNING cortesia_ate INTO v_fim;

  INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, entidade_id,
                         acao, classe, correlacao, de, para)
  VALUES (p_alvo, v_operador, 'operador', 'assinatura', p_alvo,
          'prorrogou_teste', 'escrita_financeira', p_correlacao,
          jsonb_build_object('cortesia_ate', v_antes),
          jsonb_build_object('cortesia_ate', v_fim, 'dias', p_dias,
                             'razao_hash', encode(sha256(convert_to(p_razao, 'UTF8')), 'hex'),
                             'razao_comprimento', length(p_razao)));

  RETURN v_fim;
END;
$$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- 5 · O webhook limpa a cortesia que ele consumiu (FC-2, segunda metade)
-- ---------------------------------------------------------------------------
-- Quando a fatura empurra `periodo_fim` para além da cortesia, ela foi
-- consumida — e deixá-la lá faz a próxima concessão partir de uma data morta.
-- É a única leitura honesta de "a cortesia acabou".
-- De dentro de `mavia_auth`, pela mesma razão.
SET ROLE mavia_auth;

CREATE OR REPLACE FUNCTION auth.aplicar_estado_da_assinatura(
  p_subscription TEXT,
  p_estado estado_da_assinatura,
  p_graca_ate TIMESTAMPTZ,
  p_periodo_fim TIMESTAMPTZ
)
RETURNS TABLE (id_do_tenant UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN QUERY
  UPDATE assinaturas
     SET estado = p_estado,
         graca_ate = CASE WHEN p_estado = 'em_atraso' THEN p_graca_ate END,
         periodo_fim = coalesce(p_periodo_fim, periodo_fim),
         cortesia_ate = CASE
           WHEN cortesia_ate IS NOT NULL
            AND cortesia_ate <= coalesce(p_periodo_fim, periodo_fim) THEN NULL
           ELSE cortesia_ate
         END,
         origem_da_ultima_escrita = 'stripe',
         atualizado_em = now()
   WHERE stripe_subscription_id = p_subscription
  RETURNING assinaturas.tenant_id;
END;
$$;

RESET ROLE;

SET ROLE mavia_admin_contrato;
REVOKE ALL ON FUNCTION admin.estornar_baixa(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.estornar_baixa(UUID, TEXT, UUID) TO mavia_admin_escrita;
RESET ROLE;
