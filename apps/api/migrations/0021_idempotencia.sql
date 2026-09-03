-- 0021 — Idempotência de mutação: a fila offline reaplica **uma vez só**.
--
-- O app móvel é offline-first: quem lança uma despesa no caixa do mercado sem
-- rede põe a mutação numa fila local e ela sobe quando a rede volta. A rede
-- volta de forma ruim — meio pacote, timeout depois do commit, o processo do
-- app morto entre o envio e a resposta —, e em todos esses casos o cliente
-- **precisa** reenviar sem saber se o primeiro envio chegou.
--
-- Sem esta tabela, reenviar cria a despesa duas vezes. E duas despesas iguais
-- no mesmo minuto é exatamente o que ninguém percebe: parece um erro de
-- digitação da própria pessoa.
--
-- É a regra 13 do `CLAUDE.md` — "toda ingestão externa é idempotente" —
-- aplicada à ingestão que vem do nosso próprio app.

CREATE TABLE mutacoes_idempotentes (
  tenant_id     UUID NOT NULL REFERENCES tenants (id),
  -- A chave é escolhida pelo **cliente**, no momento em que a intenção nasce —
  -- antes de qualquer tentativa de envio. Gerá-la no envio faria cada
  -- retentativa ter uma chave nova, que é o mesmo que não ter chave.
  chave         TEXT NOT NULL,

  -- Método e caminho entram na identidade para que a mesma chave não possa ser
  -- reaproveitada noutra rota: um cliente com defeito reusando a chave de um
  -- lançamento num `DELETE` receberia de volta a resposta do lançamento, e
  -- acharia que apagou.
  metodo        TEXT NOT NULL,
  caminho       TEXT NOT NULL,

  -- O hash do corpo. Mesma chave com corpo diferente é **conflito**, não
  -- repetição: significa que duas intenções distintas nasceram com a mesma
  -- identidade, e devolver a primeira resposta esconderia a segunda.
  corpo_hash    BYTEA NOT NULL,

  status        SMALLINT NOT NULL,
  resposta      JSONB,

  usuario_id    UUID NOT NULL REFERENCES usuarios (id),
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, chave)
);

-- Retenção: a janela de retentativa de um app móvel é de horas, não de meses.
-- Guardar respostas financeiras para sempre seria acumular uma segunda cópia do
-- extrato numa tabela que ninguém audita.
CREATE INDEX mutacoes_para_purga ON mutacoes_idempotentes (criado_em);

ALTER TABLE mutacoes_idempotentes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mutacoes_idempotentes FORCE  ROW LEVEL SECURITY;
CREATE POLICY mutacao_do_tenant ON mutacoes_idempotentes
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, DELETE ON mutacoes_idempotentes TO mavia_app;
