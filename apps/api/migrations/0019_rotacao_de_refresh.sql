-- 0019 — Rotação de refresh e detecção de reuso.
--
-- Implementa `docs/produto/spec-autenticacao.md` §4.3, decisão D6. Fecha as
-- pendências P-1 e P-2 na parte que é banco; o access token de 15 minutos vive
-- no Redis e não deixa rastro aqui.
--
-- **Toda função nasce com dono `mavia_auth`, na mesma migration que a cria.**
-- A migration roda como `mavia_migrate`, que tem `BYPASSRLS`: uma função
-- `SECURITY DEFINER` criada por ele executaria com `BYPASSRLS`, e a "função
-- estreita" teria acesso irrestrito à base — anulando em silêncio a garantia
-- inteira do ADR 0004. `mavia_auth` é `NOLOGIN NOBYPASSRLS`.

-- ---------------------------------------------------------------------------
-- O que `mavia_auth` passa a poder
-- ---------------------------------------------------------------------------
-- Até aqui ele só **lia** `sessoes` (0004): resolver o refresh apresentado era
-- a única coisa que precisava fazer antes de saber quem é o usuário. Rotacionar
-- escreve — cria a linha nova e marca a antiga —, e a escrita precisa de
-- permissão de tabela **e** de policy: a RLS está em `FORCE`, e sob ela um
-- `GRANT` sozinho não deixa passar nada.
--
-- As policies são `true` de propósito, e a estreiteza mora noutro lugar: em
-- nenhuma função de `auth` que devolva conjunto. Cada uma recebe um hash exato
-- e devolve no máximo uma linha. Uma conexão comprometida sonda um token por
-- vez; despejar a tabela é impossível.
GRANT INSERT, UPDATE ON sessoes TO mavia_auth;

CREATE POLICY rotacao_cria_sessoes ON sessoes FOR INSERT TO mavia_auth WITH CHECK (true);
CREATE POLICY rotacao_marca_sessoes ON sessoes FOR UPDATE TO mavia_auth
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Rotacionar
-- ---------------------------------------------------------------------------
-- Todo uso do refresh o consome e emite outro. A linha antiga permanece com
-- `revogada_em` e `substituida_por` — **ela é a armadilha**: apresentá-la de
-- novo significa que existem duas cópias do mesmo token no mundo.
--
-- O retorno distingue três desfechos, e a distinção importa:
--
--   `rotacionada` — o caminho normal;
--   `reuso`       — a armadilha disparou, e a família inteira foi revogada;
--   nenhuma linha — token desconhecido ou vencido. Não é incidente: é um
--                   cliente com credencial velha, e ele só precisa entrar de novo.
--
-- Tratar reuso como "token inválido" seria perder o único sinal de roubo de
-- refresh que existe.
CREATE TYPE desfecho_da_rotacao AS ENUM ('rotacionada', 'reuso');

CREATE FUNCTION auth.rotacionar_sessao(
  p_hash_apresentado BYTEA,
  p_hash_novo        BYTEA,
  p_desliza_segundos INTEGER
)
RETURNS TABLE (
  desfecho            desfecho_da_rotacao,
  sessao_id           UUID,
  usuario_id          UUID,
  familia_id          UUID,
  expira_em           TIMESTAMPTZ,
  expira_absoluto_em  TIMESTAMPTZ,
  sessoes_revogadas   UUID[]
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s sessoes; v_nova UUID; v_expira TIMESTAMPTZ; v_revogadas UUID[];
BEGIN
  SELECT * INTO s FROM sessoes WHERE refresh_hash = p_hash_apresentado;

  IF s.id IS NULL THEN
    RETURN;
  END IF;

  -- A armadilha. Um refresh já consumido nas mãos de alguém é roubo até prova
  -- em contrário, e a prova não existe.
  IF s.revogada_em IS NOT NULL THEN
    UPDATE sessoes
       SET revogada_em = coalesce(revogada_em, now()),
           motivo_revogacao = coalesce(motivo_revogacao, 'reuso_de_refresh')
     WHERE sessoes.familia_id = s.familia_id;

    -- Depois do UPDATE, e sem `RETURNING INTO`: a cláusula não cabe num
    -- destino escalar quando o UPDATE toca várias linhas, que é exatamente o
    -- caso de revogar uma família.
    SELECT array_agg(sessoes.id) INTO v_revogadas
      FROM sessoes WHERE sessoes.familia_id = s.familia_id;

    RETURN QUERY SELECT 'reuso'::desfecho_da_rotacao, s.id, s.usuario_id, s.familia_id,
                        s.expira_em, s.expira_absoluto_em, coalesce(v_revogadas, '{}'::uuid[]);
    RETURN;
  END IF;

  -- Vencida pela janela deslizante ou pelo teto absoluto. O teto **nunca** é
  -- estendido: uma sessão renovada indefinidamente é uma sessão eterna.
  IF s.expira_em <= now() OR s.expira_absoluto_em <= now() THEN
    RETURN;
  END IF;

  -- A nova expiração deslizante nunca ultrapassa o teto que já existia.
  v_expira := least(now() + make_interval(secs => p_desliza_segundos), s.expira_absoluto_em);

  INSERT INTO sessoes (usuario_id, familia_id, refresh_hash, geracao, plataforma,
                       dispositivo, ip_hash, user_agent_hash, mfa_verificada_em,
                       expira_em, expira_absoluto_em)
  VALUES (s.usuario_id, s.familia_id, p_hash_novo, s.geracao + 1, s.plataforma,
          s.dispositivo, s.ip_hash, s.user_agent_hash, s.mfa_verificada_em,
          v_expira, s.expira_absoluto_em)
  RETURNING id INTO v_nova;

  UPDATE sessoes
     SET revogada_em = now(),
         motivo_revogacao = 'rotacionada',
         substituida_por = v_nova,
         ultimo_uso_em = now()
   WHERE sessoes.id = s.id;

  RETURN QUERY SELECT 'rotacionada'::desfecho_da_rotacao, v_nova, s.usuario_id, s.familia_id,
                      v_expira, s.expira_absoluto_em, ARRAY[s.id];
END;
$$;

ALTER FUNCTION auth.rotacionar_sessao(BYTEA, BYTEA, INTEGER) OWNER TO mavia_auth;
REVOKE ALL ON FUNCTION auth.rotacionar_sessao(BYTEA, BYTEA, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.rotacionar_sessao(BYTEA, BYTEA, INTEGER) TO mavia_app;

-- ---------------------------------------------------------------------------
-- Revogar
-- ---------------------------------------------------------------------------
-- Devolve os ids revogados para que o chamador apague os access tokens
-- correspondentes no Redis. Sem essa lista, a revogação seria imediata no
-- Postgres e teria até quinze minutos de atraso no Redis — que é exatamente a
-- janela que o token opaco existe para eliminar.
CREATE FUNCTION auth.revogar_sessao(p_hash BYTEA, p_motivo TEXT)
RETURNS TABLE (sessao_id UUID, usuario_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN QUERY
  UPDATE sessoes
     SET revogada_em = now(), motivo_revogacao = p_motivo
   WHERE refresh_hash = p_hash AND revogada_em IS NULL
  RETURNING sessoes.id, sessoes.usuario_id;
END;
$$;

ALTER FUNCTION auth.revogar_sessao(BYTEA, TEXT) OWNER TO mavia_auth;
REVOKE ALL ON FUNCTION auth.revogar_sessao(BYTEA, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.revogar_sessao(BYTEA, TEXT) TO mavia_app;

-- Revoga toda a família de um refresh, menos a linha apresentada. É o
-- "desconectar os outros dispositivos" da matriz de acesso.
CREATE FUNCTION auth.revogar_familia(p_hash_corrente BYTEA, p_motivo TEXT)
RETURNS TABLE (sessao_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_usuario UUID;
BEGIN
  SELECT sessoes.usuario_id INTO v_usuario
    FROM sessoes WHERE refresh_hash = p_hash_corrente AND revogada_em IS NULL;

  IF v_usuario IS NULL THEN RETURN; END IF;

  -- Todas as sessões **do usuário**, e não só da família: "desconectar os
  -- outros" significa os outros dispositivos, que fizeram login próprio e
  -- portanto estão em famílias distintas.
  RETURN QUERY
  UPDATE sessoes
     SET revogada_em = now(), motivo_revogacao = p_motivo
   WHERE sessoes.usuario_id = v_usuario
     AND sessoes.revogada_em IS NULL
     AND sessoes.refresh_hash <> p_hash_corrente
  RETURNING sessoes.id;
END;
$$;

ALTER FUNCTION auth.revogar_familia(BYTEA, TEXT) OWNER TO mavia_auth;
REVOKE ALL ON FUNCTION auth.revogar_familia(BYTEA, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.revogar_familia(BYTEA, TEXT) TO mavia_app;
