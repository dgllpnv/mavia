-- 0042 · A troca de plano agendada — **P-17**
--
-- ## O defeito
--
-- `POST /v1/cobranca/plano` com um plano menor devolvia
--
--     { "aplicadoEm": "fim_do_periodo", "plano": "pessoal" }
--
-- e **não escrevia nada**. O comentário acima do `return` dizia "registra a
-- intenção para o fim do período — e a tela diz a data exata". A tela dizia. A
-- intenção não era registrada em lugar nenhum, e a data chegava sem que nada
-- acontecesse. Nunca.
--
-- O cliente pede para descer de plano, a tela confirma com data, e ele segue
-- pagando o plano caro para sempre. É a pior forma de um defeito de cobrança:
-- silencioso, a favor de quem cobra, e descoberto pelo cliente.
--
-- ## Por que uma tabela, e não três colunas em `assinaturas`
--
-- Três colunas seriam menos código e resolveriam o caso feliz. O que elas não
-- dariam:
--
-- 1. **Histórico.** "Ele já tinha pedido para descer antes?" é a primeira
--    pergunta de qualquer conversa de cancelamento, e um `UPDATE` sobre coluna
--    não responde.
-- 2. **Arrependimento auditável.** Cancelar a troca é escrever `cancelada_em`,
--    não apagar. Regra 17.
-- 3. **Idempotência do job.** `aplicada_em IS NULL` no `WHERE` é a trava; com
--    coluna em `assinaturas`, a trava seria "o plano já mudou?", que é falsa
--    quando o cliente desce e sobe de novo dentro do mesmo período.
--
-- ## `aplicar_em` é gravado, não calculado na hora de aplicar
--
-- A data é congelada no pedido. Calcular no job leria um `periodo_fim` que o
-- webhook da Stripe move a cada fatura — e a troca andaria para frente sozinha,
-- mês após mês, sem nunca chegar. A tela promete uma data; é essa que vale.
--
-- E a data vem de **`fimEfetivo(periodo_fim, cortesia_ate)`**, nunca de
-- `periodo_fim` cru: se o operador concedeu sessenta dias de cortesia, o
-- cliente comprou o direito de usar até lá. Rebaixar antes disso é o achado
-- F-12 aparecendo num caminho novo.

CREATE TABLE trocas_agendadas (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants (id),

  -- Para onde vai. `TEXT` como em `assinaturas.plano`: acrescentar um plano ao
  -- catálogo não pode exigir migration.
  plano      TEXT NOT NULL,
  intervalo  intervalo_de_cobranca NOT NULL,

  -- De onde saiu, congelado no pedido. Sem isto, a linha diz para onde o
  -- cliente foi e não de onde — e a auditoria de uma troca desfeita fica sem
  -- o outro lado.
  plano_anterior     TEXT NOT NULL,
  intervalo_anterior intervalo_de_cobranca NOT NULL,

  aplicar_em TIMESTAMPTZ NOT NULL,

  pedida_por UUID NOT NULL REFERENCES usuarios (id),
  pedida_em  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- O aviso de sete dias antes. Nulo até sair; gravado uma vez só.
  avisada_em   TIMESTAMPTZ,
  aplicada_em  TIMESTAMPTZ,
  cancelada_em TIMESTAMPTZ,

  -- Uma troca não pode estar aplicada e cancelada. Os dois estados finais são
  -- exclusivos, e sem isto um job que corre junto com um cancelamento produz
  -- uma linha que afirma as duas coisas.
  CONSTRAINT desfecho_unico CHECK (aplicada_em IS NULL OR cancelada_em IS NULL)
);

-- **Uma troca pendente por espaço.** Parcial, porque as encerradas se acumulam
-- e é justamente para isso que elas ficam.
--
-- O índice é o que torna "pedir de novo" uma decisão explícita: sem ele, dois
-- cliques no botão agendariam duas trocas, e a segunda aplicaria sobre um plano
-- que a primeira já tinha mudado.
CREATE UNIQUE INDEX trocas_agendadas_uma_pendente
  ON trocas_agendadas (tenant_id)
  WHERE aplicada_em IS NULL AND cancelada_em IS NULL;

CREATE INDEX trocas_agendadas_a_aplicar
  ON trocas_agendadas (aplicar_em)
  WHERE aplicada_em IS NULL AND cancelada_em IS NULL;

ALTER TABLE trocas_agendadas ENABLE ROW LEVEL SECURITY;
ALTER TABLE trocas_agendadas FORCE ROW LEVEL SECURITY;

-- Mesma forma da política de `assinaturas` (0025:137). `nullif(..., '')` e o
-- segundo argumento `true` do `current_setting` são o que faz a política
-- **recusar** em vez de estourar quando não há tenant no contexto: uma sessão
-- sem espaço vê zero linhas, e não um erro de conversão de UUID vazio.
CREATE POLICY trocas_agendadas_do_tenant ON trocas_agendadas
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON trocas_agendadas TO mavia_app;

-- ---------------------------------------------------------------------------
-- A saída do job
-- ---------------------------------------------------------------------------
-- Mesma forma da `jobs.recorrencias_a_materializar()` (migration 0020): uma
-- função estreita, `SECURITY DEFINER`, que atravessa espaços e devolve **só
-- identificação**. Nada aqui descreve dinheiro — nem o plano, nem o valor.
-- Quem lê o plano é o trabalho, e ele roda sob RLS dentro do espaço certo.
--
-- `pedida_por` sai junto porque o contexto de tenant exige um usuário, e
-- inventar um seria escrever no espaço de alguém sem dizer por quem.
CREATE OR REPLACE FUNCTION jobs.trocas_a_aplicar()
RETURNS TABLE (tenant_id UUID, troca_id UUID, pedida_por UUID)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT t.tenant_id, t.id, t.pedida_por
    FROM trocas_agendadas t
   WHERE t.aplicada_em IS NULL
     AND t.cancelada_em IS NULL
     AND t.aplicar_em <= now()
   ORDER BY t.aplicar_em
$$;

REVOKE ALL ON FUNCTION jobs.trocas_a_aplicar() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jobs.trocas_a_aplicar() TO mavia_app;

-- As que precisam de aviso: sete dias ou menos para aplicar, e ainda não
-- avisadas. Separada da de cima de propósito — avisar e aplicar são disparados
-- por condições diferentes, e uma função que devolvesse as duas obrigaria o
-- worker a redescobrir qual é qual.
CREATE OR REPLACE FUNCTION jobs.trocas_a_avisar()
RETURNS TABLE (tenant_id UUID, troca_id UUID, pedida_por UUID)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT t.tenant_id, t.id, t.pedida_por
    FROM trocas_agendadas t
   WHERE t.aplicada_em IS NULL
     AND t.cancelada_em IS NULL
     AND t.avisada_em IS NULL
     AND t.aplicar_em <= now() + interval '7 days'
   ORDER BY t.aplicar_em
$$;

REVOKE ALL ON FUNCTION jobs.trocas_a_avisar() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jobs.trocas_a_avisar() TO mavia_app;
