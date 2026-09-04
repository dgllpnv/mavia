# Design — Perfil de administrador

- **Data:** 2026-09-04
- **Status:** Aprovado pelo dono do produto em 2026-09-04, pendente do gate de risco
- **Escopo:** o painel interno de operação da Mavia — quem são os clientes, qual o plano, o que foi pago, e o registro imutável do que o operador fez.
- **Fora de escopo:** MFA (não existe no produto), cobrança automática pela Stripe (P-14), atendimento ao cliente dentro do produto.

---

## Problema

A Mavia está no ar e não tem como ser operada. Não há caminho para responder às perguntas que qualquer SaaS precisa responder no primeiro mês: quem são os clientes, quem pagou, quem está em atraso, e o que fizemos na conta de alguém quando ele reclamar.

Hoje isso só se resolve com `psql` na VPS. Um `UPDATE assinaturas` digitado à mão às onze da noite não tem revisão, não tem registro, e não tem como ser explicado depois.

O risco central não é construir as telas. É que **o painel atravessa o isolamento por RLS que é a espinha do produto** — pela primeira vez, alguém lê o espaço de um cliente sem pertencer a ele.

---

## Decisões do dono do produto

Duas, tomadas em 2026-09-04, registradas com a consequência que foi apresentada antes da escolha.

| # | Pergunta | Decisão | O que ela custa |
|---|---|---|---|
| **DA-1** | O admin enxerga os dados financeiros dos clientes? | **Sim, leitura completa.** Lançamentos, saldos, extrato | Um painel comprometido entrega a vida financeira de toda a base, não só a lista de clientes. É o que torna o §5 deste documento obrigatório e não decorativo |
| **DA-2** | O cliente é avisado quando um admin abre o espaço dele? | **Não.** O registro é interno | A base legal fica em legítimo interesse **sem** o contrapeso da transparência. Se um titular questionar, a resposta disponível é o log — e só ele |

**DA-2 é a que envelhece pior.** Ela é reversível a baixo custo — o dado do log já é o que a tela do titular mostraria —, e este documento a registra como escolha para que reverter seja uma decisão, e não uma descoberta.

---

## O que restringe o desenho

Quatro restrições do próprio projeto, e juntas elas quase ditam a solução.

| Restrição | Onde | Consequência |
|---|---|---|
| O `tenant_id` vem **só** da sessão, nunca da URL. Exceção **exige ADR** | matriz de acesso, R-3 | O admin precisa de uma exceção nomeada, não de um `WHERE` a mais |
| **Nenhum papel que atende requisição tem `BYPASSRLS`** | `sistema.md` §3.9 e §983 | Ler entre espaços não pode ser resolvido com privilégio de banco |
| A `auditoria` já está especificada e **nunca foi construída** | `retencao-e-eliminacao.md` §3, §4, §8 | O log pedido não é tabela nova: é essa, finalmente implementada |
| Não existe MFA | só as colunas em `usuarios` | O admin fica a **uma senha** da base inteira |

---

## Arquitetura

### 1 · O acesso entre espaços, sem furar o isolamento

O admin não ganha um caminho paralelo. Ele usa a máquina que já existe, ao contrário: em vez de contornar a RLS, ele **assume o tenant alvo** por uma transação.

Uma função única e nomeada, `comTenantDeAdmin(alvo, acao, trabalho)`, que numa só transação:

1. confirma em `administradores` que quem chama é admin **e** que a concessão não foi revogada;
2. **grava a linha de `auditoria`**;
3. faz `SET LOCAL app.tenant_id = <alvo>` e executa o trabalho como `mavia_app`.

Nenhuma policy muda. Nenhum papel ganha `BYPASSRLS`. A exceção à R-3 fica confinada a uma função, e daí sai a propriedade que sustenta o resto:

> **Não é possível ler sem registrar, porque as duas coisas são a mesma transação.** Se a escrita do log falhar, a leitura desfaz.

Isso não é disciplina de quem escreve a rota — é consequência do `BEGIN`. Uma rota de admin que "esqueça" de auditar não compila num caminho que funcione: fora de `comTenantDeAdmin` não há como definir `app.tenant_id` de outro espaço.

**Verificação:** a mesma regra de lint que hoje proíbe `withTenant(req.params.…)` ganha uma segunda cláusula — `SET LOCAL app.tenant_id` só pode aparecer em `tenancy.ts` e em `admin/contexto.ts`. Um terceiro lugar reprova o build.

### 2 · Onde o admin mora

```sql
CREATE TABLE administradores (
  usuario_id   UUID PRIMARY KEY REFERENCES usuarios (id),
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  criado_por   UUID REFERENCES usuarios (id),   -- nulo só no primeiro, do provisionamento
  removido_em  TIMESTAMPTZ,
  removido_por UUID REFERENCES usuarios (id)
);
```

Tabela, e não uma coluna `admin BOOLEAN` em `usuarios`. Quem concedeu, quando, e quem revogou é informação auditável por si; uma flag joga essa história fora no momento em que ela passa a importar — que é depois do incidente.

O admin é um usuário normal que **também** aparece aqui. Ele entra pela mesma tela, com a mesma sessão. O que muda é o que o servidor resolve sobre ele.

**O primeiro admin nasce por script de provisionamento na VPS, nunca pela interface.** Tela que cria admin é tela que promove admin, e é o primeiro alvo de quem entra.

### 3 · O log

A `auditoria` do `retencao-e-eliminacao.md`, implementada como ele especifica:

- particionada por mês (`ocorrido_em`), porque a retenção é por `DROP PARTITION`;
- `REVOKE UPDATE, DELETE ON auditoria FROM mavia_app` — **a imutabilidade é do banco**, não da aplicação. O admin lê; nenhum papel de requisição apaga;
- `de`/`para` minimizados na escrita: campo livre e valor entram como **hash + comprimento** (§8.2 do documento de retenção), nunca em claro;
- `ip_hash` e `user_agent_hash` por HMAC com o pepper do guardião (achado A-39), como o resto do produto já faz.

Três classes de evento, com os prazos que o documento de retenção já fixou:

| Classe | Exemplo no painel | Prazo |
|---|---|---|
| leitura em massa | admin abriu o espaço de um cliente | 12 meses |
| escrita financeira | mudou plano, deu baixa em pagamento | 90 dias na tela · 5 anos internos |
| segurança | concedeu ou revogou admin | 5 anos |

Isto fecha a **regra 18 do `CLAUDE.md`** — *"audit log append-only em toda escrita financeira"* —, que está escrita desde o primeiro dia e nunca saiu do papel.

**O que este documento não decide:** o job de retenção que executa os prazos (`DROP PARTITION`, anonimização por `mavia_retencao`). Ele é da §4 do documento de retenção, tem papel de banco próprio, e é trabalho separado. Enquanto não existir, a auditoria **cresce sem expurgo** — o que é seguro e é dívida declarada, não esquecimento.

### 4 · O que o admin faz

| Ação | O que toca | Classe no log |
|---|---|---|
| Listar e buscar clientes | `tenants`, `usuarios`, `assinaturas` | — (não é dado de espaço) |
| Ver o perfil de um cliente | assinatura, plano, uso, cotas, membros | leitura em massa |
| Abrir o espaço em leitura | tudo, sob `comTenantDeAdmin` | leitura em massa |
| Trocar plano ou intervalo | `assinaturas.plano`, `.intervalo` | escrita financeira |
| Adicionar tempo | `assinaturas.periodo_fim` | escrita financeira |
| Dar baixa em pagamento | `assinaturas.estado`, `.periodo_fim`, `.graca_ate` | escrita financeira |
| Cadastrar cliente novo | usuário + espaço + vínculo + assinatura, numa transação | escrita financeira |
| Ler o próprio log | `auditoria` | — |

**"Dar baixa" é registro, não cobrança.** A Stripe não está ligada (P-14): o dinheiro entra por fora, e a baixa é o operador declarando que entrou. Quando a P-14 fechar, a baixa manual continua existindo — ela é o caminho para o pagamento que a operadora não viu.

**A listagem não passa por `comTenantDeAdmin`.** Ela lê `tenants`, `usuarios` e `assinaturas` — tabelas de conta, não de dinheiro — por uma consulta própria, e não abre espaço nenhum. Sem essa separação, listar cem clientes geraria cem eventos de leitura em massa e o log viraria ruído.

### 5 · O que compensa a ausência de MFA

Com DA-1, o admin lê a base inteira, e sem MFA ele está a uma senha disso. Nada abaixo substitui MFA; o que segue reduz a janela.

1. **Sessão de admin curta.** O privilégio de admin é resolvido a cada requisição contra `administradores`, e não carimbado no token: revogar tem efeito no próximo pedido, não na próxima renovação.
2. **Reautenticação por senha nas escritas.** Trocar plano, dar baixa e cadastrar exigem a senha de novo. É o mecanismo que a matriz já declara em `exigeReautenticacao` e que **hoje não é aplicado por ninguém** — este épico é quem o implementa.
3. **O log é a rede.** Não previne; é o que permite responder "o que essa conta fez" depois.

**MFA para admin fica registrado como a próxima dívida deste épico**, e é a única que muda a natureza do risco em vez do tamanho dele.

### 6 · As telas

`/admin`, fora do grupo de rotas `(app)` e com layout próprio — a interface do operador nunca deve poder ser confundida com a do cliente.

| Rota | O que mostra |
|---|---|
| `/admin` | Clientes: espaço, titular, plano, estado, vence em, uso. Busca por nome ou e-mail |
| `/admin/clientes/:id` | O perfil: assinatura e as ações; membros; e o botão de abrir o espaço |
| `/admin/registro` | O log, filtrável por cliente, ação e período |

Seguem `docs/design.md`: sem card em tudo, tipografia conduzindo, algarismos tabulares em coluna de valor, e a auditoria da §5 rodada antes da entrega.

---

## Modelo de dados — o que é novo

```
administradores        usuario_id, criado_em, criado_por, removido_em, removido_por
auditoria (partic.)    id, ocorrido_em, tenant_id, usuario_id, entidade, entidade_id,
                       acao, classe, de, para, ip_hash, user_agent_hash
pagamentos_manuais     id, tenant_id, registrado_por, registrado_em, valor_centavos,
                       moeda, competencia, observacao
```

`pagamentos_manuais` existe para que a baixa seja um **fato**, e não só uma mudança de estado em `assinaturas`. Sem ela, "por que o período foi estendido até março?" não tem resposta no banco — só uma linha de auditoria descrevendo um `UPDATE`.

Valor em **centavos inteiros** com moeda ISO, como todo dinheiro do produto (regra 1).

---

## Erros e bordas

| Situação | Resposta |
|---|---|
| Não-admin em qualquer rota `/admin` | 404, e não 403. Um 403 confirma que o painel existe |
| Admin revogado com sessão viva | Próxima requisição já recusa — o privilégio não vive no token |
| Espaço inexistente | 404, com o mesmo corpo do caso acima |
| Escrita sem reautenticação | 401 com marcador próprio, para a tela pedir a senha |
| Falha ao gravar auditoria | A transação inteira desfaz. Nenhuma leitura e nenhuma escrita sobrevivem a um log que não gravou |

---

## Testes

| Nível | O que prova |
|---|---|
| Integração (Postgres real) | **Um não-admin não alcança nada** — a prova principal, repetida rota a rota |
| Integração | Toda leitura por `comTenantDeAdmin` deixa exatamente uma linha de auditoria |
| Integração | `mavia_app` leva `permission denied` ao tentar `UPDATE` ou `DELETE` em `auditoria` |
| Integração | Admin revogado perde acesso na requisição seguinte, sem renovar sessão |
| Integração | A transação desfaz quando a auditoria falha — sabotagem deliberada do insert |
| Domínio | Adicionar tempo e trocar plano respeitam a máquina de estados de `assinaturas` |
| Domínio | Rateio e datas do período em `[inicio, fim)`, como toda janela |
| E2E | Entrar como admin, achar um cliente, mudar o plano, e ver a linha no registro |

---

## O que este épico deliberadamente não faz

- **MFA.** Reconhecido no §5 como a dívida que muda a natureza do risco.
- **O job de retenção da auditoria.** A tabela nasce particionada e pronta para ele; ele é trabalho próprio, com papel de banco próprio.
- **Atendimento dentro do produto.** O admin não responde ticket, não conversa com cliente, não recupera conta — a DP-25 do spec de autenticação continua valendo: *não existe canal humano de recuperação*.
- **Editar dado financeiro do cliente.** O admin **lê** o espaço; ele não corrige lançamento de ninguém. Corrigir dado alheio sem o titular saber é o que transforma um painel de operação num incidente.
- **Aviso ao titular.** Decisão DA-2. Reversível.
