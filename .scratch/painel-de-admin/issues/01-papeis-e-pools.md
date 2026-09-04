Status: claimed

# 01 · Os quatro papéis, as três pools e os quatro contextos

## Objetivo

Depois deste ticket a API tem três conexões de banco com identidades distintas, quatro papéis de Postgres cujos privilégios são a fronteira do painel, e quatro tipos de contexto que não se substituem em compilação. Nenhuma rota nova existe: o que passa a ser possível é que o **próximo** ticket não consiga escrever no razão de um cliente nem por engano.

## A seção do spec que governa

- **§1.1** — três pools, não dois. Decide que a separação leitura/escrita é por **autenticação** e não por instrução, e mede por que: `BEGIN; SET LOCAL ROLE leitor; RESET ROLE; UPDATE t SET v=99;` devolve `UPDATE 1` e commita.
- **§1.2** — quatro papéis, com `GRANT` e `POLICY` em colunas separadas, mais as seis não-relações. Decide que `mavia_admin_contrato` existe porque o privilégio de escrever contrato tem de morar no **dono** das funções, não no papel que a rota usa.
- **§1.3** — `GRANT` por coluna, `CAMPOS_VETADOS` com **nove** colunas, e a decisão escrita de deixar `ip_hash`/`user_agent_hash` fora sem emendar a R-5.
- **§1.4** — `comAdmin`, `comTenantDeAdmin`, `comTenantDeAdminEscrita`, e o `SET LOCAL ROLE` redundante como **normativo**.
- **§1.5** — os quatro *branded types*, e por que o teste deles é de compilação.
- **Condições de deploy · C-9** — `NOLOGIN` primeiro, credencial por provisionamento, `statement_timeout` nos quatro.

ADR 0024 · D3 e D5. A ADR fala em **três** papéis e **dois** pools; o spec v3.2 a executa com quatro e três, e a diferença está justificada em §1.1 e §1.2. Não é re-litígio: é a mesma decisão com a topologia corrigida.

## O que entra, e onde

**Migration `0029_papeis_do_painel.sql`** (a primeira do épico; a numeração segue a ordem de execução do `README.md` deste diretório — o número real é o próximo livre no momento do merge).

1. `CREATE ROLE` dos quatro, **todos `NOLOGIN`**, `NOBYPASSRLS`, `NOINHERIT` nos dois que vão ganhar `LOGIN` por provisionamento (`mavia_admin`, `mavia_admin_escrita`). Senha **nunca** aqui — migration é forward-only e vive no repositório.
2. `CREATE SCHEMA admin`, dono `mavia_migrate`.
3. `GRANT USAGE ON SCHEMA public, admin` aos quatro, **nominalmente**.
4. `GRANT SELECT` nominal **por coluna** a `mavia_admin` nas tabelas do razão e do cadastro, com os nove `CAMPOS_VETADOS` fora.
5. `GRANT SELECT` nominal por coluna a `mavia_admin_definer` em `tenants`, `usuarios`, `tenant_usuarios` e `assinaturas` — a projeção fixa da listagem, e nada além.
6. `GRANT SELECT, UPDATE (plano, intervalo, estado, graca_ate, atualizado_em) ON assinaturas TO mavia_admin_contrato`. **`periodo_fim` e `periodo_inicio` não entram** (§8.3, §8.4, §8.7). `cortesia_ate` e `origem_da_ultima_escrita` ainda não existem — entram no ticket 08, na migration que cria as colunas.
7. `GRANT INSERT, SELECT ON tenant_usuarios` e `GRANT INSERT ON tenants` a `mavia_admin_contrato` (para `admin.cadastrar_cliente`, ticket 09).
8. `ALTER ROLE … SET statement_timeout` nos quatro: **5 s** para `mavia_admin` e `mavia_admin_escrita`, pelo precedente de `0001_fundacao.sql:149` (`mavia_app`, `'5s'`); os dois `NOLOGIN` recebem o seu por simetria.

**Código:**

- `apps/api/src/main.ts` — dois `Pool` novos, com `DATABASE_URL_PAINEL` e `DATABASE_URL_PAINEL_ESCRITA` do ambiente, passados a `criarAplicacao` (hoje `main.ts:29-33` e `:50-57`).
- `apps/api/src/tenancy/tenancy.ts` — `ContextoDeOperador`, `ContextoDeAdmin`, `ContextoDeAdminEscrita` como *branded types*; `ContextoDoTenant` (hoje `tenancy.ts:16-19`) passa a ser *branded* também; `comAdmin`, `comTenantDeAdmin`, `comTenantDeAdminEscrita`.
- `apps/api/src/autorizacao/campos-vetados.ts` — a constante `CAMPOS_VETADOS`, **uma só**, com dois consumidores obrigatórios (o teste de esquema e a varredura do OpenAPI da `AB-07`).
- `apps/api/test/tipos-do-painel.tsx.ts` (ou equivalente dentro do `include` do `tsconfig`) — os `@ts-expect-error` de compilação.

**`comAdmin(poolDoPainel, { usuarioId }, trabalho)`** define **só** `app.usuario_id`, e define `app.tenant_id` como `''` **explicitamente** — uma conexão de pool reaproveitada carrega o valor da requisição anterior (§1.4, §7). `emTransacao` (`tenancy.ts:37-59`) passa a liberar com `cliente.release(erro)` no caminho de erro, destruindo em vez de reaproveitar a conexão que falhou em desfazer — hoje o `finally` de `tenancy.ts:57` a devolve ao pool em qualquer caso (§7).

## Critérios de aceite

**Compilação** (`pnpm typecheck`, que é `tsc --noEmit`)

1. `comTenant(pool, { usuarioId: 'a', tenantId: 'b' }, fn)` **não compila**. Um `@ts-expect-error` cobre a linha e o typecheck falha se o erro deixar de ocorrer.
2. Cada par trocado dos quatro contextos de §1.5 tem o seu `@ts-expect-error`, **incluindo** `ContextoDeAdmin` × `ContextoDeAdminEscrita` — é o par que impede o caminho de leitura de habilitar uma escrita.

**Esquema** (Postgres real, contra o banco recém-migrado)

3. `has_schema_privilege(<papel>, 'public', 'USAGE')` e `has_schema_privilege(<papel>, 'admin', 'USAGE')` são verdadeiros para os quatro. *Este teste existe porque um `GRANT` sem dono não falha.*
4. `information_schema.column_privileges` mostra que `mavia_admin` tem `SELECT` **exatamente** nas colunas da lista fechada da migration. Uma coluna nova em tabela alcançada pelo painel **falha o teste** até ser classificada.
5. Nenhum dos **nove** nomes de `CAMPOS_VETADOS` — `usuarios.senha_hash`, `sessoes.refresh_hash`, `usuarios.mfa_segredo_cifrado`, `conexoes.credenciais_cifradas`, `conexoes.dek_cifrada`, `lancamentos_brutos.payload`, `dados_fiscais.documento`, `*.ip_hash`, `*.user_agent_hash` — aparece em `GRANT` de nenhum dos quatro papéis. A lista lida pelo teste é **a mesma constante** que a varredura do OpenAPI (`AB-07`, `matriz-de-acesso.md` R-5) lê.
6. `mavia_admin_definer` tem `SELECT` nominal nas quatro tabelas da projeção e **não** tem `UPDATE`, `DELETE` nem `EXECUTE` sobre tabela do razão. *(As linhas de `concessoes_de_admin` e `auditoria` desta mesma asserção estão nos tickets 04 e 03, porque os `GRANT` nascem na migration que cria a tabela.)*
7. `pg_auth_members`, as seis não-relações, cada uma sua asserção: `mavia_app` não é membro dos quatro; nenhum dos quatro é membro de `mavia_app`; `mavia_admin` não é membro de `mavia_admin_escrita`; **`mavia_admin_contrato` não tem membro nenhum e não é membro de ninguém**; nenhum tem `rolbypassrls`.
8. `pg_roles.rolcanlogin = false` para `mavia_admin_definer` e `mavia_admin_contrato`. *(Os dois com `LOGIN` nascem `NOLOGIN` aqui e recebem `LOGIN` + senha no provisionamento — C-9.)*
9. `pg_roles.rolconfig` dos quatro contém `statement_timeout`.
10. **`periodo_fim` e `periodo_inicio` não aparecem em `GRANT` de nenhum papel do painel** — nem por coluna, nem por tabela.
11. `mavia_admin_escrita` **não tem** `UPDATE` em `assinaturas`.

**Integração** (Postgres real)

12. Na conexão do painel, `BEGIN; SET LOCAL ROLE mavia_admin; RESET ROLE; UPDATE lancamentos SET …` leva `permission denied`. *É o teste que a v2 não teria passado.*
13. `mavia_admin` leva `permission denied` em `UPDATE`, `INSERT` e `DELETE` de `lancamentos`, `contas`, `faturas`, `transferencias` e `saldo_snapshots`.
14. `mavia_admin_contrato` leva `permission denied` em `SELECT` das mesmas cinco tabelas.
15. Passar o pool **do cliente** a `comTenantDeAdmin` leva `permission denied to set role`; passar um pool **do painel** a `comTenant` leva o mesmo; e passar o pool **de leitura** a `comTenantDeAdminEscrita` leva o mesmo — nos três casos **antes** de qualquer `set_config` e antes de qualquer leitura.
16. `comTenantDeAdmin`, `comAdmin` e `comTenantDeAdminEscrita` emitem `SET LOCAL ROLE` como **primeira** instrução da transação, verificado por espionagem das consultas emitidas. Remover a instrução redundante quebra este teste — ele vem em par com o 15 exatamente por isso.

## Armadilhas conhecidas

- **O `GRANT` que mente (`bootstrap-papeis.sql:36-44`).** Um `GRANT` executado por quem não é dono nem tem `grant option` **não falha**: devolve `GRANT` com `WARNING: no privileges were granted`, a transação segue e a migration reporta sucesso com o privilégio inexistente. **Todo `GRANT` desta migration roda como `mavia_migrate`**, que é dono do esquema `public` (`bootstrap-papeis.sql:45`). E **nenhum privilégio é dado como concedido porque a migration passou** — quem transforma a omissão em falha visível são os critérios 3 a 11, que leem `information_schema` e `has_schema_privilege`.
- **`USAGE` de esquema, esquecido na v3 em todos os papéis (S3-3).** `bootstrap-papeis.sql:51` faz `REVOKE ALL ON SCHEMA public FROM PUBLIC` de propósito, e `0001_fundacao.sql:140` concede `USAGE ON SCHEMA public` nominalmente a `mavia_app, mavia_jobs` e a mais ninguém. Sem o `USAGE`, todo `SELECT` dos papéis novos devolve `permission denied for schema public` — e, pelo modo de falha acima, um `GRANT` de tabela escrito sem o `USAGE` de esquema *ainda assim* deixa a migration verde.
- **Dois pools não rodam (§1.1).** Num pool autenticado como `mavia_admin`, o `SET LOCAL ROLE mavia_admin_escrita` de `comTenantDeAdminEscrita` levanta `permission denied to set role`, porque `mavia_admin` **não é membro de** `mavia_admin_escrita`. A correção que um implementador apressado escolhe — tornar um membro do outro — apaga a separação inteira. São três pools.
- **O `SET LOCAL ROLE` redundante é o controle (S3-10).** Numa conexão já autenticada como `mavia_admin`, `SET LOCAL ROLE mavia_admin` parece ruído e é o que faz o pool errado morrer na primeira instrução. **Removê-lo é defeito, não simplificação**, e o comentário na linha diz isso.
- **A lista errada de campos vetados (S3-6).** São **nove** colunas, não sete: a R-5 (`matriz-de-acesso.md:66-72`) enumera sete itens contando `ip_hash`/`user_agent_hash` como um, e a §3.17 acrescenta `dados_fiscais.documento`. Um teste escrito contra a lista errada **passa** com `auditoria.ip_hash` concedido ao painel.
- **Um papel novo não herda policy escrita `TO mavia_app`** — inclusive a `RESTRICTIVE usuario_escreve_so_a_propria_linha` (`0002_identidade.sql:173-176`). Ele nasce sem nenhum grant de escrita, e não com escrita "controlada por policy".
- **`as unknown as ContextoDoTenant` compila** e passa nas quatro regras de `eslint.config.js`. A trava de tipo **não é** controle de runtime (§1.5) — quem impede o vazamento é a topologia. O que ela compra é que o caminho errado precise de uma linha que ninguém escreve por acidente. Por isso o teste dela é de compilação; classificá-lo como integração foi o erro da v2.

## Decisões pendentes que este ticket toca

Nenhuma. **C-9** é condição de deploy e não de ticket: o `NOLOGIN` + `statement_timeout` entram aqui; a credencial dos dois papéis `LOGIN` é entregue por provisionamento (o precedente é `bootstrap-papeis.sql`), e o `sre-devops-vps` a executa antes do deploy.

## O que este ticket não faz

- Nenhuma rota, nenhum controlador, nenhuma entrada em matriz.
- Nenhuma função no esquema `admin` — o esquema nasce vazio (ticket 05).
- Nenhum `GRANT` sobre `auditoria` (ticket 03), `concessoes_de_admin` (04) ou `pagamentos_manuais` (07): esses nascem na migration que cria cada tabela, porque migration é forward-only.
- Não liga o `APP_GUARD` (ticket 02).


## Comments

**2026-09-04 · a migration e as asserções de esquema, entregues**

`0029_papeis_do_painel.sql` mais `apps/api/test/papeis-do-painel.test.ts` (16 asserções, verdes) e `apps/api/src/autorizacao/campos-vetados.ts`. Falta a metade de código: as três pools em `main.ts`, os *branded types* e os quatro contextos em `tenancy.ts`, e os `@ts-expect-error` de compilação.

**Três coisas que o ticket previa errado, e o que foi feito no lugar.** Nenhuma muda o desenho; as três foram descobertas rodando o teste.

1. **O critério 10 está errado.** Ele diz que `periodo_fim` e `periodo_inicio` não aparecem em `GRANT` nenhum, *"nem por coluna, nem por tabela"*. Mas a tela de perfil precisa **mostrar** quando o plano acaba, e "ver o perfil de um cliente" é a segunda linha da §8. A proibição que o spec sustenta é de **escrita** — F-12 é sobre o webhook sobrescrever, F-10 é sobre reescrever a base do reembolso. A asserção implementada exclui `SELECT` e mantém o veto sobre `INSERT`/`UPDATE`.

2. **`has_table_privilege` não enxerga concessão por coluna.** Ela devolve `false` onde `has_any_column_privilege` devolve `true`, para a mesma tabela e o mesmo papel — verificado no banco. Como **toda** a nossa concessão é por coluna, um teste escrito com a primeira função afirmaria o oposto do que quer. E `DELETE` não tem granularidade de coluna: a checagem dele continua sendo de tabela, ou o Postgres recusa com *"unrecognized privilege type"*.

3. **`mavia_migrate` vira membro automático dos quatro.** No Postgres 16 em diante, um papel com `CREATEROLE` recebe filiação com `ADMIN OPTION` sobre todo papel que cria — não há como criar sem essa aresta. É aceitável (ele já tem `BYPASSRLS`, é dono do esquema e não serve requisição), mas foi promovida de aresta invisível a **asserção nomeada**: se um quinto papel aparecer como membro, o teste cai.

**Uma decisão de alcance que o ticket deixava em aberto.** "As tabelas do razão e do cadastro" virou lista fechada de vinte, com três grupos deliberadamente fora e a razão de cada um escrita na migration: credencial e sessão; segredo de provider e dado cru de terceiro; infraestrutura.
