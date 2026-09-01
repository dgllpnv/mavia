-- 0005 — Resolução de identidade federada: distinguir login de cadastro.
--
-- Lacuna encontrada implementando, não projetando.
--
-- A migration 0004 entrega `auth.cadastrar_federado`, que insere
-- incondicionalmente — é função de **cadastro**. Mas nada permitia à aplicação
-- descobrir, ao receber o retorno do Google, se aquele `(issuer, subject)` já
-- existe. Sem essa resposta, entrar pela segunda vez com a mesma Conta Google
-- tentava cadastrar de novo e batia na unicidade de e-mail.
--
-- E a consulta não podia ser feita pelo `mavia_app` diretamente: a policy de
-- `identidades_federadas` filtra por `app.usuario_id`, que por definição ainda
-- não existe antes de sabermos quem é o usuário. O ovo e a galinha resolvem-se
-- aqui, numa função estreita, e não afrouxando a policy.

-- ---------------------------------------------------------------------------
-- Resolver identidade
-- ---------------------------------------------------------------------------
-- Somente leitura, e de propósito: registrar o login é escrita e tem outro
-- momento. Uma função de resolução que também escreve não pode ser chamada
-- para *decidir* — ela já teria decidido.
--
-- `email_de_outro_subject` cobre o caso C5 da spec §1.6: o Google devolve um
-- `subject` novo com um e-mail verificado que já pertence a outro `subject` do
-- mesmo provedor. Isso é reatribuição de endereço corporativo — a pessoa por
-- trás do e-mail mudou. A aplicação recusa definitivamente; esta função só
-- entrega o fato, porque a decisão é do domínio e é testável lá.
CREATE FUNCTION auth.resolver_identidade_federada(p_issuer TEXT, p_subject TEXT, p_email TEXT)
RETURNS TABLE (
  usuario_id             UUID,
  email                  TEXT,
  mfa_ativo              BOOLEAN,
  email_de_outro_subject BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_usuario UUID; v_email TEXT; v_mfa BOOLEAN; v_conflito BOOLEAN;
BEGIN
  SELECT i.usuario_id, u.email, u.mfa_ativado_em IS NOT NULL
    INTO v_usuario, v_email, v_mfa
    FROM identidades_federadas i
    JOIN usuarios u ON u.id = i.usuario_id
   WHERE i.provedor = 'google'
     AND i.issuer   = p_issuer
     AND i.subject  = p_subject
     AND u.deleted_at IS NULL;

  SELECT EXISTS (
    SELECT 1 FROM identidades_federadas i
     WHERE i.provedor = 'google'
       AND i.issuer   = p_issuer
       AND lower(i.email_no_provedor) = lower(p_email)
       AND i.subject <> p_subject
  ) INTO v_conflito;

  -- Devolve sempre uma linha: "não achei" é resposta, não ausência de resposta.
  -- Ausência obrigaria o chamador a distinguir "sem identidade" de "sem
  -- conflito", e é aí que nasce o `if` esquecido.
  RETURN QUERY SELECT v_usuario, v_email, coalesce(v_mfa, FALSE), v_conflito;
END;
$$;

-- ---------------------------------------------------------------------------
-- Registrar o login
-- ---------------------------------------------------------------------------
-- Escrita, separada da leitura. Atualiza o carimbo e a dica de e-mail — que
-- muda no provedor e nunca é chave (spec §1.3).
CREATE FUNCTION auth.registrar_login_federado(p_issuer TEXT, p_subject TEXT, p_email TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_afetadas INTEGER;
BEGIN
  UPDATE identidades_federadas
     SET ultimo_login_em   = now(),
         email_no_provedor = p_email
   WHERE provedor = 'google' AND issuer = p_issuer AND subject = p_subject;

  GET DIAGNOSTICS v_afetadas = ROW_COUNT;

  UPDATE usuarios u
     SET ultimo_acesso_em = now()
    FROM identidades_federadas i
   WHERE i.usuario_id = u.id
     AND i.provedor = 'google' AND i.issuer = p_issuer AND i.subject = p_subject;

  RETURN v_afetadas > 0;
END;
$$;

-- `UPDATE` em identidades_federadas não estava concedido: a 0004 previa só
-- SELECT e INSERT, porque registrar login não existia como operação.
GRANT UPDATE ON identidades_federadas TO mavia_auth;

-- E o GRANT sozinho não basta: sob RLS forçada, privilégio sem policy que
-- cubra o comando resulta em **zero linhas afetadas, sem erro**. A 0004 criou
-- policies só para SELECT (`r`) e INSERT (`a`). Sem esta, `registrar_login`
-- devolveria `false` para sempre e ninguém saberia por quê.
CREATE POLICY cadastro_atualiza_identidades ON identidades_federadas
  FOR UPDATE TO mavia_auth
  USING (true) WITH CHECK (true);

ALTER FUNCTION auth.resolver_identidade_federada(TEXT, TEXT, TEXT) OWNER TO mavia_auth;
ALTER FUNCTION auth.registrar_login_federado(TEXT, TEXT, TEXT)     OWNER TO mavia_auth;

REVOKE ALL ON FUNCTION auth.resolver_identidade_federada(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.registrar_login_federado(TEXT, TEXT, TEXT)     FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth.resolver_identidade_federada(TEXT, TEXT, TEXT) TO mavia_app;
GRANT EXECUTE ON FUNCTION auth.registrar_login_federado(TEXT, TEXT, TEXT)     TO mavia_app;
