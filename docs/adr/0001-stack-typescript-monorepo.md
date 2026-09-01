# ADR 0001 — Monorepo TypeScript para toda a stack

- **Status:** Aceita
- **Data:** 2026-09-01

## Contexto

A Mavia precisa de API, web e apps Android/iOS, mantidos por um time pequeno, hospedados numa única VPS com orçamento apertado. As regras monetárias (rateio, ciclo de fatura, sinal, partida dobrada) precisam ser idênticas nos três clientes — divergência entre plataformas em cálculo de dinheiro é a pior classe de bug possível neste produto.

## Decisão

Monorepo TypeScript com Turborepo e pnpm.

- `apps/api` — NestJS sobre Fastify, PostgreSQL, Drizzle ORM, BullMQ/Redis
- `apps/web` — Next.js App Router
- `apps/mobile` — Expo (ver ADR 0002)
- `packages/domain` — regras monetárias puras, sem I/O e sem framework
- `packages/contracts` — schemas Zod, gerando tipos e OpenAPI
- `packages/ui` — tokens e primitivos compartilhados

Regra de dependência: `domain` não importa nada; `contracts` importa `domain`; os apps importam ambos. Nunca o inverso, nunca app para app.

## Consequências

**Positivas.** A regra monetária existe uma vez e é testada uma vez. Mudança de contrato de API quebra o typecheck de web e mobile imediatamente, em vez de virar bug em produção. Uma linguagem só reduz o custo cognitivo do time e o número de especialistas necessários. Deploy leve na VPS.

**Negativas.** O monorepo exige disciplina de fronteira — sem ela vira uma bola de lama com passos extras. Node é mais pesado em memória que Go. TypeScript não tem o ecossistema financeiro maduro de Java, o que significa implementar `Money` e afins em vez de adotar biblioteca consagrada — mitigado por property-based testing rigoroso (ver ADR 0005).

## Alternativas rejeitadas

**Java/Kotlin + Spring Boot.** Padrão do mercado financeiro brasileiro e ecossistema maduro, mas a JVM pesa na VPS e a stack não se compartilha com mobile e web — os modelos seriam duplicados em três lugares, exatamente o risco que se quer evitar.

**Go.** Excelente consumo de recursos e throughput, mas obriga a reimplementar domínio no frontend e no mobile, e o ecossistema financeiro brasileiro é menor.

**Python + FastAPI.** Forte para a camada de IA e parsing de extratos, mais fraco para garantias de tipo em regra monetária e para concorrência. A camada de IA pode ser um serviço isolado no futuro sem exigir que todo o backend seja Python.
