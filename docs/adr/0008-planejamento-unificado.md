# ADR 0008 — `Planejamento`: uma entidade para teto de gasto e piso de receita

- **Status:** Aceita
- **Data:** 2026-09-01
- **Emendas:**
  - 2026-09-01 — escopo global admitido (ver *Hierarquia de escopos*); a redação original o havia deixado em aberto por um receio de contagem dupla que a regra de precedência já resolvia.
  - 2026-09-01 — após a auditoria financeira do spec (bloqueios B13, B14, B15, B16): definidos o tipo e o arredondamento de `consumo`, corrigida a inversão do limiar de alerta, particionado o realizado global por natureza, e fixada a identidade do Planejamento para que a cópia seja idempotente com escopo global. Ambas as emendas antes de qualquer implementação.

## Contexto

O `CONTEXT.md` tinha dois termos separados:

> **Limite (Budget)** — Teto de gasto por Categoria num período.
> **Meta** — Objetivo de acúmulo com valor-alvo e prazo. Distinta de Limite: Limite restringe saída, Meta persegue entrada.

O teardown do Organizze (seção 6) mostra que "Limite de gastos" e "Metas de receitas" são **a mesma tela, espelhada**: mesmo escopo (categoria × mês), mesmo ciclo de vida, mesmo estado vazio, e a mesma operação de partida — *"Copiar os últimos definidos"*. A diferença entre as duas é o sentido da comparação. Nada mais.

**Mas o termo `Meta` cobria dois conceitos, e essa é a armadilha deste ADR.** A "meta de receitas" do Organizze é um **piso mensal por categoria** — o espelho do Limite, e é ela que se unifica. O `Meta` do nosso glossário era outra coisa: um **acúmulo plurimensal com prazo**, "juntar R$ 12.000 até dezembro". Escopo diferente, horizonte diferente, apuração de progresso diferente. A primeira versão deste ADR tratou os dois como um só e apagou o acúmulo do modelo; o `product-financeiro` vetou, com razão. Este ADR unifica **apenas** o piso mensal. O acúmulo vira `Objetivo`, no ADR 0009, e o nome `Meta` é aposentado por ser exatamente a ambiguidade que causou o erro.

O Organizze paga por tratá-las como coisas diferentes: "Limite de gastos" é item de primeiro nível na navegação global, e "Metas de receitas" está enterrada em ⚙ → mais opções. O próprio teardown classifica isso como inconsistência de arquitetura de informação, não decisão de produto (seções 6 e 8.5.1). É o sintoma visível de uma duplicação que começou no modelo.

Duas entidades para o mesmo mecanismo custam duas vezes: dois CRUDs, dois motores de alerta, duas operações de cópia, dois lugares onde o bug de virada de mês pode morar — e um deles vai ser corrigido sem o outro.

Há ainda a decisão do horizonte do próprio planejamento. Ele é **mensal e não perpétuo** — é exatamente por isso que "copiar os últimos definidos" precisa existir no Organizze, e vai precisar existir aqui.

## Decisão

**`Limite` e a meta de receita mensal deixam de existir como termos. Uma entidade, `Planejamento`.** O termo `Meta` é aposentado por inteiro (ADR 0009).

### Modelo

| Campo | Papel |
|---|---|
| `tenant_id` | RLS, como toda tabela de negócio |
| `categoria_id` | Escopo. Nulo = global |
| `competencia` | `DATE` no dia 1, em `America/Sao_Paulo` |
| `valor` | `Money`. **O sinal é a natureza** |
| `alertas_percentuais` | `int[]`, padrão `[80, 100]` |
| `deleted_at` | Soft delete |

Escopo é **categoria × competência**, com a categoria opcional — ver *Hierarquia de escopos*. Nada mais: nem Etiqueta, nem Conta, nem período livre.

**O que este ADR não cobre.** `Planejamento` absorve o `Limite` de gastos e a **meta de receita mensal** — o piso por categoria, que é o espelho exato do Limite. Não absorve o **objetivo de acúmulo plurimensal com prazo** ("juntar R$ 12.000 até dezembro"), que tem outro horizonte, outro ciclo de vida e outra apuração de progresso. Esse é `Objetivo`, no ADR 0009. O termo `Meta` cobria os dois sentidos e por isso foi aposentado.

### O sinal carrega a direção

Não existe coluna `natureza`. `valor` negativo é **teto** de despesa; `valor` positivo é **piso** de receita — a mesma convenção de sinal do resto do domínio (ADR 0005).

A consequência é a razão desta decisão existir:

```
dentro_do_plano  ⟺  realizado >= valor
```

Uma comparação, sem nenhum `if` sobre natureza:

- Teto de R$ 500 → `valor = -50000`. Gastei R$ 300 → `-30000 >= -50000` → dentro.
- Teto de R$ 500 → `valor = -50000`. Gastei R$ 600 → `-60000 >= -50000` → estourou.
- Piso de R$ 3.000 → `valor = 300000`. Recebi R$ 3.500 → `350000 >= 300000` → batido.
- Piso de R$ 3.000 → `valor = 300000`. Recebi R$ 2.000 → `200000 >= 300000` → abaixo.

### O consumo é uma razão inteira, e o limiar não pode ser calculado por multiplicação

`consumo_bp = razaoEmBp(realizado, valor)` — `(realizado.centavos × 10000) / valor.centavos`, truncado **em direção a zero**. Inteiro com sinal, em basis points: 10000 bp = 100,00%. É a única grandeza fracionária do domínio, e é inteira; `Money` não ganha divisão que devolva `Money`.

O limiar é `atingiu(pct) ⟺ consumo_bp >= pct × 100`.

**A forma proibida é evitar a divisão multiplicando os dois lados por `valor`.** Ela é idêntica à que funciona para piso e está errada para teto, porque `valor` negativo **inverte o sentido da desigualdade**. Com teto de R$ 500,00 e R$ 300,00 gastos — 60% de consumo:

```
realizado × 100 >= pct × valor
 −30000  × 100 >=  80 × (−50000)
    −3.000.000 >= −4.000.000        →  VERDADEIRO  →  alerta de 80% disparado a 60%
```

E, pior, a mesma forma **para** de alertar exatamente quando o teto é atingido. O `if` sobre natureza que a decisão central deste ADR aboliu tinha voltado pela porta dos fundos, dentro do cálculo percentual, e invertido. A correção é estrutural, não um sinal trocado: **divide-se uma vez, para um inteiro com sinal, e compara-se esse inteiro.** Nunca se multiplica pela grandeza que carrega o sinal.

**A exibição usa o mesmo `consumo_bp`, dividido por 100.** Com realizado de −R$ 399,99 sob teto de R$ 500,00, o consumo verdadeiro é 79,998%; truncado, 7999 bp. A tela mostra 79,99% e o alerta de 80% não dispara — coerentes porque são o mesmo número. Formatar por arredondamento a partir de outro cálculo faria a tela anunciar 80,00% sem alerta, ou o alerta disparar um centavo antes do limiar. Trunca-se, nunca se arredonda, justamente para não anunciar um limiar que não foi cruzado.

**`consumo_bp` pode ser negativo**, e a redação anterior do glossário afirmava o contrário. Um mês cujo único lançamento na categoria é um estorno de R$ 80,00 sob um teto de R$ 500,00 dá `8000 / (−50000)` = −1600 bp = −16%. `dentro_do_plano` continua verdadeiro e correto; a barra recebe um número negativo, exibido como 0% com o valor real no detalhe. Nenhum limiar positivo é cruzado por consumo negativo, então nenhum alerta espúrio nasce daí.

**Gastar exatamente o teto** é `dentro_do_plano` **e** `consumo_bp = 10000`, que cruza o limiar padrão de 100. Não é contradição, são duas perguntas — mas a tela mostraria verde e o sino mostraria alerta para o mesmo objeto. O estado exibido nesse ponto é um terceiro rótulo derivado, **`no_limite`**, nem dentro nem estourado.

`natureza` (`teto` | `piso`) continua no glossário como propriedade **derivada** do sinal, para rotular tela. Nunca persistida: um enum e um sinal podem se contradizer, e estado inválido representável é exatamente o que não fazemos.

### Realizado, projetado e alerta

- **Realizado** — só Lancamentos `efetivado`. É sobre ele que os alertas disparam.
- **Projetado** — realizado + `previsto`. Aparece na barra, nunca soma com o realizado na mesma linha.
- O domínio emite `PlanejamentoLimiarAtingido(planejamento_id, limiar, consumo)` quando o `consumo` do realizado cruza um percentual. O domínio não sabe se isso é boa ou má notícia — quem sabe é a tela.

**Transferencia nunca entra no realizado.** Não é receita nem despesa (ADR 0005), e pagamento de fatura é transferência: se contasse, todo teto de cartão estouraria duas vezes.

**Lançamento de cartão entra pela base `data_parcela`, sempre**, independentemente da preferência de base temporal do relatório (ADR 0007). Um teto cujo realizado muda porque o Usuario mexeu num seletor de relatório é um teto que não serve para nada — e faria os alertas dispararem e desdispararem sem que nada de financeiro tivesse acontecido.

### Hierarquia de escopos

Os escopos formam três níveis: **global → categoria-raiz → subcategoria**. `categoria_id` nulo é o nível global; o sinal do `valor` define a abrangência, já que não há Categoria para consultar — negativo cobre toda a despesa do mês, positivo cobre toda a receita.

Um Planejamento de nível superior agrega o realizado de tudo abaixo dele. Se existirem dois níveis no mesmo caminho, o inferior é um **sub-teto** e o mesmo lançamento conta nos dois — isso é legítimo e é o que o usuário quer ao dizer "R$ 3.000 no mês, dos quais no máximo R$ 600 em restaurante".

A contagem dupla só apareceria no agregado, e uma regra a resolve nos três níveis:

> O **total planejado do mês** soma, em cada caminho da hierarquia, apenas o Planejamento de **nível mais alto** que existir naquela competência.

Existindo um global, ele é o total e os demais são sub-tetos. Não existindo, somam-se as raízes — e, nas raízes sem Planejamento, as subcategorias que tiverem. A regra é a mesma que já valia para pai e filha; o global é só mais um nível acima.

**A regra é enunciada duas vezes, uma por natureza.** Teto e piso são caminhos disjuntos: existe um total planejado de despesa e um total planejado de receita, e eles nunca se somam. Um teto global de R$ 3.000,00 e um piso global de R$ 5.000,00 somados dariam `+R$ 2.000,00`, um número que não significa nada e que a tela exibiria se ninguém escrevesse isto.

### O realizado global é apurado por natureza, nunca pela soma líquida

Este foi o furo da primeira emenda. Ela disse que o sinal define a abrangência do escopo global e não disse **como o realizado global é apurado** — e a leitura literal, "sem `if`", é a soma líquida de tudo no mês. Com ela, o teto global é **impossível de estourar para qualquer usuário com superávit**, que é a maioria de quem define um teto:

```
despesas −1.000.000 · salário +2.000.000
realizado = +1.000.000 >= −300.000  →  dentro do plano, com R$ 10.000 gastos sob teto de R$ 3.000
```

A regra correta: **o realizado de um Planejamento soma os Lancamentos cuja `Categoria.natureza` é igual à natureza do Planejamento.** Um teto agrega despesa; um piso agrega receita.

Por **natureza da Categoria**, e não pelo sinal do lançamento — a distinção é o que salva dois casos:

- Um **estorno de salário** é um lançamento negativo numa categoria de receita. Pelo sinal, consumiria teto de despesa e o estouraria com R$ 2.500,00 de gasto real. Pela natureza, reduz corretamente a receita realizada e não toca o teto.
- Um **estorno de compra** é positivo numa categoria de despesa e reduz o consumo do teto, que é o comportamento certo.

Isso exige que a natureza esteja sempre disponível, e é por isso que **`Lancamento.categoria_id` passa a ser obrigatório** fora das pernas de transferência, com Categorias de sistema `Sem categoria` por natureza. Com `categoria_id` nulo permitido, R$ 5.000,00 de despesas sem categoria não consumiriam teto nenhum e sumiriam de todo planejamento, em silêncio.

E exige a `Categoria.analitica`: **`Ajuste de saldo` não consome teto.** Ajustar saldo é correção de registro, não fato econômico; sem isso um ajuste de −R$ 300,00 vira R$ 300,00 de despesa e come o teto global.

### Identidade, e por que a cópia quebrava com escopo global

A identidade de um Planejamento é **`(tenant_id, competencia, natureza, categoria_id)`**, com `categoria_id` nulo sendo um valor legítimo e único da chave. Dela decorrem o índice e a verificação de existência da cópia — e ambos precisam de tratamento explícito de `NULL`, que é custo de engenharia, não de modelagem:

- `NULL` não colide em índice único no Postgres, então a constraint natural não impede dois globais. São necessários **dois índices únicos parciais** sobre `(tenant_id, competencia)`: `WHERE categoria_id IS NULL AND valor < 0` e `WHERE categoria_id IS NULL AND valor > 0`.
- `NULL = NULL` avalia para `NULL`, nunca para `TRUE`. A verificação de existência da cópia escrita como `categoria_id = origem.categoria_id` **não encontra** o global existente, tenta inseri-lo, é barrada pelo índice parcial e **aborta a transação inteira** — levando junto as categorias que já tinham sido copiadas, e violando a idempotência com um erro de banco na cara do Usuario. A comparação é `IS NOT DISTINCT FROM`, sobre a identidade inteira.

### Copiar do mês anterior

`copiarPlanejamento(competencia_origem, competencia_destino)`.

- **Idempotente.** Duas execuções, o mesmo conjunto — inclusive com Planejamento global na origem, pela comparação por identidade acima.
- **Não destrutiva.** Só cria onde a identidade **não existe** no destino. Nunca sobrescreve valor que o Usuario editou — mesma disciplina da regra 15 do `CLAUDE.md`.
- **Ignora categorias com `arquivada_em` preenchido** no momento da cópia. Arquivar uma categoria não deve ressuscitá-la todo mês.
- **Copia o valor literalmente.** Sem correção monetária, sem projeção, sem inflação. O produto não adivinha.

### Uma tela só

Uma tela **Planejamento**, item de primeiro nível, com tetos e pisos lado a lado — corrigindo a fraqueza 8.5.1 do teardown sem custo, porque no nosso modelo já são a mesma coisa.

### Invariantes

Escritas para virar teste direto:

1. `dentro_do_plano ⟺ realizado >= valor`, para teto e piso, sem ramificação por natureza. *(property-based)*
2. `consumo_bp = razaoEmBp(realizado, valor)`, inteiro com sinal, truncado em direção a zero. **Pode ser negativo** — a redação anterior, "positivo em ambos os casos", era falsa e o glossário a repetia como incondicional.
2b. `atingiu(pct) ⟺ consumo_bp >= pct × 100`, em aritmética inteira sobre `consumo_bp`, jamais sobre o percentual formatado e **jamais** multiplicando por `valor`. *(regressão do contraexemplo Q: teto de R$ 500, gasto de R$ 300, o alerta de 80% não dispara)*
2c. O percentual exibido é `consumo_bp / 100`, truncado. O número mostrado e o número que dispara o alerta são o mesmo. *(regressão do contraexemplo R)*
2d. `consumo_bp = 10000` exatamente ⟹ estado `no_limite`, nem `dentro` nem `estourado`.
3. `valor ≠ 0`. Planejamento de zero é ausência de planejamento — que se expressa apagando o registro.
4. Com `categoria_id` preenchido, `sinal(valor)` concorda com `Categoria.natureza`: despesa ⟹ negativo, receita ⟹ positivo. Discordância é rejeição na construção, não warning. Com `categoria_id` nulo não há o que conferir — o sinal define o escopo.
5. `valor.moeda` = moeda base do Tenant.
6. No máximo um Planejamento por `(tenant_id, categoria_id, competencia)` com `deleted_at IS NULL`. Constraint no banco, não só no código.
6b. No máximo um Planejamento global de cada natureza por `(tenant_id, competencia)`. Dois índices únicos parciais — a constraint natural não pega, porque `NULL` não colide.
7. `competencia` tem `dia = 1`.
8. Nenhuma `Transferencia` e nenhuma Categoria não analítica entram em nenhum realizado.
8b. O realizado de um Planejamento soma apenas Lancamentos cuja `Categoria.natureza` iguala a natureza do Planejamento. **Nunca a soma líquida.** *(regressão dos contraexemplos T, U e V)*
8c. Com um teto global de R$ 3.000, R$ 10.000 de despesa e R$ 20.000 de receita no mês, o teto está **estourado**. *(o caso que a redação anterior dava como dentro do plano)*
9. O realizado de cartão usa `data_parcela` e é **invariante** à preferência de base temporal do Tenant.
10. `copiar` é idempotente: `copiar(a,b); copiar(a,b)` = `copiar(a,b)`, **com e sem Planejamento global na origem**. A segunda execução não lança, não cria e não aborta. *(regressão do contraexemplo W)*
11. `copiar` nunca altera um Planejamento pré-existente no destino.
12. Total planejado do mês nunca soma dois Planejamentos do mesmo caminho: nunca global com raiz, nunca raiz com subcategoria.
13. Com um teto global e N tetos de categoria na mesma competência, o total planejado é **exatamente** o valor do global — invariante de regressão contra a contagem dupla. *(property-based)*
14. Total planejado é apurado por natureza. Teto global e piso global nunca entram na mesma soma. *(regressão do contraexemplo X)*
15. Todo `Lancamento` que entra num realizado tem Categoria. Não há caminho pelo qual uma despesa escape de todo planejamento por falta de categoria.

### Cenários de borda que a suíte precisa cobrir

- **Virada de mês com fuso.** Despesa às 23h30 de 31/jan em São Paulo (02h30 UTC de 01/fev) conta em **janeiro**. Conversão para `America/Sao_Paulo` antes de extrair a competência, sempre.
- **Mês curto.** Teto de fevereiro é o mesmo objeto de janeiro; nada é pró-rata por número de dias. O planejamento é mensal, não diário.
- **Ano bissexto.** 29/fev tem competência fevereiro. Nada de especial — e o teste existe para provar que nada de especial acontece.
- **Copiar para mês que já tem edições.** Origem com 10 categorias, destino com 3 já editadas → cria 7, preserva as 3 intactas.
- **Copiar duas vezes.** Segundo `copiar` não cria nada e não altera nada.
- **Copiar com categoria arquivada.** Categoria arquivada em março → cópia de março para abril a ignora. O Planejamento de março continua existindo e continua aparecendo no relatório de março.
- **Categoria arquivada com Planejamento futuro já criado.** Permanece. Arquivar não apaga o que já foi planejado; só impede novos.
- **Parcelada cruzando meses.** Compra em 12x em jul, teto mensal na categoria → cada mês recebe uma parcela, nenhum mês recebe o total. Se o Usuario alternar o relatório para `data_compra`, o relatório muda e **o Planejamento não**.
- **Pagamento de fatura.** Transferencia conta→cartão em mês com teto na categoria do cartão → realizado inalterado.
- **Estorno parcial.** Estorno é lançamento de sinal oposto na mesma categoria e competência → reduz o realizado; o alerta de 100% pode voltar para 80%. O evento de limiar é emitido na travessia, em qualquer direção.
- **Lançamento retroativo.** Despesa de agosto lançada em outubro entra no realizado de **agosto** e pode fazer um teto de agosto estourar depois do fato. É o comportamento correto: o relatório do passado muda quando o passado muda.
- **Piso não atingido no fim do mês.** Nada acontece automaticamente. Planejamento não gera lançamento, nunca.
- **Teto global com tetos de categoria.** Global de R$ 3.000 mais tetos de R$ 600, R$ 400 e R$ 300 → total planejado = R$ 3.000, não R$ 4.300 nem R$ 1.300. Os três continuam alertando por conta própria.
- **Teto global sem nenhum teto de categoria.** Total planejado = o global; realizado = toda a despesa do mês, exceto Transferencia.
- **Copiar mês com global, duas vezes.** A segunda execução é um no-op silencioso. Escrita com `=` em vez de `IS NOT DISTINCT FROM`, ela aborta a transação e desfaz também as categorias copiadas na primeira.
- **Teto global com superávit.** R$ 10.000 de despesa, R$ 20.000 de receita, teto global de R$ 3.000 → **estourado**, consumo 333%.
- **Estorno de salário sob teto global.** R$ 2.500 gastos e um estorno de salário de −R$ 800 numa categoria de receita → teto de R$ 3.000 **não** estourado. Pela partição por sinal, estaria.
- **Despesa sem categoria escolhida.** Vai para `Sem categoria (despesa)` e **consome** o teto global. Não existe despesa invisível ao planejamento.
- **Ajuste de saldo de −R$ 300.** Não consome teto nenhum, não entra em relatório de gasto.
- **Alerta a 60% de consumo.** Teto de R$ 500, R$ 300 gastos, limiar de 80% → **não dispara**. É o contraexemplo Q e é a regressão mais importante desta emenda.
- **Um centavo no limiar.** Teto de R$ 500, realizado de −R$ 399,99 → `consumo_bp = 7999`, tela mostra 79,99%, alerta de 80% não dispara. Em −R$ 400,00 → 8000 bp, dispara.
- **Consumo negativo.** Teto de R$ 500 cuja única movimentação do mês é um estorno de +R$ 80 → −1600 bp. `dentro_do_plano` verdadeiro, barra exibida como 0%, nenhum alerta.
- **Gasto exatamente igual ao teto.** `consumo_bp = 10000`, estado `no_limite`.

## Consequências

**Positivas.** Um CRUD, um motor de alerta, uma operação de cópia, uma tela — e por consequência um único lugar onde o bug de virada de mês pode existir. A comparação sem `if` sobre natureza elimina a classe inteira de bug em que alguém inverte o sentido do teste para um dos lados; a convenção de sinal do ADR 0005 paga dividendo de novo aqui. Não persistir `natureza` torna irrepresentável um teto com valor positivo. A constraint única por `(tenant, categoria, competencia)` impede no banco a duplicação que faria o total planejado mentir. E a inconsistência de navegação do Organizze não pode se repetir aqui, porque não há duas coisas para colocar em dois lugares.

**Negativas.** Sinal negativo em teto é contraintuitivo na leitura crua da tabela: um teto de R$ 500 aparece como `-50000`, e quem consultar o banco sem saber a convenção vai se assustar. A UI precisa traduzir em toda entrada e toda exibição, e um bug de tradução na borda é possível — o preço de manter a aritmética limpa no centro. Escopo fixo em categoria × mês fecha, por ora, planejamento por Etiqueta, por Conta e por período livre. Travar o Planejamento na base `data_parcela` significa que a tela de Planejamento e o relatório de categorias podem exibir números diferentes para o mesmo mês quando o Usuario escolhe outra base — divergência real, que a UI precisa explicar em vez de esconder.

## Alternativas rejeitadas

**Manter teto de gasto e piso de receita separados, como o Organizze.** Espelha o vocabulário que o usuário já conhece de outros produtos. Rejeitado: duplica CRUD, alerta e cópia, e é justamente a duplicação que produziu a inconsistência de navegação observada no teardown. Vocabulário de UI pode continuar dizendo "limite" e "meta do mês" — o modelo não precisa.

**`natureza` como enum persistido, ao lado de `valor` positivo.** Mais legível no banco e dispensa a tradução de sinal na UI. Rejeitado: permite `natureza = teto` com `valor` positivo. Duas fontes para o mesmo fato divergem, e a comparação volta a precisar de `if` — que é onde o sentido se inverte.

**Planejamento perpétuo: um valor válido até ser alterado.** Menos registros, sem operação de cópia. Rejeitado: destrói a história. Depois de editar o teto em junho, "quanto eu tinha planejado em março?" fica sem resposta — e o valor planejado do passado é dado de auditoria, não configuração. É também o motivo pelo qual o próprio Organizze precisou de "copiar os últimos definidos".

**Escopo sem teto global, apenas por categoria.** Foi a redação original deste ADR, por receio de contagem dupla entre o global e os tetos de categoria. **Revertido na emenda:** a regra de precedência que já resolvia pai contra filha resolve global contra raiz sem nenhuma alteração — o global é apenas mais um nível. Manter a restrição custaria uma funcionalidade útil em troca de um problema que não existia.

**Escopo por Etiqueta ou por Conta.** Rejeitado: expande o produto cartesiano de escopos sem evidência de demanda. A Categoria é a dimensão em que o usuário pensa quando planeja.

**Cópia sobrescrevendo o destino.** Mais previsível de descrever ("o destino fica igual à origem"). Rejeitado: apaga edição deliberada do Usuario sem aviso. Dado que o Usuario digitou não é sobrescrito por operação em lote — a mesma regra que vale na conciliação de importação.
