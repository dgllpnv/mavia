-- 0030 · O log de auditoria, e as duas tabelas que a política de retenção
--        especificava desde sempre sem nunca terem sido construídas
--
-- Ticket 03. Spec v3.2 §3, §3.1, §3.1.1, §3.1.2, §3.2 e §3.3.
--
-- ## ⚠️ A ordem deste arquivo é normativa
--
-- `retencao_execucoes` **antes** do gatilho. O gatilho de imutabilidade faz
-- `SELECT 1 FROM retencao_execucoes` na condição de isenção; criado antes da
-- tabela, ele referencia um objeto ausente e a migration não roda.
--
-- Foi o achado **O-2** do gate de LGPD: o spec construía a isenção em cima de
-- duas tabelas que `retencao-e-eliminacao.md` §4.3 especifica e que **não
-- existiam em migration nenhuma** — zero ocorrências no repositório. O spec
-- marcava `auditoria` como "a construir" em dois lugares e esquecia estas.
--
-- E se um dia a tabela sumir: **falhe a migration, não a condição.** Remover o
-- `EXISTS` para "fazer subir" é exatamente o escape hatch que a §3.2 fecha.
--
-- ## O que este log **não** garante, dito antes do que ele garante
--
-- A imutabilidade vale contra `mavia_app`, contra os quatro papéis do painel e
-- **contra o dono**, para DML. Ela **não** vale contra DDL — `DETACH PARTITION`
-- mais `DROP TABLE` apaga um mês e não dispara gatilho de linha nem de
-- statement — e **não** vale contra quem tem o servidor. Imutabilidade real
-- exige o log sair da máquina, e isso não está neste épico.

-- ---------------------------------------------------------------------------
-- 1 · `retencao_execucoes` — o registro de que algo foi apagado
-- ---------------------------------------------------------------------------
-- Append-only para **todos** os papéis, inclusive os que a usam. Sem
-- `tenant_id`, e é por isso que ela não entra na conta do R-08: ela não é dado
-- de cliente, é prova de que a política rodou.
--
-- `retencao-e-eliminacao.md` §4.3: "não contém dado pessoal — só classe,
-- contagem, horário e versão da política".
CREATE TABLE retencao_execucoes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  classe         TEXT        NOT NULL,
  versao_politica TEXT       NOT NULL,
  linhas         BIGINT      NOT NULL DEFAULT 0 CHECK (linhas >= 0),
  iniciada_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluida_em   TIMESTAMPTZ,
  observacao     TEXT
);

COMMENT ON TABLE retencao_execucoes IS
  'Append-only para todos os papéis. Sem dado pessoal e sem tenant_id — não '
  'entra na conta do R-08. É a âncora de accountability do art. 37.';

-- ---------------------------------------------------------------------------
-- 2 · `eliminacoes_journal` — quem pediu para sumir, e quando
-- ---------------------------------------------------------------------------
-- Sem conteúdo, de propósito: guardar o que foi eliminado seria não eliminar.
-- É a lista que o procedimento de eliminação consulta, e é o que faz a
-- restauração de backup reaplicar as eliminações antes de aceitar tráfego
-- (`retencao-e-eliminacao.md` §5.5).
CREATE TABLE eliminacoes_journal (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo         TEXT NOT NULL CHECK (tipo IN ('espaco', 'titular')),
  tenant_id    UUID,
  usuario_id   UUID,
  pedida_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluida_em TIMESTAMPTZ,
  CONSTRAINT alvo_coerente CHECK (
    (tipo = 'espaco'  AND tenant_id IS NOT NULL AND usuario_id IS NULL) OR
    (tipo = 'titular' AND usuario_id IS NOT NULL AND tenant_id IS NULL)
  )
);

-- ---------------------------------------------------------------------------
-- 3 · Os três enums — listas fechadas, e fechadas por tipo
-- ---------------------------------------------------------------------------
-- `motivo_de_acesso` é o controle mais barato do épico e o único que muda o
-- comportamento **no momento do ato**: um valor fora da lista não entra no
-- `INSERT`, e a mesma instrução que registra é a que efetiva o acesso.
--
-- "Curiosidade", "conferir uma coisa" e "mostrar numa demonstração" não têm
-- valor de enum. A lista não pede honestidade do operador — ela remove a opção.
CREATE TYPE motivo_de_acesso AS ENUM ('chamado', 'incidente', 'defeito', 'ordem_judicial');

-- Separa titular, membro e operador. É o que permite a projeção de
-- `/atividades`, o que torna a DA-2 reversível por configuração, e o que o
-- carve-out da anonimização usa como predicado (`retencao-e-eliminacao.md`
-- §3.5 e §4.4): a identidade de quem **opera** sobrevive aos 90 dias, a de
-- quem é **titular** não.
CREATE TYPE ator_de_auditoria AS ENUM ('titular', 'membro', 'operador', 'sistema');

CREATE TYPE classe_de_auditoria AS ENUM (
  'leitura_em_massa',
  'escrita_financeira',
  'seguranca',
  'operacao_interna',
  'eliminacao_de_espaco'
);

-- ---------------------------------------------------------------------------
-- 4 · `auditoria`, particionada por mês
-- ---------------------------------------------------------------------------
CREATE TABLE auditoria (
  id              UUID        NOT NULL DEFAULT gen_random_uuid(),
  ocorrido_em     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- **Nulo para eventos que não pertencem a espaço nenhum** — conceder e
  -- revogar administrador. A policy de escrita da §3.3 é o que torna esta
  -- linha gravável; o padrão do repositório a recusaria.
  tenant_id       UUID,
  usuario_id      UUID        NOT NULL,
  ator_tipo       ator_de_auditoria NOT NULL,

  entidade        TEXT        NOT NULL,
  entidade_id     UUID,
  acao            TEXT        NOT NULL,
  classe          classe_de_auditoria NOT NULL,

  -- Responde à natureza dos dados afetados, que é o que o art. 48 pede.
  -- "Abriu o espaço" não responde; "abriu o espaço, rota X, 143 registros" sim.
  rota            TEXT,
  registros       BIGINT      CHECK (registros IS NULL OR registros >= 0),

  -- A hipótese declarada **antes** do ato. É a única salvaguarda do conjunto
  -- que atua antes da leitura; as demais são forenses.
  motivo          motivo_de_acesso,
  referencia      TEXT,

  -- Liga a linha de **intenção** à de **efeito** de uma mesma escrita
  -- financeira (achado F-14). Sem ela o par existe e ninguém consegue afirmar
  -- que existe: `auditoria` não aceita `UPDATE` de ninguém, então a linha nunca
  -- é completada depois — o `de → para` precisa de uma segunda linha, e a
  -- segunda precisa dizer de qual primeira ela é.
  correlacao      UUID,

  de              JSONB,
  para            JSONB,

  -- Existem para investigação de incidente, **não para exibição**. Nenhum papel
  -- do painel os lê: `mavia_admin` tem `INSERT` nesta tabela e nada mais.
  ip_hash         BYTEA,
  user_agent_hash BYTEA,

  -- A referência é obrigatória quando há motivo, e não o contrário: um acesso
  -- sob hipótese declarada sem número de chamado é uma hipótese que ninguém
  -- consegue conferir.
  CONSTRAINT motivo_tem_referencia CHECK (
    (motivo IS NULL AND referencia IS NULL) OR
    (motivo IS NOT NULL AND length(btrim(coalesce(referencia, ''))) >= 3)
  ),

  -- Todo acesso de operador declara hipótese. É o que separa este painel do
  -- `psql` na VPS com uma tela na frente.
  --
  -- **Ou aponta para a linha que a declarou.** A hipótese é declarada uma vez
  -- por **ato**, não uma vez por linha: uma escrita financeira produz duas —
  -- a de intenção, gravada por `admin.abrir_espaco_para_escrita` com o motivo,
  -- e a de efeito, gravada pela função de contrato com o `de → para`. Exigir o
  -- motivo nas duas duplicaria o campo e criaria a chance de as cópias
  -- divergirem.
  --
  -- `correlacao IS NOT NULL` é o que liga a segunda à primeira. Uma linha de
  -- operador sem motivo **e** sem correlação continua impossível — que é a
  -- propriedade que interessa.
  CONSTRAINT operador_declara_motivo CHECK (
    ator_tipo <> 'operador' OR motivo IS NOT NULL OR correlacao IS NOT NULL
  ),

  PRIMARY KEY (id, ocorrido_em)
) PARTITION BY RANGE (ocorrido_em);

-- ---------------------------------------------------------------------------
-- 5 · Privilégios — cinco papéis gravam, ninguém altera
-- ---------------------------------------------------------------------------
REVOKE ALL ON auditoria FROM PUBLIC;

GRANT INSERT ON auditoria TO mavia_app;
GRANT INSERT ON auditoria TO mavia_admin;
GRANT INSERT ON auditoria TO mavia_admin_escrita;
GRANT INSERT ON auditoria TO mavia_admin_contrato;
GRANT INSERT ON auditoria TO mavia_admin_definer;

-- `mavia_app` lê o próprio espaço, para a tela de atividades. Os papéis do
-- painel **não leem**: a leitura do registro é por função de projeção fixa,
-- ticket 10, e é o que mantém `ip_hash` fora do alcance deles.
GRANT SELECT ON auditoria TO mavia_app;

GRANT SELECT, INSERT ON retencao_execucoes TO mavia_jobs;
GRANT SELECT ON eliminacoes_journal TO mavia_jobs;

-- ---------------------------------------------------------------------------
-- 6 · `mavia_eliminacao` — o único caminho legítimo que apaga
-- ---------------------------------------------------------------------------
-- `NOLOGIN`, sem `BYPASSRLS`, sem `SELECT` em tabela de negócio, e **nunca**
-- concedido a `mavia_app` nem aos quatro papéis do painel. Alcançável só por
-- `SET ROLE` a partir de `mavia_jobs`, dentro do procedimento que a §3.2 exige.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mavia_eliminacao') THEN
    CREATE ROLE mavia_eliminacao NOLOGIN NOBYPASSRLS NOINHERIT;
  END IF;
END $$;

ALTER ROLE mavia_eliminacao SET statement_timeout = '30s';
GRANT USAGE ON SCHEMA public TO mavia_eliminacao;
-- `DELETE` **e** `SELECT`. Não é generosidade: `DELETE … WHERE id = $1` exige
-- privilégio de leitura nas colunas do `WHERE`, e sem ele o Postgres responde
-- `permission denied for table auditoria` — uma mensagem que não menciona
-- `SELECT` e manda procurar no lugar errado.
--
-- Não afrouxa nada: o papel é `NOLOGIN`, alcançável só por `SET ROLE` a partir
-- de `mavia_jobs`, e o gatilho continua exigindo as três condições para que o
-- `DELETE` aconteça. Ler o que se vai apagar é parte de apagar.
GRANT DELETE, SELECT ON auditoria TO mavia_eliminacao;

-- **O `GRANT` que o achado S3-3(c) descobriu faltando.** O gatilho abaixo é
-- `plpgsql` **sem** `SECURITY DEFINER`, logo roda como o invocador, e o
-- `EXISTS` dele lê `retencao_execucoes`. Sem `SELECT` aqui, o `EXISTS` levanta
-- `permission denied` — e o `DELETE` que a isenção existe para permitir morre
-- no próprio gatilho que o autoriza.
--
-- A alternativa era marcar o gatilho como `SECURITY DEFINER` de
-- `mavia_migrate`. Rejeitada: ele tem `BYPASSRLS`, e o gatilho passaria a
-- avaliar o `EXISTS` sem RLS em **toda** linha que qualquer papel tocar,
-- inclusive as de `mavia_app`. Trocar um `GRANT SELECT` numa tabela sem dado
-- pessoal por um caminho `BYPASSRLS` no gatilho mais quente do log é péssimo
-- negócio.
GRANT SELECT, INSERT ON retencao_execucoes TO mavia_eliminacao;
GRANT SELECT ON eliminacoes_journal TO mavia_eliminacao;

-- `mavia_jobs` pode assumir o papel; ninguém mais.
GRANT mavia_eliminacao TO mavia_jobs;

-- ---------------------------------------------------------------------------
-- 7 · A imutabilidade, e a isenção mais estreita que o Postgres permite
-- ---------------------------------------------------------------------------
-- Três condições **simultâneas**, e nenhuma sozinha basta:
--
--   · `current_user = 'mavia_eliminacao'` — papel NOLOGIN, alcançável só por
--     `SET ROLE` a partir de `mavia_jobs`. Nenhum papel do painel chega nele.
--   · o GUC de transação, definido **apenas** dentro do procedimento
--     `SECURITY DEFINER`, com `set_config(…, true)` — morre no fim da
--     transação e não sobrevive à conexão de pool.
--   · a linha em `retencao_execucoes`, gravada na mesma transação **antes** do
--     `DELETE`. Não há apagamento sem registro do apagamento.
--
-- A ordem é normativa: **grava primeiro, apaga depois.** Invertida, a isenção
-- viraria uma janela em que o `DELETE` já rodou e o registro ainda não existe.
CREATE FUNCTION auditoria_imutavel() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_user = 'mavia_eliminacao'
     AND nullif(current_setting('app.eliminacao_execucao_id', true), '') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM retencao_execucoes
        WHERE id = nullif(current_setting('app.eliminacao_execucao_id', true), '')::uuid
          AND classe = 'eliminacao_de_espaco'
     )
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'AUDITORIA_IMUTAVEL' USING ERRCODE = 'P0001';
END;
$$;

-- ---------------------------------------------------------------------------
-- 8 · As partições, e a função que as cria
-- ---------------------------------------------------------------------------
-- **Sem partição `DEFAULT`, e a ausência é a decisão.**
--
-- A v2 propunha uma `DEFAULT` com alarme, como rede de segurança. É armadilha:
-- assim que ela recebe uma linha de um mês futuro, o `ATTACH` da partição
-- daquele mês **falha** — o Postgres precisa validar que nenhuma linha da
-- `DEFAULT` cai na faixa nova. Sair de lá exige mover linhas, sob pressão, com
-- o controle de imutabilidade no caminho.
--
-- A troca: 24 meses de pista criados por job idempotente, com alarme quando
-- restarem menos de 3. Um `INSERT` sem partição falha na hora, alto e claro,
-- em vez de criar um estado do qual só se sai com manutenção.
CREATE FUNCTION garantir_particao_de_auditoria(p_mes DATE) RETURNS TEXT
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_inicio DATE := date_trunc('month', p_mes)::date;
  v_fim    DATE := (date_trunc('month', p_mes) + INTERVAL '1 month')::date;
  v_nome   TEXT := 'auditoria_' || to_char(v_inicio, 'YYYY_MM');
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = v_nome AND n.nspname = 'public'
  ) THEN
    RETURN v_nome;
  END IF;

  -- **`public.` explícito em todo objeto criado**, e não é preciosismo.
  --
  -- O `SET search_path = pg_catalog, public` desta função é a convenção de
  -- segurança do repositório (`0004_cadastro.sql:92-94`): sem ela, quem
  -- controla o search_path da sessão redireciona uma chamada de dentro da
  -- função para um objeto que ele mesmo criou. Mas ela põe `pg_catalog`
  -- **primeiro** — e um `CREATE TABLE` sem qualificação vai para o primeiro
  -- esquema da lista. O erro é `permission denied for schema pg_catalog`, que
  -- não menciona search_path nem partição, e custou uma execução para
  -- entender.
  --
  -- Inverter a ordem do search_path resolveria o sintoma e desfaria a
  -- salvaguarda. Qualificar resolve os dois.
  EXECUTE format(
    'CREATE TABLE public.%I PARTITION OF public.auditoria FOR VALUES FROM (%L) TO (%L)',
    v_nome, v_inicio, v_fim);

  -- **Cada partição repete os grants e o gatilho, e é obrigatório.**
  -- Uma partição nova não herda o `REVOKE` do pai, e quem a cria vira dona
  -- dela: sem estas linhas, o mês seguinte nasce mutável e ninguém percebe.
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', v_nome);
  EXECUTE format('GRANT INSERT ON public.%I TO mavia_app, mavia_admin, mavia_admin_escrita,
                                              mavia_admin_contrato, mavia_admin_definer', v_nome);
  EXECUTE format('GRANT SELECT ON public.%I TO mavia_app', v_nome);
  EXECUTE format('GRANT DELETE, SELECT ON public.%I TO mavia_eliminacao', v_nome);
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.auditoria_imutavel()',
    v_nome || '_imutavel', v_nome);
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I
       FOR EACH STATEMENT EXECUTE FUNCTION public.auditoria_imutavel()',
    v_nome || '_sem_truncate', v_nome);

  RETURN v_nome;
END;
$$;

-- 24 meses de pista, a partir do mês corrente. Idempotente por construção.
DO $$
DECLARE i INT;
BEGIN
  FOR i IN 0..23 LOOP
    PERFORM garantir_particao_de_auditoria((date_trunc('month', now()) + (i || ' month')::INTERVAL)::date);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 9 · RLS — e as três linhas que o padrão do repositório recusaria
-- ---------------------------------------------------------------------------
-- O padrão é `USING`/`WITH CHECK (tenant_id = app.tenant_id)`. Sob ele, **três
-- linhas que este épico existe para gravar seriam recusadas**:
--
--   1. conceder ou revogar admin — `tenant_id` nulo, e `NULL = NULL` é `NULL`;
--   2. a busca da listagem — gravada sem `app.tenant_id` definido;
--   3. o `INSERT … SELECT` do procedimento de saída de partição, com linhas de
--      vários tenants numa instrução só.
--
-- Daí a escrita ser `WITH CHECK (true)`. **A contenção da escrita é o `GRANT`
-- nominal e o gatilho**, não a policy: quem pode gravar são cinco papéis
-- nomeados, e ninguém pode alterar depois. Uma policy restritiva aqui não
-- acrescentaria segurança e quebraria as três linhas acima.
ALTER TABLE auditoria ENABLE ROW LEVEL SECURITY;
ALTER TABLE auditoria FORCE  ROW LEVEL SECURITY;

CREATE POLICY auditoria_grava ON auditoria
  FOR INSERT TO mavia_app, mavia_admin, mavia_admin_escrita,
                mavia_admin_contrato, mavia_admin_definer
  WITH CHECK (true);

-- A leitura do titular, por espaço. Linha de `tenant_id` nulo **não aparece
-- para ninguém** por aqui — é a operação interna, e ela não é do cliente.
CREATE POLICY auditoria_do_tenant ON auditoria
  FOR SELECT TO mavia_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- `mavia_eliminacao` precisa enxergar o que vai apagar.
CREATE POLICY auditoria_eliminacao ON auditoria
  FOR DELETE TO mavia_eliminacao
  USING (true);

-- A policy de leitura que o `DELETE … WHERE` precisa. Sem ela o `USING (true)`
-- acima nunca é alcançado: a RLS de `SELECT` recusa antes.
CREATE POLICY auditoria_eliminacao_le ON auditoria
  FOR SELECT TO mavia_eliminacao
  USING (true);

ALTER TABLE retencao_execucoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE retencao_execucoes FORCE ROW LEVEL SECURITY;
CREATE POLICY retencao_le ON retencao_execucoes
  FOR SELECT TO mavia_jobs, mavia_eliminacao USING (true);
CREATE POLICY retencao_grava ON retencao_execucoes
  FOR INSERT TO mavia_jobs, mavia_eliminacao WITH CHECK (true);

ALTER TABLE eliminacoes_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliminacoes_journal FORCE ROW LEVEL SECURITY;
CREATE POLICY eliminacoes_le ON eliminacoes_journal
  FOR SELECT TO mavia_jobs, mavia_eliminacao USING (true);

-- ---------------------------------------------------------------------------
-- 10 · O `EVENT TRIGGER` contra DDL **não entra aqui** — exige superusuário
-- ---------------------------------------------------------------------------
-- Medido: `CREATE EVENT TRIGGER` responde
--
--     ERROR:  permission denied to create event trigger
--     HINT:   Must be superuser to create an event trigger.
--
-- e `mavia_migrate` não é superusuário (`rolsuper = false`), de propósito.
--
-- Então ele é **provisionamento**, como o `LOGIN` dos papéis do painel: roda
-- uma vez, pela mão que tem o servidor, junto do `bootstrap-papeis.sql`. Está
-- registrado como condição de deploy no ticket 13.
--
-- E a frase honesta continua valendo, agora com um segundo motivo: ele **não
-- impede** nada. `DETACH PARTITION` mais `DROP TABLE` apaga um mês sem
-- disparar gatilho de linha nem de statement, e quem tem superusuário para
-- criar o event trigger também tem para removê-lo. Ele eleva o custo e deixa
-- rastro. Imutabilidade real exige o log sair da máquina.
--
-- O SQL, para quem for provisionar:
--
--   CREATE FUNCTION registrar_drop_de_auditoria() RETURNS EVENT_TRIGGER
--   LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
--   DECLARE r RECORD;
--   BEGIN
--     FOR r IN SELECT * FROM pg_event_trigger_dropped_objects() LOOP
--       IF r.object_name LIKE 'auditoria%' THEN
--         INSERT INTO public.retencao_execucoes
--           (classe, versao_politica, observacao, concluida_em)
--         VALUES ('ddl_sobre_auditoria', 'n/a',
--                 format('%s removido por %s', r.object_name, current_user), now());
--       END IF;
--     END LOOP;
--   END;
--   $fn$;
--
--   CREATE EVENT TRIGGER auditoria_ddl ON sql_drop
--     EXECUTE FUNCTION registrar_drop_de_auditoria();
