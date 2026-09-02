# Bateria de aceite — Épico 2 (Núcleo)

- **Data:** 2026-09-01
- **Autor:** `validador-financeiro`
- **Escopo:** `Categoria` de dois níveis · `Lancamento` com os três estados · saldo derivado com `SaldoSnapshot` e `saldo.reconciliar` · `Transferencia` de duas pernas · `Estorno` · o módulo `agregacao` como tradutor único
- **Insumos:** `CLAUDE.md` §2 · `CONTEXT.md` · ADR 0005 · `docs/arquitetura/sistema.md` §1.1, §3.3, §3.4, §3.6, §3.7, §4.3, §4.4, §5.2 · `docs/validacao/auditoria-financeira-spec.md` · `packages/domain/src/{money,ratear,tempo}.ts` · `apps/api/migrations/0001_fundacao.sql`
- **Status:** Normativo para o aceite do épico 2. Um cenário 🔺 que não passa reprova o épico.

Isto não é prosa. Cada item tem **entrada**, **resultado esperado calculado à mão** e a **invariante que protege**. Todos os números são redondos de propósito: um cenário que o leitor não confere de cabeça não serve para provar nada.

**🔺 = obrigatório antes de o épico 2 ser dado como pronto. ⏳ = pode esperar** (entra como dívida com dono, não some).

**Ao final, §8 registra 13 lacunas e contradições encontradas ao montar esta bateria.** Elas não foram contornadas: cada uma virou cenário, e o cenário exige a decisão escrita antes de passar. Foi assim que os defeitos anteriores apareceram.

---

## 0. Convenções de toda a bateria

Fixadas para que nenhum cenário dependa de contexto implícito.

| Convenção | Valor |
|---|---|
| Tenant | Um só, `moeda_base = BRL`, `timezone = America/Sao_Paulo` |
| Relógio | **Injetado** (`RelogioFixo`). Nenhum cenário usa `new Date()` |
| "Hoje", salvo indicação | `2026-09-15T12:00:00-03:00` = `2026-09-15T15:00:00Z` |
| Janela de setembro/2026 | `[2026-09-01T03:00:00Z, 2026-10-01T03:00:00Z)` |
| Janela de agosto/2026 | `[2026-08-01T03:00:00Z, 2026-09-01T03:00:00Z)` |
| Sinal | Despesa negativa, receita positiva. **Toda conferência é soma, nunca `if`** |
| Unidade das tabelas | Centavos, com sinal. `−50000` lê-se "despesa de R$ 500,00" |
| Status | Derivado: `efetivado` se `settled_at != null`; senão `previsto` se `posted_at > agora`; senão `pendente` |
| Saldo | `conta.saldo_inicial_centavos + Σ (lançamentos `efetivado` da conta)` |
| Realizado | `efetivado` **+** `pendente` no eixo competência (`CONTEXT.md`, **Realizado**) |
| Seam | `S1` = `packages/domain` (Vitest + fast-check) · `S2` = HTTP sobre Postgres real (Testcontainers, RLS ligada) |

**Contas usadas** (nomes fixos, para os cenários se referenciarem entre si):

| Conta | Tipo | `saldo_inicial` | `incluir_no_saldo_geral` |
|---|---|---|---|
| **A** — Corrente | `corrente` | `100000` (R$ 1.000,00) | `true` |
| **B** — Poupança | `poupanca` | `0` | `true` |
| **C** — Investimento | `investimento` | `500000` (R$ 5.000,00) | `false` |
| **D** — Vazia | `corrente` | `0` | `true` |

**Categorias usadas:**

```
Casa (raiz, despesa)          Alimentação (raiz, despesa)     Salário (raiz, receita)
├── Luz                       ├── Restaurante
└── Água                      └── Mercado

Sem categoria (receita) · Sem categoria (despesa) · Ajuste de saldo  ← sistema
                                                     analitica = false
```

---

## 1. Saldo derivado

> Regra 5 do `CLAUDE.md`: *saldo é derivado, nunca campo mutável isolado.* Snapshot é cache; divergência é incidente.

### SD-1 🔺 Só efetivados

**Entrada.** Conta A (`saldo_inicial = 100000`). Todos com `settled_at` preenchido.

| # | Data (`posted_at` = `settled_at`) | Categoria | Valor |
|---|---|---|---|
| 1 | 01/set | Salário | `+50000` |
| 2 | 05/set | Mercado | `−20000` |

**Esperado.** `saldo(A, 10/set) = 100000 + 50000 − 20000 = 130000` → **R$ 1.300,00**.

**Invariante.** Saldo é a soma dos lançamentos `efetivado` mais o saldo inicial. Nenhuma coluna mutável participa. **Seam:** S1 (fold) + S2 (`GET /contas/saldos?em=2026-09-10&eixo=caixa`).

### SD-2 🔺 Efetivados mais previstos — a projeção

**Entrada.** SD-1 mais: `#3` aluguel `−30000`, `posted_at = 2026-09-20T12:00:00-03:00`, `settled_at = NULL`. Hoje = 15/set.

**Esperado.**

| Grandeza | Cálculo | Valor |
|---|---|---|
| `status(#3)` | `posted_at` no futuro, sem `settled_at` | **`previsto`** |
| Saldo hoje (15/set) | `100000 + 50000 − 20000` | **`130000`** |
| Projeção até 30/set | `130000 − 30000` | **`100000`** |
| Projeção até 19/set | `#3` fora do horizonte | **`130000`** |

**Invariante.** `previsto` entra na projeção e **fica fora** do saldo realizado. As duas respostas nunca aparecem na mesma linha da UI. **Seam:** S1 (`saldo.projetar`) + S2.

### SD-3 🔺 Pendente não entra no saldo, mas entra no realizado

**Entrada.** Conta A. Débito de R$ 100,00, `posted_at = 10/set`, `settled_at = NULL`. Hoje = 15/set.

**Esperado.**

| Grandeza | Valor |
|---|---|
| `status` | **`pendente`** (aconteceu; o dinheiro não se moveu) |
| `saldo(A, 15/set)` | **`100000`** — inalterado |
| Realizado de setembro (eixo competência) | **`−10000`** |
| Projetado de setembro | **`−10000`** |

**Invariante.** *`Saldo` não é `Realizado`.* São perguntas diferentes e a UI rotula as duas (`CONTEXT.md`, **Realizado**). Este cenário é o par de RP-4, que mostra onde o desenho atual quebra por causa disso.

### SD-4 🔺 Conta com `incluir_no_saldo_geral = false`

**Entrada.** Conta A com SD-1 (saldo `130000`). Conta C (`saldo_inicial = 500000`, flag `false`) com um aporte `+100000` efetivado em 03/set.

**Esperado.**

| Grandeza | Cálculo | Valor |
|---|---|---|
| `saldo(C)` | `500000 + 100000` | **`600000`** — a flag **não** afeta o saldo da própria conta |
| **Saldo geral** | só A e B | **`130000`** |
| Saldo geral se somasse tudo | — | `730000` ← **errado**, R$ 6.000,00 de diferença |

**Invariante.** `incluir_no_saldo_geral = false` **nunca** altera o saldo da própria Conta, só a soma do Saldo geral (`CONTEXT.md`, **Conta**). **Seam:** S2.

### SD-5 🔺 Virar a flag muda o Saldo geral e nada mais

**Entrada.** Estado de SD-4. `PATCH /contas/C { incluir_no_saldo_geral: true }`.

**Esperado.**

| Grandeza | Antes | Depois |
|---|---|---|
| Saldo geral | `130000` | **`730000`** |
| `saldo(C)` | `600000` | `600000` |
| `saldo(A)` | `130000` | `130000` |
| Despesa realizada de setembro | `−20000` | `−20000` |
| Relatório por categoria de setembro | idêntico | idêntico |

**Invariante.** *Alterar `incluir_no_saldo_geral` muda o Saldo geral e nada mais.* Mudar `tipo` não muda nada disso. **Seam:** S2.

### SD-6 🔺 Conta vazia e período vazio devolvem zero, nunca `NULL`

**Entrada.** Conta D (`saldo_inicial = 0`), nenhum lançamento. Consulta de setembro.

**Esperado.**

| Campo | Valor esperado |
|---|---|
| `saldo(D)` | **`0`** |
| `receita_realizada`, `receita_prevista` | **`0`**, `0` |
| `despesa_realizada`, `despesa_prevista` | **`0`**, `0` |
| `transferencia_liquida_realizada`, `_prevista` | **`0`**, `0` |
| `saldo_anterior` | **`0`**, com `fonte: 'derivado'` |
| Qualquer campo | **nunca `null`, nunca ausente, nunca `NaN`** |

**Invariante.** `SUM(...) FILTER (...)` sobre conjunto vazio devolve **`NULL` no Postgres**, e `saldo_anterior + NULL = NULL`. Sem `COALESCE(..., 0)` em cada balde, a primeira conta criada por um usuário novo exibe saldo vazio na tela principal do produto. **Lacuna L13.** **Seam:** S2 (é defeito de SQL, invisível em S1).

### SD-7 🔺 A soma independe da ordem

**Entrada.** As mesmas três linhas de SD-1/SD-2 inseridas em seis ordens diferentes; e uma propriedade `fast-check` sobre listas arbitrárias de `Money` em BRL.

**Esperado.** O saldo é o mesmo nas seis ordens. `somarLista(xs, 'BRL') = somarLista(shuffle(xs), 'BRL')` para qualquer `xs`.

**Invariante.** `SUM` sobre `BIGINT` é exata, associativa e comutativa — homologado em §2 da auditoria anterior. Isto congela a garantia contra alguém trocar centavos por `NUMERIC` ou `number`. **Seam:** S1 (property) + S2 (mesma sequência via HTTP).

### SD-8 🔺 Reconciliação: snapshot × derivado divergindo

**Entrada.** Conta A, `saldo_inicial = 0`. Efetivados: `+100000` (01/set), `−30000` (05/set), `−20000` (10/set).
Derivado em 10/set = **`50000`**. Corrompa o snapshot à mão: `UPDATE saldo_snapshots SET saldo_centavos = 60000 WHERE conta_id = A AND eixo = 'caixa' AND data_civil = '2026-09-10'`.

**Esperado, nesta ordem:**

| Passo | Esperado |
|---|---|
| 1 | `saldo.reconciliar(A)` detecta divergência: `delta = 60000 − 50000 = +10000` |
| 2 | Grava em `auditoria` (`classe = financeira`) com o delta, a conta, o eixo e o dia |
| 3 | Emite alerta ao operador · métrica **contador + faixa de grandeza**, sem centavos e **sem label de tenant** |
| 4 | **Só então** corrige o cache para `50000` |
| 5 | `GET /contas/saldos` volta a `50000` |

**Falha o cenário se:** o snapshot for corrigido sem entrada em `auditoria`; ou o valor em centavos aparecer na métrica; ou a divergência sair como `warn` no log em vez de incidente.

**Invariante.** *Divergência é incidente, não warning; nunca correção silenciosa* (ADR 0005 §3, regra 5). **Seam:** S2.

### SD-9 🔺 Reconciliação idempotente; snapshot ausente não é incidente

**Entrada.** Estado corrigido de SD-8.

**Esperado.**

| Ação | Esperado |
|---|---|
| `reconciliar(A)` de novo | Nenhuma divergência · **nenhuma entrada nova em `auditoria`** · nenhum alerta · mesmo valor |
| `DELETE` do snapshot e `reconciliar(A)` | Materializa `50000` · **sem incidente** — cache frio não é divergência |
| Snapshot de 05/set corrompido | Recalcula de 05/set **em diante**; 10/set volta a `50000` |

**Invariante.** Rodar duas vezes produz o mesmo estado; ausência ≠ divergência. Sem a segunda linha, todo cache frio vira um incidente e o alerta perde o significado. **Seam:** S2.

### SD-10 🔺 Ajuste de saldo entra no saldo e **não** entra na despesa

**Entrada.** Conta A, `saldo_anterior(31/ago) = 100000`. Setembro, todos efetivados:

| # | Categoria | `analitica` | Valor |
|---|---|---|---|
| 1 | Salário | `true` | `+300000` |
| 2 | Mercado | `true` | `−50000` |
| 3 | **Ajuste de saldo** | **`false`** | `−30000` |

**Esperado.**

| Grandeza | Cálculo | Valor |
|---|---|---|
| `saldo(A, 30/set)` | `100000 + 300000 − 50000 − 30000` | **`320000`** |
| `receita_realizada` | só #1 | `+300000` |
| `despesa_realizada` | só #2 — **#3 é não analítica** | `−50000` |
| `transferencia_liquida_realizada` | — | `0` |
| Identidade do rodapé, como escrita hoje | `100000 + 300000 − 50000 + 0` | **`350000`** |
| **Divergência** | `350000 − 320000` | **`30000` — R$ 300,00** |

**Invariante.** O rodapé precisa fechar contra o saldo derivado. Ele não fecha: `Ajuste de saldo` sai de todo total de gasto (correto — ressalva R9 da auditoria) e **não tem balde onde reaparecer**, exatamente o defeito B1 um nível abaixo. **Lacuna L2 — bloqueia.** Ver RP-5.

### SD-11 ⏳ Soft delete de lançamento efetivado

**Entrada.** SD-1. `DELETE /lancamentos/#2` (o `−20000` de 05/set), soft.

**Esperado.** `saldo(A) = 100000 + 50000 = 150000`. O snapshot de 05/set **e todos os dias seguintes** são recalculados. `reconciliar` não acusa divergência depois. A linha continua em `lancamentos` com `deleted_at` preenchido e continua em `auditoria`.

**Invariante.** Soft delete em tudo que é financeiro (regra 17), e o cache acompanha a exclusão em vez de congelar o saldo anterior.

---

## 2. Transferência de duas pernas

> Regra 4 do `CLAUDE.md` + ADR 0005 §2. As pernas somam zero, e transferência nunca é receita nem despesa.

### TR-1 🔺 As pernas somam zero; o Saldo geral não se move

**Entrada.** A (`saldo 100000`) e B (`saldo 0`). `POST /transferencias`: A → B, R$ 500,00, 10/set, ambas efetivadas.

**Esperado.**

| Grandeza | Valor |
|---|---|
| Linhas criadas | **exatamente 2**, mesmo `transfer_group_id` |
| Perna A | `−50000`, `categoria_id = NULL` |
| Perna B | `+50000`, `categoria_id = NULL` |
| Soma das pernas | **`0`** |
| `saldo(A)` | `50000` |
| `saldo(B)` | `50000` |
| **Saldo geral** | `100000` — **inalterado** |

**Invariante.** Um `transfer_group_id` tem exatamente duas pernas não excluídas e a soma delas é zero. Transferência move dinheiro de lugar; não cria nem destrói. **Seam:** S1 (`somaDasPernas`) + S2 (as duas linhas na **mesma transação**: se uma falha, nenhuma existe).

### TR-2 🔺 Não aparece em receita nem em despesa

**Entrada.** TR-1. Recorte: setembro, eixo competência, **sem filtro de conta**.

**Esperado.**

| Balde | Valor |
|---|---|
| `receita_realizada` | **`0`** |
| `despesa_realizada` | **`0`** |
| `transferencia_liquida_realizada` | **`0`** (as duas pernas no recorte) |
| Linhas na listagem | **2** — a transferência **aparece** |
| Relatório por categoria | **vazio** — nenhum balde "Sem categoria" de R$ 500,00 |

**Invariante.** *Aparecer como linha e entrar num total são decisões distintas, e só a primeira é permitida.* A exclusão vem do tipo (`zFiltroAgregacao`) e do módulo `agregacao`, **nunca** de um `AND` repetido. **Seam:** S2, parametrizado sobre **todas** as superfícies de agregação do épico 2 (`/lancamentos/resumo`, `/relatorios/categorias`, `/relatorios/contas`, `/relatorios/entradas-saidas`, `/relatorios/tags`, `/relatorios/evolucao`). Adicionar superfície sem passar por `agregacao` faz o teste faltar — e a regra de lint de `sistema.md` §2.5 (`SUM(` só em `apps/api/src/agregacao/`) reprova o build.

### TR-3 🔺 Uma perna dentro do recorte — o caso que fazia R$ 300,00 sumirem

**Entrada.** A com `saldo_anterior(31/ago) = 100000`. Único movimento de setembro: transferência A → B de **R$ 300,00** em 10/set, efetivada. Filtro: `contas = [A]`, setembro, `eixo = caixa`, `escopo = contas`.

**Esperado.**

| Linha do rodapé | Valor |
|---|---|
| `saldo_anterior` | `100000` |
| `receita_realizada` | `0` |
| `despesa_realizada` | `0` |
| **`transferencia_liquida_realizada`** | **`−30000`** |
| `saldo` | **`70000`** |
| Identidade | `100000 + 0 + 0 + (−30000) = 70000` ✅ |

**Falha o cenário se** o rodapé exibir `saldo = 100000` com uma linha de `−R$ 300,00` visível na lista acima dele — que é o contraexemplo B da auditoria anterior, e a razão de o balde de transferência existir.

**Invariante.** `saldo_anterior + receita + despesa + transferencia_liquida = saldo`, para **um** eixo e **um** escopo. **Seam:** S1 (`identidadeDoResumo`, property-based) + S2.

### TR-4 🔺 Excluir uma perna isolada é proibido

**Entrada.** TR-1. `DELETE /lancamentos/{perna A}`.

**Esperado.**

| | |
|---|---|
| Resposta | **`409`**, código `LANCAMENTO_PERTENCE_A_TRANSFERENCIA` |
| `deleted_at` das duas pernas | **`NULL`** — nenhuma foi tocada |
| `saldo(A)`, `saldo(B)` | `50000`, `50000` |
| Saldo geral | `100000` |

**Contraprova a impedir:** se a perna de débito fosse excluída sozinha, sobraria `+50000` solto — o saldo de B sobe R$ 500,00 **do nada** e o Saldo geral vira `150000`. É o único caminho do épico 2 em que dinheiro é criado. **Seam:** S2 (só observável na borda) + `CONSTRAINT TRIGGER … DEFERRABLE` como segunda camada.

### TR-5 🔺 Excluir a transferência inteira

**Entrada.** TR-1. `DELETE /transferencias/{id}`.

**Esperado.** As **duas** pernas recebem `deleted_at` na **mesma transação**. `saldo(A) = 100000`, `saldo(B) = 0`, Saldo geral `100000`. Uma entrada em `auditoria` referenciando a transferência, não duas soltas. Em nenhum instante observável o par fica desbalanceado.

**Invariante.** *A exclusão é da `Transferencia` inteira e marca as duas pernas na mesma transação.*

### TR-6 🔺 As duas contas são a mesma — **lacuna**

**Entrada.** `POST /transferencias`: **A → A**, R$ 500,00, 10/set.

**Nada em `CONTEXT.md` nem em `sistema.md` proíbe isto.** O que acontece hoje, se for aceito:

| Grandeza | Valor |
|---|---|
| Pernas | `−50000` e `+50000`, **na mesma conta** |
| Soma das pernas | `0` — a invariante de soma-zero **passa** |
| `saldo(A)` | `100000` — **inalterado**, e correto |
| Saldo geral | `100000` — inalterado |
| Linhas no extrato de A | **2**, R$ 500,00 entrando e saindo no mesmo dia |
| `transferencia_liquida_realizada` (filtro `contas = [A]`) | `0` |

**Nenhuma invariante aritmética é violada** — e é exatamente por isso que o caso é perigoso: ele passa em toda a suíte e produz um extrato que o usuário não consegue explicar, além de abrir caminho para inflar métricas de uso. **Decisão exigida antes do aceite:** recusar com `422 ORIGEM_IGUAL_DESTINO` (recomendado — `criarTransferencia` é o lugar, em S1) **ou** declarar por escrito que é permitido e rotulá-lo na UI. **Lacuna L4.**

### TR-7 🔺 As pernas compensam em dias diferentes — **lacuna**

**Entrada.** Transferência A → B de R$ 500,00, `posted_at = 30/set` nas duas pernas. Perna de débito `settled_at = 2026-09-30T10:00-03:00`; perna de crédito `settled_at = 2026-10-01T10:00-03:00` (TED que caiu no dia seguinte).

**Esperado, com o modelo como está hoje:**

| Grandeza | Valor |
|---|---|
| Soma das pernas (por valor) | `0` ✅ |
| `saldo(A, 30/set)` | `50000` |
| `saldo(B, 30/set)` | **`0`** |
| **Saldo geral em 30/set** | **`50000`** — R$ 500,00 a menos |
| Saldo geral em 01/out | `100000` — volta |

**Nenhuma invariante escrita é violada,** e mesmo assim o número principal do produto perde R$ 500,00 por um dia. **Decisão exigida:** ou as duas pernas compartilham `settled_at` por construção (recomendado no MVP — `criarTransferencia` grava um só), ou o produto declara a existência de *dinheiro em trânsito* e o Saldo geral ganha uma linha para ele. **Lacuna L5.** Sem decisão, o comportamento varia por quem implementa.

### TR-8 ⏳ Editar o valor edita as duas pernas

**Entrada.** TR-1. `PATCH` do valor para R$ 700,00.

**Esperado.** As duas pernas viram `−70000` e `+70000` na mesma transação; soma zero preservada; `saldo(A) = 30000`, `saldo(B) = 70000`, Saldo geral `100000`. **Não existe caminho de API que altere uma perna só** — o `PATCH` sobre uma perna isolada devolve `409`, como o `DELETE`.

---

## 3. Estorno

> `CONTEXT.md`, **Estorno**: lançamento **novo**, de sinal oposto, apontando o original por `estorno_de_lancamento_id`. Nunca edição, nunca exclusão.

### ES-1 🔺 Estorno total — o par soma zero

**Entrada.** Conta A, `saldo_anterior = 100000`. `L` = despesa Mercado `−10000`, 05/set, efetivada. `E` = estorno de `L`, `+10000`, 20/set, efetivado, **mesma conta, mesma categoria (Mercado), mesma moeda**.

**Esperado.**

| Grandeza | Cálculo | Valor |
|---|---|---|
| `L.valor + E.valor` | `−10000 + 10000` | **`0`** |
| `saldo(A, 30/set)` | `100000 − 10000 + 10000` | **`100000`** |
| `despesa_realizada` de setembro | `−10000 + 10000` | **`0`** |
| `receita_realizada` | `E` está numa categoria de **despesa** | **`0`** |
| `L.valor` depois do estorno | **`−10000`** — imutável | |
| Linhas na listagem | **2** — o fato e o desfazimento, os dois registrados | |

**Invariante.** O estorno **não ganha balde**: é linha comum na natureza da categoria do original e reduz o total **por soma**. A partição é por `Categoria.natureza`, **nunca pelo sinal** — pelo sinal, `E` seria contado como receita e a despesa do mês ficaria em `−10000` com R$ 100,00 de receita inventada. **Seam:** S1.

### ES-2 🔺 Estorno parcial e o acumulado

**Entrada.** `L` = `−10000` (Mercado, 05/set). Sequência de estornos:

| Passo | Estorno | `estornadoAcumulado(L)` antes | Esperado |
|---|---|---|---|
| 1 | `E1 = +3000` | `0` | **aceito** · acumulado `3000` |
| 2 | `E2 = +8000` | `3000` | **recusado** — `3000 + 8000 = 11000 > 10000` |
| 3 | `E3 = +7000` | `3000` | **aceito** · acumulado `10000` |
| 4 | `E4 = +1` (um centavo) | `10000` | **recusado** |

**Esperado ao fim.** `despesa_realizada` de setembro = `−10000 + 3000 + 7000 = 0`. `saldo(A) = 100000`. `L.valor` continua `−10000`.

**Invariante.** `|Σ estornos| <= |original|`, verificado **contra o acumulado**, não contra o último. Um centavo além reprova. **Seam:** S1 (`estornadoAcumulado`) + S2 (`CONSTRAINT TRIGGER`, para provar que a regra vale sob concorrência: dois `E = +6000` simultâneos não podem ambos passar).

### ES-3 🔺 Estorno maior que o original

**Entrada.** `L = −10000`. `E = +15000`.

**Esperado.** **Recusado**, `422 ESTORNO_EXCEDE_ORIGINAL`. Nenhuma linha criada. `saldo(A) = 90000`.

**Invariante.** Devolver mais do que se pagou não é estorno — é receita, e o usuário a lança como tal. Aceitar transformaria uma despesa em lucro no relatório de categorias.

### ES-4 🔺 Estorno de estorno — **lacuna**

**Entrada.** `L = −10000` (Mercado). `E1 = +10000` (estorno de `L`). `E2 = −10000` com `estorno_de_lancamento_id = E1` (a loja cobrou de volta).

**Esperado aritmeticamente:**

| Grandeza | Cálculo | Valor |
|---|---|---|
| Efeito líquido | `−10000 + 10000 − 10000` | **`−10000`** — a despesa voltou a valer |
| `despesa_realizada` de setembro | mesma categoria, soma | **`−10000`** ✅ |
| `saldo(A)` | `100000 − 10000` | **`90000`** ✅ |

**O defeito:** `estornadoAcumulado(L)` conta apenas as linhas com `estorno_de_lancamento_id = L` e continua valendo **`10000`**. Um estorno novo de `L` de R$ 1,00 é **recusado**, embora `E2` já tenha desfeito `E1` e não haja nada estornado de fato. Os números do saldo e do relatório estão certos; a **guarda** está errada.

**Decisão exigida:** ou `estornadoAcumulado` percorre a cadeia (`Σ` dos estornos de `L` menos `Σ` dos estornos desses estornos), ou o estorno de estorno é **proibido** e o caminho correto é um lançamento novo comum. **Lacuna L6.** Marcado 🔺 porque a guarda errada bloqueia uma operação legítima do usuário, e isso vira chamado de suporte insolúvel pela UI.

### ES-5 🔺 Excluir o original estornado deixa o estorno órfão — **lacuna**

**Entrada.** `L = −10000` (efetivado), `E = +10000` (estorno de `L`, efetivado). `saldo(A) = 100000`. Agora: `DELETE /lancamentos/L`.

**Esperado hoje, se a exclusão for aceita:**

| Grandeza | Valor |
|---|---|
| `saldo(A)` | **`110000`** — R$ 100,00 **criados do nada** |
| `despesa_realizada` de setembro | **`+10000`** — despesa positiva |
| `E.estorno_de_lancamento_id` | aponta para uma linha `deleted_at` |

É o **mesmo defeito da perna solta de TR-4**, numa estrutura que ninguém protegeu: `sistema.md` §4.1 recusa `DELETE` de lançamento com `transfer_group_id` ou `installment_group_id`; `estorno_de_lancamento_id` **não está na lista**.

**Esperado após a correção:** `409 LANCAMENTO_POSSUI_ESTORNO`, ou exclusão em cascata da cadeia inteira na mesma transação. **Lacuna L7.** 🔺 — é o segundo caminho do épico 2 em que dinheiro é criado.

### ES-6 🔺 Estorno com atributo divergente

**Entrada.** `L = −10000`, conta A, categoria Mercado, BRL. Quatro tentativas:

| Tentativa | Esperado |
|---|---|
| `E` na conta **B** | **recusado** — `ESTORNO_CONTA_DIVERGENTE` |
| `E` na categoria **Restaurante** | **recusado** — `ESTORNO_CATEGORIA_DIVERGENTE` |
| `E` em **USD** | **recusado** — `moedas-divergentes` (o `Money` recusa antes) |
| `E` com sinal **negativo** (`−5000`) | **recusado** — estorno tem sinal oposto ao original |

**Invariante.** *Sinal oposto ao do original, mesma Conta ou Cartao, mesma Categoria e mesma moeda.* A categoria igual é o que faz `original + estorno = 0` **dentro da natureza**, sem regra especial de agregação; categoria diferente reabre o buraco que a partição por natureza fechou.

### ES-7 ⏳ Estorno cruzando competência

**Entrada.** `L = −10000`, `posted_at = 30/set`, efetivada. `E = +10000`, `posted_at = 02/out`, efetivado.

**Esperado (eixo competência, que é o único do épico 2):**

| Competência | `despesa_realizada` |
|---|---|
| setembro | **`−10000`** |
| outubro | **`+10000`** |
| set + out | **`0`** |

**Invariante.** Cada mês registra o que aconteceu nele; o par só se anula no horizonte que contém os dois. **Comportamento declarado, não defeito** — mas precisa estar congelado em teste, porque no épico 3, sob a base `data_compra`, a regra muda (o estorno de parcelada volta para a competência da compra) e a diferença tem de ser deliberada.

### ES-8 ⏳ Estorno de lançamento `previsto` ou `pendente` — **lacuna**

**Entrada.** `L = −10000`, `posted_at = 25/set` (futuro), `settled_at = NULL` → `previsto`. Tentar estornar.

**Pergunta sem resposta escrita:** qual é o `settled_at` do estorno de algo que não compensou? Desfazer o que ainda não aconteceu é **exclusão**, não estorno — mas nada no modelo impede o estorno. **Decisão exigida:** recusar estorno de lançamento sem `settled_at` (recomendado), ou declarar o `settled_at` do estorno como `NULL` e provar que o par continua somando zero nos três estados. **Lacuna L10.**

### ES-9 ⏳ Estorno de perna de transferência — **lacuna**

**Entrada.** Perna de débito de TR-1 (`−50000`, `categoria_id = NULL`). Tentar estornar.

**Esperado.** **Recusado** — `ESTORNO_DE_PERNA_PROIBIDO`. A regra "mesma Categoria" é vacuamente satisfeita por dois nulos, então a validação atual **deixa passar**, e o resultado seria uma perna de crédito sem par, com `transfer_group_id` nulo: a soma-zero do grupo continua valendo e o saldo de A sobe R$ 500,00 do nada. Desfazer uma transferência é excluir a `Transferencia` inteira (TR-5). **Lacuna L12.**

---

## 4. O rodapé realizado × previsto

> A igualdade que o `arquiteto-solucao` se comprometeu a provar: **somar todas as páginas dá exatamente o resumo.**

### RP-1 🔺 Soma das páginas = resumo, com paginação e transferência

**Entrada.** Setembro/2026, `eixo = competencia`, `escopo = contas`, **sem filtro de conta**. Página = **3 linhas**. Hoje = 15/set 12h.

| # | Data | Conta | Categoria | Valor | `settled_at` | Status |
|---|---|---|---|---|---|---|
| 1 | 01/set | A | Salário | `+300000` | 01/set | `efetivado` |
| 2 | 05/set | A | Mercado | `−50000` | 05/set | `efetivado` |
| 3 | 10/set | A | — (perna) | `−80000` | 10/set | `efetivado` |
| 4 | 10/set | B | — (perna) | `+80000` | 10/set | `efetivado` |
| 5 | 12/set | A | Luz | `−120000` | `NULL` | `pendente` |
| 6 | 20/set | B | Salário | `+40000` | `NULL` | `previsto` |
| 7 | 25/set | A | Água | `−10000` | `NULL` | `previsto` |

Sete linhas → **três páginas** (3 + 3 + 1).

**Resumo esperado:**

| Balde | Cálculo | Valor |
|---|---|---|
| `receita_realizada` | #1 | **`+300000`** |
| `receita_prevista` | #6 | **`+40000`** |
| `despesa_realizada` | #2 + #5 (**pendente é realizado**) | **`−170000`** |
| `despesa_prevista` | #7 | **`−10000`** |
| `transferencia_liquida_realizada` | #3 + #4 | **`0`** |
| `transferencia_liquida_prevista` | — | **`0`** |
| **`realizado`** | `300000 − 170000 + 0` | **`+130000`** |
| **`projetado`** | `130000 + 40000 − 10000 + 0` | **`+160000`** |

**Esperado do teste.** Percorrer as três páginas, distribuir **cada linha** no seu balde pelo mesmo predicado, e comparar com o resumo: **igualdade exata, balde a balde**. Nenhuma linha em dois baldes, nenhuma linha em nenhum.

**Variante com `contas = [A]`** — cinco linhas (#1, #2, #3, #5, #7), duas páginas (3 + 2):

| Balde | Valor |
|---|---|
| `receita_realizada` | `+300000` |
| `despesa_realizada` | `−170000` |
| `transferencia_liquida_realizada` | **`−80000`** |
| `despesa_prevista` | `−10000` |
| `realizado` | `300000 − 170000 − 80000 =` **`+50000`** |
| `projetado` | `50000 − 10000 =` **`+40000`** |

**Invariante.** `GET /lancamentos` e `GET /lancamentos/resumo` derivam do **mesmo `zFiltroBase`** e chamam o **mesmo tradutor**. Se divergirem, o usuário vê uma soma que não bate com as linhas na tela dele. **Seam:** S2.

### RP-2 🔺 `agora` congelado entre a listagem e o resumo — **lacuna**

**Entrada.** Um lançamento de **R$ 400,00** (despesa, Luz), `posted_at = 2026-09-15T12:30:00-03:00`, `settled_at = NULL`. O cliente pede:

- página 1 da listagem às **12:29:50** → `posted_at > agora` → **`previsto`** → `despesa_prevista`
- o resumo às **12:30:10** → `posted_at <= agora` → **`pendente`** → `despesa_realizada`

**Esperado hoje:** Σ páginas ≠ resumo em **R$ 400,00 em dois baldes ao mesmo tempo**, sem nenhuma escrita entre as duas requisições. O predicado `realizado := settled_at IS NOT NULL OR posted_at <= :agora` depende do instante da consulta, e cada requisição traz o seu.

**Esperado após a correção:** `agora` é **parâmetro do filtro**, congelado no cursor assinado (já dentro do `hash_do_filtro`), ecoado na resposta, e as duas rotas usam o mesmo. Com isso, o cenário fecha em qualquer instante de execução.

**Invariante.** A igualdade "soma das páginas = resumo" só é bem definida se os dois lados usarem **o mesmo `agora`**. **Lacuna L8.** É a razão pela qual este teste é intermitente se escrito ingenuamente — e um teste intermitente acaba desativado.

### RP-3 🔺 A identidade do eixo competência

**Entrada.** RP-1, variante `contas = [A]`.

**Esperado.**

```
realizado = receita_realizada + despesa_realizada + transferencia_liquida_realizada
          = 300000 + (−170000) + (−80000) = +50000                      ✅

projetado = realizado + receita_prevista + despesa_prevista + transferencia_liquida_prevista
          = 50000 + 0 + (−10000) + 0     = +40000                        ✅
```

**E:** neste eixo **não existe linha `saldo`** no rodapé. Somar caixa de conta com competência produz um segundo número para "quanto eu tenho".

**Invariante.** `domain/agregacao.identidadeDoResumo(r)` verifica isto para qualquer resumo. **Seam:** S1 com `fast-check` sobre conjuntos gerados de lançamentos + S2 afirmando sobre a resposta real.

### RP-4 🔺 A identidade do eixo caixa quebra com um lançamento `pendente` — **lacuna**

**Entrada.** Conta A, `saldo_anterior(31/ago, eixo caixa) = 100000`. Único movimento de setembro: despesa Mercado de **R$ 100,00**, `posted_at = 10/set`, `settled_at = NULL` → `pendente`. Consulta em 30/set 23h, `eixo = caixa`, `escopo = contas`, `contas = [A]`.

**Esperado com os predicados como estão escritos hoje** (`sistema.md` §4.4, `realizado := settled_at IS NOT NULL OR posted_at <= :agora`):

| Linha do rodapé | Valor |
|---|---|
| `saldo_anterior` | `100000` |
| `despesa_realizada` | **`−10000`** |
| `saldo` (`= saldo_anterior + Σ lançamentos com settled_at no período`) | **`100000`** |
| Identidade | `100000 + (−10000) =` **`90000` ≠ `100000`** |

**Três números na mesma tela que não fecham, por R$ 100,00.** A causa é estrutural: `realizado = efetivado + pendente` é a definição do **eixo competência** (`CONTEXT.md`, **Realizado**), e ela foi aplicada ao SQL sem qualificar o eixo — enquanto `saldo` conta **só `efetivado`** (`CONTEXT.md`, **Saldo**). É o herdeiro direto do contraexemplo B: mesmo defeito, causa nova.

**Esperado após a correção** — no eixo caixa, `realizado := settled_at IS NOT NULL`:

| Linha | Valor |
|---|---|
| `despesa_realizada` | **`0`** |
| `despesa_prevista` | **`−10000`** |
| `saldo` | `100000` ✅ |
| `projetado` | `90000` ✅ |

**Lacuna L1 — bloqueia.** O predicado de `realizado` depende do eixo, e isso não está escrito em lugar nenhum. Sem a regra, as duas implementações são defensáveis e só uma fecha a identidade.

### RP-5 🔺 O balde que falta: categoria não analítica

**Entrada.** SD-10 (salário `+300000`, mercado `−50000`, ajuste de saldo `−30000`), `eixo = caixa`, `escopo = contas`, `contas = [A]`, `saldo_anterior = 100000`.

**Esperado com os seis baldes de hoje:** identidade dá `350000`, saldo derivado dá `320000` — **R$ 300,00 de divergência** (conta em SD-10).

**Esperado após a correção** — um sétimo balde, `nao_analitica_liquida_realizada` (e o par `_prevista`):

| Balde | Valor |
|---|---|
| `receita_realizada` | `+300000` |
| `despesa_realizada` | `−50000` |
| `transferencia_liquida_realizada` | `0` |
| **`nao_analitica_liquida_realizada`** | **`−30000`** |
| `saldo` | `100000 + 300000 − 50000 + 0 − 30000 =` **`320000`** ✅ |

**Nota documental:** `sistema.md` §4.1 promete "resumo com **sete** baldes"; o SQL do §4.4 define **seis**. O sétimo nunca foi escrito. **Lacuna L2.**

**Invariante.** Toda grandeza que altera o saldo tem um balde no rodapé. Sem isso o rodapé mente por desenho — foi a lição de B1, e ela vale para `analitica = false` exatamente como valeu para a transferência.

### RP-6 ⏳ Empate de `posted_at` na borda da página

**Entrada.** Cinco lançamentos com **o mesmo `posted_at`** (`10/set 09:00`), valores `−1000, −2000, −3000, −4000, −5000`. Página = 2.

**Esperado.** Três páginas (2 + 2 + 1). Cada lançamento aparece **exatamente uma vez**. `Σ páginas = −15000 = despesa_realizada`. O desempate é por `id DESC` dentro do keyset assinado, e não por `OFFSET`.

**Invariante.** "Sumiu um lançamento ao rolar" é indistinguível de perda de dado. O teste roda com inserção concorrente durante a paginação.

---

## 5. Categoria de dois níveis

### CAT-1 🔺 Só folha recebe lançamento — **contradição entre documentos aceitos**

**Entrada.** `Casa` (raiz, despesa) com filhas `Luz` e `Água`. `POST /lancamentos` com `categoria_id = Casa`, `−5000`.

**O modelo hoje permite.** `CONTEXT.md` declara três invariantes de hierarquia — dois níveis, natureza herdada, arquivar o pai arquiva as filhas — e **não** declara que a raiz com filhas recusa lançamento. O esquema (`sistema.md` §3.2) tem `CHECK ((nivel = 1) = (parent_id IS NULL))` e nada mais.

**E o cenário 4.5 da auditoria anterior, homologado ✅, usa "Alimentação (raiz) −40000" como realizado próprio da raiz** — ou seja, o desenho aceito **assume** que a raiz recebe lançamento direto.

**As duas leituras, com números:**

| | Leitura A — só folha recebe | Leitura B — a raiz também recebe |
|---|---|---|
| `POST` em `Casa` | **`422 CATEGORIA_NAO_E_FOLHA`** | aceito |
| Total de `Casa` (com Luz `−18000` e Água `−12000`) | `−30000` | **`−35000`** |
| A UI precisa de | nada | uma linha **"Casa (direto)"** distinta do total agregado |
| Risco se não distinguir | — | `Casa −35000` **e** `Casa −5000` na mesma lista ⟹ **R$ 50,00 contados duas vezes** |

**Decisão exigida antes do aceite do épico.** As duas são defensáveis; a ausência da escolha não é. Se for a Leitura B, o relatório por categoria precisa de um item explícito para o realizado próprio da raiz, e CAT-2 muda de números. **Lacuna L3.**

### CAT-2 🔺 Soma por categoria-pai não conta duas vezes

**Entrada.** Setembro, conta A, todos efetivados, **todos em folhas** (Leitura A):

| Categoria | Pai | Valor |
|---|---|---|
| Luz | Casa | `−18000` |
| Água | Casa | `−12000` |
| Restaurante | Alimentação | `−25000` |
| Mercado | Alimentação | `−40000` |

**Esperado.**

| Grandeza | Cálculo | Valor |
|---|---|---|
| `Casa` (agregado) | `−18000 − 12000` | **`−30000`** |
| `Alimentação` (agregado) | `−25000 − 40000` | **`−65000`** |
| **Total do relatório por categoria** | `−30000 − 65000` | **`−95000`** |
| Soma ingênua (raízes + folhas) | `−95000 − 95000` | `−190000` ← **errado, o dobro** |
| `despesa_realizada` do rodapé | — | **`−95000`** |

**Invariante-ponte.** O total do relatório por categoria **é igual** ao `despesa_realizada` do rodapé, para o mesmo recorte. Duas superfícies, um número — e as duas passam por `agregacao`. **Seam:** S2.

### CAT-3 🔺 Categoria arquivada continua classificando o histórico

**Entrada.** Lançamento em `Mercado`, `−20000`, 05/ago, efetivado. Em 01/set: `POST /categorias/Mercado/arquivar`.

**Esperado.**

| Verificação | Esperado |
|---|---|
| Relatório de **agosto** | **`Mercado −20000`** — presente, com nome e cor |
| `despesa_realizada` de agosto | **`−20000`** — inalterada |
| `saldo(A)` | inalterado |
| `GET /categorias` (seletor) | `Mercado` **ausente** |
| `POST /lancamentos` em `Mercado` | **`422 CATEGORIA_ARQUIVADA`** |
| `PATCH` de lançamento **já em** `Mercado` (outro campo) | **aceito** — os existentes permanecem intactos |
| `deleted_at` de `Mercado` | **`NULL`** — arquivar não é excluir |

**Invariante.** *Arquivar tira do seletor; excluir tira do sistema.* Se arquivar apagasse a categoria do histórico, R$ 200,00 mudariam de balde retroativamente e o relatório de agosto mudaria depois de fechado.

### CAT-4 🔺 Arquivar o pai arquiva as filhas

**Entrada.** `POST /categorias/Casa/arquivar`, com `Luz` e `Água` ativas e com lançamentos.

**Esperado.** `Casa`, `Luz` e `Água` com `arquivada_em` preenchido, na **mesma transação**. Nenhum lançamento novo em nenhuma das três. O relatório do passado continua exibindo `Casa −30000` com o detalhe das duas filhas. `deleted_at` de todas: `NULL`.

**Contraprova a impedir:** arquivar só o pai deixaria `Luz` e `Água` visíveis no seletor sob um pai invisível.

### CAT-5 🔺 `Sem categoria` pela natureza correspondente ao sinal

**Entrada.** `POST /lancamentos` **sem** `categoria_id`, duas vezes: `−7000` e `+7000`.

**Esperado.**

| Entrada | Categoria atribuída | Balde |
|---|---|---|
| `−7000` | **`Sem categoria (despesa)`** | `despesa_realizada` |
| `+7000` | **`Sem categoria (receita)`** | `receita_realizada` |

E: `categoria_id` fica **`NOT NULL`** nos dois casos (o `CHECK categoria_obrigatoria_fora_de_transferencia` passa), e os dois entram nos totais.

**Invariante.** *`categoria_id` nulo escapa de todo agregado por natureza, em silêncio.* Sem esta regra, R$ 70,00 sumiriam do relatório e do teto global — contraexemplo V da auditoria.

### CAT-6 ⏳ Natureza herdada e profundidade máxima

**Entrada.** Três tentativas sobre `Casa` (raiz, **despesa**):

| Tentativa | Esperado |
|---|---|
| Criar filha com `natureza = receita` | **recusado** — subcategoria herda a natureza do pai |
| Criar neta (`parent_id = Luz`) | **recusado** — `CHECK`/trigger de dois níveis |
| Mudar a `natureza` de `Casa` para `receita` tendo filhas e lançamentos | **decisão exigida** — recusar (recomendado) ou reclassificar o histórico inteiro, o que move R$ 300,00 de despesa para receita retroativamente |

---

## 6. Fronteiras de período

> Regra 7 do `CLAUDE.md`: **toda janela é semiaberta `[inicio, fim)`**, em instantes UTC, com as bordas calculadas em `America/Sao_Paulo`.

### FR-1 🔺 Primeiro e último instante do mês entram exatamente uma vez

**Entrada.** Conta A. Setembro/2026 = `[2026-09-01T03:00:00Z, 2026-10-01T03:00:00Z)`.

| # | `posted_at` (UTC) | Relógio em SP | Categoria | Valor |
|---|---|---|---|---|
| L1 | `2026-09-01T03:00:00Z` | 01/set 00:00:00 — **a borda esquerda** | Salário | `+10000` |
| L2 | `2026-10-01T02:59:59Z` | 30/set 23:59:59 — **o último instante** | Luz | `−20000` |
| L3 | `2026-10-01T03:00:00Z` | 01/out 00:00:00 — **a borda direita** | Água | `−5000` |

**Esperado.**

| Competência | Linhas | `receita_realizada` | `despesa_realizada` |
|---|---|---|---|
| agosto | — | `0` | `0` |
| **setembro** | **L1, L2** | **`+10000`** | **`−20000`** |
| **outubro** | **L3** | `0` | **`−5000`** |

**Invariante.** `inicio <= t < fim`. A borda esquerda **pertence** ao mês; a borda direita pertence ao **seguinte**. Cada lançamento aparece em **exatamente uma** competência: nem duas vezes, nem em nenhuma. **Seam:** S1 (`tempo.contem`, já implementado) + S2 (o recorte real do filtro).

### FR-2 🔺 A virada usa o fuso, não o UTC

**Entrada.** Despesa de **R$ 500,00**, Luz, conta A, efetivada, `posted_at = settled_at = 2026-09-01T01:00:00Z` — que em São Paulo é **31/ago às 22h00**.

**Esperado.**

| Grandeza | Correto (fuso do tenant) | Errado (`::date` em UTC) |
|---|---|---|
| Competência | **agosto** | setembro |
| `despesa_realizada` de agosto | **`−50000`** | `0` |
| `despesa_realizada` de setembro | **`0`** | `−50000` |
| `saldo_snapshots.data_civil` | **`2026-08-31`** | `2026-09-01` |
| `saldo_anterior` de setembro (snapshot de 31/ago) | **contém** os `−50000` | **não contém** |

**Com as duas coerções trocadas** (job em UTC, filtro no fuso), os R$ 500,00 **não estão no saldo anterior de setembro nem nas despesas de setembro, e o rodapé de agosto já foi fechado: o dinheiro some do ano inteiro.** Com as duas ao contrário, é contado **duas vezes**. É o contraexemplo D da auditoria.

**Invariante.** Nenhum `::date` sobre `TIMESTAMPTZ` sem `AT TIME ZONE` explícito, e a zona é **IANA**, nunca `-03:00`. **Seam:** S1 (`dataCivilDe`, `competenciaDe`) + S2 (o snapshot real, com o job real).

### FR-3 🔺 Janelas consecutivas encostam por igualdade

**Entrada.** `janelaDaCompetencia(2026-09)` e `janelaDaCompetencia(2026-10)`.

**Esperado.**

```
fim(setembro)  === inicio(outubro)  === 2026-10-01T03:00:00Z
```

E a propriedade, sobre 240 meses gerados: para qualquer competência `k`, `fim(k) === inicio(k+1)`, e nenhum instante gerado cai em duas janelas nem em nenhuma.

**Invariante.** Contiguidade e disjunção verificáveis por **igualdade**, não por "o instante seguinte" — que não existe em `TIMESTAMPTZ` e produziu o contraexemplo J. **Seam:** S1, property-based.

### FR-4 🔺 Comparação entre períodos usa a mesma fronteira nos dois lados

**Entrada.** Comparar setembro/2026 com agosto/2026. Cada mês contém um lançamento na borda: agosto tem L de FR-2 (`−50000`, 31/ago 22h SP) e setembro tem L1/L2 de FR-1.

**Esperado.** As duas janelas são construídas pela **mesma função**, com a mesma fronteira e o mesmo fuso; a resposta carrega o eixo e a fronteira usados. `despesa(ago) = −50000`, `despesa(set) = −20000`, variação = `+30000`.

**Falha o cenário se** um lado usar `[de, ate)` e o outro `[de, ate]` — a variação percentual passa a ser inventada, e o teste de um lado só nunca a detecta.

### FR-5 ⏳ Horário de verão histórico

**Entrada.** Competência de **outubro/2017**, quando o horário de verão brasileiro começou em 15/out (o relógio pulou de 00:00 para 01:00).

**Esperado.** `inicioDoDiaCivil({2017,10,15})` devolve o **primeiro instante após o salto**, de forma determinística; a janela de outubro/2017 continua contígua com a de setembro e a de novembro; nenhum lançamento fica fora de todas as competências. `tempo.ts` já resolve "para frente" — o cenário congela a decisão.

**Invariante.** *O Brasil já teve horário de verão e pode voltar a ter.* Offset fixo `-03:00` reprova.

---

## 7. Os três estados

> `status` é **derivado, nunca coluna**: `efetivado` se `settled_at != null`; senão `previsto` se `posted_at` está no futuro; senão `pendente`.

### ST-1 🔺 A matriz — o que conta onde

**Entrada.** Conta A, `saldo_inicial = 100000`. Hoje = **15/set 12h00**.

| # | Categoria | Valor | `posted_at` | `settled_at` | Status derivado |
|---|---|---|---|---|---|
| P | Mercado | `−10000` | 10/set | 10/set | **`efetivado`** |
| Q | Luz | `−20000` | 12/set | `NULL` | **`pendente`** |
| R | Água | `−30000` | 25/set | `NULL` | **`previsto`** |
| S | Restaurante | `−40000` | 08/set | 08/set | `efetivado`, **`deleted_at` preenchido** |
| T | — (perna de transferência A→B) | `−50000` | 09/set | 09/set | `efetivado` |
| U | Ajuste de saldo (`analitica=false`) | `−60000` | 07/set | 07/set | `efetivado` |

**Esperado — a matriz completa:**

| Grandeza | Cálculo | Valor |
|---|---|---|
| **Saldo** (`efetivado`, todos, exceto excluídos) | `100000 − 10000 − 50000 − 60000` | **`−20000`** |
| **Realizado** de setembro (competência) | `−10000 − 20000` | **`−30000`** |
| **Projetado** de setembro | `−30000 − 30000` | **`−60000`** |
| `despesa_realizada` | P + Q | **`−30000`** |
| `despesa_prevista` | R | **`−30000`** |
| `transferencia_liquida_realizada` | T | **`−50000`** |
| `nao_analitica_liquida_realizada` (após RP-5) | U | **`−60000`** |
| Projeção de caixa até 30/set | `−20000 − 20000 − 30000` | **`−70000`** |

**Linha a linha, o que cada estado faz:**

| Lançamento | Saldo | Realizado | Projetado | Relatório de gasto |
|---|---|---|---|---|
| P `efetivado` | ✅ | ✅ | ✅ | ✅ |
| Q `pendente` | ❌ | ✅ | ✅ | ✅ |
| R `previsto` | ❌ | ❌ | ✅ | ❌ |
| S excluído | ❌ | ❌ | ❌ | ❌ |
| T perna | ✅ | ❌ | ❌ | ❌ |
| U não analítica | ✅ | ❌ | ❌ | ❌ |

**Invariante.** Três coisas não contam em lugar nenhum dos totais de gasto — o excluído, a perna e a não analítica — e **duas delas contam no saldo**. É esse descasamento que exige os baldes de TR-3 e RP-5. **Seam:** S1 (`statusDe`) + S2 (todas as superfícies).

### ST-2 🔺 `compensar` e `descompensar` movem entre estados sem tocar `posted_at`

**Entrada.** Lançamento Q (`pendente`, `−20000`, `posted_at = 12/set`).

**Esperado.**

| Ação | `posted_at` | `settled_at` | Status | Saldo | Realizado |
|---|---|---|---|---|---|
| inicial | 12/set | `NULL` | `pendente` | `100000` | `−20000` |
| `POST /:id/compensar` (hoje 15/set) | **12/set — inalterado** | 15/set | **`efetivado`** | `80000` | `−20000` |
| `POST /:id/descompensar` | **12/set — inalterado** | `NULL` | **`pendente`** | `100000` | `−20000` |

**Invariante.** `posted_at` é **imutável**; o **Realizado não muda** com a compensação, só o Saldo. Compensar não é reclassificar competência. Cada transição gera entrada em `auditoria` com de → para.

### ST-3 🔺 `settled_at` nunca recebe data futura nem antecede `posted_at`

**Entrada.** Hoje = 15/set 12h. Três tentativas:

| Tentativa | Esperado |
|---|---|
| `settled_at = 2026-09-20` (futuro) | **recusado** — `SETTLED_AT_FUTURO` |
| `settled_at = 05/set` com `posted_at = 10/set` | **recusado** — `CHECK compensacao_nao_antecede_competencia` |
| `settled_at = 15/set 11:59` com `posted_at = 10/set` | **aceito** |

**Invariante.** *`settled_at != null` ⟹ o dinheiro se moveu.* Uma data futura em campo de compensação foi exatamente o defeito que fez toda compra de cartão nascer realizada (B4). O épico 2 não tem cartão — e é aqui que a guarda precisa nascer, antes do épico 3.

### ST-4 ⏳ O `previsto` vira `pendente` pela passagem do tempo, sem escrita

**Entrada.** Lançamento de `−40000`, `posted_at = 2026-09-15T18:00:00-03:00`. Duas consultas, **sem nenhuma escrita entre elas**:

| Consulta em | Status | `despesa_realizada` | `despesa_prevista` |
|---|---|---|---|
| 15/set 17:59 | `previsto` | `0` | `−40000` |
| 15/set 18:01 | `pendente` | `−40000` | `0` |

**Esperado.** As duas leituras estão **corretas** — é a consequência declarada de `status` derivado. O que o cenário congela é: (a) nenhum job precisou rodar; (b) a UI precisa saber que o rodapé muda ao longo do dia; (c) toda comparação entre duas respostas usa o **mesmo `agora`** (ver RP-2).

**Invariante.** *Coluna de status envelhece quando um job esquece de virá-la.* O preço é este, e ele é aceito — mas precisa estar escrito, senão vira chamado de "o número mudou sozinho".

---

## 8. Lacunas e contradições encontradas ao montar esta bateria

Registradas, não contornadas. As marcadas **bloqueia** precisam de resposta escrita antes do aceite do épico 2.

| # | Lacuna | Cenário | Onde corrigir | Grau |
|---|---|---|---|---|
| **L1** | O predicado `realizado` do §4.4 (`efetivado + pendente`) é a definição do **eixo competência** e foi aplicado a todos os eixos. No eixo caixa a identidade do rodapé não fecha | RP-4 | `sistema.md` §4.4 · `domain/agregacao` | **bloqueia** |
| **L2** | Falta o balde de `Categoria.analitica = false`. §4.1 promete **sete** baldes; §4.4 define **seis**. O ajuste de saldo altera o saldo e não aparece em nenhum balde | SD-10, RP-5 | `sistema.md` §4.1/§4.4 · `contracts/filtro-lancamentos` | **bloqueia** |
| **L3** | "Só folha recebe lançamento" **não está escrito** em `CONTEXT.md` nem no esquema — e o cenário 4.5 homologado da auditoria anterior assume o contrário | CAT-1 | `CONTEXT.md` **Categoria** + `CHECK`/trigger | **bloqueia** |
| **L4** | `Transferencia` com origem = destino não é proibida e passa em todas as invariantes aritméticas | TR-6 | `CONTEXT.md` **Transferencia** · `domain/transferencia` | **bloqueia** |
| **L5** | As duas pernas podem ter `settled_at` distintos; o Saldo geral perde o valor da transferência por um dia | TR-7 | `CONTEXT.md` **Transferencia** · `criarTransferencia` | **bloqueia** |
| **L6** | `estornadoAcumulado` não desconta estornos de estorno: a guarda recusa uma operação legítima | ES-4 | `domain/estorno` | **bloqueia** |
| **L7** | Excluir o **original** de um estorno não é recusado. `sistema.md` §4.1 lista `transfer_group_id` e `installment_group_id`, e omite `estorno_de_lancamento_id` | ES-5 | `sistema.md` §4.1 · `lancamentos.excluir` | **bloqueia** |
| **L8** | `agora` não é parâmetro do filtro. Listagem e resumo podem discordar de um balde inteiro sem nenhuma escrita | RP-2 | `contracts/filtro-lancamentos` · cursor assinado | **bloqueia** |
| **L9** | "Snapshot **stale**" nunca foi definido. `saldo_anterior` "cai para o derivado quando ausente ou stale" é indecidível, e `fonte: 'snapshot' \| 'derivado'` fica não determinístico | SD-8, SD-9 | `sistema.md` §4.4 · `saldos.materializar` | ressalva |
| **L10** | Estorno de lançamento `previsto` ou `pendente`: o `settled_at` do estorno não tem regra | ES-8 | `CONTEXT.md` **Estorno** | ressalva |
| **L11** | O keyset é sempre `(posted_at DESC, id DESC)`, inclusive quando `eixo = caixa` — a listagem ordena por uma coluna que não é a do recorte | RP-1 | `sistema.md` §4.2 | ressalva |
| **L12** | Estorno de perna de `Transferencia` não é proibido; a regra "mesma Categoria" é vacuamente satisfeita por dois nulos | ES-9 | `domain/estorno` | ressalva |
| **L13** | `SUM(...) FILTER (...)` sobre conjunto vazio devolve `NULL`; sem `COALESCE`, a primeira conta de um usuário novo exibe saldo vazio | SD-6 | `apps/api/src/agregacao/` | ressalva |

### 8.1 A lacuna isolada mais grave

**L1, com L2 logo atrás.** As duas são o mesmo defeito de B1, uma revisão depois: **uma grandeza que altera o saldo sem ter balde no rodapé.** O balde de transferência foi criado; a categoria não analítica e o lançamento `pendente` no eixo caixa não foram. Enquanto isso não for resolvido, `identidadeDoResumo` não pode ser afirmada como propriedade — e ela é a garantia que o `arquiteto-solucao` se comprometeu a provar neste épico.

A correção não é somar mais um `CASE`. É `domain/agregacao` declarar o `Balde` como **enum fechado e exaustivo**, com o compilador exigindo que todo lançamento caia em exatamente um: receita, despesa, perna de transferência, não analítica. Um lançamento sem balde tem de ser erro de tipo, não divergência descoberta em produção.

---

## 9. Resumo do aceite

**49 cenários: 40 🔺 obrigatórios, 9 ⏳ adiáveis.**

| Seção | 🔺 | ⏳ | Total |
|---|---|---|---|
| 1 · Saldo derivado | 10 | 1 | 11 |
| 2 · Transferência | 7 | 1 | 8 |
| 3 · Estorno | 6 | 3 | 9 |
| 4 · Rodapé realizado × previsto | 5 | 1 | 6 |
| 5 · Categoria | 5 | 1 | 6 |
| 6 · Fronteiras de período | 4 | 1 | 5 |
| 7 · Os três estados | 3 | 1 | 4 |

**Condição de liberação do épico 2:**

1. Os **40 cenários 🔺** passam, contra Postgres real onde o seam é S2.
2. As **oito lacunas que bloqueiam** (L1–L8) têm resposta escrita no documento indicado — não no código, e não neste arquivo.
3. As cinco ressalvas (L9–L13) entram na dívida com dono e prazo.
4. Nenhum cenário é dado como passado sem a saída do comando colada. *Teste que não foi executado não passou.*

**Entregar os contraexemplos ao `engenheiro-qa-automacao`** para virarem propriedade permanente da suíte — em particular SD-10, RP-4, TR-6, TR-7 e ES-4, que **somam certo** e mesmo assim estão errados. Nenhum property test de soma os detecta, e foi assim que os defeitos anteriores atravessaram duas revisões de documento aceito.
