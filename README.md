# Mavia

Plataforma de controle financeiro pessoal — SaaS multi-tenant, auto-hospedado em VPS, com aplicação web e apps nativos para Android e iOS.

> **Status: especificação.** Ainda não existe código de produto neste repositório. O que está aqui é a especificação completa — domínio, arquitetura, produto, design, segurança e conformidade — já submetida a um gate de revisão e corrigida. A primeira linha de código começa pelo épico 1 do roadmap.

---

## Por que a especificação vem primeiro

O domínio é dinheiro real de pessoas reais. Um defeito aqui não é um bug de interface: é o saldo errado na conta de alguém.

A revisão de risco acontece sobre o **spec**, não sobre o pull request. Nesta rodada ela reprovou a especificação com 23 bloqueios financeiros, mais bloqueios de segurança e de LGPD — todos corrigidos antes de qualquer implementação. Um exemplo do que esse gate encontrou:

Duas regras de rateio incompatíveis conviviam em documentos já aceitos. Uma mandava o resto da divisão para a primeira parcela, a outra distribuía uma unidade por parcela. Em R$ 100,00 divididos em 7 vezes, a diferença é de R$ 0,03 na primeira parcela. **As duas somam exatamente R$ 100,00**, então nenhum teste de soma as distingue — e em 3 vezes produzem resultados idênticos, que é justamente o exemplo com que todo mundo confere. A propriedade que separa as duas é `max(partes) − min(partes) <= 1`.

Encontrar isso em documento custou uma rodada de correção. Encontrar em produção custaria a confiança do cliente.

---

## Mapa do repositório

| Caminho | O que é |
|---|---|
| `CLAUDE.md` | Regras inegociáveis do domínio, convenções e fluxo de trabalho. **Leia antes de tudo.** |
| `CONTEXT.md` | Linguagem ubíqua: glossário, invariantes por entidade e termos proibidos |
| `docs/adr/` | Decisões arquiteturais. Uma ADR aceita não se re-litiga em conversa — substitui-se por outra |
| `docs/arquitetura/sistema.md` | Módulos, seams de teste, modelo de dados, superfície de API, jobs |
| `docs/produto/arquitetura-informacao.md` | Navegação, inventário de telas e critérios de aceite |
| `docs/design/` | Direção visual, tokens e a prévia navegável |
| `docs/seguranca/matriz-de-acesso.md` | 115 rotas em papel × ação × recurso |
| `docs/compliance/retencao-e-eliminacao.md` | 55 classes de dado pessoal com prazo, base legal e ação |
| `docs/validacao/` | Os laudos dos gates de risco, com os contraexemplos |
| `docs/pesquisa/` | Teardown do concorrente |
| `docs/decisoes-do-produto.md` | Índice das escolhas do dono do produto, com data e onde está a justificativa |
| `docs/pipeline.md` · `docs/team.md` | Como o trabalho flui e quem decide o quê |

---

## Decisões que moldam tudo

Detalhe completo em `docs/adr/`.

**Monorepo TypeScript** (ADR 0001) — NestJS e Fastify na API, Next.js na web, PostgreSQL com Drizzle. Uma linguagem do banco ao app, para que a regra monetária exista uma vez só.

**Expo para mobile** (ADR 0002) — Android e iOS de uma base, offline-first. O momento de maior valor do produto é lançar uma despesa no instante do gasto, e isso não pode depender de rede.

**`BankSyncProvider` como seam único** (ADR 0003) — nenhum código de aplicação conhece um agregador concreto. Acesso direto ao Open Finance exige autorização do Banco Central, e agregadores custam milhares de reais por mês desde o primeiro. Lançamos com importação de arquivo; plugar um agregador vira um arquivo novo, não uma reescrita.

**Row-Level Security no PostgreSQL** (ADR 0004) — o banco recusa a consulta que esqueceu de filtrar por cliente. O filtro na aplicação é a segunda camada, nunca a única.

**Dinheiro em centavos inteiros e partida dobrada** (ADR 0005) — nunca ponto flutuante. Transferência é sempre duas pernas somando zero, e pagamento de fatura é transferência, não despesa. Contá-lo como despesa duplicaria o gasto do mês, que é o erro clássico desta categoria de produto.

**Identidade visual autoral** (ADR 0006) — direção "papel e trilho", sobre fundo claro. Herdamos a organização e a densidade dos bons produtos da categoria; a linguagem visual é própria.

---

## Roadmap

Doze épicos, ordenados por dependência e risco. Detalhe em `docs/pipeline.md`.

O MVP vai até o épico 5: fundação, núcleo de lançamentos, cartão de crédito com ciclo de fatura correto, web e mobile — tudo manual. A importação de extrato entra no épico 6 e é o primeiro incremento de retenção. A conexão bancária automática é o épico 12, e depende de o faturamento cobrir o custo do agregador.

---

## Convenções

- **Dinheiro é `bigint` de centavos.** Nunca `number`, nunca `float`, nunca `NUMERIC` implícito.
- **Toda soma monetária passa pelo módulo de agregação.** Existe regra de lint para isso.
- **Teste só em seam acordado.** São seis, listados em `docs/arquitetura/sistema.md`.
- **Property-based obrigatório** onde há aritmética monetária. A soma não basta como propriedade.
- **Nada é dado como pronto sem a saída do comando colada.** Teste que não foi executado não passou.
- **Toda decisão não-óbvia vira ADR.** Contradizer uma ADR aceita exige outra que a substitua.
