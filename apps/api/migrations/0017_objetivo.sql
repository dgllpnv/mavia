-- 0017 — Objetivo: acúmulo plurimensal com prazo, e o Aporte que o alimenta.
--
-- Ver ADR 0009 e o verbete `Objetivo` no `CONTEXT.md`.
--
-- **Objetivo nunca move dinheiro.** Nada nesta migration cria, altera ou
-- exclui `lancamentos`. O que ela faz é observar: derivar progresso e gravar o
-- instante em que o alvo foi cruzado.

CREATE TABLE objetivos (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants (id),
  nome                TEXT NOT NULL,

  -- **Sempre positivo.** A convenção de sinal do ADR 0005 governa movimentos;
  -- `valor_alvo` é estoque-alvo, e um saldo de destino não tem direção a
  -- codificar. Inventar um sinal aqui carregaria a convenção onde ela não
  -- significa nada.
  valor_alvo_centavos BIGINT NOT NULL,
  moeda               CHAR(3) NOT NULL DEFAULT 'BRL',

  -- Opcional: sem prazo, o Objetivo nunca vence. É a reserva de emergência,
  -- que não tem data e não deveria ser forçada a inventar uma.
  prazo               DATE,

  -- O modo de apuração é **derivado** desta coluna, e não há enum ao lado:
  -- preenchida = ancorado, nula = por aportes. Pelo mesmo motivo que
  -- `Planejamento` não persiste `natureza` — um enum ao lado do dado pode
  -- contradizê-lo.
  conta_id            UUID REFERENCES contas (id),

  -- Marco histórico **armazenado**, capturado na criação. Nunca derivado de
  -- uma data: se fosse recalculado como "o saldo em tal dia", um lançamento
  -- retroativo mudaria o saldo do passado e o progresso subiria sozinho.
  saldo_base_centavos BIGINT,

  concluido_em        TIMESTAMPTZ,

  criado_por          UUID NOT NULL REFERENCES usuarios (id),
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em       TIMESTAMPTZ,
  deleted_at          TIMESTAMPTZ,

  CONSTRAINT alvo_positivo CHECK (valor_alvo_centavos > 0),

  -- Invariante 4: `saldo_base` existe se e somente se `conta_id` existe.
  CONSTRAINT marco_acompanha_a_conta
    CHECK ((conta_id IS NULL) = (saldo_base_centavos IS NULL))
);

CREATE INDEX objetivos_por_tenant ON objetivos (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX objetivos_por_conta  ON objetivos (tenant_id, conta_id)
  WHERE conta_id IS NOT NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Aporte — o vínculo entre um Lancamento e um Objetivo por aportes
-- ---------------------------------------------------------------------------
CREATE TABLE aportes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants (id),
  objetivo_id   UUID NOT NULL REFERENCES objetivos (id),
  lancamento_id UUID NOT NULL REFERENCES lancamentos (id),
  criado_por    UUID NOT NULL REFERENCES usuarios (id),
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- Invariante 11: um Lancamento pertence a no máximo um Objetivo. Sem isto, o
-- mesmo depósito contaria para dois objetivos e a soma deles seria patrimônio
-- que não existe.
CREATE UNIQUE INDEX aporte_do_lancamento
  ON aportes (tenant_id, lancamento_id) WHERE deleted_at IS NULL;

CREATE INDEX aportes_por_objetivo
  ON aportes (tenant_id, objetivo_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Coerência do Objetivo
-- ---------------------------------------------------------------------------
CREATE FUNCTION objetivo_e_coerente() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_moeda CHAR(3);
BEGIN
  IF NEW.conta_id IS NOT NULL THEN
    SELECT moeda INTO v_moeda FROM contas
     WHERE id = NEW.conta_id AND tenant_id = NEW.tenant_id AND deleted_at IS NULL;

    IF v_moeda IS NULL THEN
      RAISE EXCEPTION 'CONTA_INEXISTENTE' USING ERRCODE = 'P0001';
    END IF;

    -- Invariante 2: sem conversão silenciosa, nunca.
    IF v_moeda <> NEW.moeda THEN
      RAISE EXCEPTION 'MOEDA_DIVERGENTE_DA_CONTA' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- O modo de apuração é decidido na criação e não muda. Trocar de ancorado
  -- para por aportes deixaria um marco órfão; o caminho inverso teria de
  -- inventar um marco e descartar os aportes existentes. Quem quer o outro
  -- modo cria outro Objetivo.
  IF TG_OP = 'UPDATE' AND NEW.conta_id IS DISTINCT FROM OLD.conta_id THEN
    RAISE EXCEPTION 'MODO_DE_APURACAO_NAO_MUDA' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER objetivo_e_coerente_trg
  BEFORE INSERT OR UPDATE ON objetivos
  FOR EACH ROW EXECUTE FUNCTION objetivo_e_coerente();

CREATE FUNCTION aporte_e_coerente() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_ancorado BOOLEAN; v_moeda_obj CHAR(3); v_moeda_lan CHAR(3); v_conta_lan UUID;
BEGIN
  SELECT (conta_id IS NOT NULL), moeda INTO v_ancorado, v_moeda_obj
    FROM objetivos
   WHERE id = NEW.objetivo_id AND tenant_id = NEW.tenant_id AND deleted_at IS NULL;

  IF v_ancorado IS NULL THEN
    RAISE EXCEPTION 'OBJETIVO_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;

  -- Invariante 6: um Objetivo ancorado não aceita Aporte. Seu progresso já é
  -- o saldo da Conta, e somar os dois contaria o mesmo dinheiro duas vezes.
  IF v_ancorado THEN
    RAISE EXCEPTION 'OBJETIVO_ANCORADO_NAO_ACEITA_APORTE' USING ERRCODE = 'P0001';
  END IF;

  SELECT moeda, conta_id INTO v_moeda_lan, v_conta_lan
    FROM lancamentos
   WHERE id = NEW.lancamento_id AND tenant_id = NEW.tenant_id AND deleted_at IS NULL;

  IF v_moeda_lan IS NULL THEN
    RAISE EXCEPTION 'LANCAMENTO_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;

  IF v_moeda_lan <> v_moeda_obj THEN
    RAISE EXCEPTION 'MOEDA_DIVERGENTE_DO_OBJETIVO' USING ERRCODE = 'P0001';
  END IF;

  -- Lançamento de **cartão** não é aporte. O ADR 0009 não trata do caso, mas a
  -- regra 8b do `CLAUDE.md` trata: o eixo caixa agrega Contas e Faturas, nunca
  -- lançamentos de Cartao. Uma compra marcada como aporte somaria ao progresso
  -- um dinheiro que ainda está no bolso e que vai sair de novo pela fatura — o
  -- mesmo real contado duas vezes.
  IF v_conta_lan IS NULL THEN
    RAISE EXCEPTION 'LANCAMENTO_DE_CARTAO_NAO_E_APORTE' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER aporte_e_coerente_trg
  BEFORE INSERT OR UPDATE ON aportes
  FOR EACH ROW EXECUTE FUNCTION aporte_e_coerente();

-- ---------------------------------------------------------------------------
-- Progresso
-- ---------------------------------------------------------------------------
-- **Só conta dinheiro que se moveu**, nos dois modos: `settled_at IS NOT NULL`.
--
-- No modo ancorado isso é consequência da definição de saldo. No modo por
-- aportes o ADR 0009 diz apenas "Σ valor dos Lancamentos ligados", sem tratar
-- de lançamento pendente — e ele **é** tratado aqui, na direção que o próprio
-- ADR repete duas vezes: *"Objetivo observa dinheiro que se moveu"*. Contar
-- aporte não compensado deixaria o progresso subir com uma transferência
-- agendada para o mês que vem, e os dois modos discordariam sobre o que é
-- progresso.
CREATE FUNCTION progresso_do_objetivo(p_objetivo objetivos) RETURNS BIGINT
LANGUAGE plpgsql STABLE AS $$
DECLARE v BIGINT;
BEGIN
  IF p_objetivo.conta_id IS NOT NULL THEN
    SELECT coalesce(c.saldo_inicial_centavos, 0)
         + coalesce((SELECT sum(l.valor_centavos) FROM lancamentos l
                      WHERE l.tenant_id = p_objetivo.tenant_id
                        AND l.conta_id = p_objetivo.conta_id
                        AND l.deleted_at IS NULL
                        AND l.settled_at IS NOT NULL), 0)
         - p_objetivo.saldo_base_centavos
      INTO v
      FROM contas c
     WHERE c.id = p_objetivo.conta_id AND c.tenant_id = p_objetivo.tenant_id;

    RETURN coalesce(v, 0);
  END IF;

  SELECT coalesce(sum(l.valor_centavos), 0) INTO v
    FROM aportes a
    JOIN lancamentos l ON l.id = a.lancamento_id AND l.tenant_id = a.tenant_id
   WHERE a.tenant_id = p_objetivo.tenant_id
     AND a.objetivo_id = p_objetivo.id
     AND a.deleted_at IS NULL
     AND l.deleted_at IS NULL
     AND l.settled_at IS NOT NULL;

  RETURN v;
END;
$$;

-- ---------------------------------------------------------------------------
-- A travessia
-- ---------------------------------------------------------------------------
-- `concluido_em` é gravado **na transação que altera o progresso**, nunca na
-- leitura da tela. Apurado na leitura, "primeira travessia" viraria "primeira
-- vez que alguém abriu a tela": um objetivo atingido em 10/set e resgatado em
-- 15/out, aberto em 20/out, mostraria R$ 7.000 de R$ 10.000 e nunca teria
-- `concluido_em`.
--
-- **`p_redefiniu_o_alvo` é a assimetria do ADR 0009, e é a única regra dele que
-- precisa ser lida duas vezes.** A fixidez protege o fato contra o *movimento
-- do dinheiro*, não contra a *redefinição do alvo*:
--
--   - o progresso caiu (resgate) → a conclusão **fica**. Atingir foi um fato
--     histórico com data, e quem sacou está dizendo que gastou;
--   - o alvo subiu acima do progresso → a conclusão **é limpa**. Quem eleva o
--     alvo está dizendo que o objetivo é outro.
--
-- O discriminador é qual gatilho disparou, e não um campo: há uma
-- implementação só, com três portas de entrada.
CREATE FUNCTION reavaliar_objetivo(p_id UUID, p_redefiniu_o_alvo BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE o objetivos; v_progresso BIGINT;
BEGIN
  SELECT * INTO o FROM objetivos WHERE id = p_id AND deleted_at IS NULL;
  IF o.id IS NULL THEN RETURN; END IF;

  v_progresso := progresso_do_objetivo(o);

  IF v_progresso >= o.valor_alvo_centavos THEN
    IF o.concluido_em IS NULL THEN
      -- Reduzir o alvo para valor já alcançado conclui **na hora**, com a data
      -- de agora — e depois de um ciclo limpa-e-conclui, com uma data nova.
      UPDATE objetivos SET concluido_em = now(), atualizado_em = now() WHERE id = o.id;
    END IF;
  ELSIF p_redefiniu_o_alvo AND o.concluido_em IS NOT NULL THEN
    UPDATE objetivos SET concluido_em = NULL, atualizado_em = now() WHERE id = o.id;
  END IF;
END;
$$;

-- Porta 1 — o alvo mudou. É a única que limpa.
CREATE FUNCTION objetivo_alvo_mudou() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.valor_alvo_centavos IS DISTINCT FROM OLD.valor_alvo_centavos THEN
    PERFORM reavaliar_objetivo(NEW.id, TRUE);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER objetivo_alvo_mudou_trg
  AFTER UPDATE OF valor_alvo_centavos ON objetivos
  FOR EACH ROW EXECUTE FUNCTION objetivo_alvo_mudou();

-- Porta 2 — o conjunto de aportes mudou.
CREATE FUNCTION aporte_mudou() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM reavaliar_objetivo(coalesce(NEW.objetivo_id, OLD.objetivo_id), FALSE);
  RETURN NULL;
END;
$$;

CREATE TRIGGER aporte_mudou_trg
  AFTER INSERT OR UPDATE OR DELETE ON aportes
  FOR EACH ROW EXECUTE FUNCTION aporte_mudou();

-- Porta 3 — um lançamento mudou o saldo de uma conta, ou o valor de um aporte.
--
-- É esta porta que obriga a travessia a morar no banco: um lançamento é escrito
-- por caminhos que não conhecem Objetivo nenhum — manual, perna de
-- transferência, parcela, estorno, ingestão em lote. O gatilho é o único lugar
-- por onde todos passam.
--
-- **O reajuste de `saldo_base` vem antes da reavaliação**, e é o que impede o
-- retroativo anterior à criação de inventar progresso: importar em setembro um
-- depósito feito em agosto sobe o saldo e sobe o marco pelo mesmo valor, de
-- modo que o progresso não se mexe. O dinheiro já estava lá quando o marco foi
-- capturado; só não estava registrado. `saldo_base` congela o saldo *conhecido*
-- e o reajuste o corrige para o *real* daquele instante.
CREATE FUNCTION objetivos_seguem_o_lancamento() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant UUID := NEW.tenant_id;
  -- O efeito de uma linha sobre o saldo da conta: zero quando não compensou,
  -- quando foi apagada, ou quando é de cartão.
  v_efeito_novo BIGINT := 0;
  v_efeito_velho BIGINT := 0;
  o RECORD;
BEGIN
  IF NEW.deleted_at IS NULL AND NEW.settled_at IS NOT NULL AND NEW.conta_id IS NOT NULL THEN
    v_efeito_novo := NEW.valor_centavos;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL AND OLD.settled_at IS NOT NULL
     AND OLD.conta_id IS NOT NULL THEN
    v_efeito_velho := OLD.valor_centavos;
  END IF;

  -- As duas pontas são tratadas separadamente: um lançamento que troca de conta
  -- retira o efeito de uma e acrescenta à outra, e um objetivo ancorado em cada
  -- uma tem de ver o seu lado do movimento.
  IF v_efeito_velho <> 0 THEN
    FOR o IN SELECT * FROM objetivos
              WHERE tenant_id = v_tenant AND conta_id = OLD.conta_id AND deleted_at IS NULL
    LOOP
      IF OLD.settled_at < o.criado_em THEN
        UPDATE objetivos SET saldo_base_centavos = saldo_base_centavos - v_efeito_velho
         WHERE id = o.id;
      END IF;
    END LOOP;
  END IF;

  IF v_efeito_novo <> 0 THEN
    FOR o IN SELECT * FROM objetivos
              WHERE tenant_id = v_tenant AND conta_id = NEW.conta_id AND deleted_at IS NULL
    LOOP
      IF NEW.settled_at < o.criado_em THEN
        UPDATE objetivos SET saldo_base_centavos = saldo_base_centavos + v_efeito_novo
         WHERE id = o.id;
      END IF;
    END LOOP;
  END IF;

  -- Reavalia todo objetivo tocado: os ancorados nas contas das duas pontas e
  -- os que tenham este lançamento como aporte.
  FOR o IN
    SELECT id FROM objetivos
     WHERE tenant_id = v_tenant AND deleted_at IS NULL
       AND (conta_id = NEW.conta_id
            OR (TG_OP = 'UPDATE' AND conta_id = OLD.conta_id))
    UNION
    SELECT a.objetivo_id FROM aportes a
     WHERE a.tenant_id = v_tenant AND a.deleted_at IS NULL
       AND a.lancamento_id = NEW.id
  LOOP
    PERFORM reavaliar_objetivo(o.id, FALSE);
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE TRIGGER objetivos_seguem_o_lancamento_trg
  AFTER INSERT OR UPDATE ON lancamentos
  FOR EACH ROW EXECUTE FUNCTION objetivos_seguem_o_lancamento();

-- ---------------------------------------------------------------------------
-- Invariante 10 — a Conta ancorada não some por baixo do Objetivo
-- ---------------------------------------------------------------------------
-- Bloquear é uma regra; congelar o progresso num campo seria um estado, e
-- criaria um segundo significado para "progresso" — derivado às vezes,
-- armazenado outras.
CREATE FUNCTION conta_ancorada_nao_some() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_nome TEXT;
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    SELECT nome INTO v_nome FROM objetivos
     WHERE tenant_id = NEW.tenant_id AND conta_id = NEW.id AND deleted_at IS NULL
     LIMIT 1;

    IF v_nome IS NOT NULL THEN
      -- A mensagem nomeia o Objetivo: "não é possível excluir" sem dizer o quê
      -- deixa a pessoa procurando.
      RAISE EXCEPTION 'CONTA_TEM_OBJETIVO: %', v_nome USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER conta_ancorada_nao_some_trg
  BEFORE UPDATE ON contas
  FOR EACH ROW EXECUTE FUNCTION conta_ancorada_nao_some();

-- ---------------------------------------------------------------------------
-- Isolamento
-- ---------------------------------------------------------------------------
ALTER TABLE objetivos ENABLE ROW LEVEL SECURITY;
ALTER TABLE objetivos FORCE  ROW LEVEL SECURITY;
CREATE POLICY objetivo_do_tenant ON objetivos
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE aportes ENABLE ROW LEVEL SECURITY;
ALTER TABLE aportes FORCE  ROW LEVEL SECURITY;
CREATE POLICY aporte_do_tenant ON aportes
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON objetivos TO mavia_app;
GRANT SELECT, INSERT, UPDATE ON aportes   TO mavia_app;
