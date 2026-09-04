-- 0032 · As funções do esquema `admin` — família de leitura
--
-- Ticket 05. Spec v3.2 §1.6, §2, §8.0 e "Erros e bordas · S3-4". ADR 0024 D1,
-- D2 e D4.
--
-- ## O que este arquivo contém, em uma frase
--
-- Os **três únicos lugares do sistema** onde um identificador vindo de uma rota
-- vira contexto de banco. Cada um grava a linha de auditoria antes de o acesso
-- existir, e é isso que torna verdadeira a propriedade que o épico inteiro
-- promete: *não se toca o espaço de um cliente sem registrar*.
--
-- ## Por que o dono não é `mavia_auth`
--
-- A convenção do repositório manda toda `SECURITY DEFINER` pertencer a
-- `mavia_auth`. **Aqui, a convenção é o exploit.** Ele já lê `usuarios`,
-- `tenants`, `tenant_usuarios`, `sessoes` e `assinaturas` entre todos os
-- espaços, com `USING (true)` — `0004_cadastro.sql:52`, `:57`, `:60`, `:63` e
-- `0025_assinatura.sql:163`. Uma função de listagem escrita por alguém seguindo
-- a convenção nasceria lendo a base inteira sem violar uma vírgula de nenhuma
-- proibição escrita, e sem gravar uma linha de auditoria.
--
-- E não é `mavia_migrate`, que tem `BYPASSRLS`: a função viraria leitura
-- irrestrita de tudo, contra o veto 8 do `sistema.md`.

-- ---------------------------------------------------------------------------
-- 0 · O que o Postgres 16 mudou, e sem o que este arquivo não roda
-- ---------------------------------------------------------------------------
-- `ALTER FUNCTION … OWNER TO mavia_admin_definer` responde
--
--     ERROR:  must be able to SET ROLE "mavia_admin_definer"
--
-- mesmo com `mavia_migrate` sendo membro dele. No Postgres 16 em diante, a
-- filiação automática que um papel `CREATEROLE` recebe sobre o que cria vem com
-- `ADMIN OPTION` e **sem** `SET` — administrar e assumir passaram a ser
-- privilégios distintos, e transferir posse exige o segundo.
--
-- `INHERIT FALSE` de propósito: `mavia_migrate` precisa **poder assumir** o
-- papel para transferir a posse, e não deve **herdar** os privilégios dele em
-- silêncio. A diferença importa porque este é o papel que lê a base inteira.
GRANT mavia_admin_definer TO mavia_migrate WITH SET TRUE, INHERIT FALSE;
GRANT mavia_admin_contrato TO mavia_migrate WITH SET TRUE, INHERIT FALSE;

-- E `CREATE`, não só `USAGE`, nos dois donos de função.
--
-- Segunda surpresa do mesmo `ALTER FUNCTION`: para **possuir** um objeto num
-- esquema, o papel precisa de `CREATE` nele — o Postgres confere o privilégio
-- do **novo dono**, não o de quem transfere. Com apenas `USAGE`, a resposta é
-- `permission denied for schema admin`, apontando para o esquema quando o
-- problema é o destinatário.
--
-- O alcance disso é contido pelo que os dois papéis são: `NOLOGIN`, sem
-- parentesco com nenhum papel de conexão, existindo apenas como donos de
-- função. E a lista fechada do esquema `admin` é verificada por teste — uma
-- função nova, de qualquer dono, derruba a suíte.
GRANT CREATE ON SCHEMA admin TO mavia_admin_definer;
GRANT CREATE ON SCHEMA admin TO mavia_admin_contrato;

-- ---------------------------------------------------------------------------
-- 1 · As policies que a projeção da listagem precisa
-- ---------------------------------------------------------------------------
-- As policies existentes dessas tabelas exigem `app.tenant_id` ou vínculo em
-- `tenant_usuarios`. Na listagem não há tenant **por definição** — é a terceira
-- exceção do `sistema.md` §3.9 —, e o operador não tem vínculo com espaço
-- nenhum. Sem policy própria, a função devolveria zero linhas.
--
-- **`TO mavia_admin_definer`, e o alcance nominal é a contenção.** Este papel é
-- `NOLOGIN`: ele não é alcançável por `SET ROLE` a partir de `mavia_app` nem de
-- nenhum papel do painel, e existe apenas como **dono de função**. Uma policy
-- endereçada a ele não amplia nada para quem serve requisição.
--
-- **O predicado de concessão é a saída A do achado S3-4**, e ele existe porque
-- a saída B sozinha era frágil: o teste que institucionaliza "o dono de toda
-- função em `admin` é `mavia_admin_definer`" faria a **segunda** função de
-- admin nascer lendo a base inteira, herdando policies amplas. Com o predicado
-- aqui, a leitura ampla existe **para quem tem concessão ativa** — não para
-- quem alcança o papel.
CREATE FUNCTION admin.tem_concessao_ativa() RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM concessoes_de_admin
     WHERE usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid
       AND revogada_em IS NULL
  );
$$;

CREATE POLICY definer_le_tenants ON tenants
  FOR SELECT TO mavia_admin_definer USING (admin.tem_concessao_ativa());
CREATE POLICY definer_le_usuarios ON usuarios
  FOR SELECT TO mavia_admin_definer USING (admin.tem_concessao_ativa());
CREATE POLICY definer_le_vinculos ON tenant_usuarios
  FOR SELECT TO mavia_admin_definer USING (admin.tem_concessao_ativa());
CREATE POLICY definer_le_assinaturas ON assinaturas
  FOR SELECT TO mavia_admin_definer USING (admin.tem_concessao_ativa());

-- ---------------------------------------------------------------------------
-- 2 · A listagem — a terceira exceção de leitura sem contexto de tenant
-- ---------------------------------------------------------------------------
-- As cinco obrigações da §2, e nenhuma é decorativa:
--
--   1. dono próprio, `NOLOGIN NOBYPASSRLS`;
--   2. `SET search_path = pg_catalog, public`;
--   3. busca por **parâmetro vinculado**, nunca `format` nem `||`;
--   4. **checa a concessão por dentro**, e devolve **erro** — não zero linhas;
--   5. **grava a auditoria da busca na mesma instrução**.
--
-- A 4 é a que costuma virar "devolve vazio". Erro e vazio são indistinguíveis
-- para quem chama e completamente diferentes para quem audita: vazio diz "não
-- há clientes", erro diz "você não deveria estar perguntando".
CREATE FUNCTION admin.listar_clientes(p_busca TEXT DEFAULT NULL, p_limite INT DEFAULT 50)
RETURNS TABLE (
  tenant_id  UUID,
  nome       TEXT,
  titular    TEXT,
  plano      TEXT,
  estado     TEXT,
  criado_em  TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE
  v_operador UUID := nullif(current_setting('app.usuario_id', true), '')::uuid;
BEGIN
  IF v_operador IS NULL OR NOT admin.tem_concessao_ativa() THEN
    RAISE EXCEPTION 'SEM_CONCESSAO_DE_ADMIN' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  WITH achados AS (
    SELECT t.id, t.nome, u.email AS titular,
           a.plano::text AS plano, a.estado::text AS estado, t.criado_em
      FROM tenants t
      LEFT JOIN tenant_usuarios tu
             ON tu.tenant_id = t.id AND tu.papel = 'proprietario' AND tu.removido_em IS NULL
      LEFT JOIN usuarios u   ON u.id = tu.usuario_id
      LEFT JOIN assinaturas a ON a.tenant_id = t.id
     WHERE t.deleted_at IS NULL
       -- **Parâmetro vinculado.** `%` e aspas no termo são dados, não sintaxe:
       -- um `format` aqui transformaria a busca do operador em SQL do operador.
       AND (p_busca IS NULL
            OR t.nome ILIKE '%' || p_busca || '%'
            OR u.email ILIKE '%' || p_busca || '%')
     ORDER BY t.criado_em DESC
     LIMIT greatest(1, least(coalesce(p_limite, 50), 200))
  ),
  registro AS (
    -- **Uma linha por busca, não uma por cliente listado**, e o termo entra
    -- hasheado: sem isso o log de acesso vira um segundo índice de e-mails de
    -- clientes, o que é o oposto do que ele existe para fazer.
    INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, acao,
                           classe, motivo, referencia, registros, de)
    SELECT NULL, v_operador, 'operador', 'cliente', 'buscou',
           'leitura_em_massa', 'chamado', 'listagem', count(*),
           CASE WHEN p_busca IS NULL THEN NULL
                ELSE jsonb_build_object('termo_sha256',
                       encode(sha256(convert_to(p_busca, 'UTF8')), 'hex')) END
      FROM achados
    RETURNING 1
  )
  SELECT a.id, a.nome, a.titular, a.plano, a.estado, a.criado_em
    FROM achados a
   WHERE (SELECT count(*) FROM registro) >= 0;
END;
$$;

ALTER FUNCTION admin.listar_clientes(TEXT, INT) OWNER TO mavia_admin_definer;

-- ⚠️ **O `REVOKE` precisa vir de quem é dono AGORA.**
--
-- Depois do `ALTER … OWNER`, `mavia_migrate` deixou de ser dono — e um `REVOKE`
-- de quem não é dono **não falha**: ele emite um `WARNING` e não faz nada. É a
-- mesma armadilha que `bootstrap-papeis.sql:36-44` documenta para o `GRANT`, do
-- outro lado da moeda, e ela aparece aqui de forma mais cruel: a migration
-- reporta sucesso e a função nasce com `EXECUTE` para `PUBLIC`.
--
-- Medido: sem o `SET ROLE` abaixo, `proacl` fica `{=X/mavia_admin_definer,…}` —
-- o `=X` é `PUBLIC`. Qualquer sessão autenticada poderia abrir o espaço de
-- qualquer cliente.
SET ROLE mavia_admin_definer;
REVOKE ALL ON FUNCTION admin.listar_clientes(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.listar_clientes(TEXT, INT) TO mavia_admin;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- 3 · Abrir o espaço de um cliente — **duas** funções, não uma
-- ---------------------------------------------------------------------------
-- A v3 tinha só a de leitura, e por isso as quatro escritas da §8 não passavam
-- por abertura nenhuma: a propriedade central valia para leitura e não para
-- escrita. Achado S3-2.
--
-- Sem a segunda função, o implementador tinha três saídas e duas eram ruins:
-- `set_config` direto na rota — que a ADR 0024 D1 condição 2 chama de defeito,
-- por escrito —, ou conceder `EXECUTE` da função de leitura ao papel de escrita
-- de improviso na migration. A terceira, escrever a segunda função, é esta.
--
-- ## A ordem é normativa: `set_config` **primeiro**, `INSERT` depois
--
-- E ela não depende da policy de `auditoria` nem a policy depende dela — as
-- duas travas coexistem de propósito. Se um dia a policy passar a exigir
-- `app.tenant_id`, esta ordem já a satisfaz; se a ordem for invertida por
-- descuido, a policy `WITH CHECK (true)` do ticket 03 não a denuncia. Por isso
-- há um teste para a ordem, separado do teste da policy.
--
-- ## O mesmo parâmetro vinculado nos dois
--
-- `p_alvo` é o que vira `app.tenant_id` **e** o que vai para a coluna
-- `tenant_id` da auditoria. Não há como auditar A e efetivar B: seria preciso
-- escrever duas expressões diferentes, e não há duas.
CREATE FUNCTION admin.abrir_espaco(
  p_alvo       UUID,
  p_motivo     motivo_de_acesso,
  p_referencia TEXT,
  p_acao       TEXT,
  p_rota       TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE
  v_operador   UUID := nullif(current_setting('app.usuario_id', true), '')::uuid;
  v_correlacao UUID := gen_random_uuid();
BEGIN
  IF v_operador IS NULL OR NOT admin.tem_concessao_ativa() THEN
    RAISE EXCEPTION 'SEM_CONCESSAO_DE_ADMIN' USING ERRCODE = 'P0001';
  END IF;
  IF p_alvo IS NULL THEN
    RAISE EXCEPTION 'ALVO_AUSENTE' USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.tenant_id', p_alvo::text, true);

  INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, entidade_id,
                         acao, classe, rota, motivo, referencia, correlacao)
  VALUES (p_alvo, v_operador, 'operador', 'tenant', p_alvo,
          coalesce(p_acao, 'abriu'), 'leitura_em_massa', p_rota,
          p_motivo, p_referencia, v_correlacao);

  RETURN v_correlacao;
END;
$$;

-- Irmã da anterior, para as quatro escritas da §8. **Classe de escrita
-- financeira**, e devolve a `correlacao` que a segunda linha — a do efeito,
-- com o `de → para` — vai carregar (§8.5, achado F-14).
CREATE FUNCTION admin.abrir_espaco_para_escrita(
  p_alvo       UUID,
  p_motivo     motivo_de_acesso,
  p_referencia TEXT,
  p_acao       TEXT,
  p_rota       TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE
  v_operador   UUID := nullif(current_setting('app.usuario_id', true), '')::uuid;
  v_correlacao UUID := gen_random_uuid();
BEGIN
  IF v_operador IS NULL OR NOT admin.tem_concessao_ativa() THEN
    RAISE EXCEPTION 'SEM_CONCESSAO_DE_ADMIN' USING ERRCODE = 'P0001';
  END IF;
  IF p_alvo IS NULL THEN
    RAISE EXCEPTION 'ALVO_AUSENTE' USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.tenant_id', p_alvo::text, true);

  INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, entidade_id,
                         acao, classe, rota, motivo, referencia, correlacao)
  VALUES (p_alvo, v_operador, 'operador', 'tenant', p_alvo,
          coalesce(p_acao, 'abriu_para_escrever'), 'escrita_financeira', p_rota,
          p_motivo, p_referencia, v_correlacao);

  RETURN v_correlacao;
END;
$$;

ALTER FUNCTION admin.abrir_espaco(UUID, motivo_de_acesso, TEXT, TEXT, TEXT)
  OWNER TO mavia_admin_definer;
ALTER FUNCTION admin.abrir_espaco_para_escrita(UUID, motivo_de_acesso, TEXT, TEXT, TEXT)
  OWNER TO mavia_admin_definer;

-- Como acima: de dentro do papel que passou a ser dono.
SET ROLE mavia_admin_definer;
REVOKE ALL ON FUNCTION admin.abrir_espaco(UUID, motivo_de_acesso, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.abrir_espaco_para_escrita(UUID, motivo_de_acesso, TEXT, TEXT, TEXT) FROM PUBLIC;

-- **Cruzado, e é a asserção**: quem lê não alcança a função de escrita, e quem
-- escreve não alcança a de leitura. Duas conexões, dois papéis, duas classes de
-- auditoria — e nenhuma ponte entre elas.
GRANT EXECUTE ON FUNCTION admin.abrir_espaco(UUID, motivo_de_acesso, TEXT, TEXT, TEXT)
  TO mavia_admin;
GRANT EXECUTE ON FUNCTION admin.abrir_espaco_para_escrita(UUID, motivo_de_acesso, TEXT, TEXT, TEXT)
  TO mavia_admin_escrita;
RESET ROLE;

-- O dono das funções precisa gravar na auditoria: o `INSERT` acima roda como
-- ele, não como quem chamou.
GRANT INSERT ON auditoria TO mavia_admin_definer;
