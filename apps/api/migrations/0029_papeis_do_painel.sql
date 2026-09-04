-- 0029 · Os quatro papéis do painel de administração
--
-- Ticket 01. Governada pelo spec v3.2 §1.1 a §1.5 e pela ADR 0024 (aceita),
-- D3 e D5. Nenhuma rota nasce aqui: o que nasce é a **fronteira** dentro da
-- qual as rotas dos tickets seguintes vão viver.
--
-- ## A medição que produziu esta migration
--
-- A v2 do spec descrevia um papel somente-leitura alcançado por `SET LOCAL
-- ROLE` a partir do pool único de `mavia_app`. Medido contra Postgres 17:
--
--     BEGIN; SET LOCAL ROLE leitor; UPDATE t SET v=99;              -- denied
--     BEGIN; SET LOCAL ROLE leitor; RESET ROLE; UPDATE t SET v=99;  -- UPDATE 1
--
-- **Uma instrução desfaz a trava.** Um papel alcançável por `SET ROLE` é uma
-- convenção com nome de papel, não uma fronteira de privilégio. Daí os papéis
-- terem credencial própria e — o que mais importa — **não terem parentesco**
-- com `mavia_app` em direção nenhuma.
--
-- ## As não-relações valem tanto quanto os privilégios
--
--   · `mavia_app` não é membro de nenhum dos quatro
--        → senão o pool do cliente alcança o painel por `SET ROLE`
--   · nenhum dos quatro é membro de `mavia_app`
--        → senão `RESET ROLE` devolve o DML completo sobre o razão do cliente
--          cujo `app.tenant_id` acabou de ser assumido
--   · `mavia_admin` não é membro de `mavia_admin_escrita`
--        → a conexão que lê não é a conexão que escreve
--
-- Nenhum `GRANT ... TO ...` de papel a papel aparece neste arquivo, e a
-- ausência é o controle. O teste `papeis-do-painel.test.ts` a afirma em
-- `pg_auth_members`, porque uma ausência que ninguém verifica é uma ausência
-- que o próximo `GRANT` conveniente remove.
--
-- ## ⚠️ Por que cada `GRANT` tem asserção de esquema
--
-- `bootstrap-papeis.sql:36-44` documenta o modo de falha: um `GRANT` executado
-- por quem **não é dono** do objeto não falha — devolve `GRANT` com um
-- `WARNING`, esta migration reporta sucesso, e o privilégio não existe. O
-- defeito aparece na primeira execução de uma função, meses depois. Por isso
-- toda linha daqui tem uma asserção correspondente no teste de esquema.
--
-- Esta migration roda como `mavia_migrate`, que é dono do esquema `public`
-- (`bootstrap-papeis.sql:45`) — a condição que faz os `GRANT` abaixo valerem.

-- ---------------------------------------------------------------------------
-- 1 · Os papéis
-- ---------------------------------------------------------------------------
-- Todos `NOLOGIN`, e isto é a condição C-9. O único `CREATE ROLE ... LOGIN ...
-- PASSWORD` versionado no repositório tem a senha em claro, e migration é
-- forward-only: uma senha escrita aqui vive no histórico para sempre.
-- `mavia_admin` e `mavia_admin_escrita` recebem `LOGIN` e credencial no
-- **provisionamento**, pelo mesmo caminho que `mavia_app` já usa.
--
-- `NOINHERIT` nos dois que vão logar: um papel que herda privilégio sem pedir
-- é um papel cuja fronteira depende de quem o criou lembrar de não conceder.

DO $$
BEGIN
  -- Lê o espaço do cliente. Só `SELECT`, e por coluna.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mavia_admin') THEN
    CREATE ROLE mavia_admin NOLOGIN NOBYPASSRLS NOINHERIT;
  END IF;

  -- A conexão das escritas. Não escreve contrato diretamente: ele executa as
  -- funções cujo **dono** escreve (§8.0). O privilégio mora no dono.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mavia_admin_escrita') THEN
    CREATE ROLE mavia_admin_escrita NOLOGIN NOBYPASSRLS NOINHERIT;
  END IF;

  -- Dono das funções que tocam o contrato comercial. Nunca loga, nunca é
  -- alcançado por `SET ROLE`, e existe para que o privilégio de escrever
  -- `assinaturas` não fique numa conexão que uma rota consegue usar direto —
  -- que é o achado F-2: um `UPDATE` de coluna solta não recusa
  -- `expirada → ativa` sem pagamento.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mavia_admin_contrato') THEN
    CREATE ROLE mavia_admin_contrato NOLOGIN NOBYPASSRLS NOINHERIT;
  END IF;

  -- Dono das funções `SECURITY DEFINER` de listagem e abertura.
  --
  -- **Jamais `mavia_auth`**, que é a convenção do repositório para toda
  -- `SECURITY DEFINER` — e que já lê `usuarios`, `tenants`, `tenant_usuarios`,
  -- `sessoes` e `assinaturas` entre todos os espaços com `USING (true)`
  -- (`0004_cadastro.sql:52-63`, `0025_assinatura.sql:163`). Seguir a convenção,
  -- aqui, seria escrever o exploit. **Jamais `mavia_migrate`**, que tem
  -- `BYPASSRLS`. Ver ADR 0024 D4.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mavia_admin_definer') THEN
    CREATE ROLE mavia_admin_definer NOLOGIN NOBYPASSRLS NOINHERIT;
  END IF;
END $$;

-- Um teto por papel, e não por chamada — `matriz-de-acesso.md` §5.3 é
-- normativa nisso, e `0001_fundacao.sql:149` é o precedente (`mavia_app`, 5s).
-- A rota que mais precisa é `admin.listar_clientes`, que varre a base com um
-- termo de busca livre.
ALTER ROLE mavia_admin          SET statement_timeout = '5s';
ALTER ROLE mavia_admin_escrita  SET statement_timeout = '5s';
ALTER ROLE mavia_admin_contrato SET statement_timeout = '5s';
ALTER ROLE mavia_admin_definer  SET statement_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 2 · O esquema `admin`
-- ---------------------------------------------------------------------------
-- Dono `mavia_migrate`, como `public`. As funções que vivem aqui têm donos
-- **diferentes** do esquema, por família (§2, §8.0) — é o esquema que é
-- comum, não o privilégio.
CREATE SCHEMA IF NOT EXISTS admin AUTHORIZATION mavia_migrate;

-- `bootstrap-papeis.sql:51` faz `REVOKE ALL ON SCHEMA public FROM PUBLIC`, de
-- propósito. Então `USAGE` é nominal, papel a papel — inclusive em `admin`,
-- que nasce agora e nunca teve `PUBLIC`.
GRANT USAGE ON SCHEMA public, admin TO mavia_admin;
GRANT USAGE ON SCHEMA public, admin TO mavia_admin_escrita;
GRANT USAGE ON SCHEMA public, admin TO mavia_admin_contrato;
GRANT USAGE ON SCHEMA public, admin TO mavia_admin_definer;

-- ---------------------------------------------------------------------------
-- 3 · O que `mavia_admin` lê — lista fechada, coluna a coluna
-- ---------------------------------------------------------------------------
-- **Por coluna, e não por tabela**, e a propriedade que isso compra é uma só:
-- uma coluna nova **não se estende sozinha**. Uma migration futura que
-- acrescente um campo sensível a uma tabela já alcançada não o entrega ao
-- painel por omissão — ela falha o teste de esquema até alguém classificá-lo.
--
-- Os nove campos da R-5 estão fora por construção. Ver
-- `apps/api/src/autorizacao/campos-vetados.ts`, que é a lista única lida tanto
-- pelo teste de esquema quanto pela varredura do OpenAPI (AB-07).
--
-- Tabelas deliberadamente **fora** deste alcance, e a razão de cada grupo:
--   · `sessoes`, `recuperacoes_senha`, `mfa_codigos_recuperacao`,
--     `cadastros_pendentes`, `identidades_federadas` — credencial e sessão;
--     ler não atende nenhuma das três hipóteses de acesso
--   · `conexoes`, `consentimentos`, `sincronizacoes`, `lancamentos_brutos` —
--     segredo de provider e dado cru de terceiro
--   · `eventos_de_cobranca`, `mutacoes_idempotentes`, `migrations_aplicadas` —
--     infraestrutura, não dado do cliente

GRANT SELECT (id, nome, timezone, moeda_base, criado_em, deleted_at)
  ON tenants TO mavia_admin;

GRANT SELECT (id, email, nome, criado_em, deleted_at, senha_atualizada_em,
              email_verificado_em, mfa_kek_versao, mfa_ativado_em,
              mfa_ultimo_passo, ultimo_acesso_em)
  ON usuarios TO mavia_admin;

GRANT SELECT (tenant_id, usuario_id, papel, criado_em, removido_em, removido_por)
  ON tenant_usuarios TO mavia_admin;

GRANT SELECT (tenant_id, estado, plano, intervalo, periodo_inicio, periodo_fim,
              graca_ate, stripe_customer_id, stripe_subscription_id, criado_em,
              atualizado_em)
  ON assinaturas TO mavia_admin;

GRANT SELECT (id, tenant_id, email, papel, token_hash, criado_por, criado_em,
              expira_em, aceito_em, aceito_por, revogado_em)
  ON convites TO mavia_admin;

GRANT SELECT (id, tenant_id, nome, tipo, origem, saldo_inicial_centavos, moeda,
              incluir_no_saldo_geral, criado_em, atualizado_em, deleted_at,
              conexao_id)
  ON contas TO mavia_admin;

GRANT SELECT (id, tenant_id, nome, limite_centavos, closing_day, due_day,
              conta_pagamento_id, moeda, origem, arquivado_em, criado_em,
              atualizado_em, deleted_at)
  ON cartoes TO mavia_admin;

GRANT SELECT (id, tenant_id, parent_id, nivel, nome, natureza, analitica, cor,
              icone, sistema, arquivada_em, criado_em, atualizado_em, deleted_at)
  ON categorias TO mavia_admin;

GRANT SELECT (id, tenant_id, conta_id, cartao_id, categoria_id, valor_centavos,
              moeda, posted_at, settled_at, descricao, observacao,
              transfer_group_id, installment_group_id, installment_number,
              installment_total, fatura_id, estorno_de_lancamento_id, origem,
              editado_manualmente, criado_por, criado_em, atualizado_em,
              deleted_at, recorrencia_id, recorrencia_competencia, importacao_id,
              classificacao_origem, classificacao_motivo)
  ON lancamentos TO mavia_admin;

GRANT SELECT (id, tenant_id, tipo, fatura_id, descricao, criado_por, criado_em,
              deleted_at)
  ON transferencias TO mavia_admin;

GRANT SELECT (id, tenant_id, cartao_id, periodo_inicio, periodo_fim,
              data_fechamento, data_vencimento, competencia, estado,
              total_centavos, pago_centavos, conta_pagamento_id, criado_em,
              atualizado_em, deleted_at)
  ON faturas TO mavia_admin;

GRANT SELECT (id, tenant_id, cartao_id, conta_id, data_compra,
              valor_total_centavos, moeda, parcelas, descricao, criado_por,
              criado_em, deleted_at)
  ON parcelamentos TO mavia_admin;

GRANT SELECT (tenant_id, conta_id, eixo, data_civil, saldo_centavos,
              ultimo_lancamento_em, calculado_em)
  ON saldo_snapshots TO mavia_admin;

GRANT SELECT (id, tenant_id, nome, valor_alvo_centavos, moeda, prazo, conta_id,
              saldo_base_centavos, concluido_em, criado_por, criado_em,
              atualizado_em, deleted_at)
  ON objetivos TO mavia_admin;

GRANT SELECT (id, tenant_id, objetivo_id, lancamento_id, criado_por, criado_em,
              deleted_at)
  ON aportes TO mavia_admin;

GRANT SELECT (id, tenant_id, competencia, categoria_id, valor_centavos, moeda,
              alertas_percentuais, criado_por, criado_em, atualizado_em,
              deleted_at)
  ON planejamentos TO mavia_admin;

GRANT SELECT (id, tenant_id, conta_id, cartao_id, categoria_id, valor_centavos,
              moeda, descricao, dia_do_mes, intervalo_meses, inicio, fim,
              pausada_em, criado_por, criado_em, atualizado_em, deleted_at)
  ON recorrencias TO mavia_admin;

GRANT SELECT (id, tenant_id, bruto_id, lancamento_id, confianca, motivo, estado,
              decidido_por, decidido_em, criado_em)
  ON conciliacoes TO mavia_admin;

GRANT SELECT (id, tenant_id, conta_id, provider, nome_do_arquivo, arquivo_hash,
              registros, criados, repetidos, problemas, criado_por, criado_em,
              desfeita_em)
  ON importacoes TO mavia_admin;

GRANT SELECT (id, tenant_id, tipo, padrao, categoria_id, prioridade, criado_por,
              criado_em, deleted_at)
  ON regras_de_categorizacao TO mavia_admin;

-- ---------------------------------------------------------------------------
-- 4 · A projeção fixa da listagem — `mavia_admin_definer`
-- ---------------------------------------------------------------------------
-- **Muito mais estreita que a de `mavia_admin`**, e de propósito: esta é a
-- única leitura do sistema que acontece **sem contexto de tenant**, e por isso
-- é a terceira exceção do `sistema.md` §3.9. Espaço, titular, plano, estado —
-- e nenhum dado do razão.
--
-- A armadilha registrada no spec (achado S3-4): as policies que este papel vai
-- precisar terão forma ampla, porque na listagem não existe `app.tenant_id`. O
-- `GRANT` estreito é o que impede "ler a base" de virar "ler tudo da base".

GRANT SELECT (id, nome, criado_em, deleted_at)             ON tenants         TO mavia_admin_definer;
GRANT SELECT (id, email, nome, criado_em, deleted_at)      ON usuarios        TO mavia_admin_definer;
GRANT SELECT (tenant_id, usuario_id, papel, removido_em)   ON tenant_usuarios TO mavia_admin_definer;
GRANT SELECT (tenant_id, estado, plano, intervalo, periodo_fim, graca_ate)
  ON assinaturas TO mavia_admin_definer;

-- ---------------------------------------------------------------------------
-- 5 · O contrato comercial — `mavia_admin_contrato`
-- ---------------------------------------------------------------------------
-- Dono das funções da §8.0, e **não** papel de conexão. Ele lê e escreve
-- `assinaturas` em colunas nominadas, e não enxerga o razão: quem toca
-- contrato não precisa do extrato, e a ausência é a fronteira.
--
-- **`periodo_fim` e `periodo_inicio` estão fora, e são as duas ausências mais
-- importantes deste arquivo:**
--
--   · `periodo_fim` é o campo que o webhook da Stripe sobrescreve
--     (`0025_assinatura.sql:182`, `coalesce(p_periodo_fim, periodo_fim)`).
--     Conceder escrita nele faria a cortesia concedida pelo operador sumir na
--     fatura seguinte, sem linha de auditoria — porque quem escreveu foi
--     `mavia_auth`, no caminho do webhook. É o achado F-12. A cortesia vive em
--     `cortesia_ate`, coluna própria, criada no ticket 08.
--   · `periodo_inicio` é de onde `meses_iniciados` conta na fórmula de
--     reembolso. Escrevê-lo reescreve retroativamente quanto a Mavia deve
--     devolver (F-10).
--
-- `estado` e `graca_ate` entram **aqui**, no dono da função, e não em
-- `mavia_admin_escrita`: a função aplica a transição do domínio e exige o
-- estado de origem. Um `UPDATE` de coluna solta não tem como recusar
-- `expirada → ativa` sem pagamento (F-2).
--
-- `atualizado_em` entra só para que um `UPDATE` que a mencione não estoure por
-- privilégio — o valor que vale é o do gatilho do ticket 08 (F-16).

GRANT SELECT (tenant_id, estado, plano, intervalo, periodo_inicio, periodo_fim,
              graca_ate, stripe_customer_id, stripe_subscription_id, criado_em,
              atualizado_em)
  ON assinaturas TO mavia_admin_contrato;

GRANT UPDATE (plano, intervalo, estado, graca_ate, atualizado_em)
  ON assinaturas TO mavia_admin_contrato;

-- Para `admin.cadastrar_cliente` (ticket 09). `SELECT` em `tenant_usuarios`
-- porque criar vínculo exige conferir que ele não existe.
GRANT INSERT (id, nome, timezone, moeda_base) ON tenants TO mavia_admin_contrato;
GRANT SELECT (tenant_id, usuario_id, papel, criado_em) ON tenant_usuarios TO mavia_admin_contrato;
GRANT INSERT (tenant_id, usuario_id, papel) ON tenant_usuarios TO mavia_admin_contrato;
GRANT SELECT (id, email, nome, deleted_at) ON usuarios TO mavia_admin_contrato;
