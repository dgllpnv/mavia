-- 0045 · Prorrogação sem teto, e conceder operador pelo painel
--
-- Dois pedidos do dono do produto em 2026-09-05.

SET ROLE mavia_admin_contrato;

-- ---------------------------------------------------------------------------
-- 1 · Prorrogar teste deixa de ter teto
-- ---------------------------------------------------------------------------
-- **Duas travas caem, e uma continua.**
--
-- Caem: o teto de 7 dias (`PRORROGACAO_ALEM_DO_TETO`) e o uso único
-- (`TESTE_JA_PRORROGADO`). Elas eram política de produto, não de segurança, e
-- a política é do dono. Ele decidiu que o operador estende teste à vontade.
--
-- Continua: o **guarda de digitação**. `p_dias > 3650` é recusado, e isso não
-- é um teto de política — é a diferença entre "trinta dias" e "trinta mil dias
-- porque o zero grudou". Dez anos é generoso o bastante para nenhum uso real
-- esbarrar nele, e curto o bastante para um erro de digitação não produzir um
-- teste que termina no ano 3000. Sem ele, o único aviso seria a auditoria, e
-- auditoria é forense: ela conta o que aconteceu, não impede.
--
-- ## A acumulação muda de forma, e é a parte que exige cuidado
--
-- Com uso único, `cortesia_ate = periodo_fim + dias` bastava: a segunda chamada
-- nunca acontecia. Permitindo repetir, essa fórmula **substituiria** em vez de
-- somar — duas chamadas de 30 dias dariam 30, e o operador que quisesse 60
-- concluiria que a segunda não funcionou.
--
-- A base passa a ser o **fim efetivo**, `greatest(periodo_fim, cortesia_ate)`,
-- que é a mesma regra que `fimEfetivo` usa na leitura e a mesma que a
-- `conceder_cortesia` adotou ao corrigir o achado FC-2. Duas regras diferentes
-- para a mesma pergunta foi exatamente como a cortesia passou a valer zero.
CREATE OR REPLACE FUNCTION admin.prorrogar_teste(
  p_alvo       UUID,
  p_dias       INT,
  p_razao      TEXT,
  p_correlacao UUID
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE
  v_operador UUID := nullif(current_setting('app.usuario_id', true), '')::uuid;
  v_estado   TEXT;
  v_base     TIMESTAMPTZ;
  v_antes    TIMESTAMPTZ;
  v_efetivo  TIMESTAMPTZ;
  v_fim      TIMESTAMPTZ;
BEGIN
  IF v_operador IS NULL OR NOT admin.tem_concessao_ativa() THEN
    RAISE EXCEPTION 'SEM_CONCESSAO_DE_ADMIN' USING ERRCODE = 'P0001';
  END IF;
  IF p_dias IS NULL OR p_dias < 1 OR p_dias > 3650 THEN
    RAISE EXCEPTION 'PRORROGACAO_IMPLAUSIVEL' USING ERRCODE = 'P0001';
  END IF;
  IF length(btrim(coalesce(p_razao, ''))) < 3 THEN
    RAISE EXCEPTION 'RAZAO_AUSENTE' USING ERRCODE = 'P0001';
  END IF;

  SELECT estado::text, periodo_fim, cortesia_ate
    INTO v_estado, v_base, v_antes
    FROM assinaturas WHERE tenant_id = p_alvo FOR UPDATE;

  IF v_estado IS NULL THEN
    RAISE EXCEPTION 'ASSINATURA_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;
  IF v_estado <> 'teste' THEN
    RAISE EXCEPTION 'ESTADO_NAO_PERMITE_PRORROGACAO' USING ERRCODE = 'P0001';
  END IF;

  v_efetivo := greatest(v_base, coalesce(v_antes, v_base));
  v_fim := v_efetivo + (p_dias || ' days')::interval;

  UPDATE assinaturas
     SET cortesia_ate = v_fim, origem_da_ultima_escrita = 'painel'
   WHERE tenant_id = p_alvo;

  INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, entidade_id,
                         acao, classe, correlacao, de, para)
  VALUES (p_alvo, v_operador, 'operador', 'assinatura', p_alvo,
          'prorrogou_teste', 'escrita_financeira', p_correlacao,
          jsonb_build_object('cortesia_ate', v_antes, 'fim_efetivo', v_efetivo),
          jsonb_build_object('cortesia_ate', v_fim, 'dias', p_dias,
                             'razao_hash', encode(sha256(convert_to(p_razao, 'UTF8')), 'hex'),
                             'razao_comprimento', length(p_razao)));

  RETURN v_fim;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2 · Conceder e revogar operador pelo painel
-- ---------------------------------------------------------------------------
-- `admin.conceder` e `admin.revogar` já existem desde a `0031`, e o dono delas
-- é `mavia_migrate` — de propósito: elas eram **provisionamento**, executadas
-- por quem roda migration, e não por uma requisição HTTP.
--
-- Expor isso ao painel é escalada de privilégio por desenho, e por isso as duas
-- funções abaixo **não substituem** aquelas: elas envolvem. `mavia_migrate`
-- continua sendo o único dono das originais, e o que o painel executa é este
-- invólucro, que:
--
--   1. exige concessão ativa de quem chama;
--   2. resolve o alvo **por e-mail**, e não por UUID.
--
-- O item 2 é uma decisão de segurança, não de conveniência. Um UUID vindo do
-- corpo de uma requisição é um identificador que o operador não consegue
-- conferir a olho: colar o id errado torna administrador alguém que ele nem
-- sabe quem é. Um e-mail ele lê antes de clicar.
CREATE OR REPLACE FUNCTION admin.conceder_operador(
  p_email      TEXT,
  p_correlacao UUID
) RETURNS TABLE (id_da_concessao UUID, usuario UUID, ativos INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE
  v_operador UUID := nullif(current_setting('app.usuario_id', true), '')::uuid;
  v_alvo     UUID;
  v_id       UUID;
  v_ativos   INT;
BEGIN
  IF v_operador IS NULL OR NOT admin.tem_concessao_ativa() THEN
    RAISE EXCEPTION 'SEM_CONCESSAO_DE_ADMIN' USING ERRCODE = 'P0001';
  END IF;

  -- `lower()` nos dois lados: o índice único de `usuarios` é sobre
  -- `lower(email)`, e procurar sem normalizar não acha quem se cadastrou com
  -- uma maiúscula — o operador veria "não existe" para uma conta que existe.
  SELECT id INTO v_alvo FROM usuarios
   WHERE lower(email) = lower(btrim(p_email)) AND deleted_at IS NULL;

  IF v_alvo IS NULL THEN
    RAISE EXCEPTION 'USUARIO_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;

  -- Já é operador: recusa em vez de criar uma segunda concessão. O índice
  -- parcial `concessao_ativa_unica` recusaria de qualquer forma, com `23505` —
  -- uma mensagem que o operador não sabe ler.
  IF EXISTS (SELECT 1 FROM concessoes_de_admin
              WHERE usuario_id = v_alvo AND revogada_em IS NULL) THEN
    RAISE EXCEPTION 'JA_E_OPERADOR' USING ERRCODE = 'P0001';
  END IF;

  -- Quem concede é **quem está pedindo**, e não o alvo. É o que faz a corrente
  -- de responsabilidade existir na auditoria: cada operador tem um concedente
  -- nominal, até o primeiro, que se concedeu no provisionamento.
  v_id := admin.conceder(v_alvo, v_operador);

  SELECT count(*) INTO v_ativos FROM concessoes_de_admin WHERE revogada_em IS NULL;
  RETURN QUERY SELECT v_id, v_alvo, v_ativos;
END;
$$;

CREATE OR REPLACE FUNCTION admin.revogar_operador(
  p_email      TEXT,
  p_correlacao UUID
) RETURNS TABLE (usuario UUID, ativos INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE
  v_operador UUID := nullif(current_setting('app.usuario_id', true), '')::uuid;
  v_alvo     UUID;
  v_ativos   INT;
BEGIN
  IF v_operador IS NULL OR NOT admin.tem_concessao_ativa() THEN
    RAISE EXCEPTION 'SEM_CONCESSAO_DE_ADMIN' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_alvo FROM usuarios
   WHERE lower(email) = lower(btrim(p_email)) AND deleted_at IS NULL;

  IF v_alvo IS NULL THEN
    RAISE EXCEPTION 'USUARIO_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM concessoes_de_admin
                  WHERE usuario_id = v_alvo AND revogada_em IS NULL) THEN
    RAISE EXCEPTION 'NAO_E_OPERADOR' USING ERRCODE = 'P0001';
  END IF;

  -- **Revogar a si mesmo é permitido**, e não é descuido.
  --
  -- Um operador comprometido que percebe o comprometimento precisa poder se
  -- desligar sem esperar por outro. O que impede o dano real é a invariante
  -- `exigir_dois_admins_ativos`, que barra qualquer revogação que deixe menos
  -- de dois ativos — inclusive esta. Proibir a auto-revogação separadamente
  -- seria uma segunda regra dizendo quase o mesmo, e regras quase iguais
  -- divergem.
  PERFORM admin.revogar(v_alvo, v_operador);

  SELECT count(*) INTO v_ativos FROM concessoes_de_admin WHERE revogada_em IS NULL;
  RETURN QUERY SELECT v_alvo, v_ativos;
END;
$$;

-- ---------------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------------
-- `SET ROLE` no topo do arquivo já fez os invólucros nascerem com o dono certo;
-- o `REVOKE` abaixo acontece de dentro dele pela mesma razão de sempre — um
-- `REVOKE` de quem não é dono emite `WARNING` e não faz nada, deixando a função
-- com `EXECUTE` para `PUBLIC`.
REVOKE ALL ON FUNCTION admin.conceder_operador(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.revogar_operador(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.conceder_operador(TEXT, UUID) TO mavia_admin_escrita;
GRANT EXECUTE ON FUNCTION admin.revogar_operador(TEXT, UUID) TO mavia_admin_escrita;

RESET ROLE;

-- O dono dos invólucros precisa **ler `usuarios`** para resolver o e-mail, e
-- **ler `concessoes_de_admin`** para conferir duplicata e contar ativos.
-- Escrever nas duas continua sendo exclusividade de `admin.conceder` e
-- `admin.revogar`, que rodam como `mavia_migrate`.
--
-- Regra da `0039`, mais uma vez: privilégio de leitura é exigido para **toda
-- coluna que a instrução toca**, inclusive as do `WHERE`.
-- E precisa **executar as originais**, que é o que os invólucros envolvem.
--
-- A concessão é para `mavia_admin_contrato` e não para `mavia_admin_escrita`:
-- quem chama `admin.conceder` é o dono dos invólucros, de dentro deles. O papel
-- de sessão não a alcança — ele só executa o invólucro, que confere concessão
-- ativa antes. Dar `EXECUTE` direto ao papel de sessão deixaria a checagem
-- contornável por uma consulta.
--
-- `mavia_admin_contrato` é `NOLOGIN` (o `provisionar-painel.sh` assere isso a
-- cada execução), então não existe sessão que o assuma para chamar a original
-- diretamente.
GRANT EXECUTE ON FUNCTION admin.conceder(UUID, UUID) TO mavia_admin_contrato;
GRANT EXECUTE ON FUNCTION admin.revogar(UUID, UUID) TO mavia_admin_contrato;

GRANT SELECT (id, email, deleted_at) ON usuarios TO mavia_admin_contrato;
GRANT SELECT (usuario_id, revogada_em) ON concessoes_de_admin TO mavia_admin_contrato;

-- Leitura pelo painel: a tela lista quem são os operadores.
--
-- `email_no_ato` entra, e é a coluna certa para exibir: ela é a cópia do
-- endereço no momento da concessão, e sobrevive à eliminação da conta pelo art.
-- 18 VI — que é precisamente quando saber quem foi operador importa mais.
GRANT SELECT (id, usuario_id, email_no_ato, concedida_em, concedida_por,
              revogada_em, revogada_por)
  ON concessoes_de_admin TO mavia_admin;
