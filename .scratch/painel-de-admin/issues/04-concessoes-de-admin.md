Status: resolved
Blocked by: 03

# 04 · `concessoes_de_admin`, a invariante de dois administradores e a resolução por requisição

## Objetivo

Depois deste ticket existe a resposta a "quem é admin agora", derivada de uma tabela append-only que representa conceder → revogar → conceder sem apagar a história, e o banco recusa a revogação que deixaria menos de dois operadores ativos. O guard passa a resolver o privilégio **a cada requisição**, nunca carimbado no token.

## A seção do spec que governa

- **§4** — a tabela, o append-only, o `email_no_ato` e por que a FK sozinha não serve. Conceder e revogar por função `SECURITY DEFINER` estreita ou pelo script de provisionamento, que **grava a própria linha de auditoria**.
- **§4.1** — a invariante de dois administradores ativos é **de banco**, por gatilho `AFTER UPDATE … FOR EACH STATEMENT`, com o precedente escrito em `0024_compartilhamento.sql:69-98`. O gatilho é **só de `UPDATE`**, e isso é deliberado.
- **§1.4, "O helper que faltava: `comAdmin`" (S3-9)** — as **duas** leituras de `concessoes_de_admin` são diferentes e é isso que a v3 não separava: o guard lê por `comAdmin` sob a policy `concessao_propria`; a função `listar_clientes` lê por dentro, como `mavia_admin_definer`, sob policy própria.
- **§6.4** — privilégio resolvido por requisição, nunca no token. O cofre carrega só `{sessaoId, usuarioId}` (`cofre-de-acesso.ts:37-40`) e não há onde guardar claim de papel.
- **§2, a proibição** — nenhuma policy em `tenants`, `usuarios` ou `tenant_usuarios` conhece `concessoes_de_admin`.

## O que entra, e onde

**Migration `0031_concessoes_de_admin.sql`.**

1. `CREATE TABLE concessoes_de_admin (id, usuario_id, email_no_ato, concedida_em, concedida_por, revogada_em, revogada_por)`. **Sem `tenant_id`** — ela prova quem teve acesso à base, e é por isso que sobrevive ao R-08.
2. RLS `ENABLE` + `FORCE`. Policy `concessao_propria ON concessoes_de_admin FOR SELECT TO mavia_admin USING (usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid)` — **estreita de propósito**. Policy própria `TO mavia_admin_definer` e `TO mavia_admin_contrato`, cada uma carregando o predicado de concessão ativa da saída A do S3-4.
3. `GRANT SELECT` a `mavia_app` (mantendo a policy que ele já tem), a `mavia_admin`, a `mavia_admin_definer` (obrigação 4 de §2) e a `mavia_admin_contrato`.
4. `exigir_dois_admins_ativos()` + `CREATE TRIGGER dois_admins_ativos_na_revogacao AFTER UPDATE ON concessoes_de_admin REFERENCING NEW TABLE AS afetadas FOR EACH STATEMENT`. `RAISE EXCEPTION … USING ERRCODE = 'P0001'`.
5. A função `SECURITY DEFINER` estreita de conceder/revogar, **ou** o script de provisionamento — e o que ele fizer **grava a própria linha de auditoria**, com `tenant_id` nulo. Hoje ele seria, por construção, uma concessão sem registro.

**Código:** o resolvedor de concessão que o guard do ticket 02 injeta, lendo por `comAdmin(poolDoPainel, { usuarioId }, …)`.

## Critérios de aceite

**Esquema**

1. `concessoes_de_admin` tem RLS `ENABLE` + `FORCE`, a policy `concessao_propria FOR SELECT TO mavia_admin` com o predicado por `app.usuario_id`, e policies próprias `TO mavia_admin_definer` e `TO mavia_admin_contrato`.
2. `mavia_admin_definer` tem `SELECT ON concessoes_de_admin`, **e** — completando o critério 6 do ticket 01 — `SELECT` nominal nas quatro tabelas da projeção e `INSERT ON auditoria`, sem `UPDATE`, `DELETE` nem `EXECUTE` sobre tabela do razão. *Sem os três juntos, `admin.listar_clientes` falha na primeira execução pelas três razões ao mesmo tempo — foi o que a v3 fez.*
3. `mavia_admin_contrato` tem `SELECT ON concessoes_de_admin`. Sem ele, ele não confere a concessão por dentro como toda função de `admin` faz.

**Integração** (Postgres real)

4. Revogar a **penúltima** concessão ativa leva `P0001`; revogar com **três** ativas passa; **duas revogações no mesmo `UPDATE`** são barradas juntas. *Linha a linha, as duas passariam — é a razão escrita em `0024_compartilhamento.sql:69-73`.*
5. O `INSERT` da primeira concessão passa: o gatilho é **só de `UPDATE`**, e o bootstrap não tem isenção para escrever. Uma vez que a segunda existe, a contagem não desce mais — **não há GUC de escape, não há `current_user` privilegiado, não há caminho**.
6. `comAdmin` define `app.usuario_id` do operador e define `app.tenant_id` como `''`; sob ele, um operador **não enxerga** a concessão de outro operador. *A rota do painel não precisa listar quem mais é admin, e uma policy ampla aqui daria a lista de todos os operadores da Mavia numa conexão sem MFA.*
7. Nenhuma policy de `tenants`, `usuarios` ou `tenant_usuarios` referencia `concessoes_de_admin` — asserção sobre `pg_policy`.
8. Com admin logado, `X-Mavia-Tenant` de um cliente alheio no **app normal** continua sendo **403**. *`resolverTenant` (`tenancy.ts:126-139`) consulta `tenant_usuarios` sem predicado de `usuario_id` (`tenancy.ts:133`), confiando inteiramente na policy: uma policy que reconhecesse admin faria o operador navegar o espaço do cliente pela interface do cliente, sem uma linha de auditoria.*
9. Conceder ou revogar admin deixa **uma linha em `auditoria` com `tenant_id` nulo** — aceita pela policy `auditoria_grava` (ticket 03) e invisível a `mavia_app`.
10. Admin revogado com sessão viva: a **próxima requisição** recusa, porque o privilégio é resolvido por requisição contra a tabela.

## Armadilhas conhecidas

- **`administradores` com PK em `usuario_id` não representa a história (§4).** Conceder → revogar → conceder exigiria um `UPDATE` que apaga o registro anterior — o mesmo defeito que a v1 usou para recusar a flag booleana. Append-only, estado efetivo derivado.
- **A FK para `usuarios` é uma armadilha sem `email_no_ato` (§4).** A §5.2 da política de retenção apaga fisicamente a linha de `usuarios`; um ex-operador que peça eliminação da própria conta ou derruba a rota (`RESTRICT`) ou destrói a prova de quem teve acesso à base (`CASCADE`). `email_no_ato` é cópia própria e mínima do identificador, independente da FK. *A §5.2 já ganhou o segundo bloqueio: quem é, ou foi nos últimos 5 anos, administrador não elimina a própria conta pela rota do titular.*
- **A duas leituras da tabela são policies diferentes para papéis diferentes (S3-9).** O guard lê como `mavia_admin`, e só a própria linha. `admin.listar_clientes` lê como `mavia_admin_definer`, porque `SECURITY DEFINER` roda como o dono e não como o chamador. Escrever uma policy só, ampla, para servir as duas é como o painel ganha a lista de todos os operadores.
- **A saída A do S3-4 vale para as duas famílias.** Toda policy `TO mavia_admin_definer` e `TO mavia_admin_contrato` carrega `EXISTS (SELECT 1 FROM concessoes_de_admin WHERE usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid AND revogada_em IS NULL)`. E fica dito o que ela **não** faz: o predicado qualifica *quem chama*, não *quais linhas* — ele não estreita a projeção.
- **O `nullif` não é estilo (§2).** `current_setting(…, true)` devolve **string vazia** numa conexão de pool reaproveitada, e `''::uuid` **lança erro** em vez de esconder linha — documentado com contraexemplo medido em `0001_fundacao.sql:107-114` e `sistema.md:591-599`. Toda leitura de GUC é `nullif(current_setting('app.usuario_id', true), '')::uuid`, por extenso, sem abreviação. *(A ADR 0024 D4 cita `0001_fundacao.sql:105-113`; o bloco correto é `:107-114` — verificado. A ADR não é editada; usamos o intervalo certo.)*
- **O gatilho impede *cair* para um; não impede *operar* com um (S3-1).** A segunda concessão nunca criada é um degrau que este ticket **não fecha**. Ele está coberto por um **padrão vigente que o dono pode mudar** — não chame isso de fechado no ticket, no commit ou no comentário. A v3 chamou, e o gate mostrou que a citação apontava para um `---`.
- **`GRANT` de dono (`bootstrap-papeis.sql:36-44`).** Esta migration cria `GRANT`: rode como `mavia_migrate` (`bootstrap-papeis.sql:45`). Sem isso, `WARNING: no privileges were granted`, migration verde, privilégio inexistente — e `admin.listar_clientes` falharia na primeira execução no ticket 05, por um motivo que esta migration escondeu.

## Decisões pendentes que este ticket toca

- **DP-32** (`decisoes-do-produto.md:136`), **em aberto**. Padrão vigente: *MFA antes do primeiro cliente pagante; enquanto não houver escolha, o painel não vai a produção com cliente real.* É desse padrão que §4.1 **empresta** o fechamento do degrau "operar com um administrador só". **Se o dono responder qualquer marco posterior**, o degrau reabre no mesmo ato e a §8.1.1 da política de retenção volta à mesa junto. A invariante deste ticket cobre a queda; a cobertura do degrau restante é emprestada, e o ticket diz isso em vez de escondê-lo.

## O que este ticket não faz

- **Não cria tela nem rota de conceder admin.** Só o script (§4). Se um dia a tela existir, ela é o `PATCH /membros/:usuarioId` deste épico e merece as quatro travas da **R-4** (`matriz-de-acesso.md:57-64`).
- Não implementa a notificação entre pares (ticket 10) — só garante que o conjunto "os outros operadores" deixa de poder ser vazio.
- Não cria função nenhuma no esquema `admin` (ticket 05).

## Comments

**2026-09-04 · entregue. 12 asserções.**

`0031_concessoes_de_admin.sql`: a tabela append-only sem `tenant_id`, o índice de concessão ativa única, o gatilho `AFTER UPDATE … FOR EACH STATEMENT`, as três policies (uma estreita para `mavia_admin`, duas com o predicado de concessão ativa para os donos de função), e `admin.conceder` / `admin.revogar`, que **gravam a própria linha de auditoria**.

**O melhor teste do ticket falhou primeiro, e a falha foi a prova.** A versão inicial da asserção de auditoria começava com `DELETE FROM auditoria WHERE entidade = 'concessao_de_admin'`, para isolar a medição. Levou `AUDITORIA_IMUTAVEL`: o gatilho do ticket 03 barrou **o próprio teste que existe para verificar o log**.

Está certo, e reescrevi o teste em vez do gatilho. Ele agora mede pela borda, com uma marca de tempo. **Um log que o teste consegue limpar é um log que a aplicação consegue limpar** — e a conveniência de isolar uma medição não é razão para abrir a porta que o épico inteiro existe para fechar.

**A invariante é só de `UPDATE`, e a decisão está escrita na migration.** Cobrir `INSERT` exigiria isenção para a primeira concessão, e isenção é exatamente o escape hatch que a imutabilidade foi escrita para fechar. O gatilho **impede cair** para um operador; **não impede operar** com um. A diferença é real: com um só, a detecção entre pares é o conjunto vazio, e quem descobre o abuso está do mesmo lado de quem pode cometê-lo. Coberto pela **DP-32**, padrão vigente, decisão do dono pendente.

**A policy do painel é estreita de propósito**, e o teste afirma isso: um operador vê a própria concessão e nenhuma outra. Uma policy ampla entregaria, numa conexão sem segundo fator, a lista de todos os operadores da Mavia com nome e e-mail — que é o alvo de quem já comprometeu um deles.

**Critérios 8 e 10 esperam o ticket 06.** O 8 tem a metade estrutural coberta aqui: a asserção sobre `pg_policy` prova que nenhuma policy de `tenants`, `usuarios` ou `tenant_usuarios` conhece a tabela, que é o caminho perigoso. A metade de requisição precisa de rota de admin. O 10 idem — o resolvedor está pronto em `comAdmin`, falta a rota que o exercite.

Verde: typecheck 9/9, lint 9/9, API **538** em 36 arquivos.
