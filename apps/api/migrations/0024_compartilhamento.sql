-- 0024 — Compartilhamento: convite, papel e a saída de um membro.
--
-- Implementa o épico 10 e a regra **R-4** da matriz de acesso, que chama a
-- mudança de papel de "a rota de escalada de privilégio do produto".
--
-- A regra 3 da R-4 é explícita sobre onde a proteção mora:
--
-- > **Último proprietário protegido por constraint, não por `if`**: a transição
-- > que deixaria o tenant com zero `proprietario` ativo é rejeitada pelo banco.
--
-- É isso que esta migration faz. Um `if` na aplicação protege o caminho que
-- alguém lembrou de proteger; o gatilho protege todos — inclusive o `UPDATE`
-- direto no psql às três da manhã durante um incidente.

-- ---------------------------------------------------------------------------
-- Sair do espaço sem sumir da história
-- ---------------------------------------------------------------------------
-- `removido_em` em vez de `DELETE`: quem lançou continua tendo lançado, e
-- `criado_por` aponta para um usuário que precisa existir. Apagar a linha
-- deixaria o extrato com autores órfãos.
ALTER TABLE tenant_usuarios
  ADD COLUMN removido_em TIMESTAMPTZ,
  ADD COLUMN removido_por UUID REFERENCES usuarios (id);

-- ---------------------------------------------------------------------------
-- O convite
-- ---------------------------------------------------------------------------
-- **Token, e não link por e-mail.** O envio de e-mail é a pendência P-3, e
-- prender o compartilhamento a ela adiaria o épico 11 inteiro. O proprietário
-- recebe o link uma vez, na resposta, e o entrega pelo meio que quiser.
--
-- O token vive **hasheado**, como toda credencial: um dump da tabela não pode
-- virar uma lista de convites utilizáveis.
CREATE TABLE convites (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants (id),

  -- O endereço a que o convite se destina. É conferido no aceite: um convite
  -- para `ana@` aceito por `bruno@` seria um convite transferível, e um convite
  -- transferível é um convite que vaza junto com o link.
  email        TEXT NOT NULL,
  papel        papel_no_tenant NOT NULL,
  token_hash   BYTEA NOT NULL,

  criado_por   UUID NOT NULL REFERENCES usuarios (id),
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Convite sem prazo é credencial eterna esquecida num histórico de conversa.
  expira_em    TIMESTAMPTZ NOT NULL,
  aceito_em    TIMESTAMPTZ,
  aceito_por   UUID REFERENCES usuarios (id),
  revogado_em  TIMESTAMPTZ,

  CONSTRAINT convite_nao_e_para_dono CHECK (papel <> 'proprietario')
);

CREATE UNIQUE INDEX convite_por_token ON convites (token_hash);
CREATE INDEX convites_pendentes ON convites (tenant_id)
  WHERE aceito_em IS NULL AND revogado_em IS NULL;

-- Um convite pendente por endereço e por espaço: dois convites vivos para a
-- mesma pessoa deixam o proprietário sem saber qual link entregou.
CREATE UNIQUE INDEX convite_unico_por_email
  ON convites (tenant_id, lower(email))
  WHERE aceito_em IS NULL AND revogado_em IS NULL;

-- ---------------------------------------------------------------------------
-- R-4, regra 3 — o último proprietário
-- ---------------------------------------------------------------------------
-- `FOR EACH STATEMENT`, e não `FOR EACH ROW`: um `UPDATE` que rebaixa dois
-- proprietários de uma vez precisa ser avaliado **depois** de os dois terem
-- mudado. Linha a linha, o primeiro passaria porque o segundo ainda era
-- proprietário, e o segundo passaria porque o primeiro já não era — e o espaço
-- terminaria sem dono, com os dois `UPDATE` aprovados.
CREATE FUNCTION tenant_tem_dono() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_tenant UUID;
BEGIN
  FOR v_tenant IN SELECT DISTINCT tenant_id FROM afetadas LOOP
    IF NOT EXISTS (
      SELECT 1 FROM tenant_usuarios
       WHERE tenant_id = v_tenant AND papel = 'proprietario' AND removido_em IS NULL
    ) THEN
      RAISE EXCEPTION 'ESPACO_FICARIA_SEM_DONO' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER tenant_tem_dono_no_update
  AFTER UPDATE ON tenant_usuarios
  REFERENCING NEW TABLE AS afetadas
  FOR EACH STATEMENT EXECUTE FUNCTION tenant_tem_dono();

CREATE TRIGGER tenant_tem_dono_no_delete
  AFTER DELETE ON tenant_usuarios
  REFERENCING OLD TABLE AS afetadas
  FOR EACH STATEMENT EXECUTE FUNCTION tenant_tem_dono();

-- ---------------------------------------------------------------------------
-- Aceitar um convite: a única escrita em `tenant_usuarios` sem tenant no contexto
-- ---------------------------------------------------------------------------
-- Galinha e ovo, como no login: para entrar no espaço é preciso ler um convite
-- do espaço, e a policy exige o `app.tenant_id` que o aceite ainda vai
-- descobrir. A saída é a mesma do §4.2 do spec de autenticação — uma função
-- `SECURITY DEFINER` **estreita**, que recebe um hash exato e um usuário, e
-- devolve no máximo uma linha.
--
-- Ela não aceita `tenant_id` como entrada, e é isso que a torna estreita: quem
-- a chama não escolhe o espaço, o token escolhe.
-- Os nomes de saída **não** repetem os das colunas de `tenant_usuarios`.
-- Repetindo, o `INSERT` daqui de dentro fica ambíguo — o plpgsql não sabe se
-- `tenant_id` é a coluna ou o parâmetro de saída — e a função falha em tempo de
-- execução, não de criação: o erro só aparece no primeiro aceite.
CREATE FUNCTION auth.aceitar_convite(p_hash BYTEA, p_usuario UUID, p_email TEXT)
RETURNS TABLE (id_do_tenant UUID, papel_concedido papel_no_tenant, motivo TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c convites;
BEGIN
  SELECT * INTO c FROM convites WHERE token_hash = p_hash;

  IF c.id IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::papel_no_tenant, 'desconhecido'::text;
    RETURN;
  END IF;
  IF c.aceito_em IS NOT NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::papel_no_tenant, 'ja_aceito'::text;
    RETURN;
  END IF;
  IF c.revogado_em IS NOT NULL OR c.expira_em <= now() THEN
    RETURN QUERY SELECT NULL::uuid, NULL::papel_no_tenant, 'expirado'::text;
    RETURN;
  END IF;

  -- O convite é para um endereço, e não para quem tiver o link.
  IF lower(c.email) <> lower(p_email) THEN
    RETURN QUERY SELECT NULL::uuid, NULL::papel_no_tenant, 'outro_destinatario'::text;
    RETURN;
  END IF;

  INSERT INTO tenant_usuarios (tenant_id, usuario_id, papel)
  VALUES (c.tenant_id, p_usuario, c.papel)
  -- Já era membro: o convite se consome e o papel **não** é rebaixado. Um
  -- convite de `visualizador` aceito por um `membro` não pode tirar direito.
  ON CONFLICT (tenant_id, usuario_id) DO UPDATE
    SET removido_em = NULL, removido_por = NULL;

  UPDATE convites SET aceito_em = now(), aceito_por = p_usuario WHERE id = c.id;

  RETURN QUERY SELECT c.tenant_id, c.papel, 'aceito'::text;
END;
$$;

ALTER FUNCTION auth.aceitar_convite(BYTEA, UUID, TEXT) OWNER TO mavia_auth;
REVOKE ALL ON FUNCTION auth.aceitar_convite(BYTEA, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.aceitar_convite(BYTEA, UUID, TEXT) TO mavia_app;

GRANT SELECT, INSERT, UPDATE ON convites TO mavia_auth;
GRANT UPDATE ON tenant_usuarios TO mavia_auth;

CREATE POLICY convite_lido_pelo_aceite ON convites FOR SELECT TO mavia_auth USING (true);
CREATE POLICY convite_consumido_pelo_aceite ON convites FOR UPDATE TO mavia_auth
  USING (true) WITH CHECK (true);
CREATE POLICY vinculo_atualizado_pelo_aceite ON tenant_usuarios FOR UPDATE TO mavia_auth
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Revogar as sessões de quem saiu
-- ---------------------------------------------------------------------------
-- O spec de autenticação §4.3 lista "remoção do membro do tenant" entre as
-- revogações **automáticas**. Sem isto, quem foi removido continua com token
-- válido por até quinze minutos e refresh por semanas — e o "removi o acesso"
-- do proprietário seria uma promessa que o servidor não cumpre.
CREATE FUNCTION auth.revogar_sessoes_do_usuario(p_usuario UUID, p_motivo TEXT)
RETURNS TABLE (sessao_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN QUERY
  UPDATE sessoes SET revogada_em = now(), motivo_revogacao = p_motivo
   WHERE usuario_id = p_usuario AND revogada_em IS NULL
  RETURNING sessoes.id;
END;
$$;

ALTER FUNCTION auth.revogar_sessoes_do_usuario(UUID, TEXT) OWNER TO mavia_auth;
REVOKE ALL ON FUNCTION auth.revogar_sessoes_do_usuario(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.revogar_sessoes_do_usuario(UUID, TEXT) TO mavia_app;

-- ---------------------------------------------------------------------------
-- Isolamento
-- ---------------------------------------------------------------------------
ALTER TABLE convites ENABLE ROW LEVEL SECURITY;
ALTER TABLE convites FORCE  ROW LEVEL SECURITY;
CREATE POLICY convite_do_tenant ON convites
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON convites TO mavia_app;
GRANT UPDATE ON tenant_usuarios TO mavia_app;

-- `mavia_app` opera os vínculos do próprio espaço, sob a policy que já existe
-- em 0001. A policy é por `app.usuario_id`; a de tenant vem da rota.
CREATE POLICY vinculo_do_tenant ON tenant_usuarios
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
