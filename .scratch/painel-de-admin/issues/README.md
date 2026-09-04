# Painel de administração — ordem de execução

Doze tickets, escritos contra `docs/superpowers/specs/2026-09-04-perfil-de-admin-design.md` **v3.2** e `docs/adr/0024-acesso-administrativo-entre-espacos.md` (aceita). O gate de risco está completo, sem objeção de ticket aberta: appsec aprovado com condições (C-1 a C-5 fechadas na v3.1), LGPD com O-2 fechada na v3.2, financeiro com F-1 a F-14 fechados.

Todos os arquivos estão em `ready-for-agent`.

---

## Grafo de bloqueio

```
01 papeis-e-pools ──┬─→ 03 retencao-execucoes-e-auditoria ──┬─→ 04 concessoes-de-admin ─┐
                    │                                       │                            │
                    └───────────────────────────────────────┴────────────────────────────┴─→ 05 funcoes-de-admin
02 guard-global ────────────────────────────────────────────────────────────────────────────────────┐
                                                                                                     │
05 ─┬─→ 06 rotas-de-leitura ←────────────────────────────────────────────────────────────────────────┘
    │
    ├─→ 08 cortesia-e-prorrogacao ─→ 07 pagamentos-manuais ─┬─→ 09 cadastrar-cliente
    │                                                        └─→ 11 exportacao-em-parte
    └─→ 10 registro-e-notificacao

06, 07, 08, 09, 10 ─→ 12 telas
```

| NN | Fatia | Blocked by | Migration (ordem recomendada) |
|---|---|---|---|
| 01 | `papeis-e-pools` | — | `0029_papeis_do_painel.sql` |
| 02 | `guard-global` | — | — |
| 03 | `retencao-execucoes-e-auditoria` | 01 | `0030_auditoria.sql` |
| 04 | `concessoes-de-admin` | 03 | `0031_concessoes_de_admin.sql` |
| 05 | `funcoes-de-admin` | 01, 03, 04 | `0032_funcoes_de_admin.sql` |
| 06 | `rotas-de-leitura` | 02, 05 | — |
| 07 | `pagamentos-manuais` | 05, **08** | `0034_pagamentos_manuais.sql` |
| 08 | `cortesia-e-prorrogacao` | 05 | `0033_assinatura_cortesia_e_origem.sql` |
| 09 | `cadastrar-cliente` | 05, 07 | `0035_admin_cadastrar_cliente.sql` |
| 10 | `registro-e-notificacao` | 03, 05 | `0036_admin_ler_registro.sql` |
| 11 | `exportacao-em-parte` | 07 | — |
| 12 | `telas` | 06, 07, 08, 09, 10 | — |

**Sobre a numeração de migration.** O próximo número livre hoje é **0029** (a última é `apps/api/migrations/0028_rls_em_eventos_de_cobranca.sql`). A coluna acima é a alocação sob a **ordem de execução recomendada**; o número real é o próximo livre **no momento do merge**, e dois tickets que rodem em paralelo não devem reservar o mesmo. Migrations são forward-only: **privilégio que falta nasce na migration que cria a tabela**, nunca por edição de uma migration aplicada — é por isso que os `GRANT` sobre `auditoria`, `concessoes_de_admin`, `pagamentos_manuais` e as colunas novas de `assinaturas` estão espalhados pelos tickets 03, 04, 07 e 08 em vez de todos no 01.

---

## O que pode correr em paralelo

| Onda | Tickets | Observação |
|---|---|---|
| 1 | **01** e **02** | Independentes. 02 é a mudança de maior raio de alcance do épico — liga o `APP_GUARD` para as 22 rotas de controlador — e não depende de banco. Comece os dois juntos. |
| 2 | **03** | Sozinho. É a fundação do log e a migration mais densa. |
| 3 | **04** | Sozinho. |
| 4 | **05** | Sozinho. Fecha a família de leitura e o mecanismo de lista fechada. |
| 5 | **06**, **08**, **10** | Três frentes: rotas de leitura, colunas de `assinaturas` + cortesia, registro + notificação + rate limit. Nenhuma toca o que a outra toca. |
| 6 | **07** | Depende de 08 (ver abaixo). |
| 7 | **09** e **11** | Independentes entre si. |
| 8 | **12** | Telas e E2E. |

Caminho crítico: **01 → 03 → 04 → 05 → 08 → 07 → 09 → 12** (oito tickets em série).

---

## Onde eu discordo do corte — três achados

O corte é bom, e três coisas nele não fecham como escritas. Estão registradas aqui e nos tickets afetados, não corrigidas em silêncio.

### 1 · `07` não pode correr em paralelo com `08` (corrigido no ticket)

**A tabela do épico dá `07 · Blocked by: 05`.** Mas `admin.registrar_pagamento` escreve `origem_da_ultima_escrita` (§8.6, F-15, e a asserção *"toda escrita de contrato deixa `origem_da_ultima_escrita = 'painel'`"*), e essa coluna nasce no `ALTER TABLE assinaturas` da §Modelo de dados — que a tabela de fatias atribuiu ao **08**. Migration é forward-only: ou 08 vem antes, ou o `ALTER` migra para 07.

**Escolhi reordenar:** `07 · Blocked by: 05, 08`. Preserva a decisão de escopo do dono e o desenho do spec (as três colunas novas de `assinaturas` numa migration só). **Custa a paralelização de 07 com 08.** Se o dono preferir mantê-los paralelos, o conserto é mover `origem_da_ultima_escrita` **e** o `CREATE OR REPLACE` de `auth.aplicar_estado_da_assinatura` para a migration do 07, e 08 fica só com `cortesia_ate`, a `CHECK` e o gatilho.

### 2 · A asserção "o esquema `admin` contém exatamente as oito funções" não tem dono possível como escrita

As oito funções de §8.0 nascem em **cinco** tickets (05, 07, 08, 09, 10). Um teste de igualdade contra oito ficaria vermelho em quatro deles, e um teste que passa vermelho por quatro merges é um teste que alguém desliga.

**A forma normativa que os tickets adotam** (declarada no 05 e usada por 07, 08, 09 e 10): uma constante `FUNCOES_DE_ADMIN: ReadonlyMap<string, 'definer' | 'contrato'>` no arquivo de teste, e a asserção é de **igualdade contra ela**. Cada ticket acrescenta **uma linha** junto com a função. A igualdade vale em todo ponto da sequência, e uma nona função não declarada derruba o teste em qualquer um deles — que é exatamente o que a saída B do S3-4 quer, e sem a janela de quatro merges sem cobertura.

### 3 · O `§8.5` do ticket 10 é do 07, do 08 e do 09 — e o 10 não depende deles

A tabela do épico dá ao **10** *"a segunda linha de auditoria com `de/para` e `correlacao` (§8.5)"*, com `Blocked by: 03, 05`. Mas quem **grava** a segunda linha é cada função de contrato, e essas estão em 07, 08 e 09.

**Como ficou:** a coluna `correlacao` é do **03** (é da tabela); a linha de **intenção** e a geração/devolução da `correlacao` são do **05** (é `abrir_espaco_para_escrita`); a linha de **efeito** é de cada função de contrato, em 07, 08 e 09; e o **10** fica com **ler o par** — a projeção de `GET /v1/admin/registro` que devolve `de`, `para` e `correlacao`, e a asserção de que uma linha de intenção sem linha de efeito é legível como escrita que falhou. O bloqueio de 10 fica como decidido; o que muda é que a tela do registro só exibe um par de verdade depois que 07 estiver mergeado. É ordenação, não bloqueio.

---

## O que ficou fora das doze fatias

**Duas asserções da seção Testes do spec não têm ticket aqui**, e as duas são condição de deploy do `sre-devops-vps`, não de implementação:

| Asserção | Origem | Onde deveria morar |
|---|---|---|
| `E2E · Requisição a /admin de origem fora da allowlist é recusada antes da aplicação` | §6.1 · **C-6** | Ticket de infraestrutura: allowlist de IP ou mTLS no Traefik. **Sem ele o painel não sobe** — é o pressuposto das outras quatro compensações do MFA, não uma delas |
| `Integração · A ACL do Redis permite os cinco prefixos em uso e recusa CONFIG SET, FLUSHALL e KEYS` | §6.2 · **C-7** | Mesmo ticket. Os cinco prefixos: `sess:`, `acessos:`, `oauth:`, `tentativas:`, `bull:`. **Uma ACL que esqueça `tentativas:` desliga o limite de tentativas de login** |

**Recomendo um ticket 13, `condicoes-de-deploy`**, para o `sre-devops-vps`, carregando C-6, C-7, o valor numérico de C-8, o provisionamento de credencial de C-9 e a conferência de C-10. Não o criei porque não estava nas fatias decididas.

**Também não têm ticket, e é por desenho:** o job de retenção da auditoria (dívida datável), o log fora da máquina, o MFA, a troca de plano (DP-40), o cálculo de reembolso, o job que expira assinatura, e o nível intermediário de acesso.

---

## Decisões pendentes que atravessam o épico

Nenhuma bloqueia um ticket. **DP-39 bloqueia o deploy.**

| # | Padrão vigente que os tickets implementam | Onde | Se o dono responder diferente |
|---|---|---|---|
| **DP-32** | MFA antes do primeiro cliente pagante; sem escolha, o painel não vai a produção com cliente real | 02, 04, 12 | O degrau "operar com um administrador só" reabre no mesmo ato, e a LIA da §8.1.1 volta à mesa |
| **DP-33** | Janela de 30 min por `motivo` + `referencia` + operador | 05, 06, 10 | Muda o atrito do operador; **não muda nenhum controle** — a reconciliação de §5 é normativa |
| **DP-34** | Notificação entre pares com destino **externo** ao painel | 10 | *"A LIA da §8.1.1 precisa ser refeita"* — e ela sustenta a **DA-1 inteira**. Reabre o balanceamento que autoriza o épico |
| **DP-36** | A baixa restabelece o direito de uso, na mesma transação | 07 | A tela passa a **recusar** a baixa de quem está `em_atraso`, e passam a existir dois atos onde há um pagamento |
| **DP-37** | Competência do recebimento, uma linha, sem rateio | 07 | Volta a divisão ao caminho do dinheiro: `59000/12` e `79000/12` não são exatos, e vêm `ratear`, a regra 3 e a prova por propriedade junto |
| **DP-38** | `pagamentos_manuais` contém só dinheiro que entrou; cortesia é **tempo** | 07, 08 | Ver a divergência abaixo |
| **DP-39** | **Sem padrão.** A coluna `origem_da_ultima_escrita` entra nos dois casos | 08 | **F-15 não fecha e o painel não alcança cliente real (C-11)** |
| **DP-40** | O painel não troca plano nem intervalo | 05, 07, 08, 12 | Uma função nova, não uma mudança de topologia — mas os pré-requisitos são do **épico 11**: preço contratado persistido e agendamento de downgrade |

### Divergência viva com `docs/decisoes-do-produto.md`

O índice de decisões **já registra** DP-36 a DP-40 (`:139-143`), com o texto do **parecer financeiro** — que é anterior à revisão do spec. Duas linhas divergem do que os tickets implementam:

- **DP-38** (`:141`) registra a forma **fraca**: *"`valor_centavos = 0` obrigatório e o valor dispensado em campo próprio"*. O spec v3.2 a **rejeita por escrito**: ela resolve o total e **não** resolve a exportação — uma linha de R$ 0,00 continua saindo ao titular como um pagamento que ele não fez, que é a objeção do próprio parecer. Os tickets 07 e 08 implementam o spec: enum de quatro valores, cortesia como tempo.
- **DP-40** (`:143`) registra *"o painel agenda para o fim do período, pelo mesmo caminho da rota do cliente"*. O spec **concorda com a regra e discorda do prazo**, verificado: `cobranca.controller.ts:127-131` devolve `fim_do_periodo` e **não persiste nada** — não há caminho a chamar. Os tickets implementam o spec: a ação sai do épico.

**Ação do coordenador:** atualizar as duas linhas de `docs/decisoes-do-produto.md` para o padrão da v3.2. Nenhum ticket faz isso — não tocamos `docs/`.

### Divergência viva com `docs/compliance/retencao-e-eliminacao.md`

A política de retenção está sendo editada em paralelo, como o spec avisa. A **§4.4.1** dela (regra **R-31**, o "gêmeo anonimizado") é posterior ao texto de §3.2 do spec e acrescenta ao caminho de eliminação: o mecanismo é `INSERT` do gêmeo e depois `DELETE` do original, o que exige **`GRANT INSERT ON auditoria TO mavia_eliminacao`** — um sexto papel com `INSERT` na tabela.

O ticket **03** carrega esse `GRANT` e nomeia a exceção no teste dos cinco papéis. A **R-31 bloqueia o deploy** de qualquer um dos dois caminhos — painel em produção ou `DELETE /tenants/:id` — que subir por último; ela **não** bloqueia o ticket.

---

## Regra que vale para todos os tickets que criam `GRANT`

`bootstrap-papeis.sql:36-44` documenta por extenso: **um `GRANT` executado por quem não é dono nem tem `grant option` não falha.** Ele devolve `GRANT` com `WARNING: no privileges were granted`, a transação segue, **a migration reporta sucesso e o privilégio não existe.**

Duas consequências normativas, em 01, 03, 04, 05, 07, 08 e 09:

1. Todo `GRANT` roda como **`mavia_migrate`**, dono do esquema `public` (`bootstrap-papeis.sql:45`) e o único papel que roda migration.
2. **Nenhum privilégio é dado como concedido porque a migration passou.** Quem transforma a omissão em falha visível são os testes de esquema — `information_schema.role_table_grants`, `information_schema.column_privileges`, `has_schema_privilege` — e o teste de integração que roda cada função **contra o esquema recém-migrado**, na primeira execução.

E `bootstrap-papeis.sql:51` faz `REVOKE ALL ON SCHEMA public FROM PUBLIC` **de propósito**: a máscara foi removida para que a falta de concessão apareça no teste em vez de aparecer no dia de endurecer a produção. Sem `USAGE` de esquema nominal, todo `SELECT` dos papéis novos devolve `permission denied for schema public` — **e a migration continua verde.**

---

## Antes de dizer que qualquer um deles está pronto

`pnpm typecheck && pnpm test`. Sem exceção. E, para os tickets de banco, a suíte de integração roda contra **Postgres real** — RLS não pode ser mockada.
