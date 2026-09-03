-- 0023 — Categorização automática: regra do usuário, histórico do espaço e a
-- explicabilidade que o glossário exige.
--
-- `CONTEXT.md`, verbete **Categorizacao automatica**: "sempre reversível,
-- sempre com o motivo visível". As duas garantias precisam de colunas, e é o
-- que esta migration acrescenta.

-- ---------------------------------------------------------------------------
-- A regra escrita pela pessoa
-- ---------------------------------------------------------------------------
-- **Sem expressão regular**, e a ausência é decisão de segurança: uma regex
-- escrita pelo usuário e avaliada pelo servidor é uma superfície de negação de
-- serviço (ReDoS) numa rota autenticada — e o ganho sobre "contém" é pequeno
-- num domínio de descrição de banco.
CREATE TYPE tipo_de_regra AS ENUM ('igual', 'comeca_com', 'contem');

CREATE TABLE regras_de_categorizacao (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants (id),
  tipo         tipo_de_regra NOT NULL DEFAULT 'contem',
  padrao       TEXT NOT NULL,
  categoria_id UUID NOT NULL REFERENCES categorias (id),

  -- Menor vem primeiro. O padrão é 100 para que dê espaço dos dois lados sem
  -- ninguém precisar renumerar nada.
  prioridade   SMALLINT NOT NULL DEFAULT 100,

  criado_por   UUID NOT NULL REFERENCES usuarios (id),
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,

  CONSTRAINT padrao_nao_vazio CHECK (length(btrim(padrao)) > 0)
);

CREATE INDEX regras_por_tenant ON regras_de_categorizacao (tenant_id, prioridade)
  WHERE deleted_at IS NULL;

-- Duas regras idênticas não acrescentam nada e confundem a tela.
CREATE UNIQUE INDEX regra_unica
  ON regras_de_categorizacao (tenant_id, tipo, lower(btrim(padrao)))
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- A explicabilidade
-- ---------------------------------------------------------------------------
-- Duas colunas, e as duas existem por causa da mesma frase do glossário.
--
-- `classificacao_motivo` é a frase em **português** que a tela mostra — não um
-- código, não um identificador de regra. Guardar o identificador obrigaria a
-- reconstruir a explicação na leitura, e ela mudaria quando a regra mudasse:
-- o lançamento passaria a dizer que foi classificado por um motivo que não
-- existia quando ele foi classificado.
--
-- `classificacao_origem` nulo significa **decisão humana**. É o que torna a
-- reversão observável: quando a pessoa troca a categoria, as duas colunas são
-- limpas, e o lançamento deixa de ser "classificado automaticamente" — porque
-- deixou de ser.
ALTER TABLE lancamentos
  ADD COLUMN classificacao_origem TEXT,
  ADD COLUMN classificacao_motivo TEXT,
  ADD CONSTRAINT classificacao_coerente
    CHECK ((classificacao_origem IS NULL) = (classificacao_motivo IS NULL)),
  ADD CONSTRAINT origem_de_classificacao_conhecida
    CHECK (classificacao_origem IS NULL OR classificacao_origem IN ('regra', 'historico'));

-- ---------------------------------------------------------------------------
-- O histórico que o espaço usa para aprender
-- ---------------------------------------------------------------------------
-- Uma visão, e não uma tabela: o histórico **é** o extrato, e materializá-lo
-- criaria um segundo lugar onde a verdade mora — com o problema de sempre, o de
-- divergir sem que ninguém perceba.
--
-- A assinatura é calculada aqui com as mesmas remoções do domínio: número,
-- data e pontuação saem. Ela precisa existir em SQL porque agrupar em memória
-- exigiria trazer o extrato inteiro para a aplicação a cada classificação.
-- `unaccent` é extensão, e extensão exige superusuário na criação. O
-- `translate` resolve o caso brasileiro sem depender disso — e sem depender de
-- o provedor de banco gerenciado permitir a extensão no dia do deploy.
--
-- Tudo numa função só, **sem chamar outra**: uma função usada em expressão de
-- índice precisa ser `IMMUTABLE` e autocontida. Quebrá-la em duas fez o
-- `CREATE INDEX` falhar com "function does not exist", porque a resolução do
-- corpo acontece com o `search_path` de quem cria o índice, e não com o de quem
-- criou a função.
CREATE FUNCTION assinatura_da_descricao(p_descricao TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          lower(translate(p_descricao,
            'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
            'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')),
          '\d+\s*[/-]\s*\d+([/-]\d+)?', ' ', 'g'),
        '\d+', ' ', 'g'),
      '[^a-z ]+', ' ', 'g')
  );
$$;

CREATE INDEX lancamentos_por_assinatura
  ON lancamentos (tenant_id, (assinatura_da_descricao(descricao)))
  WHERE deleted_at IS NULL AND categoria_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Isolamento
-- ---------------------------------------------------------------------------
ALTER TABLE regras_de_categorizacao ENABLE ROW LEVEL SECURITY;
ALTER TABLE regras_de_categorizacao FORCE  ROW LEVEL SECURITY;
CREATE POLICY regra_do_tenant ON regras_de_categorizacao
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON regras_de_categorizacao TO mavia_app;
GRANT EXECUTE ON FUNCTION assinatura_da_descricao(TEXT) TO mavia_app;
