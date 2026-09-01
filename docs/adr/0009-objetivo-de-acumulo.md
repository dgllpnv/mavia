# ADR 0009 — `Objetivo`: acúmulo plurimensal, separado do planejamento mensal

- **Status:** Aceita
- **Data:** 2026-09-01
- **Emendas:** 2026-09-01 — após a auditoria financeira do spec (bloqueio B20, ressalva R8): `saldo_base` passa a ser reajustado por lançamento retroativo **anterior** à criação do Objetivo, e a travessia de `concluido_em` passa a ser avaliada na transação que altera o progresso, não na leitura.

## Contexto

Este ADR existe porque um erro quase apagou um conceito do produto, e o registro do erro vale tanto quanto a decisão.

O `CONTEXT.md` original definia:

> **Meta** — Objetivo de acúmulo com valor-alvo e prazo, associado a uma Conta ou virtual. Distinta de Limite: Limite restringe saída, Meta persegue entrada.

O teardown do Organizze (seção 6) mostrou que "Limite de gastos" e "Metas de receitas" são a mesma tela espelhada, e o ADR 0008 as unificou em `Planejamento`. Correto — **para a meta de receita do Organizze**, que é um piso mensal por categoria.

Mas o `Meta` do nosso glossário não era isso. Era um acúmulo plurimensal com prazo: *"juntar R$ 12.000 até dezembro"*. Um nome, dois conceitos:

| | Piso mensal de receita | Acúmulo com prazo |
|---|---|---|
| Escopo | Categoria × competência | O objetivo em si |
| Horizonte | Um mês, recomeça no seguinte | Meses ou anos, contínuo |
| Progresso | Realizado do mês | Estoque acumulado |
| Fim | O mês acaba | O alvo é atingido, ou o prazo vence |
| Cópia | "copiar do mês anterior" | Não faz sentido |

O ADR 0008 absorveu o primeiro e apagou o segundo. O `product-financeiro` vetou. O veto procede: o produto teria perdido um conceito inteiro sem que ninguém tivesse decidido perdê-lo.

A causa raiz é de linguagem, não de modelagem. **`Meta` era um termo ambíguo, e um termo ambíguo vira dois bugs** — aqui virou a fusão indevida de duas entidades. É exatamente o risco que o glossário existe para conter, e ele passou porque a ambiguidade estava dentro da própria definição.

## Decisão

**Uma entidade nova, `Objetivo`. O termo `Meta` é aposentado e vai para a tabela de termos proibidos.**

Aposentar em vez de reaproveitar: "Meta" já significa duas coisas para quem lê e três para quem vem de outro app da categoria. Reutilizá-lo para um dos sentidos garante que o outro volte pela porta dos fundos na próxima sessão. `Planejamento` e `Objetivo` não colidem em nenhuma leitura.

### Modelo

| Campo | Papel |
|---|---|
| `tenant_id` | RLS |
| `nome` | Rótulo do Usuario. "Viagem", "Reserva" |
| `valor_alvo` | `Money`, **sempre positivo** |
| `prazo` | `DATE` em `America/Sao_Paulo`. **Opcional** |
| `conta_id` | Opcional. Define o modo de apuração |
| `saldo_base` | `Money` capturado na criação. Só no modo ancorado |
| `concluido_em` | Instante da primeira vez que o alvo foi atingido |
| `deleted_at` | Soft delete |

**Não tem `competencia`.** É o que o separa de `Planejamento`, e é a razão de ser uma entidade própria.

### `valor_alvo` é positivo, e isso não contradiz o ADR 0005

`Planejamento` codifica a direção no sinal, porque teto e piso são duas direções do mesmo mecanismo. `Objetivo` só tem uma direção: acumular.

A distinção que importa é outra: a convenção de sinal do ADR 0005 governa **movimentos** — despesa negativa, receita positiva. `valor_alvo` não é movimento, é **estoque-alvo**. Um saldo de destino não tem direção a codificar. Inventar um sinal para ele seria carregar uma convenção onde ela não significa nada.

### Prazo opcional

Sem `prazo`, o Objetivo nunca vence — acumula indefinidamente. É a reserva de emergência, que não tem data e não deveria ser forçada a inventar uma.

### Dois modos de apuração, derivados de `conta_id`

Não há enum de modo. `conta_id` preenchido ou nulo é a única fonte — pelo mesmo motivo que `Planejamento` não persiste `natureza`: um enum ao lado do dado pode contradizê-lo.

**Ancorado** (`conta_id` preenchido) — `progresso = saldo(conta) - saldo_base`.

A Conta de poupança é o objetivo. `saldo_base` é um `Money` **capturado e armazenado** na criação, com padrão igual ao saldo da Conta naquele instante e editável para zero se o Usuario quiser contar o que já tinha.

`saldo_base` **nunca é derivado de uma data**. Se fosse recalculado como "o saldo em tal dia", um lançamento retroativo mudaria o saldo do passado e o progresso mudaria sozinho, sem que nada tivesse sido aportado. É a mesma armadilha que o ADR 0005 evita ao proibir saldo como coluna mutável — mas invertida: aqui a segurança está em **armazenar** o valor, porque ele é um marco histórico, não um saldo.

**Reajuste por retroativo anterior à criação.** A versão original declarava `saldo_base` simplesmente imutável, e isso protegia contra o retroativo errado. Um Lancamento com `settled_at` **anterior** ao `criado_em` do Objetivo ajusta `saldo_base` pelo mesmo valor, de modo que o progresso fique inalterado.

Sem essa regra: em 01/set o Usuario cria "Viagem" sobre uma poupança com saldo conhecido de R$ 2.000,00; em 10/set importa o OFX de agosto e aparece um depósito de R$ 3.000,00 feito em **15/ago**. O saldo vai a R$ 5.000,00 e o progresso a R$ 3.000,00 — 30% de uma meta de R$ 10.000,00 sem que ele tenha guardado um centavo desde a criação. O dinheiro já estava lá quando o marco foi capturado; só não estava registrado. Pior com um alvo menor: `concluido_em` seria gravado **em definitivo**, pela regra de fixidez, por um depósito de agosto.

A distinção que o ADR precisava fazer é entre **saldo conhecido** e **saldo real**. `saldo_base` congela o conhecido; o reajuste o corrige para o real daquele instante quando o passado é completado. Retroativo **posterior** à criação continua movendo o progresso, que é o comportamento certo — o dinheiro entrou depois do marco.

**Por aportes** (`conta_id` nulo) — `progresso = Σ valor` dos Lancamentos ligados por `Aporte`.

O objetivo é virtual: o dinheiro está espalhado, e o Usuario marca o que conta. Um aporte típico é a perna positiva de uma `Transferencia` para a poupança. Um resgate é a perna negativa. **O sinal do domínio faz a soma funcionar nos dois casos sem nenhum `if`** — é o mesmo dividendo do ADR 0005 que o `Planejamento` já colhe.

Um Objetivo ancorado **não aceita Aporte**: seu progresso já é o saldo da Conta, e somar os dois contaria o mesmo dinheiro duas vezes.

### Estado é derivado

`concluido` se `concluido_em != null`; senão `vencido` se `prazo != null && prazo < hoje`; senão `ativo`. Nenhuma coluna de estado.

### Prazo vencido sem atingir o alvo: nada acontece

O Objetivo passa a `vencido`, sai da lista de ativos, é preservado intacto e o domínio emite `ObjetivoVencido`. Não exclui, não estende sozinho, não cobra, e **não gera `Lancamento`**.

Objetivo nunca move dinheiro. Ele observa dinheiro que se moveu. Um objetivo que criasse lançamento para "completar" o alvo inventaria patrimônio — a violação mais grave possível neste domínio.

O Usuario estende o prazo (edição normal, no audit log) ou arquiva. Um Objetivo vencido continua respondendo "quanto eu tinha juntado quando o prazo acabou", que é informação legítima.

### Conclusão é fixa contra progresso, móvel contra redefinição

`concluido_em` é gravado na primeira travessia de `progresso >= valor_alvo`.

**A travessia é avaliada na transação que altera o progresso.** Toda escrita que afete o saldo de uma Conta ancorada, ou o conjunto de Aportes de um Objetivo por aportes, reavalia os Objetivos afetados na mesma transação. Nunca na leitura da tela, nunca só por job noturno.

A versão original dizia "primeira vez que `progresso >= valor_alvo`" sem dizer **o que observa**, e `progresso` é derivado de um saldo derivado. Apurado na leitura, "primeira travessia" vira "primeira vez que alguém abriu a tela": um objetivo atingido em 10/set e resgatado em 15/out, aberto em 20/out, mostra R$ 7.000,00 de R$ 10.000,00 e `concluido_em` **nunca** é gravado. A regra que este ADR chama de "a única que precisa ser lida duas vezes" — resgate não desfaz a conclusão — jamais chegaria a ser exercida.

O caminho de importação em lote precisa da mesma reavaliação ao fim da transação de ingestão, pelo mesmo motivo pelo qual precisa do reajuste de `saldo_base`: é por ali que o passado muda.

- **Resgate posterior não desfaz.** Atingir foi um fato histórico com data. O progresso cai, o estado continua `concluido`.
- **Aumentar `valor_alvo` acima do progresso desfaz** — limpa `concluido_em`, volta a `ativo`.

A assimetria é deliberada e é a única regra deste ADR que precisa ser lida duas vezes: a fixidez protege o fato contra o **movimento do dinheiro**, não contra a **redefinição do alvo**. Quem eleva o alvo está dizendo que o objetivo é outro; quem saca está dizendo que gastou.

### Invariantes

Escritas para virar teste direto:

1. `valor_alvo > 0`.
2. Ancorado: `valor_alvo.moeda = conta.moeda`. Por aportes: `valor_alvo.moeda` = moeda base do Tenant, e todo Lancamento aportado tem essa moeda. Construção com moeda divergente é rejeitada — nunca convertida.
3. `prazo`, quando informado, é `>= hoje` **no momento da escrita**. Prazo que ficou no passado pela passagem do tempo produz `vencido`, não inválido: a validação é de escrita, nunca de leitura.
4. `saldo_base` existe se e somente se `conta_id` existe.
5. `saldo_base` só muda pelo reajuste de retroativo anterior à criação, sempre pelo valor do lançamento que o motivou, de modo que o progresso fique inalterado. Nenhum outro caminho o escreve.
5b. Importar um lançamento com `settled_at` anterior ao `criado_em` do Objetivo **não altera o progresso**. *(regressão dos contraexemplos Z e AA)*
5c. A travessia de `concluido_em` é avaliada na transação que altera o progresso. Um objetivo atingido e depois resgatado, sem nenhuma leitura de tela no intervalo, tem `concluido_em` gravado. *(regressão do contraexemplo AB)*
6. Ancorado não tem nenhum `Aporte`. Por aportes não tem `saldo_base`.
7. `progresso` não é limitado: pode passar do alvo e pode ficar negativo. O domínio devolve o número real; travar a barra em 100% é decisão de UI.
8. `concluido_em` é gravado na primeira travessia do alvo e não é desfeito por queda de progresso.
9. Aumentar `valor_alvo` acima do progresso limpa `concluido_em`. Reduzi-lo para valor já alcançado o grava imediatamente.
10. Um Objetivo ancorado não excluído **bloqueia** o soft delete da sua Conta.
11. Um Lancamento pertence a no máximo um Objetivo.
12. Vincular ou desvincular um `Aporte` nunca altera `valor`, Categoria ou `status` do Lancamento.
13. `Objetivo` nunca cria, altera ou exclui `Lancamento`. *(teste de arquitetura, não de comportamento)*
14. `Aporte` não altera nenhum realizado de `Planejamento`. As duas leituras são independentes.

### Cenários de borda que a suíte precisa cobrir

- **Prazo no passado na criação.** Rejeitado. Editar um objetivo existente para um prazo passado: também rejeitado.
- **Prazo vence hoje.** `prazo < hoje` é falso — ainda `ativo`. O último dia conta, e o dia é apurado em `America/Sao_Paulo`, não em UTC.
- **Alvo alterado com progresso existente.** R$ 12.000 com R$ 8.000 juntos: baixar para R$ 7.000 conclui na hora; subir para R$ 20.000 mantém `ativo`.
- **Alvo baixado depois de concluído e subido de novo.** Concluído com R$ 8.000 de R$ 7.000; subir para R$ 20.000 limpa `concluido_em`; baixar para R$ 6.000 grava um `concluido_em` **novo**, com a data de agora, não a original.
- **Resgate depois de concluído.** R$ 12.000 atingidos, saque de R$ 5.000: progresso vira R$ 7.000, estado continua `concluido`, `concluido_em` intacto.
- **Progresso maior que o alvo.** R$ 15.000 de R$ 12.000 = 125%. O domínio devolve 125%.
- **Progresso negativo.** Objetivo por aportes com um resgate maior que os aportes → progresso negativo. Permitido, exibido como 0% na barra e como o número real no detalhe.
- **Conta associada sendo excluída.** Soft delete bloqueado enquanto o Objetivo ancorado existir. A mensagem nomeia o Objetivo.
- **Retroativo posterior à criação.** Um aporte de 10/set importado em 20/set, num Objetivo criado em 01/set: o progresso sobe. Correto — o dinheiro entrou depois do marco.
- **Retroativo anterior à criação.** Um depósito de 15/ago importado em 10/set, num Objetivo criado em 01/set: saldo sobe R$ 3.000,00, `saldo_base` sobe R$ 3.000,00, **progresso não muda**.
- **Estorno anterior à criação.** Estorno de uma despesa de julho importado em setembro: mesmo tratamento, progresso inalterado. Sem isso, um alvo baixo seria concluído em definitivo por um estorno de julho.
- **Objetivo em moeda diferente da Conta.** Impossível: a invariante de `Conta` já obriga toda conta do Tenant à moeda base. A checagem na construção permanece como segunda camada.
- **Moeda divergente.** Objetivo em USD sobre Conta em BRL: rejeitado na construção. Trocar a moeda da Conta depois já é impedido pela invariante da própria `Conta`.
- **Objetivo ancorado numa Conta com `incluir_no_saldo_geral = false`.** Funciona normalmente — é o caso comum, a conta de investimento fora do saldo geral. As duas noções são ortogonais.
- **Aporte numa perna de Transferencia.** A perna positiva soma ao progresso; a Transferencia continua não aparecendo em relatório de gastos nem em `Planejamento`. Nenhuma das duas leituras contamina a outra.
- **Dois objetivos ancorados na mesma Conta.** Permitido — ambos leem o mesmo saldo com `saldo_base` distintos. Somá-los não significa nada, e o produto não os soma.

## Consequências

**Positivas.** O conceito de acúmulo volta ao modelo, agora com apuração de progresso escrita em vez de suposta. Aposentar `Meta` fecha a ambiguidade na fonte: nenhuma sessão futura pode refundir as duas entidades, porque não sobrou nome comum entre elas. Os dois modos derivados de `conta_id` cobrem os dois casos reais — a poupança dedicada e o objetivo virtual — sem enum que possa contradizer o dado. E `Objetivo` não gera lançamento, o que o mantém fora do caminho crítico do dinheiro: um bug aqui erra um percentual numa barra, nunca um saldo.

**Negativas.** É uma entidade a mais para manter, com tela própria, e a fronteira contra `Planejamento` vai precisar ser explicada ao usuário mais de uma vez — "meta" é a palavra que ele usa para as duas coisas. Os dois modos de apuração são dois caminhos de código e dois conjuntos de teste. A assimetria de `concluido_em` (fixa contra resgate, móvel contra aumento de alvo) é a regra menos intuitiva do domínio até hoje e vai ser questionada; existe este ADR para respondê-la. E bloquear a exclusão de Conta por causa de um Objetivo é um atrito real numa operação que o Usuario espera que simplesmente funcione.

## Alternativas rejeitadas

**Não reintroduzir nada, deixar `Planejamento` cobrir tudo.** O estado em que este ADR nasceu. Rejeitado: um piso mensal por categoria não responde "quanto falta para os R$ 12.000 de dezembro", e forçar a resposta exigiria somar doze competências e torcer para que o usuário nunca tenha resgatado nada.

**Reaproveitar o nome `Meta` para a entidade de acúmulo.** Continuidade de vocabulário, menos ruído para quem já leu o glossário. Rejeitado: o termo já demonstrou, neste próprio projeto, que carrega dois sentidos — e o segundo volta na primeira sessão que ler "meta" pensando em receita mensal. Termo que já causou um erro não é reabilitado.

**`Objetivo` como um `Planejamento` de escopo plurimensal, com `competencia_inicio` e `competencia_fim`.** Uma entidade só, menos código. Rejeitado: `Planejamento` compara realizado de um mês contra um valor; `Objetivo` compara um estoque acumulado contra um alvo. São aritméticas diferentes, ciclos de vida diferentes e a operação "copiar do mês anterior" não faz sentido num deles. Unificar produziria uma entidade com metade dos campos nulos em cada uso — que é a forma que a fusão indevida assume quando insiste.

**Progresso como coluna materializada em `Objetivo`.** Leitura instantânea. Rejeitado pela regra 5 do `CLAUDE.md`: progresso é saldo, saldo é derivado, e coluna mutável diverge sob concorrência sem que ninguém perceba. Se houver problema de desempenho, a saída é o mesmo caminho do `SaldoSnapshot`, com reconciliação — não uma coluna solta.

**`saldo_base` derivado da data de criação, em vez de armazenado.** Um campo a menos. Rejeitado: lançamento retroativo reescreve o saldo do passado, e o progresso passaria a mudar sozinho sem nenhum aporte. O marco histórico precisa ser armazenado justamente porque o passado, neste sistema, é editável.

**`saldo_base` estritamente imutável, sem reajuste.** Era a redação original. Rejeitado: protegia contra o retroativo *posterior*, que não precisava de proteção, e deixava passar o *anterior*, que é o que corrompe o progresso — importar em setembro um depósito de agosto dava 30% de progresso sem nenhum aporte. A alternativa era redefinir progresso como "variação do saldo conhecido", que é o que a fórmula media mas não o que a palavra significa. Preferimos corrigir a fórmula a redefinir a palavra.

**Congelar o progresso num campo quando a Conta é excluída, em vez de bloquear a exclusão.** Mais permissivo. Rejeitado: exige um campo que existe apenas nesse estado excepcional e cria um segundo significado para "progresso" — derivado às vezes, armazenado outras. Bloquear é uma regra, não um estado.

**Objetivo gerando `Lancamento` de aporte automático.** É o que alguns apps da categoria fazem ("guarde R$ 500 todo dia 5"). Rejeitado aqui: isso é `Recorrencia`, que já existe e já resolve. Objetivo observa; recorrência move. Fundir os dois faria uma entidade de leitura criar patrimônio.
