-- 0047 · As correções do parecer de segurança de 2026-09-05
--
-- O parecer do `especialista-seguranca-appsec` sobre as migrations 0043–0046
-- vetou dois achados. Esta migration fecha o que é de banco; o que é de rota
-- está no `admin.controller.ts`.
--
-- **A circunstância fica registrada:** este trabalho foi a produção sem spec e
-- sem gate de risco. A ADR 0024 e a 0025 existem, mas ADR não é spec — nenhuma
-- passou por modelo de ameaças de rota. Os dois bloqueadores abaixo são o custo
-- previsto disso, e uma leitura de spec os teria custado minutos.

-- ---------------------------------------------------------------------------
-- S-1 · `precos_vigentes` estava sem RLS, e a rota que a lê não conferia nada
-- ---------------------------------------------------------------------------
-- **Qualquer cliente autenticado lia o histórico de preços com a nota interna
-- do operador e o UUID de quem a escreveu.** Provado contra a API real: um
-- usuário comum recebia `403` em `/v1/admin/clientes` e `200` em
-- `/v1/admin/precos`.
--
-- Foram três omissões que se somaram, e nenhuma sozinha teria bastado:
--
--   1. a tabela nasceu **sem `ENABLE ROW LEVEL SECURITY`** — a única desta leva
--      assim, enquanto `descontos_de_cliente` recebeu;
--   2. o `GRANT` foi de tabela inteira para `mavia_admin`;
--   3. a rota faz `SELECT` direto, sem passar por função `admin.*` — e **toda a
--      autorização do painel mora dentro das funções `SECURITY DEFINER`**.
--
-- O dano hoje é zero porque a tabela está vazia. Isso é cronograma, não
-- controle: a primeira troca de preço armaria o vazamento.
--
-- A `0043` protegia `motivo` com `GRANT` nominal contra `mavia_app`, e o
-- vazamento veio pelo outro lado. É a lição a guardar: proteger uma coluna
-- contra um papel não a protege contra os outros.
ALTER TABLE precos_vigentes ENABLE ROW LEVEL SECURITY;
ALTER TABLE precos_vigentes FORCE  ROW LEVEL SECURITY;

-- Mesma forma de `definer_le_tenants` (`0032`): o painel só enxerga com
-- concessão ativa. Sem ela, zero linhas — e não erro, que já vazaria a
-- existência da tabela.
CREATE POLICY precos_para_o_painel ON precos_vigentes
  FOR SELECT TO mavia_admin USING (admin.tem_concessao_ativa());

-- O dono das funções escreve e lê sem restrição de linha: quem confere a
-- concessão é o corpo delas, e uma policy que consultasse a concessão aqui
-- repetiria a checagem em dois lugares que podem divergir.
CREATE POLICY precos_para_o_contrato ON precos_vigentes
  FOR ALL TO mavia_admin_contrato USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- S-7 · `GRANT` por tabela onde a `0029` exige por coluna
-- ---------------------------------------------------------------------------
-- A propriedade que a `0029` compra é **"uma coluna nova não se estende
-- sozinha"**. `GRANT SELECT ON tabela` a desfaz em silêncio. Não vaza nada
-- hoje; é a trava que não existiria amanhã.
REVOKE SELECT ON precos_vigentes FROM mavia_admin;
GRANT SELECT (id, plano, intervalo, valor_centavos, moeda, stripe_price_id,
              vigente_desde, criado_por, motivo)
  ON precos_vigentes TO mavia_admin;

REVOKE SELECT ON descontos_de_cliente FROM mavia_admin;
GRANT SELECT (id, tenant_id, especie, pontos_base, valor_centavos, moeda,
              duracao, meses, stripe_coupon_id, motivo, concedido_por,
              concedido_em, revogado_em, revogado_por)
  ON descontos_de_cliente TO mavia_admin;

-- ---------------------------------------------------------------------------
-- S-1 · a leitura passa a ser função, como todas as outras do painel
-- ---------------------------------------------------------------------------
SET ROLE mavia_admin_contrato;

-- A rota deixa de fazer `SELECT` direto. A checagem de concessão vive **dentro**
-- da função, que é onde ela vive para todas as outras leituras do painel — e é
-- por isso que este defeito foi possível: a rota era a única que não seguia a
-- forma.
CREATE OR REPLACE FUNCTION admin.listar_precos(p_limite INT DEFAULT 100)
RETURNS TABLE (
  id UUID, plano TEXT, intervalo intervalo_de_cobranca,
  valor_centavos TEXT, moeda TEXT, stripe_price_id TEXT,
  vigente_desde TIMESTAMPTZ, criado_por UUID, motivo TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $fn$
BEGIN
  IF nullif(current_setting('app.usuario_id', true), '') IS NULL
     OR NOT admin.tem_concessao_ativa() THEN
    RAISE EXCEPTION 'SEM_CONCESSAO_DE_ADMIN' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
    SELECT p.id, p.plano, p.intervalo, p.valor_centavos::text, p.moeda,
           p.stripe_price_id, p.vigente_desde, p.criado_por, p.motivo
      FROM precos_vigentes p
     ORDER BY p.vigente_desde DESC
     LIMIT least(greatest(coalesce(p_limite, 100), 1), 200);
END;
$fn$;

REVOKE ALL ON FUNCTION admin.listar_precos(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.listar_precos(INT) TO mavia_admin;

-- ---------------------------------------------------------------------------
-- S-4 · quem revoga operador — o código e o comentário discordavam
-- ---------------------------------------------------------------------------
-- A `0045` escreveu a justificativa: *"um operador comprometido que percebe o
-- comprometimento precisa poder se desligar sem esperar por outro"*. A `0046`
-- revogou isso ao exigir `super`, sem mencionar — e o controlador continuou
-- documentando a auto-revogação como controle vivo.
--
-- **Um controle descrito e ausente é pior que ausente**: alguém vai contar com
-- ele durante um incidente. E sem MFA (DP-32 revista) esta era a contenção que
-- restava — a alternativa é SSH na VPS.
--
-- A regra que fecha as duas exigências, e que é a leitura literal do pedido do
-- dono (*"a única diferença do admin é a possibilidade de **conceder**"*):
--
--   • **desligar a si mesmo** — qualquer operador, sempre;
--   • **desligar outra pessoa** — só `super`.
--
-- Conceder continua exclusivo de `super`, como pedido. As invariantes de
-- contagem seguem valendo por cima das duas.
CREATE OR REPLACE FUNCTION admin.revogar_operador(
  p_email      TEXT,
  p_correlacao UUID
) RETURNS TABLE (usuario UUID, ativos INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $fn$
DECLARE
  v_operador UUID := nullif(current_setting('app.usuario_id', true), '')::uuid;
  v_alvo     UUID;
  v_ativos   INT;
BEGIN
  IF v_operador IS NULL OR NOT admin.tem_concessao_ativa() THEN
    RAISE EXCEPTION 'SEM_CONCESSAO_DE_ADMIN' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_alvo FROM usuarios
   WHERE lower(email) = lower(btrim(p_email)) AND deleted_at IS NULL;

  IF v_alvo IS NULL THEN
    RAISE EXCEPTION 'USUARIO_INEXISTENTE' USING ERRCODE = 'P0001';
  END IF;

  -- A checagem de `super` vem **depois** de resolver o alvo, e só neste ramo:
  -- é preciso saber quem é o alvo para saber se é a própria pessoa. Isso não
  -- cria oráculo — `USUARIO_INEXISTENTE` já era alcançável por qualquer
  -- operador antes desta linha, e um operador enumera a base inteira por
  -- `admin.listar_clientes` de qualquer forma.
  IF v_alvo <> v_operador AND NOT admin.tem_concessao_super() THEN
    RAISE EXCEPTION 'EXIGE_SUPERADMIN' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM concessoes_de_admin
                  WHERE usuario_id = v_alvo AND revogada_em IS NULL) THEN
    RAISE EXCEPTION 'NAO_E_OPERADOR' USING ERRCODE = 'P0001';
  END IF;

  PERFORM admin.revogar(v_alvo, v_operador);

  SELECT count(*) INTO v_ativos FROM concessoes_de_admin WHERE revogada_em IS NULL;
  RETURN QUERY SELECT v_alvo, v_ativos;
END;
$fn$;

RESET ROLE;

-- **`preco_vigente` vive em `public`, e por isso é recriada aqui e não acima.**
-- Dentro do `SET ROLE mavia_admin_contrato` a migration morria em `permission
-- denied for schema public`: aquele papel é dono de funções em `admin`, não em
-- `public`. A dona desta é `mavia_migrate`, como na `0044`, e `CREATE OR
-- REPLACE` exige ser o dono.

-- ---------------------------------------------------------------------------
-- S-5 · `preco_vigente()` prometia servir a vitrine e não executava
-- ---------------------------------------------------------------------------
-- A `0044` a declarou *"pública ao produto — a vitrine, o checkout e a tela de
-- plano do cliente"* e concedeu `EXECUTE` a `mavia_app`. Faltou o resto:
-- `SECURITY INVOKER` sobre uma tabela sem `GRANT` para aquele papel dá
-- `permission denied for table`.
--
-- O modo de falha é o pior possível para a ADR 0025: **o cliente veria o preço
-- do catálogo em código enquanto o painel afirma outro.** `SECURITY DEFINER` é
-- a convenção do repositório para leitura estreita e projetada, e é o que ela
-- já deveria ser.
CREATE OR REPLACE FUNCTION preco_vigente(p_plano TEXT, p_intervalo intervalo_de_cobranca)
RETURNS TABLE (valor_centavos BIGINT, moeda TEXT, stripe_price_id TEXT)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT p.valor_centavos, p.moeda, p.stripe_price_id
    FROM precos_vigentes p
   WHERE p.plano = p_plano
     AND p.intervalo = p_intervalo
     AND p.vigente_desde <= now()
   ORDER BY p.vigente_desde DESC
   LIMIT 1
$fn$;


-- ---------------------------------------------------------------------------
-- S-8 · as duas perguntas de concessão tinham `EXECUTE` para `PUBLIC`
-- ---------------------------------------------------------------------------
-- Toda outra função de `admin` tem `REVOKE ALL ... FROM PUBLIC` explícito;
-- estas duas não tinham. O que as continha era uma coisa só: `mavia_app` não
-- tem `USAGE` no schema `admin`.
--
-- **Um `GRANT USAGE ON SCHEMA admin` futuro — a coisa mais banal numa
-- migration — daria a qualquer sessão de cliente um oráculo de "fulano é
-- operador?"**, por `set_config('app.usuario_id', <uuid>)`. Teórico hoje, e a
-- distância até deixar de ser é uma linha.
--
-- **E a justificativa escrita na `0046` estava errada**: ela dizia que a função
-- é dona de `mavia_migrate` *"porque uma função de policy precisa atravessar a
-- RLS da tabela que consulta"*. `prosecdef = false` — ela **não** atravessa
-- RLS. Ela funciona porque cada papel que a invoca tem policy própria em
-- `concessoes_de_admin`. A justificativa errada é a que o próximo leitor
-- reusaria para escrever a terceira.
REVOKE ALL ON FUNCTION admin.tem_concessao_ativa() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.tem_concessao_super() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.tem_concessao_ativa()
  TO mavia_admin, mavia_admin_escrita, mavia_admin_definer, mavia_admin_contrato;
GRANT EXECUTE ON FUNCTION admin.tem_concessao_super()
  TO mavia_admin, mavia_admin_escrita, mavia_admin_definer, mavia_admin_contrato;

-- ---------------------------------------------------------------------------
-- S-12 · `concessoes_de_admin` se diz append-only e não impõe — **não fechado
-- aqui, e a razão é honesta**
-- ---------------------------------------------------------------------------
-- A `0031` descreve a tabela como *"append-only"*, *"a história inteira
-- sobrevive"*, *"a evidência de que um operador existiu"*. Nada impõe isso:
-- `DELETE` e `TRUNCATE` como `mavia_migrate` passam, e os dois gatilhos de
-- invariante são `AFTER UPDATE`. **Não é alcançável por requisição** — nenhum
-- papel do painel tem `DELETE`.
--
-- O parecer classificou isto como **registrado**, o grau mais baixo, com a
-- recomendação de fechar *"quando alguém tocar aquela família de novo"*.
--
-- ## Eu tentei fechar agora, e desfiz
--
-- Escrevi o par `BEFORE DELETE`/`BEFORE TRUNCATE` na forma de
-- `AUDITORIA_IMUTAVEL`. Ele funciona e **derrubou onze testes**: a suíte de
-- concessões limpa a tabela com `DELETE` entre casos, porque a alternativa —
-- revogar — esbarra na própria invariante que ela existe para exercitar.
--
-- Fechar de verdade exige reescrever aquela suíte para trabalhar com ids novos
-- a cada caso e contagens relativas em vez de absolutas. É trabalho real, com
-- risco real, sobre a família de testes que guarda a invariante de dois
-- operadores — e não é o que os dois bloqueadores pediam.
--
-- **A alternativa que eu recusei foi pôr uma exceção por GUC no gatilho**, como
-- a `auditoria` tem. Lá a exceção existe porque há um caminho legítimo de
-- eliminação (art. 18 VI, com linha em `retencao_execucoes` para apontar). Aqui
-- **não há**: a `0031` copia o e-mail justamente porque a concessão precisa
-- sobreviver à eliminação da conta. Uma exceção sem caminho legítimo é um
-- portão de teste em código de produção, e ele estaria na única tabela que
-- registra quem teve poder administrativo.
--
-- Fica como ticket, com a forma já escrita e provada acima. Ver o parecer.
