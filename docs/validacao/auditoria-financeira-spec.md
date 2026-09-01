# Auditoria financeira do spec — gate de risco

- **Data:** 2026-09-01
- **Auditor:** `validador-financeiro`
- **Escopo:** `CLAUDE.md` §2 · `CONTEXT.md` · ADRs 0005, 0007, 0008, 0009 · `docs/arquitetura/sistema.md` · `docs/produto/arquitetura-informacao.md` · `docs/pesquisa/organizze-teardown.md` §8
- **Objeto:** o desenho, antes de existir código. Pergunta única: **onde este desenho perde um centavo, diverge um saldo ou desloca uma data?**

> **VEREDITO: REPROVADO.** 19 bloqueios. Ver §9.
>
> Objeção do `validador-financeiro` bloqueia a fase de implementação. O spec não pode virar ticket até que os bloqueios de §9.1 tenham resposta escrita. Vários deles são contradições entre documentos aceitos — não são lacunas de detalhe, são dois números diferentes para o mesmo fato, e a implementação escolheria um ao acaso.

Todo contraexemplo abaixo usa números redondos e é conferível à mão. Onde houve conta, ela foi executada (`node`), não lida.

---

## 1. Nota de método

O spec é bom. A camada aritmética (centavos inteiros, `Money`, partida dobrada, saldo derivado, idempotência por índice único) está entre as mais sólidas que já auditei num documento pré-código. Os bloqueios abaixo **não** estão no que o spec decidiu — estão nas **junções** entre decisões corretas tomadas em documentos diferentes, e no que nenhum documento assumiu como seu.

Três padrões produzem quase todos os achados:

1. **`DATE` onde a regra exige instante com fuso.** A regra está escrita em `America/Sao_Paulo`; a coluna é `DATE`, comparada contra `TIMESTAMPTZ`. O deslocamento é de um dia — e um dia, na fronteira de uma fatura, é um mês.
2. **A elegância do "sem `if`" cobra o preço onde não há partição.** No nível de categoria, `Categoria.natureza` particiona receita de despesa e a comparação por sinal funciona. No **nível global** e no **limiar de alerta** não há partição, o `if` volta pela porta dos fundos, e volta invertido.
3. **A exclusão de transferência está escrita em exatamente um lugar** (o SQL de `/lancamentos/resumo`) e é assumida em todos os outros. O erro clássico da categoria não é impedido pelo desenho — é impedido por um `AND` que alguém precisa lembrar de repetir em cinco endpoints.

---

## 2. O resumo do período somado no banco (`sistema.md` §4.4)

A tese do §4.4 é: `SUM(BIGINT)` é aritmética inteira exata, logo somar no banco não viola o ADR 0005. **A tese está certa e eu a homologo.** `SUM` sobre `BIGINT` é exata, associativa e independente de ordem — o item "soma de lista independe da ordem" da bateria fica **satisfeito**, e melhor satisfeito do que estaria em JavaScript.

O problema não é a soma. É **o que entra nela** e **contra o que ela é comparada**.

### 2.1 🔴 BLOQUEIO — a igualdade "soma das páginas = resumo" é falsa por construção

O §4.4 declara o teste de garantia:

> *"para um conjunto gerado de lançamentos, somar todas as páginas da listagem tem de dar exatamente o resumo."*

O SQL do resumo tem `AND transfer_group_id IS NULL`. A listagem **não** tem: a IA §2.2 exibe transferências ("as duas pernas ligadas visualmente e rótulo `transferência`"), o eixo de filtro tem o valor `transferencia`, e L6 exige que a transferência **apareça** na lista sem ser somada. Os dois lados olham conjuntos diferentes. O teste declarado, se escrito literalmente, falha no primeiro período que contiver uma transferência.

**Contraexemplo A — os baldes divergem.** Contas A e B. Único movimento de setembro: transferência de R$ 100,00 de A para B em 10/set.

| | Lista (2 linhas) | Resumo |
|---|---|---|
| Receita realizada | +10000 | **0** |
| Despesa realizada | −10000 | **0** |

Líquido bate (zero); os baldes divergem em R$ 100,00 cada. O rodapé diz "receita realizada R$ 0,00" com uma linha de +R$ 100,00 visível na tela acima dele.

### 2.2 🔴 BLOQUEIO — L5 é aritmeticamente indefensável na presença de transferência

Este é o achado mais grave da seção. O critério de aceite L5 (IA §4.2) afirma:

> `saldo anterior + receita realizada − despesa realizada = saldo`

Transferência muda o saldo de uma conta e **não tem balde no rodapé**. Logo a igualdade é falsa sempre que o recorte contém uma perna e não a outra — que é o caso de uso mais comum do produto: *ver o extrato de uma conta*.

**Contraexemplo B — R$ 300,00 desaparecem do rodapé.** Conta A, saldo em 31/ago = R$ 1.000,00. Em 10/set, transferência de R$ 300,00 de A para B. Filtro: `contas = [A]`, período = setembro.

```
saldo anterior           R$ 1.000,00
receita realizada        R$     0,00
despesa realizada        R$     0,00
saldo (realizado)        R$ 1.000,00      ← o que o rodapé exibe
```

Saldo derivado real da conta A em 30/set = **R$ 700,00**. Divergência de **R$ 300,00**, com a linha de −R$ 300,00 visível na lista logo acima. Sem filtro de conta as pernas se anulam e o erro some — o que é pior, porque o bug fica invisível no teste ingênuo e aparece no uso real.

**Correção exigida:** o resumo precisa de um quinto e sexto balde, `transferencia_liquida_realizada` e `_prevista` (o `SUM` das pernas dentro do recorte, que só é zero quando ambas estão dentro), e L5 vira `saldo_anterior + receita + despesa + transferencia_liquida = saldo`. Sem isso o rodapé mente por desenho.

### 2.3 🔴 BLOQUEIO — o spec nunca declara **qual coluna temporal** recorta o período

`zFiltroLancamentos.periodo` é `{granularidade, de, ate}` e nada diz sobre a coluna. Os índices revelam duas convenções convivendo:

- extrato e paginação: `(tenant_id, posted_at DESC, id DESC)`
- saldo e snapshot: `(tenant_id, conta_id, effective_at) WHERE status = 'efetivado'`

O resumo usa "o mesmo predicado da listagem" (`posted_at`), e o `saldo_anterior` vem de `saldo_snapshots` (`effective_at`). **Somam-se grandezas recortadas por eixos diferentes.**

**Contraexemplo C — R$ 100,00 errados em dois meses seguidos, em direções opostas.** Conta corrente, saldo R$ 1.000,00. Um débito de R$ 100,00 com `posted_at = 31/ago` e `effective_at = 01/set` (compensou no dia seguinte), status `efetivado`.

| | Rodapé de agosto | Rodapé de setembro | Verdade |
|---|---|---|---|
| saldo anterior | 100000 (31/jul) | 100000 (snapshot de 31/ago, por `effective_at`) | — |
| despesa realizada | −10000 (`posted_at` em ago) | 0 | — |
| saldo exibido | **90000** | **100000** | 100000 em 31/ago · **90000** em 30/set |

Agosto erra R$ 100,00 para menos, setembro erra R$ 100,00 para mais, e o saldo do rodapé de agosto contradiz o snapshot de agosto. Não existe escolha ruim aqui — existe a ausência de escolha. **O spec precisa fixar a coluna, e ela precisa ser a mesma que alimenta o `saldo_anterior`.**

### 2.4 🔴 BLOQUEIO — o fuso de `saldo_snapshots.dia` não existe

`saldo_snapshots` tem PK `(tenant_id, conta_id, dia DATE)`. Nenhum documento diz em que fuso `dia` é apurado. `saldo_anterior` é "o dia anterior ao início do período". O predicado da listagem é apurado em `America/Sao_Paulo` (ADR 0008 fixa isso para competência).

**Contraexemplo D — um lançamento some do ano inteiro.** Despesa de R$ 500,00 efetivada em 31/ago às 22h00 em São Paulo = **01/set 01h00 UTC**.

- Se `saldo.materializar` agrupar por `effective_at::date` em UTC, o lançamento entra no snapshot do dia **01/set**. O `saldo_anterior` de setembro (snapshot de 31/ago) **não o contém**.
- O predicado da listagem, em `America/Sao_Paulo`, o coloca em **agosto** — fora do período de setembro.

Resultado: R$ 500,00 que não estão no saldo anterior de setembro nem nas despesas de setembro, e o rodapé de agosto já foi fechado. **O dinheiro some.** Com os fusos trocados (job em local, filtro em UTC), o mesmo lançamento é contado **duas vezes**. O spec permite as duas implementações.

### 2.5 🔴 BLOQUEIO — compra de cartão nasce `efetivado`, e o par realizado × previsto colapsa

Três regras aceitas colidem:

1. `CONTEXT.md`: `status = efetivado ⟺ effective_at != null` (também `CHECK efetivado_tem_data` no banco).
2. ADR 0007, invariante 7: `effective_at` de lançamento de Cartao = `data_vencimento` da sua Fatura. **Sempre.**
3. `CONTEXT.md`: `efetivado` significa *compensado*; só `efetivado` conta no **Realizado**.

De (1)+(2) segue que `effective_at` de todo lançamento de cartão é conhecido no instante da compra, logo **nunca é nulo**, logo **nenhum lançamento de cartão pode ser `previsto` ou `pendente`**. Toda compra de cartão nasce "compensada", com `effective_at` no futuro.

**Contraexemplo E — o realizado de agosto de 2027 fica pronto hoje.** Hoje é 01/set/2026. Cartão fecha dia 25, vence dia 05. Compra de R$ 1.200,00 em 12x em 05/set/2026.

- Parcela 12: `posted_at = 05/ago/2027` → fatura que fecha 25/ago/2027, vence 05/set/2027 → `effective_at = 05/09/2027`, `status = efetivado`.
- O **Realizado** da competência ago/2027 passa a valer −R$ 100,00 **hoje**, 01/set/2026.
- O job `alertas.avaliar` (cron 07:00, avalia faixas de `planejamentos`) pode disparar um alerta de teto de agosto de 2027 nesta semana. Nada aconteceu financeiramente.

Consequências que se propagam: o eixo de filtro `Situação = Previsto` devolve **conjunto vazio** para cartão; o bloco "Futura — rotulada `projeção`" da tela de Fatura (IA §2.5) mostra parcelas que o modelo classifica como realizadas; `projetar(saldoAtual, previstos, ate)` nunca vê uma parcela de cartão. O par realizado × previsto, que o spec chama de "eixo conceitual dos relatórios", não existe no cartão — que é onde passa a maior parte do gasto do usuário brasileiro (IA §1.2).

### 2.6 🟡 RESSALVA — `incluir_no_saldo_geral = false` não é tratado no resumo

O SQL do resumo não filtra conta alguma, e `saldo_anterior` vem de `saldo_snapshots`, que é **por conta** — o spec não diz quais contas são somadas quando o filtro não seleciona nenhuma.

**Contraexemplo F.** Conta corrente R$ 1.000,00 (`incluir = true`) e conta investimento R$ 5.000,00 (`incluir = false`). Sem filtro de conta, o rodapé de Lançamentos exibe `saldo anterior R$ 6.000,00` enquanto a Visão geral exibe `Saldo geral R$ 1.000,00`, no mesmo dia, na mesma sessão. R$ 5.000,00 de diferença entre duas telas, sem rótulo que explique. A escolha oposta (somar só as incluídas) faz o rodapé de Lançamentos ignorar lançamentos que a própria lista exibe. **Ambas as opções precisam ser declaradas e rotuladas na UI; nenhuma está.**

### 2.7 🟡 RESSALVA — o rodapé mistura caixa com dívida

O resumo soma lançamentos de `Conta` e de `Cartao` no mesmo balde, sem separação declarada.

**Contraexemplo G.** Saldo em conta R$ 1.000,00; uma compra no cartão de R$ 200,00 em setembro; fatura vence em outubro. Rodapé de setembro: `saldo anterior 100000 · despesa realizada −20000 · saldo 80000`. Saldo geral na Visão geral no mesmo dia: **R$ 1.000,00** — o dinheiro ainda está na conta. Duas telas, dois números para "quanto eu tenho". O spec não diz qual é "o saldo" nem obriga a rotular a diferença.

---

## 3. As três bases temporais (ADR 0007)

### 3.1 ✅ SATISFAZ — a soma sobre o ciclo de vida completo é a mesma nas três bases

Provado à mão, com o caso canônico. R$ 100,00 em 3x, compra em 05/jul, cartão fecha 25 / vence 05:

| Base | jul | ago | set | out | Σ |
|---|---|---|---|---|---|
| `data_compra` | 10000 | — | — | — | **10000** |
| `data_parcela` | 3334 | 3333 | 3333 | — | **10000** |
| `data_fatura` | — | 3334 | 3333 | 3333 | **10000** |

(Parcela 1, `posted_at` 05/jul, entra na fatura que fecha 25/jul e vence 05/ago → competência **agosto**, pela regra "competência = mês do vencimento".)

As invariantes 8 e 9 do ADR 0007 se sustentam: cada base é uma **permutação da atribuição**, nunca uma alteração do total. Nenhum centavo é criado ou destruído pela troca de base. **Satisfaz.**

### 3.2 🟡 RESSALVA — a invariante só vale em horizonte infinito, e nenhuma tela tem horizonte infinito

A invariante 9 é condicionada a "um horizonte que contenha todas as parcelas". Todo relatório do produto é de um **período**.

**Contraexemplo H — o mesmo ano, três valores, diferença de 100%.** Horizonte = ano-calendário 2026. Compra de R$ 1.200,00 em 12x em 05/dez/2026, cartão fecha 25 / vence 05.

| Base | Total atribuído a 2026 |
|---|---|
| `data_compra` | **R$ 1.200,00** |
| `data_parcela` | **R$ 100,00** |
| `data_fatura` | **R$ 0,00** (parcela 1 vence 05/jan/2027) |

Três exportações do "ano de 2026" com R$ 1.200,00, R$ 100,00 e R$ 0,00. O ADR acerta ao dizer que é redistribuição; o produto precisa **proibir a comparação e a soma entre bases** e carimbar a base em toda saída. O ADR 0007 exige o carimbo (`base_temporal` no payload, impressão no cabeçalho) — **não** exige que dois totais de bases distintas nunca apareçam lado a lado, e a IA §2.7 tem comparação de períodos com base trocável no mesmo cabeçalho. Falta a regra.

### 3.3 ✅ SATISFAZ — compra à vista e dia exato do fechamento

Compra à vista de R$ 200,00 em 26/set, fecha 25 / vence 05: `data_compra` → set, `data_parcela` → set (as duas colapsam por `COALESCE(grupo.data_compra, lancamento.posted_at)`), `data_fatura` → **novembro**. Coerente com o ADR. Janela `(periodo_inicio, periodo_fim]` fechada à direita resolve o dia do fechamento sem ambiguidade: compra em 25/set entra na fatura que fecha em 25/set. **A regra está escrita, o lado está escolhido, e o ADR justifica a escolha contra a regra 10 do `CLAUDE.md`.** É o melhor trecho do spec.

### 3.4 🔴 BLOQUEIO — `faturas.periodo_inicio/periodo_fim` são `DATE`; a janela exige instante

O ADR 0007 é explícito: *"Os limites são calculados em `America/Sao_Paulo` e persistidos como instantes UTC. Uma compra às 22h do dia do fechamento em São Paulo é 01h UTC do dia seguinte: comparar em UTC nu joga a compra na fatura errada."*

O modelo de dados §3.4 grava `periodo_inicio DATE, periodo_fim DATE`. `posted_at` é `TIMESTAMPTZ`. **A tabela não consegue representar a regra do ADR.**

**Contraexemplo I — R$ 500,00 na fatura errada, um mês de deslocamento.** `closing_day = 25`. Compra de R$ 500,00 em **25/set às 23h30** (São Paulo) = 26/set 02h30 UTC.

- O ADR manda: fatura que fecha em 25/set (cenário "Fuso na virada", escrito nominalmente).
- Com `periodo_fim = '2026-09-25'::DATE`, a comparação `posted_at <= periodo_fim` coage a data para 25/set **00h00** em algum fuso. Em UTC, isso exclui não só as 23h30 locais, mas qualquer compra a partir das **21h00 do dia 24**.

A compra vai para a fatura seguinte. O total da fatura que fecha erra em R$ 500,00 e o usuário paga um mês depois do que devia.

**Contraexemplo J — a compra não pertence a nenhuma fatura.** Ainda com `DATE`, o CONTEXT exige que `periodo_inicio` seja "o instante seguinte ao `periodo_fim` da anterior". Em `DATE`, o sucessor de `2026-09-25` é `2026-09-26`. Janelas: `(26/ago, 25/set]` e `(26/set, 25/out]`. Uma compra em **26/set** não está em nenhuma das duas — a segunda é **aberta** à esquerda. Isso viola o `CHECK cartao_tem_fatura` (o `INSERT` falha) e a invariante 5 do ADR 0007 ("nenhum instante cai em nenhuma"). Se a implementação compensar usando `>=` à esquerda, o dia 25/set cai em **duas** faturas e a mesma compra é cobrada duas vezes.

`periodo_inicio` e `periodo_fim` precisam ser `TIMESTAMPTZ`. Esta é uma correção de migration barata agora e impossível depois.

### 3.5 🔴 BLOQUEIO — `effective_at TIMESTAMPTZ = data_vencimento DATE`, sem fuso declarado

Mesma família, consequência própria. `effective_at` de cartão é "igual a `Fatura.data_vencimento`", que é `DATE`. A coerção depende do `TimeZone` da sessão que escreve.

**Contraexemplo K — o desembolso muda de mês.** `due_day = 1`, fatura vence 01/nov. Se o worker rodar com `TimeZone = UTC`, `effective_at = 2026-11-01 00:00 UTC` = **31/out 21h00 em São Paulo**. Qualquer leitura de caixa por `effective_at` põe o desembolso em **outubro**, e a competência apurada em `America/Sao_Paulo` (como o CONTEXT exige) devolve **outubro** para uma fatura de **novembro**. O `saldo_snapshots` do dia 31/out incorpora a fatura inteira um dia antes.

### 3.6 🔴 BLOQUEIO — retroativo quebra a composição da fatura e contradiz o glossário

Duas afirmações aceitas se contradizem frontalmente:

- `CONTEXT.md`, **Fatura**: *"Agrega os Lancamentos do Cartao cuja janela contém seu `posted_at`."*
- ADR 0007, **Lançamento retroativo**: *"Ele preserva seu `posted_at` original e é anexado à **fatura aberta mais antiga**."*

Um lançamento retroativo pertence a uma fatura cuja janela **não** contém seu `posted_at`. A invariante 5 do ADR 0007 ("nenhum instante cai em duas faturas") deixa de descrever o sistema.

**Contraexemplo L — R$ 500,00 a menos na composição, num critério de aceite "ao centavo".** Compra de R$ 500,00 em 10/ago, lançada em 20/out; faturas de agosto e setembro já pagas; anexa à fatura de novembro. O critério C5 (IA §4.3) exige:

> `compras do ciclo + parcelas anteriores − estornos = valor da fatura`

| Bloco Composição (fatura de novembro) | |
|---|---|
| compras deste ciclo | R$ 1.000,00 |
| parcelas de compras anteriores | R$ 200,00 |
| estornos | R$ 0,00 |
| **soma da composição** | **R$ 1.200,00** |
| **valor da fatura** | **R$ 1.700,00** |

Faltam **R$ 500,00** e falta o balde. E a mesma compra é atribuída a agosto sob `data_compra` e `data_parcela`, e a novembro sob `data_fatura` — três meses de dispersão para um único fato, sem que a régua do ciclo tenha como explicar.

### 3.7 🔴 BLOQUEIO — a perna de crédito do pagamento zera o total da fatura

Este é o **erro clássico da categoria em sua forma espelhada**, e o desenho o produz.

O pagamento é uma `Transferencia` conta → cartão. Por partida dobrada, a perna de crédito tem `cartao_id` preenchido. O `CHECK cartao_tem_fatura` então **obriga** essa perna a ter `fatura_id`. E `faturas.total_centavos` é declarado em §3.7 como *"materializado, recalculado a cada leitura ou por job"* — a partir dos lançamentos da fatura, sem nenhuma exclusão escrita.

**Contraexemplo M — a fatura de R$ 1.000,00 vira R$ 0,00 no instante do pagamento.**

1. Fatura de outubro, uma compra de R$ 1.000,00. `total_centavos` = 100000.
2. Pagamento integral: perna −100000 na conta, perna **+100000 no cartão, com `fatura_id` da fatura de outubro**.
3. Recálculo do total: `SUM` dos lançamentos daquela `fatura_id` = 100000 − 100000 = **0**.

A tela exibe "valor da fatura R$ 0,00 · paga". `pago_centavos` conta os mesmos R$ 1.000,00 de novo. E se a fatura estiver **fechada**, o `INSERT` da perna altera um valor que §3.7 declara "fato congelado, imutável" — contradição direta com a política de reabertura (ADR proposta 0013).

Três correções possíveis (nenhuma escrita hoje): a perna de crédito não recebe `fatura_id` e o `CHECK` é relaxado para pernas de transferência; ou `total_centavos` exclui `transfer_group_id IS NOT NULL`; ou o pagamento aponta para a fatura por `transferencias.fatura_id` (coluna que já existe!) e **nunca** por `lancamentos.fatura_id`. A terceira é a certa e o modelo já tem o campo — falta a regra dizendo que é ele, e só ele.

### 3.8 🔴 BLOQUEIO — `Estorno` não existe no modelo

`CONTEXT.md` não tem a entrada **Estorno**. Não há `estorno_de_lancamento_id`, `estorno_de_grupo_id`, nem tipo. Minha bateria exige *"estorno é lançamento novo, não edição destrutiva"* e *"estorno de parcela ajusta o grupo, não deixa parcela órfã"* — nada disso pode ser verificado contra o desenho, porque o desenho não fala do assunto. Mas o produto **já depende** dele: C5 exige um balde "estornos" e a IA §2.5 exige "estornos com sinal e rótulo próprios".

**Contraexemplo N — R$ 300,00 de gasto que nunca existiu, permanentes no relatório.** Compra parcelada de R$ 300,00 em 3x em 05/jul (100/100/100). Em 20/ago a loja estorna a compra inteira: crédito de R$ 300,00 no cartão em 20/ago.

Sob base `data_compra`: a compra tem `grupo.data_compra = 05/jul` → **julho: R$ 300,00 de despesa**. O estorno é à vista, sem grupo → `COALESCE(NULL, posted_at)` = 20/ago → **agosto: −R$ 300,00**. Sob nenhuma das três bases o estorno anula a compra na competência em que a compra foi atribuída. O relatório de julho registra para sempre R$ 300,00 gastos numa compra que foi desfeita.

**Contraexemplo O — o estorno parcial é irrepresentável.** Mesma compra, estorno de R$ 100,00 após a parcela 1. As parcelas futuras deveriam encolher.

- Reduzir a parcela 3 a zero viola `CHECK (valor_centavos <> 0)` e a invariante `valor ≠ 0`.
- Não reduzir nada faz o usuário pagar 3 parcelas e receber um crédito solto, e viola nada — mas o grupo passa a mentir sobre o que a compra custou.
- Reduzir e manter `Σ filhos = valor_total` é impossível: `valor_total` é o valor da compra, não o valor após o estorno.

A invariante "Σ dos N filhos = `valor_total`, exatamente" é **incompatível** com qualquer ajuste posterior do grupo. Ou o estorno cria um grupo de crédito próprio, ou `valor_total` precisa ser declarado imutável e o estorno declarado externo ao grupo — e então C5 precisa do seu quarto balde. Nenhuma das duas está escrita.

### 3.9 🟡 RESSALVA — pagamento a maior não tem destino

A IA §2.5 aceita "pagamento parcial e pagamento a maior". `parcialmente_paga` está definida; o excedente não.

**Contraexemplo P.** Fatura de R$ 1.000,00, o usuário paga R$ 1.200,00. `pago_centavos = 120000`, `total_centavos = 100000`. Estado? A tela C3 exibe "restam R$ X" — aqui, "restam −R$ 200,00". E os R$ 200,00 não viram crédito na fatura seguinte, porque nada os transporta. Dinheiro real do usuário, sem lugar no modelo.

---

## 4. Planejamento com sinal em vez de enum (ADR 0008)

### 4.1 ✅ SATISFAZ — `dentro_do_plano ⟺ realizado >= valor`, conferido nos dois sentidos

Percorrido com números, incluindo os zeros e a fronteira:

| Caso | `valor` | `realizado` | `realizado >= valor` | Leitura | Correto? |
|---|---|---|---|---|---|
| Teto R$ 500, gastei R$ 300 | −50000 | −30000 | verdadeiro | dentro | ✅ |
| Teto R$ 500, gastei R$ 600 | −50000 | −60000 | falso | estourou | ✅ |
| Teto R$ 500, gastei R$ 500 | −50000 | −50000 | **verdadeiro** | dentro | ✅ (ver 4.2) |
| Teto R$ 500, nada gasto | −50000 | 0 | verdadeiro | dentro | ✅ |
| Piso R$ 3.000, recebi R$ 3.500 | 300000 | 350000 | verdadeiro | batido | ✅ |
| Piso R$ 3.000, recebi R$ 2.000 | 300000 | 200000 | falso | abaixo | ✅ |
| Piso R$ 3.000, nada recebido | 300000 | 0 | falso | abaixo | ✅ |

Uma comparação, sem ramificar por natureza, correta em todos os oito quadrantes. **A decisão central do ADR 0008 se sustenta.** `valor ≠ 0` está protegido por invariante, então a divisão de `consumo` nunca divide por zero.

### 4.2 🟡 RESSALVA — gastar exatamente o teto é "dentro do plano" **e** dispara o alerta de 100%

Com `realizado = valor = −50000`: `dentro_do_plano = true` e `consumo = 100%`, que cruza o limiar padrão `[80, 100]`. A tela mostra verde e o sino mostra alerta, no mesmo instante, para o mesmo objeto. Não é erro de centavo; é rótulo contraditório que o suporte vai receber. Precisa de uma linha decidindo qual vence.

### 4.3 🔴 BLOQUEIO — `consumo` é uma divisão sem tipo, sem regra de arredondamento e com o sinal invertendo a comparação

`consumo = realizado / valor` é a **única** grandeza fracionária do domínio, e o módulo `money` não exporta divisão (a interface pública lista `ratear`, `comparar`, `ehZero` — nenhuma razão). A regra 3 do `CLAUDE.md` é categórica: *"Nenhum arredondamento implícito. Onde há arredondamento, a regra está declarada e testada."* Aqui não há nem tipo declarado.

O ADR se orgulha de eliminar o `if` sobre natureza. **No limiar de alerta o `if` volta, invertido, e é fácil de errar.** Como `valor` é negativo em teto, multiplicar os dois lados da desigualdade por `valor` **inverte o sentido**:

| Expressão | Teto (`valor < 0`) | Piso (`valor > 0`) |
|---|---|---|
| `realizado * 100 >= pct * valor` | **ERRADA** | correta |
| `realizado * 100 <= pct * valor` | correta | **ERRADA** |

**Contraexemplo Q — alerta de 80% disparando a 60% de consumo.** Teto de R$ 500,00 (`valor = −50000`), gastei R$ 300,00 (`realizado = −30000`, consumo real 60%). Com a forma inteira ingênua, idêntica à que funciona para piso:

```
realizado * 100 >= pct * valor
 -30000 * 100  >=  80 * (-50000)
     -3.000.000 >= -4.000.000      →  VERDADEIRO  →  alerta de 80% disparado
```

O usuário recebe "você atingiu 80% do teto de Alimentação" tendo gasto 60%. E o `chave_dedup` inclui a faixa, então a notificação é permanente. Verificado por execução — os quatro casos, incluindo a fronteira:

```
teto -50000, realizado -30000: ingenua=true  correta=false  consumo=60.00%
teto -50000, realizado -40000: ingenua=true  correta=true   consumo=80.00%
teto -50000, realizado -50000: ingenua=false correta=true   consumo=100.00%
```

Note a terceira linha: a forma ingênua **para** de alertar exatamente quando o teto é atingido.

**Contraexemplo R — um centavo decide o alerta.** Teto R$ 500,00, realizado −R$ 399,99. Consumo verdadeiro = 79,998%. Formatado a duas casas, exibe **80,00%**. Se o disparo for feito sobre o número já formatado, o alerta de 80% dispara um centavo antes do limiar; se for sobre o valor cru, não dispara e a tela exibe 80,00% sem alerta. **Um centavo, dois comportamentos, nenhuma regra escrita.** O disparo tem de ser em aritmética inteira, com o sentido da comparação escolhido pelo sinal de `valor`, e a exibição tem de truncar — não arredondar — para não anunciar um limiar que não foi cruzado.

### 4.4 🔴 BLOQUEIO — o `consumo` "sempre positivo" é falso, e o `CONTEXT.md` afirma o contrário do ADR

- ADR 0008, invariante 2: *"`consumo = realizado / valor > 0` **sempre que** `realizado` e `valor` têm o mesmo sinal."* Correto e condicionado.
- `CONTEXT.md`, **Planejamento**: *"`consumo = realizado / valor`, **positivo em ambos os casos**."* Incondicional e **falso**.

**Contraexemplo S — barra de progresso em −16%.** Teto de R$ 500,00 em Alimentação (`valor = −50000`). No mês, o único lançamento da categoria é um **estorno** de R$ 80,00 (o mercado devolveu uma compra do mês anterior): `realizado = +8000`.

```
consumo = 8000 / (-50000) = -0,16  →  -16%
```

`dentro_do_plano`: `8000 >= -50000` → verdadeiro, correto. Mas a barra recebe −16%, o `chave_dedup` do alerta receberia uma faixa negativa, e o glossário — que é normativo — garantia que isso não podia acontecer. Um dos dois documentos precisa ceder, e é o `CONTEXT.md`.

### 4.5 ✅ SATISFAZ — precedência global → raiz → subcategoria, com o caso pedido

Montado com 1 global + 3 raízes + 2 subcategorias, competência set/2026, moeda BRL:

| Escopo | Nível | `valor` |
|---|---|---|
| — (global) | global | −300000 |
| Casa | raiz | −150000 |
| Alimentação | raiz | −80000 |
| Transporte | raiz | −40000 |
| Luz (filha de Casa) | sub | −20000 |
| Restaurante (filha de Alimentação) | sub | −30000 |

Realizado: Aluguel −120000 · Luz −18000 · Alimentação (raiz) −40000 · Restaurante −25000 · Transporte −35000. **Despesa total = −238000.**

**Total planejado.** Regra: *"em cada caminho, apenas o Planejamento de nível mais alto que existir"*. Todos os cinco caminhos passam pelo global → **total planejado = R$ 3.000,00**. Não R$ 4.300,00 (soma ingênua), não R$ 2.700,00 (raízes), não R$ 500,00 (subs). Confere com a invariante 13 do ADR 0008. **Nada é contado duas vezes.**

**Realizado por escopo** — o mesmo lançamento conta em todos os níveis do seu caminho, que é o desenho declarado e é o que o usuário quer:

| Escopo | Realizado | Teto | Dentro? | Consumo |
|---|---|---|---|---|
| global | −238000 | −300000 | ✅ | 79,3% |
| Casa | −138000 | −150000 | ✅ | 92,0% |
| Alimentação | −65000 | −80000 | ✅ | 81,3% |
| Transporte | −35000 | −40000 | ✅ | 87,5% |
| Luz | −18000 | −20000 | ✅ | 90,0% |
| Restaurante | −25000 | −30000 | ✅ | 83,3% |

Soma dos realizados das raízes (−138000 − 65000 − 35000 = −238000) = despesa total ✅. Soma das subs não excede a raiz ✅. **Nada deixa de ser contado, nada é contado duas vezes no agregado. A regra de precedência funciona.**

*Nota operacional (não é bloqueio):* quatro alertas de 80% no mesmo dia, para R$ 2.380,00 gastos, cada um com `chave_dedup` própria. É ruído, não erro — mas o `alertas.avaliar` deveria suprimir o filho quando o pai já alertou no mesmo ciclo.

### 4.6 🔴 BLOQUEIO — o teto **global** nunca estoura para quem tem superávit

No nível de categoria, `Categoria.natureza` particiona receita de despesa e a soma por sinal funciona. No nível global **não há categoria contra a qual conferir** — o próprio ADR reconhece isso ("lá o sinal *define* o escopo em vez de ser conferido por ele") — mas não diz **como o realizado global é apurado**. "Negativo cobre toda a despesa do mês" exige separar despesa de receita, ou seja, exige o `if` que o ADR aboliu.

**Contraexemplo T — gastei R$ 10.000 sob um teto de R$ 3.000 e estou "dentro do plano".** Teto global `valor = −300000`. No mês: despesas −1.000.000 e salário +2.000.000.

Se o realizado global for a soma líquida (a leitura "sem `if`", que é a única compatível com a redação do ADR):

```
realizado = -1.000.000 + 2.000.000 = +1.000.000
dentro_do_plano:  1.000.000 >= -300.000  →  VERDADEIRO
consumo = 1.000.000 / -300.000 = -333%
```

**O teto global é impossível de estourar para qualquer usuário que receba mais do que gasta** — que é a maioria dos usuários que define um teto.

**Contraexemplo U — o critério oposto também mente.** Se o realizado global for "soma dos lançamentos com `valor < 0`": teto global de R$ 3.000,00; o usuário gastou R$ 2.500,00 e teve um **estorno de salário** de R$ 800,00 (a empresa cobrou de volta), que é um lançamento negativo numa categoria de **receita**. Realizado = −330000 → **teto estourado**, com R$ 2.500,00 de gasto real.

**Contraexemplo V — o terceiro critério perde dinheiro.** Se for "soma dos lançamentos cuja `Categoria.natureza = despesa`": `categoria_id` é **nullable** em `lancamentos` (só a transferência é obrigada a não ter categoria). R$ 5.000,00 de despesas sem categoria **não consomem o teto global** e não aparecem em nenhum planejamento.

Três critérios plausíveis, três números diferentes, nenhum escrito. E ver 4.9: a categoria "Ajuste de saldo" cai exatamente nesse buraco.

### 4.7 🔴 BLOQUEIO — `copiar` com global quebra a idempotência por causa de `NULL`

O ADR reconhece que `NULL` não colide em índice único no Postgres e prescreve dois índices parciais. **Não aplica o mesmo raciocínio à cópia.** A regra é "só cria onde a categoria **não tem** Planejamento no destino"; para o global, a categoria é `NULL`.

**Contraexemplo W — a segunda cópia aborta a transação inteira.** Origem: set/2026 com 1 global (−300000) e 5 tetos de categoria. Destino: out/2026, vazio.

1. `copiar(set, out)` → cria 6 registros. ✅
2. `copiar(set, out)` de novo. Se a verificação de existência for escrita como `WHERE categoria_id = origem.categoria_id`, em SQL `NULL = NULL` avalia para `NULL`, nunca para `TRUE`. O global existente **não é encontrado**, o `INSERT` do segundo global é tentado, e o índice único parcial `WHERE categoria_id IS NULL AND valor < 0` o rejeita.
3. A transação aborta. **As 5 categorias também não são copiadas** — e a invariante 10 ("`copiar(a,b); copiar(a,b)` = `copiar(a,b)`") falha, com o usuário vendo um erro de banco.

A verificação precisa ser `categoria_id IS NOT DISTINCT FROM origem.categoria_id`, **e** discriminar pelo sinal — porque um mês pode ter um teto global e um piso global.

### 4.8 🔴 BLOQUEIO — "total planejado" soma teto e piso globais num número sem significado

A invariante 6b permite um teto global (negativo) **e** um piso global (positivo) na mesma competência. A regra de precedência fala em "caminho da hierarquia", e teto e piso são caminhos disjuntos (despesa × receita) — mas a tela §2.6 bloco 2 exibe um único `planejado R$ X`.

**Contraexemplo X.** Teto global R$ 3.000,00 (−300000) e piso global R$ 5.000,00 (+500000). Somados: **+R$ 2.000,00**. Esse número não significa nada, e é o que a tela exibiria se ninguém escrever que o total planejado é apurado **por natureza, separadamente**. A regra de precedência precisa ser enunciada duas vezes: uma para o caminho de despesa, outra para o de receita.

### 4.9 🟡 RESSALVA — `planejado · gasto · resta` com categorias sem planejamento

A tela §2.6 exibe `planejado R$ X · gasto R$ Y · resta R$ Z`. O spec não diz se `gasto` é **toda** a despesa do mês ou **só** a das categorias planejadas.

**Contraexemplo Y.** Cenário de 4.5, mais uma despesa de R$ 500,00 em "Saúde", que não tem planejamento. **Sem** global: `planejado = R$ 2.700,00`.

- Se `gasto` = toda a despesa (R$ 2.880,00): `resta = −R$ 180,00`. A tela mostra saldo negativo com **todos os seis tetos individuais verdes**.
- Se `gasto` = só as planejadas (R$ 2.380,00): `resta = R$ 320,00`, e R$ 500,00 de gasto real **somem do resumo do Planejamento**.

Ambas as leituras são defensáveis; a ausência da escolha não é.

### 4.10 ✅ SATISFAZ — transferência e pagamento de fatura fora do realizado do Planejamento

ADR 0008 invariante 8 e o cenário de borda "Pagamento de fatura → realizado inalterado" são explícitos e corretos. É o único lugar do spec inteiro onde a exclusão está escrita como invariante, e não como um `AND` numa query. **Modelo para o resto.**

### 4.11 ✅ SATISFAZ — base `data_parcela` travada no Planejamento

A decisão de blindar o realizado do Planejamento contra a preferência de relatório (invariante 9) é correta e a justificativa está certa: um teto cujo realizado muda com um seletor de relatório faria alertas dispararem sem que nada financeiro tivesse acontecido. **Mas ver 2.5:** com toda parcela nascendo `efetivado`, o realizado dos meses futuros já vem preenchido, e o alerta dispara meses antes do fato.

---

## 5. Objetivo de acúmulo (ADR 0009)

### 5.1 ✅ SATISFAZ — congelar `saldo_base` contra lançamento retroativo **posterior**

A decisão de armazenar em vez de derivar está certa e a justificativa é boa: um `saldo_base` derivado mudaria o progresso sozinho quando o passado fosse editado. `progresso = saldo(conta) − saldo_base` com `saldo_base` fixo é estável contra qualquer reescrita do passado **anterior à criação**... exceto que é exatamente aí que ele falha. Ver 5.2.

### 5.2 🟡 RESSALVA — o congelamento protege contra o retroativo errado

O ADR lista como cenário resolvido: *"Conta associada com lançamento retroativo. Saldo do passado muda, `saldo_base` não. O progresso muda apenas pelo saldo atual — que é o comportamento correto, porque o dinheiro está lá."* A justificativa e a fórmula divergem quando o retroativo é **anterior** à criação do Objetivo.

**Contraexemplo Z — 30% de progresso sem ter guardado um centavo.** 01/set: poupança com saldo **registrado** de R$ 2.000,00. Cria Objetivo "Viagem", alvo R$ 10.000,00, `saldo_base = 200000`. Progresso = R$ 0,00.

10/set: o usuário importa o OFX de agosto. Aparece um depósito de **R$ 3.000,00 feito em 15/ago** — antes da criação do Objetivo. Saldo atual = R$ 5.000,00.

```
progresso = 500000 - 200000 = 300000  →  R$ 3.000,00  →  30%
```

Ele não guardou nada desde 01/set. O dinheiro **já estava lá** quando o marco foi capturado; só não estava registrado. O `saldo_base` congela um saldo *conhecido*, não um saldo *real* — e o ADR 0009 é o documento que mais insiste em que "o passado, neste sistema, é editável".

**Contraexemplo AA — o mesmo, por estorno.** A importação traz o estorno de uma despesa de julho de R$ 500,00 na mesma conta. Saldo sobe R$ 500,00, progresso sobe R$ 500,00, sem aporte. Se o alvo fosse R$ 3.000,00, `concluido_em` seria gravado — **permanentemente, pela invariante 8** — por um depósito de agosto.

Não é bug de centavo; é o significado de "progresso" divergindo da sua fórmula. Precisa de uma linha no ADR: ou `saldo_base` é reajustado por lançamentos com `effective_at < criado_em` do Objetivo (e então não é congelado), ou o ADR declara que o progresso é "variação do saldo conhecido", que é o que a fórmula de fato mede.

### 5.3 🔴 BLOQUEIO — nada detecta a primeira travessia de `concluido_em`

A invariante 8 exige que `concluido_em` seja gravado *"na **primeira** vez que `progresso >= valor_alvo`"*. `progresso` é derivado de um saldo derivado, e **nenhum job da §5.2 avalia objetivos** — `alertas.avaliar` lista faixas de `planejamentos`, contas a pagar, fatura fechando/vencendo e saldo projetado negativo. Objetivos não estão lá. Não há gatilho de outbox para `objetivo.*`.

**Contraexemplo AB — a conclusão nunca acontece.** Objetivo de R$ 10.000,00. Em 10/set um depósito leva o saldo ao alvo exato. Em 15/out o usuário resgata R$ 3.000,00. Em 20/out ele abre a tela de Objetivos pela primeira vez desde setembro.

Progresso na leitura = R$ 7.000,00 < R$ 10.000,00 → `concluido_em` **não é gravado, nunca**. A invariante "gravado na primeira travessia" é violada em silêncio, e a regra que o próprio ADR chama de "a única que precisa ser lida duas vezes" (resgate não desfaz a conclusão) nunca chega a ser exercida. Sem job, "primeira travessia" significa "primeira leitura", que é outra coisa.

### 5.4 ✅ SATISFAZ — moeda na construção; 🔴 BLOQUEIO — moeda no Saldo geral

A invariante 2 do ADR 0009 (ancorado: `valor_alvo.moeda = conta.moeda`; por aportes: moeda base do Tenant; *"sem conversão silenciosa, nunca"*) é correta e suficiente **para o Objetivo**. O bloqueio é a montante, no `CONTEXT.md`:

> **Saldo geral** — *"Contas de moedas diferentes só entram no Saldo geral após conversão explícita e datada."*

**Não existe, em todo o spec, nenhuma tabela, coluna, endpoint ou job de taxa de câmbio.** `contas.moeda` é livre; `POST /contas` aceita a moeda; `GET /contas/saldos` promete `saldo_geral`.

**Contraexemplo AC — o número principal do produto é indefinido.** Conta BRL com R$ 1.000,00 e conta USD com $ 100,00, ambas `incluir_no_saldo_geral = true`. `GET /contas/saldos` deve devolver `saldo_geral`. As opções são:

- somar os centavos: `100000 + 10000 = 110000` → "R$ 1.100,00", com erro de aproximadamente R$ 400,00 e violação da regra 2 do `CLAUDE.md`;
- lançar erro: **a tela principal do produto quebra** e não há como consertá-la pela UI;
- converter: com qual taxa, de qual fonte, de qual data?

A IA §2.2 declara "não tem múltiplas moedas por espaço no MVP", mas isso é uma decisão de **tela** — nada no modelo de dados impede criar a segunda conta. Ou entra um `CHECK`/regra "toda `Conta` de um Tenant tem a moeda base do Tenant" no MVP, ou entra uma entidade de câmbio. Hoje o spec permite criar o estado e não define o resultado.

### 5.5 ✅ SATISFAZ — dupla contagem entre modos, e conta fora do saldo geral

"Ancorado não aceita Aporte" (invariante 6) fecha a dupla contagem **dentro** de um objetivo, com a justificativa certa. Dois objetivos ancorados na mesma conta são permitidos e o produto **não os soma** — declarado explicitamente, e é a decisão certa. Objetivo ancorado numa conta com `incluir_no_saldo_geral = false` funciona normalmente: as duas noções são ortogonais, e o ADR diz isso com todas as letras. **Objetivo nunca cria `Lancamento`** (invariante 13, como teste de arquitetura) mantém o Objetivo fora do caminho crítico do dinheiro — é a melhor decisão do ADR 0009.

---

## 6. Pagamento de fatura: o desenho impede que ele vire despesa?

Este era o item de prova obrigatória. **A prova falha.** O desenho impede a dupla contagem em dois lugares e não a impede em seis.

| Superfície | Exclusão de transferência | Situação |
|---|---|---|
| `GET /lancamentos/resumo` | `AND transfer_group_id IS NULL`, escrito no SQL (§4.4) | ✅ **Impedido** |
| `Planejamento` (realizado) | ADR 0008 invariante 8 + cenário de borda nominal | ✅ **Impedido** |
| `GET /relatorios/categorias` | **nada escrito** | 🔴 |
| `GET /relatorios/entradas-saidas` | **nada escrito** | 🔴 |
| `GET /relatorios/contas` | **nada escrito** | 🔴 |
| `GET /relatorios/etiquetas` | **nada escrito** | 🔴 |
| `GET /relatorios/evolucao` | **nada escrito** | 🔴 |
| `faturas.total_centavos` | **nada escrito** | 🔴 (ver 3.7) |

### 6.1 🔴 BLOQUEIO — C2 não é garantido pelo desenho

O critério C2 (IA §4.3) é o teste que o produto declara existencial: *"o relatório de Categorias do mês do pagamento **não** aumenta em R$ 1.000,00. Este é o erro clássico da categoria e tem teste E2E dedicado."* Mas o único mecanismo que o produziria é um `AND` numa query que ninguém escreveu.

**Contraexemplo AD — gasto dobrado na aba Categorias.** Mês com uma compra de cartão de R$ 1.000,00 (categoria Mercado) e o pagamento integral da fatura.

A perna de débito do pagamento está numa conta, com `categoria_id NULL` (obrigatório por `CHECK transferencia_sem_categoria`). Todo relatório por categoria precisa decidir o que fazer com lançamentos sem categoria, e a resposta usual é um balde "Sem categoria":

```
Despesas — outubro
  Mercado             R$ 1.000,00
  Sem categoria       R$ 1.000,00     ← o pagamento da fatura
  Total               R$ 2.000,00     ← o gasto do mês dobrou
```

O `CHECK transferencia_sem_categoria` é a **única** defesa estrutural — e ele empurra o problema para o balde "Sem categoria" em vez de resolvê-lo. Pior: ele não distingue "transferência" de "o usuário não categorizou", que são coisas opostas para um relatório.

**Correção exigida:** a exclusão `transfer_group_id IS NOT NULL` tem de sair do SQL de um endpoint e virar parte do **tradutor único** `filtro.ts`, aplicada por construção a toda agregação de gasto; e o `zFiltroLancamentos` precisa distinguir *incluir transferências como linhas* (listagem) de *incluí-las nos totais* (nunca). Enquanto for um `AND` que se copia, o erro clássico da categoria entra na primeira query que alguém escrever com pressa. O risco nº 1 da IA §6 diz: *"Se um spec chegar perto disso, o épico para."* Chegou.

### 6.2 🟡 RESSALVA — "Ajuste de saldo" tem o mesmo problema, sem nenhuma defesa

O veto 3 da IA está certo: ajustar saldo cria um `Lancamento` visível, nunca escreve o saldo. Mas esse lançamento tem a categoria "Ajuste de saldo", que é de **despesa ou de receita**, e nada o exclui de nenhum total.

**Contraexemplo AE.** O usuário ajusta o saldo em −R$ 300,00 (tinha menos do que achava). Isso vira R$ 300,00 de **despesa** no relatório de categorias, consome R$ 300,00 do teto global e entra em "despesa realizada" no rodapé. É um gasto que nunca aconteceu; é uma correção de registro. Ou a categoria é declarada de sistema e excluída dos totais como a transferência, ou o produto declara que ajuste **é** despesa. Nenhuma das duas está escrita.

---

## 7. Parcelamento com resto — conferido à mão e por execução

### 7.1 🔴 BLOQUEIO — duas regras de rateio incompatíveis no corpo de documentos aceitos

| Fonte | Redação | Regra |
|---|---|---|
| `CLAUDE.md` regra 11 | *"O resto da divisão vai **na primeira parcela**"* | **B** — tudo na primeira |
| `CONTEXT.md`, **GrupoDeParcelamento** | *"O resto do rateio vai **na primeira** parcela"* | **B** |
| IA §2.3, texto normativo da tela | *"Em divisão não exata, a sobra vai **na primeira parcela**"* | **B** |
| `CONTEXT.md`, **Rateio (allocate)** | *"O resto em centavos é distribuído **nas primeiras partes**"* | **A** — uma unidade por parte |
| ADR 0005 | *"com o resto indo **nas primeiras partes**"* | **A** |
| ADR 0007, cenário `R$ 0,02 em 3x → (1, 1, 0)` | duas partes recebem 1 centavo | **A** |

As duas regras coincidem sempre que o resto é 1 — que é o caso de **R$ 100,00 em 3x**, o exemplo usado em todo lugar. É por isso que a contradição nunca apareceu.

**Contraexemplo AF — R$ 0,03 de diferença na primeira parcela.** R$ 100,00 em **7x**. `10000 = 7 × 1428 + 4`:

| Regra | Parcelas (centavos) | Σ | Parcela 1 |
|---|---|---|---|
| **A** (nas primeiras partes) | 1429, 1429, 1429, 1429, 1428, 1428, 1428 | 10000 ✅ | **R$ 14,29** |
| **B** (tudo na primeira) | **1432**, 1428, 1428, 1428, 1428, 1428, 1428 | 10000 ✅ | **R$ 14,32** |

Ambas somam exatamente R$ 100,00 — **nenhum property test de soma detecta a diferença**, que é o único teste que o spec exige (`CLAUDE.md` §7, ADR 0007 invariante 2). As parcelas 1 a 4 divergem, e a fatura de cada um desses quatro meses fecha com valor diferente conforme a regra escolhida. R$ 100,00 em 6x diverge igual: `1667…` (A) contra `1670, 1666…` (B).

**Contraexemplo AG — o ADR 0007 se contradiz internamente.** O próprio ADR lista `R$ 0,02 em 3x → (1, 1, 0)`, que é a regra **A**, no mesmo documento em que escreve "o resto vai na primeira parcela", que é a regra **B** e produziria `(2, 0, 0)`. Confirmado por execução:

```
2c em 3x | A=1,1,0 | B=2,0,0 | divergem=true
```

Uma regra, escrita uma vez. Recomendo **A** (é a de `money.ratear`, é property-friendly e minimiza a dispersão entre parcelas), e a correção do texto da tela — que hoje promete B ao usuário.

### 7.2 🔴 BLOQUEIO — `R$ 0,01 em 3x` viola o `CHECK` do banco

O ADR 0007 lista como cenário que a suíte precisa cobrir: `R$ 0,01 em 3x → (1, 0, 0)`. O modelo de dados §3.3 tem:

```sql
CONSTRAINT valor_nao_zero CHECK (valor_centavos <> 0)
```

e o `CONTEXT.md` tem a invariante `valor ≠ 0` no `Lancamento`. **As parcelas 2 e 3 são zero. O `INSERT` falha.** O mesmo vale para `R$ 0,02 em 3x → (1, 1, 0)`: a parcela 3 é zero.

O ADR especifica um comportamento que o esquema proíbe. As saídas: gerar apenas `min(n, |centavos|)` parcelas (R$ 0,01 em 3x vira 1 parcela, e `installment_total` deixa de ser o que o usuário pediu); rejeitar o parcelamento na borda com `valor_total_centavos < n`; ou relaxar o `CHECK` para parcelas — o que abre a porta para lançamentos de valor zero em todo o resto do sistema. **Precisa ser decidido antes do código, porque muda uma constraint de tabela.**

### 7.3 🔴 BLOQUEIO — o sinal de `parcelamentos.valor_total_centavos` não existe

`parcelamentos.valor_total_centavos BIGINT` — o spec não diz se é positivo ou carrega o sinal do domínio. Todo parcelamento de despesa gera parcelas **negativas** (regra 6 do `CLAUDE.md`).

**Contraexemplo AH — a invariante mais citada do spec é falsa por sinal.** Compra parcelada de R$ 100,00 em 3x. Se `valor_total_centavos = 10000` (positivo, "o valor da compra") e os filhos são `−3334, −3333, −3333`:

```
Σ filhos = -10000  ≠  valor_total = +10000
```

A invariante 2 do ADR 0007 — *"Soma dos `valor` das N parcelas = `GrupoDeParcelamento.valor_total`, **exatamente**, para qualquer total e qualquer N"*, declarada property-based e obrigatória — falha literalmente. E o `ratear` de um valor negativo não tem comportamento declarado: "o resto nas primeiras partes" para `−10000 / 3` pode produzir `−3334, −3333, −3333` (magnitude) ou `−3332, −3333, −3335` (truncamento para zero mal tratado), e as duas somam −10000. Um property test de soma não distingue; a fatura do mês 1 difere em R$ 0,02.

### 7.4 🟡 RESSALVA — o explicador da tela promete um valor que nenhuma parcela tem

F5 (IA §4.1) exige que o explicador exiba `3 parcelas de R$ 33,33` para R$ 100,00 em 3x, e o mesmo F5 exige que as parcelas sejam `33,34 / 33,33 / 33,33`. `3 × 33,33 = R$ 99,99`. A frase da sobra explica, mas o texto normativo do §2.3 é *"Serão lançadas **N parcelas de R$ X**"*, e X não é definido. Deve ser `N−1 parcelas de R$ 33,33 e a primeira de R$ 33,34`, ou o valor exibido é falso.

---

## 8. Datas

### 8.1 ✅ SATISFAZ — 31/jan em 3x, sem arrasto

`31/01/2026 · 28/02/2026 · 31/03/2026`. Verificado por execução. A regra `min(dia_da_compra, ultimo_dia_do_mes)` **calculada sempre a partir de `data_compra`**, e não do mês anterior, é o que impede o arrasto — e o ADR 0007 diz isso explicitamente ("não 28/mar"). **Correto e bem escrito.**

### 8.2 ✅ SATISFAZ — `closing_day = 31` em fevereiro

`min(31, 28) = 28` (ou 29 em bissexto). Janelas contíguas `(31/jan, 28/fev]` e `(28/fev, 31/mar]`, sem sobreposição nem lacuna. A regra "sem propagar o ajuste para o mês seguinte" está no `CONTEXT.md` e é a certa. Com `closing_day = 31` e `due_day = 31`, a regra "se `due_day <= closing_day`, vence no mês seguinte" produz fecha 28/fev / vence 31/mar, com `periodo_fim <= data_fechamento <= data_vencimento` preservado. **Nenhum deslocamento de competência.**

### 8.3 🔴 BLOQUEIO — o cenário de ano bissexto do ADR 0007 está aritmeticamente errado

O ADR 0007 lista, entre os cenários que a suíte precisa cobrir:

> *"**Ano bissexto.** Compra 29/fev/2028 em 12x → parcela 12 em 28/fev/2029, não 01/mar."*

Aplicando a regra do próprio ADR ("parcela k avança `k−1` meses a partir de `data_compra`, com o dia fixado em `min(dia_da_compra, ultimo_dia_do_mes)`"), a parcela 12 avança **11** meses a partir de fevereiro de 2028 — e 11 meses depois de fevereiro é **janeiro**. Série completa, verificada por execução:

```
29/02/2028  29/03/2028  29/04/2028  29/05/2028  29/06/2028  29/07/2028
29/08/2028  29/09/2028  29/10/2028  29/11/2028  29/12/2028  29/01/2029
```

A parcela 12 cai em **29/01/2029**, não em 28/02/2029. Doze parcelas começando em fevereiro terminam em janeiro; para terminar em fevereiro seriam treze. Além do mês errado, o dia também: `min(29, 31) = 29` em janeiro, então nem o `28` do ADR aparece.

Isto é um cenário de borda **normativo**, destinado a virar teste. Escrito como está, ele congela o erro na suíte e um lançamento fica um mês fora de lugar — com o agravante de que o teste "passaria" e daria a impressão de que o bissexto está coberto. Corrija para: *"Compra 29/fev/2028 em 12x → parcela 12 em 29/jan/2029. O caso do dia 29 em fevereiro não bissexto aparece na parcela 13 de um 13x, ou numa `Recorrencia` mensal — que é onde ele deve ser testado."*

### 8.4 🔴 BLOQUEIO — `Recorrencia` no dia 31 não tem regra para fevereiro

`recorrencias.dia_do_mes` existe na tabela. O `CONTEXT.md` define `min(dia, ultimo_dia_do_mes)` para `closing_day`, `due_day` e para as parcelas de um `GrupoDeParcelamento` — **e não para `Recorrencia`**. A entrada **Recorrencia** do glossário não tem bloco de invariantes, e não há um único cenário de borda de recorrência em nenhum documento. A bateria exige: *"Recorrência mensal em dia 31 tem regra definida para fevereiro — e ela está testada."*

**Contraexemplo AI — R$ 2.000,00 aparecem ou somem, conforme quem implementa.** Aluguel de R$ 2.000,00, recorrência mensal no dia 31, ano de 2026.

| Regra possível | Fevereiro | Março | Efeito |
|---|---|---|---|
| `min(31, ultimo_dia)` | 28/fev | 31/mar | correto |
| pular meses sem o dia | **nenhuma ocorrência** | 31/mar | fevereiro perde R$ 2.000,00; o teto de fevereiro fica verde indevidamente |
| transbordar para o mês seguinte | 03/mar | 31/mar | **março tem duas ocorrências**, R$ 4.000,00, e o teto de março estoura |

Três respostas, todas plausíveis, nenhuma escrita. E `recorrencia.materializar` tem `UNIQUE (tenant_id, recorrencia_id, recorrencia_ocorrencia_em)` — se a regra mudar depois que ocorrências já foram materializadas, a chave muda e o job **duplica** todas as ocorrências futuras em vez de não fazer nada.

### 8.5 🔴 BLOQUEIO — a fronteira do período não é declarada, e o sistema tem duas convenções opostas

| Superfície | Convenção | Fonte |
|---|---|---|
| `domain/periodo.janela()` | `[Instant, Instant)` — **aberta à direita** | `sistema.md` §1.1 |
| Janela da Fatura | `(inicio, fim]` — **fechada à direita** | ADR 0007, `CONTEXT.md` |
| `zFiltroLancamentos.periodo` | **não declarada** | `sistema.md` §4.3 |

Duas convenções opostas convivendo é aceitável se cada uma estiver escrita. A do filtro de relatório — que é a que decide se um lançamento entra no total do mês — não está.

**Contraexemplo AJ — o último dia do mês entra duas vezes ou nenhuma.** Despesa de R$ 400,00 em 30/set às 23h00 (São Paulo). Com `ate` interpretado como `30/set 00:00`, ela fica fora de setembro; se o período seguinte for `de = 01/out`, fica fora de outubro também. **R$ 400,00 fora de todos os relatórios do ano.** Com `ate` inclusivo em ambos os lados de uma comparação de mês, o dia 30/set entra em setembro e o dia 01/out pode entrar em setembro e em outubro.

A bateria também exige *"comparação entre períodos usa a mesma regra de fronteira nos dois lados"*. A IA §2.7 oferece comparação com "mês anterior" e "mesmo mês do ano passado" — e nada obriga os dois lados a usarem a mesma regra, nem a mesma base temporal de cartão. Uma comparação com fronteiras diferentes produz uma variação percentual inventada.

### 8.6 🟡 RESSALVA — a data de negócio pode vir do relógio do cliente

A regra 9 do `CLAUDE.md` é clara: *"Data de negócio nunca vem do relógio do cliente. O servidor é a autoridade."* O spec cria dois caminhos onde ela pode ser violada sem que nada detecte:

- O formulário (IA §2.3) tem "Data — padrão: **hoje**", preenchido no cliente.
- `sistema.md` §1.5 autoriza chamar `domain/fatura.faturaAlvo(cartao, postedAt)` **no cliente** — decisão correta para a prévia, mas o `postedAt` que ela recebe é o do dispositivo.
- F7 exige salvar offline no mobile, com a fila local carimbando a data.

**Contraexemplo AK.** Aparelho com a data adiantada em dois dias, cartão fecha dia 25. O usuário compra R$ 800,00 em 24/set; o aparelho grava `posted_at = 26/set`; o lançamento vai para a fatura seguinte e o total da fatura que fecha erra em R$ 800,00. O spec não diz que o servidor sobrescreve, valida ou sequer compara o `posted_at` recebido contra o seu relógio.

---

## 9. Veredito

# REPROVADO

### 9.1 Bloqueios — todos precisam de resposta escrita antes de `/to-tickets`

| # | Bloqueio | Contraex. | Onde corrigir |
|---|---|---|---|
| **B1** | Rodapé sem balde de transferência; L5 é falso e "soma das páginas = resumo" é falso | A, B | `sistema.md` §4.4 · IA L5 |
| **B2** | A coluna temporal do filtro de período não é declarada; o saldo usa `effective_at` e o extrato usa `posted_at` | C | `contracts/filtro-lancamentos` |
| **B3** | Fuso de `saldo_snapshots.dia` e de `saldo_anterior` não declarado | D | §3.6 · §4.4 |
| **B4** | `efetivado ⟺ effective_at != null` + `effective_at = vencimento` ⟹ compra de cartão nasce realizada, com realizado futuro preenchido | E | ADR 0007 §3 · `CONTEXT.md` Status |
| **B5** | `faturas.periodo_inicio/fim` são `DATE`; a janela `(inicio, fim]` exige `TIMESTAMPTZ` | I, J | §3.4 (migration) |
| **B6** | `effective_at TIMESTAMPTZ = data_vencimento DATE` sem fuso; o desembolso muda de mês | K | ADR 0007 §3 |
| **B7** | Retroativo em outra fatura contradiz a definição de Fatura e quebra C5 | L | ADR 0007 · `CONTEXT.md` |
| **B8** | A perna de crédito do pagamento leva `fatura_id` por `CHECK` e zera `total_centavos` | M | §3.3 · §3.7 |
| **B9** | `Estorno` não existe no modelo; C5 e a tela de Fatura já dependem dele | N, O | `CONTEXT.md` (termo novo) |
| **B10** | Duas regras de rateio incompatíveis; divergem em R$ 0,03 em 7x, e nenhum teste de soma detecta | AF, AG | `CLAUDE.md` 11 · ADR 0005 · ADR 0007 · IA §2.3 |
| **B11** | `R$ 0,01 em 3x → (1,0,0)` viola `CHECK (valor_centavos <> 0)` | — | ADR 0007 · §3.3 |
| **B12** | Sinal de `parcelamentos.valor_total_centavos` indefinido; `Σ filhos = valor_total` falha | AH | §3.4 · ADR 0007 inv. 2 |
| **B13** | `consumo` é divisão sem tipo nem arredondamento; no limiar, o sinal inverte a comparação e o alerta dispara a 60% | Q, R | ADR 0008 · `domain/money` |
| **B14** | O teto **global** não tem partição por natureza; nunca estoura para quem tem superávit | T, U, V | ADR 0008 §Hierarquia |
| **B15** | `copiar` com global: `NULL = NULL` quebra a idempotência e aborta a transação | W | ADR 0008 inv. 10 |
| **B16** | Total planejado soma teto e piso globais num número sem significado | X | ADR 0008 · IA §2.6 |
| **B17** | Exclusão de transferência não escrita para nenhum dos 5 endpoints de `relatorios`; C2 não é garantido pelo desenho | AD | §4.1 · `filtro.ts` |
| **B18** | Soft delete de **uma** perna de `Transferencia` não é proibido (o parcelamento é protegido, a transferência não) | ver 9.3 | `CONTEXT.md` Transferencia |
| **B19** | Multi-moeda sem câmbio: `saldo_geral` é indefinido e a tela principal não tem número correto possível | AC | `CONTEXT.md` Saldo geral |
| **B20** | Nenhum job avalia `Objetivo`; `concluido_em` "na primeira travessia" nunca acontece | AB | §5.2 |
| **B21** | `Recorrencia` no dia 31 em fevereiro não tem regra | AI | `CONTEXT.md` Recorrencia |
| **B22** | Fronteira do período não declarada; comparação entre períodos não obriga a mesma regra nos dois lados | AJ | §4.3 · IA §2.7 |
| **B23** | Cenário de bissexto do ADR 0007 está errado: parcela 12 de 29/fev/2028 cai em **29/jan/2029** | — | ADR 0007 §Cenários |

### 9.2 O bloqueio isolado mais grave

**B17, com B8 logo atrás.** O produto declara, na IA §6, que o pagamento de fatura contado como despesa *"é o erro que mata o produto — se um spec chegar perto disso, o épico para"*. O spec chegou: a exclusão existe em um `AND` de um SQL de exemplo e em uma invariante de ADR, e está **ausente** nos cinco endpoints de relatório que a tela de Relatórios consome. E, pelo lado espelhado, o `CHECK cartao_tem_fatura` **força** a perna de crédito do pagamento para dentro da fatura, zerando o total de uma fatura paga.

A correção não é adicionar cinco `AND`. É fazer a exclusão ser estrutural: **um único tradutor de filtro por onde passa toda agregação monetária**, com a distinção entre *exibir transferência como linha* e *somá-la num total* codificada no schema — e o vínculo pagamento ↔ fatura por `transferencias.fatura_id`, que já existe na tabela, nunca por `lancamentos.fatura_id`.

### 9.3 Ressalvas — não bloqueiam, mas entram na dívida com dono e prazo

| # | Ressalva | Contraex. |
|---|---|---|
| R1 | `incluir_no_saldo_geral` não tratado no `saldo_anterior` do rodapé: R$ 5.000,00 de diferença entre duas telas | F |
| R2 | O rodapé mistura caixa de conta com dívida de cartão; dois números para "quanto eu tenho" | G |
| R3 | A invariante das três bases só vale em horizonte infinito; nenhuma tela tem um. Falta proibir comparar bases | H |
| R4 | Pagamento a maior não tem estado nem destino para o excedente | P |
| R5 | Gastar exatamente o teto é "dentro do plano" **e** dispara o alerta de 100% | — |
| R6 | `CONTEXT.md` afirma `consumo` sempre positivo; é falso com estorno. Contradiz o ADR 0008 | S |
| R7 | `planejado · gasto · resta` indefinido quando há categoria sem planejamento | Y |
| R8 | `saldo_base` congelado protege contra o retroativo posterior e falha contra o anterior | Z, AA |
| R9 | "Ajuste de saldo" entra nos totais de gasto e consome o teto global | AE |
| R10 | O explicador de parcelamento promete um valor que nenhuma parcela tem | — |
| R11 | Data de negócio pode vir do relógio do cliente (default do formulário, fila offline, `faturaAlvo` no cliente) | AK |
| R12 | Alerta de teto dispara em cascata pai+filhos no mesmo dia; falta supressão hierárquica | — |
| R13 | "Constraint deferida" para soma-zero das pernas exige `CONSTRAINT TRIGGER DEFERRABLE`; Postgres não tem constraint de agregação entre linhas | — |

**Sobre B18 / R13, o contraexemplo:** transferência de R$ 500,00 entre contas próprias. O usuário abre a tela de Lançamentos, seleciona a perna de débito e a exclui (`DELETE /lancamentos/:id`, soft). Sobra `+50000` solto: o saldo da conta de destino sobe R$ 500,00 do nada, o Saldo geral sobe R$ 500,00, e a soma das pernas deixa de ser zero. O `CONTEXT.md` protege o `GrupoDeParcelamento` com todas as letras — *"excluir uma parcela isolada é proibido"* — e **não escreve o equivalente para a `Transferencia`**, que é a estrutura em que o desequilíbrio cria dinheiro.

### 9.4 O que está certo e deve ser preservado na correção

Registrado para que a revisão não desfaça o que funciona:

- **Centavos inteiros em `BIGINT` com `Money`**, sem `NUMERIC` nem float em nenhum caminho monetário. Veto 2 de §8. ✅
- **`SUM(BIGINT)` no banco** é exato, associativo e independente de ordem. A justificativa do §4.4 está correta e a decisão de somar no banco e interpretar no domínio é a certa. ✅
- **Partida dobrada** com `transfer_group_id` e soma zero. ✅
- **Saldo derivado** com snapshot só como cache e `saldo.reconciliar` que **alerta** e nunca corrige em silêncio. É exatamente o que a bateria exige. ✅
- **Idempotência por índice único parcial** — `(tenant, provider, external_id)`, `(tenant, provider, conteudo_hash)`, `(tenant, recorrencia_id, ocorrencia_em)`, `(tenant, lancamento_bruto_id)`, `(tenant, chave_dedup)` — declarados como **correção, não otimização**. Um dos melhores trechos do spec. ✅
- **Janela da fatura fechada à direita**, com o lado escolhido, justificado e testável. ✅
- **`data_compra` no grupo, nunca nos filhos** — fato único, linha única. ✅
- **`dentro_do_plano ⟺ realizado >= valor`** sem `if` sobre natureza: correto nos oito quadrantes conferidos. ✅
- **Precedência global → raiz → subcategoria**: conferida com 1 global + 3 raízes + 2 subs; nada contado duas vezes, nada faltando. ✅
- **Conciliação propõe, o usuário confirma**; desfazer a importação em lote. ✅
- **`Objetivo` nunca cria `Lancamento`**, como teste de arquitetura. Mantém uma entidade de leitura fora do caminho do dinheiro. ✅

### 9.5 Condição de liberação

Reapresentar quando **B1–B23** tiverem resposta escrita nos documentos indicados (ADR nova onde a correção contradiz ADR aceita: 0007 em B4, B5, B6, B7, B11, B23; 0008 em B13, B14, B15, B16). As ressalvas R1–R13 podem seguir como dívida registrada com dono.

Nova auditoria obrigatória sobre o spec corrigido. E, na fase de implementação, cada contraexemplo desta auditoria (A–AK) entra na suíte como **teste nomeado antes da correção**, entregue ao `engenheiro-qa-automacao` para virar propriedade permanente — em particular AF, AH, Q e M, que somam certo e mesmo assim estão errados, e que nenhum property test de soma detecta.
