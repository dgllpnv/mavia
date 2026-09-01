# ADR 0004 — SaaS multi-tenant com Row-Level Security no Postgres

- **Status:** Aceita
- **Data:** 2026-09-01

## Contexto

A Mavia é um SaaS público de finanças pessoais: cadastro aberto, planos por assinatura, e no futuro compartilhamento familiar (vários usuários por espaço de dados). O dado tratado é financeiro e pessoal — a categoria mais sensível fora de saúde. Vazamento entre clientes é uma falha da qual um produto financeiro não se recupera.

Um banco por cliente é inviável em uma VPS com centenas ou milhares de assinantes.

## Decisão

Banco único, isolamento lógico por `tenant_id`, com **Row-Level Security do PostgreSQL como primeira camada de defesa**.

- Toda tabela de negócio tem `tenant_id NOT NULL` e uma policy de RLS.
- A conexão da aplicação roda sob um papel **sem** `BYPASSRLS`.
- O `tenant_id` da requisição é definido na sessão do banco por transação.
- A aplicação **também** filtra por tenant — segunda camada, porque a primeira pode falhar em silêncio.
- Identificadores expostos são não sequenciais.
- `Tenant` é a unidade de isolamento e de assinatura; `Usuario` pertence a um ou mais tenants com um `Papel`.

Teste obrigatório: todo teste de integração de recurso cria dois tenants e prova que um não enxerga o outro. Contra Postgres real via Testcontainers — RLS não pode ser mockada.

## Consequências

**Positivas.** Uma consulta esquecida de filtrar não vaza dado, porque o banco recusa. Custo de infraestrutura proporcional ao uso, não ao número de clientes. Migration única. O modelo `Tenant` já acomoda compartilhamento familiar e billing sem refatoração.

**Negativas.** RLS adiciona sobrecarga de planejamento em consultas quentes — exige índices que iniciem por `tenant_id`. Errar a configuração da sessão do tenant é uma falha silenciosa e perigosa, o que torna o teste de isolamento obrigatório, não opcional. Trabalho administrativo (migrations, jobs) precisa de caminho explícito e auditado para operar entre tenants.

## Alternativas rejeitadas

**Schema por tenant.** Isolamento mais forte, mas milhares de schemas tornam migration e conexões impraticáveis.

**Banco por tenant.** Isolamento máximo, custo e operação incompatíveis com uma VPS e com o preço-alvo do produto.

**Apenas filtro na aplicação.** É o modelo mais comum e a origem mais comum de vazamento entre clientes. Uma consulta esquecida basta. Rejeitado.
