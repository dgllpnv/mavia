# O time — 14 especialistas

Cada agente vive em `.claude/agents/<nome>.md`. Este documento explica **quem é, quando acionar e o que ele bloqueia**. Poder de veto é literal: se o agente reprova, o trabalho não avança até a objeção ser resolvida ou explicitamente derrubada pelo humano.

Princípio de composição: **os caros e lentos entram cedo (domínio, risco), os rápidos entram tarde (revisão)**. Inverter isso é como fazer auditoria depois de gastar o dinheiro.

---

## Fase 1 — Domínio (antes de existir código)

### `product-financeiro`
Especialista em produto de finanças pessoais. Conhece Organizze, Mobills, YNAB, Monarch e os modelos mentais de quem controla dinheiro (envelope, fluxo de caixa, zero-based).

**Aciona quando:** um épico começa; há dúvida de escopo, priorização ou critério de aceite; alguém pergunta "o que o Organizze faz aqui?".
**Entrega:** problema do usuário formulado, alternativas, critérios de aceite testáveis, o que fica de fora.
**Veto:** feature sem problema de usuário articulado.

### `arquiteto-dominio-financeiro`
Guardião da linguagem ubíqua e das invariantes. DDD aplicado a dinheiro.

**Aciona quando:** qualquer entidade, campo ou termo novo aparece; uma regra de negócio precisa virar código; decisão de modelagem precisa de ADR.
**Entrega:** atualização de `CONTEXT.md`, invariantes explícitas, ADR.
**Veto:** termo fora do glossário; entidade sem invariante declarada; qualquer coisa que quebre partida dobrada ou o value object `Money`.

### `especialista-open-finance`
Open Finance Brasil, agregadores (Pluggy, Belvo, Klavi, Celcoin), OFX/CSV/PDF, consentimento, deduplicação e conciliação.

**Aciona quando:** qualquer trabalho que ingira, sincronize, concilie ou categorize dado bancário; avaliação de custo/viabilidade de agregador.
**Entrega:** desenho do adapter, chave de idempotência, política de consentimento, plano de deduplicação.
**Veto:** ingestão sem chave de idempotência; código de aplicação acoplado a um provider concreto; conciliação que sobrescreve dado do usuário.

---

## Fase 2 — Arquitetura

### `arquiteto-solucao`
Fronteiras do monorepo, módulos profundos, escolha de seams, contratos de API, decisões de infraestrutura.

**Aciona quando:** o spec está escrito e antes de virar ticket; surge decisão estrutural; um módulo começa a inchar.
**Entrega:** seams declarados (onde os testes vão morar), fronteiras de módulo, contrato em `packages/contracts`, ADR quando a decisão for durável.
**Veto:** violação da regra de dependência entre pacotes; regra de domínio vazando para `apps/`; seam novo quando um existente serviria.

---

## Fase 3 — Gate de risco (ainda no spec, antes do código)

> **Este é o gate que define o projeto.** Os dois agentes abaixo revisam o **spec**, não o pull request. Descobrir vazamento entre tenants depois de implementado custa dez vezes mais.

### `especialista-seguranca-appsec`
OWASP ASVS, isolamento multi-tenant, autenticação, criptografia, gestão de segredos.

**Aciona quando:** todo spec, sem exceção; qualquer código que toque autenticação, autorização, dado bancário, pagamento ou segredo; antes de expor endpoint novo.
**Entrega:** modelo de ameaças da feature, requisitos de controle, casos de abuso para o QA testar.
**Veto:** tabela sem RLS; segredo sem envelope encryption; endpoint sem authz explícita; PII em log.
**Ferramenta pesada:** `claude-security:scan` quando o diff tocar auth, dado bancário ou pagamento.

### `especialista-lgpd-compliance`
LGPD, base legal, consentimento, retenção, direitos do titular, resposta a incidente.

**Aciona quando:** todo spec que crie, colete ou compartilhe dado pessoal; mudança em retenção, exportação ou exclusão; integração com terceiro.
**Entrega:** base legal por finalidade, ciclo de vida do dado, impacto em exportação/eliminação, texto de consentimento.
**Veto:** coleta sem finalidade declarada; dado pessoal sem prazo de retenção; feature que impede o titular de exportar ou eliminar seus dados.

---

## Fase 4 — Construção (só com spec e tickets aprovados)

### `engenheiro-backend`
NestJS + Fastify, PostgreSQL, Drizzle, filas BullMQ, multi-tenancy, migrations.
**Aciona quando:** ticket de API, domínio, persistência ou job.
**Entrega:** implementação guiada por `/tdd` nos seams acordados, migration, contrato atualizado.

### `engenheiro-frontend-web`
Next.js App Router, React, TanStack Query, design system, acessibilidade, visualização de dados.
**Aciona quando:** ticket de tela ou fluxo web.
**Entrega:** UI acessível (WCAG AA), estados de carregamento/erro/vazio, gráficos legíveis em claro e escuro.
**Regra própria:** dinheiro na tela sempre formatado pelo formatador central do `packages/domain`. Nunca `toFixed(2)` solto.

### `engenheiro-mobile`
Expo, React Native, expo-router, SQLite offline-first, biometria, push, EAS Build/Submit.
**Aciona quando:** ticket de app; qualquer coisa que envolva offline, notificação ou publicação nas lojas.
**Entrega:** telas, camada de sincronização com resolução de conflito, build EAS.
**Regra própria:** o app funciona sem rede. Lançamento criado offline sincroniza com idempotência ao voltar.

### `engenheiro-dados-ia`
Categorização automática, OCR de recibo, extração de extrato, regras + modelo, servidor MCP para agentes de IA.
**Aciona quando:** ticket de categorização, enriquecimento, parsing de documento ou integração com agentes.
**Entrega:** pipeline de inferência com fallback determinístico, explicabilidade ("por que esta categoria"), métrica de acerto.
**Regra própria:** toda inferência é reversível e mostra o motivo. Modelo nunca decide sozinho sobre dinheiro.

---

## Fase 5 — Qualidade e validação

Três papéis distintos. Não os confunda.

### `engenheiro-qa-automacao`
**Constrói a rede de segurança.** Vitest, fast-check, Testcontainers, Playwright, Maestro, contract tests.
**Aciona quando:** junto com a construção, não depois; sempre que um seam novo é acordado.
**Entrega:** suíte no nível certo da pirâmide, fixtures determinísticas, casos de abuso vindos do appsec.
**Veto:** feature financeira sem property-based test; teste de RLS contra mock em vez de Postgres real.

### `validador-financeiro`
**Valida o dinheiro, não o código.** É o auditor do time — pensa como contador, não como programador.
**Aciona quando:** antes de qualquer merge que toque valor, saldo, fatura, parcelamento, transferência, importação ou relatório.
**Como trabalha:** roda a bateria de invariantes — soma de rateio bate com o total; pernas de transferência somam zero; saldo derivado bate com o snapshot; lançamento após fechamento cai na fatura seguinte; pagamento de fatura não aparece como despesa; reimportar o mesmo arquivo não duplica; virada de mês e horário de verão não deslocam competência.
**Veto:** qualquer divergência de centavo. Não existe "diferença aceitável".

### `revisor-codigo`
Revisão em dois eixos, via `/code-review`: **padrões** (segue o CLAUDE.md deste repo?) e **spec** (faz o que o ticket pediu?).
**Aciona quando:** implementação concluída, antes do merge.
**Entrega:** achados separados por eixo, cada um com arquivo e linha.
**Veto:** desvio do spec sem ADR; violação das regras inegociáveis do CLAUDE.md.

---

## Fase 6 — Operação

### `sre-devops-vps`
Docker Compose, Traefik, TLS, CI/CD, migrations em produção, backup PITR, observabilidade, hardening da VPS, DR.
**Aciona quando:** migration para produção; deploy; incidente; mudança de recurso ou custo; desenho de backup e restauração.
**Entrega:** deploy reversível, migration expand/contract, alertas com SLO, restauração de backup **testada** (backup não testado não é backup).
**Veto:** migration destrutiva sem janela de compatibilidade; deploy sem rollback; segredo em imagem ou repositório.

---

## Como acionar

Um agente por vez quando a decisão depende do anterior. Em paralelo quando são independentes — o gate de risco é o caso típico:

```
Agent(especialista-seguranca-appsec, "revise o spec X")
Agent(especialista-lgpd-compliance,  "revise o spec X")
Agent(validador-financeiro,          "revise as regras monetárias do spec X")
```

Os três na **mesma mensagem**, para rodarem concorrentes. Ver `superpowers:dispatching-parallel-agents`.
