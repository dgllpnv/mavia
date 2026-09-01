# ADR 0007 — As três bases temporais de um lançamento de cartão

- **Status:** Aceita
- **Data:** 2026-09-01

## Contexto

O `CLAUDE.md` fixa duas referências de tempo (`posted_at` e `effective_at`) e o `CONTEXT.md` as herdou. O teardown do Organizze (`docs/pesquisa/organizze-teardown.md`, seções 5 e 8.1) mostra que duas não bastam para cartão de crédito.

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

Há uma terceira consequência, mais silenciosa: hoje ninguém sabe dizer o que `effective_at` significa num lançamento de cartão. A compra em si nunca compensa — quem compensa é o pagamento da fatura, que é uma `Transferencia` separada. Sem uma regra escrita, cada sessão inventa uma.

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
- Rateio por `allocate` (ADR 0005): o resto vai na primeira parcela. R$ 100,00 em 3x são `3334, 3333, 3333`, somando exatamente `10000`.

### 3. `Lancamento.effective_at` — quando vira dinheiro fora do bolso

Em lançamento de cartão, `effective_at` é **função da `Fatura`**: igual a `Fatura.data_vencimento`. É materializado na linha por desempenho, mas escrito exclusivamente pelo domínio a partir da Fatura — nunca por entrada do Usuario, nunca por adapter de ingestão. O job de reconciliação do saldo verifica a igualdade junto com os snapshots.

### Janela da Fatura: fechada à direita

`(periodo_inicio, periodo_fim]`. Uma compra **no dia exato do fechamento** entra na fatura que fecha naquele dia. A regra 10 do `CLAUDE.md` diz "compras **após** o fechamento caem na fatura seguinte" — e o dia do fechamento não é após o fechamento.

Os limites são calculados em `America/Sao_Paulo` e persistidos como instantes UTC. Uma compra às 22h do dia do fechamento em São Paulo é 01h UTC do dia seguinte: comparar em UTC nu joga a compra na fatura errada. A conversão vem antes da comparação, sempre.

### Competência da Fatura

A `competencia` de uma Fatura é o mês de `data_vencimento` — o mês em que o Usuario paga. Fatura que fecha em 25/set e vence em 05/out é a fatura de **outubro**.

### Lançamento retroativo

Um lançamento cuja janela natural já está `fechada` ou `paga` **não** reabre a fatura. Ele preserva seu `posted_at` original e é anexado à **fatura aberta mais antiga** do Cartao, sinalizado como retroativo. O total de uma fatura fechada é imutável — é isso que "valor travado" significa.

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

### Invariantes

Escritas para virar teste direto:

1. `data_compra <= posted_at` de toda parcela do grupo.
2. Soma dos `valor` das N parcelas = `GrupoDeParcelamento.valor_total`, exatamente, para qualquer total e qualquer N. *(property-based)*
3. `installment_number` cobre `[1, N]` sem lacuna e sem repetição.
4. Todo `Lancamento` de Cartao pertence a exatamente uma `Fatura`.
5. As janelas de um Cartao são contíguas e disjuntas: nenhum instante cai em duas faturas, nenhum instante cai em nenhuma.
6. Compra com `posted_at` exatamente em `periodo_fim` pertence àquela fatura; um milissegundo depois, à seguinte.
7. `effective_at` de lançamento de Cartao = `data_vencimento` da sua Fatura. Sempre.
8. Trocar a base temporal **não altera a soma** sobre o ciclo de vida completo de um grupo de parcelamento. Só redistribui entre competências. *(property-based)*
9. Somar as três bases sobre um horizonte que contenha todas as parcelas dá o mesmo número três vezes.
10. `posted_at` nunca muda depois de criado — nem em lançamento retroativo, nem em reprocessamento de ingestão.

### Cenários de borda que a suíte precisa cobrir

- **Dia exato do fechamento.** `closing_day = 25`, compra em 25/set → fatura que fecha em 25/set.
- **Fuso na virada.** Compra às 23h30 de 25/set em São Paulo (02h30 UTC de 26/set) → ainda a fatura de 25/set.
- **Vencimento antes do fechamento.** `closing_day = 25`, `due_day = 5` → vence em 05/out. `competencia` = outubro.
- **Mês curto.** `closing_day = 31` em fevereiro → fecha em 28 (ou 29 em bissexto).
- **Parcela em mês curto sem arrasto.** Compra 31/jan em 3x → 31/jan, 28/fev, 31/mar.
- **Ano bissexto.** Compra 29/fev/2028 em 12x → parcela 12 em 28/fev/2029, não 01/mar.
- **Parcela que não divide.** R$ 100,00 em 3x, R$ 0,01 em 3x (`1, 0, 0`), R$ 0,02 em 3x (`1, 1, 0`).
- **Compra depois do fechamento, antes do vencimento.** `closing_day = 25`, `due_day = 5`, compra em 30/set → fatura de novembro. Um mês inteiro de distância entre comprar e pagar, e é o comportamento correto.
- **Retroativo em fatura paga.** Compra em 10/ago lançada em 20/out com a fatura de agosto paga → anexa à fatura aberta mais antiga, `posted_at` continua 10/ago, base `data_compra` continua atribuindo a agosto.
- **Parcelamento cruzando o fechamento.** Compra em 26/set com fechamento em 25: parcela 1 já cai na fatura de outubro. A soma das 3 bases sobre 12 meses continua idêntica.
- **Horário de verão.** O Brasil não tem hoje, mas já teve. Nenhum cálculo usa offset fixo `-03:00`; sempre a zona IANA.

## Consequências

**Positivas.** As duas perguntas — "quanto comprei" e "quanto vou pagar" — passam a ser respondíveis a partir do mesmo dado, sem número inventado. `data_compra` no grupo torna a divergência entre parcelas impossível por construção, em vez de por validação. `effective_at` deixa de ser um campo que cada sessão interpreta e passa a ter uma regra verificável por job. A janela fechada à direita resolve de uma vez a discussão do dia do fechamento, que reaparece toda vez que ela não está escrita. Carregar `base_temporal` no payload significa que nenhuma tela pode mostrar um total de cartão sem dizer sob qual leitura — o oposto do link escondido do Organizze.

**Negativas.** Três bases é uma dimensão a mais em toda consulta de relatório de cartão: três caminhos de agregação, três conjuntos de teste, e um índice a mais. É explicação a mais na UI — um seletor que a maioria dos usuários nunca vai tocar, mas cuja ausência torna o número ambíguo. `effective_at` materializado é denormalização, e denormalização diverge: exige o job de reconciliação, que é código e é custo. A janela fechada à direita pode discordar do emissor real: quando um adapter do `BankSyncProvider` trouxer uma fatura fechada de verdade, a fatura importada manda, e a divergência aparece na conciliação, não como erro.

## Alternativas rejeitadas

**Só `posted_at` e `effective_at`.** O que temos hoje. Rejeitado: torna "quanto comprei em julho" permanentemente irrespondível. A informação não é perdida por design, é perdida por omissão — e uma vez que existem dados de cliente sem `data_compra`, ela não volta.

**`data_compra` copiada em cada `Lancamento` filho.** Dispensa o join e simplifica a consulta. Rejeitado: replica o mesmo fato em N linhas. Um `UPDATE` que erra o `WHERE` deixa parcelas discordando sobre quando a compra aconteceu, e nada no modelo detecta isso. Fato único, linha única.

**Uma base fixa, sem escolha.** Menos superfície, menos teste. Rejeitado: qualquer escolha fixa deixa uma pergunta legítima sem resposta, e o usuário compensa fazendo conta na mão — que é exatamente o que o produto existe para eliminar.

**`effective_at` preenchido pelo Usuario no lançamento de cartão.** Mais simples de implementar. Rejeitado: o Usuario não sabe, e não deveria precisar saber, quando a fatura vence quando está registrando uma compra. Campo que o humano preenche por adivinhação é campo errado.

**`effective_at` = data em que a fatura foi efetivamente paga.** Mais fiel ao caixa. Rejeitado: deixaria `effective_at` nulo em todo lançamento de fatura ainda não paga, quebrando a projeção justamente onde ela importa — no futuro. O vencimento é a melhor estimativa disponível no momento da compra, e o pagamento real já está modelado como `Transferencia`.

**Janela `[fechamento, fechamento_seguinte)` — compra no dia do fechamento vai para a fatura seguinte.** É o comportamento de parte dos emissores reais. Rejeitado: contraria a redação da regra 10 do `CLAUDE.md`, que é inegociável, e é contraintuitivo para quem lança à mão. Se um emissor real discordar, a fatura importada é a autoridade sobre a nossa.
