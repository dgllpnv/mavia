-- 0027 — O nome do espaço acompanha o cadastro pendente.
--
-- Pendência P-3. O formulário de cadastro pergunta como a pessoa quer chamar o
-- espaço dela, e até aqui a resposta se perdia: `cadastros_pendentes` não tinha
-- onde guardá-la, e `auth.confirmar_cadastro` recebia o nome como argumento —
-- que a tela de confirmação, alcançada por um link de e-mail em outro
-- dispositivo, não tem como conhecer.
--
-- O sintoma era silencioso e por isso caro: a pessoa digitava "Casa da Ana", o
-- cadastro funcionava, e o espaço nascia chamado "Meu espaço". Nada falhava.
--
-- **Perguntar depois seria pior.** O nome é escolhido enquanto a pessoa está
-- engajada, preenchendo o formulário; empurrá-lo para depois do clique no
-- e-mail é pedir uma decisão a quem só quer entrar.

ALTER TABLE cadastros_pendentes
  ADD COLUMN nome_do_espaco TEXT;

-- ---------------------------------------------------------------------------
-- As duas funções, substituídas
-- ---------------------------------------------------------------------------
-- Migrations são forward-only: a 0004 fica como está, e a substituição é uma
-- migration nova. Editar a original faria os dois bancos — o que já rodou e o
-- que vai rodar do zero — divergirem em silêncio.

-- **A versão de cinco argumentos é derrubada, e não deixada como sobrecarga.**
-- Duas funções com o mesmo nome e aridades diferentes convivem bem em teoria;
-- na prática, uma chamada com parâmetros de tipo `unknown` — que é como o
-- driver os envia — vira `function ... is not unique` e falha em runtime. Foi um
-- teste existente que encontrou isso, e o erro só apareceria no primeiro
-- cadastro depois do deploy.
DROP FUNCTION auth.registrar_pendente(TEXT, TEXT, TEXT, BYTEA, TIMESTAMPTZ);

CREATE FUNCTION auth.registrar_pendente(
  p_email TEXT, p_nome TEXT, p_senha_hash TEXT, p_token_hash BYTEA,
  p_expira_em TIMESTAMPTZ, p_nome_do_espaco TEXT DEFAULT NULL)
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

  INSERT INTO cadastros_pendentes
    (email, nome, senha_hash, token_hash, expira_em, nome_do_espaco)
  VALUES (p_email, p_nome, p_senha_hash, p_token_hash, p_expira_em, p_nome_do_espaco);
  RETURN TRUE;
END;
$$;

-- O nome do espaço agora vem do **pendente**, e não do argumento. O argumento
-- some: mantê-lo como alternativa deixaria dois caminhos para nomear a mesma
-- coisa, e o dia em que os dois discordassem seria o dia de descobrir qual
-- vence.
CREATE OR REPLACE FUNCTION auth.confirmar_cadastro(p_token_hash BYTEA, p_nome_do_tenant TEXT)
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

  -- O nome escolhido no formulário. O argumento continua na assinatura porque
  -- ela é pública, e vira o fallback de quem não escolheu nada.
  INSERT INTO tenants (nome)
  VALUES (coalesce(nullif(trim(v_pendente.nome_do_espaco), ''), p_nome_do_tenant))
  RETURNING id INTO v_tenant;

  -- Na mesma transação: um tenant nunca existe sem proprietário.
  INSERT INTO tenant_usuarios (tenant_id, usuario_id, papel)
  VALUES (v_tenant, v_usuario, 'proprietario');

  UPDATE cadastros_pendentes SET consumido_em = now() WHERE id = v_pendente.id;

  RETURN QUERY SELECT v_usuario, v_tenant;
END;
$$;

-- **O dono importa mais do que parece.** Estas são `SECURITY DEFINER`: elas
-- rodam com os privilégios de quem as possui. Uma função criada por esta
-- migration nasce pertencendo a `mavia_migrate`, que é o papel mais poderoso do
-- banco — e passaria a executar o cadastro com ele. `mavia_auth` é NOLOGIN e
-- NOBYPASSRLS de propósito, e é o teto certo para uma função pré-autenticação.
ALTER FUNCTION auth.registrar_pendente(TEXT, TEXT, TEXT, BYTEA, TIMESTAMPTZ, TEXT)
  OWNER TO mavia_auth;
ALTER FUNCTION auth.confirmar_cadastro(BYTEA, TEXT) OWNER TO mavia_auth;

GRANT EXECUTE ON FUNCTION
  auth.registrar_pendente(TEXT, TEXT, TEXT, BYTEA, TIMESTAMPTZ, TEXT) TO mavia_app;
