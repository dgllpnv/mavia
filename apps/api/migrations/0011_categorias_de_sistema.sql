-- 0011 — Categorias de sistema nascem com o tenant.
--
-- A migration 0010 semeou `Ajuste de saldo` nos tenants que **existiam naquele
-- momento**. Todo tenant criado depois nascia sem ela — e o defeito era
-- silencioso: o usuário só descobriria ao tentar conciliar um saldo e não
-- encontrar a categoria.
--
-- Semear numa migration resolve o passado e não o futuro. O gatilho resolve os
-- dois, e não depende de quem criou o tenant: `auth.confirmar_cadastro`,
-- `auth.cadastrar_federado` e `auth.criar_tenant` são três caminhos, e semear
-- em cada um seria três lugares para esquecer.

-- No esquema `auth`, e não em `public`: ser dono de uma função exige CREATE
-- no esquema que a contém, e `mavia_auth` só tem isso no esquema dele. Dar
-- CREATE em `public` a `mavia_auth` seria alargar o papel para resolver um
-- problema de endereço.
CREATE FUNCTION auth.semear_categorias_de_sistema() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  -- `Ajuste de saldo` existe para o dia em que o saldo do produto não bate com
  -- o do banco e o usuário concilia a diferença. É movimento de saldo sem ser
  -- gasto nem ganho: `analitica = false` o mantém fora do relatório de
  -- categoria e de todo `Planejamento`, e o balde `nao_analitica` o mantém
  -- visível no rodapé — que é o que faz a identidade fechar.
  --
  -- Uma por natureza: ajustar para cima é receita, para baixo é despesa, e o
  -- sinal precisa concordar com a natureza (`lancamento_coerente`).
  INSERT INTO categorias (tenant_id, nivel, nome, natureza, analitica, sistema)
  VALUES (NEW.id, 1, 'Ajuste de saldo', 'receita', FALSE, TRUE),
         (NEW.id, 1, 'Ajuste de saldo', 'despesa', FALSE, TRUE);

  -- `Sem categoria` é o destino do lançamento importado que a categorização
  -- automática não soube classificar. É analítica de propósito: o gasto é real
  -- e precisa aparecer no relatório, ainda que sem nome melhor.
  INSERT INTO categorias (tenant_id, nivel, nome, natureza, analitica, sistema)
  VALUES (NEW.id, 1, 'Sem categoria', 'receita', TRUE, TRUE),
         (NEW.id, 1, 'Sem categoria', 'despesa', TRUE, TRUE);

  RETURN NEW;
END;
$$;

-- `SECURITY DEFINER` e dono `mavia_auth`: o gatilho dispara dentro de
-- `auth.criar_tenant`, cujo chamador é `mavia_app` — que não tem `INSERT` em
-- `categorias` no momento em que o tenant nasce, porque `app.tenant_id` ainda
-- não aponta para ele.
ALTER FUNCTION auth.semear_categorias_de_sistema() OWNER TO mavia_auth;

CREATE TRIGGER semear_categorias_de_sistema_trg
  AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION auth.semear_categorias_de_sistema();

GRANT INSERT ON categorias TO mavia_auth;

-- A policy de `categorias` filtra por `app.tenant_id`, que ainda não está
-- definido quando o tenant nasce. `mavia_auth` precisa da própria, restrita ao
-- que o gatilho faz.
CREATE POLICY cadastro_semeia_categorias ON categorias
  FOR INSERT TO mavia_auth
  WITH CHECK (sistema = TRUE);

-- Categoria de sistema não se exclui: apagar `Ajuste de saldo` deixaria o
-- histórico de conciliação órfão, e apagar `Sem categoria` quebraria a
-- importação.
CREATE FUNCTION categoria_de_sistema_nao_some() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sistema AND NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    RAISE EXCEPTION 'CATEGORIA_DE_SISTEMA_NAO_SOME' USING ERRCODE = 'P0001';
  END IF;
  -- Arquivar é permitido: some dos seletores e continua classificando o
  -- histórico. É a diferença entre esconder e destruir.
  RETURN NEW;
END;
$$;

CREATE TRIGGER categoria_de_sistema_nao_some_trg
  BEFORE UPDATE ON categorias
  FOR EACH ROW EXECUTE FUNCTION categoria_de_sistema_nao_some();
