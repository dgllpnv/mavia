-- 0040 · Ler o registro — por projeção, e não por policy
--
-- Ticket 10. Spec v3.2 §3.3, §1.3 e §6.3.
--
-- ## Por que projeção, e não `GRANT SELECT` com policy
--
-- Uma policy de `SELECT` em `auditoria` para `mavia_admin` daria à conexão do
-- painel a tabela inteira, colunas incluídas — e duas delas, `ip_hash` e
-- `user_agent_hash`, a matriz de acesso veta para **todo** papel: *"existem
-- para investigação de incidente, não para exibição"*.
--
-- Com projeção, as duas colunas **não têm como** sair: elas não estão no tipo
-- de retorno. Não é uma lista que alguém precisa lembrar de manter — é a
-- assinatura da função, e acrescentá-las exigiria mudá-la.
--
-- Daí `mavia_admin` continuar com `INSERT` e **nada mais** em `auditoria`, e a
-- ausência de policy de `SELECT` para ele ser afirmada por teste.
--
-- ## Ler o registro é evento
--
-- A classe é **segurança**, e a rota notifica os outros operadores. Um log que
-- ninguém lê descobre o incidente quando o cliente reclama; um log cuja leitura
-- é silenciosa descobre na mesma hora. A leitura fica registrada como qualquer
-- outro acesso — inclusive a leitura da própria leitura.

CREATE POLICY definer_le_auditoria ON auditoria
  FOR SELECT TO mavia_admin_definer USING (admin.tem_concessao_ativa());

GRANT SELECT ON auditoria TO mavia_admin_definer;

SET ROLE mavia_admin_definer;

CREATE FUNCTION admin.ler_registro(
  p_desde   TIMESTAMPTZ DEFAULT NULL,
  p_tenant  UUID        DEFAULT NULL,
  p_limite  INT         DEFAULT 100
) RETURNS TABLE (
  ocorrido_em TIMESTAMPTZ,
  tenant_id   UUID,
  usuario_id  UUID,
  ator_tipo   TEXT,
  entidade    TEXT,
  entidade_id UUID,
  acao        TEXT,
  classe      TEXT,
  rota        TEXT,
  registros   BIGINT,
  motivo      TEXT,
  referencia  TEXT,
  correlacao  UUID,
  de          JSONB,
  para        JSONB
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE
  v_operador UUID := nullif(current_setting('app.usuario_id', true), '')::uuid;
BEGIN
  IF v_operador IS NULL OR NOT admin.tem_concessao_ativa() THEN
    RAISE EXCEPTION 'SEM_CONCESSAO_DE_ADMIN' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  WITH lidas AS (
    SELECT a.ocorrido_em, a.tenant_id, a.usuario_id, a.ator_tipo::text AS ator_tipo,
           a.entidade, a.entidade_id, a.acao, a.classe::text AS classe,
           a.rota, a.registros, a.motivo::text AS motivo, a.referencia,
           a.correlacao, a.de, a.para
      FROM auditoria a
     WHERE (p_desde IS NULL OR a.ocorrido_em >= p_desde)
       AND (p_tenant IS NULL OR a.tenant_id = p_tenant)
     ORDER BY a.ocorrido_em DESC
     LIMIT greatest(1, least(coalesce(p_limite, 100), 500))
  ),
  registro AS (
    -- **Ler o registro é evento, e classe `seguranca`.** A linha é gravada na
    -- mesma instrução que a leitura, como em toda a família: quem lê não tem
    -- janela entre o dado sair e o registro entrar.
    INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, acao,
                           classe, motivo, referencia, registros, rota)
    SELECT NULL, v_operador, 'operador', 'auditoria', 'leu',
           'seguranca', 'incidente', 'leitura-do-registro', count(*),
           '/v1/admin/registro'
      FROM lidas
    RETURNING 1
  )
  SELECT l.* FROM lidas l WHERE (SELECT count(*) FROM registro) >= 0;
END;
$$;

REVOKE ALL ON FUNCTION admin.ler_registro(TIMESTAMPTZ, UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.ler_registro(TIMESTAMPTZ, UUID, INT) TO mavia_admin;
RESET ROLE;
