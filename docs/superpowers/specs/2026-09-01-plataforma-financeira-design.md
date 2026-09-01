# Design — Plataforma Mavia de controle financeiro

- **Data:** 2026-09-01
- **Status:** Aprovado
- **Escopo deste documento:** a estrutura de trabalho (time, pipeline, decisões fundadoras). **Não** é o spec de nenhuma feature — cada épico terá o seu, produzido por `/to-spec`.

## Problema

Construir um SaaS de controle financeiro pessoal equivalente ao Organizze, auto-hospedado em VPS, com web e apps Android e iOS, incluindo caminho para Open Finance. O trabalho é grande demais para uma sessão de agente e envolve um domínio (dinheiro) onde erro silencioso é inaceitável.

O risco central não é técnico, é de processo: sem estrutura, sessões sucessivas de agente produzem decisões inconsistentes, vocabulário divergente e uma base de código onde ninguém sabe se o saldo está certo.

## Estudo do concorrente

Organizze, funcionalidades observadas: contas (corrente, digital, PJ), cartões com faturas centralizadas, categorias e subcategorias personalizáveis, categorização automática por IA, leitura de recibo por foto, limites de gasto por categoria, alertas de contas a pagar, relatórios com gráficos e comparação de períodos, conexão via Open Finance com 90 dias de histórico e até seis sincronizações diárias, integração com agentes de IA. Planos: Manual R$ 35, Conectado R$ 45 (3 contas), Conectado Plus R$ 69 (10 contas, suporte a PJ). Teste de 7 dias.

Achado que condiciona a arquitetura: acesso direto ao Open Finance exige autorização do Banco Central, e agregadores custam na ordem de milhares de reais mensais desde o primeiro mês. Ver ADR 0003.

## Decisões fundadoras

| # | Decisão | ADR |
|---|---|---|
| 1 | Monorepo TypeScript: NestJS + Fastify, Next.js, Postgres, Drizzle | [0001](../../adr/0001-stack-typescript-monorepo.md) |
| 2 | Mobile em React Native com Expo, offline-first | [0002](../../adr/0002-mobile-react-native-expo.md) |
| 3 | `BankSyncProvider` como seam único; OFX/CSV primeiro, agregador depois | [0003](../../adr/0003-banksyncprovider.md) |
| 4 | SaaS multi-tenant com Row-Level Security no Postgres | [0004](../../adr/0004-saas-multi-tenant-rls.md) |
| 5 | Dinheiro em centavos inteiros; transferência por partida dobrada; saldo derivado | [0005](../../adr/0005-dinheiro-centavos-partida-dobrada.md) |
| 6 | Identidade visual autoral, recusa explícita à estética genérica de IA | [0006](../../adr/0006-identidade-visual-autoral.md) |

## Arquitetura

```
apps/api · apps/web · apps/mobile
packages/domain (puro) · packages/contracts (Zod) · packages/ui
infra/ (docker-compose, Traefik, backup, observabilidade)
```

Regra de dependência: `domain` não importa nada; `contracts` importa `domain`; apps importam ambos. Nunca o inverso, nunca app para app.

## Time

14 especialistas, detalhados em [`docs/team.md`](../../team.md), definidos em `.claude/agents/`.

Agrupados em seis fases: domínio (3), arquitetura (1), gate de risco (2), construção (4), qualidade (3), operação (1).

O princípio de composição: os papéis caros e lentos entram cedo (domínio, risco), os rápidos entram tarde (revisão). O gate de risco — segurança, LGPD e validação financeira revisando o **spec** e não o pull request — é a decisão de processo mais importante deste documento.

## Pipeline

Detalhada em [`docs/pipeline.md`](../../pipeline.md).

```
/grill-me → /to-spec → 🚦 gate de risco → /to-tickets → /tdd → /implement
         → /code-review → validador-financeiro → deploy
```

Fase 0, uma vez: `/setup-matt-pocock-skills` → `/wayfinder` → `/grill-with-docs` → esqueleto e ambiente.

## Testes

Property-based obrigatório para toda aritmética monetária. Postgres real via Testcontainers para RLS — RLS não pode ser mockada. Testes apenas em seams acordados com o arquiteto de solução.

## Roadmap

Doze épicos, ordenados por dependência e risco, listados em `docs/pipeline.md`. O épico 12 (Open Finance) depende do épico 6 (importação) porque, com o `BankSyncProvider` já existindo, plugar um agregador é adicionar um adapter — não uma reescrita.

## Fora de escopo neste documento

Specs de feature, modelagem detalhada de tabelas, escolha de tipografia e paleta (produto do processo de três direções em `docs/design.md`), precificação dos planos, e a decisão sobre qual agregador de Open Finance adotar no épico 12.

## Próximo passo

`/wayfinder` para transformar o roadmap num mapa de tickets de decisão, e resolvê-los um a um até a rota ao MVP ficar clara.
