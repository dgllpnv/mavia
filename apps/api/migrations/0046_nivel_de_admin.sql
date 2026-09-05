-- 0046 · Superadministrador — quem pode criar administrador
--
-- Pedido do dono em 2026-09-05: *"um superadmin só para o meu usuário, em que a
-- única diferença do admin é a possibilidade de conceder acesso de admin"*.
--
-- ## O que muda, e o que deliberadamente não muda
--
-- **Uma coluna, e nada além dela.** `nivel` decide quem executa
-- `conceder_operador` e `revogar_operador`, e mais nada. Um `super` vê os
-- mesmos clientes, dá as mesmas baixas, lê o mesmo registro. A tentação óbvia
-- — pendurar mais poderes no nível novo enquanto ele está sendo criado — é
-- exatamente como um papel administrativo vira o papel que faz tudo, e aí
-- ninguém consegue mais dizer o que ele faz.
--
-- **`admin.tem_concessao_ativa()` não muda.** Todas as policies e todas as
-- outras funções continuam perguntando "é operador?", e a resposta continua
-- sendo a mesma para os dois níveis. Um `super` que deixasse de ser operador
-- por uma checagem esquecida seria o pior defeito possível aqui.

CREATE TYPE nivel_de_admin AS ENUM ('operador', 'super');

-- `DEFAULT 'operador'` é o que faz esta migration ser segura sobre um banco em
-- produção: as concessões existentes continuam sendo o que eram, e ninguém
-- ganha poder por causa de um `ALTER TABLE`. Promover é ato explícito.
ALTER TABLE concessoes_de_admin
  ADD COLUMN nivel nivel_de_admin NOT NULL DEFAULT 'operador';

COMMENT ON COLUMN concessoes_de_admin.nivel IS
  'operador: tudo no painel. super: idem, mais conceder e revogar operador.';

-- ---------------------------------------------------------------------------
-- A pergunta nova
-- ---------------------------------------------------------------------------
-- Dona `mavia_migrate`, como `tem_concessao_ativa` — as duas são consultadas de
-- dentro de policies, e uma função de policy precisa atravessar a RLS da tabela
-- que ela consulta. É a mesma razão pela qual a irmã dela já é assim.
CREATE OR REPLACE FUNCTION admin.tem_concessao_super() RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM concessoes_de_admin
     WHERE usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid
       AND revogada_em IS NULL
       AND nivel = 'super'
  );
$$;

-- ---------------------------------------------------------------------------
-- A invariante do último super
-- ---------------------------------------------------------------------------
-- **O risco que o dono aceitou, e o que o contém.**
--
-- Com um `super` só, perder aquela conta tira do sistema a capacidade de criar
-- administrador — para sempre, pela via do painel. A saída existe e é
-- deliberadamente fora dele: `conceder-operador.sh` roda como `mavia_migrate`,
-- na VPS, por quem tem acesso ao servidor.
--
-- Dentro do painel, o que contém o risco é este gatilho: **não se revoga nem se
-- rebaixa o último `super`**. Para tirar o super de alguém, promova outro
-- antes. É o mesmo formato de `exigir_dois_admins_ativos`, com um número
-- diferente — um, e não dois, porque o dono pediu explicitamente um super só, e
-- exigir dois contradiria o pedido.
CREATE OR REPLACE FUNCTION exigir_um_super_ativo() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_supers INT;
BEGIN
  -- **Compara o antes com o depois, e não olha só o depois.**
  --
  -- A primeira versão perguntava apenas "alguma linha afetada deixou de ser
  -- super ativa?" — e isso é verdade para *qualquer* revogação de operador
  -- comum, num sistema onde nenhum super existe. Como a coluna nasce
  -- `'operador'` por `DEFAULT`, esse é o estado de **toda instalação existente
  -- no instante seguinte a esta migration**: a contagem daria zero, e revogar
  -- qualquer pessoa ficaria impossível para sempre.
  --
  -- Três testes da suíte de concessões reprovaram com `SUPER_ATIVO_INSUFICIENTE`
  -- e é exatamente esse o defeito que eles descreveram.
  --
  -- A pergunta certa é *"esta instrução tirou alguém que **era** super ativo?"*,
  -- e respondê-la exige `OLD TABLE`. Sem super antes, não há super a proteger.
  IF NOT EXISTS (
    SELECT 1
      FROM antes a JOIN afetadas d ON d.id = a.id
     WHERE a.nivel = 'super' AND a.revogada_em IS NULL
       AND (d.revogada_em IS NOT NULL OR d.nivel <> 'super')
  ) THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_supers
    FROM concessoes_de_admin WHERE revogada_em IS NULL AND nivel = 'super';

  IF v_supers < 1 THEN
    RAISE EXCEPTION 'SUPER_ATIVO_INSUFICIENTE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- `AFTER UPDATE ... FOR EACH STATEMENT` com tabela de transição, como o gatilho
-- irmão: por linha, uma troca de dois supers numa instrução só passaria pelo
-- estado intermediário de zero e seria barrada sem motivo.
CREATE TRIGGER manter_um_super_ativo
  AFTER UPDATE ON concessoes_de_admin
  REFERENCING OLD TABLE AS antes NEW TABLE AS afetadas
  FOR EACH STATEMENT EXECUTE FUNCTION exigir_um_super_ativo();

-- ---------------------------------------------------------------------------
-- Conceder e revogar passam a exigir `super`
-- ---------------------------------------------------------------------------
SET ROLE mavia_admin_contrato;

-- A assinatura ganha `p_nivel`: um `super` pode criar outro `super`, e sem isso
-- o único caminho para sair do super único seria o servidor. Criar um segundo
-- super é a forma sancionada de destravar a revogação do primeiro.
CREATE OR REPLACE FUNCTION admin.conceder_operador(
  p_email      TEXT,
  p_correlacao UUID,
  p_nivel      nivel_de_admin DEFAULT 'operador'
) RETURNS TABLE (id_da_concessao UUID, usuario UUID, ativos INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE
  v_operador UUID := nullif(current_setting('app.usuario_id', true), '')::uuid;
  v_alvo     UUID;
  v_id       UUID;
  v_ativos   INT;
BEGIN
  -- **`tem_concessao_super`, e não `tem_concessao_ativa`.** É a única diferença
  -- entre os dois níveis, e ela vive aqui — não numa condição na tela.
  IF v_operador IS NULL OR NOT admin.tem_concessao_super() THEN
    RAISE EXCEPTION 'EXIGE_SUPERADMIN' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_alvo FROM usuarios
   WHERE lower(email) = lower(btrim(p_email)) AND deleted_at IS NULL;

  IF v_alvo IS NULL THEN
    RAISE EXCEPTION 'USUARIO_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM concessoes_de_admin
              WHERE usuario_id = v_alvo AND revogada_em IS NULL) THEN
    RAISE EXCEPTION 'JA_E_OPERADOR' USING ERRCODE = 'P0001';
  END IF;

  v_id := admin.conceder(v_alvo, v_operador);

  -- O nível é escrito **depois**, porque `admin.conceder` é da `0031` e não o
  -- conhece. Envolver em vez de reescrever mantém `mavia_migrate` como único
  -- dono da função que insere a concessão — e o `UPDATE` aqui é sobre a linha
  -- que acabou de nascer, dentro da mesma transação.
  IF p_nivel <> 'operador' THEN
    UPDATE concessoes_de_admin SET nivel = p_nivel WHERE id = v_id;
  END IF;

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
  IF v_operador IS NULL OR NOT admin.tem_concessao_super() THEN
    RAISE EXCEPTION 'EXIGE_SUPERADMIN' USING ERRCODE = 'P0001';
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

  PERFORM admin.revogar(v_alvo, v_operador);

  SELECT count(*) INTO v_ativos FROM concessoes_de_admin WHERE revogada_em IS NULL;
  RETURN QUERY SELECT v_alvo, v_ativos;
END;
$$;

-- A versão de dois argumentos deixa de existir: o `DEFAULT` cobre as chamadas
-- antigas, e manter as duas produziria `function is not unique` na primeira
-- chamada com dois parâmetros.
DROP FUNCTION IF EXISTS admin.conceder_operador(TEXT, UUID);

REVOKE ALL ON FUNCTION admin.conceder_operador(TEXT, UUID, nivel_de_admin) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.conceder_operador(TEXT, UUID, nivel_de_admin)
  TO mavia_admin_escrita;

RESET ROLE;

-- O dono precisa **escrever `nivel`** na linha recém-criada, e **lê-lo** para a
-- checagem de duplicata. Regra da `0039`: privilégio por coluna, para toda
-- coluna que a instrução toca.
GRANT UPDATE (nivel) ON concessoes_de_admin TO mavia_admin_contrato;
GRANT SELECT (nivel) ON concessoes_de_admin TO mavia_admin_contrato;

-- E o painel lê o **próprio** nível, para saber se mostra a seção de
-- operadores. A policy `concessao_propria` da `0031` já restringe `mavia_admin`
-- à linha dele — esta coluna entra dentro dessa restrição, e não a afrouxa.
GRANT SELECT (nivel) ON concessoes_de_admin TO mavia_admin;
