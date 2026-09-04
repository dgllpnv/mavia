Status: resolved
Blocked by: 05, 08

> **Atenção ao bloqueio.** A tabela de fatias do épico diz `Blocked by: 05`. Este ticket declara **05 e 08**, e a razão é de migration, não de gosto: `admin.registrar_pagamento` escreve `origem_da_ultima_escrita` (§8.6, critério 21), coluna que a §Modelo de dados cria no `ALTER TABLE assinaturas` do ticket 08. Migration é forward-only — ou 08 vem antes, ou aquele `ALTER` migra para cá. Escolhi reordenar em vez de mover escopo, porque as três colunas novas de `assinaturas` numa migration só é o que o spec escreve. **Se o dono preferir 07 ∥ 08**, o conserto é mover `origem_da_ultima_escrita` + o `CREATE OR REPLACE` de `auth.aplicar_estado_da_assinatura` para a migration deste ticket, e o bloqueio volta a ser só 05. Ver `README.md`.

# 07 · `pagamentos_manuais`, a baixa e a pré-checagem de semelhança

## Objetivo

Depois deste ticket o operador dá baixa num pagamento recebido fora da Stripe, o cliente que pagou **não expira no 15º dia**, e uma segunda baixa do mesmo Pix é impossível de esconder — do índice único, da pré-checagem de semelhança e da lista na tela, nessa ordem. É a primeira escrita do painel, e ela é escrita financeira.

## A seção do spec que governa

- **Modelo de dados** — `pagamentos_manuais` campo a campo: enum de **quatro** valores, `competencia` gerada, `referencia_externa` obrigatória, índice único parcial, RLS `ENABLE` + `FORCE`, `deleted_at`, e por que a FK de `registrado_por` se sustenta.
- **§8.1 (F-1, F-2)** — `estado` não está em `GRANT` de rota nenhuma; a transição é a do domínio, aplicando `pagamento_recuperado` (`catalogo.ts:172`); a função relê `FOR UPDATE` e exige `estado = p_de`.
- **§8.2 a–e (F-3 a F-7)** — o tipo e a moeda; a competência gerada; a idempotência; a exportação do titular; e por que cortesia e ajuste saem do enum.
- **§8.0** — a escrita mora numa função `SECURITY DEFINER` de `mavia_admin_contrato`, com os seis passos obrigatórios.
- **§8.5 (F-14)** — a **segunda** linha de `auditoria`, a do efeito, com `de`/`para` e a mesma `correlacao`.
- **§8.7** — o que este épico deliberadamente não toca no razão, e por que isso é acerto.

## O que entra, e onde

**Migration `0034_pagamentos_manuais.sql`.**

1. `CREATE TYPE meio_de_pagamento AS ENUM ('pix', 'transferencia', 'boleto', 'dinheiro')` — **quatro**, e acabou.
2. `CREATE TABLE pagamentos_manuais` exatamente como a §Modelo de dados escreve: `valor_centavos BIGINT CHECK (> 0)`, `moeda CHAR(3) CHECK (= 'BRL')`, `recebido_em TIMESTAMPTZ NOT NULL`, `competencia DATE GENERATED ALWAYS AS ((date_trunc('month', recebido_em AT TIME ZONE 'America/Sao_Paulo'))::date) STORED`, `CONSTRAINT competencia_no_dia_1`, `referencia_externa TEXT NOT NULL CHECK (length(btrim(…)) BETWEEN 6 AND 140)`, `observacao`, `deleted_at`.
3. `CREATE UNIQUE INDEX pagamento_manual_unico ON pagamentos_manuais (tenant_id, meio, referencia_externa) WHERE deleted_at IS NULL` e o índice por competência.
4. RLS `ENABLE` + `FORCE`, `tenant_isolation` **sem cláusula `TO`**, no padrão de `0006_nucleo.sql:271-277`.
5. `GRANT SELECT` **nominal por coluna** a `mavia_app` nas **nove** colunas de §8.2 d — `id, valor_centavos, moeda, competencia, recebido_em, meio, referencia_externa, observacao, registrado_em`. **`registrado_por` fora, por construção.**
6. `GRANT SELECT (as nove) ON pagamentos_manuais TO mavia_admin` — a lista de baixas anteriores, também sem `registrado_por` (§1.2).
7. `GRANT SELECT, INSERT, UPDATE (deleted_at) ON pagamentos_manuais TO mavia_admin_contrato`.
8. `admin.registrar_pagamento(p_alvo uuid, p_de estado_da_assinatura, p_para estado_da_assinatura, …)` — dono `mavia_admin_contrato`, `SET search_path`, e uma linha em `FUNCOES_DE_ADMIN`.

**Código:**

- `POST /v1/admin/clientes/:tenantId/pagamentos` — `mavia_admin_escrita` → `admin.abrir_espaco_para_escrita` → `admin.registrar_pagamento`.
- `GET /v1/admin/clientes/:tenantId/pagamentos` — a **quarta** tela de cliente, servida por `mavia_admin`, passando por `admin.abrir_espaco` como qualquer leitura.
- `pagamentosRecebidos(tenantId, janela)` — **o único ponto do repositório que lê `pagamentos_manuais` para somar**, aplicando `deleted_at IS NULL` e a janela semiaberta `[inicio, fim)`.
- A rota lê a assinatura, computa `destino = transicao(atual, 'pagamento_recuperado')` **no domínio** e recusa com `409` se for `null`.

**A função, na ordem de §8.0:** exige `app.tenant_id` definido e igual a `p_alvo`; confere concessão ativa por dentro; lê `FOR UPDATE`; recusa a transição inexistente; escreve; grava a **segunda** linha de auditoria com `de`/`para` e a `correlacao` devolvida pela abertura.

## Critérios de aceite

**Domínio** (`packages/domain`, sem I/O)

1. A baixa usa **`pagamento_recuperado`**, e `transicao('em_atraso', 'pagamento_recuperado') === 'ativa'`. Para os outros quatro estados de origem, a mesma chamada devolve `null`. **Nenhum estado novo, nenhuma transição nova** — a tabela de `catalogo.ts:160-185` continua sendo a única.
2. `transicao('expirada', 'pagamento_recuperado')` é `null`. A asserção existe para que ninguém acrescente a transição "para facilitar o atendimento".
3. Nenhum `number` monetário no módulo do painel: `valor_centavos` é `bigint` do parse à resposta, e a serialização é `.toString()`, como `precoCentavos` já faz (`cobranca.controller.ts:349`). Um `JSON.parse` do corpo com `9007199254740993` centavos volta íntegro.
4. A competência de `2026-09-30T22:00-03:00` é **setembro**, e a de `2026-10-01T00:30-03:00` é **outubro** — o caso que vira o mês quando calculado em UTC nu.

**Esquema**

5. `valor_centavos` é `BIGINT` com `CHECK (> 0)`; `moeda` é `CHAR(3)` com `CHECK (= 'BRL')`; `competencia` é `GENERATED … STORED` e tem a `CHECK` do dia 1. Um `INSERT` com valor **zero**, **negativo** ou moeda `USD` é **rejeitado pelo banco**.
6. Nenhum tenant tem `moeda_base <> 'BRL'` (`0001_fundacao.sql:49`, sem `CHECK`). *É o teste que precisa quebrar no dia da segunda moeda, e é por isso que ele existe antes dela.*
7. O enum `meio_de_pagamento` tem **exatamente** `pix`, `transferencia`, `boleto`, `dinheiro`. `cortesia` e `ajuste` **não** são valores válidos.
8. Existe `UNIQUE (tenant_id, meio, referencia_externa) WHERE deleted_at IS NULL`, e `referencia_externa` é `NOT NULL`.
9. `mavia_app` tem `SELECT` **exatamente** nas nove colunas de §8.2 d e **não** tem em `registrado_por` — `information_schema.column_privileges`, nominal.
10. `mavia_admin_escrita` **não tem `INSERT` em `pagamentos_manuais`**, e continua sem `UPDATE` em `assinaturas`.
11. `CHECK (recebido_em <= now())` **não é criável** — `now()` é estável, não imutável, e o Postgres recusa a constraint. *É o teste irmão que prova por que a guarda de data futura mora na função.*

**Integração** (Postgres real)

12. `pagamentos_manuais` tem RLS `ENABLE` + `FORCE` e policy de tenant; um segundo tenant **não enxerga** a linha do primeiro.
13. **Dar baixa num cliente `em_atraso` deixa `estado = 'ativa'` e `graca_ate IS NULL`, na mesma transação do `INSERT`.** É o cenário do parecer, ponta a ponta: o cliente que pagou não expira no 15º dia.
14. Um `UPDATE assinaturas SET estado = 'ativa', graca_ate = <ts>` é **rejeitado pelo banco** pela `CHECK graca_so_em_atraso` (`0025_assinatura.sql:48-49`), e não por `if` na aplicação.
15. `mavia_admin_escrita` leva `permission denied` em `UPDATE assinaturas` e em `INSERT INTO pagamentos_manuais` — as duas escritas só existem por dentro das funções.
16. `admin.registrar_pagamento` chamada com `p_de` diferente do estado corrente levanta `TRANSICAO_OBSOLETA` e **não grava o pagamento**. Simulado com um webhook que muda o estado entre a leitura e a chamada.
17. Chamada com `p_para` que não seja `'ativa'`, ou com `p_de` que não seja `'em_atraso'`, a função **levanta erro**. `expirada → ativa` **não é produzível por esta função por nenhum caminho**.
18. Baixa num cliente que **não** está `em_atraso`: a baixa é gravada e **nenhuma transição acontece**. Não é erro — é o caso comum de quem paga em dia por Pix.
19. A segunda baixa com a mesma `referencia_externa` levanta `23505`, a rota devolve **`409` nomeando a linha existente e a data em que ela foi registrada** (nunca "erro ao salvar"), e a **contagem de linhas não muda**. *O teste roda as duas chamadas em conexões distintas — é o cenário dos dois operadores.*
20. Baixa **semelhante** — mesma `(tenant_id, valor_centavos, competencia)` viva, referência nova — devolve `409` com o `id` e a `referencia_externa` da existente; reenviada com `confirmado_semelhante = true`, grava, **e a confirmação aparece na linha de auditoria**.
21. `recebido_em` no futuro é recusado pela função com `RECEBIMENTO_NO_FUTURO`, e a rota devolve `400`.
22. Baixa registrada às 22h de 30/09 em São Paulo tem `competencia = 2026-09-01`, e a de 00h30 de 01/10 tem `2026-10-01`. Rodado com a sessão em `UTC` **e** em `America/Sao_Paulo`, com o mesmo resultado nas duas.
23. Um pagamento anual de `99000` gera **uma** linha em **uma** competência. Nenhuma divisão acontece: o teste percorre o SQL emitido e falha se encontrar `/` ou `div` no caminho da baixa.
24. `pagamentosRecebidos` é o **único** ponto que agrega a tabela: um teste percorre o repositório e falha se `pagamentos_manuais` aparecer sob `sum(`, `count(` ou `avg(` fora dela. E uma linha com `deleted_at` preenchido **não entra** no total e **entra** na listagem.
25. `GET /v1/admin/clientes/:tenantId/pagamentos` devolve as baixas anteriores **sem `registrado_por`**, passa por `admin.abrir_espaco` e deixa a sua linha de auditoria como qualquer outra leitura.
26. A exportação do titular (`mavia_app`) **lê `pagamentos_manuais` e devolve as linhas**, com as nove colunas e sem `registrado_por`. *É o teste que a v3.1 não teria passado: não havia `GRANT`, e a exportação levantaria `permission denied` na tabela que ela promete exportar.*
27. `admin.registrar_pagamento` roda **na primeira execução** contra o esquema recém-migrado, pelo pool de escrita — sem `permission denied` de esquema, de tabela, de `concessoes_de_admin` ou de `auditoria`.
28. Chamá-la **sem** `admin.abrir_espaco_para_escrita` levanta **erro** — e não afeta zero linhas em silêncio. Chamá-la com `p_alvo` diferente do `app.tenant_id` aberto levanta erro também.
29. O teste prova as duas metades do achado **por baixo** da função: emitindo o DML cru como `mavia_admin_contrato` **sem** o GUC, o `UPDATE` de `assinaturas` afeta **zero linhas** e o `INSERT` em `pagamentos_manuais` viola o `WITH CHECK`. *A função converte o silêncio em erro; o teste prova que o silêncio era o comportamento de baixo.*
30. A baixa deixa **duas** linhas de `auditoria` com a mesma `correlacao`: a de intenção **sem** `de`/`para`, e a de efeito com os dois preenchidos e **iguais ao antes e depois lidos na tabela**. Uma baixa que falha deixa **zero**.
31. O `de` da linha de efeito vem do `SELECT … FOR UPDATE`, **e não do que a rota mandou**: um teste passa um `de` mentiroso no corpo e a linha registrada continua sendo o valor real da tabela.
32. Duas baixas simultâneas no mesmo cliente serializam pelo `FOR UPDATE`: a segunda enxerga o estado que a primeira deixou, e as quatro linhas de auditoria saem na ordem.
33. A baixa deixa `origem_da_ultima_escrita = 'painel'` em `assinaturas`, e o webhook deixa `'stripe'`.
34. **Sabotagem:** com o `INSERT` da segunda linha de auditoria forçado a falhar, a transação desfaz **inclusive o `INSERT` do pagamento**, e a resposta não sai.
35. **Nenhuma escrita do painel cria `Lancamento`:** contagem de `lancamentos`, `transferencias`, `contas`, `faturas` e `saldo_snapshots` idêntica antes e depois de uma baixa.

## Armadilhas conhecidas

- **F-1 · Dar baixa não pagava nada.** Na v3.1 a baixa inseria uma linha e **não tocava `assinaturas`** — não havia coluna ligando as duas tabelas. Quem governa o direito de uso é `assinaturas.estado`, lido por `lerAssinatura` (`cobranca.controller.ts:311`, `:319`) e traduzido por `podeEscrever` (`catalogo.ts:201-203`, aplicado em `:350`). O cliente que pagou virava `expirada` no 15º dia.
- **F-2 · Um `GRANT` de coluna não sabe recusar uma transição.** `UPDATE assinaturas SET estado = 'ativa'` numa linha `expirada` é reativação sem pagamento, e o `GRANT` a autoriza tanto quanto autoriza a legítima. Quem sabe recusar é `transicao()` (`catalogo.ts:187-192`), que é **domínio e não roda no Postgres**. Por isso a assinatura da função carrega `p_de`/`p_para`, no mesmo contrato que o webhook já usa (`cobranca.controller.ts:228-239`) — **não reescreva `TRANSICOES` em SQL**: duas fontes de verdade para a mesma regra é o que `spec-planos:520` proíbe entre nós e a Stripe.
- **A limpeza de `graca_ate` não é opcional — o banco já a exige.** `CHECK graca_so_em_atraso` (`0025_assinatura.sql:48-49`) diz `(estado = 'em_atraso') = (graca_ate IS NOT NULL)`. Use a mesma expressão do webhook (`0025_assinatura.sql:181`): `graca_ate = CASE WHEN p_para = 'em_atraso' THEN graca_ate END`.
- **F-3 · A baixa duplicada era indetectável, inclusive pelo operador.** Sem chave de idempotência, sem índice único, e **nenhum papel tinha `SELECT`** — nem o operador. Dois operadores davam baixa no mesmo Pix em horas diferentes e a escrituração somava R$ 198,00 sobre R$ 99,00 recebidos. O índice único **não** resolve a digitação divergente: por isso a pré-checagem de semelhança, a `409` que nomeia a linha, o `confirmado_semelhante` auditado, e **a lista antes do botão**. Sugestão, não sobrescrita — regra 15 aplicada a um caso que não é conciliação bancária mas tem o mesmo formato.
- **`referencia_externa` é `NOT NULL` inclusive para `dinheiro`.** Quem recebe em espécie escreve o número do recibo; **se não há recibo não há baixa**. É a chave da regra 13 na forma que esta tabela permite.
- **F-4 · Policy sem `GRANT` não lê nada, uma tabela adiante (S3-3).** A exportação roda como `mavia_app` (`exportacao.controller.ts:238` → `comTenant` → `'mavia_app'` em `tenancy.ts:74`). A v3.1 mandava exportar a tabela sem conceder `SELECT` a `mavia_app`: a `tenant_isolation` estava escrita, o `GRANT` não. O critério 26 é quem pega isso.
- **F-5 · `competencia` não é digitada e não vem do relógio de quem grava.** `CONTEXT.md:34-39` é normativo: `DATE` no dia 1, convertendo para `America/Sao_Paulo` **antes** de extrair mês e ano. Coluna **gerada**, e não conferida por `CHECK`: uma coluna gerada não pode divergir da regra, enquanto um `CHECK` só reprova quem errou. A `CHECK` fica junto como documentação executável.
- **F-6 · Uma linha de R$ 0,00 sai ao titular como um pagamento que ele não fez.** É o formato exato do erro que a **regra 12b** nomeia. Aqui a exclusão nem existe: **a tabela não contém linha não-monetária**, e a única exclusão que resta é a de estornos, num tradutor único.
- **F-7 · `INTEGER` estoura em R$ 21.474.836,47** — improvável numa baixa e irrelevante como argumento. O padrão da casa é `BIGINT` e não se abre exceção por probabilidade.
- **Nada disso cria `Lancamento` (§8.2 e, §8.7).** Uma baixa é dinheiro que entrou **na Mavia**, não no espaço do cliente. Não toca `lancamentos`, `contas`, `faturas`, `transferencias` nem `saldo_snapshots`, não altera saldo nenhum e não aparece em relatório dele. As regras 4, 5, 6, 12 e 12b não são exercitadas **porque o épico não escreve no razão** — e o critério 35 é quem prova.
- **`deleted_at` marca estorno de baixa registrada por engano, nunca eliminação** — a linha sobrevive à eliminação do espaço por obrigação fiscal (`retencao-e-eliminacao.md` §3.6, §5.3, regras **R-08** e **R-22**). `pagamentos_manuais` é a **quinta** tabela com `tenant_id` na lista de sobreviventes, e **sem essa linha a R-08 reprova a implementação do painel**.
- **A FK de `registrado_por` só se sustenta por uma coincidência de prazos**, e ela está escrita: *quem é, ou foi nos últimos 5 anos, administrador não elimina a própria conta pela rota do titular* (§4), e a linha de pagamento vive exatamente 5 anos. **Se um dos dois prazos mudar, esta tabela ganha um `email_no_ato`** pelo mesmo argumento da §4.
- **`observacao` é livre e opcional, e a UI diz ao lado do campo:** *"esta observação pode ser lida pelo cliente se ele pedir os dados dele"*. Mata a categoria "nota interna sobre o cliente que ninguém previa que sairia". Nota para o ticket 12. *(A `retencao-e-eliminacao.md` **R-30** exige que `observacao` esteja nula depois da eliminação do espaço, por `GRANT UPDATE (observacao) ON pagamentos_manuais TO mavia_retencao` — o papel **não existe** e está fora deste épico; o requisito é **de deploy** do caminho de eliminação, e fica registrado aqui para não sumir.)*
- **`GRANT` de dono (`bootstrap-papeis.sql:36-44`).** Os `GRANT` por coluna desta migration rodam como `mavia_migrate`. Os critérios 9 e 10 são quem transformam o `WARNING` em falha visível — e o 26 é quem prova, ponta a ponta, que o privilégio existe de verdade.

## Decisões pendentes que este ticket toca

- **DP-36** — *dar baixa fora da Stripe restabelece o direito de uso?* **Padrão vigente: sim, na mesma transação**, aplicando `pagamento_recuperado` e limpando `graca_ate`. É o que os critérios 13 e 14 implementam. **Se o dono responder "não, o operador restabelece à parte"**, passam a existir dois atos onde há um pagamento, e o segundo é esquecível; a tela teria de **recusar a baixa de quem está `em_atraso`** — o único caso em que ela importa.
- **DP-37** — *competência do recebimento ou do período coberto?* **Padrão vigente: do recebimento, uma linha por pagamento, sem rateio.** **Se for a do período coberto**, um pagamento anual vira doze linhas, `59000/12` e `79000/12` **não são exatos**, e volta ao caminho do dinheiro a divisão que `spec-planos:308-310` se orgulha de não ter — trazendo `ratear`, a regra 3 e a prova por propriedade junto. O critério 23 é o que quebra no dia em que alguém tentar.
- **DP-38** — *cortesia é dinheiro?* **Padrão vigente: não, e por isso sai da tabela.** Atenção: `docs/decisoes-do-produto.md:141` ainda registra a forma **mais fraca** (`valor_centavos = 0` com o valor concedido em campo próprio), que é a proposta do parecer e **não** o que a v3.2 decidiu. O spec rejeita a forma fraca por escrito — ela resolve o total e **não** resolve a exportação. **Este ticket implementa o spec** (enum de quatro valores), e o índice de decisões precisa ser atualizado pela mão do coordenador. Registrado no `README.md`.

## O que este ticket não faz

- **Não troca plano nem intervalo** (DP-40, §8.3). A rota **não existe** — não é 403 nem 404 de controle, é ação que o épico não tem.
- Não implementa `cortesia_ate`, `prorrogar_teste` nem `conceder_cortesia` (ticket 08).
- Não implementa `cadastrar_cliente` (ticket 09).
- Não acrescenta o terceiro estado `EXPORTADA_EM_PARTE` ao teste de completude (ticket 11) — só produz a condição que o exige.
- Não calcula nem executa reembolso. A fórmula é do épico 11 e lê um `valor_pago` que **não existe persistido**: a tabela `cobrancas` não foi criada por migration nenhuma. A metade que cabe aqui é a tela avisar o operador (ticket 12, §9 item 3).
