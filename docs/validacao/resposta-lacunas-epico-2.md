# Resposta às 13 lacunas da bateria do épico 2

- **Data:** 2026-09-02
- **Autor:** `arquiteto-dominio-financeiro`
- **Responde a:** `docs/validacao/bateria-epico-2.md` §8
- **Escreve em:** `CONTEXT.md` · ADR 0021 · ADR 0022

A bateria pediu **resposta escrita, no documento indicado — não no código**. Este é o documento. Cada lacuna tem um veredito, um lugar onde a decisão passou a viver, e um dono para o que sobra.

Nada aqui está resolvido "no commit". Uma lacuna cuja única resposta é o comportamento do código continua aberta: foi exatamente essa a causa de L1 e L3.

---

## 1. O achado que atravessa L2 e L3

**`analitica` carregava dois significados, e a leitura errada tornava `Ajuste de saldo` inalcançável.**

`0006_nucleo.sql` comenta a coluna com *"Só folha recebe lançamento"* e o gatilho `lancamento_coerente` recusa todo lançamento em categoria `analitica = false`. Mas `CONTEXT.md` define `analitica = false` como *"não é fato econômico"* — e nomeia uma única categoria assim: `Ajuste de saldo`.

As duas leituras juntas produzem isto: **a única categoria para a qual o campo existe é a única em que ele é inalcançável.** Os cenários SD-10, RP-5 e a linha `U` de ST-1 não são representáveis no esquema entregue. O sétimo balde nunca foi escrito porque nada podia cair nele.

L2 e L3 não são duas lacunas vizinhas. São **a mesma**, vista de dois lados. Por isso as duas se fecham juntas, e por isso a decisão de L3 tinha de vir antes da de L2.

Não houve incidente porque nada cria categoria não analítica hoje: `DEFAULT TRUE`, nenhuma migration semeia as categorias de sistema, e o ramo do gatilho é código morto. O custo de corrigir é o de agora.

---

## 2. Veredito, lacuna a lacuna

| # | Veredito | Onde vive agora | Dono do que resta |
|---|---|---|---|
| **L1** | **Fechada.** `realizado` depende do eixo: competência = `settled_at` ou `posted_at` passado; caixa = `settled_at`, e nada mais | `CONTEXT.md` **Realizado depende do eixo** (já escrito no commit `ea3a332`) | — |
| **L2** | **Fechada.** Quarto balde `nao_analitica`. Os "sete baldes" eram nove campos: `Balde × {realizada, prevista}` + `saldoAnterior` | `CONTEXT.md` **Balde** · **ADR 0022** | `arquiteto-solucao` reescreve `sistema.md` §4.1/§4.4 |
| **L3** | **Fechada. A raiz recebe lançamento** (Leitura B). Não existe regra de folha; `analitica` não é "é folha" | `CONTEXT.md` **Categoria** · **ADR 0021** | `engenheiro-backend`: migration nova removendo o ramo do gatilho |
| **L4** | **Fechada. Proibida**, `ORIGEM_IGUAL_DESTINO`. A definição diz *entre duas Contas* — duas, não a mesma duas vezes | `CONTEXT.md` **Transferencia**, invariante nova | `engenheiro-backend`: recusa em `criarTransferencia` (S1) |
| **L5** | **Fechada. As duas pernas compartilham `settled_at`**, gravado uma vez. Corrigido em código (TR-7); faltava estar escrito | `CONTEXT.md` **Transferencia**, invariante nova | — |
| **L6** | **Fechada. Estorno de estorno é proibido**, `ESTORNO_DE_ESTORNO_PROIBIDO`. Recobrança é fato novo, não desfazimento | `CONTEXT.md` **Estorno**, invariante nova | `engenheiro-backend` |
| **L7** | **Fechada. Excluir o original exclui a cadeia inteira**, na mesma transação. Excluir um estorno isolado é permitido. Corrigido em código; faltava a invariante | `CONTEXT.md` **Estorno**, invariante nova | — |
| **L8** | **Metade fechada.** Domínio: `agora` é **entrada** da consulta, nunca relógio lido dentro dela; duas respostas comparadas usam o mesmo. **O transporte é de arquitetura** | `CONTEXT.md` **Realizado depende do eixo**, invariante nova | 🔁 **`arquiteto-solucao`**: cursor assinado, eco na resposta, `hash_do_filtro` |
| **L9** | **Devolvida.** "Snapshot stale" é decisão de cache, não de domínio. O domínio exige só que `fonte` seja **determinística**: a mesma pergunta não pode responder `snapshot` numa vez e `derivado` na outra | — | 🔁 **`arquiteto-solucao`** + `sre-devops-vps` |
| **L10** | **Fechada, contra a recomendação do validador.** Estorno exige que o fato tenha acontecido: `pendente` e `efetivado` **podem** ser estornados; `previsto` é recusado. `settled_at` do estorno é fato próprio | `CONTEXT.md` **Estorno**, duas invariantes novas | `engenheiro-backend` |
| **L11** | **Devolvida.** Ordem do keyset é decisão de paginação. O domínio só exige que a ordenação **não altere a partição em baldes** — e não altera | — | 🔁 **`arquiteto-solucao`**: `sistema.md` §4.2 |
| **L12** | **Fechada. Estorno de perna é proibido**, `ESTORNO_DE_PERNA_PROIBIDO`. A regra "mesma Categoria" passa a exigir que **nenhuma das duas seja nula** | `CONTEXT.md` **Estorno**, invariante nova | `engenheiro-backend` |
| **L13** | **Fechada em código** (`coalesce(..., 0)` em cada balde de `SQL_BALDES`). Não é modelagem — é a diferença entre `NULL` e zero em SQL | — | `engenheiro-qa-automacao`: SD-6 congela |

**Oito bloqueantes (L1–L8): sete fechadas, uma dividida.** L8 tem a regra de domínio escrita; o mecanismo que a carrega entre duas requisições é do `arquiteto-solucao`.

---

## 3. As duas decisões em que discordei do recomendado

Registradas aqui porque a bateria propôs outra coisa, e a divergência precisa ser deliberada.

### L10 — o validador recomendou recusar estorno sem `settled_at`. Recusei a recomendação.

A regra recomendada quebra o estorno mais comum que existe, e quebra no épico seguinte. **Uma compra de cartão na fatura aberta é `pendente` até a fatura ser paga.** O lojista reembolsa antes disso o tempo todo. Sob "exige `settled_at`", o produto recusaria o reembolso e o Usuario ficaria com a compra inteira no relatório de um mês em que ela foi devolvida.

A fronteira certa não é "compensou", é **"aconteceu"**:

| Estado do original | Estorno | Por quê |
|---|---|---|
| `efetivado` | **aceito** | O dinheiro saiu e voltou |
| `pendente` | **aceito** | O fato aconteceu; o estorno cai na mesma `Fatura` e compensa junto com ela |
| `previsto` | **recusado** | Nada aconteceu. Desfazer é excluir ou editar, e as duas operações estão disponíveis |

E a pergunta que a bateria fez — *qual é o `settled_at` do estorno de algo que não compensou?* — tem resposta simples uma vez posta a fronteira: **nulo**. `settled_at` é fato próprio de cada linha, nunca copiado do original. Num Cartao, quem o escreve é o pagamento da Fatura, para o estorno como para qualquer lançamento dela.

### L6 — o validador ofereceu dois caminhos. Escolhi o proibitivo, e o justifico.

Percorrer a cadeia (`Σ estornos de L` menos `Σ estornos desses estornos`) resolve a aritmética e cria três problemas: recursão de profundidade ilimitada no caminho de escrita, sob `FOR UPDATE`; uma guarda que deixa de ser conferível por uma soma de um nível; e um conceito — "cadeia de estornos" — que não existe em nenhum lugar do glossário.

O caminho recusado **não custa nada ao Usuario**. A recobrança depois de um reembolso é um Lancamento comum, na mesma Categoria, com o sinal do original. Os números de ES-4 são idênticos:

```
L = −10000 · E1 = +10000 · L2 = −10000 (lançamento comum, não estorno)
despesa_realizada = −10000  ✅        saldo = 90000  ✅
estornoAcumulado(L) = 10000 — correto: L foi inteiramente devolvido
L2 é fato novo, e pode ser estornado por conta própria
```

Muda só o rótulo do botão: numa linha de `Estorno`, a ação oferecida é *"lançar cobrança de volta"*, não *"estornar"*.

---

## 4. O que devolvo, e a quem

Explicitamente **não resolvidas aqui**, porque não são de modelagem:

| Item | Dono | O que falta |
|---|---|---|
| **L8** (transporte de `agora`) | `arquiteto-solucao` | `agora` como campo do `zFiltroBase`, dentro do cursor assinado e do `hash_do_filtro`, ecoado na resposta. A regra de domínio já está escrita |
| **L9** (definição de *stale*) | `arquiteto-solucao` + `sre-devops-vps` | Critério decidível de invalidação do `SaldoSnapshot` e determinismo de `fonte` |
| **L11** (keyset × eixo) | `arquiteto-solucao` | `sistema.md` §4.2 |
| **`sistema.md` §4.1/§4.4** | `arquiteto-solucao` | Seis baldes por sinal → quatro por natureza, indexados pelo enum. **Não editei `docs/arquitetura/sistema.md`** |
| **CAT-6, terceira linha** — mudar `natureza` de raiz com filhas e lançamentos | `product-financeiro` | É escolha de produto entre recusar e reclassificar o histórico. Recomendo **recusar**: reclassificar move dinheiro entre naturezas retroativamente e altera relatório já fechado |
| **Rótulo "(direto)" na UI** | `engenheiro-frontend-web` + `docs/design.md` | O glossário fixa que a linha existe e o que ela significa; a forma é da interface |
| **Alerta duplicado pai/filha** (nota de 4.5 da auditoria) | `product-financeiro` | Supressão do filho quando o pai já alertou no ciclo |

---

## 5. O que muda na bateria

Para o `validador-financeiro` e o `engenheiro-qa-automacao`:

| Cenário | Muda |
|---|---|
| **CAT-1** | Inverte. `POST` em `Casa` (raiz com filhas) passa a ser **aceito**, não `422`. O cenário passa a exigir a linha `Casa (direto) −5000` e o agregado `−35000`, provando que as duas **não** aparecem somáveis na mesma lista |
| **CAT-2** | Ganha um lançamento direto na raiz. Como está, todos em folhas, ele não exercita a decisão de L3 |
| **SD-10 · RP-5 · ST-1 (linha U)** | Passam a ser representáveis. Hoje o gatilho recusa a criação do lançamento de `Ajuste de saldo` e o cenário falha antes de chegar à aritmética |
| **ES-1** | Vira o cenário que reprova a partição por sinal. Com o SQL atual, o estorno de `+10000` cai em `receita_realizada` e o mês fecha com receita inventada |
| **ES-4** | Reescrito: `E2` passa a ser recusado com `ESTORNO_DE_ESTORNO_PROIBIDO`, e o cenário prova que o Lancamento comum produz os mesmos números |
| **ES-8** | Vira três linhas — `efetivado` aceito, `pendente` aceito, `previsto` recusado — e deixa de ser ⏳ |
| **TR-6** | Fixado em `422 ORIGEM_IGUAL_DESTINO` |
| **Novo, 🔺** | **Exaustividade da partição:** `Σ dos quatro baldes = Σ dos lançamentos do universo`, property-based, com pernas, estornos e não analíticas no gerador. Substitui `identidadeDoResumo` como propriedade — a identidade passa a decorrer dela |

O `Balde` como `Record<Balde, _>` quebra `BaldesDoPeriodo`, que é tipo público consumido por API, web e mobile. Feito agora, no início do épico 3, custa uma rodada de `typecheck`.
