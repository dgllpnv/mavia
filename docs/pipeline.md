# Pipeline de desenvolvimento

Como o trabalho flui da ideia até a VPS. Cada fase tem entrada, saída e quem manda.

---

## Fase 0 — Fundação (uma vez, no início do projeto)

| Passo | Skill | Quem | Saída |
|---|---|---|---|
| 0.1 | `/setup-matt-pocock-skills` | — | `docs/agents/issue-tracker.md` e vocabulário de labels |
| 0.2 | `/wayfinder` | `arquiteto-solucao` | Mapa de decisões do projeto inteiro, com tickets de decisão |
| 0.3 | `/grill-with-docs` | `arquiteto-dominio-financeiro` + `especialista-open-finance` | `CONTEXT.md` preenchido, ADRs 0001–0005 |
| 0.4 | — | `sre-devops-vps` | Esqueleto do monorepo, Docker Compose, CI, ambiente na VPS |

`/wayfinder` existe justamente para trabalho maior que uma sessão de agente. Este projeto é. Resolva um ticket de decisão por vez até a rota até o MVP ficar visível — **não** tente construir a partir do mapa.

---

## Ciclo por épico

```
  ┌─ 1. Descobrir ──────────── product-financeiro · /grill-me
  │
  ├─ 2. Especificar ────────── /to-spec · arquiteto-solucao declara os seams
  │
  ├─ 3. 🚦 GATE DE RISCO ───── appsec ∥ lgpd ∥ validador-financeiro   ← no SPEC
  │
  ├─ 4. Fatiar ─────────────── /to-tickets · tracer bullets verticais
  │
  ├─ 5. Construir ──────────── worktree isolado · /tdd → /implement
  │
  ├─ 6. Verificar ─────────── qa-automacao · validador-financeiro
  │
  ├─ 7. Revisar ───────────── /code-review · claude-security:scan
  │
  └─ 8. Entregar ──────────── sre-devops-vps · migration · deploy · observar
```

### 1. Descobrir

**Entrada:** uma ideia, um pedido, uma dor.
**Skill:** `/grill-me` (ou `/grill-with-docs` se a discussão vai cunhar termos novos).
**Quem:** `product-financeiro` conduz; `arquiteto-dominio-financeiro` acompanha se houver conceito novo.

Uma pergunta por vez, cada uma com recomendação. Termina quando não sobra decisão em aberto — não quando cansou.

**Saída:** entendimento compartilhado. Nada escrito ainda.

### 2. Especificar

**Skill:** `/to-spec` — sintetiza a conversa, sem nova entrevista.
**Quem:** `arquiteto-solucao` **declara os seams** onde a feature será testada, e confirma com o humano.

Preferir seam existente a seam novo. Preferir o seam mais alto possível. O número ideal de seams novos numa feature é zero.

**Saída:** PRD no tracker com label `ready-for-agent`.

### 3. 🚦 Gate de risco — no spec, antes do código

Três agentes **em paralelo**, na mesma mensagem:

| Agente | Pergunta que responde |
|---|---|
| `especialista-seguranca-appsec` | Como isso vaza dado, escala privilégio ou expõe segredo? |
| `especialista-lgpd-compliance` | Qual a base legal, o prazo de retenção e o efeito no direito de exportar/eliminar? |
| `validador-financeiro` | Onde o centavo se perde, o saldo diverge ou a data desloca? |

**Saída:** spec revisado, ou objeções registradas como comentário. Cada um tem veto. Objeção não resolvida bloqueia a Fase 4.

Custo desta fase: minutos. Custo de pular: retrabalho de dias, ou incidente com dado de cliente.

### 4. Fatiar

**Skill:** `/to-tickets`.
**Forma:** tracer bullets **verticais** — cada ticket atravessa banco → API → UI e entrega algo demonstrável. Nunca fatie por camada ("ticket do backend", "ticket do frontend"): isso produz pilhas de trabalho que só provam valor no fim.

Cada ticket declara as arestas que o bloqueiam. Prefatore antes: "torne a mudança fácil, depois faça a mudança fácil."

### 5. Construir

**Isolamento:** worktree próprio, via `superpowers:using-git-worktrees`.
**Loop:** `/tdd` nos seams acordados na Fase 2 → `/implement`.
**Quem:** o engenheiro da camada. Tickets independentes podem rodar em paralelo em worktrees separados.

Teste primeiro, sempre nos seams acordados — nunca contra internos. `pnpm typecheck` e o teste do arquivo rodam o tempo todo; a suíte completa roda uma vez ao fim.

### 6. Verificar

| Quem | O que faz |
|---|---|
| `engenheiro-qa-automacao` | Suíte no nível certo; property-based obrigatório se houve aritmética monetária; casos de abuso do appsec viram teste |
| `validador-financeiro` | Bateria de invariantes monetárias (ver `docs/team.md`). Divergência de um centavo reprova |

Fecha com `superpowers:verification-before-completion`: rode o comando, cole a saída. Nenhuma afirmação de "passou" sem evidência colada.

### 7. Revisar

**Skill:** `/code-review` contra o ponto fixo (`main` ou merge-base). Dois eixos em subagentes paralelos: **padrões** e **spec**.
**Adicional obrigatório:** se o diff tocou autenticação, autorização, dado bancário, segredo ou pagamento → `claude-security:scan`.

Ao receber os achados, use `superpowers:receiving-code-review`: verifique cada um tecnicamente. Concordância automática é tão ruim quanto rejeição automática.

### 8. Entregar

**Quem:** `sre-devops-vps`.

- Migration **expand/contract**: adiciona compatível → faz o deploy → remove o antigo num release seguinte. Nunca destrutiva no mesmo deploy.
- Deploy com rollback pronto antes de começar.
- Observabilidade: erro, latência e a métrica de negócio da feature.
- Após o deploy, confira o job de reconciliação de saldo. Divergência é incidente.

`superpowers:finishing-a-development-branch` para integrar e limpar o worktree.

---

## Trilhas paralelas

| Situação | Skill | Quem |
|---|---|---|
| Issue ou bug reportado chega | `/triage` | `product-financeiro` |
| Bug difícil, regressão, lentidão | `/diagnosing-bugs` | Engenheiro da camada |
| Dúvida de UX ou máquina de estados | `/prototype` | `engenheiro-frontend-web` ou `-mobile` |
| Precisa da spec do Open Finance, doc de agregador, formato OFX | `/research` (agente em background) | `especialista-open-finance` |
| Dívida arquitetural acumulando | `/improve-codebase-architecture` | `arquiteto-solucao` |
| Contexto da sessão acabando | `/handoff` | Quem estiver no comando |

`/diagnosing-bugs` só avança depois de existir um **loop de feedback apertado** — um sinal vermelho que fica verde quando o bug morre. Sem isso, olhar código não resolve.

---

## Cadência

| Ritmo | O quê |
|---|---|
| A cada ticket | typecheck, testes do escopo, `/code-review` |
| A cada épico | Gate de risco, validação financeira completa, ADR se houve decisão durável |
| A cada 4–6 épicos | `/improve-codebase-architecture`; revisão de `CONTEXT.md`; restauração de backup testada de verdade |
| Trimestral | Reavaliar custo do agregador de Open Finance contra a receita (ver ADR 0003), **com a lista de espera da conexão bancária como insumo** — quantas pessoas, quais bancos, que faixa de disposição a pagar (`spec-planos-e-assinatura.md` §1.3). Sem ela a revisão compara custo contra nada. Conferir junto a conversão do checkout e o volume de reembolso proporcional do anual (ADR 0020) |

---

## Roadmap sugerido — ordem dos épicos

Ordenado por dependência e por risco: o que sustenta tudo vem primeiro.

1. **Fundação** — monorepo, `packages/domain` com `Money` e rateio, auth, tenant, RLS, CI, deploy na VPS
2. **Núcleo** — Conta, Categoria, Lancamento, saldo derivado, Transferencia de duas pernas
3. **Cartão** — Cartao, Fatura, ciclo de fechamento, parcelamento, pagamento de fatura
4. **Web MVP** — dashboard, lançar, extrato, filtros
5. **Mobile MVP** — Expo, offline-first, lançamento rápido, biometria, push
6. **Importação** — `BankSyncProvider` + adapters OFX/CSV, deduplicação, conciliação
7. **Inteligência** — categorização automática, OCR de recibo, regras do usuário
8. **Planejamento** — `Planejamento` (teto e piso por categoria), `Objetivo` de acúmulo, alertas, `Recorrencia`
9. **Relatórios** — gráficos, comparação de períodos, exportação
10. **Compartilhamento** — múltiplos usuários por Tenant, papéis
11. **Billing** — planos, assinatura, **cotas** por plano
12. **Open Finance** — adapter de agregador, Conexao, Consentimento, sincronização periódica

Épico 12 depende do 6: quando o `BankSyncProvider` já existir, plugar um agregador é adicionar um adapter — não uma reescrita. É esse o ponto do ADR 0003.

**Épico 11 depende do 10, e a dependência é dura — não é só ordem.** Os planos `Família` e `Negócio` são diferenciados por **pessoas no espaço** e **número de espaços** (`docs/produto/spec-planos-e-assinatura.md` §1.2). Sem o épico 10, os dois níveis superiores não têm o que vender: as cotas `pessoas` e `espacos` existiriam sem a funcionalidade que elas medem, e restaria cobrar pela conexão bancária — que é o épico 12 e ainda não existe. **Começar o 11 antes de o 10 estar em produção produz três planos que são o mesmo plano com três preços.**

**E o épico 12 não depende do 11 apenas por ordem: depende da receita que o 11 gera.** O gatilho do ADR 0003 é a receita cobrir o custo do agregador com margem. Manter os níveis superiores fechados até o 12 existir seria circular — e é exatamente por isso que eles vendem, desde o 11, o que o 10 entregou (DP-17).

A checagem de cota atravessa o produto inteiro: **toda rota de criação de recurso com cota nasce com a verificação no servidor** (ADR 0020, §3 do spec), e a lista do que **nunca** é limitado (§4) é normativa. Introduzir uma cota nova exige revisar aquele documento, não só acrescentar um campo.
