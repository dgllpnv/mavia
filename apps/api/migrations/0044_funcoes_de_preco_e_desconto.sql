-- 0044 · As funções do painel para preço e desconto — **ADR 0025**
--
-- Mesma forma das outras escritas do painel (`0034`): `SECURITY DEFINER`,
-- dono `mavia_admin_contrato`, concessão conferida dentro da função,
-- `EXECUTE` só para `mavia_admin_escrita`, `REVOKE` de dentro do dono.
--
-- O `SET ROLE` antes do `REVOKE` não é cerimônia: um `REVOKE` de quem deixou de
-- ser dono **não falha** — emite `WARNING` e deixa a função com `EXECUTE` para
-- `PUBLIC`. Foi assim que a `0032` quase publicou `abrir_espaco` para qualquer
-- sessão autenticada.

-- ---------------------------------------------------------------------------
-- Ler o preço vigente — a única leitura, e ela é pública ao produto
-- ---------------------------------------------------------------------------
-- **Não é do painel.** A vitrine, o checkout e a tela de plano do cliente
-- precisam do preço vigente, e todos são caminho de cliente. Por isso ela é
-- `STABLE`, sem concessão, e `mavia_app` executa.
--
-- Devolve `NULL` quando a tabela não tem linha para o par — e é o caso normal
-- hoje, porque a `0043` nasce vazia de propósito. Quem chama cai no catálogo em
-- código, que continua sendo a origem.
CREATE OR REPLACE FUNCTION preco_vigente(p_plano TEXT, p_intervalo intervalo_de_cobranca)
RETURNS TABLE (valor_centavos BIGINT, moeda TEXT, stripe_price_id TEXT)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT p.valor_centavos, p.moeda, p.stripe_price_id
    FROM precos_vigentes p
   WHERE p.plano = p_plano
     AND p.intervalo = p_intervalo
     AND p.vigente_desde <= now()
   ORDER BY p.vigente_desde DESC
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION preco_vigente(TEXT, intervalo_de_cobranca) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION preco_vigente(TEXT, intervalo_de_cobranca) TO mavia_app;
GRANT EXECUTE ON FUNCTION preco_vigente(TEXT, intervalo_de_cobranca) TO mavia_admin;

-- ---------------------------------------------------------------------------
-- Criar preço
-- ---------------------------------------------------------------------------
CREATE FUNCTION admin.criar_preco(
  p_plano     TEXT,
  p_intervalo intervalo_de_cobranca,
  p_centavos  BIGINT,
  p_motivo    TEXT,
  p_correlacao UUID,
  p_stripe_price_id TEXT DEFAULT NULL
) RETURNS TABLE (id_do_preco UUID, valor_anterior BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE
  v_operador UUID := nullif(current_setting('app.usuario_id', true), '')::uuid;
  v_anterior BIGINT;
  v_id       UUID;
  v_vivas    BIGINT;
BEGIN
  IF v_operador IS NULL OR NOT admin.tem_concessao_ativa() THEN
    RAISE EXCEPTION 'SEM_CONCESSAO_DE_ADMIN' USING ERRCODE = 'P0001';
  END IF;
  IF p_centavos IS NULL OR p_centavos <= 0 THEN
    RAISE EXCEPTION 'VALOR_INVALIDO' USING ERRCODE = 'P0001';
  END IF;
  IF p_plano IS NULL OR btrim(p_plano) = '' THEN
    RAISE EXCEPTION 'PLANO_INVALIDO' USING ERRCODE = 'P0001';
  END IF;
  IF length(btrim(coalesce(p_motivo, ''))) < 8 THEN
    RAISE EXCEPTION 'MOTIVO_INSUFICIENTE' USING ERRCODE = 'P0001';
  END IF;

  SELECT v.valor_centavos INTO v_anterior FROM preco_vigente(p_plano, p_intervalo) v;

  -- **Preço igual ao vigente é recusado.** Não é preciosismo: uma linha que não
  -- muda nada produz uma entrada de auditoria dizendo que o preço mudou, e
  -- quem ler o histórico depois vai procurar uma mudança que não houve.
  IF v_anterior IS NOT NULL AND v_anterior = p_centavos THEN
    RAISE EXCEPTION 'PRECO_INALTERADO' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO precos_vigentes (plano, intervalo, valor_centavos, moeda,
                               stripe_price_id, criado_por, motivo)
  VALUES (p_plano, p_intervalo, p_centavos, 'BRL',
          nullif(btrim(coalesce(p_stripe_price_id, '')), ''), v_operador, btrim(p_motivo))
  RETURNING id INTO v_id;

  -- **A contagem de assinaturas afetadas, e ela é sempre zero.**
  --
  -- A ADR 0025 exige que a tela mostre esse número, e a função o calcula para
  -- que não seja a tela a afirmá-lo. Zero porque o preço novo vale para vendas
  -- futuras; quem já contratou mantém o preço contratado (grandfathering).
  --
  -- Ela vai para a auditoria em vez de ser devolvida: no dia em que deixar de
  -- ser zero, o registro dirá desde quando.
  SELECT count(*) INTO v_vivas
    FROM assinaturas a
   WHERE a.plano = p_plano AND a.intervalo = p_intervalo
     AND a.estado IN ('ativa', 'em_atraso');

  -- **`auditoria.motivo` é o enum `motivo_de_acesso`**, e não texto livre: ele
  -- guarda a *hipótese de acesso* declarada antes do ato (`chamado`,
  -- `incidente`, …), que é outra coisa. A razão de negócio da mudança vive na
  -- coluna `motivo` de `precos_vigentes` — texto, obrigatório, com mínimo de
  -- oito caracteres — e é repetida no `para` para que a linha de auditoria se
  -- explique sozinha, sem um `JOIN` que quem lê o registro talvez não faça.
  --
  -- A `correlacao` é o que satisfaz `operador_declara_motivo` aqui: trocar
  -- preço não abre espaço de cliente nenhum, então não há hipótese de acesso a
  -- declarar — não se acessou espaço algum.
  INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, entidade_id,
                         acao, classe, correlacao, de, para)
  VALUES (NULL, v_operador, 'operador', 'preco_do_plano', v_id,
          'criou_preco', 'escrita_financeira', p_correlacao,
          -- **Centavos como texto no `jsonb`, e não como número.**
          --
          -- `jsonb` guarda número com precisão arbitrária, mas quem lê este
          -- registro é JavaScript, e `JSON.parse` transforma número em `double`.
          -- Um valor monetário que atravessa um ponto flutuante no caminho até
          -- a tela do operador é exatamente o que a regra 1 proíbe — e o
          -- registro de auditoria é onde alguém vai conferir uma cobrança.
          -- É a mesma convenção do fio: centavos viajam em decimal.
          jsonb_build_object('valor_centavos', v_anterior::text),
          jsonb_build_object('valor_centavos', p_centavos::text, 'moeda', 'BRL',
                             'plano', p_plano, 'intervalo', p_intervalo,
                             'razao', btrim(p_motivo),
                             'assinaturas_vivas_no_par', v_vivas,
                             'assinaturas_afetadas', 0));

  RETURN QUERY SELECT v_id, v_anterior;
END;
$$;

ALTER FUNCTION admin.criar_preco(TEXT, intervalo_de_cobranca, BIGINT, TEXT, UUID, TEXT)
  OWNER TO mavia_admin_contrato;

SET ROLE mavia_admin_contrato;
REVOKE ALL ON FUNCTION admin.criar_preco(TEXT, intervalo_de_cobranca, BIGINT, TEXT, UUID, TEXT)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.criar_preco(TEXT, intervalo_de_cobranca, BIGINT, TEXT, UUID, TEXT)
  TO mavia_admin_escrita;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- Conceder desconto
-- ---------------------------------------------------------------------------
CREATE FUNCTION admin.conceder_desconto(
  p_alvo       UUID,
  p_especie    especie_de_desconto,
  p_pontos_base INTEGER,
  p_centavos   BIGINT,
  p_duracao    duracao_de_desconto,
  p_meses      INTEGER,
  p_motivo     TEXT,
  p_correlacao UUID,
  p_stripe_coupon_id TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE
  v_operador UUID := nullif(current_setting('app.usuario_id', true), '')::uuid;
  v_id       UUID;
  v_anterior UUID;
BEGIN
  IF v_operador IS NULL OR NOT admin.tem_concessao_ativa() THEN
    RAISE EXCEPTION 'SEM_CONCESSAO_DE_ADMIN' USING ERRCODE = 'P0001';
  END IF;
  IF length(btrim(coalesce(p_motivo, ''))) < 8 THEN
    RAISE EXCEPTION 'MOTIVO_INSUFICIENTE' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM assinaturas WHERE tenant_id = p_alvo) THEN
    RAISE EXCEPTION 'ASSINATURA_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;

  -- **Conceder sobre um desconto vivo revoga o anterior, na mesma transação.**
  --
  -- O índice parcial recusaria o segundo de qualquer forma; revogar antes é o
  -- que transforma a recusa do banco numa substituição intencional, com as
  -- duas linhas no histórico. Sem isto, o operador veria `23505` e não saberia
  -- que já havia um desconto — e o cliente ficaria com o antigo.
  UPDATE descontos_de_cliente
     SET revogado_em = now(), revogado_por = v_operador
   WHERE tenant_id = p_alvo AND revogado_em IS NULL
  RETURNING id INTO v_anterior;

  INSERT INTO descontos_de_cliente (tenant_id, especie, pontos_base, valor_centavos,
                                    moeda, duracao, meses, stripe_coupon_id,
                                    motivo, concedido_por)
  VALUES (p_alvo, p_especie,
          CASE WHEN p_especie = 'percentual' THEN p_pontos_base END,
          CASE WHEN p_especie = 'valor'      THEN p_centavos    END,
          'BRL', p_duracao,
          CASE WHEN p_duracao = 'meses' THEN p_meses END,
          nullif(btrim(coalesce(p_stripe_coupon_id, '')), ''),
          btrim(p_motivo), v_operador)
  RETURNING id INTO v_id;

  INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, entidade_id,
                         acao, classe, correlacao, de, para)
  VALUES (p_alvo, v_operador, 'operador', 'desconto', v_id,
          'concedeu_desconto', 'escrita_financeira', p_correlacao,
          jsonb_build_object('desconto_anterior', v_anterior),
          jsonb_build_object('especie', p_especie, 'duracao', p_duracao,
                             'pontos_base', CASE WHEN p_especie = 'percentual' THEN p_pontos_base END,
                             'valor_centavos', CASE WHEN p_especie = 'valor' THEN p_centavos::text END,
                             'meses', CASE WHEN p_duracao = 'meses' THEN p_meses END,
                             'razao', btrim(p_motivo)));

  RETURN v_id;
END;
$$;

ALTER FUNCTION admin.conceder_desconto(UUID, especie_de_desconto, INTEGER, BIGINT,
                                       duracao_de_desconto, INTEGER, TEXT, UUID, TEXT)
  OWNER TO mavia_admin_contrato;

SET ROLE mavia_admin_contrato;
REVOKE ALL ON FUNCTION admin.conceder_desconto(UUID, especie_de_desconto, INTEGER, BIGINT,
                                               duracao_de_desconto, INTEGER, TEXT, UUID, TEXT)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.conceder_desconto(UUID, especie_de_desconto, INTEGER, BIGINT,
                                                  duracao_de_desconto, INTEGER, TEXT, UUID, TEXT)
  TO mavia_admin_escrita;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- Revogar desconto
-- ---------------------------------------------------------------------------
CREATE FUNCTION admin.revogar_desconto(
  p_alvo       UUID,
  p_motivo     TEXT,
  p_correlacao UUID
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE
  v_operador UUID := nullif(current_setting('app.usuario_id', true), '')::uuid;
  v_id       UUID;
BEGIN
  IF v_operador IS NULL OR NOT admin.tem_concessao_ativa() THEN
    RAISE EXCEPTION 'SEM_CONCESSAO_DE_ADMIN' USING ERRCODE = 'P0001';
  END IF;
  IF length(btrim(coalesce(p_motivo, ''))) < 8 THEN
    RAISE EXCEPTION 'MOTIVO_INSUFICIENTE' USING ERRCODE = 'P0001';
  END IF;

  UPDATE descontos_de_cliente
     SET revogado_em = now(), revogado_por = v_operador
   WHERE tenant_id = p_alvo AND revogado_em IS NULL
  RETURNING id INTO v_id;

  -- Nada a revogar é **erro**, e não sucesso silencioso: o operador clicou
  -- achando que havia um desconto. Devolver sucesso o deixaria com a impressão
  -- de ter desfeito algo.
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'SEM_DESCONTO_ATIVO' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, entidade_id,
                         acao, classe, correlacao, de, para)
  VALUES (p_alvo, v_operador, 'operador', 'desconto', v_id,
          'revogou_desconto', 'escrita_financeira', p_correlacao,
          jsonb_build_object('ativo', true),
          jsonb_build_object('ativo', false, 'razao', btrim(p_motivo)));

  RETURN v_id;
END;
$$;

ALTER FUNCTION admin.revogar_desconto(UUID, TEXT, UUID) OWNER TO mavia_admin_contrato;

SET ROLE mavia_admin_contrato;
REVOKE ALL ON FUNCTION admin.revogar_desconto(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.revogar_desconto(UUID, TEXT, UUID) TO mavia_admin_escrita;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- O que o dono das funções precisa ler e escrever
-- ---------------------------------------------------------------------------
-- Regra da `0039`, pela quinta vez: **privilégio de leitura é exigido para toda
-- coluna que uma instrução toca** — `SELECT`, `WHERE`, `RETURNING` —,
-- independentemente de RLS. Faltar um deles produz `permission denied for
-- table` apontando para a tabela e não para a coluna.
GRANT SELECT, INSERT ON precos_vigentes TO mavia_admin_contrato;
GRANT SELECT, INSERT, UPDATE ON descontos_de_cliente TO mavia_admin_contrato;
GRANT EXECUTE ON FUNCTION preco_vigente(TEXT, intervalo_de_cobranca) TO mavia_admin_contrato;

-- Leitura pelo painel: o operador vê o histórico de preço e o desconto vigente.
-- `motivo` e `criado_por` **entram** aqui — diferente do cliente, o operador é
-- justamente quem precisa saber quem mudou o quê e por quê.
GRANT SELECT ON precos_vigentes TO mavia_admin;
GRANT SELECT ON descontos_de_cliente TO mavia_admin;
