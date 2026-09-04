# Design — Perfil de administrador

- **Data:** 2026-09-04
- **Status:** **v3.2 — revisão da v3.1 sobre o parecer do `validador-financeiro`.** A v1 e a v2 foram reprovadas; a v3 passou no gate de segurança; a v3.1 fechou as condições de ticket dele. O validador financeiro revisou pela primeira vez e reprovou a parte de dinheiro: *"Este é um dos melhores specs de banco de dados que já li neste repositório. A parte de dinheiro dele não existe."* Esta revisão fecha os catorze achados que bloqueiam o ticket (F-1 a F-14), o que bloqueia o deploy (F-15) e a observação F-16.
- **A causa-raiz do parecer, dita antes de qualquer correção:** este documento citava `0025_assinatura.sql` cinco vezes, **sempre como fonte de policy de RLS e nunca como a máquina de dinheiro que ela é**, e não citava `docs/produto/spec-planos-e-assinatura.md` uma única vez em 922 linhas. As quatro escritas financeiras da §8 tinham um `GRANT` de cinco colunas e **uma** linha de teste. A correção estrutural é a subseção **"O contrato comercial"** em *O que restringe o desenho*, e a §8 refeita.
- **Pré-requisito aceito:** **ADR 0024 — Acesso administrativo entre espaços** (`docs/adr/0024-acesso-administrativo-entre-espacos.md`), **aceita pelo dono do produto**. Ela é a fonte da verdade de D1 a D6; este documento a executa e não a re-litiga. **A v3.2 exige uma emenda a ela** — a lista fechada do esquema `admin` (§8.0), pelo gatilho que a própria v3.1 registrou em *Erros e bordas · S3-4*.
- **Segundo pré-requisito, novo:** **`docs/produto/spec-planos-e-assinatura.md`** (épico 11) e o **`CONTEXT.md` §Assinatura**. As invariantes deles não se re-litigam aqui; onde este épico as atravessa, ele muda de desenho, não a invariante.
- **Nota de citação da ADR:** a D4 cita `0001_fundacao.sql:105-113` para o contraexemplo do `nullif`. O bloco correto é **`0001_fundacao.sql:107-114`** — verificado. A ADR não é editada aqui; **este documento usa o intervalo certo em toda menção**.
- **Convenção de citação — adotada na v3.2 por recomendação do parecer de LGPD.** Toda citação a documento normativo é **por identificador de regra** — `R-3`, `R-5`, `A-26`, `§3.12`, `DP-27` — **com a linha como apoio**, nesta ordem. Identificador não apodrece; linha apodrece a cada edição, e apodreceu: as citações a `matriz-de-acesso.md` desta v3.1 estavam **4 linhas adiantadas** porque aquele arquivo foi editado hoje, e uma delas passou a afirmar o contrário do que o arquivo diz (§"O que a v1 errou"). Todas foram reconferidas abrindo o arquivo. **Exceção declarada:** as citações **novas** a `docs/compliance/retencao-e-eliminacao.md` são **por seção**, sem linha. Aquele arquivo está sendo editado em paralelo pelo parecer de LGPD, e um número de linha escrito aqui hoje nasce vencido. As linhas que já estão na tabela de *LGPD — o que muda fora do código* são a evidência que o parecer de LGPD entregou para provar cada "Feito"; ficam como estão, e valem para a versão daquele arquivo naquele momento — não são reconferidas aqui, e quem as conferir depois da edição em curso deve esperar deslocamento.
- **Escopo:** o painel interno de operação da Mavia — quem são os clientes, qual o plano, o que foi pago, e o registro imutável do que o operador fez.
- **Fora de escopo:** MFA, cobrança automática pela Stripe (P-14), atendimento ao cliente dentro do produto.

---

## Problema

A Mavia está no ar e não tem como ser operada. Não há caminho para responder às perguntas que qualquer SaaS precisa responder no primeiro mês: quem são os clientes, quem pagou, quem está em atraso, e o que fizemos na conta de alguém quando ele reclamar.

Hoje isso só se resolve com `psql` na VPS. Um `UPDATE assinaturas` digitado à mão às onze da noite não tem revisão, não tem registro, e não tem como ser explicado depois.

O risco central não é construir as telas. É que **o painel atravessa o isolamento por RLS que é a espinha do produto** — pela primeira vez, alguém lê o espaço de um cliente sem pertencer a ele.

---

## O que a v1 errou

A v1 alegava: *"não é possível ler sem registrar, porque as duas coisas são a mesma transação"*. O gate mostrou que a frase era **falsa como escrita**, por três caminhos independentes — e que a salvaguarda que ela citava não existe.

| O que a v1 dizia | O que é verdade |
|---|---|
| "a regra de lint que hoje proíbe `withTenant(req.params.…)`" | **Ela não existe.** `eslint.config.js` tem quatro regras — `no-floating-promises`, `no-misused-promises`, `no-explicit-any`, `react-hooks/exhaustive-deps` — e nenhuma é essa. A função se chama `comTenant`, não `withTenant` |
| a nova cláusula de lint procuraria `SET LOCAL app.tenant_id` | O literal **não aparece no código**: `tenancy.ts:76-80` usa `set_config($1,$2,true)`. O lint casaria com zero linhas |
| "fora de `comTenantDeAdmin` não há como definir `app.tenant_id` de outro espaço" | `comTenant` aceita `tenantId: string` e **não verifica pertencimento** (`tenancy.ts:64-84`). Qualquer rota do painel podia lê-lo sem log |

**A matriz de acesso R-3 afirmava essa regra de lint desde que foi escrita.** Era um controle de papel, e este épico é quem o descobriu. **Atualização verificada em 2026-09-04:** a **R-3 já foi corrigida na fonte**, e a correção nomeia este spec. `matriz-de-acesso.md` R-3, bloco *"Correção de 2026-09-04"* (`:48`), diz por extenso: *"As duas metades eram falsas… Foi ele que reprovou a v1 do spec do painel de administração, que o citou como salvaguarda existente"*, e conclui *"controle afirmado em documento normativo precisa apontar para arquivo e linha, ou não é controle"*. A garantia real hoje é estrutural e está escrita ali (`:50`): `set_config($1,$2,true)` com parâmetro vinculado, e o `ContextoDoTenant` produzido só pelo pipeline de sessão.

> **Regra que passa a valer neste documento:** nenhuma salvaguarda é citada sem arquivo e linha. Onde a verificação foi feita, ela está anotada. Onde o controle não existe ainda, está marcado **a construir**.

---

## O que a v2 errou

A v2 corrigiu a citação e manteve o erro de fundo: **descreveu travas de banco de dados sobre uma topologia de conexão que não as suporta.**

| O que a v2 dizia | O que é verdade |
|---|---|
| §1.3: *"`SET LOCAL ROLE mavia_admin`, um papel novo com `SELECT` nas tabelas de negócio"*, e §8: *"agora garantido pelo papel `mavia_admin` e não por disciplina"* | Existe **um único `Pool`**, autenticado como `mavia_app` (`main.ts:29-33`), e ele é o único objeto que a aplicação recebe (`main.ts:50-57`). Todo papel proposto ficava a um `SET ROLE` de distância dele. Medido contra Postgres 17 real: `BEGIN; SET LOCAL ROLE leitor; RESET ROLE; UPDATE t SET v=99;` devolve `UPDATE 1` e commita. **Uma instrução desfaz a trava**, e o que sobrava era um papel com nome de fronteira |
| §1.1: a trava de tipo impede compor `ContextoDoTenant` à mão | Um *branded type* é apagado na compilação. `as unknown as ContextoDoTenant` compila e passa nas quatro regras do lint. A trava é real e é **de compilação** — a v2 a classificou como teste de "Integração", que é o nível onde ela não existe |
| §2: *"Proibido: qualquer policy … que conheça `administradores`"* | Correto e insuficiente. O caminho perigoso não é a policy nova: é o **dono** da `SECURITY DEFINER`. `mavia_auth` — a convenção do repositório para toda função `SECURITY DEFINER` — **já lê cinco tabelas cross-tenant com `USING (true)`**: `0004_cadastro.sql:52`, `:57`, `:60`, `:63` e `0025_assinatura.sql:163`. Uma função de listagem escrita seguindo a convenção nasce lendo a base inteira, sem violar nada escrito e sem gravar uma linha |
| §5: asserção de boot *"no mesmo espírito de `verificarCoberturaDaMatriz`"* | Esse mecanismo (`politica-acesso.ts:258-266`) verifica que toda rota **tem entrada na matriz**. Ele não verifica que o guard está **ligado** — e o guard **não é global**: não há `APP_GUARD` em `app.module.ts:71-85`, ele é aplicado controlador a controlador por `@UseGuards(AutorizacaoGuard)`, hoje em 17 dos 22 controladores registrados. Um `AdminController` com entrada na matriz e sem o decorador sobe limpo e fica aberto a qualquer sessão |
| §3.1 e §3.2 | O gatilho `BEFORE UPDATE OR DELETE … RAISE EXCEPTION` que *"dispara também para o dono"* e o papel `mavia_eliminacao` com `DELETE ON auditoria` se excluem mutuamente. Os dois estavam no mesmo documento, uma página depois do outro |
| §3.1 | A partição `DEFAULT` foi apresentada como rede de segurança. Ela é uma armadilha: uma linha de mês futuro dentro dela faz o `ATTACH` daquela partição **falhar**, e sair exige `DELETE` na `DEFAULT` — que o gatilho bloqueia |
| §8 | *"O admin lê e não edita dado financeiro do cliente"*, no rodapé de uma tabela que lista quatro ações classificadas como **escrita financeira**. `assinaturas` e `pagamentos_manuais` são dado financeiro |

O padrão dos dois erros é o mesmo: **a propriedade foi afirmada antes de a topologia que a sustenta existir.** A ADR 0024 é a topologia; esta v3 é o spec escrito em cima dela.

---

## Decisões do dono do produto

| # | Pergunta | Decisão | Consequência registrada |
|---|---|---|---|
| **DA-1** | O admin enxerga os dados financeiros dos clientes? | **Sim, leitura completa** | Um painel comprometido entrega a vida financeira de toda a base |
| **DA-2** | O cliente é avisado quando um admin abre o espaço dele? | **Não.** Mantida em 2026-09-04, já sabendo o que segue | **Não é omissão: é código que oculta.** A matriz §3.12, linha `GET /atividades` (`matriz-de-acesso.md:367`), dá ao `proprietario` *"todas as atividades do espaço"*, e as linhas do admin nascem com o `tenant_id` dele. Esconder exige um filtro deliberado, que é mais difícil de defender que a ausência de aviso |
| **DA-3** | Os bloqueantes do gate entram agora ou viram dívida? | **Agora, antes dos tickets** | É o que este documento executa |

**DA-2 continua reversível por configuração**, e a coluna `ator_tipo` (§3) é o que a torna reversível — não uma reescrita.

**DA-1 e DA-2 não se re-litigam neste documento.**

### DP-36 a DP-40 — padrão vigente, decisão pendente

Cinco perguntas que o parecer financeiro abriu e que **não são minhas**. Mesmo formato de DP-32, DP-33 e DP-34 (`decisoes-do-produto.md:136-138`, seção *"Em aberto — esperando o dono"*): cada uma tem **padrão vigente**, o time segue o padrão enquanto não houver resposta, e está escrito **o que muda se o dono responder diferente**. Nenhuma delas bloqueia o ticket — **exceto DP-39, que não tem padrão** e por isso bloqueia o deploy junto com F-15.

Elas entram em `docs/decisoes-do-produto.md` pela mão do coordenador, como DP-28 e DP-29 do épico 11 entraram: registradas aqui primeiro, movidas para o índice quando decididas.

| # | Pergunta | Padrão vigente | O que muda se o dono responder diferente | Onde |
|---|---|---|---|---|
| **DP-36** | Dar baixa num pagamento fora da Stripe restabelece o direito de uso? | **Sim, na mesma transação.** A baixa aplica `pagamento_recuperado` (`catalogo.ts:172`) e limpa `graca_ate`. Sem isso, o cliente **que pagou** expira no 15º dia | Se a resposta for "não, o operador restabelece à parte", passam a existir dois atos onde há um pagamento, e o segundo é esquecível. A tela teria de recusar a baixa de quem está `em_atraso` — o único caso em que ela importa | §8.2 · F-1 |
| **DP-37** | `competencia` de um pagamento manual é a do **dinheiro recebido** ou a do **período coberto**? | **Do recebimento.** Uma linha por pagamento, **sem rateio**. Um pagamento anual é uma competência, não doze | Se for a do período coberto, um pagamento anual vira doze linhas e `59000/12` e `79000/12` **não são exatos** — reintroduz no caminho do dinheiro a divisão que `spec-planos:308-310` se orgulha de não ter, e traz `ratear` e a regra 3 junto. Recomendo o padrão | §8.2 · F-5 |
| **DP-38** | Cortesia é dinheiro? | **Não, e por isso sai da tabela de pagamentos.** `cortesia` e `ajuste` deixam o enum `meio`; `pagamentos_manuais` passa a conter **só dinheiro que entrou**, e a cortesia vira tempo concedido (`cortesia_ate`), medida em dias e nunca em centavos | O parecer propôs a forma mais fraca — `cortesia` com `valor_centavos = 0` e o valor concedido em campo próprio. Ela resolve o total e **não** resolve a exportação: uma linha de R$ 0,00 continua saindo ao titular como um pagamento que ele não fez, que é a objeção do próprio parecer. Se o dono quiser o valor concedido como número, ele é derivado do plano e dos dias na tela, nunca uma coluna de dinheiro nesta tabela | §8.2, §8.4 · F-6 |
| **DP-39** | O painel escreve na **Stripe** e espera o webhook, ou escreve no **nosso banco** com marca de origem? | **Sem padrão.** É a única das cinco que não tem: a resposta depende de a chave de API da Stripe existir (P-14), que é do dono | Enquanto não houver resposta, **F-15 não fecha** e o painel não alcança cliente real. As duas saídas estão desenhadas em §8.6, e a marca `origem_da_ultima_escrita` entra agora nos dois casos — porque acrescentá-la depois exige adivinhar a origem das linhas já escritas | §8.6 · F-15 · **C-11** |
| **DP-40** | O painel troca o plano de um cliente? | **Não neste épico.** Nem plano, nem intervalo. `assinaturas` não tem preço contratado persistido, e o caminho de agendamento de downgrade **não existe** — verificado, `cobranca.controller.ts:127-131` devolve `fim_do_periodo` e não persiste nada | O parecer propôs *"o painel agenda para o fim do período, chamando o mesmo caminho de aplicação"*. Concordo com a regra e **discordo do prazo**: não há caminho a chamar. Se o dono quiser a troca no painel, o pré-requisito é do épico 11 — preço contratado em `assinaturas` (`spec-planos:448`, `:460`) e o agendamento de downgrade que o §8.1 daquele spec promete | §8.3 · F-8, F-9, F-10, F-11 |

---

### Mapa dos dezesseis achados

Onde cada um fecha, e o que sobrou aberto. **Nenhum achado é fechado por "o ticket cuida disso".**

| # | O achado, em uma linha | Fecha em | Como |
|---|---|---|---|
| **F-1** | Dar baixa não paga nada: `pagamentos_manuais` não se liga a `assinaturas` | §8.1 | A baixa aplica `pagamento_recuperado` e limpa `graca_ate`, na mesma transação · DP-36 |
| **F-2** | O `GRANT` autoriza escrever `estado`, que invariante aceita proíbe | §1.2, §8.1 | `estado` e `graca_ate` saem do `GRANT` de rota; a transição vive em função de `mavia_admin_contrato`, com `transicao()` do domínio |
| **F-3** | Baixa duplicada indetectável, inclusive pelo operador | §8.2 c | `UNIQUE (tenant_id, meio, referencia_externa)`, pré-checagem de semelhança, `SELECT` nominal a `mavia_admin`, e a lista na tela antes do botão |
| **F-4** | A exportação do titular não conseguiria ler a tabela | §8.2 d | `GRANT SELECT` nominal a `mavia_app`, sem `registrado_por` |
| **F-5** | `competencia` é data nua | §8.2 b | Coluna **gerada** de `recebido_em` em `America/Sao_Paulo`, `CHECK` do dia 1 · DP-37 |
| **F-6** | `cortesia` e `ajuste` não são dinheiro recebido | §8.2 e | Saem do enum; a tabela passa a conter só dinheiro que entrou; um tradutor único agrega · DP-38 |
| **F-7** | `moeda` sem amarra, tipo não declarado | §8.2 a | `BIGINT CHECK (> 0)`, `CHAR(3) CHECK (= 'BRL')` |
| **F-8** | Trocar plano à mão atravessa a regra que a rota do cliente cumpre | §8.3 | A ação **sai do épico** · DP-40 |
| **F-9** | O operador produz um preço errado na tela do cliente | §8.3 | Idem — e o pré-requisito (preço contratado em `assinaturas`) fica registrado como do épico 11 |
| **F-10** | A fórmula de reembolso lê o plano que o operador editou | §8.3, §9 | Idem; e a tela da baixa avisa que pagamento fora da Stripe não entra no cálculo automático |
| **F-11** | Rebaixar pelo painel não aciona a resolução de excesso | §8.3 | Idem — sem rebaixamento pelo painel, não há terceiro caminho |
| **F-12** | "Adicionar tempo" escreve num campo que o webhook sobrescreve | §8.4 | `periodo_fim` sai de todo `GRANT`; a cortesia vira `cortesia_ate`, somada na leitura |
| **F-13** | Prorrogar o teste por `UPDATE` solto é o que a invariante proíbe | §8.4 | Operação nomeada, com teto e razão; e `cadastrar_cliente` não força estado nenhum |
| **F-14** | `de → para` não tem quem os escreva | §8.5 | Segunda linha de `auditoria`, na mesma transação, ligada por `correlacao` |
| **F-15** | O job de reconciliação trata toda escrita do painel como incidente | §8.6 · **C-11** | Marca de origem entra agora; o fechamento **depende de DP-39** |
| **F-16** | `atualizado_em` fora do `GRANT` | Modelo de dados | Gatilho `BEFORE UPDATE`, imune a quem esqueça |

**O que ficou aberto, e está nomeado:** DP-39 (F-15) é decisão do dono e vira **C-11**; a emenda à ADR 0024 (§8.0) é pré-requisito do primeiro ticket da §8; e os dois pré-requisitos do épico 11 que DP-40 depende — preço contratado e agendamento de downgrade — estão registrados como dele, não como dívida deste épico.

---

## O que restringe o desenho

| Restrição | Onde — verificado | Consequência |
|---|---|---|
| Tenant vem só da sessão; exceção **exige ADR** | **R-3** (`matriz-de-acesso.md:40-55`) | Exceção nomeada na **ADR 0024, D1** — e a própria R-3 já a nomeia (`:53`), *"com **uma** exceção, nomeada e delimitada pelo ADR 0024… Uma segunda exceção exige ADR nova"* |
| Nenhum `id` de tenant em path de rota | `sistema.md:991` (veto 10) | **Já emendado no `sistema.md`.** O veto nomeia `/v1/admin/` como a exceção única, sob três condições simultâneas — ADR 0024, D1 |
| Nenhuma leitura sem contexto de tenant além das exceções de §3.9 | `sistema.md:644-650` (§3.9) e `:989` (veto 8) | **Já emendado no `sistema.md`.** Os dois lugares dizem **três** exceções, e a terceira é `admin.listar_clientes` (`:648`), com o critério de aceite em `:650`. *O parecer do gate afirma que `:644` "ainda diz as duas exceções" e que o veto 8 está em `:983`; verifiquei os dois — a emenda está aplicada, e o veto 8 é a linha `:989`* |
| Nenhum papel de requisição tem `BYPASSRLS` | `sistema.md:989`; `bootstrap-papeis.sql:27` (só `mavia_migrate` o tem) | Cross-tenant não se resolve com privilégio. Nenhum dos **quatro** papéis novos o tem |
| **Um `Pool` só, como `mavia_app`, com DML completo em toda tabela de negócio** | `main.ts:29-33`; `tenancy.ts:74`; `0006_nucleo.sql:278` | **É o achado que reprovou a v2.** Resolvido por dois pools — ADR 0024, D3 |
| **Não existe guard global.** A autorização é aplicada por decorador, controlador a controlador | `app.module.ts:71-85` registra só `APP_INTERCEPTOR`; dos **22 controladores** registrados (`app.module.ts:47-70`), **17** carregam `@UseGuards(AutorizacaoGuard)` | Rota nova sem decorador é rota aberta. §5 |
| `mavia_auth` já lê `usuarios`, `tenants`, `tenant_usuarios`, `sessoes` e `assinaturas` cross-tenant | `0004_cadastro.sql:52`, `:57`, `:60`, `:63`; `0025_assinatura.sql:163` | O dono da `SECURITY DEFINER` da listagem **não pode** ser `mavia_auth` — ADR 0024, D4 |
| `auditoria` especificada, nunca construída | `retencao-e-eliminacao.md` §3, §4, §8; não há `CREATE TABLE auditoria` em nenhuma migration | O log é ela, e ele é **a construir** |
| Não existe MFA | colunas em `0002_identidade.sql:19-22` e `:108`, nenhuma rota as usa | O admin fica a uma senha da base. §6 |
| Redis de produção: `requirepass` **corrigido no repositório, deploy pendente** | `infra/producao/docker-compose.yml:83-88` e `:111` | Até o deploy rodar, quem alcança a rede `dados` **é** o admin. O de desenvolvimento segue sem senha por decisão registrada (`infra/docker-compose.yml:43`) |

### O contrato comercial — o que o épico 11 já decidiu, e este épico atravessa

**Esta subseção é a correção estrutural da v3.2.** As restrições acima são todas de isolamento e de topologia, e por isso a v3 e a v3.1 leram `0025_assinatura.sql` como *"o arquivo onde mora a policy `assinatura_do_tenant`"*. Ele é isso, e é também **a máquina de dinheiro do produto**: a tabela que decide quem pode escrever, por quanto tempo, e quanto o cliente vê que paga. As quatro escritas da §8 caem exatamente em cima dela e da tabela de baixas.

`docs/produto/spec-planos-e-assinatura.md` é o documento que decide essas regras, e ele **não era citado uma vez** em 922 linhas. As invariantes abaixo não são negociadas aqui; são o contorno dentro do qual a §8 foi refeita.

| Invariante do épico 11 | Onde — verificado | O que ela proíbe ao painel |
|---|---|---|
| **`estado` só é escrito pelo processador de `EventoDeCobranca` ou pelo job de fim de teste. Nenhuma rota de produto o escreve** | `CONTEXT.md:408`; `spec-planos:458` | Um `GRANT … UPDATE (estado)` — que é o que a v3.1 dava. §8.1 |
| **`teste_termina_em` é fixado na criação e imutável. Prorrogar é operação nomeada e auditada, nunca um `UPDATE` solto** | `CONTEXT.md:407`; `spec-planos:456` | "Adicionar tempo" por `UPDATE (periodo_fim)` num tenant em `teste` — e na implementação o fim do teste **é** `periodo_fim` (`0025_assinatura.sql:78-79`). §8.4 |
| **Downgrade nunca corta no meio do período: *"o cliente comprou aquele período inteiro"*** | `spec-planos:291`, §6.2; a rota do cliente cumpre em `cobranca.controller.ts:127-131`, com a razão escrita em `:99-101` | Trocar plano por `UPDATE (plano)`, que passa por cima da regra que a rota do cliente respeita. §8.3 |
| **Downgrade abaixo da contagem atual de `pessoas` ou `espacos` é recusado no ato** — *"remover pessoa é decisão do titular, jamais efeito colateral de uma mudança de plano"* | `spec-planos:416`, §8.1 | Um terceiro caminho de rebaixamento, que não é o voluntário (§8.1 de lá) nem o involuntário (§8.2 de lá), e que não roda nem a recusa nem a resolução de excesso de `conexoes` (§8.3 de lá). §8.3 |
| **O preço contratado é o do par `(plano_codigo, intervalo, plano_versao)` e não muda dentro de um período já pago** | `spec-planos:448`, `:460`, §6.4 | Mudar `plano` ou `intervalo` enquanto **as colunas de preço contratado não existem** — `0025_assinatura.sql:18-50` não as tem, e `lerAssinatura` reconsulta o catálogo (`cobranca.controller.ts:349`). §8.3 |
| **`reembolso = max(0, valor_pago − meses_iniciados × preco_mensal_do_plano)`, e `meses_iniciados` conta de `periodo_inicio`** | `spec-planos:305`, `:314`, §6.3 | Editar `plano` (que é o `preco_mensal` da fórmula) e editar `periodo_inicio` (que é a âncora da contagem). §8.3 |
| **Nenhuma divisão no caminho do dinheiro** — é a propriedade de que a fórmula do reembolso se orgulha | `spec-planos:308-310` | Ratear um pagamento manual pelas competências que ele cobre. DP-37, §8.2 |
| **Preço, cota e desconto vivem no catálogo em código, nunca em tabela** | `spec-planos:177`, §3; `packages/domain/src/catalogo.ts:1-22` | Uma tela de administração que edite preço ou cota. Ela não existe e não entra por dívida |
| **O job diário de reconciliação compara `assinaturas` com a Stripe; divergência é incidente, a correção segue a Stripe, e quando reduz acesso avisa o proprietário antes de valer** | `spec-planos:579`, §10.5 | Escrever em `assinaturas` sem marca de origem. **Toda escrita legítima do painel é, por construção, uma divergência.** §8.6 · F-15 |
| **A Stripe é fonte de verdade do pagamento; a Mavia é fonte de verdade do direito de uso** | `spec-planos:529-531`, §10.1 | Que o painel invente um terceiro dono da mesma pergunta. É a raiz de DP-39 |

**E três fatos do código, verificados, que mudam o peso de tudo acima:**

1. **`periodo_fim` e `graca_ate` não expiram nada hoje.** As quatro transições de tempo — `prazo_de_teste_acabou`, `graca_acabou`, `periodo_terminou`, `reativou` — existem em `catalogo.ts:163-185` e em `catalogo.test.ts`, **e em nenhum outro lugar do repositório**. O único consumidor de `transicao()` em runtime é o webhook (`cobranca.controller.ts:228`), com quatro eventos mapeados (`:289-294`). Não há job de assinatura: a única fila é a de recorrências (`recorrencias/agendador.ts:42`).
2. **A tabela `cobrancas` não existe.** Nenhuma migration a cria; o que existe é `eventos_de_cobranca` (`0025_assinatura.sql:114-125`), que é o livro de idempotência do webhook. Logo **não existe `valor_pago` persistido em lugar nenhum** — o que faz da fórmula de reembolso do épico 11 uma fórmula sem primeiro operando.
3. **O job de reconciliação também não existe.** F-15 não é um incidente de hoje: é uma colisão marcada para o dia em que o épico 11 escrever o job. Por isso a marca de origem entra agora (§8.6) e o job nasce sabendo dela.

---

## Arquitetura

### 1 · O acesso entre espaços

Executa a **ADR 0024, D1 a D3, D5 e D6**. A ordem abaixo é deliberada: a topologia vem antes das travas, porque foi a topologia que faltou na v2.

#### 1.1 · Dois pools, e a razão medida (ADR 0024 · D3)

`SET LOCAL ROLE` restringe até o fim da transação; ele **não** é irreversível dentro dela. Contra Postgres 17 real, com a topologia que a v2 propunha:

```sql
BEGIN;  SET LOCAL ROLE leitor;  UPDATE t SET v = 99;              -- permission denied
BEGIN;  SET LOCAL ROLE leitor;  RESET ROLE;  UPDATE t SET v = 99; -- UPDATE 1, e commita
```

Qualquer injeção numa rota do painel, qualquer helper com concatenação, ou um `RESET ROLE` copiado de um exemplo devolve o DML completo sobre o razão do cliente cujo `app.tenant_id` acabou de ser assumido. **Um papel alcançado por `SET ROLE` é uma convenção com nome de papel, não uma fronteira de privilégio.**

**A decisão:** o painel abre `Pool`s próprios, autenticados *diretamente* como papel próprio, com credencial própria no ambiente. O de sempre (`main.ts:29-33`) continua como está, e `criarAplicacao` (`main.ts:50-57`) passa a receber os novos.

##### São **três** pools, e a v3.1 dizia dois — corrigido aqui

A v3.1 escrevia *"um segundo `Pool`"* e, na §1.4, *"`comTenantDeAdmin` e `comTenantDeAdminEscrita` usam o **pool do painel**"*, no singular. **As duas frases juntas não rodam**, e o motivo é uma das não-relações que a própria §1.2 declara: `mavia_admin` **não é membro de** `mavia_admin_escrita`. Num pool autenticado como `mavia_admin`, o `SET LOCAL ROLE mavia_admin_escrita` de `comTenantDeAdminEscrita` levanta `permission denied to set role` — e o caminho de escrita inteiro morre na primeira instrução.

É o mesmo formato do achado que reprovou a v2: **a propriedade foi afirmada antes de a topologia que a sustenta existir.** Aqui ela foi afirmada *depois*, e contra a topologia que o mesmo documento tinha acabado de escrever.

| Pool | Autentica como | Serve |
|---|---|---|
| `pool` | `mavia_app` | Todas as rotas de cliente (`main.ts:29-33`, hoje) |
| `poolDoPainel` | `mavia_admin` | `comAdmin` e `comTenantDeAdmin` — leitura |
| **`poolDoPainelEscrita`** | `mavia_admin_escrita` | `comTenantDeAdminEscrita` — as escritas da §8 |

**A separação por autenticação era a decisão desde a v3** — *"a conexão que lê não é a conexão que escreve, e a separação é por **autenticação**, não por instrução"* (§1.2). Três pools é o que essa frase custa, e o custo é o certo: com dois, ou a escrita não funciona, ou alguém "conserta" tornando `mavia_admin` membro de `mavia_admin_escrita` — que apaga a separação inteira e é a correção que um implementador apressado escolhe, porque é a que faz o erro sumir.

**`mavia_admin_definer` e `mavia_admin_contrato` não têm pool**, e não podem ter: são `NOLOGIN` (§1.2). Eles são alcançados **só** por serem donos de função `SECURITY DEFINER`.

Duas conexões a mais no Postgres. Irrelevante no volume atual, e explícito no dimensionamento.

#### 1.2 · Três papéis: `GRANT` e `POLICY` são camadas distintas, e as duas são necessárias (ADR 0024 · D3, D5)

**O que a v3 errava aqui (achado S3-3):** a tabela descrevia os papéis pelo que eles **não** podem fazer, e misturava `GRANT` com `POLICY` numa coluna só. São camadas independentes e ortogonais — `GRANT` decide se a instrução é sequer permitida, `POLICY` decide quais linhas ela enxerga —, e **negar uma delas é negar o acesso inteiro**. Como estava escrito, o SQL que o próprio documento exige não rodava: `admin.listar_clientes` falhava na primeira execução, e nenhum dos três papéis tinha `USAGE` de esquema.

##### O modo de falha que faz a migration mentir

Antes da tabela, porque ele contamina tudo o que vem depois. `bootstrap-papeis.sql:36-44` documenta, por extenso: **um `GRANT` executado por quem não é dono nem tem `grant option` não falha.** Ele devolve `GRANT` com um `WARNING: no privileges were granted`, a transação segue, a migration reporta sucesso — e o privilégio não existe. O bloco existe justamente porque isso já mordeu neste repositório.

Duas consequências normativas:

1. **Todo `GRANT` desta seção roda como `mavia_migrate`**, que é dono do esquema `public` (`bootstrap-papeis.sql:45`) e o único papel que roda migration.
2. **Nenhum privilégio desta seção é dado como concedido porque a migration passou.** O teste de esquema da seção Testes lê `information_schema.role_table_grants`, `information_schema.column_privileges` e `has_schema_privilege`, e é ele — não o `WARNING` — quem transforma a omissão em falha visível.

##### `USAGE` de esquema, que a v3 esqueceu em todos

`bootstrap-papeis.sql:51` faz `REVOKE ALL ON SCHEMA public FROM PUBLIC` **de propósito** — o comentário de `:47-50` diz que a máscara foi removida para que a falta de concessão apareça no teste em vez de aparecer no dia de endurecer a produção. E `0001_fundacao.sql:140` concede `USAGE ON SCHEMA public` **nominalmente**, a `mavia_app, mavia_jobs` e a mais ninguém.

Logo: **os papéis novos precisam de `USAGE` em `public` e em `admin`, explicitamente.** Sem isso, todo `SELECT` deles devolve `permission denied for schema public` — e, pelo modo de falha acima, um `GRANT` de tabela escrito sem o `USAGE` de esquema *ainda assim* deixa a migration verde.

```sql
GRANT USAGE ON SCHEMA public TO mavia_admin, mavia_admin_escrita,
                                mavia_admin_definer, mavia_admin_contrato;
GRANT USAGE ON SCHEMA admin  TO mavia_admin, mavia_admin_escrita,
                                mavia_admin_definer, mavia_admin_contrato;
```

##### São **quatro** papéis, e o quarto é a correção do achado F-2

**O que a v3.1 errava aqui (achado F-2).** A linha de `mavia_admin_escrita` dava `UPDATE (plano, intervalo, estado, periodo_fim, graca_ate) ON assinaturas`. `CONTEXT.md:408` diz o contrário, por extenso: *"`estado` só é escrito pelo processador de `EventoDeCobranca` ou pelo job de fim de teste. **Nenhuma rota de produto o escreve**"* — e `spec-planos:458` repete. Duas das cinco colunas (`estado`, `graca_ate`) não eram pedidas por ação nenhuma da §8; `periodo_fim` era pedida pela ação errada (§8.4); e as duas restantes vinham com os problemas de F-8 a F-11.

Pior que a largura: **um `GRANT` de coluna não sabe recusar uma transição.** `UPDATE assinaturas SET estado = 'ativa'` numa linha `expirada` é uma reativação sem pagamento, e o `GRANT` a autoriza tanto quanto autoriza a transição legítima `em_atraso → ativa` da baixa. Quem sabe recusar é `transicao()` (`catalogo.ts:187-192`), que é código de domínio e não roda no banco.

**A correção, e por que ela custa um papel novo.** A escrita do contrato passa a viver **dentro de funções**, e o privilégio de escrita tem de morar em quem é **dono** delas — senão a rota continua podendo emitir o `UPDATE` solto por fora. Esse dono não pode ser:

- `mavia_auth` — já lê cinco tabelas cross-tenant com `USING (true)`; é o motivo de a ADR 0024 D4 existir (§2);
- `mavia_migrate` — tem `BYPASSRLS` (`bootstrap-papeis.sql:27`), pelo mesmo argumento que rejeitou o gatilho `SECURITY DEFINER` da §3.2;
- **`mavia_admin_definer`** — dar-lhe `UPDATE ON assinaturas` transformaria o risco de **Erros e bordas · S3-4** de *"a próxima função nasce lendo a base inteira"* em *"a próxima função nasce podendo reescrever o contrato de toda a base"*. É o pior lugar disponível.

Sobra um papel próprio. **O precedente é deste mesmo documento:** `mavia_eliminacao` (§3.2) é um papel `NOLOGIN` que existe só para segurar um privilégio perigoso alcançável apenas de dentro de um procedimento. `mavia_admin_contrato` é a mesma forma, e mais estreita — ele não é alcançável nem por `SET ROLE`, porque ninguém é membro dele.

`GRANT` e `POLICY` em colunas separadas. Uma célula vazia em qualquer das duas colunas é acesso negado, não acesso irrestrito.

| Papel | Atributos | `GRANT` (a instrução é permitida) | `POLICY` (quais linhas ela vê) | Existe para |
|---|---|---|---|---|
| `mavia_admin` | `LOGIN NOINHERIT NOBYPASSRLS` | `USAGE` em `public` e `admin`; `SELECT` **nominal por coluna** (§1.3) nas tabelas do razão e do cadastro; **`SELECT (id, valor_centavos, moeda, competencia, recebido_em, meio, referencia_externa, observacao, registrado_em, deleted_at) ON pagamentos_manuais`** (§8.2 — a lista de baixas anteriores, sem `registrado_por`); `INSERT ON auditoria`; `EXECUTE` em `admin.abrir_espaco` e `admin.listar_clientes` | Nas tabelas do razão: a `tenant_isolation` de `0006_nucleo.sql:271-277` **não tem cláusula `TO`**, logo vale para todo papel — e é por isso que ela funciona para o painel: quem define `app.tenant_id` é `admin.abrir_espaco` (§1.6). Em `auditoria`: `FOR INSERT WITH CHECK (true)` (§3.3). **Sem policy de `SELECT` em `auditoria`** — a leitura do registro é por projeção própria (§3.3) | Ler o espaço do cliente |
| `mavia_admin_escrita` | `LOGIN NOINHERIT NOBYPASSRLS` | `USAGE` em `public` e `admin`; `INSERT ON auditoria`; `EXECUTE` em **`admin.abrir_espaco_para_escrita`** (§1.6) e nas funções de contrato da §8.0. **Nenhum `UPDATE` em `assinaturas`, nenhum `INSERT` em `pagamentos_manuais`, nenhum DML em tabela nenhuma.** **Nenhum `EXECUTE` em `admin.abrir_espaco`** — a função de leitura não é a de escrita | Só `auditoria`: `FOR INSERT WITH CHECK (true)`. **Ele não tem linhas que enxergar em `assinaturas`** — o que ele tem é o direito de chamar quem escreve | Chamar as escritas da §8, e nada além |
| `mavia_admin_definer` | `NOLOGIN NOBYPASSRLS` | `USAGE` em `public` e `admin`; `SELECT` nominal por coluna em `tenants`, `usuarios`, `tenant_usuarios` e `assinaturas` — a projeção fixa da listagem, e nada além; `SELECT ON concessoes_de_admin` (obrigação 4 da §2); `INSERT ON auditoria` (obrigação 5 da §2). **Nenhum `EXECUTE`, nenhum `UPDATE`, nenhum `DELETE`, nenhum `GRANT` sobre tabela do razão nem sobre tabela de contrato** | Policies próprias, `TO mavia_admin_definer`, nas quatro tabelas da projeção. Em `auditoria`: `FOR INSERT WITH CHECK (true)`. A forma dessas policies é o risco registrado em **Erros e bordas · S3-4**, e não é fechada aqui | Ser o dono das funções de **leitura** de `admin` (§2, §1.6) |
| **`mavia_admin_contrato`** — novo | `NOLOGIN NOBYPASSRLS` | `USAGE` em `public` e `admin`; **`SELECT, UPDATE (plano, intervalo, estado, graca_ate, cortesia_ate, origem_da_ultima_escrita, atualizado_em) ON assinaturas`**; **`SELECT, INSERT, UPDATE (deleted_at) ON pagamentos_manuais`**; **`INSERT ON tenants` e `INSERT, SELECT ON tenant_usuarios`** (só para `admin.cadastrar_cliente`, §8.4); `SELECT ON concessoes_de_admin`; `INSERT ON auditoria`. **Nenhum `SELECT` em tabela do razão, nenhum `EXECUTE`, nenhum `DELETE` em lugar nenhum** — e `periodo_fim` e `periodo_inicio` **não estão na lista** (§8.4, §8.3) | `assinaturas`: `assinatura_do_tenant` (`0025_assinatura.sql:136-138`), **sem `TO`**, por `app.tenant_id`. `pagamentos_manuais`: `tenant_isolation`, também sem `TO` (Modelo de dados). As duas dependem de o GUC existir — e é `abrir_espaco_para_escrita` quem o define. Em `auditoria`: `FOR INSERT WITH CHECK (true)` | Ser o dono das funções de **escrita de contrato** (§8.0). É o único papel do banco com `UPDATE` em `assinaturas` fora de `mavia_auth` (webhook, `0025:159`) e `mavia_app` (a rota do próprio cliente, `0025:140`) |

**Por que `mavia_admin_definer` precisa de tudo isso.** `admin.listar_clientes` é `SECURITY DEFINER` dele: ela roda **como ele**, não como quem chamou. Sem `SELECT` nas quatro tabelas da projeção, a listagem não existe; sem `SELECT ON concessoes_de_admin`, a obrigação 4 da §2 — *"a checagem de concessão é dentro da função"* — levanta `permission denied` (a §4 concede `SELECT` ali só a `mavia_app`); sem `INSERT ON auditoria`, a obrigação 5 — *"a auditoria da busca é gravada na mesma instrução"* — também. **Na v3, a função falhava na primeira execução, pelas três razões ao mesmo tempo.**

**E `mavia_admin_contrato` precisa da mesma lista pela mesma razão**, um esquema adiante: sem `SELECT ON assinaturas` ele não lê o estado atual para computar o `de` do `de → para` (F-14); sem `SELECT ON concessoes_de_admin` ele não confere a concessão por dentro, como toda função de `admin` faz; sem `INSERT ON auditoria` ele não grava a **segunda** linha, a do efeito. Três omissões que fariam as quatro escritas falharem na primeira execução — que é exatamente o formato do achado S3-3, e por isso o teste de integração correspondente é o mesmo: *rodar contra o esquema recém-migrado*.

**O `INSERT ON auditoria` é dos quatro.** A v3 dava esse `INSERT` a dois e esquecia o definer; a v3.1 corrigiu para três. Com o quarto papel são quatro, porque cada um tem um caminho que precisa registrar: abertura de leitura, abertura de escrita, busca, e **o efeito** de cada escrita de contrato.

**As não-relações importam tanto quanto os privilégios**, e cada uma fecha um caminho. Elas são normativas e cada uma vira asserção:

- `mavia_app` **não** é membro de nenhum dos quatro — senão o pool do cliente alcança o painel por `SET ROLE`;
- **nenhum dos quatro é membro de `mavia_app`** — senão `RESET ROLE` devolve o DML completo, que é exatamente o defeito da v2;
- `mavia_admin` **não** é membro de `mavia_admin_escrita` — a conexão que lê não é a conexão que escreve, e a separação é por **autenticação**, não por instrução;
- **ninguém é membro de `mavia_admin_contrato`**, e ele não é membro de ninguém. Ele é alcançável **só** por ser o dono de uma das funções da §8.0 — não por `SET ROLE`, não por herança, não pelo pool. Um `RESET ROLE` na conexão de escrita aterrissa em `mavia_admin_escrita`, que não tem DML em tabela nenhuma;
- nenhum dos quatro tem `BYPASSRLS`, mantendo o veto 8 de `sistema.md:989` sem exceção;
- nenhum dos quatro recebe `mavia_eliminacao` (§3.2).

Com isso, `RESET ROLE` na conexão do painel aterrissa em `mavia_admin`, que não tem escrita em tabela nenhuma. A propriedade *"o admin não edita o razão do cliente"* passa a ser consequência de **quem a conexão é**, e não de qual instrução a rota lembrou de executar.

**Aviso que o ticket carrega:** um papel novo **não herda** policies escritas `TO mavia_app` — inclusive a `RESTRICTIVE usuario_escreve_so_a_propria_linha` (`0002_identidade.sql:173-176`). Ele nasce sem nenhum grant de escrita, e não com escrita "controlada por policy".

#### 1.3 · `GRANT` por coluna, com os **nove** campos vetados fora (ADR 0024 · D5)

**O que a v3 errava (achado S3-6):** ela dizia "os sete campos da R-5" e listava um conjunto que **não é o da R-5** — trocou `ip_hash`/`user_agent_hash` por `dados_fiscais.documento`. Verifiquei a **R-5** (`matriz-de-acesso.md:66-72`) e o revisor está certo.

A R-5 enumera assim (`matriz-de-acesso.md:70`), contando `ip_hash / user_agent_hash` como um item de sete:

`senha_hash` · `refresh_hash` · `mfa_segredo_cifrado` · `credenciais_cifradas` · `dek_cifrada` · `ip_hash` / `user_agent_hash` · `lancamentos_brutos.payload`

E a §3.17 acrescenta `dados_fiscais.documento` à R-5 (`matriz-de-acesso.md:436`), *"junto de"* os oito anteriores, nomeando-os um a um. **Contados como colunas, são nove:**

```
CAMPOS_VETADOS = {
  usuarios.senha_hash          sessoes.refresh_hash        usuarios.mfa_segredo_cifrado
  conexoes.credenciais_cifradas  conexoes.dek_cifrada      lancamentos_brutos.payload
  dados_fiscais.documento      *.ip_hash                   *.user_agent_hash
}
```

**A consequência do erro era concreta, e não editorial.** A §3 põe `ip_hash` e `user_agent_hash` como colunas de `auditoria`, e a §8 cria `GET /v1/admin/registro`, servida por `mavia_admin`. O teste previsto — *"nenhum dos sete campos da R-5 está em nenhum `GRANT`"* —, escrito contra a lista errada, **passa** com `auditoria.ip_hash` concedido ao painel. O teste teria dado verde sobre exatamente o campo que a matriz veta.

##### A decisão sobre `ip_hash` e `user_agent_hash`, escrita como decisão

A **A-26**, na §3.12 (`matriz-de-acesso.md:172`), é categórica: eles *"nunca saem em resposta de `atividade`, para nenhum papel. Existem para investigação de incidente, não para exibição — A-26."*

**A escolha deste documento: os dois ficam FORA do `GRANT` do painel, e a R-5 não é emendada.**

O argumento do outro lado é bom e está registrado: o operador que abre um espaço com `motivo = incidente` é plausivelmente o leitor previsto da A-26 — *investigação de incidente* é literalmente a finalidade que a matriz declara para esses campos. Ele perde, por três razões:

1. **A R-5 fala de resposta de API, e `GET /v1/admin/registro` é resposta de API.** Emendá-la para o painel abriria a primeira exceção de uma regra que hoje não tem nenhuma, e a exceção nasceria na superfície com menos autenticação do produto (sem MFA — §6).
2. **A finalidade "investigação de incidente" é satisfeita sem o painel.** Quem investiga incidente tem `psql` no runner de deploy, com a credencial de `mavia_migrate` sob custódia (§3.1.2, item 1) e `pg_hba.conf` restringindo ao host. É um caminho mais caro, e ele **deve** ser mais caro: investigação de incidente é evento raro e deliberado, não uma coluna numa tela.
3. **Deixar os dois fora não custa nada à operação normal.** As perguntas do primeiro mês — quem leu, quando, sob qual hipótese, qual rota, quantos registros — são respondidas pelas outras colunas de `auditoria`.

**Portanto:** `GET /v1/admin/registro` serve `ocorrido_em`, `tenant_id`, `usuario_id`, `ator_tipo`, `entidade`, `entidade_id`, `acao`, `classe`, `rota`, `registros`, `motivo`, `referencia`, `correlacao`, `de`, `para` — e **não** `ip_hash` nem `user_agent_hash`. Se um dia a decisão inverter, ela entra como emenda escrita à R-5 na `matriz-de-acesso.md`, não como um `GRANT` a mais numa migration.

##### A lista vira constante única

`CAMPOS_VETADOS` é **uma** constante, num só lugar, e tem **dois** consumidores obrigatórios:

- o **teste de esquema** que afirma que nenhum dos nove aparece em `GRANT` de nenhum dos quatro papéis (§Testes);
- a **varredura sobre o OpenAPI gerado** que a R-5 já exige (`AB-07`, `matriz-de-acesso.md:72`).

Duas listas divergentes é exatamente o defeito que este achado descobriu. Uma constante com dois leitores é o que impede a próxima divergência: mudar a R-5 e esquecer o teste passa a quebrar o teste.

##### Por que `GRANT` por coluna, e não por tabela

`GRANT SELECT` no nível de tabela entregaria à conexão do painel `usuarios.senha_hash`, `usuarios.mfa_segredo_cifrado`, `sessoes.refresh_hash`, `conexoes.credenciais_cifradas`, `conexoes.dek_cifrada`, `lancamentos_brutos.payload` e `dados_fiscais.documento` de uma vez.

O envelope encryption do ADR 0018 torna as credenciais cifradas inúteis sem a KEK. `senha_hash` não: é material para quebra offline de toda a base de clientes, a um `SELECT` de distância numa conexão que não tem segundo fator. **A DA-1 autorizou leitura completa dos dados financeiros; não autorizou o hash de senha de todo mundo.**

Os `GRANT` são **nominais por coluna**, e a lista fechada mora na migration. A propriedade que isso compra e que `GRANT` de tabela não compra: **coluna nova não se estende sozinha** — uma migration futura que adicione um campo sensível não o entrega ao painel por omissão. O teste de esquema da seção Testes é quem transforma isso em falha visível.

#### 1.4 · O caminho de admin nunca produz um `Autenticado`, e nunca alcança `comTenant` (ADR 0024 · D2)

**Declaração normativa.** Esta é a decisão que carrega o peso, e ela é topológica em vez de disciplinar.

`AutorizacaoGuard` (`autorizacao.guard.ts:36-48`) exige `req.autenticado` com `{usuarioId, tenantId, papel}`. Se o painel sintetizasse esse objeto com o tenant do cliente, **todos os controladores de cliente passariam a servi-lo** — e todos chamam `comTenant(this.pool, ctx, …)`, que passa `'mavia_app'` fixo (`tenancy.ts:74`), com DML completo sobre `lancamentos`, `contas`, `faturas` e `transferencias` (`0006_nucleo.sql:278`), sem passar por `abrir_espaco` e sem gravar linha nenhuma.

Por isso, e sem exceção:

1. `autenticador.ts` **continua devolvendo `autenticado: null`** para rotas `/v1/admin/*` — é o caminho que a linha 93 já toma para rota sem espaço;
2. o contexto que `abrirEspacoComoAdmin` produz é de um **tipo distinto** (`ContextoDeAdmin`), aceito **só** por `comTenantDeAdmin`; e o que `abrirEspacoComoAdminParaEscrita` produz é um quarto tipo (`ContextoDeAdminEscrita`), aceito **só** por `comTenantDeAdminEscrita` — as duas funções de §1.6 têm cada uma o seu par, e os pares não se cruzam;
3. `comAdmin` e `comTenantDeAdmin` usam o **pool de leitura do painel**, `comTenantDeAdminEscrita` usa o **pool de escrita** (§1.1, os três pools), e nenhum deles usa `'mavia_app'`;
4. **nenhuma rota `/v1/admin/*` chama `comTenant`, `comUsuario` ou `resolverTenant`.**

##### O `SET LOCAL ROLE` redundante é normativo — não o remova (achado S3-10)

Hoje o cruzamento pool × papel **falha fechado por acidente feliz**, e o acidente precisa virar decisão escrita antes que alguém o desfaça com uma boa intenção.

`emTransacao` (`tenancy.ts:37-59`) emite **sempre** `SET LOCAL ROLE ${papel}` (`tenancy.ts:48`), antes de qualquer configuração. Como `mavia_app` não é membro de nenhum dos papéis do painel e nenhum deles é membro de `mavia_app` (§1.2, as não-relações), o `SET LOCAL ROLE` **estoura** quando a conexão vem do pool errado: um pool do painel tentando `SET LOCAL ROLE mavia_app` falha, o pool do cliente tentando `SET LOCAL ROLE mavia_admin` também, e — pela mesma não-relação — **o pool de leitura tentando `SET LOCAL ROLE mavia_admin_escrita` falha igual**. O cruzamento morre na primeira instrução da transação, e não na décima consulta.

Mas `comTenantDeAdmin` roda no pool de leitura do painel, que **já está autenticado** como `mavia_admin`. Um implementador razoável olha `SET LOCAL ROLE mavia_admin` numa conexão que já é `mavia_admin`, conclui que é ruído, e o remove. A partir daí o pool trocado **passa a funcionar em silêncio**, e a única defesa contra usar a conexão errada some sem deixar erro.

> **Normativo:** `comTenantDeAdmin` emite `SET LOCAL ROLE mavia_admin` — e `comAdmin`, `SET LOCAL ROLE mavia_admin`; e o caminho de escrita, `SET LOCAL ROLE mavia_admin_escrita` — **mesmo sendo redundante com a autenticação do pool**, precisamente para que o pool errado falhe na primeira instrução. A redundância **é** o controle. Remover a instrução é defeito, não simplificação, e o comentário na linha diz isso.

Três asserções de integração guardam a frase (§Testes): passar o pool do cliente a `comTenantDeAdmin` leva `permission denied to set role`; passar um pool do painel a `comTenant` leva o mesmo; e **passar o pool de leitura a `comTenantDeAdminEscrita` leva o mesmo** — nos três casos **antes** de qualquer `set_config` e antes de qualquer leitura.

##### O helper que faltava: `comAdmin` (achado S3-9)

A §1.4 proíbe `/v1/admin/*` de chamar `comTenant`, `comUsuario` e `resolverTenant` — e esses três são **os únicos caminhos de transação que existem hoje** (`tenancy.ts`). A v3 proibia os três e não nomeava o substituto, o que deixava sem resposta a pergunta mais imediata do implementador: *quem lê `concessoes_de_admin` para saber se este operador ainda é admin, e sob qual policy?*

**`comAdmin(poolDoPainel, { usuarioId }, trabalho)`** — sem alvo, sem espaço.

| | |
|---|---|
| **Pool** | o do painel (§1.1) |
| **Papel** | `SET LOCAL ROLE mavia_admin`, redundante e obrigatório (acima) |
| **GUCs** | define **só** `app.usuario_id` = o do operador, por `set_config($1,$2,true)`. **`app.tenant_id` é definido como `''` explicitamente**, pela mesma razão da §7: uma conexão de pool reaproveitada carrega o valor da requisição anterior |
| **Serve para** | resolver a concessão de admin da requisição (§6.4), a listagem (§2), e tudo o que é do painel e não é de um cliente |
| **Não serve para** | qualquer leitura dentro do espaço de um cliente — esse caminho é `comTenantDeAdmin`, e ele só nasce de `admin.abrir_espaco` |
| **Tipo** | recebe `ContextoDeOperador`, um terceiro *branded type*, produzido só pelo ramo de admin do guard (§5). Não é `ContextoDoTenant` nem `ContextoDeAdmin` |

**Quem lê `concessoes_de_admin`, e sob qual policy — as duas leituras são diferentes, e é isso que a v3 não separava:**

1. **O guard, a cada requisição** (§6.4), lê por `comAdmin` como `mavia_admin`, sob a policy `concessao_propria ON concessoes_de_admin FOR SELECT TO mavia_admin USING (usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid)`. **Estreita de propósito: o operador enxerga a própria concessão e nenhuma outra.** A rota do painel não precisa listar quem mais é admin, e uma policy ampla aqui daria ao painel a lista de todos os operadores da Mavia numa conexão sem MFA.
2. **A função `admin.listar_clientes`**, por dentro, como `mavia_admin_definer` (obrigação 4 da §2), sob policy própria `TO mavia_admin_definer`. É outra policy, para outro papel, e ela existe porque `SECURITY DEFINER` roda como o dono e não como o chamador.

`mavia_app` mantém o `SELECT` que a §4 já lhe dá, e mantém a policy que já tem. Nenhuma das duas policies acima é `TO mavia_app`, e nenhuma delas toca `tenants`, `usuarios` ou `tenant_usuarios` — a proibição da §2 continua intacta.

**Como as rotas de admin são classificadas sem cair em `ROTAS_SEM_TENANT`.** A ADR 0024 D6 proíbe colar `/admin/*` em `ROTAS_SEM_TENANT`, e com razão: aquela lista é o que dispensa a rota da matriz (`politica-acesso.ts:264`). Mas é ela também que define `exigeTenant` (`aplicacao.ts:86`), e é isso que faz o autenticador parar em `autenticado: null` antes de exigir `X-Mavia-Tenant` (`autenticador.ts:93`). As duas coisas estão amarradas hoje e passam a ser três listas nomeadas:

| Lista | Efeito | Rotas |
|---|---|---|
| `ROTAS_PUBLICAS` (`politica-acesso.ts:203-226`) | dispensa sessão | **nove entradas no total** — oito de credencial e sessão (`POST /v1/sessoes`, `/v1/sessoes/renovar`, `/v1/cadastro`, `/v1/cadastro/confirmar`, `/v1/senha/recuperar`, `/v1/senha/redefinir`, `/v1/auth/google`, `/v1/auth/google/retorno`) mais `POST /v1/cobranca/webhook`. *A v3 dizia "as nove de credencial e o webhook", o que somaria dez; verificado, são nove* |
| `ROTAS_SEM_TENANT` (`politica-acesso.ts:176-200`) | exige sessão, dispensa espaço e papel | as 13 rotas de `GET /v1/eu`, sessões, cadastro, senha, Google, convite e webhook |
| **`ROTAS_DE_ADMIN`** — nova | exige sessão, dispensa espaço, **exige concessão de admin ativa** | as rotas da §8, **uma a uma** |

##### `ROTAS_DE_ADMIN` é conjunto de chaves exatas, não prefixo (achado S3-8)

A v3 descrevia a lista nova como *"`/v1/admin/*`, e só elas"*, enquanto as duas irmãs são `ReadonlySet<string>` de chaves exatas no formato `` `${metodo} ${caminho}` `` (`politica-acesso.ts:176`, `:203`, com `chaveDaRota` em `:228-230`). Uma lista com semântica de prefixo entre duas de chave exata é a assimetria que o próximo leitor resolve errado — e resolve na direção permissiva, porque prefixo é mais fácil de escrever.

> **Normativo:** `ROTAS_DE_ADMIN: ReadonlySet<string>`, com as **chaves exatas** de cada rota da §8, enumeradas à mão. Uma rota nova sob `/v1/admin/` exige uma linha nova aqui, e é isso que se quer.

**O prefixo vive num lugar só: a asserção de boot.** Ele não é critério de pertencimento; é o mecanismo que confere a lista contra o roteador real, nas duas direções:

- toda rota registrada cujo caminho começa com `/v1/admin/` **está** em `ROTAS_DE_ADMIN` — pega a rota de admin que alguém esqueceu de declarar;
- nenhuma chave de `ROTAS_DE_ADMIN` aponta para caminho **fora** desse prefixo — pega a rota de cliente que alguém colou na lista para fazê-la passar.

`verificarCoberturaDaMatriz` (`politica-acesso.ts:258-266`, chamado em `aplicacao.ts:119` com as rotas que o `onRoute` de `aplicacao.ts:107-114` de fato registrou) passa a considerar as três listas e a rodar essa asserção. Uma rota de admin declarada como rota de cliente derruba o boot.

**Consequência aceita, e é a maior parte do orçamento do épico:** cada tela do cliente que o operador precisa ver tem **rota própria sob `/v1/admin/`**, com projeção própria, contagem própria e linha de auditoria própria. Não há reuso dos controladores do cliente. A alternativa — um `Autenticado` sintético — grava uma linha na abertura e **nenhuma** nas N leituras seguintes, o que torna falsa a propriedade central do painel.

O orçamento, escrito para não ser descoberto no meio: são **quatro telas de cliente** no primeiro corte — perfil, contas e saldos, lançamentos do período e **as baixas anteriores** (§8.2 c) —, e cada uma custa rota, projeção, contagem, teste e linha na matriz. *A v3.1 dizia três e avisava que uma quarta tela seria ticket e não ajuste; a quarta chegou pelo achado F-3, e ela é ticket — do mesmo ticket da baixa, porque dar baixa sem ver as baixas anteriores é o cenário F-3 com outra roupa.* Uma quinta continua sendo ticket próprio.

#### 1.5 · A trava de tipo é de **compilação**, e o teste dela também

`ContextoDoTenant` (`tenancy.ts:16-19`) passa a ser um *branded type* que **só** `resolverTenant` produz. São quatro tipos, e cada um tem exatamente um produtor e um consumidor:

| Tipo | Produzido só por | Aceito só por | Papel |
|---|---|---|---|
| `ContextoDoTenant` | `resolverTenant` | `comTenant` | `mavia_app` |
| `ContextoDeOperador` | o ramo de admin do guard (§5) | `comAdmin` | `mavia_admin` |
| `ContextoDeAdmin` | `abrirEspacoComoAdmin` | `comTenantDeAdmin` | `mavia_admin` |
| `ContextoDeAdminEscrita` | `abrirEspacoComoAdminParaEscrita` | `comTenantDeAdminEscrita` | `mavia_admin_escrita` |

`comTenant` deixa de aceitar `{ tenantId: string }` montado à mão.

**O limite, escrito:** um *branded type* é apagado na compilação, e `as unknown as ContextoDoTenant` compila e passa nas quatro regras de `eslint.config.js`. Isto **não é** um controle de runtime, e não é o que impede o vazamento — quem impede é a topologia de §1.1 a §1.4. O que a trava compra é que o caminho errado precise de uma linha que ninguém escreve por acidente.

Por isso o teste dela é **de compilação** (`@ts-expect-error` num arquivo dentro do `include` do `tsconfig`, verificado por `pnpm typecheck`, que é `tsc --noEmit`), e não de integração. Um teste de integração não observa uma propriedade que não existe em runtime — foi assim que a v2 classificou errado.

*A construir.* Verificado que hoje não há trava alguma: `tenancy.ts:64-84`.

#### 1.6 · Uma instrução liga o log ao alvo — e são **duas** funções, não uma

`SET LOCAL` não aceita parâmetro, então a v1 implicava interpolar um parâmetro de rota em SQL — e `node-pg` aceita múltiplas instruções numa consulta simples. A linha de auditoria podia dizer cliente A enquanto o `app.tenant_id` virava cliente B.

```sql
admin.abrir_espaco            (p_alvo uuid, p_motivo motivo_de_acesso,
                               p_referencia text, p_acao text, p_rota text)

admin.abrir_espaco_para_escrita (p_alvo uuid, p_motivo motivo_de_acesso,
                               p_referencia text, p_acao text, p_rota text)
```

Cada uma faz o `INSERT INTO auditoria` **e** o `set_config('app.tenant_id', p_alvo, true)` com o **mesmo parâmetro vinculado, na mesma instrução**. Divergência entre o que foi auditado e o que foi efetivado deixa de ser expressável.

##### Por que a segunda função existe (achado S3-2)

A v3 construiu a propriedade central — *não se toca o espaço de um cliente sem registrar* — **só para leitura**, e classificava na §8 quatro ações como **escrita financeira** sem que nenhuma passasse por `abrir_espaco`. O `EXECUTE` em `admin.abrir_espaco` estava apenas na linha de `mavia_admin`, e as quatro escritas rodam em `mavia_admin_escrita`.

O problema não era estético. As duas tabelas de escrita têm RLS por `app.tenant_id` **sem cláusula `TO`**, e portanto valem para o papel novo:

- `assinaturas` — `assinatura_do_tenant`, `0025_assinatura.sql:136-138`;
- `pagamentos_manuais` — `tenant_isolation`, escrita neste documento (Modelo de dados), no padrão de `0006_nucleo.sql:271-277`.

Sem o GUC, `nullif(current_setting('app.tenant_id', true), '')` é `NULL`, o `UPDATE` afeta **zero linhas** e o `INSERT` viola o `WITH CHECK`. O implementador tinha três saídas, e as três eram ruins:

| Saída | Por que não |
|---|---|
| `set_config` direto na rota | É **o defeito que a ADR 0024 D1, condição 2 nomeia por escrito**, e o veto 10 de `sistema.md:991` repete: *"`params` alimentando `set_config('app.tenant_id', …)` é defeito"* |
| Conceder `EXECUTE` em `abrir_espaco` a `mavia_admin_escrita`, de improviso na migration | Funciona e apaga a separação: a função de leitura passaria a habilitar escrita, e a classe no log seria a de leitura |
| **Escrever a segunda função** | É a resposta certa, e faltava no documento |

**A divergência que a v3 reintroduzia pelo outro lado.** Sem uma função que faça `INSERT INTO auditoria` e `set_config` com o **mesmo parâmetro vinculado**, nada amarra o que foi auditado ao que foi efetivado na escrita. É literalmente a divergência "auditou A, efetivou B" que esta seção declarou não-expressável — fechada na leitura e aberta na escrita.

**`admin.abrir_espaco_para_escrita`:**

- `EXECUTE` **só** a `mavia_admin_escrita`. `mavia_admin` não a alcança, e `mavia_admin_escrita` não alcança `admin.abrir_espaco` (§1.2);
- grava a linha com a **classe de escrita financeira**, não a de leitura em massa, e com `p_acao`/`p_rota` identificando qual das quatro escritas da §8 vem a seguir;
- é `SECURITY DEFINER` de `mavia_admin_definer`, com `SET search_path = pg_catalog, public`, como toda função de `admin` (§2, obrigação 2);
- verifica a concessão ativa por dentro, como `admin.listar_clientes` (§2, obrigação 4). Chamá-la sem concessão devolve **erro**, não zero linhas.

##### A ordem é normativa: `set_config` primeiro, `INSERT` depois (achado S3-7)

A v3 fixava *"mesma instrução, mesmo parâmetro vinculado"* e **não fixava a ordem** — e é a ordem que decide se o `INSERT INTO auditoria` é aceito. Sob a policy de `auditoria` (§3.3), se o `INSERT` for avaliado **antes** do `set_config`, a linha não tem `app.tenant_id` no contexto e uma policy de escrita por tenant a recusaria.

> **Normativo, nas duas funções:** `set_config('app.tenant_id', p_alvo, true)` **precede** o `INSERT INTO auditoria`, dentro do mesmo corpo e com o mesmo parâmetro vinculado. A instrução é uma só do ponto de vista do chamador — ele chama a função e recebe o resultado ou o erro —, e a ordem interna é esta, sem alternativa.

A ordem é o inverso da §3.2 (*"grava primeiro, apaga depois"*), e as duas estão certas: lá o registro precisa preceder o efeito irreversível; aqui o contexto precisa preceder o registro, porque é o contexto que torna o registro possível. **A §3.3 fecha essa dependência pelo outro lado** — a policy de `INSERT` em `auditoria` é `WITH CHECK (true)` —, e as duas travas coexistem de propósito: a ordem não depende da policy, e a policy não depende da ordem.

##### A proibição, por extenso, sobre as duas

Fora de **`admin.abrir_espaco`** e de **`admin.abrir_espaco_para_escrita`**, `params` — ou qualquer valor vindo do caminho, do corpo, da query ou de um cabeçalho — alimentando `set_config('app.tenant_id', …)` é **defeito** (ADR 0024, D1, condição 2; `sistema.md:991`, veto 10). Vale para os três pools, para código de rota, de serviço e de repositório, e não tem exceção sob revisão. As duas funções são o conjunto fechado de lugares onde um alvo de rota vira contexto de banco.

**As funções de contrato da §8.0 não abrem espaço — elas exigem que ele esteja aberto.** Nenhuma das quatro chama `set_config('app.tenant_id', …)`: cada uma **lê** o GUC e recusa se ele estiver vazio, o que mantém `abrir_espaco_para_escrita` como o único ponto onde um alvo de rota vira contexto. Elas recebem `p_alvo` mesmo assim, e **conferem que ele é igual ao GUC** — sem isso, o operador poderia abrir o espaço de um cliente e escrever no de outro dentro da mesma transação, que é a divergência "auditou A, efetivou B" reaparecendo um andar acima. A conferência é uma linha de `plpgsql` e fecha o caminho inteiro.

#### 1.7 · `app.usuario_id` é sempre o do operador

Personificar o titular é **proibido**, e a proibição é normativa porque a correção "óbvia" vai na direção errada: as telas do cliente chaveadas por `usuario_id` (alertas, preferências, sessões — R-2) virão vazias no painel, e assumir o `usuario_id` do titular faria a policy restritiva de `0002_identidade.sql:173-176` passar a autorizar `UPDATE usuarios SET senha_hash` **na linha do cliente**.

**Consequência aceita:** as telas `⊙` do cliente não são visíveis no painel. Está escrito aqui para não ser "descoberta" e revertida por conveniência.

#### 1.8 · O que a atomicidade compra, exatamente

Para **escrita**, "sem log não há efeito" é real: uma conexão, um `BEGIN`, um `COMMIT`. Para **leitura**, "a leitura desfaz" é retórica — as linhas já estão no processo quando o `COMMIT` roda. A janela residual é a falha de `COMMIT`, e fecha assim: **a resposta é montada estritamente depois de o `COMMIT` retornar**, e qualquer erro descarta o resultado.

E a afirmação é escopada: **nenhum caminho HTTP** lê entre tenants sem registrar. `mavia_jobs` lê entre tenants por desenho (`sistema.md:639-644`), e o agendador de recorrências já roda assim.

### 2 · A listagem, e o dono da `SECURITY DEFINER`

Executa a **ADR 0024, D4**. A listagem de clientes é a terceira exceção de leitura sem contexto de tenant, e o **dono** da função é a decisão mais sensível do épico.

A v2 proibia *"policy que conheça administradores"*. Isso continua valendo e continua insuficiente:

> **Proibido:** qualquer policy em `tenants`, `usuarios` ou `tenant_usuarios` que conheça `concessoes_de_admin`.
>
> **Por quê:** `resolverTenant` (`tenancy.ts:126-139`) consulta `tenant_usuarios` **sem predicado de `usuario_id`**, confiando inteiramente na policy. Uma policy que reconheça admin faria o operador mandar `X-Mavia-Tenant: <cliente>` no **app normal**, receber `papel`, e navegar o espaço pela interface do cliente — sem uma linha de auditoria.

**O caminho que a v2 não viu.** A convenção do repositório é que toda `SECURITY DEFINER` pertence a `mavia_auth` — **nove** `ALTER FUNCTION … OWNER TO mavia_auth` em bloco (`0004_cadastro.sql:317-325`; a v3 dizia oito em `:317-324`, e contei as nove), mais `0025_assinatura.sql:156`. E `mavia_auth` já lê cross-tenant, com `USING (true)`, exatamente a projeção que a listagem precisa:

```
usuarios         cadastro_le_usuarios          0004_cadastro.sql:52
tenants          cadastro_le_tenants           0004_cadastro.sql:57
tenant_usuarios  cadastro_le_vinculos          0004_cadastro.sql:60
sessoes          cadastro_le_sessoes           0004_cadastro.sql:63
assinaturas      assinatura_lida_pelo_webhook  0025_assinatura.sql:163
```

Uma função escrita por alguém seguindo a convenção nasce dona de `mavia_auth`, lê a base inteira, não viola uma vírgula de nenhuma proibição escrita, e não grava uma linha. **Aqui, a convenção é o exploit.**

`mavia_migrate` também está fora: ele tem `BYPASSRLS` (`bootstrap-papeis.sql:27`), e a função viraria leitura irrestrita de tudo, contra o veto 8 de `sistema.md:989`.

**A v2 corrigida — cinco obrigações, todas verificáveis:**

1. **Dono próprio.** `admin.listar_clientes(p_busca text, p_pagina int)` pertence a `mavia_admin_definer`, `NOLOGIN NOBYPASSRLS`, cujas **únicas** policies são as estritamente necessárias à projeção fixa: espaço, titular, plano, estado, vence em, uso. Nenhum dado financeiro do razão.

   **E ele precisa dos `GRANT` que a §1.2 agora lista.** Sendo `SECURITY DEFINER` dele, a função roda **como ele**: sem `USAGE` nos esquemas, sem `SELECT` nominal em `tenants`, `usuarios`, `tenant_usuarios` e `assinaturas`, sem `SELECT ON concessoes_de_admin` (obrigação 4) e sem `INSERT ON auditoria` (obrigação 5), ela falha na primeira execução. Policy sem `GRANT` não lê nada — este é o achado S3-3, e o fechamento dele está na §1.2.
2. **`SET search_path = pg_catalog, public`** na função — como as `SECURITY DEFINER` existentes já têm, pelo motivo escrito em `0004_cadastro.sql:92-94`: quem controla o `search_path` da sessão redireciona uma chamada de dentro da função para um objeto que ele mesmo criou.
3. **Busca por parâmetro vinculado**, nunca `format` ou `||` sobre o termo.
4. **A checagem de concessão é dentro da função.** Ela verifica que `nullif(current_setting('app.usuario_id', true), '')::uuid` tem concessão ativa em `concessoes_de_admin`. `EXECUTE` concedido só a `mavia_admin` **não** é controle suficiente enquanto papel for alcançável; a checagem interna é. **Critério de aceite: chamá-la sem concessão ativa devolve erro, não linhas.**
5. **A auditoria da busca é gravada na mesma instrução**, pela mesma razão que `admin.abrir_espaco` faz isso. **A busca é evento**: uma linha por busca, com o termo hasheado e a contagem de resultados — não uma linha por cliente listado, que era o argumento de ruído da v1.

O `nullif` não é estilo. `current_setting(…, true)` devolve **string vazia** numa conexão de pool reaproveitada, e `''::uuid` **lança erro** em vez de esconder linha — documentado com contraexemplo medido em `0001_fundacao.sql:107-114` e `sistema.md:591-599`. **Toda leitura de GUC neste documento é `nullif(current_setting('app.usuario_id', true), '')::uuid`, por extenso, sem abreviação.**

**Segunda camada, que a regra 16 exige.** `resolverTenant` ganha `AND usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid`. É o que `sistema.md:648` promete — *"todo repositório também filtra por `tenant_id` no `WHERE`"* — e que essa consulta não cumpre hoje (`tenancy.ts:133`).

### 3 · O log

A `auditoria` do `retencao-e-eliminacao.md`, com o que os dois gates acrescentaram. Ela **não existe como tabela** em nenhuma migration — o nome aparece em `0013`, `0022` e `0026`, e não há `CREATE TABLE auditoria`. Todo controle deste documento que se apoia no log é **a construir**, e é condição, não pressuposto.

```
auditoria (particionada por mês em ocorrido_em)
  id, ocorrido_em, tenant_id, usuario_id, ator_tipo,
  entidade, entidade_id, acao, classe, rota, registros,
  motivo, referencia, correlacao, de, para, ip_hash, user_agent_hash
```

| Coluna nova | Por quê |
|---|---|
| `motivo` + `referencia` | O log respondia "quem leu", não "sob qual hipótese legítima". É o controle mais barato do épico e o único que muda o comportamento no momento do ato. Lista fechada: `chamado \| incidente \| defeito \| ordem_judicial`, com a referência obrigatória (`retencao-e-eliminacao.md:500-509`) |
| `rota` + `registros` | "Abriu o espaço" não responde ao art. 48, que pede a natureza dos dados afetados. A matriz §6 já exige contagem de registros do ator programático |
| `correlacao` | **Nova na v3.2 (F-14).** Liga a linha de **intenção** à linha de **efeito** de uma mesma escrita financeira (§8.5). Sem ela, o par existe e ninguém consegue afirmar que existe: `auditoria` não aceita `UPDATE` de ninguém (§3.1), então uma linha nunca é completada depois — o `de → para` **precisa** de uma segunda linha, e a segunda precisa dizer de qual primeira ela é |
| `ator_tipo` | Separa titular, membro e operador. É o que permite a projeção de `/atividades`, o que torna a **DA-2 reversível por configuração**, e o que o predicado normativo de `retencao-e-eliminacao.md:576` usa |

**`tenant_id` é nulo** para eventos que não pertencem a espaço nenhum — conceder e revogar admin. A v3 dizia aqui que *"a policy padrão os torna invisíveis a todos"* e **nunca escrevia a policy**: afirmava o comportamento de um objeto que o documento não especificava. A RLS de `auditoria` está agora na **§3.3**, e a linha de `tenant_id` nulo só é gravável por causa dela.

**De/para em claro para enum, id e dinheiro.** A v1 mandava hashear tudo, citando o §8.2 ao contrário: ele diz *"em claro apenas quando o valor é o objeto da mudança"*, e dar baixa em pagamento é exatamente esse caso. Hash e redação ficam para texto livre e PII. **Já feito:** o §8.2 recebeu os campos de `assinaturas` na linha "estruturais — em claro" (`retencao-e-eliminacao.md:563`).

#### 3.1 · A imutabilidade, com os furos fechados e os limites ditos

`REVOKE UPDATE, DELETE, TRUNCATE ON auditoria FROM mavia_app` não basta, e o spec precisa dizer contra quem cada coisa vale.

| Furo | Fechamento | Contra quem vale |
|---|---|---|
| **O dono ignora `REVOKE`.** As tabelas pertencem a `mavia_migrate`, que tem `BYPASSRLS` (`bootstrap-papeis.sql:27`) e é dono do esquema (`bootstrap-papeis.sql:45`) | Gatilho `BEFORE UPDATE OR DELETE … RAISE EXCEPTION`, que dispara **também para o dono** | Todo **DML**, inclusive o do dono |
| **`TRUNCATE` é privilégio separado** e não está no `REVOKE` | Entra no `REVOKE`, e o gatilho `BEFORE TRUNCATE` o cobre | Idem |
| **Partição nova não é governada pelo `REVOKE` do pai**, e quem a cria vira dono dela | Job mensal idempotente (§3.1.1), que aplica grants e gatilho a cada partição criada | Idem |
| **DDL não dispara gatilho nenhum** | §3.1.2 | Ninguém, dentro do banco |

> **A imutabilidade vale contra `mavia_app`, contra os quatro papéis do painel e contra o dono, para DML.** Ela **não** vale contra DDL, e **não** vale contra quem tem acesso ao servidor. Imutabilidade real exige o log sair da máquina, e isso não está neste épico.

##### 3.1.1 · Partições: job mensal, e a `DEFAULT` como incidente

A v2 propunha partição `DEFAULT` com alarme. **É uma armadilha, e a troca é obrigatória.**

Assim que a `DEFAULT` recebe uma linha de um mês futuro, o `ATTACH PARTITION` daquele mês **falha** — o Postgres varre a `DEFAULT` e recusa anexar uma partição que capturaria linhas já lá. Sair exige `DELETE` na `DEFAULT`, que é exatamente o que o gatilho de §3.1 bloqueia. A rede de segurança tranca a porta por dentro.

**No lugar dela:**

- **Job mensal idempotente** que garante **24 meses** de pista à frente, criando o que faltar, aplicando `REVOKE`, os `GRANT` nominais e o gatilho a cada partição criada. Idempotente: rodar duas vezes no mesmo mês não faz nada e não falha.
- **Alarme quando restarem menos de 3 meses** de pista. Três meses é o tempo de alguém acordar, não o tempo de o log parar.
- A partição `DEFAULT` **existe**, e existe para não perder linha — mas ela é **página de incidente**, não rede de segurança. Uma linha nela é incidente aberto, com dono e runbook, nunca warning.
- **O procedimento de saída não precisa de `DELETE`**, e é por isso que ele não amplia a isenção de §3.2: parar a escrita no painel · gravar em `retencao_execucoes` a janela · `ALTER TABLE auditoria DETACH PARTITION auditoria_default` · criar as partições faltantes · `INSERT … SELECT` da tabela destacada de volta para o pai, que agora roteia cada linha para o mês certo · `ATTACH` de uma `DEFAULT` nova e vazia · `DROP TABLE` da destacada. É DDL mais `INSERT` — nenhuma instrução que o gatilho de §3.1 bloqueia. O `DROP TABLE` final é DDL e portanto **fica registrado pelo `EVENT TRIGGER` de §3.1.2**, que é onde ele deve aparecer.

**A propriedade que protege o log é a mesma que o torna ponto único de falha** — pela regra "falha de auditoria desfaz a transação", um mês sem partição derruba o painel. Trocar a `DEFAULT` pelo job move o risco de "trava impossível de destravar" para "alarme com 3 meses de antecedência", e isso fica escrito.

##### 3.1.2 · O gatilho fecha DML, não DDL

`ALTER TABLE auditoria DETACH PARTITION auditoria_2026_09; DROP TABLE auditoria_2026_09;` apaga um mês inteiro e **não dispara gatilho nenhum**. Gatilho de linha e de instrução é DML; `DROP` é DDL. A v2 escrevia *"dispara também para o dono"* como se fechasse tudo. Ela fecha o DML do dono, e essa é a frase verdadeira.

O controle real é outro, e tem três partes — nenhuma delas dentro do gatilho:

1. **Custódia da credencial de `mavia_migrate`.** Ela é o único papel com `BYPASSRLS` (`bootstrap-papeis.sql:27`) e dono do esquema (`:45`); `pg_hba.conf` a restringe ao host do runner de deploy e ela está **ausente do ambiente dos processos `http` e `worker`** (`sistema.md:640`; `bootstrap-papeis.sql:3-6`). Quem apaga um mês precisa de acesso ao runner, não de um bug numa rota.
2. **`EVENT TRIGGER` de `sql_drop`** que registra toda remoção de objeto sob `auditoria*` — em `retencao_execucoes`, que é append-only para todos os papéis (`retencao-e-eliminacao.md:263`). Ele **não impede**: ele deixa rastro. E carrega uma ressalva honesta: `CREATE EVENT TRIGGER` exige superusuário, e quem tem superusuário também remove o event trigger. Ele eleva o custo, não fecha a porta.
3. **O log sair da máquina.** É o único controle que vale contra quem tem o servidor, e ele **não está neste épico** — está dito aqui e no fim do documento, nos dois lugares.

#### 3.2 · O caminho de eliminação, e a reconciliação com a imutabilidade

`DELETE /tenants/:id` promete apagar **todas** as tabelas com aquele `tenant_id`, e `auditoria` não está entre os sobreviventes da §5.3 (`retencao-e-eliminacao.md:345-356`). Mas nenhum papel consegue: `mavia_app` não tem `DELETE`, e `mavia_retencao` só tem `UPDATE` de três colunas (`retencao-e-eliminacao.md:254`) — `DROP PARTITION` derruba o mês de **todos** os tenants e nunca serve para um pedido individual.

Então **R-08 é insatisfazível a partir da primeira linha de auditoria escrita**, que é a primeira ação do painel. E migration é forward-only: os grants nascem aqui.

> ### ⚠️ `retencao_execucoes` e `eliminacoes_journal` **não existem** — achado O-2 do gate de LGPD
>
> Esta seção inteira apoia a isenção de imutabilidade em duas tabelas que o repositório não tem. Verifiquei: `grep` por `retencao_execucoes` e `eliminacoes_journal` em `apps/` e `packages/`, em `*.sql` e `*.ts`, devolve **zero ocorrências**. Elas são especificadas em `retencao-e-eliminacao.md` §4.3 e nunca foram construídas — exatamente como `auditoria`.
>
> O spec marca `auditoria` como *a construir* em dois lugares e **esqueceu de fazer o mesmo com estas duas**, citando-as como propriedade de objetos existentes. É a mesma classe de erro que reprovou a v1: afirmar um controle sem abrir o arquivo.
>
> **Consequência prática, e é por isso que o achado bloqueia o ticket:** o gatilho `auditoria_imutavel()` faz `SELECT 1 FROM retencao_execucoes`. A **primeira migration do épico não roda** — ela cria um gatilho que referencia uma tabela ausente, e o `DELETE` que a isenção existe para permitir morre no próprio gatilho que o autoriza.
>
> **O que o ticket precisa fazer, e não é negociável:** criar `retencao_execucoes` (append-only para todos os papéis, sem dado pessoal, conforme `retencao-e-eliminacao.md` §4.3) na mesma migration que cria `auditoria` e o gatilho — **antes** dele. Se o caminho da R-08 sai daqui, `eliminacoes_journal` idem. O papel `mavia_retencao`, citado pela política de retenção, **também não existe**: as únicas `CREATE ROLE` do repositório são `mavia_app`, `mavia_jobs`, `mavia_auth` e `mavia_migrate`.
>
> A correção barata sob pressão — remover a condição do `EXISTS` para a migration subir — é precisamente o escape hatch que a §3.2 foi escrita para fechar. Se a tabela não existir, **falhe a migration**, não a condição.

**Sexta trava da §4.3:** papel `mavia_eliminacao`, `NOLOGIN`, com `DELETE ON auditoria` **exclusivamente** por procedimento `SECURITY DEFINER` que aceita apenas `tenant_id` presente em `eliminacoes_journal` com eliminação concluída, e que grava em `retencao_execucoes`. Sem `BYPASSRLS`, sem `SELECT` em tabela de negócio, e o texto da regra 18 intacto para `mavia_app`.

**Os `GRANT` de `mavia_eliminacao`, corrigidos (achado S3-3, consequência c).** A v3 lhe concedia `DELETE ON auditoria` e escrita em `retencao_execucoes`, e mais nada — e com isso **o caminho de eliminação da R-08 nunca rodava**. O gatilho `auditoria_imutavel()` abaixo é `plpgsql` **sem `SECURITY DEFINER`**, logo roda como o invocador, e o `EXISTS` dele faz `SELECT 1 FROM retencao_execucoes`. Sem `SELECT` nessa tabela, o `EXISTS` levanta `permission denied` — e o `DELETE` que a isenção existe para permitir morre no próprio gatilho que o autoriza.

Duas saídas, e **a escolha é a primeira:**

```sql
GRANT SELECT ON retencao_execucoes TO mavia_eliminacao;
```

A alternativa era marcar `auditoria_imutavel()` como `SECURITY DEFINER` de `mavia_migrate`, com `SET search_path`. **Rejeitada, e o motivo é o mesmo da §2:** `mavia_migrate` tem `BYPASSRLS` (`bootstrap-papeis.sql:27`), e um gatilho `SECURITY DEFINER` dele passaria a avaliar o `EXISTS` sem RLS nenhuma, em toda linha de `auditoria` que qualquer papel tocar — inclusive as de `mavia_app`. Trocar um `GRANT SELECT` de uma tabela sem dado pessoal (`retencao-e-eliminacao.md:263`: *"não contém dado pessoal — só classe, contagem, horário e versão da política"*) por um caminho `BYPASSRLS` no gatilho mais quente do log é péssimo negócio. O `GRANT` nominal é a resposta menor e é a certa.

O `GRANT` não afrouxa nada: `retencao_execucoes` é append-only para todos os papéis, `SELECT` nela não revela dado de cliente, e `mavia_eliminacao` continua sem `SELECT` em tabela de negócio.

**A reconciliação — porque o gatilho de §3.1 e este `DELETE` se excluem mutuamente.** A v2 pôs os dois no mesmo documento sem notar. A isenção existe, e é escrita aqui na forma mais estreita que o Postgres permite. Três condições **simultâneas**, dentro do próprio gatilho:

```sql
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
```

Cada condição fecha um caminho, e nenhuma sozinha basta:

- **`current_user = 'mavia_eliminacao'`** — e o papel é `NOLOGIN`, alcançável só por `SET ROLE` a partir de `mavia_jobs`, **nunca concedido a `mavia_app` nem a `mavia_admin`, `mavia_admin_escrita` ou `mavia_admin_definer`**. Um operador do painel não chega ao papel por nenhum caminho.
- **O GUC de transação** `app.eliminacao_execucao_id` é definido **apenas** dentro do procedimento `SECURITY DEFINER`, com `set_config(…, true)` — morre no fim da transação e não sobrevive à conexão de pool.
- **A linha em `retencao_execucoes` é gravada na mesma transação, antes do `DELETE`**, e o gatilho a exige por `EXISTS`. Não há apagamento sem registro do apagamento, e `retencao_execucoes` é append-only para todos os papéis, inclusive `mavia_retencao` e `mavia_eliminacao`.

A ordem importa e é normativa: **grava primeiro, apaga depois.** Invertida, a isenção viraria uma janela em que o `DELETE` já rodou e o registro ainda não existe.

**O job de retenção continua fora de escopo, agora com data.** A dimensão de prazo é dívida datável — a primeira obrigação vence 5 anos após o primeiro acesso de admin. A de eliminação não é adiável, porque o gatilho é o titular e o prazo é de 15 dias (art. 19 II). Por isso o **desenho dos grants sai deste épico**.

#### 3.3 · A RLS de `auditoria`, escrita (achado S3-7)

A v3 **nunca especificou** a RLS desta tabela e mesmo assim afirmava o comportamento dela. `auditoria` não existe em migration nenhuma — confirmado: o nome aparece em `0013`, `0022` e `0026`, e não há `CREATE TABLE auditoria`. Não havia policy a herdar; havia um vazio, e o vazio se preenche sozinho com o padrão do repositório.

**E o padrão do repositório recusa três linhas que este épico existe para gravar.** O padrão é `0006_nucleo.sql:271-277`: `USING` e `WITH CHECK` iguais, por `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`. Aplicado a `auditoria`, ele barra:

| Linha | Por que o `WITH CHECK` falha |
|---|---|
| Conceder e revogar admin (§4) | `tenant_id` é **nulo** por desenho, e `NULL = <uuid>` não é verdadeiro |
| A busca de `admin.listar_clientes` (§2, obrigação 5) | A listagem roda **sem `app.tenant_id`** — é a terceira exceção de `sistema.md:644-650`, e não ter contexto de tenant é a definição dela |
| A abertura de `admin.abrir_espaco` | Passa **se** o `set_config` preceder o `INSERT`, e falha se não preceder. A §1.6 agora fixa a ordem, mas a policy não pode depender disso |
| O `INSERT … SELECT` do procedimento de saída da `DEFAULT` (§3.1.1) | Reinsere linhas de **muitos tenants numa instrução só**. Nenhum valor de `app.tenant_id` satisfaz todas |

**As três formas, e a contenção fica onde ela pertence.**

```sql
ALTER TABLE auditoria ENABLE ROW LEVEL SECURITY;
ALTER TABLE auditoria FORCE  ROW LEVEL SECURITY;

-- 1 · Escrita: aceita a linha, para os papéis que têm INSERT.
CREATE POLICY auditoria_grava ON auditoria
  FOR INSERT TO mavia_app, mavia_admin, mavia_admin_escrita,
                mavia_admin_definer, mavia_admin_contrato
  WITH CHECK (true);

-- 2 · Leitura do cliente: por tenant, e só o que é do espaço dele.
CREATE POLICY auditoria_do_tenant ON auditoria
  FOR SELECT TO mavia_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

**`WITH CHECK (true)` na escrita não é relaxamento, e a frase precisa ser dita inteira:** a contenção do que entra em `auditoria` **não é a policy de escrita** — é o `GRANT` nominal (§1.2: só **cinco** papéis têm `INSERT` — `mavia_app` e os quatro do painel —, e nenhum tem `UPDATE` ou `DELETE`) somado ao gatilho de §3.1, que barra todo `UPDATE`, `DELETE` e `TRUNCATE` inclusive do dono. Uma policy de escrita por tenant aqui não protegeria nada que esses dois já não protejam, e quebraria as quatro linhas acima. **Ela seria uma trava que só acerta o caminho legítimo.**

E `tenant_id` nulo continua fazendo o que a §3 queria: pela policy 2, `USING (NULL = …)` não é verdadeiro, e as linhas de conceder e revogar admin são **invisíveis a `mavia_app`** — para todo tenant, inclusive o do próprio operador. Agora isso é consequência de uma policy escrita, e não de uma suposição.

**A leitura do registro pelo painel é por projeção própria, e não por policy de `SELECT`.** Não existe policy `FOR SELECT TO mavia_admin` em `auditoria`, e o `GRANT` de `mavia_admin` na tabela é `INSERT` **apenas** (§1.2). `GET /v1/admin/registro` é servida por **`admin.ler_registro`** (§8.0, família de leitura), `SECURITY DEFINER` de `mavia_admin_definer`, com policy própria `TO mavia_admin_definer` e **projeção fixa que não inclui `ip_hash` nem `user_agent_hash`** (§1.3). Três razões:

1. É o que mantém a decisão da §1.3 no banco, e não só no código da rota. Uma coluna vetada não sai porque **não há `GRANT`** dela para o papel que atende a requisição.
2. Ler o registro **é evento** (§6.3) e notifica os outros operadores — o que exige que a leitura passe por uma função que grava, e não por um `SELECT` livre.
3. A forma dessa policy é o mesmo risco que a **Erros e bordas · S3-4** registra: policy de definer numa listagem não tem `app.tenant_id` para se estreitar. Está nomeado lá, e não escondido aqui.

### 4 · Quem é admin

`administradores` com PK em `usuario_id` não representa conceder → revogar → conceder sem um `UPDATE` que apaga a história — o mesmo defeito que a v1 usou para recusar a flag booleana.

```
concessoes_de_admin   id, usuario_id, email_no_ato, concedida_em, concedida_por,
                      revogada_em, revogada_por
```

Append-only, estado efetivo derivado. `mavia_app` com `SELECT` apenas; conceder e revogar por função `SECURITY DEFINER` estreita ou pelo script de provisionamento — que **grava a própria linha de auditoria**, porque hoje ele seria, por construção, uma concessão sem registro.

`email_no_ato` é cópia própria e mínima do identificador, independente da FK: a §5.2 apaga fisicamente a linha de `usuarios`, e um ex-operador que peça eliminação da própria conta ou derruba a rota (`RESTRICT`) ou destrói a prova de quem teve acesso à base (`CASCADE`).

**A §5.2 já ganhou o segundo bloqueio** (`retencao-e-eliminacao.md:337`): quem é, ou foi nos últimos 5 anos, administrador não elimina a própria conta pela rota do titular.

#### 4.1 · O mínimo de dois administradores ativos é invariante de banco

A detecção entre pares (§6) só existe se houver par. Com um operador, *"notifica os outros admins"* é o conjunto vazio, e a §8.1.1 registra isso como **o ponto mais frágil da LIA** (`retencao-e-eliminacao.md:548`).

**A invariante:** nenhuma revogação deixa menos de **duas** concessões ativas. Ela é verificada **no banco**, não por `if` na aplicação, e a forma já existe no repositório: o gatilho `AFTER … FOR EACH STATEMENT` com `REFERENCING NEW TABLE`, que protege o último proprietário de um espaço (`0024_compartilhamento.sql:74-98`), pelo motivo escrito em `0024_compartilhamento.sql:69-73` — linha a linha, duas revogações simultâneas passam as duas.

```sql
CREATE TRIGGER dois_admins_ativos_na_revogacao
  AFTER UPDATE ON concessoes_de_admin
  REFERENCING NEW TABLE AS afetadas
  FOR EACH STATEMENT EXECUTE FUNCTION exigir_dois_admins_ativos();
```

O gatilho é **só de `UPDATE`**, e isso é deliberado: o `INSERT` da primeira concessão é o bootstrap, e não há isenção para escrever. Uma vez que a segunda concessão existe, a contagem não desce mais. Não há GUC de escape, não há `current_user` privilegiado, não há caminho.

**O que ele não cobre, dito — e a v3 mentia sobre o fechamento (achado S3-1).** O gatilho impede *cair* para um; não impede *operar* com um enquanto a segunda concessão nunca foi criada. A v3 escrevia que *"esse degrau é fechado por DP-32"*, tratando-a como decisão tomada.

**DP-32 não é decisão tomada.** Verifiquei `docs/decisoes-do-produto.md`: a linha 130 é o título da seção **"Em aberto — esperando o dono"**, a 132 diz *"Estas ainda não foram decididas"*, e a coluna da tabela é **"Padrão vigente"**, não "Escolha". DP-32 é a linha **136** — a v3 citava `:128`, que é um `---`.

> **A verdade, escrita:** o degrau **não está fechado**. Ele está **coberto por um padrão vigente que o dono pode mudar** — DP-32 (`decisoes-do-produto.md:136`), *"até quando o painel de admin fica sem MFA?"*, cujo padrão vigente é *"antes do primeiro cliente pagante; enquanto não houver escolha, o painel não vai a produção com cliente real"*.

Enquanto esse padrão valer, o painel não alcança cliente real com um operador só, e o degrau não é exercitável. Se o dono responder outra coisa — qualquer marco posterior ao primeiro cliente pagante —, **o degrau reabre no mesmo ato**, e a §8.1.1 volta à mesa junto com ele. O que este documento pode fazer é não chamar de fechado o que está apoiado numa pendência: a invariante de dois administradores cobre a queda, e a cobertura do degrau restante é emprestada.

**O dono do produto ainda não respondeu DP-32, DP-33 nem DP-34.** Nenhuma das três é tratada aqui como decidida.

**O painel concede admin?** Não. Só o script. Se um dia a tela existir, ela é o `PATCH /membros/:usuarioId` deste épico e merece as quatro travas de **R-4** (`matriz-de-acesso.md:57-64`).

### 5 · A autorização das rotas — e o guard que precisa existir

`pode()` mapeia rota → `Papel[]`, e `Papel` é `proprietario|membro|visualizador` (`politica-acesso.ts:17`). O admin não tem papel de tenant, e a saída fácil — colar `/admin/*` em `ROTAS_SEM_TENANT` — está proibida pela ADR 0024 D6 e pelo §1.4.

**O achado que a v2 não tinha.** A v2 invocava uma asserção de boot *"no mesmo espírito de `verificarCoberturaDaMatriz`"*. Esse mecanismo (`politica-acesso.ts:258-266`, chamado em `aplicacao.ts:119`) verifica que toda rota registrada **tem entrada em alguma lista**. Ele não verifica — e não pode verificar — que o guard está **ligado**.

E o guard **não é global**. Verificado: `app.module.ts:71-85` registra `APP_INTERCEPTOR` e nenhum `APP_GUARD`; `AutorizacaoGuard` é aplicado por `@UseGuards` em **17 dos 22 controladores** registrados em `app.module.ts:47-70`. **Um `AdminController` com entrada na matriz e sem o decorador sobe limpo e responde a qualquer sessão autenticada.** Isso contradiz `matriz-de-acesso.md:20` e `sistema.md:660`, que afirmam existir um guard global que nega por padrão. Os dois documentos descrevem um mecanismo que o código não tem.

**A correção, e ela é maior que este épico:**

1. **`AutorizacaoGuard` passa a ser registrado por `APP_GUARD`** em `app.module.ts`, ao lado do `APP_INTERCEPTOR` que já está lá. Esquecer o decorador deixa de ser expressável.
2. **Opt-out explícito e nominal**, por lista, nunca por decorador ausente:
   - rota em `ROTAS_PUBLICAS` (`politica-acesso.ts:203-226`) → passa sem sessão;
   - rota em `ROTAS_SEM_TENANT` e fora de `ROTAS_PUBLICAS` → exige `req.sessao`, é a semântica que o `SessaoGuard` (`sessao.guard.ts:17-23`) já implementa nas quatro rotas onde está aplicado;
   - rota em `ROTAS_DE_ADMIN` → ramo de admin: sessão, concessão ativa resolvida por requisição, e `req.autenticado` continua nulo;
   - qualquer outra → `req.autenticado` obrigatório e `pode(rota, papel)`.
3. **`ROTAS_PUBLICAS` já existe e nada a lê.** Verificado: a constante é declarada em `politica-acesso.ts:203` e **não tem nenhum consumidor no repositório**. A lista de opt-out que o guard global precisa já foi escrita e nunca foi ligada — é o mesmo defeito que este épico está corrigindo, uma camada acima.

> **Risco registrado, e ele afeta a API inteira.** Ligar `APP_GUARD` muda o comportamento de **todas** as rotas de uma vez. Guards do Nest compõem — as 17 ocorrências de `@UseGuards(AutorizacaoGuard)` continuam válidas e passam a ser redundantes —, mas as **13 rotas** de `ROTAS_SEM_TENANT` têm `req.autenticado` nulo por construção (`autenticador.ts:93`) e **passariam a responder 401** se caíssem no ramo padrão. Entre elas, `GET /v1/eu`, `POST /v1/sessoes`, as quatro rotas de credencial e o webhook da Stripe.
>
> Os cinco controladores que hoje **não** têm o decorador — `SessoesController`, `CadastroController`, `GoogleController`, `WebhookController` e `AceitarConviteController` — são exatamente os que servem essas rotas. Hoje eles estão descobertos por desenho; depois do `APP_GUARD` eles ficam cobertos por lista nominal, que é a diferença entre "não tem guard" e "está declarado como público".
>
> **Por isso é ticket próprio, e ele vem antes das telas do painel:** ligar o guard global, com um teste que percorre **todas** as rotas registradas e afirma o veredito esperado de cada uma (pública, só-sessão, admin, papel), executado contra a aplicação real no boot. Sem esse teste, a mudança é uma aposta sobre 13 rotas de credencial e sessão.

**Rate limit.** Duas classes próprias, não uma:

| Classe | Teto | Rotas | Por quê |
|---|---|---|---|
| `RL-ADMIN-BUSCA` | mais estrita que `RL-AUTH` (§5.1, `matriz-de-acesso.md:477`) | `GET /v1/admin/clientes` | A busca por nome ou e-mail sobre toda a base é a superfície de enumeração mais barata do produto |
| **`RL-ADMIN-ABERTURA`** | teto por hora **e** por dia, por operador | `POST /v1/admin/clientes/:tenantId/abrir` | **A v2 só limitava a busca.** Um admin comprometido percorre a base inteira **um espaço por vez**, cada abertura com motivo e referência válidos, deixando uma trilha impecável que ninguém lê. Um teto por operador transforma varredura em alarme |

O teto de `RL-ADMIN-ABERTURA` é decisão do dono do produto no ticket; o que este documento fixa é que **a classe existe e é por operador, não por rota**.

**As aberturas de escrita contam no mesmo teto, e isso é normativo.** `admin.abrir_espaco_para_escrita` (§1.6) é uma abertura como qualquer outra: `RL-ADMIN-ABERTURA` conta **as duas funções somadas**, por operador. Um teto separado para escrita seria um segundo orçamento de varredura, e o operador comprometido usaria o mais folgado. As escritas de contrato exigem, além disso, o step-up da §6.5 com o `tenant_alvo` no ticket — que é o controle por ato, enquanto o teto é o controle por volume.

**DP-33 e `RL-ADMIN-ABERTURA` são o mesmo controle puxado em direções opostas — e a v3 não mencionava DP-33 em lugar nenhum.**

DP-33 (`decisoes-do-produto.md:137`, também **em aberto**, padrão vigente **30 minutos**) pergunta *"por quanto tempo um `motivo` + `referencia` autoriza aberturas de espaço"*, e o padrão registra que *"cada abertura continua gerando sua própria linha de auditoria; o que a janela reaproveita é a hipótese"*.

As duas medidas tratam da mesma sequência de aberturas e discordam sobre o que ela significa:

| | O que ela otimiza | O que ela assume da sequência |
|---|---|---|
| **Janela de 30 min (DP-33)** | Atrito do operador legítimo: um chamado que percorre três telas não pede motivo três vezes | Que uma rajada de aberturas sob a mesma hipótese é **normal** |
| **`RL-ADMIN-ABERTURA`** | Detecção: transformar varredura da base em alarme | Que uma rajada de aberturas é **o sinal** que se quer ver |

Reconciliação, e ela é normativa aqui porque não depende da resposta do dono:

1. **A janela reaproveita a hipótese; ela nunca reaproveita a linha de auditoria.** Toda abertura chama `admin.abrir_espaco` e grava sua própria linha, com seu `tenant_alvo`, sua rota e sua contagem. É o que o próprio padrão de DP-33 diz, e é o que a §1.6 constrói.
2. **A janela é por `motivo` + `referencia` + operador, e nunca por operador sozinho.** Uma referência autoriza aberturas dentro dela; ela não autoriza *outra* referência. Sem isso, "30 minutos" viraria trinta minutos de acesso livre à base inteira.
3. **`RL-ADMIN-ABERTURA` conta aberturas, não hipóteses**, e por isso a janela **não** o afrouxa: reaproveitar a hipótese poupa o formulário, não o contador. Se poupasse, o teto deixaria de existir no exato cenário para o qual foi criado — o operador comprometido com uma referência válida, que é o do parágrafo da tabela acima.
4. **O teto por operador é o limite superior; a janela é conforto abaixo dele.** Quando os dois discordam, quem vence é o teto.

Com essas quatro linhas, uma resposta do dono a DP-33 — 30 minutos, 5 minutos ou nenhuma janela — muda o atrito do operador e **não** muda o controle. É o que permite tirar DP-33 do caminho crítico do ticket sem fingir que ela está decidida.

### 6 · O que compensa a ausência de MFA

A v1 listava três compensações e o gate mostrou que nenhuma era isolamento. A ordem abaixo mudou na v3: o item que era o primeiro de cinco passou a ser condição.

#### 6.1 · Rede — **bloqueante de deploy**, não item de lista

**Allowlist de IP ou mTLS no Traefik à frente de `/admin`, mais hostname distinto para o painel — escopo de cookie distinto — entram neste épico e bloqueiam o deploy dele.**

A formulação importa e é a condição sob a qual o gate aceita o adiamento do MFA: **sem allowlist ou mTLS em produção, o painel não sobe.** Não é a primeira de cinco compensações que se somam; é o pressuposto das outras quatro.

O motivo é concreto: hoje `/admin` seria grupo de rotas do mesmo Next, no mesmo host, com o mesmo cookie — **um XSS em qualquer tela do produto, no navegador de um admin, alcança o painel inteiro.** A `retencao-e-eliminacao.md:523` já lista esta salvaguarda como *"a construir"*, e a §8.1.1 conclui o balanceamento *"com as salvaguardas acima como condição, e não como intenção"* (`retencao-e-eliminacao.md:543`).

#### 6.2 · Redis autenticado, e o que ainda falta nele

**Corrigido no repositório, deploy pendente.** `infra/producao/docker-compose.yml:83-88` passa `--requirepass` e a linha 111 monta a `REDIS_URL` autenticada. **A correção não está em produção** — até o deploy rodar, quem alcança a rede `dados` **é** o admin, e antes de DA-1 isso comprava um tenant; depois, a base inteira. O Redis de desenvolvimento segue sem senha por decisão registrada (`infra/docker-compose.yml:43`).

Duas ressalvas viram ticket próprio, porque a senha sozinha não fecha o assunto:

1. **A senha vai em `command:`** (`infra/producao/docker-compose.yml:87-88`) e em `environment:` (`:93`, `REDISCLI_AUTH`), e as duas aparecem em `docker inspect` e na lista de processos do container. Preferível arquivo de configuração montado, ou ACL com o segredo fora da linha de comando.
2. **O usuário `default` do Redis mantém `CONFIG SET`, `FLUSHALL` e `KEYS`.** Uma ACL fecha o resto — mas ela precisa cobrir **todos** os prefixos em uso, e são cinco, não três: `sess:` e `acessos:` (`cofre-de-acesso.ts:47-48`), `oauth:` (`estado-do-oauth.ts:44`), `tentativas:` (`limite-de-tentativas.ts:65`) e o `bull:` do BullMQ (fila `recorrencias`, `agendador.ts:32,42`). Uma ACL que esqueça `tentativas:` desliga o limite de tentativas de login, que é a defesa das rotas públicas (`politica-acesso.ts:214-216`). O ticket carrega a lista dos cinco, e um teste que sobe a aplicação contra o Redis com a ACL aplicada e exercita os cinco caminhos.

E o que continua a construir, independente disso: instância ou banco separado para sessões, e **revalidação da sessão no Postgres a cada requisição sob `/admin`**.

**O que essa revalidação compra, e contra quem ela não vale (achado S3-12).** A v3 a descrevia como *"a linha de `sessoes` que o Redis afirma existir precisa existir, não estar revogada, e pertencer àquele usuário"* — uma frase que soa como defesa contra quem controla o Redis, e não é.

| | |
|---|---|
| **Compra** | **Revogação com efeito em no máximo uma requisição.** Hoje o access token vive 15 minutos no cofre (`cofre-de-acesso.ts:35`, `VIDA_DO_ACESSO_EM_SEGUNDOS = 15 * 60`) e nada consulta o Postgres no caminho quente: revogar uma sessão de admin deixa até 15 minutos de acesso vivo. É o achado **A-15** da matriz, e sob `/admin` esses 15 minutos são a base inteira. Com a revalidação, o próximo request morre. É também o que sustenta a §6.4 — privilégio resolvido por requisição, nunca carimbado |
| **Não compra** | **Nada contra quem lê ou escreve o Redis.** O cofre grava `{sessaoId, usuarioId}` **em claro**, como JSON (`cofre-de-acesso.ts:37-40` define o tipo; `:59-72` faz o `SET` do `JSON.stringify(dono)` sob a chave `sess:<sha256 do token>`). A revalidação pega esses dois valores e pergunta ao Postgres se **eles** conferem — logo, ela confirma exatamente os dois valores que o atacante acabou de copiar de lá. Quem lê o Redis já tem uma sessão válida de admin, e a revalidação diz que sim, ela é válida |

Ou seja: a revalidação fecha a janela de **revogação**, e não a de **comprometimento do cofre**. Contra o cofre, o que vale é o `requirepass` (acima), a ACL dos cinco prefixos, e o isolamento de rede — todos em **Condições de deploy**. As duas coisas são necessárias e nenhuma substitui a outra; escrevê-las juntas foi o que deu à v3 a aparência de uma defesa que ela não tem.

#### 6.3 · Detecção — e o destino da notificação é fora do produto

Ler o log **é evento**, e toda abertura de espaço e leitura do registro **notifica os outros operadores**, mais um resumo diário. Nada no desenho da v1 detectava: os itens eram preventivos ou forenses, e um log que ninguém lê descobre o incidente quando o cliente reclama. DA-2 proíbe avisar o cliente; não proíbe avisar o segundo operador.

**O destino é externo ao painel** — **DP-34, padrão vigente e decisão pendente** (`decisoes-do-produto.md:138`, na seção *"Em aberto — esperando o dono"*): *"uma notificação que só existe dentro do sistema que ela vigia não detecta o comprometimento desse sistema."* Concretamente: e-mail para endereço fora do domínio da aplicação, entregue por caminho que o painel comprometido não silencia. Uma notificação escrita numa tabela do próprio banco, ou num canal que o operador administra, não conta como detecção.

**A v3 escrevia "decisão DP-34, já tomada" e citava `:130`** — que é o **título** da seção de pendentes. É o achado S3-1, verificado linha a linha. O texto acima é o padrão vigente, e o épico o implementa como tal.

> **O que muda se o dono responder outra coisa.** DP-34 carrega, no próprio texto de `decisoes-do-produto.md:138`, a consequência: *"se a resposta for 'não', a LIA da §8.1.1 precisa ser refeita"*. E a §8.1.1 é a LIA que sustenta a **DA-1 inteira** — leitura completa dos dados financeiros dos clientes. Uma resposta negativa a DP-34 não ajusta a §6.3: ela reabre o balanceamento que autoriza o épico. Por isso a pendência é **registrada como risco do épico**, e não escondida como detalhe de implementação de uma seção.

Com a §4.1, o conjunto "os outros operadores" deixa de poder ser vazio.

#### 6.4 · Sessão curta e privilégio por requisição

Resolvido contra `concessoes_de_admin`, **nunca carimbado no token**. *Verificado como sólido pelo gate:* o cofre carrega só `{sessaoId, usuarioId}` (`cofre-de-acesso.ts:37-40`, gravado como JSON em `:59-72`) e não há onde guardar claim de papel.

#### 6.5 · Reautenticação nas escritas

Com o ticket carregando o **`tenant_alvo`** — sem isso, um ticket emitido para "dar baixa" autoriza a mesma escrita em outro cliente dentro da janela. O mecanismo de step-up está especificado na **§4** da matriz (`matriz-de-acesso.md:463`); `exigeReautenticacao()` existe em `politica-acesso.ts:239-241` e tem **um único consumidor no repositório**, o teste `membros.test.ts:274-276`, que apenas confere que a matriz marca `PATCH /v1/membros/:usuarioId`. Ou seja: **nenhum consumidor de runtime** — o predicado existe, é testado, e nada no caminho da requisição o lê. *A v3 dizia "ninguém o consulta", o que o teste desmente pela letra; a propriedade verdadeira, e a que importa, é a ausência de consumidor de runtime.* O lugar é o guard, e este épico o implementa junto com o `APP_GUARD` da §5.

> **O que a reautenticação compra, exatamente:** ela protege contra **sessão** roubada, não contra **senha** roubada — que é o risco que a ausência de MFA declara. Vale a pena e não fecha o buraco. **MFA continua sendo a única mudança que altera a natureza do risco**, e o marco é **padrão vigente, não decisão**: DP-32 (`decisoes-do-produto.md:136`) propõe *antes do primeiro cliente pagante*, e segue **em aberto** (§4.1).

### 7 · Endurecimento do §3.9 que este épico exige

O gate não conseguiu construir exploit confiável, mas a carga muda: hoje `app.tenant_id` só assume tenants do próprio usuário; depois do painel, assume **qualquer cliente**.

- `comUsuario` (`tenancy.ts:93-111`) passa a definir `app.tenant_id` como `''` explicitamente — hoje ele nunca o limpa;
- `resolverTenant` (`tenancy.ts:133`) ganha o predicado `AND usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid` (§2);
- `emTransacao` (`tenancy.ts:37-59`) libera com `cliente.release(erro)` no caminho de erro, **destruindo** em vez de reaproveitar a conexão que falhou em desfazer. Hoje o `finally` da linha 57 a devolve ao pool em qualquer caso;
- `comAdmin` (§1.4) nasce já com essa disciplina: define `app.tenant_id` como `''` explicitamente, e não conta com a conexão estar limpa.

**O que este épico *não* precisa mais fazer aqui:** a emenda ao §3.9 do `sistema.md` **já está aplicada** — `sistema.md:644` diz três exceções, `:648` nomeia `admin.listar_clientes` pela ADR 0024, `:650` traz o critério de aceite, e os vetos 8 e 10 (`:989` e `:991`) acompanham. Verificado; ver **Condições de deploy · C-10**. O que resta na §3.9 é o código dos três marcadores acima, não o texto.

### 8 · O que o admin faz

| Ação | Rota | Pool / papel | Classe no log |
|---|---|---|---|
| Buscar clientes | `GET /v1/admin/clientes` | painel · `mavia_admin` | leitura em massa — uma linha por busca, com termo hasheado e contagem |
| Ver o perfil de um cliente | `GET /v1/admin/clientes/:tenantId` | painel · `mavia_admin` | leitura em massa |
| Abrir o espaço em leitura | `POST /v1/admin/clientes/:tenantId/abrir` + rotas próprias por tela | painel · `mavia_admin` | leitura em massa, com rota e contagem |
| **Ver as baixas anteriores** | `GET /v1/admin/clientes/:tenantId/pagamentos` | painel · `mavia_admin` | leitura em massa, com rota e contagem |
| **Dar baixa em pagamento** | `POST /v1/admin/clientes/:tenantId/pagamentos` | painel · `mavia_admin_escrita` → `admin.abrir_espaco_para_escrita` → **`admin.registrar_pagamento`** (`mavia_admin_contrato`) | escrita financeira · **duas linhas** (§8.5) |
| **Prorrogar o teste** | `POST /v1/admin/clientes/:tenantId/teste/prorrogar` | idem → **`admin.prorrogar_teste`** | escrita financeira · duas linhas |
| **Conceder cortesia** (tempo) | `POST /v1/admin/clientes/:tenantId/cortesia` | idem → **`admin.conceder_cortesia`** | escrita financeira · duas linhas |
| **Cadastrar cliente novo** | `POST /v1/admin/clientes` | idem → **`admin.cadastrar_cliente`** | escrita financeira · duas linhas |
| ~~Trocar plano ou intervalo~~ | — | — | **Sai do épico. DP-40, §8.3** |
| **Ler o registro** | `GET /v1/admin/registro` | painel · `mavia_admin`, por função de `admin` com projeção fixa (§3.3) | **segurança** — e notifica os outros operadores |

**As escritas passam por `admin.abrir_espaco_para_escrita`, e isso é o achado S3-2 fechado.** Na v3, nenhuma delas passava por abertura nenhuma: a propriedade *"não se toca o espaço de um cliente sem registrar"* estava construída só para leitura, e as escritas classificadas aqui como financeiras não tinham sequer como definir `app.tenant_id` sem cometer o defeito que a ADR 0024 D1, condição 2 nomeia. A função está em §1.6; o `EXECUTE` dela, em §1.2.

**A frase correta, que a v2 errava.** A v2 fechava esta tabela com *"o admin lê e não edita dado financeiro do cliente"*, quatro linhas depois de classificar quatro ações como **escrita financeira**. `assinaturas` e `pagamentos_manuais` **são** dado financeiro: são o contrato do cliente e o dinheiro que ele pagou.

> **O admin não edita o razão do cliente.** `lancamentos`, `contas`, `faturas`, `transferencias`, `saldo_snapshots`: nenhum `GRANT` de escrita, para nenhum dos quatro papéis (ADR 0024, D6). O que ele edita é a **relação comercial** — prazo e baixa de pagamento —, e cada uma dessas escritas é ato de operador sobre o contrato, registrada com `de/para` em claro (`retencao-e-eliminacao.md` §8.2).
>
> Corrigir lançamento de cliente é pedido ao cliente, não feito por cima dele. E a propriedade é garantida por **quem a conexão é** (§1.2), não por disciplina de quem escreve a rota — foi essa distância que reprovou a v2.

#### 8.0 · As escritas moram em funções, e isso emenda a ADR 0024

**O que a v3.1 tinha.** Quatro ações classificadas como escrita financeira, um `GRANT` de cinco colunas em `assinaturas`, um `INSERT` em `pagamentos_manuais`, e **uma** linha na seção Testes: *"Domínio · Adicionar tempo e trocar plano respeitam a máquina de estados da assinatura"*. O parecer financeiro chamou isso de *"a parte de dinheiro não existe"*, e a proporção prova o ponto: o mesmo documento gasta trinta e uma asserções em `GRANT`, papel e partição.

**O que passa a valer.** Nenhuma rota emite DML sobre `assinaturas` ou `pagamentos_manuais`. Cada escrita é **uma** chamada a uma função `SECURITY DEFINER` de `mavia_admin_contrato` (§1.2), e a função é quem:

1. exige que `app.tenant_id` já esteja definido — isto é, que `admin.abrir_espaco_para_escrita` tenha rodado; sem ele, a `tenant_isolation` sem `TO` faz o `UPDATE` afetar zero linhas e o `INSERT` violar o `WITH CHECK`, e a função levanta erro em vez de devolver silêncio;
2. confere a concessão ativa por dentro, como toda função de `admin` (§2, obrigação 4);
3. lê o estado atual **`FOR UPDATE`** — que é o `de` do `de → para` (§8.5) e é também o que serializa dois operadores no mesmo cliente;
4. quando o ato muda `estado` — e só `registrar_pagamento` muda —, **recusa a transição que não existe**, pelo mecanismo do §8.1;
5. escreve;
6. grava a **segunda** linha de `auditoria`, a do efeito, com `de` e `para` (§8.5).

**Isto dispara o gatilho que a própria v3.1 registrou.** *Erros e bordas · S3-4*, saída B, fechou o esquema `admin` numa lista de três funções e escreveu o critério que reabre a decisão: *"a primeira proposta de terceira função no esquema `admin`. Nesse momento, ou a lista fechada é emendada por ADR, ou o padrão de policy do definer é revisto — e não se resolve em code review."* **Esta seção é essa proposta**, e ela não se resolve aqui.

Registro, de passagem, que a v3.1 já era incoerente nesse ponto: a §1.2 dava a `mavia_admin_escrita` `EXECUTE` *"no procedimento de cadastro de cliente"* — uma quarta função — enquanto o teste de esquema afirmava que `admin` contém **exatamente três**. A lista fechada já estava furada antes de o dinheiro entrar.

> **Emenda exigida à ADR 0024, e ela é pré-requisito do primeiro ticket desta seção.** A lista fechada do esquema `admin` passa de três para **oito**, em duas famílias com donos diferentes:
>
> | Família | Dono | Funções |
> |---|---|---|
> | Leitura e abertura | `mavia_admin_definer` | `listar_clientes` · `abrir_espaco` · `abrir_espaco_para_escrita` · `ler_registro` |
> | **Escrita de contrato** | **`mavia_admin_contrato`** | `registrar_pagamento` · `prorrogar_teste` · `conceder_cortesia` · `cadastrar_cliente` |
>
> O teste de esquema passa a afirmar **as duas listas e o dono de cada uma**, e uma nona função continua derrubando o teste. A saída A do S3-4 — o predicado de concessão dentro das policies do definer — vale igual para as duas famílias, e a obrigação 4 acima é ela.

**Por que oito e não uma função com um parâmetro `p_acao`.** Uma função por ato mantém a interface pequena e o `GRANT` de `EXECUTE` granular: `prorrogar_teste` não pode dar baixa, `registrar_pagamento` não pode prorrogar. Uma função genérica teria a união dos privilégios de todas e uma superfície que cresce a cada ação nova — módulo raso com nome de fronteira, que é o defeito que reprovou a v2 num outro andar.

#### 8.1 · `estado` não está em nenhum `GRANT`, e a transição é a do domínio (F-1, F-2)

**O cenário que abre o achado F-1, verificado.** Cliente em `em_atraso` com `graca_ate` preenchido paga R$ 79,00 por Pix. O operador dá baixa. Na v3.1, a baixa inseria uma linha em `pagamentos_manuais` e **não tocava `assinaturas`** — não havia coluna ligando as duas tabelas. Quem governa o direito de uso é `assinaturas.estado`, lido por `lerAssinatura` (`cobranca.controller.ts:311`, `:319`) e traduzido por `podeEscrever` (`catalogo.ts:201-203`, aplicado em `cobranca.controller.ts:350`). Resultado: no 15º dia o cliente **que pagou** vira `expirada` e perde a escrita.

**DP-36 — padrão vigente: a baixa restabelece o direito de uso, na mesma transação.**

`admin.registrar_pagamento` aplica o evento **`pagamento_recuperado`** (`catalogo.ts:172`), que é a transição `em_atraso → ativa` já existente — **nenhum evento novo, nenhuma transição nova.** É a mesma transição que o webhook aplica para `invoice.payment_succeeded` (`cobranca.controller.ts:291`), e é isso que mantém `CONTEXT.md:408` verdadeiro: continua havendo **um** conjunto de transições, o de `catalogo.ts`, e nenhuma rota escreve `estado` por conta própria.

**Como a função recusa o que não existe, sem duplicar a tabela de transições no banco.** A tabela `TRANSICOES` (`catalogo.ts:160-185`) é domínio, e domínio não roda no Postgres. Reescrevê-la em SQL criaria duas fontes de verdade para a mesma regra — exatamente o que `spec-planos:520` proíbe entre nós e a Stripe. O contrato da função é, então, o mesmo que o webhook já usa (`cobranca.controller.ts:228-239`):

```
admin.registrar_pagamento(p_alvo uuid, p_de estado_da_assinatura,
                          p_para estado_da_assinatura, …)
```

- a rota lê a assinatura, computa `destino = transicao(atual, 'pagamento_recuperado')` **no domínio** e recusa com `409` se for `null`;
- a função relê a linha `FOR UPDATE` e **exige `estado = p_de`**; se um webhook mudou o estado no meio, o `UPDATE` afeta zero linhas e a função levanta `TRANSICAO_OBSOLETA`. Duas fontes escrevendo a mesma linha sem trava é a *"pior frase que um produto de cobrança pode produzir"* de `spec-planos:533`;
- `p_para` só pode ser `'ativa'`, e **só** quando `p_de = 'em_atraso'`. É a única transição que uma baixa produz. `expirada → ativa` **não é alcançável por esta função** — reativar quem expirou é `reativou` (`catalogo.ts:183`), que é ato do titular na tela de cobrança, não do operador.

**E a limpeza de `graca_ate` não é opcional — o banco já a exige.** O `CHECK graca_so_em_atraso` (`0025_assinatura.sql:48-49`) diz `(estado = 'em_atraso') = (graca_ate IS NOT NULL)`. Um `UPDATE` que ponha `estado = 'ativa'` deixando `graca_ate` preenchido é **rejeitado pelo banco**, não por `if`. A função usa a mesma expressão do webhook (`0025:181`), `graca_ate = CASE WHEN p_para = 'em_atraso' THEN graca_ate END`, e a `CHECK` é a asserção. O parecer notou que *"alguém já pensou nesse caminho sem escrevê-lo"*; a `CHECK` é essa pessoa, e agora o caminho está escrito.

> **`estado` e `graca_ate` saem do `GRANT` de `mavia_admin_escrita` e entram apenas no de `mavia_admin_contrato`** (§1.2), que é alcançável só de dentro destas funções. `periodo_fim` e `periodo_inicio` não entram em `GRANT` nenhum (§8.3, §8.4).

#### 8.2 · Dar baixa em pagamento (F-3, F-4, F-5, F-6, F-7)

**A linha é dinheiro que entrou.** Cinco correções, e cada uma fecha um achado.

**a · O tipo, e a moeda com amarra (F-7).** A v3.1 dizia *"valor em centavos inteiros com moeda ISO (regra 1)"* e não declarava tipo nenhum. `INTEGER` estoura em R$ 21.474.836,47 — improvável numa baixa e irrelevante como argumento: o padrão da casa é `BIGINT` e não se abre exceção por probabilidade.

```sql
valor_centavos  BIGINT  NOT NULL CHECK (valor_centavos > 0),
moeda           CHAR(3) NOT NULL CHECK (moeda = 'BRL'),
```

`> 0`, e não `>= 0`: uma baixa de zero não é um pagamento. `CHECK (moeda = 'BRL')` enquanto multi-moeda não tiver ADR — é a mesma forma que `tenants.timezone` já usa, com a razão escrita no comentário (`0001_fundacao.sql:45-48`): *"CHECK e não texto livre"*. O catálogo declara `BRL` nos três planos (`catalogo.ts:64-83`) e `tenants.moeda_base` nasce `'BRL'` (`0001_fundacao.sql:49`), sem `CHECK` — um teste de esquema afirma que nenhum tenant tem outra, e é ele que precisa quebrar no dia em que a segunda moeda aparecer.

**b · `competencia` deixa de ser data nua (F-5).** `CONTEXT.md:34-39` é normativo: competência é `DATE` fixada no dia 1, calculada convertendo o instante para `America/Sao_Paulo` **antes** de extrair mês e ano, nunca a partir do UTC nu. Uma baixa às 22h de 30 de setembro em São Paulo é 01/out em UTC, e a receita do mês muda de lugar sozinha.

Portanto a competência **não é digitada e não é derivada do relógio de quem grava**: o operador informa **quando o dinheiro entrou** (`recebido_em`, que ele lê no comprovante), e a competência é **coluna gerada**:

```sql
recebido_em  TIMESTAMPTZ NOT NULL,
competencia  DATE NOT NULL GENERATED ALWAYS AS (
               (date_trunc('month', recebido_em AT TIME ZONE 'America/Sao_Paulo'))::date
             ) STORED,
CONSTRAINT competencia_no_dia_1 CHECK (extract(day from competencia) = 1)
```

Gerada, e não conferida por `CHECK`: uma coluna gerada **não pode** divergir da regra, enquanto um `CHECK` só reprova quem errou. A `CHECK` fica junto porque é a documentação executável da invariante do `CONTEXT.md` e sobrevive a uma mudança de definição.

**A guarda de data futura mora na função, e a razão é do Postgres:** `CHECK (recebido_em <= now())` **não compila** — `now()` é estável, não imutável, e o Postgres recusa a constraint. `admin.registrar_pagamento` levanta `RECEBIMENTO_NO_FUTURO`, e o teste correspondente é de integração, não de esquema. Dinheiro que ainda não entrou não tem baixa.

> **DP-37 — padrão vigente: competência do recebimento, uma linha por pagamento, sem rateio.** Um pagamento anual de R$ 990,00 é **uma** competência de R$ 990,00, e não doze de R$ 82,50. `99000/12 = 8250` é exato, mas `59000/12` e `79000/12` **não são** — e ratear reintroduziria no caminho do dinheiro a divisão que `spec-planos:308-310` declara não existir, trazendo `ratear`, a regra 3 e a prova por propriedade junto. O período que o pagamento cobre já é dito por `assinaturas.periodo_inicio`/`periodo_fim`; não precisa ser inventado aqui.

**c · Idempotência: a baixa duplicada passa a ser impossível de esconder (F-3).** A v3.1 não tinha chave de idempotência, não tinha índice único, e **nenhum papel tinha `SELECT`** na tabela — nem o operador. Dois operadores davam baixa no mesmo Pix em horas diferentes, nenhum via a linha do outro, e a escrituração somava R$ 198,00 sobre R$ 99,00 recebidos.

A regra 13 do `CLAUDE.md` já dá a forma da chave — `(tenant_id, provider, external_id)`. Aqui ela é:

```sql
referencia_externa TEXT NOT NULL CHECK (length(btrim(referencia_externa)) BETWEEN 6 AND 140),
CREATE UNIQUE INDEX pagamento_manual_unico
  ON pagamentos_manuais (tenant_id, meio, referencia_externa) WHERE deleted_at IS NULL;
```

`referencia_externa` é o **end-to-end id do Pix**, o identificador do comprovante da transferência, o número do boleto. `NOT NULL` inclusive para `dinheiro`: quem recebe em espécie escreve o número do recibo, e se não há recibo não há baixa. É a chave que torna a reimportação do mesmo pagamento um conflito, e é o que a regra 13 pede.

**O índice único não resolve o caso da digitação divergente**, e por isso ele não é a única defesa:

- a função faz uma **pré-checagem de semelhança** — mesma `(tenant_id, valor_centavos, competencia)` viva — e levanta `PAGAMENTO_SEMELHANTE` com o `id` e a `referencia_externa` da linha existente. A rota devolve `409` com esses dados na tela;
- o operador segue **só** reenviando com `confirmado_semelhante = true`, e essa confirmação **vai na linha de auditoria**. Sugestão, não sobrescrita — é a forma da regra 15 aplicada a um caso que não é conciliação bancária, mas tem o mesmo formato;
- a tela **lista as baixas anteriores antes do botão**, e não depois. É a rota `GET /v1/admin/clientes/:tenantId/pagamentos`, servida por `mavia_admin` com `SELECT` nominal por coluna (§1.2) — leitura do espaço de um cliente, logo passa por `admin.abrir_espaco` e tem sua própria linha de auditoria, como qualquer outra.

  **Orçamento, dito para não ser descoberto no meio:** esta é a **quarta** tela de cliente, e a §1.4 avisa que *"uma quarta tela é um ticket, não um ajuste"*. Ela é ticket, e ela é do mesmo ticket da baixa: dar baixa sem ver as baixas anteriores é o cenário F-3 com outra roupa.

**d · A exportação do titular passa a conseguir ler (F-4).** É o achado S3-3 — *"policy sem `GRANT` não lê nada"* — uma tabela adiante. A exportação roda como `mavia_app` (`exportacao.controller.ts:238` → `comTenant` → `'mavia_app'` em `tenancy.ts:74`), e a v3.1 mandava exportar `pagamentos_manuais` sem conceder `SELECT` a `mavia_app`. A `tenant_isolation` da tabela estava escrita; o `GRANT`, não.

```sql
GRANT SELECT (id, valor_centavos, moeda, competencia, recebido_em,
              meio, referencia_externa, observacao, registrado_em)
  ON pagamentos_manuais TO mavia_app;
```

Nominal, e `registrado_por` fica de fora **por construção** — não por lista de omissão no serializador. É a mesma propriedade que a §1.3 compra com o `GRANT` por coluna: uma coluna nova não se estende sozinha, e o `EXPORTADA_EM_PARTE` do *Modelo de dados* deixa de ser uma promessa do código para virar um privilégio que não existe.

**e · Cortesia e ajuste não são dinheiro, e por isso saem da tabela (F-6).** Na v3.1, `meio` era `pix | transferencia | boleto | dinheiro | cortesia | ajuste`, tudo na mesma coluna de valor. Uma cortesia de `9900` fazia a receita crescer R$ 99,00 sem um centavo ter entrado, e saía na exportação do titular como um pagamento que ele nunca fez. É o formato exato do erro que a **regra 12b** nomeia: linha que pertence à listagem e não ao total.

> **DP-38 — padrão vigente: `pagamentos_manuais` contém só dinheiro que entrou.** `meio` passa a ser `pix | transferencia | boleto | dinheiro`, e **acabou**. `cortesia` vira **tempo concedido** (§8.4), medido em dias e nunca em centavos; `ajuste` desaparece, porque o que ele significava — *"registrei errado"* — já é o `deleted_at` que o *Modelo de dados* define como estorno de baixa.

**A exclusão da regra 12b vive num tradutor único, e aqui ela é ainda mais forte: não há o que excluir.** A regra 12b exige que a exclusão de uma classe de linha de toda agregação monetária *"viva num tradutor de filtro único, não num `AND` repetido em cada consulta"*. Como a tabela passa a não conter linha não-monetária, a única exclusão que resta é a de estornos, e ela fica em **um** lugar:

> **Normativo:** existe uma função única, `pagamentosRecebidos(tenantId, janela)`, e ela é **o único ponto do repositório que lê `pagamentos_manuais` para somar**. Ela aplica `deleted_at IS NULL` e a janela semiaberta `[inicio, fim)` (regra 7). Qualquer outra consulta à tabela é de listagem, nunca de total. Um teste percorre o repositório e falha se `pagamentos_manuais` aparecer dentro de um `sum(` ou `count(` fora dela.

**E nada disso cria `Lancamento`.** Uma baixa de pagamento é dinheiro que entrou **na Mavia**, não no espaço do cliente. Ela não toca `lancamentos`, `contas`, `faturas`, `transferencias` nem `saldo_snapshots`, não altera saldo nenhum do cliente, e não aparece em relatório dele. As regras 4, 5, 6, 12 e 12b não são exercitadas por este épico porque **ele não escreve no razão** — §8.7.

#### 8.3 · Trocar plano sai do épico (F-8, F-9, F-10, F-11)

Quatro achados apontam para a mesma linha da §8 da v3.1 — `UPDATE (plano, intervalo)` —, e os quatro procedem. Verifiquei cada um.

**F-8 · O painel atravessaria a regra que a rota do cliente cumpre.** `cobranca.controller.ts:127-131` recusa o downgrade no meio do ciclo e devolve `aplicadoEm: 'fim_do_periodo'`, com a razão escrita em `:99-101`: *"o cliente comprou aquele período inteiro. Cortar no meio seria vender doze meses e entregar sete."* É `spec-planos:291`. Um cliente Negócio que pagou R$ 99,00 no dia 1º e fosse rebaixado no dia 10 perderia 21 dias já pagos.

**F-9 · O operador produziria um preço errado na tela do cliente.** `lerAssinatura` monta `precoCentavos: preco(codigo, linha.intervalo).centavos.toString()` (`cobranca.controller.ts:349`), com `codigo` vindo de `assinaturas.plano` e `intervalo` da coluna homônima. **Não existe preço contratado persistido:** `0025_assinatura.sql:18-50` não tem `preco_contratado_centavos`, não tem `moeda`, não tem `plano_versao`, embora `spec-planos:448` e `:460` os exijam. Trocar `intervalo` de `mensal` para `anual` num formulário de dois campos faz a tela do cliente saltar de R$ 59,00 para R$ 590,00, sem que o débito mude e sem que nada reclame.

**F-10 · A fórmula de reembolso leria o plano que o operador editou.** `reembolso = max(0, valor_pago − meses_iniciados × preco_mensal_do_plano)` (`spec-planos:305`), e `preco_mensal_do_plano` sai de `assinaturas.plano`. Cliente paga Negócio anual (`99000`), o operador troca para `pessoal` no mês 2, e o cancelamento no mês 4 devolve `99000 − 3 × 5900 = 81300` em vez de `99000 − 3 × 9900 = 69300` — R$ 120,00 a mais. O inverso custa R$ 120,00 ao cliente.

**F-11 · O painel seria um terceiro caminho de rebaixamento.** `spec-planos:416` recusa no ato o downgrade abaixo da contagem de pessoas ou espaços — *"remover pessoa é decisão do titular, jamais efeito colateral de uma mudança de plano"*. O §8.2 daquele spec trata o caminho involuntário do webhook e tolera. O painel seria **deliberado como o §8.1, sem a recusa; instantâneo como o §8.2, sem o aviso** — e um `UPDATE` não roda a resolução determinística de `conexoes` do §8.3, que no épico 12 é dinheiro nosso: `conexoes` é *"a única cota que corresponde a uma fatura que a Mavia paga por unidade"* (`spec-planos:175`).

> **DP-40 — padrão vigente: o painel não troca plano nem intervalo. A ação sai do épico.**

**Aqui eu discordo do parecer, e a discordância é sobre o prazo, não sobre a regra.** O parecer propõe que *"o painel agenda para o fim do período, chamando o mesmo caminho de aplicação"*. Concordo com a regra e **verifiquei que não há caminho a chamar**: `cobranca.controller.ts:127-131` **devolve `fim_do_periodo` e não persiste nada** — não há tabela de troca agendada em nenhuma migration, e não há job que aplique agendamento nenhum. "Chamar o mesmo caminho" significaria construir o caminho, e construí-lo é épico 11.

Somando F-9: mesmo que o agendamento existisse, o painel escreveria `plano` numa tabela que não guarda o preço contratado, e o reembolso de F-10 continuaria lendo o plano editado. **O pré-requisito real é do épico 11**, e são duas coisas:

1. `assinaturas` ganha `preco_contratado_centavos BIGINT`, `moeda CHAR(3)` e `plano_versao`, gravados na contratação e **imutáveis dentro do período** (`spec-planos:448`, `:460`), e `lerAssinatura` passa a exibir esse campo em vez de reconsultar o catálogo. Isto conserta, de quebra, o reajuste de catálogo reescrevendo preço retroativo de quem já é cliente;
2. o agendamento de downgrade que `spec-planos:414` promete — *"o downgrade é agendado, não recusado"* — passa a existir de fato.

**O que o operador faz enquanto isso, e é honesto dizer:** ele orienta o cliente a trocar pela própria tela, que é onde a regra já está implementada. Um caso de suporte a mais custa menos que R$ 69,00 tirados de um cliente que pagou, e muito menos que um reembolso calculado sobre um plano que ele nunca teve.

**Consequência no `GRANT`:** `plano` e `intervalo` permanecem na lista de `mavia_admin_contrato` (§1.2) **e nenhuma função os escreve hoje** — a coluna existe no privilégio para que a emenda futura não precise de nova migration de papel, e o teste de esquema afirma que **nenhuma das oito funções de `admin` contém `UPDATE … SET plano`**. Se o dono responder DP-40 no outro sentido, o que muda é uma função nova, não a topologia.

#### 8.4 · Adicionar tempo: `periodo_fim` sai do `GRANT` (F-12, F-13)

**Dois fatos verificados, e eles se somam.**

**F-12 · O webhook sobrescreve o campo.** `auth.aplicar_estado_da_assinatura` faz `periodo_fim = coalesce(p_periodo_fim, periodo_fim)` (`0025_assinatura.sql:182`), com o valor vindo de `current_period_end` do evento (`cobranca.controller.ts:237`, `:299-302`). O operador concede 60 dias por indisponibilidade; na próxima fatura o webhook grava o `periodo_fim` da Stripe e **os 60 dias somem sem uma linha de auditoria**, porque quem escreveu foi `mavia_auth`, no caminho do webhook, que não passa pelo log do painel.

**F-13 · Num tenant em `teste`, "adicionar tempo" é literalmente o `UPDATE` vetado.** `CONTEXT.md:407` e `spec-planos:456` dizem que prorrogar é *"operação nomeada e auditada, nunca um `UPDATE` solto"* — e na implementação o fim do teste **é** `periodo_fim`: o gatilho grava `now() + interval '7 days'` ali (`0025_assinatura.sql:78-79`), e não existe coluna `teste_termina_em`. Um `UPDATE (periodo_fim)` num tenant em `teste` é a prorrogação solta que a invariante nomeia.

> **A correção: `periodo_fim` não entra em `GRANT` nenhum.** O tempo concedido pelo painel vive em coluna própria, **`cortesia_ate TIMESTAMPTZ`**, que nenhum caminho existente escreve — verificado: `aplicar_estado_da_assinatura` escreve `estado`, `graca_ate`, `periodo_fim` e `atualizado_em`, e nada mais (`0025:179-185`).

**E o fim efetivo passa a ser uma leitura, não uma coluna:**

```
fim_efetivo = greatest(periodo_fim, coalesce(cortesia_ate, periodo_fim))
```

**Normativo, e é a metade que decide se a cortesia vale alguma coisa:** todo caminho que decidir expiração — o job do 8º dia, o de fim de graça, o de fim de período, quando existirem — lê `fim_efetivo`, **nunca `periodo_fim` cru**. Um teste fixa isso, e ele é o único controle contra a cortesia evaporar em silêncio no dia em que o job nascer. É o mesmo desenho que `Cobranca.reembolso` usa em `spec-planos:468-475`: o eixo derivado ao lado do número que o descreve, em vez de um segundo campo escrevível que pode divergir dele.

**Duas funções, e não uma, porque são dois atos com nomes diferentes:**

| Função | Estado exigido | O que escreve | Teto (padrão vigente) |
|---|---|---|---|
| `admin.prorrogar_teste` | `estado = 'teste'` | `cortesia_ate` | **uma vez por Tenant**, no máximo **+7 dias** — o mesmo prazo da DP-15, e não mais que ele. `spec-planos:267` diz *"sem prorrogação automática"*; esta é manual, nomeada e auditada, que é o que a invariante permite |
| `admin.conceder_cortesia` | `estado ∈ {ativa, em_atraso, cancelada}` | `cortesia_ate` | **no máximo +30 dias por chamada e +60 acumulados** dentro do mesmo período. Exige `razao` (texto livre, obrigatório), que vai na linha de auditoria |

`estado = 'expirada'` é **recusado nas duas**: dar tempo a quem já expirou é reativar sem pagamento, que é a transição `reativou` (`catalogo.ts:183`) e é ato do titular. É a mesma recusa da §8.1, pelo mesmo motivo.

**A honestidade que falta dizer, e que o parecer não pediu:** hoje **nenhum job expira nada** (ver *O contrato comercial*, fato 1). "Adicionar tempo" é, neste instante, uma escrita que muda o que o cliente lê e não muda o que o sistema faz. A coluna entra agora mesmo assim, por duas razões: ela é o que impede o `UPDATE` vetado de F-13 já no primeiro ticket, e acrescentá-la depois exigiria descobrir, linha a linha, quais `periodo_fim` haviam sido esticados à mão — que é a migração de dado de cliente pagante que `spec-planos:62` manda evitar.

**F-13, o adjacente: o cliente cadastrado pelo painel nasce em `teste` e nunca sai.** O gatilho `assinatura_de_teste_trg` (`0025:87-89`) dispara em todo `INSERT` em `tenants` e cria a assinatura em `teste` com 7 dias, com as cotas do Família (`catalogo.ts:94`). Sem job de expiração, esse cliente fica em `teste` **para sempre**, e a v3.1 criava a ação *"cadastrar cliente novo"* sem dizer como ela termina. Escrito:

> **`admin.cadastrar_cliente` não inventa um caminho para `ativa`.** Ela cria o espaço e vincula o titular, e **para**. O cliente sai de `teste` pelo caminho de todo mundo: assinando (`assinou`, `catalogo.ts:164`), o que hoje depende da P-14. Enquanto a P-14 não existir, a ação serve para **preparar** o espaço de quem vai assinar, e a tela diz isso ao operador com todas as letras: *"este espaço vai ficar em teste até o cliente assinar."* Nenhum estado é forçado à mão; a alternativa seria o painel virando o terceiro escritor de `estado`, que é o que a §8.1 acabou de fechar.

**Três amarras nessa função, e a segunda é de segurança, não de dinheiro:**

1. **Ela não cria identidade.** O titular precisa **já ter conta** — a função recebe um `usuario_id` existente e vincula. Criar `usuarios` pelo painel seria fabricar uma identidade para outra pessoa, que atravessa `spec-autenticacao.md` e a DP-25, e não é deste épico por nenhum caminho.
2. **Ela roda o mesmo teto de criação de espaços que a rota do cliente.** `auth.criar_tenant` (`0004_cadastro.sql:287-310`, com os dois tetos em `:302-303`) recusa acima de **3 por dia** e **10 ativos** por usuário — e o comentário de `:285-286` diz por que ele mora ali: *"o teto vive AQUI, e não só no guard: um teto que existe só na aplicação é um teto que a próxima rota esquece"*. **Este épico é a próxima rota.** É a guarda A-18/DP-26 que a segurança impôs, e que `spec-planos:398` (§7.2) cita como parte da defesa contra o abuso do teste sem cartão. Um caminho de criação que não a roda **é o bypass dela**, e ele nasceria no painel sem ninguém notar. A verificação é copiada por dentro, com a mesma consulta e as mesmas duas exceções (`TETO_DIARIO_DE_TENANTS`, `TETO_DE_TENANTS_ATIVOS`), e um teste afirma que o painel recusa o 4º espaço do dia igual à rota do cliente.
3. **O `GRANT` dela é nominal e conferido na primeira execução.** Ela escreve em `tenants` e `tenant_usuarios`, e o gatilho `assinatura_de_teste_trg` (`0025_assinatura.sql:87-89`) cria a assinatura por baixo, como `mavia_auth` — esse não precisa de privilégio nosso. **O ticket confere a lista contra as migrations antes de escrever a migration**, e o mecanismo que pega a omissão é o mesmo do achado S3-3: o teste de integração que roda a função contra o esquema recém-migrado. *Uma função de `admin` que falha na primeira execução por falta de `GRANT` é o defeito que já reprovou este documento uma vez.*

#### 8.5 · `de → para` ganha quem os escreva (F-14)

**O achado.** A ordem normativa da v3.1 — `set_config` antes do `INSERT`, tudo dentro de `abrir_espaco*` (§1.6, S3-7) — faz aquela linha registrar a **intenção**: o valor `para` só existe depois do `UPDATE`, que ainda não aconteceu. E `auditoria` não aceita `UPDATE` de ninguém (§3.1), então a linha **não pode ser completada depois**. Resultado: nenhuma das escritas financeiras tinha `de → para`, embora a §3 declare as colunas e o parecer de LGPD já tenha emendado a política de retenção (§8.2 de lá) para recebê-las.

**A correção é uma segunda linha, e não uma linha editável.**

| Linha | Quem grava | Quando | Conteúdo |
|---|---|---|---|
| **1 · intenção** | `admin.abrir_espaco_para_escrita`, como `mavia_admin_definer` | antes da escrita, depois do `set_config` | `motivo`, `referencia`, `rota`, `acao`, `tenant_id`, classe de escrita financeira. `de` e `para` **nulos** |
| **2 · efeito** | a função de contrato da §8.0, como `mavia_admin_contrato` | depois do `UPDATE`/`INSERT`, na mesma transação | `de` e `para` vindos do `SELECT … FOR UPDATE` e do `… RETURNING`, mesma `entidade`/`entidade_id`, mesma classe |

As duas carregam a mesma **`correlacao UUID`** (coluna nova, §3), gerada pela abertura e devolvida por ela. É o que torna o par verificável: uma linha de intenção sem linha de efeito é uma escrita que falhou ou foi desfeita, e as duas juntas contam a história inteira sem que nenhuma linha precise ser alterada.

`mavia_admin_definer` e `mavia_admin_contrato` já têm `INSERT ON auditoria` (§1.2), e a policy `auditoria_grava` é `WITH CHECK (true)` (§3.3) — **é omissão de spec, não impossibilidade**, exatamente como o parecer diz. O `RETURNING OLD` do Postgres 18 não existe aqui: rodamos 17, e o `de` vem do `SELECT … FOR UPDATE` que a §8.0 já exige por outro motivo.

**Por que não uma linha só, gravada depois da escrita.** Porque então uma escrita que falha no meio não deixa rastro nenhum, e a propriedade *"não se toca o espaço de um cliente sem registrar"* volta a valer só quando dá certo. A intenção precede o efeito pelo mesmo motivo que a §3.2 grava antes de apagar.

#### 8.6 · A marca de origem, e o job que ainda não existe (F-15)

**O achado, e ele é real.** `spec-planos:579` especifica um job diário que compara `assinaturas` com a Stripe: *"divergência é incidente"*, *"a correção segue a Stripe"*, e quando reduz acesso *"avisa o proprietário por e-mail com o motivo antes de valer"*. **Toda escrita legítima do painel é, por construção, uma divergência.** No dia em que os dois existirem juntos: cada atendimento abre um incidente; a correção **desfaz** o ato do operador; e o cliente recebe um e-mail dizendo que o acesso dele foi reduzido por uma mudança que a Mavia fez e desfez.

**Verifiquei que o job não existe** — não há código de reconciliação de assinatura em lugar nenhum, e a única fila é a de recorrências (`recorrencias/agendador.ts:42`). Logo F-15 não é um incidente de hoje: é uma colisão **marcada** para o dia em que o épico 11 escrever o job.

**O que entra agora, mesmo assim:**

```sql
origem_da_ultima_escrita TEXT NOT NULL DEFAULT 'stripe'
  CHECK (origem_da_ultima_escrita IN ('stripe', 'painel', 'cliente', 'sistema')),
```

Escrita por **todo** caminho que toca `assinaturas`, e não só pelo painel — o que exige um `CREATE OR REPLACE` de `auth.aplicar_estado_da_assinatura` numa migration nova, marcando `'stripe'`. Migration é forward-only; a de 0025 não é editada.

**Ela entra agora porque não dá para acrescentá-la depois.** Uma coluna de origem criada no dia do job precisa de um valor para as linhas já escritas, e esse valor é uma adivinhação sobre quem escreveu o quê — que é exatamente a informação que ela existe para não perder.

> **DP-39 — sem padrão vigente, e é a única das cinco assim.** A pergunta é se **o painel escreve na Stripe e espera o webhook**, ou se **escreve no nosso banco com marca de origem**. As duas fecham F-15, e a escolha depende de a chave de API da Stripe existir (P-14), que é do dono:
>
> | Saída | O que o job faz | O que custa |
> |---|---|---|
> | **A · o painel escreve na Stripe** | Nada muda no job: não há divergência, porque a Stripe passa a ser a fonte também do que o operador fez | Depende da P-14, e faz uma baixa por Pix virar uma escrita no provedor de cartão — que é o que `spec-planos:529-531` mantém separado |
> | **B · marca de origem** | O job **reconhece** `origem_da_ultima_escrita = 'painel'`, e uma divergência assim é reconciliada **em favor da nossa linha** dentro de uma janela declarada, não em favor da Stripe | Abre a primeira exceção a *"a correção segue a Stripe"*, e a exceção precisa ser escrita naquele spec, não neste |
>
> **Enquanto DP-39 não for respondida, F-15 não fecha, e é por isso que ela é condição de deploy (C-11) e não de ticket.** O que este documento pode fazer sozinho é garantir que a informação exista quando a resposta chegar — a coluna — e que o cliente não receba o e-mail do §10.5 por causa de um atendimento.

#### 8.7 · O que este épico não toca no dinheiro — registrado porque está certo

O parecer financeiro reprovou a parte de dinheiro e, no mesmo texto, registrou o que a v3 e a v3.1 acertaram. Fica escrito, porque uma revisão que só lista defeitos ensina a próxima pessoa a desfazer o que estava bom:

| Propriedade | Como ela é garantida | Onde se prova |
|---|---|---|
| **O razão do cliente está intacto.** `lancamentos`, `contas`, `faturas`, `transferencias`, `saldo_snapshots` não recebem `GRANT` de escrita para nenhum dos quatro papéis | Por **quem a conexão é** (§1.2), não por disciplina de rota. `RESET ROLE` aterrissa em `mavia_admin`, sem DML | Testes · integração, `permission denied` em `UPDATE`, `INSERT` e `DELETE` das cinco tabelas |
| **Nenhuma `Cobranca` e nenhum pagamento manual cria `Lancamento`** | A baixa é dinheiro que entrou **na Mavia**. Nenhuma das oito funções de `admin` escreve no razão, e `mavia_admin_contrato` não tem `SELECT` nem `INSERT` em tabela do razão (§1.2) | Testes · esquema e integração (§8.2 e) |
| **Regra 4 — partida dobrada da transferência** | Não é exercitada: o painel não cria transferência | — |
| **Regra 5 — saldo derivado** | Não é exercitada: nenhuma escrita do painel entra na soma de saldo de nenhum cliente | — |
| **Regra 6 — sinal explícito** | Não é exercitada: `valor_centavos > 0` é dinheiro recebido pela Mavia, num eixo que não é o do razão | — |
| **Regra 12 — pagamento de fatura é transferência** | Não é exercitada, e a colisão de vocabulário está fechada desde o épico 11: a fatura da assinatura é `Cobranca`, e `Fatura` é o ciclo do `Cartao` (`spec-planos:508`, `CONTEXT.md:412-414`) | — |
| **Regra 12b — transferência fora de toda agregação** | Não é exercitada pelo razão, e o **formato** dela é respeitado no eixo novo: a exclusão vive num tradutor único (§8.2 e), e a tabela não contém linha não-monetária | Testes · o teste que proíbe `sum(` sobre `pagamentos_manuais` fora de `pagamentosRecebidos` |
| **`periodo_inicio` ficou fora do `GRANT`, e é deliberado** | É a âncora de `meses_iniciados` na fórmula de reembolso (`spec-planos:305`, `:314`), e a contagem usa a **Ancoragem de dia do mês** do `CONTEXT.md`. Editá-lo move o marco de todos os meses do contrato de uma vez, para trás ou para a frente, e o reembolso muda junto. **Nenhuma função da §8.0 o escreve, e ele não está em `GRANT` de papel nenhum do painel** | Testes · esquema |

### 9 · As telas

Hostname próprio (§6.1). Lista de clientes · perfil do cliente · registro, mais as **quatro** telas de leitura do espaço do cliente com rota própria (§1.4): perfil, contas e saldos, lançamentos do período e **baixas anteriores** (§8.2 c). Seguem `docs/design.md`, com a auditoria da §5 daquele documento rodada antes da entrega.

O motivo e a referência são pedidos **antes** de abrir o espaço, não depois.

**Três exigências de tela que vêm do parecer financeiro, e que não são decoração:**

1. **A tela de baixa mostra as baixas anteriores acima do formulário**, não numa aba. Sem isso, o cenário F-3 — dois operadores, o mesmo Pix, horas diferentes — não tem como ser percebido por gente (§8.2 c).
2. **A tela de baixa diz o que a baixa faz.** Se o cliente está `em_atraso`, ela diz por escrito: *"esta baixa reativa o acesso deste espaço"* (§8.1). Uma escrita que muda o direito de uso não pode parecer um registro contábil.
3. **A tela de baixa diz o que ela não faz.** Pagamento fora da Stripe **não** entra no `valor_pago` de nenhum reembolso, porque não existe `Cobranca` correspondente (F-10; a tabela `cobrancas` não existe — ver *O contrato comercial*, fato 2). O texto é literal: *"este pagamento não entra no cálculo automático de reembolso; se este cliente pedir cancelamento com devolução, o valor é conferido à mão."* Registrar isso na tela é o mínimo honesto enquanto o épico 11 não decidir se pagamento fora da Stripe é reembolsável — e é a metade do F-10 que este épico consegue fechar sozinho.

Valores em algarismos tabulares e alinhados à direita, competência como mês por extenso, e nenhuma coluna de dinheiro sem a moeda ao lado — `docs/design.md:50`, repetido na auditoria de entrega (`:127`).

---

## Modelo de dados

```
concessoes_de_admin    id, usuario_id, email_no_ato, concedida_em, concedida_por,
                       revogada_em, revogada_por
auditoria (particion.)  ver §3
pagamentos_manuais     id, tenant_id, registrado_por, registrado_em, recebido_em,
                       competencia (gerada), valor_centavos, moeda, meio,
                       referencia_externa, observacao, deleted_at
assinaturas            três colunas novas — ver abaixo
```

**`pagamentos_manuais`, campo a campo — é a tabela que o parecer financeiro reprovou inteira.**

```sql
CREATE TYPE meio_de_pagamento AS ENUM ('pix', 'transferencia', 'boleto', 'dinheiro');

CREATE TABLE pagamentos_manuais (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants (id),

  -- Quem, e quando ele registrou. `registrado_por` nunca sai ao titular (abaixo).
  registrado_por UUID        NOT NULL REFERENCES usuarios (id),
  registrado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- **Quando o dinheiro entrou**, lido no comprovante. Não é o relógio de quem
  -- grava, e não vem do cliente (regra 9: a data de negócio é do servidor, e
  -- aqui ela é do documento bancário, conferida pelo operador).
  recebido_em    TIMESTAMPTZ NOT NULL,

  -- Derivada, nunca digitada. `CONTEXT.md:34-39`: dia 1, convertida para
  -- America/Sao_Paulo **antes** de extrair mês e ano.
  competencia    DATE NOT NULL GENERATED ALWAYS AS (
                   (date_trunc('month', recebido_em AT TIME ZONE 'America/Sao_Paulo'))::date
                 ) STORED,

  valor_centavos BIGINT  NOT NULL CHECK (valor_centavos > 0),
  moeda          CHAR(3) NOT NULL CHECK (moeda = 'BRL'),
  meio           meio_de_pagamento NOT NULL,

  -- A chave de idempotência da regra 13, na forma que esta tabela permite:
  -- end-to-end id do Pix, identificador do comprovante, número do boleto ou do
  -- recibo. Sem ela não há baixa, inclusive para dinheiro em espécie.
  referencia_externa TEXT NOT NULL
                     CHECK (length(btrim(referencia_externa)) BETWEEN 6 AND 140),

  observacao     TEXT,
  deleted_at     TIMESTAMPTZ,

  CONSTRAINT competencia_no_dia_1 CHECK (extract(day from competencia) = 1)
);

CREATE UNIQUE INDEX pagamento_manual_unico
  ON pagamentos_manuais (tenant_id, meio, referencia_externa)
  WHERE deleted_at IS NULL;

CREATE INDEX pagamento_manual_por_competencia
  ON pagamentos_manuais (tenant_id, competencia) WHERE deleted_at IS NULL;
```

O enum tem **quatro** valores, e não seis: `cortesia` e `ajuste` saíram (DP-38, §8.2 e). **A tabela contém só dinheiro que entrou** — é o que torna a exclusão da regra 12b desnecessária por construção, em vez de correta por disciplina.

**A FK de `registrado_por` é segura, e a razão está na §4.** `usuarios` é apagada fisicamente pela §5.2 da política de retenção, e uma FK para lá seria a mesma armadilha que obrigou `concessoes_de_admin` a guardar `email_no_ato`. Aqui ela se sustenta porque *"quem é, ou foi nos últimos 5 anos, administrador não elimina a própria conta pela rota do titular"* (§4) — e a linha de pagamento vive **exatamente** 5 anos por obrigação fiscal (`retencao-e-eliminacao.md` §3.6). Os dois prazos são o mesmo, e essa coincidência é o que mantém a FK de pé; se um dos dois mudar, esta tabela ganha um `email_no_ato` pelo mesmo argumento da §4.

`observacao` é livre e **opcional** — e a UI diz, ao lado do campo: *"esta observação pode ser lida pelo cliente se ele pedir os dados dele"*. Alinha o comportamento do operador ao que a exportação entrega, e mata a categoria "nota interna sobre o cliente que ninguém previa que sairia".

**`assinaturas` ganha três colunas, e nenhuma delas é editável por `GRANT` de rota:**

```sql
ALTER TABLE assinaturas
  ADD COLUMN cortesia_ate              TIMESTAMPTZ,                        -- §8.4, F-12/F-13
  ADD COLUMN origem_da_ultima_escrita  TEXT NOT NULL DEFAULT 'stripe'      -- §8.6, F-15
      CHECK (origem_da_ultima_escrita IN ('stripe','painel','cliente','sistema')),
  ADD CONSTRAINT cortesia_depois_do_periodo
      CHECK (cortesia_ate IS NULL OR cortesia_ate > periodo_inicio);
```

`cortesia_ate` é o tempo concedido pelo operador, somado na leitura (`fim_efetivo`, §8.4) e **jamais** escrito por `periodo_fim` — que é o campo que o webhook sobrescreve (`0025_assinatura.sql:182`). A terceira "coluna" é a `CHECK`, e ela está aqui porque uma cortesia anterior ao início do período não é cortesia, é engano de digitação.

**E `atualizado_em` passa a ser escrita por gatilho (F-16).** Ela está fora do `GRANT` das rotas e **todo caminho existente a escreve** — `cobranca.controller.ts:135` na troca de plano do cliente, `0025_assinatura.sql:183` no webhook — e ela sai na exportação. Sem gatilho, ou a escrita do painel falha na coluna, ou omite-a e a linha exportada mente sobre quando foi tocada:

```sql
CREATE TRIGGER assinaturas_atualizado_em
  BEFORE UPDATE ON assinaturas
  FOR EACH ROW EXECUTE FUNCTION tocar_atualizado_em();
```

Gatilho, e não disciplina: ele é imune a quem esqueça, inclusive ao webhook e às funções da §8.0. `atualizado_em` permanece na lista de `mavia_admin_contrato` (§1.2) só para que um `UPDATE` que a mencione não estoure por privilégio — o valor que vale é o do gatilho.

**RLS e soft delete não são opcionais nesta tabela.** A v2 dizia que ela *"não tem caminho de leitura voltado ao tenant"*, o que é verdade e **é propriedade da aplicação, não do banco**. A regra 16 exige RLS em toda tabela de negócio e a regra 17 exige `deleted_at`; nenhuma das duas admite "não existe rota hoje" como fundamento. Então:

```sql
ALTER TABLE pagamentos_manuais ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagamentos_manuais FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pagamentos_manuais
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

— o mesmo padrão de `0006_nucleo.sql:271-277`, e `deleted_at TIMESTAMPTZ`, com a ressalva da §3.6 de `retencao-e-eliminacao.md`: a linha sobrevive à eliminação do espaço por obrigação legal, então `deleted_at` marca estorno de baixa registrada por engano, nunca eliminação.

**`registrado_por` não sai na exportação do cliente.** Ele é o `usuarios.id` de um funcionário da Mavia. Entregá-lo na exportação do titular contraria a **DA-2 por porta lateral**: o cliente descobriria pelo arquivo o que a decisão do dono determinou não contar. Saem `id`, `valor_centavos`, `moeda`, `competencia`, `recebido_em`, `meio`, `referencia_externa`, `observacao` e `registrado_em`; não sai `registrado_por`.

**E a omissão passa a ser um privilégio que não existe, não uma lista no serializador (F-4).** O `GRANT SELECT` de `mavia_app` é nominal por coluna e não inclui `registrado_por` (§8.2 d) — o mesmo raciocínio da §1.3: *"coluna nova não se estende sozinha"*. Sem esse `GRANT`, a exportação nem sequer lia a tabela: é o achado S3-3 — **policy sem `GRANT` não lê nada** — repetido uma tabela adiante, e a v3.1 mandava exportar uma tabela que `mavia_app` não podia abrir.

**Isso cria um terceiro estado que o teste de completude não tem.** Hoje a classificação é binária e fechada: `TABELAS_EXPORTADAS` (`exportacao.controller.ts:289`), `EXPORTADA_JUNTO` (`:197`) e `FORA_DA_EXPORTACAO` (`:206`); o teste monta um conjunto com as três e falha se sobrar tabela com `tenant_id` não classificada (`relatorios.test.ts:273-280`). **Não existe "exportada em parte".** O ticket acrescenta `EXPORTADA_EM_PARTE: ReadonlyMap<string, {colunas_omitidas, porque}>`, entra no conjunto do teste, e ganha uma asserção própria: **as colunas omitidas não aparecem na saída real da exportação** — senão a lista vira documentação e o campo sai assim mesmo.

---

## LGPD — o que muda fora do código

| # | Onde | O quê | Estado |
|---|---|---|---|
| 1 | `retencao-e-eliminacao.md` §10.5 e §10.6 → **v2** | Os textos diziam *"quem mais vê: todas as pessoas do espaço"*, o que passava a ser falso por omissão | **Feito.** `:704` e `:719` declaram o acesso da administração; `:684-686` registra que o reconsentimento devido é zero e por quê |
| 2 | Nova §8.1.1 — **LIA do acesso de operador** | A LIA do §8.1 não se estende: ela lista como salvaguarda *"o log é exposto ao próprio titular"*, e DA-2 retira exatamente essa | **Feito.** `:464-553`, com hipóteses fechadas, salvaguardas, a ausência de MFA como fato e os três pontos onde o balanceamento é apertado |
| 3 | Nova §3.8 — **operação interna** | Primeira categoria do produto cujo titular não é cliente | **Feito.** `:195-215`, com `concessoes_de_admin` 5 anos e a classe de acesso de operador em 5 anos, não nos 12 meses de "leitura em massa" |
| 4 | §3.5 e §4.4 | Carve-out: a anonimização de `auditoria.usuario_id` aos 90 dias não alcança a classe de operador | **Feito.** `:154`, `:163-165`, `:281-291`, e o predicado normativo `WHERE ator_tipo <> 'operador'` em `:576` |
| 5 | §3.6 e §5.3 | `pagamentos_manuais`: 5 anos, sobrevive à eliminação; `observacao` 12 meses; quinta linha em "sobrevive apenas" | **Feito.** `:178-179` e `:352`, com `:356` dizendo que sem ela o R-08 reprova |
| 6 | §8.2 | Campos de `assinaturas` na linha "estruturais — em claro" | **Feito.** `:563`, e `:564` cobre a baixa de `pagamentos_manuais` |
| **7** | **Procedimento escrito** | Resposta ao art. 18 I e II: pedido do titular respondido com a lista de acessos do período, em até 15 dias. **Com dono e prazo.** A justificativa de `auditoria` em `FORA_DA_EXPORTACAO` (`exportacao.controller.ts:213`) diz *"sai por outro fluxo"* e hoje aponta para um fluxo que não existe. O texto de consentimento v2 já o promete ao titular (`retencao-e-eliminacao.md:704`), o que o torna também obrigação contratual | **Falta** |
| **8** | **Política de privacidade** | Declaração genérica do acesso de operador, e o e-mail do encarregado (art. 41 §2º I) | **Falta** |
| **9** | **ROPA + RIPD** | Entrada para "acesso de operador a espaço de cliente". A §8.1.1 já é o núcleo do RIPD, e diz isso em `:553` | **Falta** |
| **10** | §3.6 — **as colunas novas da v3.2** | `pagamentos_manuais` ganhou `recebido_em` e **`referencia_externa`** — o end-to-end id do Pix ou o número do comprovante, que é identificador de uma transação bancária do titular e portanto dado pessoal. `assinaturas` ganhou `cortesia_ate` e `origem_da_ultima_escrita`. As duas primeiras entram na **mesma classe de 5 anos** da linha de pagamento, por obrigação fiscal; as duas últimas, na classe de `assinaturas`. **Nenhuma abre finalidade nova:** a referência existe para a idempotência da regra 13 (F-3) e para o titular reconciliar o próprio extrato, e nada além — um uso secundário dela é finalidade nova, pelo mesmo argumento que o épico 11 usa para o documento fiscal (`spec-planos:663-670`) | **Falta** — é insumo para quem está editando aquele arquivo, não uma edição deste |

**Já feito no código:** o teste de completude da exportação passou a excluir partições (`relatorios.test.ts:252-270`) — sem isso ele falharia todo mês, quando a partição seguinte nascesse. Verificado contra um pai particionado real.

---

## Erros e bordas

| Situação | Resposta |
|---|---|
| Não-admin em rota `/v1/admin` | 404. **Não é controle** — o tempo de resposta difere de um caminho inexistente, e o App Router entrega o manifesto de rotas. É grátis, e só. Não conta como salvaguarda (`retencao-e-eliminacao.md:526`) |
| Admin revogado com sessão viva | Próxima requisição recusa — o privilégio é resolvido por requisição contra `concessoes_de_admin` (§6.4) |
| Escrita sem reautenticação, ou com ticket de outro cliente | 401 com marcador próprio |
| Falha ao gravar auditoria | A transação desfaz. Para escrita, nada sobrevive; para leitura, ver §1.8 |
| Mês sem partição | **Não pode acontecer:** o job mantém 24 meses de pista e alarma abaixo de 3 (§3.1.1) |
| Linha na partição `DEFAULT` | **Incidente aberto**, com procedimento de saída em §3.1.1. Não é warning |
| Revogação que deixaria menos de dois admins ativos | Recusada pelo banco, `ERRCODE P0001` (§4.1) |
| `RESET ROLE` numa rota do painel | Aterrissa em `mavia_admin`, que não escreve em tabela nenhuma (§1.2). Na conexão de escrita, aterrissa em `mavia_admin_escrita`, que **também** não tem DML — o privilégio mora em `mavia_admin_contrato`, que ninguém alcança |
| Baixa com a mesma `referencia_externa` | `23505` do índice único, traduzido para **`409`** que nomeia a linha existente e a data em que ela foi registrada. Nunca "erro ao salvar" (§8.2 c) |
| Baixa **semelhante** — mesmo valor, mesma competência, referência diferente | `409` com a linha existente na tela. Segue só com `confirmado_semelhante = true`, e a confirmação vai na linha de auditoria. Sugestão, não sobrescrita |
| Baixa com `recebido_em` no futuro | `RECEBIMENTO_NO_FUTURO` na função, `400` na rota. Não é `CHECK`: `now()` não é imutável e o Postgres recusa a constraint (§8.2 b) |
| Baixa num cliente que não está `em_atraso` | A baixa é gravada e **nenhuma transição acontece** — `transicao(atual, 'pagamento_recuperado')` devolve `null` fora de `em_atraso` (`catalogo.ts:171-175`), e a rota registra o pagamento sem tocar `estado`. Não é erro: é o caso comum de quem paga em dia por Pix |
| Webhook muda o estado no meio da baixa | `TRANSICAO_OBSOLETA`: o `UPDATE` exige `estado = p_de` e afeta zero linhas. A transação inteira desfaz, inclusive o `INSERT` do pagamento, e o operador reenvia lendo o estado novo (§8.1) |
| "Adicionar tempo" num cliente `expirada` | Recusado. Dar tempo a quem expirou é reativar sem pagamento, e reativar é `reativou` — ato do titular (§8.4) |
| Prorrogar o teste duas vezes | Recusado: uma vez por Tenant, teto de +7 dias (§8.4) |
| Trocar plano pelo painel | **A rota não existe** (DP-40, §8.3). Não é 403 nem 404 de controle: é ação que este épico não tem |
| Escrita de contrato sem a linha de efeito | Impossível de produzir pela rota: a segunda linha é gravada dentro da mesma função, na mesma transação. Se ela falhar, a escrita desfaz (§8.5) |

### A armadilha que a correção de `mavia_auth` recria um esquema adiante (achado S3-4)

Recomendação sem veto no parecer, e a observação mais incômoda dele. Registrada aqui inteira, porque é o tipo de coisa que se descobre na terceira função e não na primeira.

**O argumento.** A §2 tirou o dono da `SECURITY DEFINER` de `mavia_auth` porque `mavia_auth` já lê cinco tabelas cross-tenant com `USING (true)`, e uma função escrita pela convenção nasceria lendo a base inteira. A correção foi criar `mavia_admin_definer` e torná-lo o dono. Mas as policies **novas** desse papel terão forma ampla pela mesma razão estrutural que as de `mavia_auth` têm: **numa listagem não existe `app.tenant_id` por definição** — é a terceira exceção de `sistema.md:644-650`. Uma policy `TO mavia_admin_definer` sobre `tenants` não tem por onde se estreitar a não ser por um predicado que alguém precisa lembrar de escrever.

**E o teste previsto institucionaliza a convenção.** A asserção *"o dono de toda função em `admin` é `mavia_admin_definer`"* (§Testes) é um controle correto contra o erro da v2 e, ao mesmo tempo, uma instrução: a próxima pessoa que escrever uma função em `admin` vai fazê-la pertencer a `mavia_admin_definer` para o teste passar — e ela nascerá **com acesso às policies amplas da primeira**. A segunda função de admin nasce lendo a base inteira, sem violar uma linha deste documento. É exatamente o formato do achado que reprovou a v2, um esquema à frente.

**As duas saídas propostas pelo revisor:**

| | Como | Custo |
|---|---|---|
| **A** — predicado de concessão dentro das policies do definer | Cada policy `TO mavia_admin_definer` carrega `EXISTS (SELECT 1 FROM concessoes_de_admin WHERE usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid AND revogada_em IS NULL)` | A checagem passa a valer para **toda** função do esquema, inclusive as que ninguém releu. Mas o predicado só qualifica *quem chama*, não *quais linhas* — ele não estreita a projeção, e a leitura da base inteira continua possível para um operador com concessão |
| **B** — esquema `admin` travado numa lista fechada de duas funções, com emenda à ADR para a terceira | Asserção de boot ou de esquema: `pg_proc` sob `admin` contém exatamente `listar_clientes` e `abrir_espaco*`. Uma função nova derruba o teste até a ADR 0024 ser emendada | Fricção deliberada. Não impede a terceira função; obriga que ela seja decidida em vez de escrita |

**Recomendo B, com A junto — e a ordem importa.**

B é o controle real: ele ataca a *convenção* (o mecanismo do achado), não o sintoma. A já era obrigação 4 da §2 para `listar_clientes`; generalizá-la para todas as policies do definer é barato e fecha o caso do operador sem concessão. O que A **não** faz é impedir a terceira função de nascer ampla, e é por isso que ela não basta sozinha — é a mesma distância entre "a policy está certa" e "a policy está no lugar certo" que reprovou a v2.

~~**Não é bloqueante e não é escopo desta revisão.**~~ **O gatilho disparou na v3.2, e um passo antes do previsto.**

O critério registrado era *"a primeira proposta de terceira função no esquema `admin`"*. Duas coisas o acionaram de uma vez:

1. **A lista já estava furada na v3.1.** A §1.2 dava a `mavia_admin_escrita` `EXECUTE` *"no procedimento de cadastro de cliente"* — uma quarta função — enquanto o teste de esquema afirmava que `admin` contém **exatamente três**. Um dos dois teria falhado no primeiro ticket.
2. **A correção financeira precisa de mais quatro funções** (§8.0), porque o privilégio de escrever contrato tem de morar no **dono** delas, e não no papel que a rota usa.

**Como fica, e é a saída B com a emenda que ela previa:** duas listas fechadas, com **donos diferentes** — leitura em `mavia_admin_definer`, escrita de contrato em `mavia_admin_contrato` (§8.0). Isso melhora o achado em vez de piorá-lo: a função nova que alguém escrever seguindo a convenção precisa **escolher** a família, e cada família tem um conjunto de policies estreito ao que ela faz — o definer não tem `UPDATE` em lugar nenhum, e o `contrato` não tem `SELECT` em tabela do razão. A convenção deixa de dar acesso amplo por herança porque não existe mais **uma** convenção.

**A saída A entra junto, como estava recomendado:** toda policy `TO mavia_admin_definer` e `TO mavia_admin_contrato` carrega o predicado de concessão ativa. Ele não estreita a projeção, e continua sendo isso que ele não faz.

**A emenda à ADR 0024 é pré-requisito do primeiro ticket da §8, e não se resolve em code review** — como este parágrafo dizia desde a v3.1.

---

## Condições de deploy

**C-1 a C-5 do parecer de segurança bloqueiam o primeiro ticket e estão fechadas desde a v3.1; F-1 a F-14 bloqueiam o primeiro ticket e estão fechados nesta v3.2.** As **seis** abaixo (C-6 a C-11) bloqueiam o **deploy**, não o ticket. Estão aqui, com o achado de origem, para não se perderem entre a implementação e a subida — é a lista que o `sre-devops-vps` executa e contra a qual o gate confere antes de o painel alcançar cliente real.

| # | Condição | Origem | Onde já está tratado | Estado |
|---|---|---|---|---|
| **C-6** | **Allowlist de IP ou mTLS no Traefik à frente de `/admin`**, mais hostname distinto e escopo de cookie distinto | §6.1 | §6.1 é explícita: *"sem allowlist ou mTLS em produção, o painel não sobe"*. `retencao-e-eliminacao.md:523` já a lista como *a construir* | **Falta** — é o pressuposto das outras compensações do MFA, não uma delas |
| **C-7** | **`requirepass` implantado em produção**, mais a **ACL dos cinco prefixos**, com teste que sobe a aplicação contra o Redis com a ACL aplicada e exercita os cinco caminhos | §6.2 | Corrigido no repositório (`infra/producao/docker-compose.yml:83-88`, `:111`), **deploy pendente**. Os cinco prefixos: `sess:` e `acessos:` (`cofre-de-acesso.ts:47-48`), `oauth:`, `tentativas:`, `bull:` | **Falta** — até o deploy rodar, quem alcança a rede `dados` é o admin |
| **C-8** | **`RL-ADMIN-ABERTURA` implementada**, com teto por hora e por dia por operador, e **reconciliada com DP-33** | §5 | A reconciliação em quatro pontos está escrita na §5 e não depende da resposta do dono. O **teto numérico** é decisão do dono no ticket | **Falta** — a classe está especificada; o valor e o código, não |
| **C-9** | **Os quatro papéis nascem `NOLOGIN`**, com a credencial entregue como **provisionamento** — nunca na migration —, e **`statement_timeout` nos quatro** | §1.1, §1.2 | **R-5.3** (`matriz-de-acesso.md:504`) é normativa (*"`statement_timeout` definido no papel de banco, não por chamada"*) e `0001_fundacao.sql:149-150` é o precedente: `ALTER ROLE mavia_app SET statement_timeout = '5s'` e `mavia_jobs`, `'60s'`. `bootstrap-papeis.sql` é o precedente do provisionamento fora da migration | **Falta.** Proposta: **5 s** para `mavia_admin` e `mavia_admin_escrita` (são rotas HTTP, como `mavia_app`); `mavia_admin_definer` e `mavia_admin_contrato` herdam o do chamador e recebem o seu próprio por simetria. A listagem que varre a base é o caso que o teto existe para pegar |
| **C-10** | **A emenda ao `sistema.md` §3.9 aplicada no `sistema.md`** | ADR 0024 | **Verifiquei os três lugares e a emenda já está aplicada:** `sistema.md:644` diz *"as exceções … são três, e a lista é fechada"*, `:648` nomeia `admin.listar_clientes` citando a ADR 0024, `:650` traz o critério de aceite, e o veto 8 em **`:989`** diz *"três exceções nomeadas em §3.9. A terceira entrou pelo ADR 0024"*. O veto 10, em `:991`, já nomeia `/v1/admin/` com as três condições | **Feito** — o parecer descreve um estado anterior do arquivo. Fica na lista para ser conferido no deploy, não para ser executado |
| **C-11** | **DP-39 respondida, e o job de reconciliação do épico 11 sabendo da marca de origem** — ou o painel escrevendo na Stripe | §8.6 · **F-15** | A coluna `origem_da_ultima_escrita` entra já no primeiro ticket (Modelo de dados), porque acrescentá-la depois exige adivinhar a origem das linhas já escritas. **O job não existe hoje** — verificado, a única fila é a de recorrências (`recorrencias/agendador.ts:42`) —, então a colisão está marcada, não acontecendo | **Falta.** Sem DP-39, F-15 não fecha: no dia em que os dois existirem juntos, cada atendimento vira incidente, a correção **desfaz** o ato do operador, e o cliente recebe o e-mail de `spec-planos:579` dizendo que o acesso dele foi reduzido por uma mudança que a Mavia fez e desfez |

**Notas de forma sobre C-9, porque são o tipo de coisa que se erra na migration:**

- `NOLOGIN` primeiro, credencial depois, e nunca no mesmo arquivo. Migration é forward-only e vive no repositório; senha em migration é senha versionada.
- `mavia_admin_definer` e `mavia_admin_contrato` são `NOLOGIN` **para sempre** — nunca autenticam, só são donos de função (§1.2). E `mavia_admin_contrato` **não recebe membro nenhum**: um `GRANT mavia_admin_contrato TO …` numa migration futura é o que desfaz a §8.0 inteira, e o teste de `pg_auth_members` existe para pegá-lo.
- Os `GRANT` de esquema e de coluna da §1.2 rodam como `mavia_migrate`, ou não têm efeito e não falham (§1.2, o modo de falha).

---

## Testes

Cada correção da v3 e da v3.1 tem a asserção que a prova, no nível onde a propriedade existe. **As asserções de dinheiro estão na subseção própria, ao fim** — foi a ausência delas que reprovou a v3.1.

| Nível | O que prova | Fecha |
|---|---|---|
| **Compilação** (`tsc --noEmit`) | `comTenant` **não aceita** `{ usuarioId, tenantId }` montado à mão — `@ts-expect-error` que falha o typecheck se o erro deixar de ocorrer | §1.5 · a trava de tipo, no nível certo |
| **Compilação** | Os quatro contextos da §1.5 não se substituem: cada `@ts-expect-error` cobre um par trocado, e os pares de leitura e de escrita de admin (`ContextoDeAdmin` × `ContextoDeAdminEscrita`) inclusive — é o que impede o caminho de leitura de habilitar uma escrita | §1.4, §1.5, §1.6 |
| **Esquema** (Postgres real) | `mavia_admin` tem `SELECT` **exatamente** nas colunas da lista fechada. Uma coluna nova em tabela alcançada pelo painel **falha o teste** até ser classificada | §1.3 · a propriedade que o `GRANT` por coluna compra |
| **Esquema** | Nenhum dos **nove** campos de `CAMPOS_VETADOS` está em nenhum `GRANT` de nenhum dos quatro papéis — e a lista lida pelo teste é **a mesma constante** que a varredura do OpenAPI (AB-07) lê. Duas listas divergentes é o defeito que o achado S3-6 descobriu | §1.3 |
| **Esquema** | `auditoria.ip_hash` e `auditoria.user_agent_hash` **não** estão no `GRANT` de `mavia_admin`, e não aparecem na projeção de `GET /v1/admin/registro` | §1.3 · a decisão escrita como decisão |
| **Esquema** | `has_schema_privilege` devolve verdadeiro para `USAGE` em `public` **e** em `admin`, para os quatro papéis. *Este teste existe porque um `GRANT` sem dono não falha* (`bootstrap-papeis.sql:36-44`) | §1.2 · o `USAGE` que a v3 esqueceu |
| **Esquema** | `mavia_admin_definer` tem `SELECT` nominal nas quatro tabelas da projeção, `SELECT ON concessoes_de_admin` e `INSERT ON auditoria`; e **não** tem `UPDATE`, `DELETE` nem `EXECUTE` sobre tabela do razão | §1.2, §2 obrigações 4 e 5 |
| **Esquema** | Os **cinco** papéis que gravam em `auditoria` têm `INSERT`; **nenhum** tem `UPDATE`, `DELETE` ou `TRUNCATE` | §1.2, §3.1, §3.3 |
| **Esquema** | `mavia_eliminacao` tem `SELECT ON retencao_execucoes` — sem ele o gatilho de §3.2 levanta `permission denied` e a R-08 nunca roda | §3.2 · S3-3 (c) |
| **Esquema** | `pg_auth_members`: `mavia_app` não é membro dos quatro; nenhum dos quatro é membro de `mavia_app`; `mavia_admin` não é membro de `mavia_admin_escrita`; **`mavia_admin_contrato` não tem membro nenhum e não é membro de ninguém**; nenhum dos cinco é membro de `mavia_eliminacao`; nenhum tem `rolbypassrls` | §1.2 · as não-relações |
| **Esquema** | `mavia_admin_definer` tem `rolcanlogin = false` | §1.2, C-9 |
| **Esquema** | Os quatro papéis têm `statement_timeout` em `pg_roles.rolconfig` | Condições de deploy · C-9 |
| **Esquema** | O dono de cada função em `admin` é `mavia_admin_definer` (família de leitura) **ou** `mavia_admin_contrato` (família de escrita de contrato), pela lista da §8.0 — e **nenhuma** é de `mavia_auth` ou `mavia_migrate` | §2 · ADR 0024 D4 · §8.0 |
| **Esquema** | O esquema `admin` contém **exatamente** as oito funções da §8.0, com o dono certo em cada família. Uma nona derruba o teste até a ADR 0024 ser emendada de novo. *A v3.1 afirmava três e concedia `EXECUTE` numa quarta — o teste teria falhado no primeiro ticket* | Erros e bordas · S3-4, saída B · §8.0 |
| **Esquema** | Toda função em `admin` tem `SET search_path` em `proconfig` | §2, obrigação 2 |
| **Esquema** | `auditoria` tem RLS `ENABLE` + `FORCE`, uma policy `FOR INSERT` com `WITH CHECK (true)` para os cinco papéis que gravam, uma `FOR SELECT TO mavia_app` por `tenant_id`, e **nenhuma** policy `FOR SELECT TO mavia_admin` | §3.3 |
| **Esquema** | `EXECUTE ON admin.abrir_espaco` é só de `mavia_admin`; `EXECUTE ON admin.abrir_espaco_para_escrita` é só de `mavia_admin_escrita`. Nenhum dos dois alcança a função do outro | §1.6 · S3-2 |
| **Integração** (Postgres real) | Na conexão do painel, `BEGIN; SET LOCAL ROLE …; RESET ROLE; UPDATE lancamentos …` leva `permission denied` — **o teste que a v2 não teria passado** | §1.1 |
| **Integração** | `mavia_admin` leva `permission denied` em `UPDATE`, `INSERT` e `DELETE` de `lancamentos`, `contas`, `faturas`, `transferencias` e `saldo_snapshots` | §8 |
| **Integração** | `admin.listar_clientes` roda **na primeira execução**, contra o esquema recém-migrado, com o pool de leitura do painel — sem `permission denied` de esquema, de tabela, de `concessoes_de_admin` ou de `auditoria`. *É o teste que a v3 não teria passado* | §1.2, §2 · S3-3 (a) e (b) |
| **Integração** | `admin.listar_clientes` chamada por um `app.usuario_id` **sem concessão ativa** devolve **erro**, não zero linhas | §2, obrigação 4 · critério de aceite da ADR 0024 |
| **Integração** | Passar o pool **do cliente** a `comTenantDeAdmin` leva `permission denied to set role`; passar um pool **do painel** a `comTenant` leva o mesmo; e passar o pool **de leitura** a `comTenantDeAdminEscrita` leva o mesmo — nos três casos **antes** de qualquer `set_config` e de qualquer leitura. *O `SET LOCAL ROLE` redundante é o que produz essa falha; removê-lo faz este teste passar a verde por outro caminho, e por isso ele vem em par com o seguinte* | §1.4 · S3-10 |
| **Integração** | `comTenantDeAdmin`, `comAdmin` e o caminho de escrita emitem `SET LOCAL ROLE` como **primeira** instrução da transação, verificado por espionagem das consultas emitidas. Remover a instrução redundante quebra este teste | §1.4 · S3-10, a frase normativa |
| **Integração** | `comAdmin` define `app.usuario_id` do operador e define `app.tenant_id` como `''`; sob ele, um operador **não** enxerga a concessão de outro operador em `concessoes_de_admin` | §1.4 · S3-9 |
| **Integração** | Cada uma das quatro escritas da §8 passa por `admin.abrir_espaco_para_escrita` e **afeta linhas**. Sem a abertura, a função **levanta erro** — e o teste prova as duas metades do achado por baixo dela, emitindo o DML cru como `mavia_admin_contrato` sem o GUC: o `UPDATE` de `assinaturas` afeta **zero linhas** e o `INSERT` em `pagamentos_manuais` viola o `WITH CHECK`. *A função converte o silêncio em erro; o teste prova que o silêncio era o comportamento de baixo* | §1.6 · S3-2 · §8.0 |
| **Integração** | A linha gravada por `abrir_espaco_para_escrita` tem a **classe de escrita financeira** e o mesmo `tenant_id` que virou `app.tenant_id`. Divergência entre auditado e efetivado não é produzível pela rota | §1.6 · S3-2 |
| **Integração** | `mavia_admin_escrita` leva `permission denied` ao chamar `admin.abrir_espaco`, e `mavia_admin` ao chamar `admin.abrir_espaco_para_escrita` | §1.6, §1.2 |
| **Integração** | As três linhas de `auditoria` que o padrão de policy recusaria são **aceitas**: conceder admin (`tenant_id` nulo), a busca de `listar_clientes` (sem `app.tenant_id`), e o `INSERT … SELECT` do procedimento de saída da `DEFAULT`, com linhas de vários tenants numa instrução | §3.3 · S3-7 |
| **Integração** | `mavia_app` **não enxerga** as linhas de conceder e revogar admin, para nenhum valor de `app.tenant_id` | §3.3 |
| **Integração** | `admin.listar_clientes` grava a linha da busca na mesma transação, com termo hasheado e contagem | §2, obrigação 5 |
| **Integração** | Termo de busca com aspas e `%` não altera o conjunto de resultados nem produz erro de sintaxe — parâmetro vinculado | §2, obrigação 3 |
| **Integração** | Toda leitura por `abrirEspacoComoAdmin` deixa **exatamente uma** linha, com `motivo`, `referencia`, `rota` e contagem, e o `tenant_id` da linha é o mesmo que virou `app.tenant_id` | §1.6 |
| **Integração** | `motivo` fora do enum recusa o `INSERT`, e a abertura não acontece | §1.6 |
| **Integração** | `mavia_app` leva `permission denied` em `UPDATE`, `DELETE` **e `TRUNCATE`** de `auditoria` | §3.1 |
| **Integração** | O gatilho barra `UPDATE` e `DELETE` **do dono da tabela**, e numa **partição criada pelo job**, depois do `REVOKE` | §3.1 |
| **Integração** | `mavia_eliminacao` **sem** o GUC de transação leva `AUDITORIA_IMUTAVEL`; **com** o GUC mas **sem** a linha em `retencao_execucoes`, leva `AUDITORIA_IMUTAVEL`; só as três condições juntas apagam | §3.2 · a reconciliação |
| **Integração** | `mavia_admin`, `mavia_admin_escrita` e `mavia_app` **não conseguem** `SET ROLE mavia_eliminacao` | §3.2 |
| **Integração** | O job de partições é idempotente: duas execuções no mesmo mês não criam nada e não falham; e toda partição criada nasce com o `REVOKE`, os `GRANT` e o gatilho | §3.1.1 |
| **Integração** | Com uma linha de mês futuro na `DEFAULT`, o `ATTACH` daquela partição falha — **o teste documenta a armadilha** para que ninguém a reintroduza como "rede de segurança" | §3.1.1 |
| **Integração** | O procedimento de saída da `DEFAULT` roda inteiro sem uma única instrução `DELETE` em `auditoria`, e ao fim toda linha está na partição do mês dela | §3.1.1 |
| **Integração** | Revogar a penúltima concessão ativa leva `P0001`; revogar com três ativas passa; duas revogações no mesmo `UPDATE` são barradas juntas | §4.1 |
| **Integração** | Nenhuma policy de `tenants`, `usuarios` ou `tenant_usuarios` referencia `concessoes_de_admin` | §2 |
| **Integração** | Com admin logado, `X-Mavia-Tenant` de um cliente alheio no **app normal** continua sendo 403 | §1.4, §2 |
| **Integração** | Nenhuma rota `/v1/admin/*` produz `req.autenticado` não-nulo, e nenhuma chama `comTenant`, `comUsuario` ou `resolverTenant` | §1.4 · a declaração normativa |
| **Integração** | Admin revogado perde acesso na requisição seguinte | §6.4 |
| **Integração** | Sabotagem: auditoria que falha desfaz a escrita, e a resposta não sai | §1.8 |
| **Boot** (contra a aplicação real) | **Toda** rota registrada tem veredito declarado — pública, só-sessão, admin, ou papel — e o guard global entrega esse veredito. Um controlador novo sem entrada derruba o boot | §5 · o achado S-4 |
| **Boot** | Toda rota registrada com prefixo `/v1/admin/` está em `ROTAS_DE_ADMIN` (**chave exata**, não prefixo), e nenhuma chave de `ROTAS_DE_ADMIN` aponta para caminho fora do prefixo — as duas direções. O prefixo aparece **só aqui** | §1.4 · S3-8 |
| **Integração** | `exigeReautenticacao()` passa a ter consumidor de runtime: uma rota marcada na matriz e chamada sem step-up recebe 401 com o marcador próprio. Hoje o único consumidor é `membros.test.ts:274-276` | §6.5 · S3-12 |
| **Integração** | Revogar a sessão de um operador tira o acesso na **requisição seguinte**, sem esperar os 15 minutos de vida do access token (`cofre-de-acesso.ts:35`) — o que a revalidação no Postgres compra, medido | §6.2 · A-15 |
| **Boot** | `ROTAS_PUBLICAS` tem consumidor: o teste falha se a constante voltar a ser lista morta | §5, item 3 |
| **Integração** | As 13 rotas de `ROTAS_SEM_TENANT` continuam respondendo o que respondiam **depois** de `APP_GUARD` ligado — rota a rota, com o código de status esperado | §5 · o risco registrado |
| **Integração** | `pagamentos_manuais` tem RLS `ENABLE` + `FORCE` e policy de tenant; um segundo tenant não enxerga a linha do primeiro | Modelo de dados |
| **Integração** | A exportação do titular **não contém** `registrado_por`, e o teste de completude reconhece `EXPORTADA_EM_PARTE` como terceiro estado | Modelo de dados · DA-2 |
| **Integração** | A ACL do Redis permite os cinco prefixos em uso e recusa `CONFIG SET`, `FLUSHALL` e `KEYS` | §6.2 |
| **E2E** | Entrar, achar cliente em atraso, informar motivo e referência, dar baixa, ver o acesso restabelecido e as **duas** linhas no registro | §8.1, §8.5 |

### As asserções de dinheiro — uma por achado

**Esta subseção é a correção do sintoma que o parecer financeiro nomeou.** A v3.1 gastava trinta e uma asserções em `GRANT`, papel, policy e partição, e **uma** linha nas três escritas do contrato comercial: *"Domínio · Adicionar tempo e trocar plano respeitam a máquina de estados da assinatura"* — que não diz o que assertar, roda num nível onde a propriedade não existe sozinha, e cobre uma ação que a v3.2 removeu do épico.

Cada linha abaixo tem o achado que ela fecha e **o nível onde a propriedade existe** — a mesma disciplina que a §1.5 aplicou à trava de tipo.

| Nível | O que prova | Fecha |
|---|---|---|
| **Domínio** (`packages/domain`, sem I/O) | A baixa usa **`pagamento_recuperado`**, e `transicao('em_atraso','pagamento_recuperado') === 'ativa'`. Para os outros quatro estados de origem, a mesma chamada devolve `null` — nenhum estado novo, nenhuma transição nova, e a tabela de `catalogo.ts` continua sendo a única | **F-1** · DP-36 |
| **Domínio** | `transicao('expirada','pagamento_recuperado')` é `null`. O caminho da baixa **não** reativa quem expirou, e a asserção existe para que ninguém acrescente a transição "para facilitar o atendimento" | **F-2** |
| **Domínio** | `fim_efetivo` = `greatest(periodo_fim, coalesce(cortesia_ate, periodo_fim))`, property-based: **nunca** menor que `periodo_fim`, monótono não-decrescente em `cortesia_ate`, e igual a `periodo_fim` quando a cortesia é nula | **F-12** · §8.4 |
| **Domínio** | Nenhum `number` monetário no módulo do painel: `valor_centavos` é `bigint` do parse à resposta, e a serialização é `.toString()`, como `precoCentavos` já faz (`cobranca.controller.ts:349`). Um `JSON.parse` do corpo da rota com `9007199254740993` centavos volta íntegro | regra 1 |
| **Domínio** | A competência de `2026-09-30T22:00-03:00` é **setembro**, e a de `2026-10-01T00:30-03:00` é **outubro** — o caso que vira o mês quando calculado em UTC nu | **F-5** · `CONTEXT.md:34-39` |
| **Esquema** | `pagamentos_manuais.valor_centavos` é `BIGINT` com `CHECK (> 0)`; `moeda` é `CHAR(3)` com `CHECK (= 'BRL')`; `competencia` é `GENERATED … STORED` e tem a `CHECK` do dia 1. Um `INSERT` com valor zero, negativo ou moeda `USD` é **rejeitado pelo banco** | **F-6**, **F-7** |
| **Esquema** | Nenhum tenant tem `moeda_base <> 'BRL'` (`0001_fundacao.sql:49`). *É o teste que precisa quebrar no dia da segunda moeda, e é por isso que ele existe antes dela* | **F-7** |
| **Esquema** | O enum `meio_de_pagamento` tem **exatamente** `pix`, `transferencia`, `boleto`, `dinheiro`. `cortesia` e `ajuste` não são valores válidos | **F-6** · DP-38 |
| **Esquema** | Existe `UNIQUE (tenant_id, meio, referencia_externa) WHERE deleted_at IS NULL`, e `referencia_externa` é `NOT NULL` | **F-3** |
| **Esquema** | `mavia_app` tem `SELECT` **exatamente** nas nove colunas de `pagamentos_manuais` da §8.2 d, e **não** tem em `registrado_por`. `information_schema.column_privileges`, nominal | **F-4** |
| **Esquema** | `estado`, `graca_ate`, `cortesia_ate` e `origem_da_ultima_escrita` estão no `GRANT` de `mavia_admin_contrato` e **em nenhum outro papel do painel**; `mavia_admin_escrita` **não tem `UPDATE` em `assinaturas` nem `INSERT` em `pagamentos_manuais`** | **F-2** · §1.2 |
| **Esquema** | **`periodo_fim` e `periodo_inicio` não aparecem em `GRANT` de nenhum papel do painel** — nem por coluna, nem por tabela | **F-12**, **F-13**, e o acerto registrado em §8.7 |
| **Esquema** | Nenhuma das oito funções de `admin` contém `UPDATE … SET plano` ou `SET intervalo` no corpo (`pg_get_functiondef`) | **F-8** a **F-11** · DP-40 |
| **Esquema** | `assinaturas` tem o gatilho `BEFORE UPDATE` de `atualizado_em`, e ele dispara **também** para o webhook: um `UPDATE` que não mencione a coluna a atualiza mesmo assim | **F-16** |
| **Integração** (Postgres real) | **Dar baixa num cliente `em_atraso` deixa `estado = 'ativa'` e `graca_ate IS NULL`, na mesma transação do `INSERT`.** É o cenário do parecer, ponta a ponta: o cliente que pagou não expira no 15º dia | **F-1** |
| **Integração** | Um `UPDATE assinaturas SET estado = 'ativa', graca_ate = <ts>` é **rejeitado pelo banco** pela `CHECK graca_so_em_atraso` (`0025_assinatura.sql:48-49`), e não por `if` na aplicação | **F-1** |
| **Integração** | `mavia_admin_escrita` leva `permission denied` em `UPDATE assinaturas` e em `INSERT INTO pagamentos_manuais` — as duas escritas só existem por dentro das funções | **F-2** |
| **Integração** | `admin.registrar_pagamento` chamada com `p_de` diferente do estado corrente levanta `TRANSICAO_OBSOLETA` e **não grava o pagamento**. Simulado com um webhook que muda o estado entre a leitura e a chamada | **F-1** · §8.1 |
| **Integração** | Chamada com `p_para` que não seja `'ativa'`, ou com `p_de` que não seja `'em_atraso'`, a função **levanta erro**. `expirada → ativa` não é produzível por esta função por nenhum caminho | **F-2** |
| **Integração** | A segunda baixa com a mesma `referencia_externa` levanta `23505`, a rota devolve `409`, e a **contagem de linhas não muda**. *É o cenário dos dois operadores, e o teste roda as duas chamadas em conexões distintas* | **F-3** |
| **Integração** | Baixa semelhante — mesmo valor, mesma competência, referência nova — devolve `409` com o `id` da existente; reenviada com `confirmado_semelhante = true`, grava, **e a confirmação aparece na linha de auditoria** | **F-3** |
| **Integração** | `GET /v1/admin/clientes/:tenantId/pagamentos` devolve as baixas anteriores **sem `registrado_por`**, passa por `admin.abrir_espaco` e deixa a sua linha de auditoria como qualquer outra leitura | **F-3**, **F-4** |
| **Integração** | A exportação do titular (`mavia_app`) **lê `pagamentos_manuais` e devolve as linhas**, com as nove colunas e sem `registrado_por`. *É o teste que a v3.1 não teria passado: não havia `GRANT`, e a exportação levantaria `permission denied` na tabela que ela promete exportar* | **F-4** · S3-3 |
| **Integração** | Baixa registrada às 22h de 30/09 em São Paulo tem `competencia = 2026-09-01`, e a de 00h30 de 01/10 tem `2026-10-01`. Rodado com a sessão em `UTC` **e** em `America/Sao_Paulo`, com o mesmo resultado nas duas | **F-5** |
| **Integração** | `recebido_em` no futuro é recusado pela função com `RECEBIMENTO_NO_FUTURO`. *E o teste de esquema irmão prova por que não é `CHECK`: a constraint com `now()` não é criável* | **F-5** |
| **Integração** | Um pagamento anual de `99000` gera **uma** linha em **uma** competência. Nenhuma divisão acontece: o teste percorre o SQL emitido e falha se encontrar `/` ou `div` no caminho da baixa | **F-5** · DP-37 · `spec-planos:308-310` |
| **Integração** | `pagamentosRecebidos` é o **único** ponto que agrega a tabela: um teste percorre o repositório e falha se `pagamentos_manuais` aparecer sob `sum(`, `count(` ou `avg(` fora dela; e uma linha com `deleted_at` preenchido **não entra** no total e **entra** na listagem | **F-6** · regra 12b |
| **Integração** | Prorrogar o teste escreve `cortesia_ate` e **não altera `periodo_fim`**, comparado antes e depois. A segunda prorrogação do mesmo Tenant é recusada, e mais de 7 dias também | **F-13** |
| **Integração** | Conceder cortesia num tenant `expirada` é recusado; em `ativa`, escreve `cortesia_ate` e não toca `periodo_fim`; acima de 30 dias por chamada ou 60 acumulados, recusado | **F-12**, **F-13** |
| **Integração** | **O webhook não apaga a cortesia:** conceder 60 dias, entregar um `invoice.payment_succeeded` com `current_period_end` anterior, e `cortesia_ate` continua intacto — `aplicar_estado_da_assinatura` escreve `periodo_fim`, e `fim_efetivo` continua o maior dos dois | **F-12** |
| **Integração** | `admin.cadastrar_cliente` deixa o espaço em `teste` com as cotas do Família (`catalogo.ts:94`), **e não força nenhum estado**. A resposta da rota carrega o texto que a tela mostra ao operador | **F-13**, o adjacente |
| **Integração** | `admin.cadastrar_cliente` **recusa o 4º espaço do dia** e o 11º ativo do mesmo titular, com as mesmas exceções de `auth.criar_tenant` (`0004_cadastro.sql:302-303`). *O painel não é bypass do teto A-18/DP-26* | §8.4, amarra 2 |
| **Integração** | As quatro funções de contrato rodam **na primeira execução** contra o esquema recém-migrado, pelo pool de escrita — sem `permission denied` de esquema, de tabela, de `concessoes_de_admin` ou de `auditoria`. *É o teste de S3-3 aplicado à família nova* | §1.2, §8.0 |
| **Integração** | **Toda escrita de contrato deixa duas linhas de `auditoria` com a mesma `correlacao`**: a de intenção sem `de`/`para`, e a de efeito com os dois preenchidos e iguais ao antes e depois lidos na tabela. Uma escrita que falha deixa **zero** | **F-14** |
| **Integração** | O `de` da linha de efeito vem do `SELECT … FOR UPDATE`, e não do que a rota mandou: um teste passa um `de` mentiroso no corpo e a linha registrada continua sendo o valor real da tabela | **F-14** |
| **Integração** | Duas escritas simultâneas no mesmo cliente serializam pelo `FOR UPDATE`: a segunda enxerga o estado que a primeira deixou, e as quatro linhas de auditoria saem na ordem | **F-14** · §8.0 |
| **Integração** | Toda escrita de contrato deixa `origem_da_ultima_escrita = 'painel'`, e o webhook deixa `'stripe'`. *Sem isso, o job de reconciliação do épico 11 trata cada atendimento como incidente* | **F-15** |
| **Integração** | Chamar qualquer das quatro funções de contrato **sem** `admin.abrir_espaco_para_escrita` levanta erro — e não afeta zero linhas em silêncio; chamá-la com `p_alvo` diferente do `app.tenant_id` aberto levanta erro também | §1.6, §8.0 |
| **Integração** | `mavia_admin_contrato` leva `permission denied` em `SELECT` de `lancamentos`, `contas`, `faturas`, `transferencias` e `saldo_snapshots` | §8.7 |
| **Integração** | **Nenhuma escrita do painel cria `Lancamento`:** contagem de `lancamentos`, `transferencias`, `contas`, `faturas` e `saldo_snapshots` idêntica antes e depois de uma baixa, de uma cortesia e de um cadastro | §8.7 · regras 4, 5, 6, 12 |
| **E2E** | Entrar, achar cliente, informar motivo e referência, **ver as baixas anteriores**, conceder cortesia, ver as duas linhas no registro. *A v3.1 tinha aqui "mudar plano", que a DP-40 tirou do épico* | §9 |
| **E2E** | Requisição a `/admin` de origem fora da allowlist é recusada **antes** da aplicação | §6.1 · o bloqueante |

---

## Gate de risco

Conforme `docs/agents/issue-tracker.md`: *"um spec sem esta seção completa não avança para `/to-tickets`"*.

- **especialista-seguranca-appsec: aprovado com condições** — três passadas. A v1 e a v2 foram reprovadas; sobre a v3 o veredito foi *"os cinco bloqueantes de arquitetura estão fechados"*, com 9 de 9 achados anteriores resolvidos. As condições de ticket **C-1 a C-5** foram fechadas na v3.1. **C-6 a C-10 bloqueiam o deploy** e estão em *Condições de deploy*.
- **especialista-lgpd-compliance: objeções** — quatro dela mesma (O-1, O-3, O-4, O-9) fechadas em `retencao-e-eliminacao.md` em 2026-09-04. Resta **O-2**, fechada nesta v3.2 pelo bloco de aviso da §3.2: `retencao_execucoes` e `eliminacoes_journal` não existem, e a primeira migration do épico não roda sem elas. Bloqueiam o deploy: **O-5** (art. 18 I e II), **O-6** (política e encarregado), **O-7** (registro do acesso por `psql`), **O-8** (duas concessões ativas + DP-34, como C-11), **O-9** executado como R-31. ROPA e RIPD não bloqueiam: 15 dias após o deploy.
- **validador-financeiro: objeções** — primeira passada, e a mais dura das três: *"Este é um dos melhores specs de banco de dados que já li neste repositório. A parte de dinheiro dele não existe."* Dezesseis achados. **F-1 a F-14 fechados nesta v3.2**; **F-15 bloqueia o deploy** (C-11) e depende de **DP-39**, a única das cinco decisões novas sem padrão vigente. F-8 a F-11 foram fechados **retirando a troca de plano do escopo** — ver abaixo.

### Por que a troca de plano saiu do épico

O desenho mandava a ação do painel chamar *"o mesmo caminho de aplicação que a rota do cliente usa"*. Ao procurá-lo para reusar, ele **não existia** — e o que se encontrou no lugar foi um defeito vivo em produção, registrado como **P-17**: `cobranca.controller.ts:127-131` responde `fim_do_periodo` ao cliente e **não persiste nada**. Não há tabela de troca agendada em migration nenhuma, não há job, e `assinaturas` não tem preço contratado persistido (F-9).

Implementar a ação aqui significaria construir três peças do épico 11 dentro do épico do painel. Ficam registradas como pré-requisito, e o painel entrega o resto.

**É o valor de um gate que exige abrir o arquivo em vez de acreditar no comentário.** Nenhum dos três revisores anteriores tinha olhado o dinheiro; o comentário do código descreve corretamente a regra que ele não cumpre.

### O caminho até aqui

| Passada | Documento | Veredito |
|---|---|---|
| 1ª · appsec | v1 | **Reprovado.** A alegação central era falsa: citava uma regra de lint inexistente. A `matriz-de-acesso.md` R-3 a afirmava desde sempre, e foi corrigida em 2026-09-04 |
| 2ª · appsec | v2 | **Reprovado.** *"Travas de banco de dados sobre uma topologia de conexão que não as suporta."* Medido: `SET LOCAL ROLE leitor; RESET ROLE; UPDATE` commita |
| 3ª · appsec | v3 → v3.1 | **Aprovado com condições.** 9/9 fechados; 5 de ticket fechadas, 5 de deploy abertas por desenho |
| 1ª · LGPD | v3.1 | **Objeções**, quatro delas contra o próprio texto anterior da revisora |
| 1ª · financeiro | v3.1 → v3.2 | **Objeções.** 16 achados, 14 fechados, 1 de deploy, 1 fora de escopo |

---

## O que este épico deliberadamente não faz

- **MFA.** A única mudança que altera a natureza do risco. O marco é **padrão vigente, não decisão tomada**: DP-32 (`decisoes-do-produto.md:136`, seção *"Em aberto — esperando o dono"*) propõe *antes do primeiro cliente pagante*, e o dono ainda não respondeu. Enquanto o padrão valer, o painel não vai a produção com cliente real — e é dele que a §4.1 empresta o fechamento do degrau de "operar com um administrador só".
- **O job de retenção da auditoria.** Prazo é dívida datável; o **desenho dos grants não é**, e sai daqui (§3.2).
- **Log fora da máquina.** É o único controle que vale contra quem tem o servidor. Não está neste escopo, e a §3.1.2 diz exatamente o que isso deixa aberto.
- **Nível intermediário de acesso.** Toda hipótese custa o mesmo acesso, que é o mais amplo possível. A necessidade é defensável **por hipótese**, não **por linha** — limite registrado na ADR 0024 (Consequências) e em `retencao-e-eliminacao.md:547`.
- **Atendimento dentro do produto.** DP-25 continua: não existe canal humano de recuperação. **Requisição de titular não é atendimento** — é obrigação com prazo, e tem procedimento (§LGPD 7).
- **Editar o razão do cliente.**
- **Trocar plano ou intervalo de um cliente.** DP-40, §8.3. Sai do épico por dois pré-requisitos que são do **épico 11**: o preço contratado persistido em `assinaturas` (`spec-planos:448`, `:460`) e o agendamento de downgrade que `spec-planos:414` promete e que `cobranca.controller.ts:127-131` hoje devolve sem persistir. Enquanto isso, o operador orienta o cliente a trocar pela própria tela — que é onde a regra já está implementada.
- **Calcular ou executar reembolso.** A fórmula é do épico 11 (`spec-planos:305`), e ela lê um `valor_pago` que **não existe persistido**: a tabela `cobrancas` não foi criada por migration nenhuma. Quem pagou por Pix tem `valor_pago` zero, e `max(0, 0 − …)` é **zero** — reembolso nulo sobre R$ 990,00 recebidos. Este épico fecha a metade que lhe cabe: a tela da baixa **diz ao operador**, no ato, que aquele pagamento não entra em cálculo automático de reembolso (§9). A outra metade — declarar por escrito se pagamento fora da Stripe é reembolsável, e persistir `valor_pago` — é do épico 11 e está registrada em **F-10**.
- **O job que expira assinatura.** Não existe nenhum: `prazo_de_teste_acabou`, `graca_acabou` e `periodo_terminou` vivem só em `catalogo.ts` e no teste dele. Enquanto isso, `cortesia_ate` e `graca_ate` são campos que descrevem o futuro e não o produzem — e o **normativo** da §8.4, de que o job leia `fim_efetivo` e nunca `periodo_fim` cru, existe para que a cortesia não evapore no dia em que ele nascer.
- **Aviso ao titular** (DA-2) — agora sabendo que é filtro, e não omissão.
