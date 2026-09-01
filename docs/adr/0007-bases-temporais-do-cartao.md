# ADR 0007 — As três bases temporais de um lançamento de cartão

- **Status:** Aceita
- **Data:** 2026-09-01
- **Emendas:**
  - 2026-09-01 — após a auditoria financeira do spec (bloqueios B4, B5, B6, B7, B11, B12, B23). Revogada a invariante 7 original (campo de efetivação = vencimento), trocada a representação da janela para semiaberta sem mudar o comportamento, corrigido o cenário de ano bissexto, e fixados o sinal de `valor_total` e o caso indivisível. As três bases e a decisão do dia do fechamento permanecem.
  - 2026-09-01 — resolvida a colisão de modelos com `docs/arquitetura/sistema.md` §3.3 sobre B4: `effective_at` **aposentado** como nome, o fato passa a `settled_at`, a previsão de caixa **não** é coluna, e o eixo caixa passa a agregar `Fatura` em vez de lançamento de cartão.

## Contexto

O `CLAUDE.md` fixa duas referências de tempo (`posted_at` e `settled_at`) e o `CONTEXT.md` as herdou. O teardown do Organizze (`docs/pesquisa/organizze-teardown.md`, seções 5 e 8.1) mostra que duas não bastam para cartão de crédito.

Escondido num link discreto no canto do relatório de categorias, o Organizze oferece três bases para atribuir um gasto de cartão a um mês:

| Base | Comportamento |
|---|---|
| Data da fatura | Só as compras da fatura daquele mês entram |
| Data da compra | Todas as compras feitas no mês entram, independente da fatura |
| Data da parcela (padrão) | Como "data da compra", mas em parceladas considera só a parcela do mês |

Isso não é um recurso de nicho. São **duas perguntas legítimas e diferentes** que o mesmo dado precisa responder:

- *"Quanto eu comprei em julho?"* — comportamento, hábito de consumo. Uma TV parcelada em 12x foi uma decisão de julho.
- *"Quanto eu vou desembolsar em julho?"* — fluxo de caixa. Dessa TV, só uma parcela pesa em julho.

Com o modelo atual não é possível responder à primeira. Uma compra de 12x em 15/jul gera doze `Lancamento` com `posted_at` de 15/jul a 15/jun do ano seguinte. A **data da compra** existe como fato no mundo, mas depois da parcela 1 ela não existe em lugar nenhum no banco: consultar julho devolve uma parcela, e o valor total da compra é irrecuperável.

Há uma terceira consequência, mais silenciosa: hoje ninguém sabe dizer o que `settled_at` significa num lançamento de cartão. A compra em si nunca compensa — quem compensa é o pagamento da fatura, que é uma `Transferencia` separada. Sem uma regra escrita, cada sessão inventa uma.

## Decisão

**Um lançamento de cartão tem três referências temporais. Cada uma mora num lugar diferente, e uma delas é derivada.**

### 1. `GrupoDeParcelamento.data_compra` — quando a compra aconteceu

Persistida **uma vez, no grupo**, nunca nos filhos. É o fato da compra, e um fato pertence à compra, não a cada parcela.

- Compra à vista no cartão não tem grupo: `data_compra` resolve como `COALESCE(grupo.data_compra, lancamento.posted_at)`.
- Corrigir a data da compra é uma escrita, no grupo. Nunca N escritas que podem divergir.
- `data_compra` é imutável depois que qualquer parcela pertence a uma `Fatura` fechada.

### 2. `Lancamento.posted_at` — a que parcela/mês o valor pertence

Já existe. Continua sendo o campo que decide **em qual `Fatura` o lançamento cai**.

Geração das parcelas a partir de `data_compra`:

- Parcela 1 tem `posted_at = data_compra`.
- Parcela k avança `k-1` meses a partir de `data_compra`, com o dia fixado em `min(dia_da_compra, ultimo_dia_do_mes)`.
- **O ajuste de mês curto não é arrastado.** Compra em 31/jan em 3x gera 31/jan, 28/fev, **31**/mar — não 28/mar.
- Rateio por `ratear` (ADR 0005): resto nas **primeiras** parcelas, uma unidade por parcela. R$ 100,00 em 3x são `3334, 3333, 3333`; em 7x, `1429×4` seguidos de `1428×3`.

**`valor_total` carrega o sinal do domínio.** Uma compra parcelada de R$ 100,00 tem `valor_total = −10000` e filhos negativos. Guardá-lo como magnitude positiva faria a invariante mais citada deste ADR — `Σ filhos = valor_total` — falhar literalmente, invertida em sinal, num teste que ninguém suspeitaria de estar errado.

**Parcelamento indivisível é rejeitado.** Exige-se `|valor_total| >= N`; fora disso o domínio devolve erro. R$ 0,01 em 3x produziria duas parcelas de valor zero, que `Lancamento` proíbe por invariante e o banco por `CHECK`. As saídas alternativas — gerar menos parcelas do que o Usuario pediu, ou relaxar `valor ≠ 0` — mentem sobre o parcelamento ou abrem lançamento de valor zero em todo o sistema.

### 3. `Lancamento.settled_at` — quando o dinheiro sai do bolso

**Esta seção substitui a versão original, que estava errada, e aposenta o nome que ela usava.**

O campo se chamava `effective_at`, e a redação anterior dizia que num lançamento de cartão ele é igual a `Fatura.data_vencimento`, sempre. Combinada com `efetivado ⟺ campo != null`, ela tornava **toda compra de cartão `efetivada` no instante da compra**, com data de efetivação no futuro. Consequência medida na auditoria: uma compra em 12x feita hoje preenche o Realizado de agosto de 2027 hoje, e o alerta de teto daquele mês pode disparar esta semana. O par realizado × previsto — que este projeto chama de eixo conceitual dos relatórios — deixava de existir justamente no cartão, que é onde passa a maior parte do gasto.

**O nome vai junto com o defeito.** "Efetivação" é lido como *fato* por metade dos leitores e como *previsão* pela outra metade — e a ambiguidade não é teórica: este ADR e o documento de arquitetura chegaram, em paralelo, a dois modelos de dados incompatíveis, um com `effective_at` anulável significando o fato, outro com `effective_at NOT NULL` significando a previsão. Termo que já produziu um erro não é reabilitado, pela mesma regra que aposentou `Meta` no ADR 0009. O fato passa a se chamar **`settled_at`** — compensação, liquidação —, que só tem uma leitura.

A regra correta:

- **`settled_at` só é escrito quando o dinheiro se move.** Num lançamento de cartão, quem move dinheiro é o pagamento da fatura.
- Enquanto a `Fatura` não está `paga`, os lançamentos dela têm `settled_at` nulo.
- Quando a Fatura passa a `paga`, o domínio grava `settled_at` = instante de compensação do pagamento em **todos** os lançamentos daquela Fatura, na mesma transação. Pagamento parcial não grava nada.
- **Não existe coluna de previsão de caixa em `lancamentos`.** A previsão de um cartão é a `Fatura`, não a linha — ver a seção seguinte.

### O eixo caixa agrega Faturas, não lançamentos de cartão

A alternativa considerada era persistir a previsão numa segunda coluna `NOT NULL` ("é sempre calculável"), para que o eixo caixa pudesse ordenar e indexar por ela sem join: `settled_at` para o efetivado, a previsão para o previsto. O argumento de desempenho é legítimo e precisa de resposta, não de recusa.

A resposta é que **o eixo caixa nunca deveria conter lançamento de cartão.** Seus consumidores são todos do lado da conta — saldo, Saldo geral, projeção de saldo, `Objetivo` ancorado. Uma compra de cartão não tira dinheiro de conta nenhuma; quem tira é o pagamento da fatura.

Projetar por lançamento de cartão é, além de mais caro, **errado**: o lançamento não tem `conta_id`, então seria preciso roteá-lo até uma Conta pelo cartão — um segundo join — e o resultado estaria errado sempre que a fatura fosse paga por outra conta. Aglutinar por `Fatura` é uma linha por ciclo em vez de N, sem join em `lancamentos`, e corresponde ao que o Usuario de fato paga.

O eixo caixa soma, então, duas coisas:

1. Lancamentos de `Conta`, por `settled_at` (compensados) ou `posted_at` (agendados).
2. `Fatura`s não pagas, pelo **total**, na `data_vencimento`, debitando a Conta de pagamento.

**A invariante que impede a dupla contagem:** uma Fatura entra na projeção enquanto não estiver `paga`; depois de paga, quem representa a saída é a perna de débito da `Transferencia`, na Conta. Nunca as duas ao mesmo tempo.

Com isso, a previsão não precisa ser coluna, nenhum índice do eixo caixa precisa liderar por ela, e nenhuma linha carrega uma cópia de um vencimento que pode mudar.

Disso decorre o `status`, que passa a ser **derivado e nunca coluna**: `efetivado` se `settled_at != null`; senão `previsto` se `posted_at` está no futuro; senão `pendente`. Uma parcela futura é `previsto`; uma compra na fatura aberta é `pendente`; tudo numa fatura paga é `efetivado`.

E disso decorre a correção de uma lacuna que o glossário carregava: **Realizado = `efetivado` + `pendente`** — o que já aconteceu, movido ou não. O Saldo continua contando só `efetivado`. Uma compra na fatura aberta está no Realizado do mês e fora do Saldo, e as duas coisas estão certas.

### Janela da Fatura: semiaberta, e o dia do fechamento entra

`[periodo_inicio, periodo_fim)`, com `periodo_fim` em **00h00 de `America/Sao_Paulo` do dia seguinte ao `closing_day`**.

**A decisão não mudou, só a representação.** Uma compra no dia exato do fechamento, a qualquer hora, continua entrando na fatura que fecha naquele dia — a regra 10 do `CLAUDE.md` diz "compras **após** o fechamento caem na fatura seguinte", e o dia do fechamento não é após o fechamento. O que muda é que a redação anterior, `(inicio, fim]`, obrigava a definir `periodo_inicio` como "o instante seguinte ao `periodo_fim` da anterior" — e "instante seguinte" não existe num contínuo. Em `DATE`, o sucessor de 25/set é 26/set, e as janelas `(26/ago, 25/set]` e `(26/set, 25/out]` deixam o dia 26/set **fora de ambas**; compensando com `>=` à esquerda, o dia 25/set cai em **duas** faturas e a compra é cobrada duas vezes.

Com a forma semiaberta, `periodo_fim(k) = periodo_inicio(k+1)` **exatamente**, e contiguidade e disjunção passam a ser verificáveis por igualdade. É também a convenção única de janela do domínio (`CLAUDE.md` regra 7), o que elimina a segunda convenção que convivia no sistema.

**`periodo_inicio` e `periodo_fim` são `TIMESTAMPTZ`, não `DATE`.** Uma compra às 23h30 do dia do fechamento em São Paulo é 02h30 UTC do dia seguinte; comparada contra um `DATE`, a coerção depende do fuso da sessão que escreve e exclui não só as 23h30 locais, mas qualquer compra a partir das 21h do dia anterior. A fatura fecha com o valor errado e o Usuario paga um mês depois do que devia. As bordas são calculadas em `America/Sao_Paulo` e persistidas como instantes UTC; a conversão vem antes da comparação, sempre.

**`data_fechamento`, `data_vencimento` e `competencia` são datas civis**, não instantes, e nunca são comparadas contra `posted_at`. A separação dos dois tipos é o que impede a coerção acidental que desloca um desembolso de mês.

### Competência da Fatura

A `competencia` de uma Fatura é o mês de `data_vencimento` — o mês em que o Usuario paga. Fatura que fecha em 25/set e vence em 05/out é a fatura de **outubro**.

### Lançamento retroativo

Um lançamento cuja janela natural já está `fechada` ou `paga` **não** reabre a fatura. Ele preserva seu `posted_at` original e é anexado à **fatura aberta mais antiga** do Cartao, marcado `retroativo`. O total de uma fatura fechada é imutável — é isso que "valor travado" significa.

Isso obriga duas correções que a redação original não fez.

**A pertinência de um lançamento a uma fatura é um vínculo explícito, não uma consulta por janela.** O glossário definia Fatura como "agrega os Lancamentos cuja janela contém seu `posted_at`" — e um retroativo pertence a uma fatura cuja janela **não** contém seu `posted_at`, o que tornava a definição falsa. A definição passa a ser: a Fatura agrega os lançamentos que apontam para ela por `fatura_id`. A *regra de atribuição* — janela que contém `posted_at`, ou a fatura aberta mais antiga se aquela não estiver aberta — é separada da definição. Separar as duas é o que permite o retroativo sem que a definição minta.

A invariante 5 continua valendo e **não** é a que quebrava: ela fala de **janelas**, e as janelas seguem disjuntas e contíguas independentemente de onde um retroativo seja anexado.

**A composição da fatura tem quatro parcelas, não três.** `compras do ciclo + parcelas de compras anteriores + retroativos − estornos = total`. Sem o balde de retroativos, uma compra de R$ 500,00 de agosto anexada à fatura de novembro faz a conferência "ao centavo" da tela de Fatura fechar com R$ 500,00 de diferença e nenhuma linha que a explique.

### Bases nos relatórios

| Base | Atribuição |
|---|---|
| `data_compra` | O **valor total** da compra na competência de `data_compra` |
| `data_parcela` **(padrão)** | Cada parcela na competência do seu `posted_at` |
| `data_fatura` | Cada parcela na `competencia` da Fatura a que pertence |

- **Padrão: `data_parcela`.** É a que responde à pergunta de fluxo de caixa, que é a pergunta cotidiana.
- A base é preferência por Tenant, e **corrigimos a fraqueza 8.5.5 do teardown**: o seletor é explícito no cabeçalho do relatório, não um link no canto. A base ativa aparece em toda impressão e em todo export.
- Toda resposta de API de relatório carrega `base_temporal`. **Nenhum número de cartão trafega sem dizer o que significa.**
- A base **só afeta lançamentos de `Cartao`**. Em lançamento de `Conta` as três colapsam em `posted_at`.
- O `Planejamento` **não** obedece a essa preferência — usa sempre `data_parcela` (ADR 0008).
- **Estorno.** Sob a base `data_compra`, o estorno de uma compra parcelada é atribuído à competência da `data_compra` **do grupo estornado**, não à sua própria. Sem essa regra, uma compra de R$ 300,00 em julho desfeita em agosto fica para sempre no relatório de julho como gasto, com o crédito caindo em agosto — sob nenhuma das três bases o estorno anularia a compra na competência em que a compra foi atribuída.

**Dois totais de bases diferentes nunca são comparados, somados nem exibidos lado a lado.** A invariante de que a soma é a mesma nas três bases vale sobre o ciclo de vida completo de um grupo — e nenhuma tela tem horizonte infinito. Num recorte de ano-calendário, uma compra de R$ 1.200,00 em 12x em dezembro vale R$ 1.200,00 sob `data_compra`, R$ 100,00 sob `data_parcela` e R$ 0,00 sob `data_fatura`: três exportações do "ano de 2026" com diferença de 100%. Toda comparação entre períodos usa a mesma base nos dois lados, e a identidade de um relatório inclui sua `base_temporal`.

### Invariantes

Escritas para virar teste direto:

1. `data_compra <= posted_at` de toda parcela do grupo.
2. Soma dos `valor` das N parcelas = `GrupoDeParcelamento.valor_total`, exatamente, **com sinal**, para qualquer total e qualquer N. *(property-based)*
3. `max(parcelas) − min(parcelas) <= 1` em centavos, e as maiores vêm primeiro. **Sem esta, a invariante 2 não distingue a regra de rateio escolhida daquela que põe todo o resto na primeira parcela** — as duas somam certo. *(property-based)*
4. `|valor_total| >= N`, senão a construção do grupo falha. Nenhuma parcela de valor zero é criada.
5. `installment_number` cobre `[1, N]` sem lacuna e sem repetição.
6. Todo `Lancamento` de Cartao tem exatamente um `fatura_id`.
7. As janelas de um Cartao são contíguas e disjuntas, verificado por igualdade: `periodo_fim(k) = periodo_inicio(k+1)`. Nenhum instante em duas janelas, nenhum instante fora de todas. **Invariante sobre janelas, não sobre lançamentos** — um retroativo não a viola.
8. Compra com `posted_at` a qualquer hora do `closing_day` pertence à fatura que fecha naquele dia; a partir de 00h00 local do dia seguinte, à seguinte.
9. `settled_at` de lançamento de Cartao é nulo enquanto a Fatura não estiver `paga`, e igual ao instante de compensação do pagamento depois disso. **Nunca igual a `data_vencimento`.** *(substitui a invariante 7 original)*
9b. Nenhuma coluna de `lancamentos` armazena data de vencimento de fatura.
9c. Nenhum `Lancamento` de `Cartao` entra no eixo caixa. Saldo, Saldo geral, projeção e `Objetivo` somam lançamentos de `Conta` e `Fatura`s.
9d. Uma `Fatura` entra na projeção enquanto não estiver `paga`; depois, quem representa a saída é a perna de débito da `Transferencia`. Nunca as duas. *(property-based: projetar até uma data além do vencimento dá o mesmo número antes e depois do pagamento)*
9e. Alterar `due_day` de um Cartao ou reabrir uma Fatura muda a projeção imediatamente, sem job e sem reconciliação, porque nada foi copiado.
10. Nenhuma parcela futura é `efetivado`. O Realizado de uma competência futura é sempre zero. *(regressão do contraexemplo E)*
11. `total` de uma Fatura exclui pernas de Transferencia.
12. Trocar a base temporal **não altera a soma** sobre o ciclo de vida completo de um grupo de parcelamento. Só redistribui entre competências. *(property-based)*
13. Somar as três bases sobre um horizonte que contenha todas as parcelas dá o mesmo número três vezes. **Em horizonte finito não dá, e o produto proíbe a comparação.**
14. `posted_at` nunca muda depois de criado — nem em lançamento retroativo, nem em reprocessamento de ingestão.
15. Nenhuma comparação de janela envolve `DATE`.

### Cenários de borda que a suíte precisa cobrir

- **Dia exato do fechamento.** `closing_day = 25`, compra em 25/set → fatura que fecha em 25/set.
- **Fuso na virada.** Compra às 23h30 de 25/set em São Paulo (02h30 UTC de 26/set) → ainda a fatura de 25/set.
- **Vencimento antes do fechamento.** `closing_day = 25`, `due_day = 5` → vence em 05/out. `competencia` = outubro.
- **Mês curto.** `closing_day = 31` em fevereiro → fecha em 28 (ou 29 em bissexto).
- **Parcela em mês curto sem arrasto.** Compra 31/jan em 3x → 31/jan, 28/fev, 31/mar.
- **Ano bissexto.** Compra 29/fev/2028 em 12x → parcela 12 em **29/jan/2029**. A parcela k avança `k−1` meses, e 11 meses depois de fevereiro é janeiro; doze parcelas começando em fevereiro terminam em janeiro. O dia é `min(29, 31) = 29`. *(A versão original deste ADR dizia 28/fev/2029, que é a parcela 13 e ainda erra o dia. Escrito assim, o cenário congelaria o erro numa suíte que passaria dando a impressão de cobrir o bissexto.)*
- **O dia 29 em fevereiro não bissexto** aparece na parcela 13 de um 13x — 28/fev/2029 — ou numa `Recorrencia` mensal. É lá que ele deve ser testado.
- **Parcela que não divide.** R$ 100,00 em 3x → `3334, 3333, 3333`. R$ 100,00 em **7x** → `1429, 1429, 1429, 1429, 1428, 1428, 1428`, e **não** `1432, 1428×6` — as duas somam R$ 100,00 e só a asserção de dispersão as separa. R$ 0,03 em 3x → `1, 1, 1`.
- **Parcelamento indivisível.** R$ 0,01 em 3x e R$ 0,02 em 3x são **rejeitados**, não `(1,0,0)` e `(1,1,0)`. Parcela de valor zero é irrepresentável.
- **Compra depois do fechamento, antes do vencimento.** `closing_day = 25`, `due_day = 5`, compra em 30/set → fatura de novembro. Um mês inteiro de distância entre comprar e pagar, e é o comportamento correto.
- **Retroativo em fatura paga.** Compra em 10/ago lançada em 20/out com a fatura de agosto paga → anexa à fatura aberta mais antiga, `posted_at` continua 10/ago, base `data_compra` continua atribuindo a agosto.
- **Parcelamento cruzando o fechamento.** Compra em 26/set com fechamento em 25: parcela 1 já cai na fatura de outubro. A soma das 3 bases sobre 12 meses continua idêntica.
- **Horário de verão.** O Brasil não tem hoje, mas já teve. Nenhum cálculo usa offset fixo `-03:00`; sempre a zona IANA.
- **Compra na fatura aberta.** Compra hoje, fatura fecha daqui a 10 dias. `status = pendente`, entra no Realizado do mês, **não** entra no Saldo, `settled_at` nulo.
- **Parcela futura.** Parcela 8 de 12, `posted_at` em 2027. `status = previsto`, fora do Realizado, fora do Saldo, dentro do Projetado. Nenhum alerta de teto de 2027 dispara hoje.
- **Fatura paga.** Ao quitar, todos os lançamentos da fatura recebem `settled_at` = instante do pagamento e passam a `efetivado`, na mesma transação.
- **Pagamento parcial.** Fatura `parcialmente_paga`; nenhum lançamento recebe `settled_at`; todos seguem `pendente`.
- **Vencimento no dia 1.** `due_day = 1`, fatura vence 01/nov. O desembolso é apurado em `America/Sao_Paulo` e cai em **novembro**. Com `data_vencimento` coagido a instante por uma sessão em UTC, cairia em 31/out às 21h e a fatura inteira entraria no snapshot de outubro — por isso data civil e instante são tipos distintos.
- **Projeção antes e depois do pagamento.** Fatura de R$ 1.000,00 vencendo 05/out; projetar a conta até 31/out dá o mesmo número no dia 04/out (fatura aberta) e no dia 06/out (fatura paga, transferência lançada). Se der R$ 2.000,00 de diferença, a fatura e a transferência estão sendo contadas juntas.
- **`due_day` alterado com faturas abertas.** Mudar o vencimento do cartão reposiciona a projeção na hora. Com a previsão copiada para cada linha, N linhas ficariam com o vencimento antigo.
- **Fatura paga por outra conta.** O Usuario quita a fatura a partir de uma conta diferente da padrão: a projeção da conta padrão deixa de conter a fatura e a da conta usada recebe a transferência. Projetado por lançamento de cartão, o débito teria caído na conta errada.
- **Estorno de parcelada sob `data_compra`.** Compra R$ 300,00 em 3x em 05/jul, estornada integralmente em 20/ago: julho recebe `−300,00` do estorno, e não agosto. O relatório de julho deixa de mostrar um gasto desfeito.

## Consequências

**Positivas.** As duas perguntas — "quanto comprei" e "quanto vou pagar" — passam a ser respondíveis a partir do mesmo dado, sem número inventado. `data_compra` no grupo torna a divergência entre parcelas impossível por construção, em vez de por validação. `settled_at` deixa de ser um campo que cada sessão interpreta e passa a ter uma regra verificável por job. A janela fechada à direita resolve de uma vez a discussão do dia do fechamento, que reaparece toda vez que ela não está escrita. Carregar `base_temporal` no payload significa que nenhuma tela pode mostrar um total de cartão sem dizer sob qual leitura — o oposto do link escondido do Organizze.

**Negativas.** Três bases é uma dimensão a mais em toda consulta de relatório de cartão: três caminhos de agregação, três conjuntos de teste, e um índice a mais. É explicação a mais na UI — um seletor que a maioria dos usuários nunca vai tocar, mas cuja ausência torna o número ambíguo. Quitar uma fatura passa a escrever `settled_at` em N linhas numa transação, em vez de zero: é mais caro, e obriga o pagamento a ser transacional com a atualização dos lançamentos. `status` derivado custa uma expressão em toda consulta que filtra por situação. A regra do dia do fechamento pode discordar do emissor real: quando um adapter do `BankSyncProvider` trouxer uma fatura fechada de verdade, a fatura importada manda, e a divergência aparece na conciliação, não como erro. E proibir a comparação entre bases é uma restrição que a UI precisa impor ativamente, porque a tela de comparação de períodos convida a violá-la.

## Alternativas rejeitadas

**Só `posted_at` e `settled_at`.** O que temos hoje. Rejeitado: torna "quanto comprei em julho" permanentemente irrespondível. A informação não é perdida por design, é perdida por omissão — e uma vez que existem dados de cliente sem `data_compra`, ela não volta.

**`data_compra` copiada em cada `Lancamento` filho.** Dispensa o join e simplifica a consulta. Rejeitado: replica o mesmo fato em N linhas. Um `UPDATE` que erra o `WHERE` deixa parcelas discordando sobre quando a compra aconteceu, e nada no modelo detecta isso. Fato único, linha única.

**Uma base fixa, sem escolha.** Menos superfície, menos teste. Rejeitado: qualquer escolha fixa deixa uma pergunta legítima sem resposta, e o usuário compensa fazendo conta na mão — que é exatamente o que o produto existe para eliminar.

**`settled_at` preenchido pelo Usuario no lançamento de cartão.** Mais simples de implementar. Rejeitado: o Usuario não sabe, e não deveria precisar saber, quando a fatura vence quando está registrando uma compra. Campo que o humano preenche por adivinhação é campo errado.

**Um campo só, com a data de vencimento da fatura.** Era a decisão original deste ADR, e estava errada. O argumento a favor era que deixar o campo nulo até o pagamento "quebraria a projeção justamente no futuro". O argumento é falso: a projeção do eixo caixa usa a `Fatura`, não a linha. **Revertido:** uma data futura num campo de compensação faz toda compra de cartão nascer `efetivada`, preenche o Realizado de meses que ainda não chegaram e dispara alerta de teto de 2027 hoje.

**Duas colunas: `settled_at` para o fato e uma previsão `NOT NULL` ao lado.** É o modelo a que o `arquiteto-solucao` chegou em paralelo, e ele resolve B4 tão bem quanto este. Rejeitado por dois motivos. Primeiro, previsão persistida é valor derivado sem fonte de verdade própria: editar `due_day` do cartão ou reabrir uma fatura deixa cada linha carregando um vencimento velho, e nada acusa — seria preciso um gatilho e um job de reconciliação para um dado que um join já dá correto. Segundo, e decisivo, a coluna existe para pôr lançamento de cartão num eixo em que ele não deve estar: o ganho de índice some quando o eixo caixa passa a agregar `Fatura`, que é a unidade certa e é uma linha por ciclo em vez de N.

**Manter o nome `effective_at` para o fato.** Menos alteração em documentos já escritos. Rejeitado: foi a ambiguidade desse nome que produziu dois modelos incompatíveis em paralelo, e ela reincidiria no primeiro leitor novo. É pré-código; o custo de renomear é hoje o mais barato que será.

**`status` como coluna, atualizada por job.** Mais barato de consultar. Rejeitado: um lançamento cujo `posted_at` passou continua marcado `previsto` até o job rodar, e o número congela sem que nada acuse. Derivar de `settled_at` e `posted_at` elimina a classe inteira.

**Compra no dia do fechamento vai para a fatura seguinte.** É o comportamento de parte dos emissores reais. Rejeitado: contraria a redação da regra 10 do `CLAUDE.md`, que é inegociável, e é contraintuitivo para quem lança à mão. Se um emissor real discordar, a fatura importada é a autoridade sobre a nossa.

**Reabrir a fatura fechada para receber o lançamento retroativo.** Preserva a definição original de Fatura e dispensa o balde de retroativos. Rejeitado: o total de uma fatura fechada é um fato congelado, e reabri-lo altera um valor que o Usuario já conferiu — possivelmente já pagou. O retroativo entra na fatura aberta e a composição ganha uma linha que o explica.

**Reduzir as parcelas futuras num estorno parcial.** Faria o grupo refletir o custo final da compra. Rejeitado: quebra `Σ filhos = valor_total`, e reduzir uma parcela a zero é irrepresentável. O grupo diz o que a compra custou; o estorno diz o que voltou. São dois fatos e ficam em duas linhas.
