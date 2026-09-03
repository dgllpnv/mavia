-- 0026 — Conexão, consentimento e a revogação em três fases.
--
-- Épico 12. Implementa o ADR 0018 (envelope encryption) §D4 e o ADR 0019
-- (revogação no `BankSyncProvider`) §D2 e §D6.
--
-- **Nenhum agregador está ligado.** A porta de receita do ADR 0003 não foi
-- atingida, e nenhum adapter que fale com Pluggy ou Belvo existe neste
-- repositório. O que existe aqui é o esqueleto que a decisão do ADR exige que
-- esteja pronto **antes** de a primeira credencial bancária entrar: as colunas,
-- o isolamento, a máquina de estados da revogação e a prova do consentimento.
--
-- A ordem não é burocracia. Uma conexão criada contra um esquema sem
-- `dek_cifrada` guarda credencial em claro; uma revogada contra um esquema sem
-- `revogacao_remota` mente ao titular dizendo "revogada" quando o acesso lá fora
-- continua vivo. Os dois erros são irreversíveis depois do primeiro usuário.

-- ---------------------------------------------------------------------------
-- Os estados
-- ---------------------------------------------------------------------------
CREATE TYPE estado_da_conexao AS ENUM (
  'ativa',
  -- O agregador pediu novo consentimento ou a credencial expirou. Não é erro:
  -- é o estado normal de um consentimento com prazo. O titular reconecta.
  'requer_atencao',
  'revogada'
);

-- **Dois fatos, e o produto não tem o direito de fundi-los** (ADR 0019 §D2).
-- "Revogada" descreve o que a Mavia fez com a credencial — sempre verdade, e
-- imediata. Isto aqui descreve o que sabemos do outro lado.
CREATE TYPE revogacao_no_provedor AS ENUM (
  'pendente',
  'confirmada',
  'falhou',
  -- Adapter sem acesso continuado a encerrar: `manual`, `ofx-import`,
  -- `csv-import`. Sem I/O, sem job, sem alerta (ADR 0019 §D5).
  'nao_aplicavel'
);

CREATE TYPE motivo_da_revogacao AS ENUM (
  'titular',
  'expiracao',
  'reconsentimento',
  'eliminacao_espaco',
  'eliminacao_titular'
);

-- ---------------------------------------------------------------------------
-- A conexão
-- ---------------------------------------------------------------------------
-- Uma conexão é o vínculo com uma origem de dado bancário. Hoje só existem
-- origens de arquivo, em que o "acesso" foi o titular entregar um extrato uma
-- vez. Amanhã existe o agregador, e a diferença entre os dois casos está na
-- ficha do adapter, não em `if` espalhado pelas rotas.
CREATE TABLE conexoes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants (id),

  -- O nome do adapter (`ofx-import`, `pluggy`). Nenhum código de aplicação
  -- ramifica sobre este valor — regra 14. Ele é rótulo de tela e de auditoria,
  -- e a chave do registro de adapters.
  provider       TEXT NOT NULL,
  -- Como o titular chama isto. "Itaú da Ana".
  apelido        TEXT NOT NULL,
  instituicao    TEXT,
  -- O id do recurso na origem (`item_id`, `consent_id`). Opaco, e não é
  -- segredo: sozinho ele não abre nada, porque a chamada ao agregador
  -- autentica com a chave de API da Mavia, que vive no guardião. É o que faz a
  -- retentativa de revogação continuar funcionando **depois** do crypto-shred.
  external_id    TEXT,

  status         estado_da_conexao NOT NULL DEFAULT 'ativa',

  -- ------------------------------------------------------------------------
  -- ADR 0018 §D4 — o envelope
  -- ------------------------------------------------------------------------
  -- O segredo, cifrado pela DEK. Nulo quando o adapter não tem segredo
  -- (`sem-credencial`, §D0) e nulo depois do crypto-shred.
  credenciais_cifradas BYTEA,
  -- A DEK, cifrada pela KEK, que vive no processo do guardião e **não** aqui.
  -- Um dump deste banco não abre nada: as duas colunas juntas ainda precisam da
  -- KEK, e a KEK não está no banco, nem no `.env`, nem no backup.
  dek_cifrada          BYTEA,
  -- A versão de KEK que selou a DEK. **É o que torna a rotação incremental
  -- possível**: sem ela restariam reenvelopar tudo num único movimento atômico
  -- ou nunca rotacionar.
  kek_versao           SMALLINT,
  dek_criada_em        TIMESTAMPTZ,

  -- Sustenta a regra de revogação da matriz de acesso §2.2: quem ligou é quem
  -- responde por ter ligado.
  criado_por     UUID NOT NULL REFERENCES usuarios (id),
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- O escopo consentido, cópia operacional. A cópia **probatória** fica em
  -- `consentimentos` e sobrevive à revogação; esta some com o crypto-shred.
  escopo         JSONB,

  sincronizada_em TIMESTAMPTZ,
  revogada_em     TIMESTAMPTZ,
  revogado_por    UUID REFERENCES usuarios (id),
  motivo_revogacao motivo_da_revogacao,
  revogacao_remota revogacao_no_provedor,
  -- Vocabulário nosso, nunca o corpo da resposta do agregador (ADR 0019 §D1,
  -- regra 3): um `detalhe` que ecoasse o provider carregaria segredo para o
  -- log na primeira falha estranha.
  revogacao_detalhe TEXT,
  revogacao_tentativas SMALLINT NOT NULL DEFAULT 0,

  deleted_at     TIMESTAMPTZ,

  -- **A credencial e a chave dela vivem e morrem juntas.** Um `UPDATE` que
  -- apagasse só uma produziria ciphertext eternamente ilegível (se sobrasse o
  -- ciphertext) ou uma chave órfã (se sobrasse a DEK) — e o defeito só
  -- apareceria na primeira leitura, semanas depois. O banco recusa os dois.
  CONSTRAINT envelope_completo CHECK (
    num_nonnulls(credenciais_cifradas, dek_cifrada, kek_versao, dek_criada_em) IN (0, 4)
  ),

  -- Revogada é revogada: sem data não há o que a auditoria mostre ao titular, e
  -- sem `revogacao_remota` a resposta da API não teria os dois fatos separados.
  CONSTRAINT revogacao_completa CHECK (
    (status <> 'revogada')
    OR (revogada_em IS NOT NULL AND revogacao_remota IS NOT NULL AND motivo_revogacao IS NOT NULL)
  ),

  -- **O crypto-shred é parte da revogação, não um passo posterior.** Uma
  -- conexão revogada com credencial viva é exatamente o incidente que a DP-9
  -- existe para impedir, e ele nasceria de um `UPDATE` que esqueceu uma coluna.
  CONSTRAINT revogada_nao_guarda_segredo CHECK (
    status <> 'revogada' OR (credenciais_cifradas IS NULL AND dek_cifrada IS NULL)
  )
);

CREATE INDEX conexoes_do_tenant ON conexoes (tenant_id) WHERE deleted_at IS NULL;

-- Um `external_id` por provider e por espaço: reconectar a mesma instituição
-- não cria uma segunda conexão viva competindo pela mesma origem.
CREATE UNIQUE INDEX conexao_por_origem
  ON conexoes (tenant_id, provider, external_id)
  WHERE external_id IS NOT NULL AND status <> 'revogada' AND deleted_at IS NULL;

-- O que o job `kek.reenvelopar` percorre. A métrica
-- `mavia_kek_reenvelope_pendentes` sai daqui, e zero é o estado esperado fora
-- da janela de rotação (ADR 0018 §D5).
CREATE INDEX conexoes_por_kek ON conexoes (kek_versao) WHERE dek_cifrada IS NOT NULL;

-- O que o job `conexao.revogar-no-provedor` retenta.
CREATE INDEX conexoes_com_revogacao_pendente ON conexoes (revogada_em)
  WHERE revogacao_remota = 'pendente';

-- ---------------------------------------------------------------------------
-- O consentimento — a prova
-- ---------------------------------------------------------------------------
-- **Nunca apagado pela revogação.** Retenção de 5 anos: é o documento que
-- responde "o titular autorizou isto, nesta data, nestes termos, e revogou
-- naquela". Se sumisse junto com a conexão, a revogação destruiria a prova de
-- que a coleta foi legítima — o oposto do que a LGPD pede.
CREATE TABLE consentimentos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants (id),
  conexao_id     UUID NOT NULL REFERENCES conexoes (id),

  -- Quem consentiu. Não é `criado_por` da conexão por acaso: são a mesma
  -- pessoa hoje e podem não ser amanhã, e a prova é sobre quem consentiu.
  usuario_id     UUID NOT NULL REFERENCES usuarios (id),

  -- A versão do texto apresentado. Sem ela, a prova diz "consentiu" sem dizer
  -- **com o quê** — e o texto muda.
  termos_versao  TEXT NOT NULL,
  escopo         JSONB NOT NULL,
  finalidade     TEXT NOT NULL,

  concedido_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Consentimento de Open Finance tem prazo por norma. Nulo só para as origens
  -- de arquivo, em que o ato foi entregar um arquivo, uma vez.
  expira_em      TIMESTAMPTZ,
  revogado_em    TIMESTAMPTZ,
  motivo_revogacao motivo_da_revogacao,

  -- O IP entra **hasheado com o pepper do guardião** (achado A-39): sem isso o
  -- endereço seria reversível por quem tivesse o banco, e o hash existe
  -- justamente para que não seja. Nulo quando o guardião estava selado — a
  -- prova do consentimento não pode depender do estado do cofre.
  ip_hash        BYTEA,

  CONSTRAINT consentimento_revogado_tem_motivo CHECK (
    (revogado_em IS NULL) = (motivo_revogacao IS NULL)
  )
);

CREATE INDEX consentimentos_da_conexao ON consentimentos (tenant_id, conexao_id);

-- ---------------------------------------------------------------------------
-- A sincronização
-- ---------------------------------------------------------------------------
-- Como o titular vê o que aconteceu e **quando parou**. Retenção de 12 meses.
CREATE TABLE sincronizacoes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants (id),
  conexao_id     UUID NOT NULL REFERENCES conexoes (id),

  comecou_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminou_em    TIMESTAMPTZ,
  registros      INTEGER NOT NULL DEFAULT 0,
  novos          INTEGER NOT NULL DEFAULT 0,
  -- Vocabulário nosso. Nunca o corpo da resposta do provider.
  falha          TEXT
);

CREATE INDEX sincronizacoes_da_conexao ON sincronizacoes (tenant_id, conexao_id, comecou_em DESC);

-- ---------------------------------------------------------------------------
-- O elo com o que já existe
-- ---------------------------------------------------------------------------
-- `lancamentos_brutos` já carrega `provider` e `external_id` desde a 0022. O que
-- faltava era saber **de qual conexão** cada linha veio — sem isso a Fase 3 da
-- revogação não tem como achar os payloads a destruir, e a DP-9 fica sem
-- executor. Nulo nas linhas de importação por arquivo anteriores a esta
-- migration.
ALTER TABLE lancamentos_brutos
  ADD COLUMN conexao_id UUID REFERENCES conexoes (id);

CREATE INDEX brutos_da_conexao ON lancamentos_brutos (tenant_id, conexao_id)
  WHERE conexao_id IS NOT NULL AND deleted_at IS NULL;

-- O payload cru da origem, separado dos campos normalizados **de propósito**.
-- Prazo imediato na revogação (§3.4 da retenção): ele não abre porta nenhuma,
-- mas guarda agência, conta e chave Pix **de terceiros**. Os campos
-- normalizados e o `conteudo_hash` sobrevivem — são o que impede a reconexão de
-- duplicar o histórico que o titular escolheu manter (ADR 0019 §D7-10).
ALTER TABLE lancamentos_brutos
  ADD COLUMN payload JSONB;

-- ADR 0018 §D4 pede `usuarios.mfa_kek_versao`, e ela já existe desde a 0002:
-- o MFA nasceu com o envelope, e a coluna veio junto. Nada a fazer aqui.

-- A conta que veio de uma conexão. Na revogação ela **não some**: volta a
-- `manual` e o titular continua dono do histórico (ADR 0019 §D6).
ALTER TABLE contas
  ADD COLUMN conexao_id UUID REFERENCES conexoes (id);

-- ---------------------------------------------------------------------------
-- Isolamento
-- ---------------------------------------------------------------------------
ALTER TABLE conexoes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE conexoes        FORCE  ROW LEVEL SECURITY;
ALTER TABLE consentimentos  ENABLE ROW LEVEL SECURITY;
ALTER TABLE consentimentos  FORCE  ROW LEVEL SECURITY;
ALTER TABLE sincronizacoes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sincronizacoes  FORCE  ROW LEVEL SECURITY;

CREATE POLICY conexao_do_tenant ON conexoes
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY consentimento_do_tenant ON consentimentos
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY sincronizacao_do_tenant ON sincronizacoes
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON conexoes       TO mavia_app;
GRANT SELECT, INSERT, UPDATE ON consentimentos TO mavia_app;
GRANT SELECT, INSERT, UPDATE ON sincronizacoes TO mavia_app;

-- **Sem `DELETE` em `consentimentos`.** A prova não é apagável pela aplicação,
-- e a ausência do grant é mais forte que a intenção de não escrever o `DELETE`.

-- ---------------------------------------------------------------------------
-- A Fase 1, como função
-- ---------------------------------------------------------------------------
-- ADR 0019 §D2: síncrona, transacional, **incondicional**. Nada aqui depende de
-- terceiro, e é por isso que ela é uma função e não uma sequência de statements
-- na rota: a ordem importa e a atomicidade é a garantia.
--
-- O que esta função **não** faz: falar com o provider. I/O de rede sob
-- transação aberta prende conexão de pool por segundos — e, o que decide a
-- questão, um timeout faria `ROLLBACK`, deixando a credencial **viva** depois
-- que o titular pediu para destruí-la. O pior resultado possível, produzido
-- pela ordem mais intuitiva.
CREATE FUNCTION revogar_conexao(
  p_conexao_id UUID,
  p_usuario_id UUID,
  p_motivo     motivo_da_revogacao,
  p_remota     revogacao_no_provedor
) RETURNS TABLE (
  ja_estava_revogada  BOOLEAN,
  external_id         TEXT,
  provider            TEXT,
  lancamentos_mantidos BIGINT,
  -- O estado do lado de lá **como está gravado**, e não como foi pedido. Na
  -- segunda revogação é a única resposta honesta: a primeira já decidiu, e
  -- devolver o valor pedido faria a tela dizer "nao_aplicavel" sobre uma
  -- conexão que está pendente de verdade.
  revogacao_atual     revogacao_no_provedor
) LANGUAGE plpgsql AS $$
DECLARE
  v_status estado_da_conexao;
  v_external TEXT;
  v_provider TEXT;
  v_remota revogacao_no_provedor;
BEGIN
  SELECT c.status, c.external_id, c.provider, c.revogacao_remota
    INTO v_status, v_external, v_provider, v_remota
    FROM conexoes c
   WHERE c.id = p_conexao_id AND c.deleted_at IS NULL
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conexao inexistente' USING ERRCODE = 'no_data_found';
  END IF;

  -- **Idempotência** (ADR 0019 §D4): a segunda revogação não é erro na tela do
  -- titular. Não há o que destruir de novo, e o `external_id` sai igual para
  -- que o job possa retentar lá fora se ainda estiver pendente.
  IF v_status = 'revogada' THEN
    RETURN QUERY SELECT true, v_external, v_provider, contar_lancamentos(p_conexao_id), v_remota;
    RETURN;
  END IF;

  UPDATE conexoes
     SET status               = 'revogada',
         credenciais_cifradas = NULL,
         dek_cifrada          = NULL,
         kek_versao           = NULL,
         dek_criada_em        = NULL,
         escopo               = NULL,
         revogada_em          = now(),
         revogado_por         = p_usuario_id,
         motivo_revogacao     = p_motivo,
         revogacao_remota     = p_remota
   WHERE id = p_conexao_id;

  -- A prova ganha a data. Na mesma transação, porque um consentimento sem
  -- `revogado_em` depois de a conexão morrer é uma prova que afirma o contrário
  -- do que aconteceu.
  UPDATE consentimentos
     SET revogado_em = now(), motivo_revogacao = p_motivo
   WHERE conexao_id = p_conexao_id AND revogado_em IS NULL;

  -- A conta continua existindo e passa a ser mantida pelo titular. Revogar o
  -- acesso ao banco não é pedir a destruição do próprio extrato.
  UPDATE contas SET origem = 'manual'
   WHERE conexao_id = p_conexao_id AND origem = 'conectado';

  RETURN QUERY SELECT false, v_external, v_provider, contar_lancamentos(p_conexao_id), p_remota;
END;
$$;

-- Quantos lançamentos permanecem. É o número que a resposta 200 devolve, e o
-- ponto dele é político, não informativo: o titular precisa ver que revogar o
-- acesso **não** apagou o histórico dele.
CREATE FUNCTION contar_lancamentos(p_conexao_id UUID) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT count(*)
    FROM lancamentos l
    JOIN lancamentos_brutos b ON b.lancamento_id = l.id
   WHERE b.conexao_id = p_conexao_id AND l.deleted_at IS NULL;
$$;

GRANT EXECUTE ON FUNCTION revogar_conexao(UUID, UUID, motivo_da_revogacao, revogacao_no_provedor)
  TO mavia_app;
GRANT EXECUTE ON FUNCTION contar_lancamentos(UUID) TO mavia_app;
