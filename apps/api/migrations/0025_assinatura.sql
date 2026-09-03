-- 0025 — Assinatura, cotas e o webhook idempotente.
--
-- Implementa o épico 11 e o `docs/produto/spec-planos-e-assinatura.md`.
--
-- **O catálogo não está aqui.** Preço e cota vivem em código
-- (`packages/domain/catalogo.ts`), pela mesma razão da política de retenção:
-- configuração versionada em código não é alterável em produção sem deploy e
-- sem teste. Uma tabela de preços é uma tabela que alguém edita às pressas numa
-- madrugada, e o preço errado só aparece na fatura do cliente.
--
-- O que está aqui é o **estado**: em que ponto do ciclo cada espaço está.

CREATE TYPE estado_da_assinatura AS ENUM
  ('teste', 'ativa', 'em_atraso', 'cancelada', 'expirada');

CREATE TYPE intervalo_de_cobranca AS ENUM ('mensal', 'anual');

CREATE TABLE assinaturas (
  -- Uma por espaço, e a chave primária diz isso. Duas assinaturas para o mesmo
  -- tenant seriam duas respostas para "posso escrever?".
  tenant_id      UUID PRIMARY KEY REFERENCES tenants (id),

  estado         estado_da_assinatura NOT NULL DEFAULT 'teste',
  -- Código do catálogo, validado em código. Não é enum de banco de propósito:
  -- acrescentar um plano não pode exigir migration.
  plano          TEXT NOT NULL DEFAULT 'pessoal',
  intervalo      intervalo_de_cobranca NOT NULL DEFAULT 'mensal',

  -- Janela semiaberta `[periodo_inicio, periodo_fim)`, como toda janela do
  -- sistema (regra 7).
  periodo_inicio TIMESTAMPTZ NOT NULL DEFAULT now(),
  periodo_fim    TIMESTAMPTZ NOT NULL,

  -- Quando a graça de 14 dias acaba. Nulo fora de `em_atraso`.
  graca_ate      TIMESTAMPTZ,

  -- Identificadores da Stripe. Nulos enquanto o espaço está em teste — e o
  -- teste **não pede cartão**, então eles são nulos na maioria das linhas.
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,

  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ,

  CONSTRAINT periodo_semiaberto CHECK (periodo_fim > periodo_inicio),
  -- `graca_ate` existe se e somente se o estado é `em_atraso`: uma data de
  -- graça sobrando num estado ativo faria um job expirar quem está pagando.
  CONSTRAINT graca_so_em_atraso
    CHECK ((estado = 'em_atraso') = (graca_ate IS NOT NULL))
);

CREATE INDEX assinaturas_por_estado ON assinaturas (estado, periodo_fim);
CREATE UNIQUE INDEX assinatura_por_stripe
  ON assinaturas (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Toda tenant nasce em teste
-- ---------------------------------------------------------------------------
-- Gatilho, e não responsabilidade da aplicação: um espaço sem assinatura é um
-- espaço cuja pergunta "posso escrever?" não tem resposta, e o caminho que
-- esquecer de criar a linha produziria exatamente isso.
-- **`SECURITY DEFINER`**, e a razão é dupla:
--
-- 1. o cadastro roda como `mavia_auth`, que não tem escrita em `assinaturas`;
-- 2. quando `mavia_app` cria um espaço, `app.tenant_id` ainda aponta para o
--    espaço **anterior** — o novo acabou de nascer. A policy de `WITH CHECK`
--    recusaria a linha, e a criação de espaço falharia com um erro sobre uma
--    tabela que quem criou o espaço nem mencionou.
--
-- A invariante "todo espaço tem assinatura" é do sistema, e não de quem
-- escreve. Por isso ela executa com a identidade do sistema.
-- No esquema `auth`, e não em `public`: o dono precisa poder criar a função
-- onde ela vive, e `mavia_auth` é dono de `auth` — dar-lhe CREATE em `public`
-- para hospedar um gatilho seria alargar o papel por uma questão de endereço.
CREATE FUNCTION auth.assinatura_de_teste() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO assinaturas (tenant_id, estado, periodo_inicio, periodo_fim)
  VALUES (NEW.id, 'teste', now(), now() + interval '7 days')
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

ALTER FUNCTION auth.assinatura_de_teste() OWNER TO mavia_auth;

CREATE TRIGGER assinatura_de_teste_trg
  AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION auth.assinatura_de_teste();

-- As permissões vêm antes do primeiro uso: o `INSERT` de recuperação abaixo já
-- dispara nada, mas o gatilho passa a valer para todo espaço criado a partir
-- daqui, inclusive no meio desta mesma migration.
GRANT SELECT, INSERT, UPDATE ON assinaturas TO mavia_auth;
ALTER TABLE assinaturas ENABLE ROW LEVEL SECURITY;
ALTER TABLE assinaturas FORCE  ROW LEVEL SECURITY;
CREATE POLICY assinatura_criada_pelo_gatilho ON assinaturas FOR INSERT TO mavia_auth
  WITH CHECK (true);

-- Os espaços que já existem entram no mesmo estado, com o teste contado da
-- criação deles — e não de agora, que daria sete dias grátis a quem já usa há
-- meses.
INSERT INTO assinaturas (tenant_id, estado, periodo_inicio, periodo_fim)
SELECT t.id, 'teste', t.criado_em, t.criado_em + interval '7 days'
  FROM tenants t
 WHERE NOT EXISTS (SELECT 1 FROM assinaturas a WHERE a.tenant_id = t.id);

-- ---------------------------------------------------------------------------
-- O webhook
-- ---------------------------------------------------------------------------
-- A Stripe **reenvia**. Entrega ao menos uma vez, fora de ordem, e repete
-- quando a nossa resposta demora. Sem esta tabela, um `invoice.payment_failed`
-- reentregue depois de o cliente já ter pago o colocaria de volta em atraso.
CREATE TABLE eventos_de_cobranca (
  -- O id do evento **na Stripe**. É ele que torna o reenvio detectável.
  id             TEXT PRIMARY KEY,
  tipo           TEXT NOT NULL,
  tenant_id      UUID REFERENCES tenants (id),
  recebido_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processado_em  TIMESTAMPTZ,
  -- O que a máquina de estados decidiu. Nulo quando o evento não se aplicava —
  -- e isso **não** é erro: a Stripe manda eventos fora de ordem.
  transicao      TEXT,
  corpo          JSONB NOT NULL
);

CREATE INDEX eventos_por_tenant ON eventos_de_cobranca (tenant_id, recebido_em DESC);

-- ---------------------------------------------------------------------------
-- Isolamento
-- ---------------------------------------------------------------------------
-- `assinaturas` tem RLS como toda tabela de negócio. `eventos_de_cobranca` não
-- é do titular — é registro de integração, chega **antes** de sabermos de qual
-- espaço é, e o webhook não tem sessão. Fica sem RLS, e o acesso a ela é só
-- pela rota de webhook, que é pública por assinatura criptográfica.
CREATE POLICY assinatura_do_tenant ON assinaturas
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON assinaturas TO mavia_app;
GRANT SELECT, INSERT, UPDATE ON eventos_de_cobranca TO mavia_app;

-- ---------------------------------------------------------------------------
-- A leitura pré-tenant do webhook
-- ---------------------------------------------------------------------------
-- O webhook chega sem sessão e sem tenant: quem diz de qual espaço ele é são os
-- identificadores da Stripe. É o mesmo galinha-e-ovo do login, e a mesma saída —
-- função `SECURITY DEFINER` estreita, que recebe um identificador exato e
-- devolve no máximo uma linha.
CREATE FUNCTION auth.assinatura_por_stripe(p_subscription TEXT)
RETURNS TABLE (id_do_tenant UUID, estado_atual estado_da_assinatura)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT tenant_id, estado FROM assinaturas WHERE stripe_subscription_id = p_subscription;
$$;

ALTER FUNCTION auth.assinatura_por_stripe(TEXT) OWNER TO mavia_auth;
REVOKE ALL ON FUNCTION auth.assinatura_por_stripe(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.assinatura_por_stripe(TEXT) TO mavia_app;
GRANT SELECT, INSERT, UPDATE ON assinaturas TO mavia_auth;

-- O webhook lê e escreve como `mavia_auth`. As policies são `true` porque a
-- estreiteza mora noutro lugar: nenhuma função de `auth` devolve conjunto.
CREATE POLICY assinatura_lida_pelo_webhook ON assinaturas FOR SELECT TO mavia_auth USING (true);
CREATE POLICY assinatura_escrita_pelo_webhook ON assinaturas FOR UPDATE TO mavia_auth
  USING (true) WITH CHECK (true);

-- A transição vinda do webhook, também estreita: recebe o identificador da
-- Stripe e o estado de destino, e não aceita `tenant_id`.
CREATE FUNCTION auth.aplicar_estado_da_assinatura(
  p_subscription TEXT,
  p_estado estado_da_assinatura,
  p_graca_ate TIMESTAMPTZ,
  p_periodo_fim TIMESTAMPTZ
)
RETURNS TABLE (id_do_tenant UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN QUERY
  UPDATE assinaturas
     SET estado = p_estado,
         graca_ate = CASE WHEN p_estado = 'em_atraso' THEN p_graca_ate END,
         periodo_fim = coalesce(p_periodo_fim, periodo_fim),
         atualizado_em = now()
   WHERE stripe_subscription_id = p_subscription
  RETURNING assinaturas.tenant_id;
END;
$$;

ALTER FUNCTION auth.aplicar_estado_da_assinatura(TEXT, estado_da_assinatura, TIMESTAMPTZ, TIMESTAMPTZ)
  OWNER TO mavia_auth;
REVOKE ALL ON FUNCTION auth.aplicar_estado_da_assinatura(TEXT, estado_da_assinatura, TIMESTAMPTZ, TIMESTAMPTZ)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.aplicar_estado_da_assinatura(TEXT, estado_da_assinatura, TIMESTAMPTZ, TIMESTAMPTZ)
  TO mavia_app;
