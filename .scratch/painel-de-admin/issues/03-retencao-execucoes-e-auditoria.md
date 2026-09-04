Status: resolved
Blocked by: 01

# 03 · `retencao_execucoes`, `auditoria` particionada e a imutabilidade

## Objetivo

Depois deste ticket existe o log em que todo o resto do épico se apoia: uma tabela `auditoria` particionada por mês, imutável para DML inclusive do dono, com a isenção de eliminação escrita na forma mais estreita que o Postgres permite, e um job que mantém 24 meses de pista à frente. Nenhuma leitura de espaço de cliente é possível sem ele — e hoje **ele não existe**.

## A seção do spec que governa

- **§3** — as colunas, e por que `motivo`+`referencia`, `rota`+`registros`, `correlacao` e `ator_tipo` existem. `tenant_id` é nulo para conceder e revogar admin.
- **§3.1** — os quatro furos da imutabilidade e o que cada fechamento vale contra. A frase honesta: vale contra `mavia_app`, os quatro papéis do painel e o dono, **para DML**; não vale contra DDL, e não vale contra quem tem o servidor.
- **§3.1.1** — job mensal idempotente, 24 meses de pista, alarme abaixo de 3, e a `DEFAULT` como **página de incidente** e não rede de segurança.
- **§3.1.2** — o gatilho fecha DML, não DDL; custódia de `mavia_migrate`, `EVENT TRIGGER` de `sql_drop`, e o log fora da máquina como o que falta.
- **§3.2** — o bloco de aviso do achado **O-2**, a isenção de três condições, e o `GRANT SELECT ON retencao_execucoes TO mavia_eliminacao`.
- **§3.3** — a RLS de `auditoria`, escrita: `WITH CHECK (true)` na escrita, `FOR SELECT TO mavia_app` por tenant, e **nenhuma** policy de `SELECT` para `mavia_admin`.

## O que entra, e onde

**Migration `0030_auditoria.sql`.** A ordem dentro do arquivo é normativa: **`retencao_execucoes` antes do gatilho.**

1. `CREATE TABLE retencao_execucoes` — append-only para **todos** os papéis, sem dado pessoal (só classe, contagem, horário e versão da política), conforme `retencao-e-eliminacao.md` §4.3. Sem `tenant_id`, e é por isso que ela não conta no R-08.
2. `CREATE TABLE eliminacoes_journal` — `(tenant_id | usuario_id, tipo, concluido_em)`, nenhum conteúdo, `retencao-e-eliminacao.md` §4.3 e §5.5. Entra aqui porque o caminho da R-08 sai daqui.
3. `CREATE TYPE motivo_de_acesso AS ENUM ('chamado', 'incidente', 'defeito', 'ordem_judicial')` — lista fechada, `retencao-e-eliminacao.md` §8.1.1. `ator_tipo` e `classe` na mesma forma.
4. `CREATE TABLE auditoria (…) PARTITION BY RANGE (ocorrido_em)`, com as colunas de §3, incluindo **`correlacao UUID`** (F-14) e `ip_hash`/`user_agent_hash`.
5. `CREATE ROLE mavia_eliminacao NOLOGIN` — sem `BYPASSRLS`, sem `SELECT` em tabela de negócio. `GRANT DELETE ON auditoria`, `GRANT SELECT, INSERT ON retencao_execucoes`, `GRANT SELECT ON eliminacoes_journal`. Alcançável **só** por `SET ROLE` a partir de `mavia_jobs`, dentro do procedimento `SECURITY DEFINER` que aceita apenas `tenant_id` presente em `eliminacoes_journal` com eliminação concluída.
6. `GRANT INSERT ON auditoria` a `mavia_app`, `mavia_admin`, `mavia_admin_escrita`, `mavia_admin_definer` e `mavia_admin_contrato`. **Cinco papéis, `INSERT` apenas.** `REVOKE UPDATE, DELETE, TRUNCATE` de todos.
7. `auditoria_imutavel()` — `plpgsql`, **sem `SECURITY DEFINER`**, `SET search_path = pg_catalog, public`, com a isenção de três condições simultâneas de §3.2. Gatilhos `BEFORE UPDATE OR DELETE` e `BEFORE TRUNCATE`.
8. `EVENT TRIGGER` de `sql_drop` que registra em `retencao_execucoes` toda remoção de objeto sob `auditoria*`.
9. A partição `DEFAULT`, vazia, mais 24 meses de partições, e a função do job.
10. RLS de §3.3: `ENABLE` + `FORCE`, `auditoria_grava FOR INSERT TO <os cinco> WITH CHECK (true)`, `auditoria_do_tenant FOR SELECT TO mavia_app USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`.

**Código:** o job mensal de partições, na fila que já existe (`apps/api/src/recorrencias/agendador.ts` é o precedente de `Queue`/`Worker`), idempotente, com o alarme abaixo de 3 meses.

## Critérios de aceite

**Esquema** (Postgres real)

1. Os **cinco** papéis que gravam em `auditoria` têm `INSERT`; **nenhum** tem `UPDATE`, `DELETE` ou `TRUNCATE`. *A isenção de `mavia_eliminacao` (`DELETE`) e a de `mavia_retencao` (`UPDATE` de três colunas, §4.3 da política, fora deste épico) são nomeadas no teste como exceções declaradas — o teste enumera os cinco, não "todos os papéis".*
2. `mavia_eliminacao` tem `SELECT ON retencao_execucoes`. Sem ele o gatilho levanta `permission denied` e a R-08 nunca roda.
3. `auditoria` tem RLS `ENABLE` **e** `FORCE`, uma policy `FOR INSERT` com `WITH CHECK (true)` para os cinco papéis que gravam, uma `FOR SELECT TO mavia_app` por `tenant_id`, e **nenhuma** policy `FOR SELECT TO mavia_admin`.
4. `auditoria.ip_hash` e `auditoria.user_agent_hash` **não** estão em `GRANT` de `mavia_admin` — que só tem `INSERT` na tabela. *(A metade "não aparecem na projeção de `GET /v1/admin/registro`" é do ticket 10.)*
5. `mavia_eliminacao` não tem `rolbypassrls` e não tem `SELECT` em nenhuma tabela de negócio.

**Integração** (Postgres real)

6. `mavia_app` leva `permission denied` em `UPDATE`, `DELETE` **e `TRUNCATE`** de `auditoria`.
7. O gatilho barra `UPDATE` e `DELETE` **do dono da tabela**, e numa **partição criada pelo job**, depois do `REVOKE`.
8. `mavia_eliminacao` **sem** o GUC `app.eliminacao_execucao_id` leva `AUDITORIA_IMUTAVEL`; **com** o GUC mas **sem** a linha correspondente em `retencao_execucoes`, leva `AUDITORIA_IMUTAVEL`; só as três condições juntas apagam.
9. `mavia_admin`, `mavia_admin_escrita` e `mavia_app` **não conseguem** `SET ROLE mavia_eliminacao`.
10. As três linhas que o padrão de policy do repositório recusaria são **aceitas**: uma com `tenant_id` **nulo** (conceder admin); uma gravada **sem `app.tenant_id` definido** (a busca da listagem); e um `INSERT … SELECT` com linhas de **vários tenants numa instrução só** (o procedimento de saída da `DEFAULT`).
11. `mavia_app` **não enxerga** as linhas de `tenant_id` nulo, para nenhum valor de `app.tenant_id`.
12. Um valor fora do enum `motivo_de_acesso` **recusa o `INSERT`**.
13. O job de partições é idempotente: duas execuções no mesmo mês não criam nada e não falham; e **toda partição criada nasce com o `REVOKE`, os `GRANT` nominais e o gatilho**.
14. Com uma linha de mês futuro na `DEFAULT`, o `ATTACH` daquela partição **falha**. *O teste documenta a armadilha, para que ninguém a reintroduza como "rede de segurança".*
15. O procedimento de saída da `DEFAULT` roda inteiro **sem uma única instrução `DELETE`** em `auditoria`, e ao fim toda linha está na partição do mês dela.
16. O `EVENT TRIGGER` registra em `retencao_execucoes` um `DROP TABLE` sobre uma partição de `auditoria*`.

## Armadilhas conhecidas

- **`retencao_execucoes` e `eliminacoes_journal` não existem (O-2, o bloco de aviso de §3.2).** Verificado hoje: `grep` por ambos em `apps/` e `packages/`, em `*.sql` e `*.ts`, devolve **zero ocorrências**. O gatilho `auditoria_imutavel()` faz `SELECT 1 FROM retencao_execucoes` — **a primeira migration do épico não roda** se elas não vierem antes. **A correção barata sob pressão — remover a condição do `EXISTS` para a migration subir — é precisamente o escape hatch que a §3.2 existe para fechar. Se a tabela não existir, falhe a migration, não a condição.** `mavia_retencao` também não existe; ele **não** é criado aqui (ver *O que este ticket não faz*).
- **`auditoria` também não existe.** O nome aparece em `0013`, `0022` e `0026`, e não há `CREATE TABLE auditoria` em migration nenhuma. Todo controle do épico que se apoia no log é **a construir**, e é condição, não pressuposto.
- **A partição `DEFAULT` é armadilha, não rede (§3.1.1).** Assim que ela recebe uma linha de mês futuro, o `ATTACH PARTITION` daquele mês **falha** — o Postgres varre a `DEFAULT` e recusa anexar uma partição que capturaria linhas já lá. Sair exigiria `DELETE` na `DEFAULT`, que é exatamente o que o gatilho bloqueia. A rede de segurança tranca a porta por dentro. Ela existe para não perder linha e é **página de incidente**, com dono e runbook, nunca warning.
- **`WITH CHECK (true)` na escrita não é relaxamento (§3.3).** A contenção do que entra em `auditoria` é o `GRANT` nominal (cinco papéis, `INSERT` apenas) somado ao gatilho. Uma policy de escrita por tenant aqui não protegeria nada que esses dois já não protejam e **quebraria as quatro linhas que o épico existe para gravar** — seria uma trava que só acerta o caminho legítimo. Escreva a razão no comentário da policy; sem ela, o próximo revisor "corrige" para o padrão de `0006_nucleo.sql:271-277`.
- **O gatilho fecha DML, não DDL (§3.1.2).** `ALTER TABLE auditoria DETACH PARTITION …; DROP TABLE …;` apaga um mês inteiro e não dispara gatilho nenhum. O `EVENT TRIGGER` **não impede**: deixa rastro. E ele exige superusuário — quem tem superusuário também o remove. Ele eleva o custo, não fecha a porta. Não escreva "imutável" sem o escopo.
- **`auditoria_imutavel()` não pode ser `SECURITY DEFINER` de `mavia_migrate` (§3.2, S3-3 c).** `mavia_migrate` tem `BYPASSRLS` (`bootstrap-papeis.sql:27`), e um gatilho definer dele avaliaria o `EXISTS` sem RLS nenhuma, em toda linha de `auditoria` que qualquer papel tocar. A resposta é o `GRANT SELECT` nominal — a tabela não tem dado pessoal.
- **A ordem de §3.2 é o inverso da de §1.6, e as duas estão certas.** Aqui: *grava primeiro, apaga depois* — o registro precede o efeito irreversível. Lá: `set_config` antes do `INSERT` — o contexto precede o registro, porque é o contexto que o torna possível.
- **`GRANT` de dono (`bootstrap-papeis.sql:36-44`).** Esta migration cria `GRANT`: rode como `mavia_migrate`, dono do esquema `public` (`bootstrap-papeis.sql:45`). Um `GRANT` de quem não é dono devolve `WARNING: no privileges were granted`, a migration reporta sucesso, e o privilégio não existe. Os critérios 1, 2 e 5 são quem transforma isso em falha visível — **e eles precisam rodar contra cada partição criada pelo job**, não só contra o pai.
- **Divergência viva com a política de retenção, e ela é de hoje.** `retencao-e-eliminacao.md` **§4.4.1** (regra **R-31**) é posterior ao texto de §3.2 do spec e acrescenta ao caminho de eliminação: o mecanismo é **`INSERT` do gêmeo anonimizado e depois `DELETE` do original**, o que exige **`GRANT INSERT ON auditoria TO mavia_eliminacao`** — um sexto papel com `INSERT`, que o critério 1 precisa nomear. A R-31 **bloqueia o deploy** de qualquer um dos dois caminhos (painel em produção ou `DELETE /tenants/:id`) que subir por último; ela não bloqueia este ticket. **Conceda o `INSERT` aqui**: migration é forward-only e acrescentá-lo depois é uma migration a mais por uma linha que já se sabe necessária. Se o dono do épico 12 discordar, o custo de tirar é o mesmo.

## Decisões pendentes que este ticket toca

Nenhuma DP. O prazo de retenção é dívida datável (§"O que este épico deliberadamente não faz"); **o desenho dos grants não é, e sai daqui.**

## O que este ticket não faz

- Não cria `mavia_retencao` nem o job de retenção, nem o `GRANT UPDATE (usuario_id, de, para) ON auditoria` que a `retencao-e-eliminacao.md` §4.3 lhe dá. O job é fora de escopo declarado; a anonimização aos 90 dias com o carve-out `WHERE ator_tipo <> 'operador'` é da mesma dívida.
- Não escreve nenhuma linha de auditoria: quem grava são `admin.abrir_espaco*` (ticket 05) e as funções de contrato (07, 08, 09).
- Não cria o esquema `admin` (ticket 01) nem função nenhuma nele (ticket 05).
- Não tira o log da máquina. É o único controle que vale contra quem tem o servidor, e está fora do épico — dito aqui e no fim do spec, nos dois lugares.


## Comments

**2026-09-04 · entregue. 23 asserções, e três coisas que o Postgres ensinou.**

`0030_auditoria.sql` cria `retencao_execucoes`, `eliminacoes_journal`, os três enums, a `auditoria` particionada, o papel `mavia_eliminacao`, o gatilho de imutabilidade com a isenção de três condições, a função de partição e a RLS da §3.3. `auditoria-imutavel.test.ts`, 23 asserções.

**1 · `SET search_path = pg_catalog, public` e `CREATE TABLE` se mordem.** A convenção de segurança do repositório põe `pg_catalog` primeiro; um `CREATE TABLE` sem qualificação vai para o **primeiro** esquema da lista, e o erro é `permission denied for schema pg_catalog` — que não menciona search_path nem partição. Inverter a ordem resolveria o sintoma e desfaria a salvaguarda. Todo objeto criado dentro da função passou a ser qualificado com `public.`, que resolve os dois.

**2 · `CREATE EVENT TRIGGER` exige superusuário**, e `mavia_migrate` não é (`rolsuper = false`, de propósito). Medido: *"Must be superuser to create an event trigger."* Ele saiu da migration e virou **provisionamento**, como o `LOGIN` dos papéis — o SQL está no rodapé do arquivo, comentado, para quem for provisionar, e entrou nas condições de deploy do ticket 13. A frase honesta ganhou um segundo motivo: quem tem superusuário para criá-lo também tem para removê-lo.

**3 · `DELETE … WHERE` exige `SELECT` nas colunas do `WHERE`.** `mavia_eliminacao` tinha `DELETE` e não tinha `SELECT`, e o Postgres respondia `permission denied for table auditoria` — mensagem que não diz `SELECT` e manda procurar no lugar errado. Não afrouxa nada: o papel é `NOLOGIN`, alcançável só por `SET ROLE` a partir de `mavia_jobs`, e o gatilho continua exigindo as três condições. **Ler o que se vai apagar é parte de apagar.**

**Duas asserções que já existiam pegaram o que eu não tinha previsto — e as duas estavam certas.**

- O teste de completude da exportação reprovou `eliminacoes_journal`: tabela com `tenant_id` e sem classificação. Entrou em `FORA_DA_EXPORTACAO` com a razão escrita — ela guarda **que** a eliminação foi pedida e nada do que foi eliminado, e exportá-la devolveria ao titular o próprio pedido de apagamento, sobrevivendo à eliminação que registra.
- O teste dos campos vetados reprovou com **200 linhas** quando a `auditoria` nasceu — vinte e cinco partições × quatro papéis × duas colunas. A asserção dizia *"em `GRANT` nenhum"* e estava forte no eixo errado: os papéis do painel **escrevem** `ip_hash`, e é assim que o hash é registrado no ato do acesso. O que a R-5 e a A-26 proíbem é **sair**. Uma asserção que impedisse a escrita impediria o próprio log de existir. Agora ela é sobre `SELECT`.

**O job em código não entrou.** A função `garantir_particao_de_auditoria` existe, é idempotente e cria 24 meses de pista; o que falta é o agendamento mensal e o alarme abaixo de 3 meses, que precisam da fila do `agendador.ts`. Registrado, e a pista de 24 meses dá folga larga para isso.

Verde: typecheck 9/9, lint 9/9, API **526** em 35 arquivos.
