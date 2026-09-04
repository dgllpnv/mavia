Status: resolved
Blocked by: 02, 05

# 06 · As rotas de leitura do painel

## Objetivo

Depois deste ticket o operador consegue achar um cliente, ver o perfil dele, declarar a hipótese e abrir o espaço — e cada tela do cliente que ele vê deixa a sua própria linha de auditoria, com rota e contagem. É a primeira vez que `/v1/admin/` existe no roteador.

## A seção do spec que governa

- **§8.0, tabela de ações** — as rotas de leitura: `GET /v1/admin/clientes`, `GET /v1/admin/clientes/:tenantId`, `POST /v1/admin/clientes/:tenantId/abrir`, mais **rotas próprias por tela**.
- **§1.4** — a consequência aceita, e é a maior parte do orçamento do épico: **cada tela do cliente tem rota própria, com projeção própria, contagem própria e linha de auditoria própria. Não há reuso dos controladores do cliente.**
- **§1.4, a declaração normativa** — `autenticador.ts` continua devolvendo `autenticado: null` para `/v1/admin/*`; o contexto é de tipo distinto; os pools são os do painel; e **nenhuma rota `/v1/admin/*` chama `comTenant`, `comUsuario` ou `resolverTenant`**.
- **§1.7** — `app.usuario_id` é sempre o do operador. Personificar o titular é proibido, e a consequência aceita é que as telas `⊙` do cliente não são visíveis no painel.
- **§1.8** — o que a atomicidade compra: para leitura, a resposta é montada **estritamente depois** de o `COMMIT` retornar.
- **§5, `RL-ADMIN-BUSCA`** — classe própria, mais estrita que `RL-AUTH` (`matriz-de-acesso.md` §5.1, `:477`).

## O que entra, e onde

Sem migration.

**Rotas** — cada uma com uma linha em `ROTAS_DE_ADMIN` (chave exata) e uma linha na matriz:

| Rota | Serve | Chama |
|---|---|---|
| `GET /v1/admin/clientes` | busca, paginada | `admin.listar_clientes`, por `comAdmin` |
| `GET /v1/admin/clientes/:tenantId` | perfil do cliente | `admin.abrir_espaco` → `comTenantDeAdmin` |
| `POST /v1/admin/clientes/:tenantId/abrir` | declara motivo + referência | `admin.abrir_espaco` |
| `GET /v1/admin/clientes/:tenantId/contas` | contas e saldos | `admin.abrir_espaco` → `comTenantDeAdmin` |
| `GET /v1/admin/clientes/:tenantId/lancamentos` | lançamentos do período | idem |

**As quatro telas de cliente do primeiro corte** (§1.4) são perfil, contas e saldos, lançamentos do período e **baixas anteriores** — a quarta é do ticket 07, porque dar baixa sem ver as baixas anteriores é o cenário F-3 com outra roupa. **Uma quinta tela continua sendo ticket próprio.**

O motivo e a referência são pedidos **antes** de abrir o espaço, não depois. `RL-ADMIN-BUSCA` na rota de busca.

## Critérios de aceite

**Boot**

1. As cinco chaves novas estão em `ROTAS_DE_ADMIN`, por chave exata, e o boot passa nas duas direções da asserção de prefixo (ticket 02, critério 2).

**Integração** (aplicação real contra Postgres real)

2. **Nenhuma rota `/v1/admin/*` produz `req.autenticado` não-nulo**, e **nenhuma chama `comTenant`, `comUsuario` ou `resolverTenant`** — asserção sobre o código emitido e sobre a requisição real.
3. Cada uma das rotas de tela deixa **exatamente uma** linha de `auditoria`, com a sua `rota` e a sua **contagem de registros**. Duas telas seguidas deixam duas linhas, não uma.
4. A linha tem o `tenant_id` **igual** ao `:tenantId` do caminho, e igual ao que virou `app.tenant_id`.
5. Admin revogado com sessão viva: a **próxima requisição** a qualquer rota de admin recusa.
6. `GET /v1/admin/clientes` sem concessão ativa devolve **erro**, não lista vazia — a checagem é dentro de `admin.listar_clientes`, e a rota não a duplica.
7. Não-admin em rota `/v1/admin/` recebe **404**. *Não é controle: o tempo de resposta difere de um caminho inexistente e o App Router entrega o manifesto de rotas. É grátis, e só — não conta como salvaguarda.*
8. **Sabotagem:** com o `INSERT` em `auditoria` forçado a falhar, a transação desfaz e **a resposta não sai**. A resposta é montada estritamente depois de o `COMMIT` retornar, e qualquer erro descarta o resultado.
9. `RL-ADMIN-BUSCA` recusa acima do teto, e o teto é mais estrito que o de `RL-AUTH`.
10. Uma tela do cliente chaveada por `usuario_id` (alertas, preferências, sessões — R-2) **não existe** sob `/v1/admin/`. Asserção sobre a lista de rotas: nenhuma delas.

## Armadilhas conhecidas

- **Um `Autenticado` sintético destrói a propriedade central (ADR 0024 D2, §1.4).** `AutorizacaoGuard` (`autorizacao.guard.ts:36-48`) exige `req.autenticado` com `{usuarioId, tenantId, papel}`. Se o painel o sintetizasse com o tenant do cliente, **todos os 22 controladores passariam a servi-lo** — e todos chamam `comTenant(this.pool, ctx, …)`, que passa `'mavia_app'` fixo (`tenancy.ts:74`), com DML completo sobre `lancamentos`, `contas`, `faturas` e `transferencias` (`0006_nucleo.sql:278`), **sem passar por `abrir_espaco` e sem gravar linha nenhuma**. É a alternativa barata e falsa que a ADR rejeitou por escrito.
- **Reusar o controlador do cliente grava uma linha na abertura e nenhuma nas N leituras seguintes.** É a mesma armadilha por outro caminho, e é o que torna falsa a propriedade que justifica o épico. **Rota própria por tela, e o orçamento está declarado para não ser descoberto no meio.**
- **Personificar o titular vai na direção errada (§1.7).** As telas chaveadas por `usuario_id` virão vazias no painel, e a correção "óbvia" — assumir o `usuario_id` do titular — faria a policy `RESTRICTIVE usuario_escreve_so_a_propria_linha` (`0002_identidade.sql:173-176`) passar a autorizar `UPDATE usuarios SET senha_hash` **na linha do cliente**. A consequência aceita está escrita para não ser "descoberta" e revertida por conveniência.
- **`app.tenant_id` só nasce de `admin.abrir_espaco`.** Nenhum `set_config('app.tenant_id', …)` na rota, com valor de `params`, corpo, query ou cabeçalho. `sistema.md:991`, veto 10, já nomeia isso como defeito.
- **"A leitura desfaz" é retórica (§1.8).** As linhas já estão no processo quando o `COMMIT` roda. A janela residual é a falha de `COMMIT`, e o critério 8 é o que a fecha. Não escreva no ticket que a leitura é atômica no mesmo sentido que a escrita.
- **DA-2 é filtro, não omissão.** A matriz §3.12, linha `GET /atividades` (`matriz-de-acesso.md:367`), dá ao `proprietario` *"todas as atividades do espaço"*, e as linhas do admin nascem com o `tenant_id` dele. **Esconder exige um filtro deliberado**, e é aqui que ele mora. `ator_tipo` é a coluna que o torna reversível por configuração.
- **`RESET ROLE` numa rota do painel aterrissa em `mavia_admin`**, que não escreve em tabela nenhuma. Essa é a propriedade que o ticket 01 comprou; **não a desfaça** trocando de pool numa rota "só para essa consulta".

## Decisões pendentes que este ticket toca

- **DA-2**, decidida e mantida em 2026-09-04: o cliente **não** é avisado quando um admin abre o espaço dele. Não se re-litiga aqui. O filtro que a implementa é a consequência descrita acima.
- **DP-33** (`decisoes-do-produto.md:137`), **em aberto**, padrão vigente **30 minutos**: a rota `POST …/abrir` reaproveita a hipótese dentro da janela por `motivo` + `referencia` + operador, e **grava a linha de auditoria em toda abertura**, sem exceção. Se o dono responder 5 minutos ou nenhuma janela, muda quantas vezes o formulário aparece; não muda o log nem o teto.

## O que este ticket não faz

- Não implementa `GET /v1/admin/clientes/:tenantId/pagamentos` (ticket 07 — mesma fatia da baixa, por F-3).
- Não implementa `GET /v1/admin/registro` (ticket 10).
- Não implementa escrita nenhuma.
- Não desenha tela (ticket 12): entrega as rotas e os contratos.
- Não implementa `RL-ADMIN-ABERTURA` (ticket 10, **C-8**).

## Comments

**2026-09-04 · entregue. 13 asserções.** `/v1/admin/` existe no roteador pela primeira vez.

As cinco rotas, o `AdminController`, a pool do painel ligada de `main.ts` até o módulo, e — a peça que carrega a ADR 0024 D2 — `exigeTenant` passando a excluir as rotas de admin.

**Essa linha é o épico inteiro em uma condição.** O autenticador produz um `Autenticado` sempre que a rota exige tenant, e as rotas de admin **não podem** entrar em `ROTAS_SEM_TENANT` (D6: aquela lista dispensa da matriz e define `exigeTenant` ao mesmo tempo). Sem a segunda condição, o painel teria um `Autenticado` com o tenant do cliente — e todos os controladores existentes passariam a servi-lo, cada um chamando `comTenant`, que roda como `mavia_app`, com escrita completa sobre o razão.

**A pool ausente é estado legítimo, não defeito.** Sem `DATABASE_URL_PAINEL`, o `AdminController` não é registrado e nenhuma rota `/v1/admin/` existe. É o mesmo padrão do SMTP e do Google: recusar é melhor que fingir, e uma rota de administração servida por uma pool que não existe é pior que ausente.

**A hipótese vem em cabeçalho, e é pedida antes.** `x-mavia-motivo` e `x-mavia-referencia`, validados por Zod contra a lista fechada antes de qualquer consulta. Três asserções cobrem as três formas de burlar: sem cabeçalho, motivo fora do enum, referência vazia.

**Duas coisas que o teste me obrigou a separar.**

O arreio ganhou `abrirSessao(usuario)`. A asserção de 403 precisava de alguém **com sessão e sem concessão** — sem sessão a resposta é 401, e o teste mediria autenticação em vez de autorização. 401 diz "não entrou"; 403 diz "entrou e não pode", e é o segundo que importa aqui.

E a asserção de que o controlador não chama `comTenant`, `comUsuario` nem `resolverTenant` é sobre o **código**, não sobre a requisição. Uma requisição que passa prova o caminho de hoje; o texto prova que o caminho de amanhã não existe.

**Fora deste ticket:** `RL-ADMIN-BUSCA` não entrou — nenhuma classe de rate limit da matriz está implementada, e o substrato é condição de deploy (C-8, ticket 13). E a rota de baixas anteriores é a quarta tela, do ticket 07.

Verde: typecheck 9/9, lint 9/9, API **565** em 38 arquivos, E2E 23.
