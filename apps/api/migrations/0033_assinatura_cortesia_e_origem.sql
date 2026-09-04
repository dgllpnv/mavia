-- 0033 · Tempo concedido pelo operador, e quem escreveu por último
--
-- Ticket 08. Spec v3.2 §8.4 (achados F-12 e F-13), §8.6 (F-15) e Modelo de
-- dados (F-16).
--
-- ## O campo que o webhook sobrescreve
--
-- `periodo_fim` é escrito pelo webhook da Stripe com `coalesce(p_periodo_fim,
-- periodo_fim)` (`0025_assinatura.sql:182`). Um operador que concedesse 60 dias
-- de cortesia empurrando esse campo veria os 60 dias **sumirem na próxima
-- fatura** — sem uma linha de auditoria, porque quem escreveu foi `mavia_auth`,
-- no caminho do webhook, e ninguém compara.
--
-- O cliente veria uma data encolher sozinha na tela dele.
--
-- Daí `cortesia_ate` ser coluna própria, e `periodo_fim` continuar **fora de
-- todo `GRANT`** dos papéis do painel. Escrever no campo que o outro lado é
-- dono de reescrever não é conceder tempo; é escrever um bilhete que vai ser
-- jogado fora.

-- ---------------------------------------------------------------------------
-- 1 · `atualizado_em` por gatilho, não por disciplina (F-16)
-- ---------------------------------------------------------------------------
-- Ela está fora do `GRANT` das rotas, todo caminho existente a escreve, e ela
-- sai na exportação do titular. Sem gatilho, ou a escrita do painel falha na
-- coluna, ou a omite — e a linha exportada ao cliente diz que a assinatura dele
-- não muda desde a última fatura, no dia seguinte a alguém ter trocado o plano.
CREATE FUNCTION tocar_atualizado_em() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.atualizado_em := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2 · As colunas novas
-- ---------------------------------------------------------------------------
ALTER TABLE assinaturas
  -- O tempo concedido pelo operador. Somado na leitura por `fim_efetivo`, e
  -- **jamais** confundido com `periodo_fim`.
  ADD COLUMN cortesia_ate TIMESTAMPTZ,

  -- **Entra agora, mesmo sem o job de reconciliação existir** — e é por isso
  -- que ela entra agora.
  --
  -- O job diário do épico 11 compara `assinaturas` com a Stripe e trata
  -- divergência como incidente, corrigindo **pela Stripe**. Toda escrita
  -- legítima do painel é, por construção, uma divergência. Sem esta coluna, no
  -- dia em que o job existir ele desfaria o ato do operador e mandaria ao
  -- cliente um e-mail dizendo que o acesso dele foi reduzido — por uma mudança
  -- que a Mavia fez e desfez sozinha.
  --
  -- Acrescentá-la depois exigiria **adivinhar a origem das linhas já
  -- escritas**. Por isso ela nasce com as linhas, e não com o job.
  --
  -- O que o job faz com cada origem depende da **DP-39**, que é a única das
  -- cinco decisões comerciais sem padrão vigente.
  ADD COLUMN origem_da_ultima_escrita TEXT NOT NULL DEFAULT 'stripe'
      CHECK (origem_da_ultima_escrita IN ('stripe', 'painel', 'cliente', 'sistema')),

  -- Uma cortesia anterior ao início do período não é cortesia, é engano de
  -- digitação — e um engano que **encurta** o direito do cliente.
  ADD CONSTRAINT cortesia_depois_do_periodo
      CHECK (cortesia_ate IS NULL OR cortesia_ate > periodo_inicio);

CREATE TRIGGER assinaturas_atualizado_em
  BEFORE UPDATE ON assinaturas
  FOR EACH ROW EXECUTE FUNCTION tocar_atualizado_em();

-- ---------------------------------------------------------------------------
-- 3 · Todo caminho que toca `assinaturas` passa a dizer quem foi
-- ---------------------------------------------------------------------------
-- `CREATE OR REPLACE`, e não edição da `0025`: migration é forward-only.
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
         origem_da_ultima_escrita = 'stripe',
         atualizado_em = now()
   WHERE stripe_subscription_id = p_subscription
  RETURNING assinaturas.tenant_id;
END;
$$;

ALTER FUNCTION auth.aplicar_estado_da_assinatura(TEXT, estado_da_assinatura, TIMESTAMPTZ, TIMESTAMPTZ)
  OWNER TO mavia_auth;

GRANT UPDATE (cortesia_ate, origem_da_ultima_escrita) ON assinaturas TO mavia_admin_contrato;
GRANT SELECT (cortesia_ate, origem_da_ultima_escrita) ON assinaturas TO mavia_admin_contrato;
GRANT SELECT (cortesia_ate, origem_da_ultima_escrita) ON assinaturas TO mavia_admin;
GRANT SELECT (cortesia_ate) ON assinaturas TO mavia_app;

-- ---------------------------------------------------------------------------
-- 4 · Prorrogar o teste — operação nomeada, nunca `UPDATE` solto
-- ---------------------------------------------------------------------------
-- `CONTEXT.md:407` e o spec de planos são literais: *"prorrogar é operação
-- nomeada e auditada, **nunca um `UPDATE` solto**"*. Na implementação o fim do
-- teste **é** `periodo_fim` (`0025_assinatura.sql:78-79`), então "adicionar
-- tempo" num tenant em teste seria exatamente o `UPDATE` vetado — achado F-13.
--
-- Teto: **uma vez por Tenant, no máximo sete dias** — o mesmo prazo da DP-15, e
-- não mais que ele. Prorrogar indefinidamente transformaria o teste de sete
-- dias numa assinatura gratuita que ninguém decidiu vender.
--
-- `estado = 'expirada'` é recusado: quem expirou não prorroga teste, contrata.
CREATE FUNCTION admin.prorrogar_teste(
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
    FROM assinaturas WHERE tenant_id = p_alvo;

  IF v_estado IS NULL THEN
    RAISE EXCEPTION 'ASSINATURA_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;
  IF v_estado <> 'teste' THEN
    RAISE EXCEPTION 'ESTADO_NAO_PERMITE_PRORROGACAO' USING ERRCODE = 'P0001';
  END IF;
  -- **Uma vez por Tenant.** A segunda chamada encontra `cortesia_ate` já
  -- preenchida e recusa — sem contador separado, porque um contador seria mais
  -- uma coisa a manter consistente.
  IF v_antes IS NOT NULL THEN
    RAISE EXCEPTION 'TESTE_JA_PRORROGADO' USING ERRCODE = 'P0001';
  END IF;

  UPDATE assinaturas
     SET cortesia_ate = periodo_fim + (p_dias || ' days')::interval,
         origem_da_ultima_escrita = 'painel'
   WHERE tenant_id = p_alvo
  RETURNING cortesia_ate INTO v_fim;

  -- A **segunda linha** do par — a do efeito, com `de → para` (achado F-14).
  -- A primeira, a da intenção, foi gravada por `abrir_espaco_para_escrita`, e
  -- `p_correlacao` é o que liga as duas. `auditoria` não aceita `UPDATE` de
  -- ninguém, então uma linha nunca é completada depois: o `de → para` **precisa**
  -- de uma segunda linha, e a segunda precisa dizer de qual primeira ela é.
  INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, entidade_id,
                         acao, classe, correlacao, de, para)
  VALUES (p_alvo, v_operador, 'operador', 'assinatura', p_alvo,
          'prorrogou_teste', 'escrita_financeira', p_correlacao,
          jsonb_build_object('cortesia_ate', v_antes),
          jsonb_build_object('cortesia_ate', v_fim, 'dias', p_dias, 'razao', p_razao));

  RETURN v_fim;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5 · Conceder cortesia — o tempo que compensa uma indisponibilidade
-- ---------------------------------------------------------------------------
-- Teto: **30 dias por chamada, 60 acumulados** no mesmo período. E `razao`
-- obrigatória, que vai na linha de auditoria: uma cortesia sem motivo escrito
-- é indistinguível de um favor.
CREATE FUNCTION admin.conceder_cortesia(
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
    FROM assinaturas WHERE tenant_id = p_alvo;

  IF v_estado IS NULL THEN
    RAISE EXCEPTION 'ASSINATURA_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;
  IF v_estado NOT IN ('ativa', 'em_atraso', 'cancelada') THEN
    RAISE EXCEPTION 'ESTADO_NAO_PERMITE_CORTESIA' USING ERRCODE = 'P0001';
  END IF;

  -- Acumula sobre a cortesia anterior, não sobre `periodo_fim` — senão duas
  -- chamadas de 30 dias dariam 30, e o operador repetiria a operação achando
  -- que a primeira não pegou.
  v_fim := coalesce(v_antes, v_fim_base) + (p_dias || ' days')::interval;

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
          jsonb_build_object('cortesia_ate', v_antes),
          jsonb_build_object('cortesia_ate', v_fim, 'dias', p_dias, 'razao', p_razao));

  RETURN v_fim;
END;
$$;

ALTER FUNCTION admin.prorrogar_teste(UUID, INT, TEXT, UUID)   OWNER TO mavia_admin_contrato;
ALTER FUNCTION admin.conceder_cortesia(UUID, INT, TEXT, UUID) OWNER TO mavia_admin_contrato;

-- De dentro do papel que passou a ser dono: um `REVOKE` de quem não é mais dono
-- **não falha**, emite `WARNING` e não faz nada — e as funções nasceriam com
-- `EXECUTE` para `PUBLIC`. Ver a mesma armadilha na `0032`.
SET ROLE mavia_admin_contrato;
REVOKE ALL ON FUNCTION admin.prorrogar_teste(UUID, INT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.conceder_cortesia(UUID, INT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.prorrogar_teste(UUID, INT, TEXT, UUID)   TO mavia_admin_escrita;
GRANT EXECUTE ON FUNCTION admin.conceder_cortesia(UUID, INT, TEXT, UUID) TO mavia_admin_escrita;
RESET ROLE;
