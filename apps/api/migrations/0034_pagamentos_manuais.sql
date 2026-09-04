-- 0034 · Pagamentos manuais — a tabela que o parecer financeiro reprovou inteira
--
-- Ticket 07. Spec v3.2 §8.1 e §8.2, achados F-1 a F-7 e F-14.
--
-- ## O cenário que esta migration existe para não repetir
--
-- Cliente com cartão recusado entra em `em_atraso`, com catorze dias de graça.
-- Ele liga, paga R$ 79,00 por Pix, o operador dá baixa. **A assinatura não é
-- tocada.** A Stripe continua retentando, a graça continua correndo, e no 15º
-- dia o cliente **que pagou** fica `expirada` e bloqueado — depois de o
-- operador ter dito a ele que estava resolvido.
--
-- Uma ação chamada "dar baixa em pagamento" que não dá baixa em nada é a
-- definição de número errado. Achado F-1.

-- ---------------------------------------------------------------------------
-- 1 · O meio de pagamento — **quatro** valores, e não seis
-- ---------------------------------------------------------------------------
-- `cortesia` e `ajuste` **saíram**, e a decisão é mais forte do que zerar o
-- valor deles (DP-38, achado F-6).
--
-- Zerar consertaria o total e **não** consertaria a exportação: uma linha de
-- R$ 0,00 continuaria saindo ao titular como um pagamento que ele nunca fez, e
-- se a nota fiscal um dia existir, ela nasceria sobre um valor inexistente.
--
-- **A tabela contém só dinheiro que entrou.** É o que torna a exclusão da regra
-- 12b desnecessária por construção, em vez de correta por disciplina — não há
-- linha a excluir de total nenhum. Cortesia virou **tempo**, em dias, na
-- migration 0033.
CREATE TYPE meio_de_pagamento AS ENUM ('pix', 'transferencia', 'boleto', 'dinheiro');

CREATE TABLE pagamentos_manuais (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants (id),

  registrado_por UUID        NOT NULL REFERENCES usuarios (id),
  registrado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- **Quando o dinheiro entrou**, lido no comprovante. Não é o relógio de quem
  -- grava (regra 9: a data de negócio é do servidor, e aqui ela é do documento
  -- bancário, conferida pelo operador).
  recebido_em    TIMESTAMPTZ NOT NULL,

  -- **Derivada, nunca digitada** — achado F-5, e a razão é a regra 7.
  --
  -- Uma baixa lançada às 22h de 30 de setembro em São Paulo vira 1º de outubro
  -- em UTC, e a receita muda de mês. A conversão para `America/Sao_Paulo`
  -- acontece **antes** de extrair mês e ano, e o dia 1 é a invariante de
  -- `Competencia` no `CONTEXT.md`.
  --
  -- É a competência do **recebimento**, não a do período coberto (DP-37). Um
  -- pagamento anual cobre doze competências, e R$ 590,00 e R$ 790,00 **não
  -- dividem por 12 em centavos exatos**: uma linha por competência
  -- reintroduziria no caminho do dinheiro a divisão que a fórmula de reembolso
  -- foi desenhada para não ter.
  competencia    DATE NOT NULL GENERATED ALWAYS AS (
                   (date_trunc('month', recebido_em AT TIME ZONE 'America/Sao_Paulo'))::date
                 ) STORED,

  -- Regra 1 e 2, com as amarras que faltavam (F-7). `INTEGER` estouraria em
  -- R$ 21.474.836,47; `moeda` sem `CHECK` deixaria duas linhas do mesmo tenant
  -- somarem num total que não existe.
  valor_centavos BIGINT  NOT NULL CHECK (valor_centavos > 0),
  moeda          CHAR(3) NOT NULL CHECK (moeda = 'BRL'),
  meio           meio_de_pagamento NOT NULL,

  -- **A chave de idempotência da regra 13**, na forma que esta tabela permite:
  -- end-to-end id do Pix, identificador do comprovante, número do boleto ou do
  -- recibo. Sem ela não há baixa — inclusive para dinheiro em espécie, onde ela
  -- é o número do recibo que alguém precisou emitir.
  --
  -- Achado F-3: sem chave, dois operadores dão baixa no mesmo Pix em horas
  -- diferentes e **nenhum vê a linha do outro**. A escrituração soma R$ 198,00
  -- sobre R$ 99,00 recebidos, e o cliente vê as duas na exportação dele.
  referencia_externa TEXT NOT NULL
                     CHECK (length(btrim(referencia_externa)) BETWEEN 6 AND 140),

  -- Livre e **opcional**. A UI diz, ao lado do campo, que o cliente pode lê-la
  -- se pedir os dados dele — o que alinha o comportamento do operador ao que a
  -- exportação entrega, e mata a categoria "nota interna sobre o cliente que
  -- ninguém previa que sairia".
  observacao     TEXT,

  -- Regra 17. Marca **estorno de baixa registrada por engano**, nunca
  -- eliminação: a linha sobrevive à eliminação do espaço por obrigação fiscal
  -- de cinco anos.
  deleted_at     TIMESTAMPTZ,

  CONSTRAINT competencia_no_dia_1 CHECK (extract(day from competencia) = 1)
);

CREATE UNIQUE INDEX pagamento_manual_unico
  ON pagamentos_manuais (tenant_id, meio, referencia_externa)
  WHERE deleted_at IS NULL;

CREATE INDEX pagamento_manual_por_competencia
  ON pagamentos_manuais (tenant_id, competencia) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2 · RLS e privilégios
-- ---------------------------------------------------------------------------
-- A v2 dizia que a tabela *"não tem caminho de leitura voltado ao tenant"* — o
-- que é verdade e é **propriedade da aplicação, não do banco**. A regra 16 não
-- admite "não existe rota hoje" como fundamento.
ALTER TABLE pagamentos_manuais ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagamentos_manuais FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON pagamentos_manuais
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- **`registrado_por` fica de fora por construção, não por lista de omissão.**
--
-- Ele é o `usuarios.id` de um funcionário da Mavia. Entregá-lo na exportação do
-- titular contraria a decisão do dono (o log de acesso não é exposto ao
-- cliente) **por porta lateral**: o cliente descobriria pelo arquivo o que a
-- decisão determinou não contar.
--
-- E é `GRANT` por coluna, e não filtro no serializador, pelo mesmo motivo do
-- resto do épico: coluna nova não se estende sozinha.
GRANT SELECT (id, valor_centavos, moeda, competencia, recebido_em, meio,
              referencia_externa, observacao, registrado_em)
  ON pagamentos_manuais TO mavia_app;

-- O painel **lê** para mostrar as baixas anteriores antes do botão — achado
-- F-3: sem essa tela, dar baixa é o cenário da duplicidade com outra roupa.
GRANT SELECT (id, tenant_id, valor_centavos, moeda, competencia, recebido_em,
              meio, referencia_externa, observacao, registrado_em, registrado_por,
              deleted_at)
  ON pagamentos_manuais TO mavia_admin;

GRANT SELECT, INSERT ON pagamentos_manuais TO mavia_admin_contrato;

-- ---------------------------------------------------------------------------
-- 3 · Dar baixa — e a baixa **paga** alguma coisa
-- ---------------------------------------------------------------------------
-- A função aplica a transição que a **máquina de estados do domínio** permite
-- para "o dinheiro chegou", e não uma regra inventada aqui:
--
--   · `em_atraso` → `pagamento_recuperado` → `ativa`, e a graça é limpa
--   · `expirada`  → `reativou`             → `ativa`
--   · `ativa`, `teste`, `cancelada`        → registra e **não** muda o estado
--
-- O terceiro caso é deliberado: não há o que recuperar em quem não estava
-- devendo, e mudar o estado ali seria a função decidindo mais do que sabe.
--
-- **`estado` e `graca_ate` são escritos só por aqui.** `CONTEXT.md:408` é
-- literal: *"nenhuma rota de produto escreve `estado`"*. Um `UPDATE` de coluna
-- solta não teria como recusar `expirada → ativa` sem pagamento — achado F-2 —,
-- e é por isso que o privilégio mora no **dono da função**, não num papel de
-- rota.
CREATE FUNCTION admin.registrar_pagamento(
  p_alvo        UUID,
  p_centavos    BIGINT,
  p_meio        meio_de_pagamento,
  p_referencia  TEXT,
  p_recebido_em TIMESTAMPTZ,
  p_observacao  TEXT,
  p_correlacao  UUID
) RETURNS TABLE (id_do_pagamento UUID, estado_novo TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE
  v_operador UUID := nullif(current_setting('app.usuario_id', true), '')::uuid;
  v_estado   TEXT;
  v_novo     TEXT;
  v_id       UUID;
BEGIN
  IF v_operador IS NULL OR NOT admin.tem_concessao_ativa() THEN
    RAISE EXCEPTION 'SEM_CONCESSAO_DE_ADMIN' USING ERRCODE = 'P0001';
  END IF;
  IF p_centavos IS NULL OR p_centavos <= 0 THEN
    RAISE EXCEPTION 'VALOR_INVALIDO' USING ERRCODE = 'P0001';
  END IF;
  -- Data futura recusada na função, e não por `CHECK`: uma `CHECK` com `now()`
  -- não é imutável e o Postgres a recusa na definição da tabela.
  IF p_recebido_em IS NULL OR p_recebido_em > now() THEN
    RAISE EXCEPTION 'RECEBIMENTO_NO_FUTURO' USING ERRCODE = 'P0001';
  END IF;

  SELECT estado::text INTO v_estado FROM assinaturas WHERE tenant_id = p_alvo;
  IF v_estado IS NULL THEN
    RAISE EXCEPTION 'ASSINATURA_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO pagamentos_manuais (tenant_id, registrado_por, recebido_em,
                                  valor_centavos, moeda, meio, referencia_externa,
                                  observacao)
  VALUES (p_alvo, v_operador, p_recebido_em, p_centavos, 'BRL', p_meio,
          p_referencia, nullif(btrim(coalesce(p_observacao, '')), ''))
  RETURNING id INTO v_id;

  v_novo := CASE v_estado
              WHEN 'em_atraso' THEN 'ativa'
              WHEN 'expirada'  THEN 'ativa'
              ELSE v_estado
            END;

  IF v_novo <> v_estado THEN
    UPDATE assinaturas
       SET estado = v_novo::estado_da_assinatura,
           graca_ate = NULL,
           origem_da_ultima_escrita = 'painel'
     WHERE tenant_id = p_alvo;
  END IF;

  -- A segunda linha do par (F-14), com o `de → para` em claro: a baixa de
  -- pagamento é exatamente o caso em que o valor **é** o objeto da mudança.
  INSERT INTO auditoria (tenant_id, usuario_id, ator_tipo, entidade, entidade_id,
                         acao, classe, correlacao, de, para)
  VALUES (p_alvo, v_operador, 'operador', 'pagamento_manual', v_id,
          'deu_baixa', 'escrita_financeira', p_correlacao,
          jsonb_build_object('estado', v_estado),
          jsonb_build_object('estado', v_novo, 'valor_centavos', p_centavos,
                             'moeda', 'BRL', 'meio', p_meio,
                             'referencia_externa', p_referencia));

  RETURN QUERY SELECT v_id, v_novo;
END;
$$;

ALTER FUNCTION admin.registrar_pagamento(UUID, BIGINT, meio_de_pagamento, TEXT,
                                         TIMESTAMPTZ, TEXT, UUID)
  OWNER TO mavia_admin_contrato;

-- De dentro do dono: um `REVOKE` de quem não é mais dono não falha, emite
-- `WARNING` e deixa a função com `EXECUTE` para `PUBLIC`. Ver a `0032`.
SET ROLE mavia_admin_contrato;
REVOKE ALL ON FUNCTION admin.registrar_pagamento(UUID, BIGINT, meio_de_pagamento,
                                                 TEXT, TIMESTAMPTZ, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.registrar_pagamento(UUID, BIGINT, meio_de_pagamento,
                                                    TEXT, TIMESTAMPTZ, TEXT, UUID)
  TO mavia_admin_escrita;
RESET ROLE;
