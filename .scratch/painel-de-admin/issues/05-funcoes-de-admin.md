Status: ready-for-agent
Blocked by: 01, 03, 04

# 05 · As funções `SECURITY DEFINER` do esquema `admin` — família de leitura

## Objetivo

Depois deste ticket existem os três únicos lugares do sistema onde um identificador vindo de uma rota vira contexto de banco, e cada um deles grava a linha de auditoria **antes** de o acesso existir. A propriedade central do épico — *não se toca o espaço de um cliente sem registrar* — passa a ser verdadeira no banco, para leitura **e** para escrita.

## A seção do spec que governa

- **§2** — as cinco obrigações de `admin.listar_clientes`, e por que o dono **não** pode ser `mavia_auth`: ele já lê cinco tabelas cross-tenant com `USING (true)` (`0004_cadastro.sql:52`, `:57`, `:60`, `:63`, `0025_assinatura.sql:163`). **Aqui, a convenção é o exploit.** ADR 0024 · D4.
- **§1.6** — duas funções de abertura, não uma. `set_config` e `INSERT INTO auditoria` com o **mesmo parâmetro vinculado**, e a **ordem normativa**: `set_config` primeiro.
- **§1.6 · S3-2** — por que `abrir_espaco_para_escrita` existe, e as três saídas ruins que o implementador tinha sem ela.
- **§8.0** — a emenda à ADR 0024: a lista fechada do esquema `admin` passa de três para **oito**, em duas famílias com donos diferentes. **É pré-requisito do primeiro ticket da §8, e não se resolve em code review.**
- **Erros e bordas · S3-4** — a saída B (lista fechada) com a saída A (predicado de concessão nas policies do definer) junto, nessa ordem.

## O que entra, e onde

**Migration `0032_funcoes_de_admin.sql`.** Quatro funções nesta migration; a quarta da família de leitura (`admin.ler_registro`) é do ticket 10.

1. `admin.listar_clientes(p_busca text, p_pagina int)` — dono `mavia_admin_definer`.
2. `admin.abrir_espaco(p_alvo uuid, p_motivo motivo_de_acesso, p_referencia text, p_acao text, p_rota text)` — dono `mavia_admin_definer`, `EXECUTE` **só** a `mavia_admin`.
3. `admin.abrir_espaco_para_escrita(…mesma assinatura…)` — dono `mavia_admin_definer`, `EXECUTE` **só** a `mavia_admin_escrita`, classe de **escrita financeira** no log, e **devolve a `correlacao`** que a segunda linha (§8.5) vai carregar.
4. Todas com `SET search_path = pg_catalog, public`.
5. `resolverTenant` (`tenancy.ts:133`) ganha `AND usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid` — a segunda camada que a regra 16 exige e que `sistema.md:648` promete.
6. `comUsuario` (`tenancy.ts:93-111`) passa a definir `app.tenant_id` como `''` explicitamente — hoje ele nunca o limpa (§7).

**O teste da lista fechada, e a forma que ele precisa ter.** A asserção do spec é *"o esquema `admin` contém **exatamente** as oito funções da §8.0, com o dono certo em cada família; uma nona derruba o teste"*. As oito nascem em quatro tickets diferentes (05, 07, 08, 09, 10), e um teste de igualdade contra oito ficaria vermelho entre eles. **A forma normativa:** uma constante `FUNCOES_DE_ADMIN: ReadonlyMap<string, 'definer' | 'contrato'>` no arquivo de teste, e a asserção é de **igualdade contra ela**. Cada ticket seguinte acrescenta **uma linha** à constante junto com a função. A igualdade vale em todo ponto da sequência, e uma nona função não declarada derruba o teste em qualquer um deles — que é exatamente o que a saída B quer.

## Critérios de aceite

**Esquema**

1. O esquema `admin` contém **exatamente** as funções de `FUNCOES_DE_ADMIN`, e o dono de cada uma é `mavia_admin_definer` (leitura) ou `mavia_admin_contrato` (escrita de contrato). **Nenhuma** é de `mavia_auth` ou de `mavia_migrate`.
2. Toda função em `admin` tem `SET search_path` em `pg_proc.proconfig`.
3. Nenhuma função de `admin` contém `UPDATE … SET plano` ou `SET intervalo` no corpo (`pg_get_functiondef`). *Vale desde aqui e é reafirmada a cada função nova — DP-40.*
4. `EXECUTE ON admin.abrir_espaco` é **só** de `mavia_admin`; `EXECUTE ON admin.abrir_espaco_para_escrita` é **só** de `mavia_admin_escrita`. Nenhum dos dois alcança a função do outro.

**Integração** (Postgres real)

5. `admin.listar_clientes` roda **na primeira execução**, contra o esquema recém-migrado, com o pool de leitura do painel — sem `permission denied` de esquema, de tabela, de `concessoes_de_admin` ou de `auditoria`. *É o teste que a v3 não teria passado, pelas três razões ao mesmo tempo.*
6. `admin.listar_clientes` chamada por um `app.usuario_id` **sem concessão ativa** devolve **erro**, não zero linhas. *Critério de aceite da ADR 0024, e da emenda ao `sistema.md` §3.9 (`:650`).*
7. `admin.listar_clientes` grava a linha da busca **na mesma instrução**, com o termo **hasheado** e a **contagem** de resultados. Uma linha por **busca**, não uma por cliente listado.
8. Termo de busca com aspas e `%` não altera o conjunto de resultados nem produz erro de sintaxe — parâmetro vinculado, nunca `format` ou `||`.
9. Toda abertura por `admin.abrir_espaco` deixa **exatamente uma** linha de `auditoria`, com `motivo`, `referencia`, `rota` e contagem, e o `tenant_id` da linha é **o mesmo** que virou `app.tenant_id`.
10. `motivo` fora do enum recusa o `INSERT`, **e a abertura não acontece**.
11. A linha gravada por `admin.abrir_espaco_para_escrita` tem a **classe de escrita financeira** — não a de leitura em massa — e o mesmo `tenant_id` que virou `app.tenant_id`. **Divergência entre auditado e efetivado não é produzível pela rota.**
12. `mavia_admin_escrita` leva `permission denied` ao chamar `admin.abrir_espaco`, e `mavia_admin` ao chamar `admin.abrir_espaco_para_escrita`.
13. Nas duas funções, `set_config('app.tenant_id', p_alvo, true)` **precede** o `INSERT INTO auditoria`, verificado por um teste que troca a policy de `auditoria` para uma que exija `app.tenant_id` e observa que a função continua passando. *A ordem não depende da policy, e a policy não depende da ordem — as duas travas coexistem de propósito.*
14. `resolverTenant` com um `app.usuario_id` que não é o dono do vínculo devolve `null` mesmo com a policy permitindo — o predicado da segunda camada está no `WHERE`.

## Armadilhas conhecidas

- **A convenção é o exploit (§2, ADR 0024 D4).** `0004_cadastro.sql:317-325` tem **nove** `ALTER FUNCTION … OWNER TO mavia_auth` em bloco, mais `0025_assinatura.sql:156`. Uma função escrita seguindo a convenção nasce dona de `mavia_auth`, lê a base inteira, **não viola uma vírgula de nenhuma proibição escrita, e não grava uma linha**. `mavia_migrate` também está fora: tem `BYPASSRLS` (`bootstrap-papeis.sql:27`).
- **Policy sem `GRANT` não lê nada (S3-3).** `admin.listar_clientes` é `SECURITY DEFINER` de `mavia_admin_definer`: ela roda **como ele**. Sem `USAGE` nos esquemas (ticket 01), sem `SELECT` nominal nas quatro tabelas da projeção (01), sem `SELECT ON concessoes_de_admin` (04) e sem `INSERT ON auditoria` (03), ela falha na primeira execução. O critério 5 é o teste que pega isso, e ele **precisa rodar contra o esquema recém-migrado** — não contra um banco de desenvolvimento onde alguém concedeu à mão.
- **`SET LOCAL` não aceita parâmetro (§1.6).** A v1 implicava interpolar um parâmetro de rota em SQL, e `node-pg` aceita múltiplas instruções numa consulta simples: a linha de auditoria podia dizer cliente A enquanto o `app.tenant_id` virava cliente B. **Mesmo parâmetro vinculado, mesmo corpo.**
- **A ordem é normativa e é o inverso da de §3.2 (S3-7).** Aqui `set_config` precede o `INSERT`, porque é o contexto que torna o registro possível. Lá, *grava primeiro, apaga depois*. Trocar uma pela outra por simetria é defeito.
- **Fora destas duas funções, `params` alimentando `set_config('app.tenant_id', …)` é defeito** — ADR 0024 D1 condição 2, e `sistema.md:991` veto 10, que já nomeia `admin.abrir_espaco*`. Vale para os três pools, para código de rota, de serviço e de repositório, e **não tem exceção sob revisão**.
- **A armadilha que a correção de `mavia_auth` recria um esquema adiante (S3-4).** As policies novas de `mavia_admin_definer` terão forma ampla pela mesma razão estrutural: **numa listagem não existe `app.tenant_id` por definição**. E a asserção "o dono de toda função em `admin` é `mavia_admin_definer`" é, ao mesmo tempo, um controle e uma **instrução**: a próxima pessoa fará a função dela pertencer ao definer para o teste passar, e ela nascerá com acesso às policies amplas da primeira. **É por isso que são duas famílias com donos diferentes** — a função nova precisa *escolher*, e cada família tem policies estreitas ao que ela faz. Não unifique os donos "para simplificar": isso desfaz a §8.0 inteira.
- **A emenda à ADR 0024 é pré-requisito deste ticket.** A lista fechada da ADR diz três funções; a §8.0 diz oito, em duas famílias. **Não se resolve em code review** — a ADR precisa ser emendada antes do merge, e o critério 1 é o que torna a omissão visível.
- **`GRANT` de dono (`bootstrap-papeis.sql:36-44`)**: os `GRANT EXECUTE` desta migration rodam como `mavia_migrate`. O critério 4 é quem pega a omissão.

## Decisões pendentes que este ticket toca

- **DP-33** (`decisoes-do-produto.md:137`), **em aberto**, padrão vigente **30 minutos** para a janela em que um `motivo` + `referencia` autoriza aberturas. O ticket implementa a reconciliação normativa de §5, que **não depende da resposta**: a janela reaproveita a hipótese e **nunca** a linha de auditoria (toda abertura chama a função e grava a sua); ela é por `motivo` + `referencia` + operador, **nunca por operador sozinho**; `RL-ADMIN-ABERTURA` conta aberturas e não hipóteses, e a janela não o afrouxa; quando os dois discordam, vence o teto. **Se o dono responder 5 minutos ou nenhuma janela**, muda o atrito do operador e não muda nenhum controle deste ticket.

## O que este ticket não faz

- Não cria rota nenhuma (ticket 06).
- Não cria as quatro funções de contrato (07, 08, 09) nem `admin.ler_registro` (10) — só o mecanismo da lista fechada que cada uma vai estender.
- Não implementa `RL-ADMIN-ABERTURA` (ticket 10; **C-8** fixa o valor com o dono).
- Não muda o texto do `sistema.md` §3.9: a emenda **já está aplicada** — `:644` diz três exceções, `:648` nomeia `admin.listar_clientes` citando a ADR 0024, `:650` traz o critério de aceite, e os vetos 8 e 10 estão em `:989` e `:991`. Verificado. **C-10** fica na lista para ser conferido no deploy, não executado.
