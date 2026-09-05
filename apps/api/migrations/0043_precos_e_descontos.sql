-- 0043 · Preço-base editável e desconto por cliente — **ADR 0025**
--
-- A ADR foi emendada antes desta migration existir, e a emenda é o que define a
-- forma daqui: as colunas `stripe_*` são **anuláveis**. A versão original as
-- exigia `NOT NULL`, para que a ausência da Stripe se manifestasse como
-- impossibilidade de criar a linha. Estava errada.
--
-- A invariante é *nenhum cliente é cobrado um valor diferente do que a gente
-- mostra*, e ela só equivale a "toda linha tem um `Price`" **quando a Stripe é
-- quem cobra**. Hoje não existe cliente de saída, não existe tabela
-- `cobrancas`, e nenhuma assinatura tem `stripe_subscription_id`. Ninguém é
-- cobrado nada; a nossa tabela não é uma segunda verdade, é a única.
--
-- A trava mudou de lugar: quem recusa é a **venda**, no épico 11, e não a
-- criação da linha.

-- ---------------------------------------------------------------------------
-- Preço vigente
-- ---------------------------------------------------------------------------
-- **Append-only.** Não há `UPDATE` concedido a papel nenhum, e é a propriedade
-- central: retroatividade fica *irrepresentável*, e não desencorajada. O pior
-- erro possível é criar um preço errado para vendas futuras, que se corrige
-- criando outro — e os dois ficam no histórico.
--
-- Sem `tenant_id`: preço de plano é do produto, não de um espaço. É a única
-- tabela de negócio deste sistema sem tenant, e por isso ela **não** entra na
-- exportação de portabilidade nem sob RLS de tenant.
CREATE TABLE precos_vigentes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  plano          TEXT NOT NULL,
  intervalo      intervalo_de_cobranca NOT NULL,

  valor_centavos BIGINT NOT NULL CHECK (valor_centavos > 0),
  -- `BRL` e ponto final. Moeda diferente é plano diferente, não uma linha
  -- nesta tabela — somar `Money` de moedas diferentes lança erro no domínio, e
  -- um catálogo bimonetário exigiria decidir a conversão em algum lugar.
  moeda          TEXT NOT NULL DEFAULT 'BRL' CHECK (moeda = 'BRL'),

  -- Nulo enquanto não houver Stripe. Ver o cabeçalho.
  stripe_price_id TEXT,

  vigente_desde  TIMESTAMPTZ NOT NULL DEFAULT now(),
  criado_por     UUID NOT NULL REFERENCES usuarios (id),
  motivo         TEXT NOT NULL CHECK (length(btrim(motivo)) >= 8)
);

-- Um preço por `(plano, intervalo)` em cada instante. Sem isto, dois cliques no
-- botão criariam duas linhas com o mesmo `vigente_desde` e a leitura teria de
-- desempatar — e desempate silencioso sobre preço é como se cobra errado.
CREATE UNIQUE INDEX precos_vigentes_unico
  ON precos_vigentes (plano, intervalo, vigente_desde);

CREATE INDEX precos_vigentes_leitura
  ON precos_vigentes (plano, intervalo, vigente_desde DESC);

-- A tabela nasce **vazia**, e é deliberado.
--
-- Semear com os seis valores da DP-41 pareceria mais completo e criaria uma
-- duplicata: o catálogo em código continua declarando os mesmos números, e no
-- dia em que alguém editasse um dos dois lados o sistema teria duas respostas
-- para "quanto custa o Pessoal". Vazia, a leitura cai no catálogo — uma
-- resposta só — e a primeira linha só existe quando alguém decidir mudar algo.

-- ---------------------------------------------------------------------------
-- Desconto por cliente
-- ---------------------------------------------------------------------------
-- Desconto nunca foi plausível como código: é por cliente, por negociação, por
-- circunstância. Nada disso versiona.
CREATE TYPE especie_de_desconto AS ENUM ('percentual', 'valor');
CREATE TYPE duracao_de_desconto AS ENUM ('uma_vez', 'meses', 'sempre');

CREATE TABLE descontos_de_cliente (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants (id),

  especie     especie_de_desconto NOT NULL,
  -- Percentual em **pontos-base inteiros**: 15% é `1500`. `0.15` traria ponto
  -- flutuante para dois passos de uma `Money`, e `19990 * 0.15` é
  -- `2998.4999999999995` em IEEE 754. A regra 1 não fala só do valor: fala de
  -- perto dele.
  pontos_base INTEGER CHECK (pontos_base BETWEEN 1 AND 10000),
  valor_centavos BIGINT CHECK (valor_centavos > 0),
  moeda       TEXT NOT NULL DEFAULT 'BRL' CHECK (moeda = 'BRL'),

  duracao     duracao_de_desconto NOT NULL,
  meses       INTEGER CHECK (meses > 0),

  stripe_coupon_id TEXT,

  motivo      TEXT NOT NULL CHECK (length(btrim(motivo)) >= 8),
  concedido_por UUID NOT NULL REFERENCES usuarios (id),
  concedido_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revogado_em   TIMESTAMPTZ,
  revogado_por  UUID REFERENCES usuarios (id),

  -- A espécie decide qual coluna de valor existe, e o banco recusa a outra.
  -- Sem isto, um desconto poderia declarar 15% **e** R$ 10,00, e quem lesse
  -- teria de escolher — que é a forma mais silenciosa de cobrar errado.
  CONSTRAINT valor_combina_com_especie CHECK (
    (especie = 'percentual' AND pontos_base IS NOT NULL AND valor_centavos IS NULL)
    OR
    (especie = 'valor' AND valor_centavos IS NOT NULL AND pontos_base IS NULL)
  ),
  -- `meses` existe se e somente se a duração é `meses`. Um número sobrando
  -- numa duração `sempre` seria lido por alguém, algum dia.
  CONSTRAINT meses_combina_com_duracao CHECK (
    (duracao = 'meses' AND meses IS NOT NULL) OR (duracao <> 'meses' AND meses IS NULL)
  ),
  CONSTRAINT revogacao_completa CHECK (
    (revogado_em IS NULL AND revogado_por IS NULL)
    OR (revogado_em IS NOT NULL AND revogado_por IS NOT NULL)
  )
);

-- **Um desconto ativo por espaço.** Dois descontos vivos exigiriam decidir se
-- compõem ou se o maior vence, e as duas respostas são defensáveis — que é
-- exatamente o motivo de a pergunta não poder existir. Trocar o desconto é
-- revogar e conceder, com as duas linhas no histórico.
CREATE UNIQUE INDEX descontos_um_ativo_por_espaco
  ON descontos_de_cliente (tenant_id)
  WHERE revogado_em IS NULL;

ALTER TABLE descontos_de_cliente ENABLE ROW LEVEL SECURITY;
ALTER TABLE descontos_de_cliente FORCE ROW LEVEL SECURITY;

-- Uma política só, para todas as instruções — a forma de `pagamentos_manuais`
-- (`0034`).
--
-- **`FOR SELECT` não bastava, e a lição custou um teste.** Com `FORCE ROW LEVEL
-- SECURITY`, a RLS alcança **o dono da tabela**, e o dono das funções
-- `SECURITY DEFINER` é justamente quem escreve aqui. Uma política restrita a
-- leitura deixa o `INSERT` sem política nenhuma, e o Postgres recusa com *"new
-- row violates row-level security policy"* — apontando para a linha, não para
-- a política que falta.
--
-- **Quem impede o cliente de escrever é o `GRANT`, não a política.** `mavia_app`
-- recebe `SELECT` de colunas nominadas e nada mais; não há `INSERT` a conceder
-- política nenhuma. Separar as duas responsabilidades é o padrão do
-- repositório: a política decide *quais linhas*, o grant decide *quais verbos*.
CREATE POLICY desconto_do_tenant ON descontos_de_cliente
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT (id, tenant_id, especie, pontos_base, valor_centavos, moeda,
              duracao, meses, concedido_em, revogado_em)
  ON descontos_de_cliente TO mavia_app;

-- `motivo`, `concedido_por` e `revogado_por` **ficam de fora do GRANT**, e não
-- só de fora da consulta.
--
-- É a mesma disciplina da `0034`: o motivo é a nota interna do operador
-- ("cliente reclamou", "amigo do dono"), e os dois ids são crachás de
-- funcionário. Entregá-los ao cliente contrariaria por porta lateral a decisão
-- de não lhe expor o registro de acesso do operador.
--
-- Com o GRANT nominal, incluir uma dessas colunas numa consulta futura faz o
-- **banco recusar** — em vez de a decisão virar um comentário que alguém
-- deixou de ler.
