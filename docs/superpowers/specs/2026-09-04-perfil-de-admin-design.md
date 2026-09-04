# Design — Perfil de administrador

- **Data:** 2026-09-04
- **Status:** **v3 — reescrito após a segunda reprovação do gate de risco.** A v1 e a v2 foram reprovadas. Aguarda reabertura do gate.
- **Pré-requisito aceito:** **ADR 0024 — Acesso administrativo entre espaços** (`docs/adr/0024-acesso-administrativo-entre-espacos.md`). Ela é a fonte da verdade de D1 a D6; este documento a executa e não a re-litiga. **Nenhum ticket sai daqui antes de a ADR 0024 estar aceita.**
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

**A matriz de acesso R-3 afirma essa regra de lint desde que foi escrita** (`matriz-de-acesso.md:46`). É um controle de papel, e este épico é quem o descobre.

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
| **DA-2** | O cliente é avisado quando um admin abre o espaço dele? | **Não.** Mantida em 2026-09-04, já sabendo o que segue | **Não é omissão: é código que oculta.** A matriz §3.12 (`matriz-de-acesso.md:363`) dá ao `proprietario` *todas* as atividades do espaço, e as linhas do admin nascem com o `tenant_id` dele. Esconder exige um filtro deliberado, que é mais difícil de defender que a ausência de aviso |
| **DA-3** | Os bloqueantes do gate entram agora ou viram dívida? | **Agora, antes dos tickets** | É o que este documento executa |

**DA-2 continua reversível por configuração**, e a coluna `ator_tipo` (§3) é o que a torna reversível — não uma reescrita.

**DA-1 e DA-2 não se re-litigam neste documento.**

---

## O que restringe o desenho

| Restrição | Onde — verificado | Consequência |
|---|---|---|
| Tenant vem só da sessão; exceção **exige ADR** | `matriz-de-acesso.md:40-49` (R-3) | Exceção nomeada na **ADR 0024, D1** |
| Nenhum `id` de tenant em path de rota | `sistema.md:985` (veto 10) | Emendado pela **ADR 0024, D1**, só sob `/v1/admin/` |
| Nenhuma leitura sem contexto de tenant além das duas exceções de §3.9 | `sistema.md:983` (veto 8) | A listagem é a terceira — **ADR 0024**, emenda ao §3.9 |
| Nenhum papel de requisição tem `BYPASSRLS` | `sistema.md:983`; `bootstrap-papeis.sql:27` (só `mavia_migrate` o tem) | Cross-tenant não se resolve com privilégio. Nenhum dos três papéis novos o tem |
| **Um `Pool` só, como `mavia_app`, com DML completo em toda tabela de negócio** | `main.ts:29-33`; `tenancy.ts:74`; `0006_nucleo.sql:278` | **É o achado que reprovou a v2.** Resolvido por dois pools — ADR 0024, D3 |
| **Não existe guard global.** A autorização é aplicada por decorador, controlador a controlador | `app.module.ts:71-85` registra só `APP_INTERCEPTOR`; dos **22 controladores** registrados (`app.module.ts:47-70`), **17** carregam `@UseGuards(AutorizacaoGuard)` | Rota nova sem decorador é rota aberta. §5 |
| `mavia_auth` já lê `usuarios`, `tenants`, `tenant_usuarios`, `sessoes` e `assinaturas` cross-tenant | `0004_cadastro.sql:52`, `:57`, `:60`, `:63`; `0025_assinatura.sql:163` | O dono da `SECURITY DEFINER` da listagem **não pode** ser `mavia_auth` — ADR 0024, D4 |
| `auditoria` especificada, nunca construída | `retencao-e-eliminacao.md` §3, §4, §8; não há `CREATE TABLE auditoria` em nenhuma migration | O log é ela, e ele é **a construir** |
| Não existe MFA | colunas em `0002_identidade.sql:19-22` e `:108`, nenhuma rota as usa | O admin fica a uma senha da base. §6 |
| Redis de produção: `requirepass` **corrigido no repositório, deploy pendente** | `infra/producao/docker-compose.yml:83-88` e `:111` | Até o deploy rodar, quem alcança a rede `dados` **é** o admin. O de desenvolvimento segue sem senha por decisão registrada (`infra/docker-compose.yml:43`) |

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

**A decisão:** o painel abre um **segundo `Pool`**, autenticado *diretamente* como papel próprio, com credencial própria no ambiente. O processo passa a construir dois: o de sempre (`main.ts:29-33`) e o do painel, e `criarAplicacao` (`main.ts:50-57`) recebe os dois.

Uma conexão a mais no Postgres. Irrelevante no volume atual, e explícito no dimensionamento.

#### 1.2 · Três papéis, os `GRANT` nominais e as não-relações (ADR 0024 · D3, D5)

| Papel | Atributos | Privilégio | Existe para |
|---|---|---|---|
| `mavia_admin` | `LOGIN NOINHERIT NOBYPASSRLS` | `SELECT` **por coluna** (§1.3) nas tabelas do razão e do cadastro; `INSERT` em `auditoria`; `EXECUTE` em `admin.abrir_espaco` e `admin.listar_clientes` | Ler o espaço do cliente |
| `mavia_admin_escrita` | `LOGIN NOINHERIT NOBYPASSRLS` | `UPDATE (plano, intervalo, estado, periodo_fim, graca_ate)` em `assinaturas`; `INSERT` em `pagamentos_manuais`; `INSERT` em `auditoria`; `EXECUTE` no procedimento de cadastro de cliente | As quatro escritas da §8 |
| `mavia_admin_definer` | `NOLOGIN NOBYPASSRLS` | Dono das funções do esquema `admin`. Nenhum `GRANT` de tabela além das policies estritamente necessárias à projeção fixa da listagem | A listagem (§2) |

**As não-relações importam tanto quanto os privilégios**, e cada uma fecha um caminho. Elas são normativas e cada uma vira asserção:

- `mavia_app` **não** é membro de nenhum dos três — senão o pool do cliente alcança o painel por `SET ROLE`;
- **nenhum dos três é membro de `mavia_app`** — senão `RESET ROLE` devolve o DML completo, que é exatamente o defeito da v2;
- `mavia_admin` **não** é membro de `mavia_admin_escrita` — a conexão que lê não é a conexão que escreve, e a separação é por **autenticação**, não por instrução;
- nenhum dos três tem `BYPASSRLS`, mantendo `sistema.md:983` sem exceção;
- nenhum dos três recebe `mavia_eliminacao` (§3.2).

Com isso, `RESET ROLE` na conexão do painel aterrissa em `mavia_admin`, que não tem escrita em tabela nenhuma. A propriedade *"o admin não edita o razão do cliente"* passa a ser consequência de **quem a conexão é**, e não de qual instrução a rota lembrou de executar.

**Aviso que o ticket carrega:** um papel novo **não herda** policies escritas `TO mavia_app` — inclusive a `RESTRICTIVE usuario_escreve_so_a_propria_linha` (`0002_identidade.sql:173-176`). Ele nasce sem nenhum grant de escrita, e não com escrita "controlada por policy".

#### 1.3 · `GRANT` por coluna, com os sete campos da R-5 fora (ADR 0024 · D5)

`GRANT SELECT` no nível de tabela entregaria à conexão do painel `usuarios.senha_hash`, `usuarios.mfa_segredo_cifrado`, `sessoes.refresh_hash`, `conexoes.credenciais_cifradas`, `conexoes.dek_cifrada`, `lancamentos_brutos.payload` e `dados_fiscais.documento`. A **R-5** (`matriz-de-acesso.md:62-68`) diz que esses sete nunca saem, para papel nenhum.

O envelope encryption do ADR 0018 torna as credenciais cifradas inúteis sem a KEK. `senha_hash` não: é material para quebra offline de toda a base de clientes, a um `SELECT` de distância numa conexão que não tem segundo fator. **A DA-1 autorizou leitura completa dos dados financeiros; não autorizou o hash de senha de todo mundo.**

Os `GRANT` são **nominais por coluna**, e a lista fechada mora na migration. A propriedade que isso compra e que `GRANT` de tabela não compra: **coluna nova não se estende sozinha** — uma migration futura que adicione um campo sensível não o entrega ao painel por omissão. O teste de esquema da seção Testes é quem transforma isso em falha visível.

#### 1.4 · O caminho de admin nunca produz um `Autenticado`, e nunca alcança `comTenant` (ADR 0024 · D2)

**Declaração normativa.** Esta é a decisão que carrega o peso, e ela é topológica em vez de disciplinar.

`AutorizacaoGuard` (`autorizacao.guard.ts:36-48`) exige `req.autenticado` com `{usuarioId, tenantId, papel}`. Se o painel sintetizasse esse objeto com o tenant do cliente, **todos os controladores de cliente passariam a servi-lo** — e todos chamam `comTenant(this.pool, ctx, …)`, que passa `'mavia_app'` fixo (`tenancy.ts:74`), com DML completo sobre `lancamentos`, `contas`, `faturas` e `transferencias` (`0006_nucleo.sql:278`), sem passar por `abrir_espaco` e sem gravar linha nenhuma.

Por isso, e sem exceção:

1. `autenticador.ts` **continua devolvendo `autenticado: null`** para rotas `/v1/admin/*` — é o caminho que a linha 93 já toma para rota sem espaço;
2. o contexto que `abrirEspacoComoAdmin` produz é de um **tipo distinto** (`ContextoDeAdmin`), aceito **só** por `comTenantDeAdmin`;
3. `comTenantDeAdmin` usa o **pool do painel** (§1.1) e nunca `'mavia_app'`;
4. **nenhuma rota `/v1/admin/*` chama `comTenant`, `comUsuario` ou `resolverTenant`.**

**Como as rotas de admin são classificadas sem cair em `ROTAS_SEM_TENANT`.** A ADR 0024 D6 proíbe colar `/admin/*` em `ROTAS_SEM_TENANT`, e com razão: aquela lista é o que dispensa a rota da matriz (`politica-acesso.ts:264`). Mas é ela também que define `exigeTenant` (`aplicacao.ts:86`), e é isso que faz o autenticador parar em `autenticado: null` antes de exigir `X-Mavia-Tenant` (`autenticador.ts:93`). As duas coisas estão amarradas hoje e passam a ser três listas nomeadas:

| Lista | Efeito | Rotas |
|---|---|---|
| `ROTAS_PUBLICAS` (`politica-acesso.ts:203-226`) | dispensa sessão | as nove de credencial e o webhook |
| `ROTAS_SEM_TENANT` (`politica-acesso.ts:176-200`) | exige sessão, dispensa espaço e papel | as 13 rotas de `GET /v1/eu`, sessões, cadastro, senha, Google, convite e webhook |
| **`ROTAS_DE_ADMIN`** — nova | exige sessão, dispensa espaço, **exige concessão de admin ativa** | `/v1/admin/*`, e só elas |

`verificarCoberturaDaMatriz` passa a considerar as três, e ganha uma asserção a mais: **toda rota registrada cujo caminho começa com `/v1/admin/` está em `ROTAS_DE_ADMIN`, e nenhuma rota fora desse prefixo está.** Uma rota de admin declarada como rota de cliente derruba o boot.

**Consequência aceita, e é a maior parte do orçamento do épico:** cada tela do cliente que o operador precisa ver tem **rota própria sob `/v1/admin/`**, com projeção própria, contagem própria e linha de auditoria própria. Não há reuso dos controladores do cliente. A alternativa — um `Autenticado` sintético — grava uma linha na abertura e **nenhuma** nas N leituras seguintes, o que torna falsa a propriedade central do painel.

O orçamento, escrito para não ser descoberto no meio: são **três telas de cliente** no primeiro corte (perfil, contas e saldos, lançamentos do período), e cada uma custa rota, projeção, contagem, teste e linha na matriz. Uma quarta tela é um ticket, não um ajuste.

#### 1.5 · A trava de tipo é de **compilação**, e o teste dela também

`ContextoDoTenant` (`tenancy.ts:16-19`) passa a ser um *branded type* que **só** `resolverTenant` produz; `ContextoDeAdmin` é outro, que **só** `abrirEspacoComoAdmin` produz. `comTenant` deixa de aceitar `{ tenantId: string }` montado à mão.

**O limite, escrito:** um *branded type* é apagado na compilação, e `as unknown as ContextoDoTenant` compila e passa nas quatro regras de `eslint.config.js`. Isto **não é** um controle de runtime, e não é o que impede o vazamento — quem impede é a topologia de §1.1 a §1.4. O que a trava compra é que o caminho errado precise de uma linha que ninguém escreve por acidente.

Por isso o teste dela é **de compilação** (`@ts-expect-error` num arquivo dentro do `include` do `tsconfig`, verificado por `pnpm typecheck`, que é `tsc --noEmit`), e não de integração. Um teste de integração não observa uma propriedade que não existe em runtime — foi assim que a v2 classificou errado.

*A construir.* Verificado que hoje não há trava alguma: `tenancy.ts:64-84`.

#### 1.6 · Uma instrução liga o log ao alvo

`SET LOCAL` não aceita parâmetro, então a v1 implicava interpolar um parâmetro de rota em SQL — e `node-pg` aceita múltiplas instruções numa consulta simples. A linha de auditoria podia dizer cliente A enquanto o `app.tenant_id` virava cliente B.

```sql
admin.abrir_espaco(p_alvo uuid, p_motivo motivo_de_acesso,
                   p_referencia text, p_acao text, p_rota text)
```

Ela faz o `INSERT INTO auditoria` **e** o `set_config('app.tenant_id', p_alvo, true)` com o **mesmo parâmetro vinculado, na mesma instrução**. Divergência entre o que foi auditado e o que foi efetivado deixa de ser expressável.

Fora dessa função, `params` alimentando `set_config('app.tenant_id', …)` é defeito (ADR 0024, D1, condição 2).

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

**O caminho que a v2 não viu.** A convenção do repositório é que toda `SECURITY DEFINER` pertence a `mavia_auth` — oito `ALTER FUNCTION … OWNER TO mavia_auth` em bloco (`0004_cadastro.sql:317-324`), mais `0025_assinatura.sql:156`. E `mavia_auth` já lê cross-tenant, com `USING (true)`, exatamente a projeção que a listagem precisa:

```
usuarios         cadastro_le_usuarios          0004_cadastro.sql:52
tenants          cadastro_le_tenants           0004_cadastro.sql:57
tenant_usuarios  cadastro_le_vinculos          0004_cadastro.sql:60
sessoes          cadastro_le_sessoes           0004_cadastro.sql:63
assinaturas      assinatura_lida_pelo_webhook  0025_assinatura.sql:163
```

Uma função escrita por alguém seguindo a convenção nasce dona de `mavia_auth`, lê a base inteira, não viola uma vírgula de nenhuma proibição escrita, e não grava uma linha. **Aqui, a convenção é o exploit.**

`mavia_migrate` também está fora: ele tem `BYPASSRLS` (`bootstrap-papeis.sql:27`), e a função viraria leitura irrestrita de tudo, contra `sistema.md:983`.

**A v2 corrigida — cinco obrigações, todas verificáveis:**

1. **Dono próprio.** `admin.listar_clientes(p_busca text, p_pagina int)` pertence a `mavia_admin_definer`, `NOLOGIN NOBYPASSRLS`, cujas **únicas** policies são as estritamente necessárias à projeção fixa: espaço, titular, plano, estado, vence em, uso. Nenhum dado financeiro do razão.
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
  motivo, referencia, de, para, ip_hash, user_agent_hash
```

| Coluna nova | Por quê |
|---|---|
| `motivo` + `referencia` | O log respondia "quem leu", não "sob qual hipótese legítima". É o controle mais barato do épico e o único que muda o comportamento no momento do ato. Lista fechada: `chamado \| incidente \| defeito \| ordem_judicial`, com a referência obrigatória (`retencao-e-eliminacao.md:500-509`) |
| `rota` + `registros` | "Abriu o espaço" não responde ao art. 48, que pede a natureza dos dados afetados. A matriz §6 já exige contagem de registros do ator programático |
| `ator_tipo` | Separa titular, membro e operador. É o que permite a projeção de `/atividades`, o que torna a **DA-2 reversível por configuração**, e o que o predicado normativo de `retencao-e-eliminacao.md:576` usa |

**`tenant_id` é nulo** para eventos que não pertencem a espaço nenhum — conceder e revogar admin. A policy padrão os torna invisíveis a todos, o que é o desejado; fica declarado para que não seja acidente.

**De/para em claro para enum, id e dinheiro.** A v1 mandava hashear tudo, citando o §8.2 ao contrário: ele diz *"em claro apenas quando o valor é o objeto da mudança"*, e dar baixa em pagamento é exatamente esse caso. Hash e redação ficam para texto livre e PII. **Já feito:** o §8.2 recebeu os campos de `assinaturas` na linha "estruturais — em claro" (`retencao-e-eliminacao.md:563`).

#### 3.1 · A imutabilidade, com os furos fechados e os limites ditos

`REVOKE UPDATE, DELETE, TRUNCATE ON auditoria FROM mavia_app` não basta, e o spec precisa dizer contra quem cada coisa vale.

| Furo | Fechamento | Contra quem vale |
|---|---|---|
| **O dono ignora `REVOKE`.** As tabelas pertencem a `mavia_migrate`, que tem `BYPASSRLS` (`bootstrap-papeis.sql:27`) e é dono do esquema (`bootstrap-papeis.sql:45`) | Gatilho `BEFORE UPDATE OR DELETE … RAISE EXCEPTION`, que dispara **também para o dono** | Todo **DML**, inclusive o do dono |
| **`TRUNCATE` é privilégio separado** e não está no `REVOKE` | Entra no `REVOKE`, e o gatilho `BEFORE TRUNCATE` o cobre | Idem |
| **Partição nova não é governada pelo `REVOKE` do pai**, e quem a cria vira dono dela | Job mensal idempotente (§3.1.1), que aplica grants e gatilho a cada partição criada | Idem |
| **DDL não dispara gatilho nenhum** | §3.1.2 | Ninguém, dentro do banco |

> **A imutabilidade vale contra `mavia_app`, contra os três papéis do painel e contra o dono, para DML.** Ela **não** vale contra DDL, e **não** vale contra quem tem acesso ao servidor. Imutabilidade real exige o log sair da máquina, e isso não está neste épico.

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

**Sexta trava da §4.3:** papel `mavia_eliminacao`, `NOLOGIN`, com `DELETE ON auditoria` **exclusivamente** por procedimento `SECURITY DEFINER` que aceita apenas `tenant_id` presente em `eliminacoes_journal` com eliminação concluída, e que grava em `retencao_execucoes`. Sem `BYPASSRLS`, sem `SELECT` em tabela de negócio, e o texto da regra 18 intacto para `mavia_app`.

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

**O que ele não cobre, dito:** ele impede *cair* para um, não impede *operar* com um enquanto a segunda concessão nunca foi criada. Esse degrau é fechado por DP-32 (`decisoes-do-produto.md:128`), que já proíbe o painel de ir a produção com cliente real antes do MFA.

**O painel concede admin?** Não. Só o script. Se um dia a tela existir, ela é o `PATCH /membros/:usuarioId` deste épico e merece as quatro travas de R-4 (`matriz-de-acesso.md:53-60`).

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
| `RL-ADMIN-BUSCA` | mais estrita que `RL-AUTH` (`matriz-de-acesso.md:473`) | `GET /v1/admin/clientes` | A busca por nome ou e-mail sobre toda a base é a superfície de enumeração mais barata do produto |
| **`RL-ADMIN-ABERTURA`** | teto por hora **e** por dia, por operador | `POST /v1/admin/clientes/:tenantId/abrir` | **A v2 só limitava a busca.** Um admin comprometido percorre a base inteira **um espaço por vez**, cada abertura com motivo e referência válidos, deixando uma trilha impecável que ninguém lê. Um teto por operador transforma varredura em alarme |

O teto de `RL-ADMIN-ABERTURA` é decisão do dono do produto no ticket; o que este documento fixa é que **a classe existe e é por operador, não por rota**.

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

E o que continua a construir, independente disso: instância ou banco separado para sessões, e **revalidação da sessão no Postgres a cada requisição sob `/admin`** — a linha de `sessoes` que o Redis afirma existir precisa existir, não estar revogada, e pertencer àquele usuário.

#### 6.3 · Detecção — e o destino da notificação é fora do produto

Ler o log **é evento**, e toda abertura de espaço e leitura do registro **notifica os outros operadores**, mais um resumo diário. Nada no desenho da v1 detectava: os itens eram preventivos ou forenses, e um log que ninguém lê descobre o incidente quando o cliente reclama. DA-2 proíbe avisar o cliente; não proíbe avisar o segundo operador.

**O destino é externo ao painel** — decisão **DP-34**, já tomada (`decisoes-do-produto.md:130`): *"uma notificação que só existe dentro do sistema que ela vigia não detecta o comprometimento desse sistema."* Concretamente: e-mail para endereço fora do domínio da aplicação, entregue por caminho que o painel comprometido não silencia. Uma notificação escrita numa tabela do próprio banco, ou num canal que o operador administra, não conta como detecção.

Com a §4.1, o conjunto "os outros operadores" deixa de poder ser vazio.

#### 6.4 · Sessão curta e privilégio por requisição

Resolvido contra `concessoes_de_admin`, **nunca carimbado no token**. *Verificado como sólido pelo gate:* o cofre carrega só `{sessaoId, usuarioId}` (`cofre-de-acesso.ts:37-40`, gravado como JSON em `:59-72`) e não há onde guardar claim de papel.

#### 6.5 · Reautenticação nas escritas

Com o ticket carregando o **`tenant_alvo`** — sem isso, um ticket emitido para "dar baixa" autoriza a mesma escrita em outro cliente dentro da janela. O mecanismo de step-up está especificado em `matriz-de-acesso.md:459`; `exigeReautenticacao()` existe em `politica-acesso.ts:239-241` e **ninguém o consulta**. O lugar é o guard, e este épico o implementa junto com o `APP_GUARD` da §5.

> **O que a reautenticação compra, exatamente:** ela protege contra **sessão** roubada, não contra **senha** roubada — que é o risco que a ausência de MFA declara. Vale a pena e não fecha o buraco. **MFA continua sendo a única mudança que altera a natureza do risco**, e DP-32 já fixou o marco: antes do primeiro cliente pagante (`decisoes-do-produto.md:128`).

### 7 · Endurecimento do §3.9 que este épico exige

O gate não conseguiu construir exploit confiável, mas a carga muda: hoje `app.tenant_id` só assume tenants do próprio usuário; depois do painel, assume **qualquer cliente**.

- `comUsuario` (`tenancy.ts:93-111`) passa a definir `app.tenant_id` como `''` explicitamente — hoje ele nunca o limpa;
- `resolverTenant` (`tenancy.ts:133`) ganha o predicado `AND usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid` (§2);
- `emTransacao` (`tenancy.ts:37-59`) libera com `cliente.release(erro)` no caminho de erro, **destruindo** em vez de reaproveitar a conexão que falhou em desfazer. Hoje o `finally` da linha 57 a devolve ao pool em qualquer caso.

### 8 · O que o admin faz

| Ação | Rota | Pool / papel | Classe no log |
|---|---|---|---|
| Buscar clientes | `GET /v1/admin/clientes` | painel · `mavia_admin` | leitura em massa — uma linha por busca, com termo hasheado e contagem |
| Ver o perfil de um cliente | `GET /v1/admin/clientes/:tenantId` | painel · `mavia_admin` | leitura em massa |
| Abrir o espaço em leitura | `POST /v1/admin/clientes/:tenantId/abrir` + rotas próprias por tela | painel · `mavia_admin` | leitura em massa, com rota e contagem |
| Trocar plano ou intervalo | `PATCH /v1/admin/clientes/:tenantId/assinatura` | painel · `mavia_admin_escrita` | escrita financeira |
| Adicionar tempo (`periodo_fim`) | idem | painel · `mavia_admin_escrita` | escrita financeira |
| Dar baixa em pagamento | `POST /v1/admin/clientes/:tenantId/pagamentos` | painel · `mavia_admin_escrita` | escrita financeira |
| Cadastrar cliente novo | `POST /v1/admin/clientes` | painel · `mavia_admin_escrita` | escrita financeira |
| **Ler o registro** | `GET /v1/admin/registro` | painel · `mavia_admin` | **segurança** — e notifica os outros operadores |

**A frase correta, que a v2 errava.** A v2 fechava esta tabela com *"o admin lê e não edita dado financeiro do cliente"*, quatro linhas depois de classificar quatro ações como **escrita financeira**. `assinaturas` e `pagamentos_manuais` **são** dado financeiro: são o contrato do cliente e o dinheiro que ele pagou.

> **O admin não edita o razão do cliente.** `lancamentos`, `contas`, `faturas`, `transferencias`, `saldo_snapshots`: nenhum `GRANT` de escrita, para nenhum dos três papéis (ADR 0024, D6). O que ele edita é a **relação comercial** — plano, prazo e baixa de pagamento —, e cada uma dessas escritas é ato de operador sobre o contrato, registrada com `de/para` em claro (`retencao-e-eliminacao.md:563-564`).
>
> Corrigir lançamento de cliente é pedido ao cliente, não feito por cima dele. E a propriedade é garantida por **quem a conexão é** (§1.2), não por disciplina de quem escreve a rota — foi essa distância que reprovou a v2.

### 9 · As telas

Hostname próprio (§6.1). Lista de clientes · perfil do cliente · registro, mais as três telas de leitura do espaço do cliente com rota própria (§1.4). Seguem `docs/design.md`, com a auditoria da §5 daquele documento rodada antes da entrega.

O motivo e a referência são pedidos **antes** de abrir o espaço, não depois.

---

## Modelo de dados

```
concessoes_de_admin    id, usuario_id, email_no_ato, concedida_em, concedida_por,
                       revogada_em, revogada_por
auditoria (particion.)  ver §3
pagamentos_manuais     id, tenant_id, registrado_por, registrado_em, valor_centavos,
                       moeda, competencia, meio, observacao, deleted_at
```

`pagamentos_manuais.meio` é enum (`pix | transferencia | boleto | dinheiro | cortesia | ajuste`), com `observacao` livre **opcional** — e a UI diz, ao lado do campo: *"esta observação pode ser lida pelo cliente se ele pedir os dados dele"*. Alinha o comportamento do operador ao que a exportação entrega, e mata a categoria "nota interna sobre o cliente que ninguém previa que sairia". Valor em centavos inteiros com moeda ISO (regra 1).

**RLS e soft delete não são opcionais nesta tabela.** A v2 dizia que ela *"não tem caminho de leitura voltado ao tenant"*, o que é verdade e **é propriedade da aplicação, não do banco**. A regra 16 exige RLS em toda tabela de negócio e a regra 17 exige `deleted_at`; nenhuma das duas admite "não existe rota hoje" como fundamento. Então:

```sql
ALTER TABLE pagamentos_manuais ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagamentos_manuais FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pagamentos_manuais
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

— o mesmo padrão de `0006_nucleo.sql:271-277`, e `deleted_at TIMESTAMPTZ`, com a ressalva da §3.6 de `retencao-e-eliminacao.md`: a linha sobrevive à eliminação do espaço por obrigação legal, então `deleted_at` marca estorno de baixa registrada por engano, nunca eliminação.

**`registrado_por` não sai na exportação do cliente.** Ele é o `usuarios.id` de um funcionário da Mavia. Entregá-lo na exportação do titular contraria a **DA-2 por porta lateral**: o cliente descobriria pelo arquivo o que a decisão do dono determinou não contar. Sai valor, moeda, competência, meio, `registrado_em` e `observacao`; não sai `registrado_por`.

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
| `RESET ROLE` numa rota do painel | Aterrissa em `mavia_admin`, que não escreve em tabela nenhuma (§1.2) |

---

## Testes

Cada correção da v3 tem a asserção que a prova, no nível onde a propriedade existe.

| Nível | O que prova | Fecha |
|---|---|---|
| **Compilação** (`tsc --noEmit`) | `comTenant` **não aceita** `{ usuarioId, tenantId }` montado à mão — `@ts-expect-error` que falha o typecheck se o erro deixar de ocorrer | §1.5 · a trava de tipo, no nível certo |
| **Compilação** | `comTenantDeAdmin` **não aceita** um `ContextoDoTenant`, e `comTenant` não aceita um `ContextoDeAdmin` — as duas direções | §1.4, §1.5 |
| **Esquema** (Postgres real) | `mavia_admin` tem `SELECT` **exatamente** nas colunas da lista fechada. Uma coluna nova em tabela alcançada pelo painel **falha o teste** até ser classificada | §1.3 · a propriedade que o `GRANT` por coluna compra |
| **Esquema** | Nenhum dos sete campos da R-5 está em nenhum `GRANT` de nenhum dos três papéis | §1.3 |
| **Esquema** | `pg_auth_members`: `mavia_app` não é membro dos três; nenhum dos três é membro de `mavia_app`; `mavia_admin` não é membro de `mavia_admin_escrita`; nenhum dos quatro é membro de `mavia_eliminacao`; nenhum tem `rolbypassrls` | §1.2 · as não-relações |
| **Esquema** | O dono de toda função em `admin` é `mavia_admin_definer`, e **nenhuma** é de `mavia_auth` ou `mavia_migrate` | §2 · ADR 0024 D4 |
| **Esquema** | Toda função em `admin` tem `SET search_path` em `proconfig` | §2, obrigação 2 |
| **Integração** (Postgres real) | Na conexão do painel, `BEGIN; SET LOCAL ROLE …; RESET ROLE; UPDATE lancamentos …` leva `permission denied` — **o teste que a v2 não teria passado** | §1.1 |
| **Integração** | `mavia_admin` leva `permission denied` em `UPDATE`, `INSERT` e `DELETE` de `lancamentos`, `contas`, `faturas`, `transferencias` e `saldo_snapshots` | §8 |
| **Integração** | `admin.listar_clientes` chamada por um `app.usuario_id` **sem concessão ativa** devolve **erro**, não zero linhas | §2, obrigação 4 · critério de aceite da ADR 0024 |
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
| **Boot** | Toda rota com prefixo `/v1/admin/` está em `ROTAS_DE_ADMIN`, e nenhuma rota fora do prefixo está | §1.4 |
| **Boot** | `ROTAS_PUBLICAS` tem consumidor: o teste falha se a constante voltar a ser lista morta | §5, item 3 |
| **Integração** | As 13 rotas de `ROTAS_SEM_TENANT` continuam respondendo o que respondiam **depois** de `APP_GUARD` ligado — rota a rota, com o código de status esperado | §5 · o risco registrado |
| **Integração** | `pagamentos_manuais` tem RLS `ENABLE` + `FORCE` e policy de tenant; um segundo tenant não enxerga a linha do primeiro | Modelo de dados |
| **Integração** | A exportação do titular **não contém** `registrado_por`, e o teste de completude reconhece `EXPORTADA_EM_PARTE` como terceiro estado | Modelo de dados · DA-2 |
| **Integração** | A ACL do Redis permite os cinco prefixos em uso e recusa `CONFIG SET`, `FLUSHALL` e `KEYS` | §6.2 |
| **Domínio** | Adicionar tempo e trocar plano respeitam a máquina de estados da assinatura | §8 |
| **E2E** | Entrar, achar cliente, informar motivo e referência, mudar plano, ver a linha no registro | §9 |
| **E2E** | Requisição a `/admin` de origem fora da allowlist é recusada **antes** da aplicação | §6.1 · o bloqueante |

---

## O que este épico deliberadamente não faz

- **MFA.** A única mudança que altera a natureza do risco. DP-32 fixou o marco: antes do primeiro cliente pagante (`decisoes-do-produto.md:128`).
- **O job de retenção da auditoria.** Prazo é dívida datável; o **desenho dos grants não é**, e sai daqui (§3.2).
- **Log fora da máquina.** É o único controle que vale contra quem tem o servidor. Não está neste escopo, e a §3.1.2 diz exatamente o que isso deixa aberto.
- **Nível intermediário de acesso.** Toda hipótese custa o mesmo acesso, que é o mais amplo possível. A necessidade é defensável **por hipótese**, não **por linha** — limite registrado na ADR 0024 (Consequências) e em `retencao-e-eliminacao.md:547`.
- **Atendimento dentro do produto.** DP-25 continua: não existe canal humano de recuperação. **Requisição de titular não é atendimento** — é obrigação com prazo, e tem procedimento (§LGPD 7).
- **Editar o razão do cliente.**
- **Aviso ao titular** (DA-2) — agora sabendo que é filtro, e não omissão.
