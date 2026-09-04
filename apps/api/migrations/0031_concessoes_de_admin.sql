-- 0031 · Quem é administrador, e desde quando
--
-- Ticket 04. Spec v3.2 §4, §4.1, §1.4 (achado S3-9) e §6.4.
--
-- ## A tabela é append-only, e é por isso que ela responde à pergunta certa
--
-- "Quem é admin **agora**" é derivado; "quem foi admin **em março**" também. Uma
-- coluna booleana `é_admin` responderia só a primeira, e perderia a segunda no
-- instante em que alguém fosse revogado — que é exatamente o instante em que a
-- pergunta passa a importar.
--
-- Conceder → revogar → conceder de novo são **três linhas**, e a história
-- inteira sobrevive.
--
-- ## Sem `tenant_id`, e a ausência tem consequência
--
-- Esta tabela prova quem teve acesso **à base**, não a um espaço. Por isso ela
-- não entra na conta do R-08 e sobrevive à eliminação de qualquer cliente: a
-- evidência de que um operador existiu não é dado de nenhum cliente.

CREATE TABLE concessoes_de_admin (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id    UUID        NOT NULL REFERENCES usuarios (id),

  -- **O e-mail no ato da concessão, copiado e nunca atualizado.**
  --
  -- A FK acima não basta, e a razão é a §5.2 da política de retenção: `usuarios`
  -- é apagada fisicamente quando o titular exerce o art. 18 VI. Sem esta cópia,
  -- eliminar a conta de um ex-operador transformaria toda a história de acesso
  -- dele num UUID sem dono — e a evidência que esta tabela existe para guardar
  -- some junto com a pessoa que ela deveria identificar.
  --
  -- Ela conversa com o segundo bloqueio da §5.2: quem é, ou foi nos últimos
  -- cinco anos, administrador **não elimina a própria conta pela rota do
  -- titular**. Desligamento de operador é processo administrativo.
  email_no_ato  TEXT        NOT NULL CHECK (position('@' IN email_no_ato) > 1),

  concedida_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  concedida_por UUID        NOT NULL REFERENCES usuarios (id),

  revogada_em   TIMESTAMPTZ,
  revogada_por  UUID        REFERENCES usuarios (id),

  CONSTRAINT revogacao_completa CHECK (
    (revogada_em IS NULL AND revogada_por IS NULL) OR
    (revogada_em IS NOT NULL AND revogada_por IS NOT NULL)
  )
);

-- Uma concessão ativa por pessoa. Duas ativas fariam a contagem da invariante
-- abaixo mentir, e "revogar" passaria a ser ambíguo.
CREATE UNIQUE INDEX concessao_ativa_unica
  ON concessoes_de_admin (usuario_id) WHERE revogada_em IS NULL;

-- ---------------------------------------------------------------------------
-- A invariante de dois operadores ativos
-- ---------------------------------------------------------------------------
-- `FOR EACH STATEMENT`, pelo mesmo motivo escrito em
-- `0024_compartilhamento.sql:69-73`: um `UPDATE` que revoga dois de uma vez
-- precisa ser avaliado **depois** de os dois terem mudado. Linha a linha, o
-- primeiro passaria porque o segundo ainda estava ativo, e o segundo passaria
-- porque o primeiro já não estava — e a base terminaria com um operador só,
-- com as duas revogações aprovadas.
--
-- ## Só de `UPDATE`, e é decisão declarada
--
-- Uma invariante "sempre ≥ 2 ativos" que cobrisse `INSERT` exigiria uma isenção
-- para a **primeira** concessão — e isenção é exatamente o escape hatch que a
-- imutabilidade da `auditoria` foi escrita para fechar. Um GUC de bootstrap,
-- ou um `current_user` privilegiado, seria o caminho que alguém usaria depois
-- para outra coisa.
--
-- Então o gatilho **impede cair** para um, e **não impede operar** com um.
-- A diferença está escrita porque ela é real: enquanto houver um único
-- operador, a salvaguarda de detecção entre pares é o conjunto vazio, e quem
-- descobre o abuso está do mesmo lado de quem pode cometê-lo. É o ponto mais
-- frágil do balanceamento, e ele é coberto pela DP-32 — padrão vigente, decisão
-- do dono ainda pendente: **o painel não vai a produção com cliente real antes
-- do MFA**.
CREATE FUNCTION exigir_dois_admins_ativos() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_ativos INT;
BEGIN
  -- Só conta se a instrução de fato revogou alguém. Um `UPDATE` que mexe em
  -- outra coluna não deve ser barrado por uma contagem que ele não alterou.
  IF NOT EXISTS (SELECT 1 FROM afetadas WHERE revogada_em IS NOT NULL) THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_ativos
    FROM concessoes_de_admin WHERE revogada_em IS NULL;

  IF v_ativos < 2 THEN
    RAISE EXCEPTION 'ADMINS_ATIVOS_INSUFICIENTES' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER dois_admins_ativos_na_revogacao
  AFTER UPDATE ON concessoes_de_admin
  REFERENCING NEW TABLE AS afetadas
  FOR EACH STATEMENT EXECUTE FUNCTION exigir_dois_admins_ativos();

-- ---------------------------------------------------------------------------
-- RLS — e a policy do painel é **estreita de propósito**
-- ---------------------------------------------------------------------------
ALTER TABLE concessoes_de_admin ENABLE ROW LEVEL SECURITY;
ALTER TABLE concessoes_de_admin FORCE  ROW LEVEL SECURITY;

-- O operador enxerga **a própria concessão, e nenhuma outra**.
--
-- É o que o guard precisa para responder "este operador está ativo?", e é tudo
-- o que ele precisa. Uma policy ampla aqui entregaria, numa conexão sem segundo
-- fator, a lista de todos os operadores da Mavia com nome e e-mail — que é
-- exatamente o alvo de quem já comprometeu um deles.
CREATE POLICY concessao_propria ON concessoes_de_admin
  FOR SELECT TO mavia_admin
  USING (usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid);

-- As duas famílias de função de `admin` conferem a concessão **por dentro**,
-- como a obrigação 4 da §2 exige — e para conferir, precisam poder ler.
--
-- ⚠️ **`USING (true)`, e não o predicado de concessão — porque ele é impossível
-- aqui.** Uma policy que guarda uma tabela **não pode consultar essa mesma
-- tabela**: o Postgres responde `infinite recursion detected in policy for
-- relation "concessoes_de_admin"`, e responde na primeira chamada.
--
-- O predicado da saída A do achado S3-4 vive nas policies das **outras**
-- tabelas — `tenants`, `usuarios`, `tenant_usuarios`, `assinaturas` (migration
-- 0032) —, que é onde ele de fato contém: é lá que a leitura ampla existe, e é
-- lá que ela passa a valer só para quem tem concessão ativa.
--
-- Aqui, o alcance é contido pelo que estes dois papéis **são**: `NOLOGIN`, sem
-- parentesco com papel de conexão nenhum, existindo apenas como donos de
-- função. Eles leem `concessoes_de_admin` para responder "esta pessoa é
-- operador?" — que é a pergunta que a checagem por dentro precisa fazer, e a
-- única coisa que as funções expõem é o que elas retornam.
CREATE POLICY concessao_para_o_definer ON concessoes_de_admin
  FOR SELECT TO mavia_admin_definer USING (true);

CREATE POLICY concessao_para_o_contrato ON concessoes_de_admin
  FOR SELECT TO mavia_admin_contrato USING (true);

GRANT SELECT (id, usuario_id, email_no_ato, concedida_em, revogada_em)
  ON concessoes_de_admin TO mavia_admin;
GRANT SELECT (id, usuario_id, email_no_ato, concedida_em, revogada_em)
  ON concessoes_de_admin TO mavia_admin_definer;
GRANT SELECT (id, usuario_id, email_no_ato, concedida_em, revogada_em)
  ON concessoes_de_admin TO mavia_admin_contrato;

-- ---------------------------------------------------------------------------
-- Conceder e revogar — e as duas **gravam a própria linha de auditoria**
-- ---------------------------------------------------------------------------
-- Sem isto, o provisionamento seria, por construção, uma concessão sem
-- registro: a única operação do sistema que cria um operador aconteceria fora
-- do log que existe para vigiar operadores.
--
-- `tenant_id` **nulo** nas duas linhas — conceder admin não pertence a espaço
-- nenhum, e é uma das três linhas que a policy da §3.3 foi escrita para
-- aceitar. Invisível a `mavia_app` por construção.
--
-- `SECURITY DEFINER` de `mavia_migrate`, e aqui é aceitável porque estas duas
-- funções **não servem requisição**: são chamadas pelo provisionamento, pela
-- mão que já tem o servidor. Concedê-las a `mavia_admin` seria deixar um
-- operador criar outro.
CREATE FUNCTION admin.conceder(p_usuario UUID, p_por UUID) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE v_email TEXT; v_id UUID;
BEGIN
  SELECT email INTO v_email FROM usuarios WHERE id = p_usuario AND deleted_at IS NULL;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'USUARIO_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO concessoes_de_admin (usuario_id, email_no_ato, concedida_por)
  VALUES (p_usuario, v_email, p_por)
  RETURNING id INTO v_id;

  INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, entidade_id,
                         acao, classe, para)
  VALUES (NULL, p_por, 'sistema', 'concessao_de_admin', v_id,
          'concedeu', 'operacao_interna',
          jsonb_build_object('usuario_id', p_usuario, 'email', v_email));

  RETURN v_id;
END;
$$;

CREATE FUNCTION admin.revogar(p_usuario UUID, p_por UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE v_id UUID; v_email TEXT;
BEGIN
  UPDATE concessoes_de_admin
     SET revogada_em = now(), revogada_por = p_por
   WHERE usuario_id = p_usuario AND revogada_em IS NULL
  RETURNING id, email_no_ato INTO v_id, v_email;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'CONCESSAO_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, entidade_id,
                         acao, classe, de)
  VALUES (NULL, p_por, 'sistema', 'concessao_de_admin', v_id,
          'revogou', 'operacao_interna',
          jsonb_build_object('usuario_id', p_usuario, 'email', v_email));
END;
$$;

REVOKE ALL ON FUNCTION admin.conceder(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.revogar(UUID, UUID) FROM PUBLIC;
