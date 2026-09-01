-- 0004 — O caminho de cadastro.
--
-- Fecha a lacuna registrada no fim de apps/api/test/rls.test.ts.
--
-- A decisão que esta migration materializa: `mavia_app` NÃO recebe INSERT em
-- `tenants`. Ele recebe EXECUTE em funções estreitas, de propriedade de um
-- papel que não tem BYPASSRLS, e que impõem no BANCO os invariantes que a
-- aplicação não pode ser a única a lembrar:
--   (a) tenant nunca nasce sem proprietário;
--   (b) tenant nunca nasce de um e-mail não provado;
--   (c) o teto de tenants por usuário existe mesmo se um guard falhar.

-- ---------------------------------------------------------------------------
-- O papel dono das funções
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mavia_auth') THEN
    CREATE ROLE mavia_auth NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- mavia_migrate precisa ser membro de mavia_auth para poder transferir a
-- propriedade das funções. Sem a transferência, elas nasceriam pertencendo a
-- mavia_migrate — que TEM BYPASSRLS — e cada SECURITY DEFINER viraria um
-- buraco irrestrito na RLS. Este é o detalhe que anularia a migration inteira
-- em silêncio.
GRANT mavia_auth TO mavia_migrate;

CREATE SCHEMA auth;
-- O esquema pertence a `mavia_auth`, e não a quem roda a migration. Não é
-- estética: `ALTER FUNCTION … OWNER TO mavia_auth` exige que o novo dono tenha
-- CREATE no esquema que contém a função — sem isto, a transferência de
-- propriedade abaixo falha com "permission denied for schema auth", e a
-- tentação seria removê-la, que é exatamente o erro que ela existe para evitar.
-- `mavia_migrate` continua podendo criar aqui por ser membro de `mavia_auth`.
ALTER SCHEMA auth OWNER TO mavia_auth;
GRANT USAGE ON SCHEMA auth TO mavia_app;

-- ---------------------------------------------------------------------------
-- Policies para mavia_auth
-- ---------------------------------------------------------------------------
-- Policies são por papel (cláusula TO). mavia_auth NÃO é dono das tabelas,
-- então o FORCE de 0001 não se aplica a ele e a RLS comum vale: o que ele pode
-- é exatamente o que estas policies dizem, e nada mais.
--
-- O `USING (true)` não é frouxidão: a contenção deste caminho é a SUPERFÍCIE
-- DAS FUNÇÕES — nenhuma devolve conjunto, nenhuma aceita lista, mavia_auth é
-- NOLOGIN e ninguém mais tem EXECUTE. Amarrar as policies a um GUC seria pior:
-- o GUC é definível por quem chama.
CREATE POLICY cadastro_le_usuarios   ON usuarios        FOR SELECT TO mavia_auth USING (true);
CREATE POLICY cadastro_cria_usuarios ON usuarios        FOR INSERT TO mavia_auth WITH CHECK (true);
CREATE POLICY cadastro_atualiza_usuarios ON usuarios    FOR UPDATE TO mavia_auth
  USING (true) WITH CHECK (true);

CREATE POLICY cadastro_le_tenants    ON tenants         FOR SELECT TO mavia_auth USING (true);
CREATE POLICY cadastro_cria_tenants  ON tenants         FOR INSERT TO mavia_auth WITH CHECK (true);

CREATE POLICY cadastro_le_vinculos   ON tenant_usuarios FOR SELECT TO mavia_auth USING (true);
CREATE POLICY cadastro_cria_vinculos ON tenant_usuarios FOR INSERT TO mavia_auth WITH CHECK (true);

CREATE POLICY cadastro_le_sessoes    ON sessoes         FOR SELECT TO mavia_auth USING (true);
CREATE POLICY cadastro_le_identidades ON identidades_federadas FOR SELECT TO mavia_auth USING (true);
CREATE POLICY cadastro_cria_identidades ON identidades_federadas FOR INSERT TO mavia_auth WITH CHECK (true);
CREATE POLICY cadastro_opera_pendentes ON cadastros_pendentes FOR ALL TO mavia_auth
  USING (true) WITH CHECK (true);
CREATE POLICY cadastro_opera_recuperacoes ON recuperacoes_senha FOR ALL TO mavia_auth
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON usuarios              TO mavia_auth;
GRANT SELECT, INSERT         ON tenants               TO mavia_auth;
GRANT SELECT, INSERT         ON tenant_usuarios       TO mavia_auth;
GRANT SELECT                 ON sessoes               TO mavia_auth;
GRANT SELECT, INSERT         ON identidades_federadas TO mavia_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON cadastros_pendentes TO mavia_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON recuperacoes_senha  TO mavia_auth;

-- ---------------------------------------------------------------------------
-- Funções — nenhuma devolve conjunto
-- ---------------------------------------------------------------------------
-- `SET search_path = pg_catalog, public` em TODAS: sem isso, quem controla o
-- search_path da sessão redireciona uma chamada de dentro da função para um
-- objeto que ele mesmo criou, e SECURITY DEFINER vira escalada de privilégio.

CREATE FUNCTION auth.buscar_credencial(p_email TEXT)
RETURNS TABLE (usuario_id UUID, senha_hash TEXT, mfa_ativo BOOLEAN, tem_identidade BOOLEAN)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.senha_hash, u.mfa_ativado_em IS NOT NULL,
         EXISTS (SELECT 1 FROM identidades_federadas i WHERE i.usuario_id = u.id)
    FROM usuarios u
   WHERE lower(u.email) = lower(p_email) AND u.deleted_at IS NULL
   LIMIT 1;
$$;

-- Entrada é o hash exato do refresh apresentado. Não existe assinatura que
-- aceite usuario_id: com ela, um bug de aplicação listaria as sessões alheias.
CREATE FUNCTION auth.resolver_sessao(p_refresh_hash BYTEA)
RETURNS TABLE (sessao_id UUID, usuario_id UUID, familia_id UUID, geracao INTEGER,
               expira_em TIMESTAMPTZ, expira_absoluto_em TIMESTAMPTZ,
               revogada_em TIMESTAMPTZ, mfa_verificada_em TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.usuario_id, s.familia_id, s.geracao, s.expira_em,
         s.expira_absoluto_em, s.revogada_em, s.mfa_verificada_em
    FROM sessoes s
   WHERE s.refresh_hash = p_refresh_hash
   LIMIT 1;
$$;

-- `POST /auth/registrar`. Não cria usuário, não cria tenant: é a camada 1 do
-- teto de §6.3. Devolve `false` quando o endereço já é de um usuário — e a
-- rota responde EXATAMENTE a mesma coisa nos dois casos (A-13).
CREATE FUNCTION auth.registrar_pendente(
  p_email TEXT, p_nome TEXT, p_senha_hash TEXT, p_token_hash BYTEA, p_expira_em TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM usuarios u
              WHERE lower(u.email) = lower(p_email) AND u.deleted_at IS NULL) THEN
    RETURN FALSE;
  END IF;

  -- Reemitir para o mesmo endereço substitui o pendente anterior em vez de
  -- acumular: mil requisições geram um registro e um e-mail, não mil.
  DELETE FROM cadastros_pendentes
   WHERE lower(email) = lower(p_email) AND consumido_em IS NULL;

  INSERT INTO cadastros_pendentes (email, nome, senha_hash, token_hash, expira_em)
  VALUES (p_email, p_nome, p_senha_hash, p_token_hash, p_expira_em);
  RETURN TRUE;
END;
$$;

-- `POST /auth/senha/recuperar`. A regra D5 mora AQUI, e não na aplicação:
-- conta sem `senha_hash` não recebe token, ponto. É a trava que impede que a
-- recuperação vire a porta dos fundos da recusa de vinculação de C5 (§1.6).
CREATE FUNCTION auth.emitir_recuperacao(
  p_email TEXT, p_token_hash BYTEA, p_expira_em TIMESTAMPTZ, p_ip_hash BYTEA)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_usuario UUID; v_vivos INTEGER;
BEGIN
  SELECT u.id INTO v_usuario FROM usuarios u
   WHERE lower(u.email) = lower(p_email)
     AND u.deleted_at IS NULL
     AND u.senha_hash IS NOT NULL;     -- D5
  IF NOT FOUND THEN RETURN FALSE; END IF;

  SELECT count(*) INTO v_vivos FROM recuperacoes_senha r
   WHERE r.usuario_id = v_usuario AND r.consumido_em IS NULL AND r.expira_em > now();
  IF v_vivos >= 3 THEN RETURN FALSE; END IF;

  INSERT INTO recuperacoes_senha (usuario_id, token_hash, expira_em, ip_hash)
  VALUES (v_usuario, p_token_hash, p_expira_em, p_ip_hash);
  RETURN TRUE;
END;
$$;

-- Consome o token e escreve a senha nova na mesma transação. A verificação de
-- MFA (§3.4) acontece ANTES, na aplicação, sob app.usuario_id devolvido por
-- auth.resolver_recuperacao — e é por isso que esta função recebe o token de
-- novo: ela não confia no que a aplicação lembrou entre as duas chamadas.
CREATE FUNCTION auth.concluir_recuperacao(p_token_hash BYTEA, p_senha_hash TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_usuario UUID;
BEGIN
  UPDATE recuperacoes_senha SET consumido_em = now()
   WHERE token_hash = p_token_hash AND consumido_em IS NULL AND expira_em > now()
   RETURNING usuario_id INTO v_usuario;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECUPERACAO_INVALIDA' USING ERRCODE = 'P0001';
  END IF;

  UPDATE usuarios SET senha_hash = p_senha_hash, senha_atualizada_em = now()
   WHERE id = v_usuario AND senha_hash IS NOT NULL;   -- D5, de novo, na escrita
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTA_SEM_SENHA' USING ERRCODE = 'P0001';
  END IF;

  -- Os demais tokens do usuário morrem junto. A revogação das SESSÕES é da
  -- aplicação, sob a policy de app.usuario_id.
  UPDATE recuperacoes_senha SET consumido_em = now()
   WHERE usuario_id = v_usuario AND consumido_em IS NULL;

  RETURN v_usuario;
END;
$$;

-- O fluxo de recuperação é pré-autenticação por definição. Esta função é o que
-- devolve o usuario_id que a aplicação usará no `SET LOCAL app.usuario_id` das
-- etapas seguintes — inclusive a leitura de mfa_codigos_recuperacao, que vive
-- sob policy de app.usuario_id.
CREATE FUNCTION auth.resolver_recuperacao(p_token_hash BYTEA)
RETURNS TABLE (recuperacao_id UUID, usuario_id UUID, expira_em TIMESTAMPTZ,
               consumido_em TIMESTAMPTZ, mfa_ativo BOOLEAN)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT r.id, r.usuario_id, r.expira_em, r.consumido_em,
         u.mfa_ativado_em IS NOT NULL
    FROM recuperacoes_senha r
    JOIN usuarios u ON u.id = r.usuario_id
   WHERE r.token_hash = p_token_hash
   LIMIT 1;
$$;

-- O clique no link de confirmação. Usuário, tenant e vínculo numa transação.
CREATE FUNCTION auth.confirmar_cadastro(p_token_hash BYTEA, p_nome_do_tenant TEXT)
RETURNS TABLE (usuario_id UUID, tenant_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_pendente cadastros_pendentes%ROWTYPE;
  v_usuario  UUID;
  v_tenant   UUID;
BEGIN
  -- FOR UPDATE: dois cliques simultâneos no mesmo link criariam dois tenants.
  SELECT * INTO v_pendente FROM cadastros_pendentes
   WHERE token_hash = p_token_hash AND consumido_em IS NULL AND expira_em > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CADASTRO_INVALIDO' USING ERRCODE = 'P0001';
  END IF;

  -- email_verificado_em nasce preenchido: só chega aqui quem clicou no link.
  INSERT INTO usuarios (email, nome, senha_hash, senha_atualizada_em, email_verificado_em)
  VALUES (v_pendente.email, v_pendente.nome, v_pendente.senha_hash, now(), now())
  RETURNING id INTO v_usuario;

  INSERT INTO tenants (nome) VALUES (p_nome_do_tenant) RETURNING id INTO v_tenant;

  -- Na mesma transação: um tenant nunca existe sem proprietário.
  INSERT INTO tenant_usuarios (tenant_id, usuario_id, papel)
  VALUES (v_tenant, v_usuario, 'proprietario');

  UPDATE cadastros_pendentes SET consumido_em = now() WHERE id = v_pendente.id;

  RETURN QUERY SELECT v_usuario, v_tenant;
END;
$$;

-- Cadastro por Google. Só é chamada no caso C3 da matriz de §2.4 — a decisão
-- de QUAL caso é este é pura e mora em packages/domain/identidade (§8.4).
-- O UNIQUE de (provedor, issuer, subject) e o de lower(email) são o que faz a
-- corrida entre duas requisições simultâneas falhar fechada, e não duplicar.
CREATE FUNCTION auth.cadastrar_federado(
  p_issuer TEXT, p_subject TEXT, p_email TEXT, p_nome TEXT, p_nome_do_tenant TEXT)
RETURNS TABLE (usuario_id UUID, tenant_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_usuario UUID; v_tenant UUID;
BEGIN
  INSERT INTO usuarios (email, nome, email_verificado_em)
  VALUES (p_email, p_nome, now())
  RETURNING id INTO v_usuario;

  INSERT INTO identidades_federadas
    (usuario_id, provedor, issuer, subject, email_no_provedor,
     email_verificado_no_provedor, ultimo_login_em)
  VALUES (v_usuario, 'google', p_issuer, p_subject, p_email, TRUE, now());

  INSERT INTO tenants (nome) VALUES (p_nome_do_tenant) RETURNING id INTO v_tenant;
  INSERT INTO tenant_usuarios (tenant_id, usuario_id, papel)
  VALUES (v_tenant, v_usuario, 'proprietario');

  RETURN QUERY SELECT v_usuario, v_tenant;
END;
$$;

-- POST /tenants (matriz §3.2). O teto vive AQUI, e não só no guard: um teto
-- que existe só na aplicação é um teto que a próxima rota esquece.
CREATE FUNCTION auth.criar_tenant(p_usuario_id UUID, p_nome TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_no_dia INTEGER; v_ativos INTEGER; v_tenant UUID;
BEGIN
  SELECT count(*) FILTER (WHERE t.criado_em > now() - interval '1 day'),
         count(*)
    INTO v_no_dia, v_ativos
    FROM tenant_usuarios tu
    JOIN tenants t ON t.id = tu.tenant_id
   WHERE tu.usuario_id = p_usuario_id
     AND tu.papel = 'proprietario'
     AND t.deleted_at IS NULL;

  IF v_no_dia >= 3  THEN RAISE EXCEPTION 'TETO_DIARIO_DE_TENANTS'  USING ERRCODE = 'P0001'; END IF;
  IF v_ativos >= 10 THEN RAISE EXCEPTION 'TETO_DE_TENANTS_ATIVOS'  USING ERRCODE = 'P0001'; END IF;

  INSERT INTO tenants (nome) VALUES (p_nome) RETURNING id INTO v_tenant;
  INSERT INTO tenant_usuarios (tenant_id, usuario_id, papel)
  VALUES (v_tenant, p_usuario_id, 'proprietario');
  RETURN v_tenant;
END;
$$;

-- ---------------------------------------------------------------------------
-- Propriedade e EXECUTE
-- ---------------------------------------------------------------------------
-- A transferência de propriedade é o que impede que estas funções rodem com o
-- BYPASSRLS de mavia_migrate. Sem ela, tudo acima é decoração.
ALTER FUNCTION auth.buscar_credencial(TEXT)                       OWNER TO mavia_auth;
ALTER FUNCTION auth.resolver_sessao(BYTEA)                        OWNER TO mavia_auth;
ALTER FUNCTION auth.resolver_recuperacao(BYTEA)                   OWNER TO mavia_auth;
ALTER FUNCTION auth.registrar_pendente(TEXT, TEXT, TEXT, BYTEA, TIMESTAMPTZ) OWNER TO mavia_auth;
ALTER FUNCTION auth.emitir_recuperacao(TEXT, BYTEA, TIMESTAMPTZ, BYTEA)      OWNER TO mavia_auth;
ALTER FUNCTION auth.concluir_recuperacao(BYTEA, TEXT)             OWNER TO mavia_auth;
ALTER FUNCTION auth.confirmar_cadastro(BYTEA, TEXT)               OWNER TO mavia_auth;
ALTER FUNCTION auth.cadastrar_federado(TEXT, TEXT, TEXT, TEXT, TEXT) OWNER TO mavia_auth;
ALTER FUNCTION auth.criar_tenant(UUID, TEXT)                      OWNER TO mavia_auth;

-- PUBLIC recebe EXECUTE por padrão em toda função criada. Revogar não é zelo:
-- sem isso, mavia_jobs também poderia criar tenants.
REVOKE ALL ON FUNCTION auth.buscar_credencial(TEXT)                       FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.resolver_sessao(BYTEA)                        FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.resolver_recuperacao(BYTEA)                   FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.registrar_pendente(TEXT, TEXT, TEXT, BYTEA, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.emitir_recuperacao(TEXT, BYTEA, TIMESTAMPTZ, BYTEA)      FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.concluir_recuperacao(BYTEA, TEXT)             FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.confirmar_cadastro(BYTEA, TEXT)               FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.cadastrar_federado(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.criar_tenant(UUID, TEXT)                      FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth.buscar_credencial(TEXT)                       TO mavia_app;
GRANT EXECUTE ON FUNCTION auth.resolver_sessao(BYTEA)                        TO mavia_app;
GRANT EXECUTE ON FUNCTION auth.resolver_recuperacao(BYTEA)                   TO mavia_app;
GRANT EXECUTE ON FUNCTION auth.registrar_pendente(TEXT, TEXT, TEXT, BYTEA, TIMESTAMPTZ) TO mavia_app;
GRANT EXECUTE ON FUNCTION auth.emitir_recuperacao(TEXT, BYTEA, TIMESTAMPTZ, BYTEA)      TO mavia_app;
GRANT EXECUTE ON FUNCTION auth.concluir_recuperacao(BYTEA, TEXT)             TO mavia_app;
GRANT EXECUTE ON FUNCTION auth.confirmar_cadastro(BYTEA, TEXT)               TO mavia_app;
GRANT EXECUTE ON FUNCTION auth.cadastrar_federado(TEXT, TEXT, TEXT, TEXT, TEXT) TO mavia_app;
GRANT EXECUTE ON FUNCTION auth.criar_tenant(UUID, TEXT)                      TO mavia_app;

-- `mavia_app` continua SEM INSERT em tenants, usuarios e tenant_usuarios.
-- Esta ausência é o ponto da migration e é verificada por teste (AB-40).
