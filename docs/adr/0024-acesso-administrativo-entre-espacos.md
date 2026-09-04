# ADR 0024 — Acesso administrativo entre espaços: a exceção à R-3, e o que a contém

**Estado:** **aceita**
**Data:** 2026-09-04 · **Aceita pelo dono do produto em 2026-09-04.**
**Substitui:** nada. **Emenda** o `sistema.md` §3.9 (lista fechada de exceções de leitura sem tenant) e nomeia a exceção que a `matriz-de-acesso.md` R-3 exige.
**Exigida por:** achado S-10 do gate de segurança sobre o spec do painel de administração.

---

## Contexto

Três documentos normativos proíbem o que o painel de administração precisa fazer, e os três dizem que a proibição só cede por ADR:

| Norma | Texto | O que o painel faz |
|---|---|---|
| `matriz-de-acesso.md` **R-3** | *"O tenant vem só da sessão, nunca da URL. Não há exceção prevista, e criar uma exige ADR."* | Precisa de uma rota que **escolhe** o tenant |
| `sistema.md` §8, **veto 10** | *"Nenhum `id` de tenant em path de rota. O tenant vem do contexto; duas fontes de verdade é IDOR."* | `/admin/clientes/:tenantId` é exatamente isso |
| `sistema.md` §8, **veto 8** | *"nenhuma leitura sem contexto de tenant além das duas exceções nomeadas em §3.9"* | A listagem de clientes é a terceira |

Escrever a ADR não é formalidade. As três regras existem porque a alternativa — decidir caso a caso em revisão de código — foi julgada pior, e a §8 do `sistema.md` existe literalmente para impedir que um veto seja re-litigado no pull request. Uma exceção que não passa por aqui é uma exceção que ninguém consegue auditar depois.

### Por que a exceção é necessária

A alternativa real nunca foi "nenhum acesso entre espaços". Era `psql` na VPS: acesso mais amplo (DML completo em toda tabela, `0006_nucleo.sql:278`), sem hipótese declarada, sem papel somente-leitura e sem registro. O painel **substitui um tratamento pior que já acontecia** — o argumento está desenvolvido na LIA de `retencao-e-eliminacao.md` §8.1.1 e não se repete aqui.

O que esta ADR decide não é *se* a exceção existe. É **qual é exatamente o seu contorno**, e qual mecanismo a impede de vazar para o resto do sistema.

---

## Decisão

### D1 · A exceção é nomeada, e o nome tem três partes

A R-3 passa a ter **uma** exceção, e ela só vale sob as três condições simultâneas:

1. **A rota está sob `/v1/admin/`.** Nenhuma outra rota do sistema aceita identificador de tenant no caminho, e isso é verificável por varredura do manifesto.
2. **O identificador do caminho nunca é atribuído a `app.tenant_id` diretamente.** Ele é *argumento* de `admin.abrir_espaco(...)`, que é quem grava a auditoria e define o GUC na mesma instrução. Fora dessa função, `params` alimentando `set_config('app.tenant_id', …)` é defeito.
3. **A requisição não carrega um `Autenticado`.** É a D2, e é o que impede a exceção de encostar no resto do sistema.

### D2 · O caminho de admin nunca produz um `Autenticado`, e nunca alcança `comTenant`

Esta é a decisão que carrega o peso, e ela é topológica em vez de disciplinar.

`AutorizacaoGuard` (`autorizacao.guard.ts:36-48`) exige `req.autenticado` com `{usuarioId, tenantId, papel}`. Se o painel sintetizasse esse objeto com o tenant do cliente, **todos os controladores existentes passariam a servi-lo** — e todos eles chamam `comTenant(this.pool, ctx, …)`, que passa `'mavia_app'` fixo (`tenancy.ts:74`), com DML completo sobre `lancamentos`, `contas`, `faturas` e `transferencias`, sem passar por `abrir_espaco` e sem gravar linha nenhuma.

Por isso:

- `autenticador.ts` continua devolvendo `autenticado: null` para rotas `/admin/*`;
- o contexto que `abrirEspacoComoAdmin` produz é de um **tipo distinto**, aceito só por `comTenantDeAdmin`;
- `comTenantDeAdmin` usa um **pool diferente** (D3).

Consequência aceita: cada tela do cliente que o operador precisa ver tem rota própria sob `/admin/`, com projeção própria e contagem própria. É a maior parte do trabalho do épico e está orçada como tal. A alternativa — reusar os controladores do cliente — grava uma linha de auditoria na abertura e **nenhuma** nas N leituras seguintes, o que torna falsa a propriedade central do painel.

### D3 · Pool próprio, papel `LOGIN` próprio, sem parentesco com `mavia_app`

**O motivo, medido.** `SET LOCAL ROLE` restringe até o fim da transação; ele **não** é irreversível dentro dela. Provado contra Postgres 17 real, com a topologia proposta (papel de aplicação membro de um papel somente-leitura):

```sql
BEGIN;  SET LOCAL ROLE leitor;  UPDATE t SET v = 99;              -- permission denied
BEGIN;  SET LOCAL ROLE leitor;  RESET ROLE;  UPDATE t SET v = 99; -- UPDATE 1, e commita
```

Uma instrução desfaz a trava. Qualquer injeção de SQL numa rota do painel, qualquer helper com concatenação, ou um `RESET ROLE` copiado de um exemplo, devolve o DML completo sobre o razão do cliente cujo `app.tenant_id` acabou de ser assumido. Um papel alcançado por `SET ROLE` é uma convenção com nome de papel — não uma fronteira de privilégio.

**A decisão:** o painel abre um **segundo `Pool`**, autenticado *diretamente* como papel próprio, com credencial própria no `.env`.

| Papel | Atributos | Privilégio | Existe para |
|---|---|---|---|
| `mavia_admin` | `LOGIN NOINHERIT` | `SELECT` **por coluna** (D5); `INSERT` em `auditoria` | Ler o espaço do cliente |
| `mavia_admin_escrita` | `LOGIN NOINHERIT` | `UPDATE` por coluna em `assinaturas`; `INSERT` em `pagamentos_manuais`; `EXECUTE` no procedimento de cadastro | As quatro escritas da §8 |
| `mavia_admin_definer` | `NOLOGIN NOBYPASSRLS` | Dono das funções do esquema `admin` | A listagem (D4) |

**As não-relações importam tanto quanto os privilégios**, e cada uma fecha um caminho:

- `mavia_app` **não** é membro de nenhum dos três — senão o pool do cliente alcança o painel por `SET ROLE`;
- nenhum dos três é membro de `mavia_app` — senão `RESET ROLE` devolve o DML completo, que é o defeito acima;
- `mavia_admin` **não** é membro de `mavia_admin_escrita` — a conexão que lê não é a conexão que escreve, e a separação é por autenticação, não por instrução;
- nenhum dos três tem `BYPASSRLS`, mantendo o `sistema.md` §3.9 (nenhum papel que serve requisição o tem).

Com isso, `RESET ROLE` na conexão do painel aterrissa em `mavia_admin`, que não tem escrita em tabela nenhuma. A propriedade "o admin lê e não edita o razão do cliente" passa a ser consequência de **quem a conexão é**, e não de qual instrução a rota lembrou de executar.

### D4 · A listagem tem dono próprio, e o dono não pode ser `mavia_auth`

A listagem de clientes é a terceira exceção de leitura sem contexto de tenant. Ela vive numa função `SECURITY DEFINER` no esquema `admin`, e **o dono dela é a decisão mais sensível do épico**.

**Não pode ser `mavia_auth`**, que é a convenção do repositório para toda `SECURITY DEFINER`. Verificado no banco de produção e no local:

```
usuarios         cadastro_le_usuarios           TO mavia_auth  USING (true)
tenants          cadastro_le_tenants            TO mavia_auth  USING (true)
tenant_usuarios  cadastro_le_vinculos           TO mavia_auth  USING (true)
sessoes          cadastro_le_sessoes            TO mavia_auth  USING (true)
assinaturas      assinatura_lida_pelo_webhook   TO mavia_auth  USING (true)
```

Isto é: **exatamente a projeção que a listagem precisa — espaço, titular, plano, estado — já está liberada cross-tenant para o dono canônico das funções do repositório.** Uma função escrita por alguém seguindo a convenção nasce dona de `mavia_auth` e lê a base inteira sem violar uma vírgula de nenhuma proibição escrita, e sem gravar uma linha de auditoria.

**Não pode ser `mavia_migrate`**, que tem `BYPASSRLS` (`bootstrap-papeis.sql:27`): a função viraria leitura irrestrita de tudo, contra o veto 8.

**É `mavia_admin_definer`**, `NOLOGIN NOBYPASSRLS`, cujas **únicas** policies são as estritamente necessárias à projeção fixa da listagem. Mais três obrigações, todas verificáveis:

1. `SET search_path = pg_catalog, public` na função — como as 20 `SECURITY DEFINER` existentes já têm, pelo motivo em `0004_cadastro.sql:92-94`.
2. Busca por **parâmetro vinculado**, nunca `format` ou `||` sobre o termo.
3. A função **verifica dentro dela** que `nullif(current_setting('app.usuario_id', true), '')::uuid` tem concessão ativa em `concessoes_de_admin`, e **grava a linha de auditoria da busca na mesma instrução** — pela mesma razão que `admin.abrir_espaco` faz isso. `EXECUTE` concedido só ao papel do painel não é controle suficiente enquanto papel for alcançável; a checagem interna é.

O `nullif` não é estilo: `current_setting` devolve string vazia em conexão de pool reaproveitada, e `''::uuid` lança erro — está documentado com contraexemplo medido em `sistema.md:591-599` e `0001_fundacao.sql:105-113`.

### D5 · `GRANT` por coluna, com os sete campos da R-5 fora

`GRANT SELECT` no nível de tabela entregaria à conexão do painel `usuarios.senha_hash`, `usuarios.mfa_segredo_cifrado`, `sessoes.refresh_hash`, `conexoes.credenciais_cifradas`, `conexoes.dek_cifrada`, `lancamentos_brutos.payload` e `dados_fiscais.documento`. A R-5 da matriz diz que esses sete **nunca** saem, para papel nenhum.

O envelope encryption do ADR 0018 torna as credenciais cifradas inúteis sem a KEK. `senha_hash` não: é material para quebra offline de toda a base de clientes, a um `SELECT` de distância numa conexão de painel que não tem segundo fator. **A DA-1 autorizou leitura completa dos dados financeiros; não autorizou o hash de senha de todo mundo.**

Os `GRANT` são nominais por coluna, e a lista fechada mora na migration. A propriedade que isso compra e que `GRANT` de tabela não compra: **coluna nova não se estende sozinha** — uma migration futura que adicione um campo sensível não o entrega ao painel por omissão.

### D6 · O que a exceção **não** autoriza

- **Personificar o titular.** Já decidido no spec, e o motivo é concreto: a policy `RESTRICTIVE` de `0002_identidade.sql:173-176` é `TO mavia_app`, então uma sessão sintética do cliente passaria a autorizar `UPDATE usuarios SET senha_hash` na linha dele.
- **Colar `/admin/*` em `ROTAS_SEM_TENANT`.** Seriam duas exceções pelo preço de uma.
- **Escrever no razão do cliente.** `lancamentos`, `contas`, `faturas`, `transferencias`, `saldo_snapshots`: nenhum `GRANT` de escrita, para nenhum dos três papéis. Corrigir lançamento de cliente é pedido ao cliente, não feito por cima dele.
- **Leitura sem hipótese declarada.** `motivo` é enum; um valor fora da lista não entra no `INSERT`, e a instrução que registra é a que efetiva o acesso.

---

## Emenda ao `sistema.md` §3.9

A frase *"A única exceção de leitura sem contexto de tenant é `outbox_pendencias` e a view `tenants_ativos`"* passa a ter **três** exceções, e a terceira é:

> **`admin.listar_clientes(...)`**, função `SECURITY DEFINER` de `mavia_admin_definer` (`NOLOGIN NOBYPASSRLS`), com projeção fixa — espaço, titular, plano, estado —, sem dado financeiro do razão, executável apenas pelo pool do painel, que verifica concessão ativa e grava auditoria na mesma instrução. Critério de aceite: chamá-la sem concessão ativa devolve **erro**, não linhas.

---

## Consequências

**O painel fica mais caro do que parecia.** Rota própria por tela, dois pools, três papéis, `GRANT` nominais por coluna. É o preço de a propriedade central ser verdadeira, e a v1 do spec provou que afirmá-la sem esse preço custa uma reprovação.

**Uma conexão a mais no Postgres.** Dois pools pequenos em vez de um. Irrelevante no volume atual, e explícito no dimensionamento.

**A convenção "toda `SECURITY DEFINER` é de `mavia_auth`" ganha uma exceção documentada.** Quem escrever a próxima função de admin precisa saber disso, e é por isso que está aqui e não só no ticket.

**Fica um degrau que esta ADR não resolve:** não há nível intermediário de acesso. Um defeito de fechamento de fatura alcança `objetivos.nome` e os anexos. A necessidade é defensável **por hipótese**, não **por linha**, e essa distância está registrada na LIA §8.1.1 como limite conhecido, não como coisa resolvida.

---

## Alternativas rejeitadas

**Um pool só, com `SET LOCAL ROLE`.** É o que o spec v2 propunha. Rejeitada pela medição da D3: `RESET ROLE` desfaz a trava em uma instrução. Foi o achado que reprovou a v2.

**Reusar os controladores do cliente com um `Autenticado` sintético.** Rejeitada pela D2: grava uma linha na abertura e nenhuma nas leituras seguintes. Barata de implementar e falsa na propriedade que justifica o épico inteiro.

**`admin.listar_clientes` de `mavia_auth`, seguindo a convenção.** Rejeitada pela D4: `mavia_auth` já lê as cinco tabelas cross-tenant com `USING (true)`. A convenção, aqui, é o exploit.

**Não escrever ADR e tratar o painel como caso especial no código.** É o que a `sistema.md` §8 existe para impedir. Uma exceção implícita não é auditável, e daqui a um ano ninguém saberá dizer se `/admin/:tenantId` foi decidido ou tolerado.
