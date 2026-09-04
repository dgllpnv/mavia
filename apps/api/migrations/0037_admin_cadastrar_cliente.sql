-- 0037 · O operador prepara o espaço de um cliente novo
--
-- Ticket 09. Spec v3.2 §8.4 e §8.5.
--
-- ## O que esta função **não** faz, e é o mais importante dela
--
-- **Não cria identidade.** Ela recebe um `usuario_id` que já existe e o vincula
-- a um espaço novo. Criar conta é ato de quem vai ser dono dela — com senha que
-- só ele conhece, ou pela conta Google dele. Um operador criando login para
-- terceiro é um operador que conhece a credencial de um cliente.
--
-- **Não força estado.** O espaço nasce em `teste`, pelo gatilho
-- `assinatura_de_teste_trg` (`0025_assinatura.sql:87-89`), com sete dias e as
-- cotas do Família. Sair de `teste` é `assinou`, e `assinou` pede plano e
-- intervalo — que é a DP-40, ainda aberta. Inventar um caminho para `ativa`
-- aqui seria recriar o defeito que o achado F-13 fechou, um estado ao lado.
--
-- **Não é bypass do teto.** A rota do cliente cumpre A-18/DP-26 — três espaços
-- por dia, dez ativos por titular. Um painel que ignorasse isso transformaria
-- o limite numa formalidade que basta pedir a um operador para contornar.
--
-- A verificação é **copiada por dentro**, e a duplicação é deliberada: a
-- alternativa seria conceder ao painel `EXECUTE` em `auth.criar_tenant`, que é
-- de `mavia_auth` — o papel que lê cinco tabelas entre todos os espaços com
-- `USING (true)`. Emprestar aquele papel ao painel desfaria a ADR 0024 D4 por
-- conveniência.

SET ROLE mavia_admin_contrato;

CREATE FUNCTION admin.cadastrar_cliente(
  p_usuario_id UUID,
  p_nome       TEXT,
  p_correlacao UUID
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE
  v_operador UUID := nullif(current_setting('app.usuario_id', true), '')::uuid;
  v_no_dia   INTEGER;
  v_ativos   INTEGER;
  v_tenant   UUID;
  v_email    TEXT;
BEGIN
  IF v_operador IS NULL OR NOT admin.tem_concessao_ativa() THEN
    RAISE EXCEPTION 'SEM_CONCESSAO_DE_ADMIN' USING ERRCODE = 'P0001';
  END IF;
  IF length(btrim(coalesce(p_nome, ''))) < 2 THEN
    RAISE EXCEPTION 'NOME_AUSENTE' USING ERRCODE = 'P0001';
  END IF;

  -- **O titular precisa existir.** Sem esta guarda, a chave estrangeira
  -- responderia com o nome de uma restrição, e a tela mostraria ao operador uma
  -- mensagem de banco em vez de "esta pessoa ainda não tem conta".
  SELECT email INTO v_email
    FROM usuarios WHERE id = p_usuario_id AND deleted_at IS NULL;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'TITULAR_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;

  -- A **mesma** consulta e os **mesmos** tetos de `auth.criar_tenant`
  -- (`0004_cadastro.sql:293-303`), com os mesmos nomes de exceção — para que a
  -- tela do painel e a do cliente digam a mesma coisa quando o limite bater.
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

  INSERT INTO tenants (nome) VALUES (btrim(p_nome)) RETURNING id INTO v_tenant;
  INSERT INTO tenant_usuarios (tenant_id, usuario_id, papel)
  VALUES (v_tenant, p_usuario_id, 'proprietario');

  -- A assinatura de teste nasce do gatilho, como `mavia_auth`. O painel não a
  -- insere e **não precisa de privilégio sobre `assinaturas` neste caminho** —
  -- o que é a propriedade que mantém "não força estado" verificável, e não uma
  -- promessa.

  -- A segunda linha do par (§8.5). O `de` é o vazio: o espaço não existia.
  INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, entidade_id,
                         acao, classe, correlacao, de, para)
  VALUES (v_tenant, v_operador, 'operador', 'tenant', v_tenant,
          'cadastrou_cliente', 'escrita_financeira', p_correlacao,
          NULL,
          jsonb_build_object('nome', btrim(p_nome), 'titular', p_usuario_id,
                             'titular_email_sha256',
                             encode(sha256(convert_to(v_email, 'UTF8')), 'hex')));

  RETURN v_tenant;
END;
$$;

REVOKE ALL ON FUNCTION admin.cadastrar_cliente(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.cadastrar_cliente(UUID, TEXT, UUID) TO mavia_admin_escrita;
RESET ROLE;
