-- 0028 — RLS em `eventos_de_cobranca`, a última tabela sem ela.
--
-- Encontrado **verificando o primeiro deploy**, e não em revisão de código: uma
-- consulta ao banco de produção listou as tabelas com `tenant_id` e sem RLS, e
-- devolveu uma.
--
-- A 0025 documentou a escolha, e o raciocínio dela estava certo até onde ia:
--
-- > `eventos_de_cobranca` não é do titular — é registro de integração, chega
-- > **antes** de sabermos de qual espaço é, e o webhook não tem sessão.
--
-- O que faltou é que a tabela **tem** `tenant_id`, preenchido depois pelo
-- próprio webhook, e guarda o **corpo cru** do evento da Stripe: e-mail do
-- cliente, id de assinatura, valores. Sem RLS, qualquer consulta feita por
-- `mavia_app` — a de hoje, ou a que alguém escrever com pressa daqui a um ano —
-- lê o dado de cobrança de todos os espaços.
--
-- A defesa que existia era "nenhum caminho de código lê essa tabela numa sessão
-- de tenant". Isso é exatamente o que a regra 16 recusa: *filtro na aplicação é
-- a segunda camada, nunca a única*.
--
-- **Hoje o risco é zero e é por isso que a hora é agora.** Não há chave da
-- Stripe (P-14), então a tabela está vazia e continuará vazia até a cobrança
-- entrar no ar. Consertar com a tabela vazia é uma migration; consertar depois é
-- uma migration mais um incidente.

-- ---------------------------------------------------------------------------
-- O isolamento
-- ---------------------------------------------------------------------------
ALTER TABLE eventos_de_cobranca ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventos_de_cobranca FORCE  ROW LEVEL SECURITY;

-- **`mavia_app` perde o acesso direto, e não ganha policy nenhuma.** Sem policy
-- que se aplique, a RLS nega tudo — que é o desfecho certo para uma tabela que
-- nenhuma rota autenticada tem razão para ler.
--
-- Revogar o privilégio *e* não dar policy é redundante de propósito: são duas
-- camadas, e a regra 16 pede as duas.
REVOKE SELECT, INSERT, UPDATE, DELETE ON eventos_de_cobranca FROM mavia_app;

-- `mavia_auth` é NOLOGIN e NOBYPASSRLS. As funções abaixo rodam como ele, então
-- precisam de policy — sem ela a RLS as barraria também, e o webhook passaria a
-- falhar em silêncio no `ON CONFLICT DO NOTHING`.
GRANT SELECT, INSERT, UPDATE ON eventos_de_cobranca TO mavia_auth;

CREATE POLICY evento_escrito_pelo_webhook ON eventos_de_cobranca
  FOR ALL TO mavia_auth USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- As duas portas estreitas
-- ---------------------------------------------------------------------------
-- Registrar o evento, e dizer se ele é **novo**.
--
-- O valor de retorno é a defesa 1 do webhook: `false` significa reenvio, e
-- reenvio significa "já tratei". Devolver isso de dentro da função mantém a
-- detecção de replay no mesmo lugar que a escrita — separá-los abriria uma
-- janela em que dois reenvios simultâneos seriam ambos "novos".
CREATE FUNCTION auth.registrar_evento_de_cobranca(
  p_id TEXT, p_tipo TEXT, p_corpo JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO eventos_de_cobranca (id, tipo, corpo)
  VALUES (p_id, p_tipo, p_corpo)
  ON CONFLICT (id) DO NOTHING;

  RETURN FOUND;
END;
$$;

-- Fechar o evento. `p_tenant` e `p_transicao` são nulos quando o evento não se
-- aplicava — e isso **não** é erro: a Stripe manda eventos fora de ordem, e o
-- registro de "chegou e não se aplicou" é o que torna a desordem auditável em
-- vez de invisível.
CREATE FUNCTION auth.concluir_evento_de_cobranca(
  p_id TEXT, p_tenant UUID DEFAULT NULL, p_transicao TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  UPDATE eventos_de_cobranca
     SET processado_em = now(),
         -- `coalesce` para não apagar o que já foi gravado, caso a conclusão
         -- seja chamada duas vezes com o segundo argumento vazio.
         tenant_id = coalesce(p_tenant, tenant_id),
         transicao = coalesce(p_transicao, transicao)
   WHERE id = p_id;
$$;

ALTER FUNCTION auth.registrar_evento_de_cobranca(TEXT, TEXT, JSONB) OWNER TO mavia_auth;
ALTER FUNCTION auth.concluir_evento_de_cobranca(TEXT, UUID, TEXT)  OWNER TO mavia_auth;

GRANT EXECUTE ON FUNCTION auth.registrar_evento_de_cobranca(TEXT, TEXT, JSONB) TO mavia_app;
GRANT EXECUTE ON FUNCTION auth.concluir_evento_de_cobranca(TEXT, UUID, TEXT)  TO mavia_app;
