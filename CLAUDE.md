# Mavia — Plataforma de Controle Financeiro Pessoal

SaaS multi-tenant de finanças pessoais (categoria Organizze/Mobills/YNAB), auto-hospedado em VPS, com web e apps nativos Android/iOS.

Domínio: dinheiro real de pessoas reais. **Um bug aqui não é um bug de UI — é o saldo errado na conta de alguém.**

> Leia este arquivo inteiro antes da primeira ação de qualquer sessão. As seções **Regras inegociáveis** e **Fluxo de trabalho** não são sugestões.

---

## 1. Stack e layout

Monorepo TypeScript (Turborepo + pnpm). Uma linguagem do banco ao app.

```
apps/
  api/        NestJS + Fastify · PostgreSQL · Drizzle ORM · BullMQ/Redis
  web/        Next.js (App Router) · React · TanStack Query · Tailwind
  mobile/     Expo (React Native) · expo-router · SQLite offline-first
packages/
  domain/     Regras monetárias PURAS. Zero I/O, zero framework. O coração.
  contracts/  Schemas Zod → tipos + OpenAPI. Fonte única de verdade da API.
  ui/         Design system compartilhado web/mobile (tokens + primitivos)
infra/        docker-compose · Traefik · migrations · backup · observabilidade
docs/         ADRs, pipeline, time, specs
```

**Regra de dependência:** `domain` não importa nada. `contracts` importa `domain`. `api`/`web`/`mobile` importam ambos. Nunca o inverso. Nunca app → app.

---

## 2. ⛔ Regras inegociáveis

Violar qualquer uma destas é motivo para reprovar o código, mesmo que os testes passem.

### Dinheiro

1. **Nunca `float`, `double` ou `number` para valor monetário.** Sempre inteiro em centavos (`BIGINT` no Postgres, `bigint` em TS) encapsulado no value object `Money` de `packages/domain`. Se você escreveu `0.1 + 0.2` em algum lugar perto de dinheiro, pare.
2. **Toda `Money` carrega moeda ISO 4217.** Somar `Money` de moedas diferentes lança erro, não converte silenciosamente.
3. **Arredondamento é explícito e declarado.** Nenhum arredondamento implícito. Divisões (rateio de parcela, split de despesa) usam `ratear`: o resto em centavos é distribuído **uma unidade por parte, nas primeiras partes**, de modo que nenhuma parte difira de outra em mais de um centavo. A soma das partes é **exatamente** igual ao todo. Sempre. Prove isso com property-based testing — e a propriedade da soma **não basta**: sem `max − min <= 1` a suíte não distingue esta regra de "todo o resto na primeira parte".
4. **Transferência entre contas são duas pernas.** Débito numa conta, crédito na outra, ligadas por `transfer_group_id`. Nunca uma linha única com um campo "conta destino". A soma das pernas de uma transferência é sempre zero.
5. **Saldo é derivado, nunca um campo mutável isolado.** Verdade = soma dos lançamentos. Snapshots materializados existem só para performance, e um job de reconciliação compara snapshot vs. derivado. Divergência é incidente, não warning.
6. **Sinal é explícito no domínio.** Despesa é negativa, receita é positiva, no próprio tipo. Nunca dependa de um enum `type` para inferir sinal na hora de somar.

### Tempo

7. **UTC no banco, `America/Sao_Paulo` na tela.** Nenhuma data "nua" no domínio. **Toda janela de período é semiaberta `[inicio, fim)`**, em instantes UTC, com as bordas calculadas em `America/Sao_Paulo` antes da comparação — inclusive a janela da fatura. Uma convenção só, em todo o sistema.
8. **`posted_at` (competência) e `settled_at` (compensação) são campos distintos.** Um lançamento de cartão acontece num dia e afeta o caixa noutro. Não colapse os dois. **`settled_at` é o fato: só é gravado quando o dinheiro se move**, é nulo até lá, e nunca recebe data futura. Num lançamento de cartão, quem move o dinheiro é o pagamento da fatura. **Não existe coluna de previsão de caixa em `lancamentos`** — a previsão de um cartão é a `Fatura`, não a linha.
8b. **O eixo caixa agrega Contas e Faturas, nunca lançamentos de Cartao.** Saldo, Saldo geral, projeção e `Objetivo` somam lançamentos de `Conta` (por `settled_at`) e Faturas em aberto (pelo total, no vencimento). Uma compra de cartão não sai do bolso; a fatura sai.
9. **Data de negócio nunca vem do relógio do cliente.** O servidor é a autoridade.

### Cartão de crédito

10. **Fatura tem ciclo: `closing_day` e `due_day`.** Um lançamento entra na fatura cuja janela contém seu `posted_at`. Compras após o fechamento caem na fatura seguinte.
11. **Parcelamento gera N lançamentos futuros** ligados por `installment_group_id`, com `installment_number`/`installment_total`. Nunca um lançamento único "12x". O resto da divisão segue a regra 3 — distribuído nas primeiras parcelas, um centavo por parcela.
12. **Pagamento de fatura é transferência** (conta → cartão), não uma despesa. Contar como despesa duplica o gasto — este é o erro clássico da categoria. O vínculo pagamento ↔ fatura é `transferencias.fatura_id`, **nunca** `lancamentos.fatura_id`: a perna de crédito dentro da fatura zeraria o total dela.
12b. **Transferência é excluída de toda agregação monetária de receita ou despesa, por construção.** A exclusão vive num tradutor de filtro único, não num `AND` repetido em cada consulta. Aparecer como linha na listagem e entrar num total são decisões distintas, e só a primeira é permitida.

### Ingestão de dados bancários

13. **Toda ingestão externa é idempotente.** Chave: `(tenant_id, provider, external_id)` mais hash de conteúdo. Reimportar o mesmo OFX duas vezes não pode duplicar nada.
14. **Todo dado bancário entra por `BankSyncProvider`.** Nenhum código de aplicação conhece "Pluggy", "Belvo" ou "OFX" — só a interface. Ver `docs/adr/0003`.
15. **Conciliação é sugestão, não sobrescrita.** Ao casar um lançamento importado com um manual, proponha o merge; nunca apague o registro do usuário automaticamente.

### Tenancy e dados

16. **Row-Level Security no Postgres, obrigatória.** Filtro na aplicação é a segunda camada, nunca a única. Toda tabela de negócio tem `tenant_id NOT NULL`.
17. **Soft delete em tudo que é financeiro.** `deleted_at`, nunca `DELETE`.
18. **Audit log append-only** em toda escrita financeira: quem, quando, de → para.
19. **Segredos de provider com envelope encryption.** Token de agregador nunca em texto claro, nunca em log, nunca em resposta de API.
20. **PII e valores mascarados em log.** Log de produção não contém CPF, e-mail completo, número de conta ou valor de transação.

---

## 3. O time

14 especialistas em `.claude/agents/`. Responsabilidade, gatilho e poder de veto de cada um em **`docs/team.md`**.

| Fase | Agentes | Aciona quando |
|---|---|---|
| **Domínio** | `product-financeiro`, `arquiteto-dominio-financeiro`, `especialista-open-finance` | Antes de existir qualquer código |
| **Arquitetura** | `arquiteto-solucao` | Antes do spec virar ticket |
| **Construção** | `engenheiro-backend`, `engenheiro-frontend-web`, `engenheiro-mobile`, `engenheiro-dados-ia` | Só com spec e tickets aprovados |
| **Qualidade** | `engenheiro-qa-automacao`, `validador-financeiro`, `revisor-codigo` | QA durante; validador e revisor ao fim |
| **Risco** | `especialista-seguranca-appsec`, `especialista-lgpd-compliance` | **No spec**, antes do código |
| **Operação** | `sre-devops-vps` | Migration, deploy, incidente |

**O gate que define este projeto:** segurança, LGPD e validação financeira revisam o **spec**, não o pull request. Descobrir "esse fluxo vaza dado de outro tenant" depois de implementado custa dez vezes mais.

---

## 4. Fluxo de trabalho

Pipeline completa em **`docs/pipeline.md`**. O ciclo curto:

```
/grill-me → /to-spec → 🚦 gate de risco → /to-tickets → /tdd → /implement
         → /code-review → validador-financeiro → deploy
```

**Regras de processo:**

- **Nunca escreva código sem spec e tickets.** Se pedirem uma feature direto, invoque `/grill-me` primeiro. "É simples" é exatamente quando isso falha.
- **Trabalho de feature acontece em git worktree isolado** (`superpowers:using-git-worktrees`).
- **TDD apenas em seams acordados.** Antes de escrever teste, declare o seam e confirme. Não testamos tudo — testamos o caminho crítico e a lógica complexa.
- **Nunca afirme "pronto" sem evidência.** Use `superpowers:verification-before-completion`: rode o comando, cole a saída. Teste que não foi executado não passou.
- **Toda decisão não-óbvia vira ADR** em `docs/adr/`. Use `/domain-modeling`.
- **Vocabulário vem de `CONTEXT.md`.** Nome no código = nome no glossário = nome na UI. Precisa de um termo novo? Adicione ao glossário primeiro.
- **Ao fim de sessão longa**, rode `/handoff` antes de perder contexto.

---

## 5. Skills e quando usar

Pacotes `mattpocock-skills`, `superpowers` e `claude-security` instalados.

### Agent skills

Configuração que as skills de engenharia assumem:

- **Issue tracker** — markdown local em `.scratch/`. Convenções em `docs/agents/issue-tracker.md`
- **Labels de triagem** — `docs/agents/triage-labels.md`
- **Docs de domínio** — `docs/agents/domain.md`

| Situação | Skill |
|---|---|
| Ideia vaga, decisões em aberto | `/grill-me` · `/grill-with-docs` (gera ADR junto) |
| Trabalho grande demais para uma sessão | `/wayfinder` |
| Conversa madura → PRD | `/to-spec` |
| PRD → fatias verticais | `/to-tickets` |
| Modelar entidade, cunhar termo, registrar decisão | `/domain-modeling` |
| Decidir onde vai o seam, aprofundar módulo | `/codebase-design` |
| Escrever a feature | `/tdd` → `/implement` |
| Revisar o que foi feito | `/code-review` |
| Código tocou auth, dado bancário ou pagamento | `claude-security:scan` |
| Bug difícil, regressão, lentidão | `/diagnosing-bugs` |
| Dúvida de UX ou de máquina de estados | `/prototype` |
| Precisa da spec do Open Finance ou doc de API | `/research` |
| Issue nova chegando | `/triage` |
| Dívida arquitetural acumulando | `/improve-codebase-architecture` |
| Fim de sessão | `/handoff` |

---

## 6. Convenções de código

- **TypeScript estrito.** `strict: true`, `noUncheckedIndexedAccess: true`. `any` é proibido — use `unknown` e estreite. `as` só com comentário justificando.
- **Módulos profundos** (`/codebase-design`): muito comportamento atrás de uma interface pequena. Se a interface é quase tão complexa quanto a implementação, o módulo está raso.
- **Erros são valores no domínio, exceções na borda.** `packages/domain` retorna `Result<T, DomainError>`; a camada HTTP traduz para status code.
- **Validação na borda com Zod, de `packages/contracts`.** Nada entra no domínio sem parse.
- **Nomes em português para conceitos de domínio** (`Lancamento`, `Fatura`, `Conta`), inglês para infraestrutura (`Repository`, `Handler`). Consistência vale mais que a escolha.
- **Migrations são forward-only.** Reversão por compensação. Nunca edite uma migration já aplicada.
- **Sem comentário que descreve o óbvio.** Comente o *porquê*, sobretudo regra de negócio financeira não-óbvia.

### Interface

Antes de desenhar qualquer tela, leia **`docs/design.md`** e rode a auditoria da seção 5 antes de entregar. Resumo: nada de roxo/índigo, nada de gradiente decorativo, nada de glassmorphism, nada de emoji na interface, nem toda informação dentro de card. Tipografia conduz, algarismos tabulares em toda coluna de valor, densidade é feature, movimento só quando explica algo. UI nova nasce de três direções radicalmente diferentes via `/prototype` — o humano escolhe.

---

## 7. Testes

| Nível | Ferramenta | O que cobre |
|---|---|---|
| Domínio | Vitest + fast-check (property-based) | Invariantes de `Money`, rateio, ciclo de fatura, partida dobrada |
| Integração API | Vitest + Testcontainers (Postgres real) | RLS, idempotência de ingestão, transações |
| Contrato | Schemas de `packages/contracts` | API ↔ web ↔ mobile não divergem |
| E2E web | Playwright | Onboarding, lançamento, fatura, importação |
| E2E mobile | Maestro | Smoke: login, lançar despesa, sync offline → online |

**Property-based é obrigatório para dinheiro.** Ratear R$ 100,00 em 3 partes deve somar R$ 100,00 para *qualquer* entrada. Exemplo escolhido a dedo não prova isso.

Testes contra Postgres real, não mock. RLS não pode ser mockada.

---

## 8. Comandos

```bash
pnpm dev            # sobe api + web + mobile
pnpm test           # suíte completa
pnpm test:domain    # só domínio, rápido, roda o tempo todo
pnpm typecheck      # obrigatório antes de qualquer commit
pnpm lint
pnpm db:migrate
pnpm db:seed
```

Antes de dizer que algo está pronto: `pnpm typecheck && pnpm test`. Sem exceção.

---

## 9. Documentos vivos

| Arquivo | Papel |
|---|---|
| `CONTEXT.md` | Glossário do domínio, a linguagem ubíqua. Leia antes de nomear qualquer coisa |
| `docs/adr/` | Decisões arquiteturais. Não re-litigue uma ADR aceita — proponha uma nova que a substitua |
| `docs/design.md` | Direção de design. **Obrigatório antes de qualquer tela** — define a identidade e o que é proibido |
| `docs/team.md` | Os 14 agentes: responsabilidade, gatilho, poder de veto |
| `docs/pipeline.md` | A pipeline completa, fase a fase |
| `docs/agents/issue-tracker.md` | Config do tracker para as skills do pacote mattpocock |
| `docs/superpowers/specs/` | Specs de design por épico |
