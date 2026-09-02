# CONTEXT — Linguagem ubíqua da Mavia

Este é o glossário do domínio. **Nome no código = nome no banco = nome na UI = nome aqui.** Se um termo não está aqui, ele não existe no projeto ainda — adicione-o antes de usá-lo.

Mantido pelo `arquiteto-dominio-financeiro` via `/domain-modeling`.

**Convenção de nomes de campo.** Conceito de domínio em português (`Lancamento`, `Fatura`, `natureza`, `competencia`). Os campos temporais fixados pelas regras inegociáveis do `CLAUDE.md` permanecem em inglês (`posted_at`, `settled_at`, `closing_day`, `due_day`, `deleted_at`, `*_group_id`) — renomeá-los seria re-litigar regra aceita. Campo novo nasce em português.

**Invariantes.** Cada entidade declara as suas. Elas são escritas para virar teste direto — se uma invariante não pode ser expressa como asserção, ela está mal escrita.

---

## Núcleo monetário

**Money** — Value object. Inteiro de centavos (`bigint`) + moeda ISO 4217. Imutável. Toda aritmética monetária passa por ele. Operações entre moedas distintas lançam erro. _Nunca_ use `number` para dinheiro.

**Rateio (`ratear`)** — Divisão de uma `Money` em N partes cuja soma é exatamente igual ao total. O resto em centavos é distribuído **uma unidade por parte, nas primeiras partes**. Regra única do sistema: vale para parcelamento e para divisão de despesa. Base de `GrupoDeParcelamento`.

> **Invariantes**
> - `Σ partes = total`, exatamente, para qualquer total e qualquer N.
> - `max(partes) − min(partes) <= 1`. **É esta invariante, e não a da soma, que distingue a regra escolhida de "todo o resto na primeira parte"** — as duas somam certo, e divergem em R$ 0,03 já em R$ 100,00 / 7.
> - As partes são não-crescentes: `parte[i] >= parte[j]` para `i < j`.
> - `ratear(−v, n) = map(negar, ratear(v, n))`. O rateio opera sobre a magnitude e reaplica o sinal; sem isso, o truncamento de negativos produz uma distribuição diferente que também soma certo.
> - `ratear` **pode** produzir partes de valor zero quando `|total| < n`. Isso é válido para o value object e **proibido** para `GrupoDeParcelamento`, que rejeita esse caso — a restrição é da entidade, não da aritmética.

**Razão em basis points (`razaoEmBp`)** — `(a, b: Money) → bigint`, com `a` e `b` na mesma moeda e `b ≠ 0`: `(a.centavos * 10000) / b.centavos`, truncado **em direção a zero**. Única grandeza fracionária do domínio, e é inteira: 10000 bp = 100,00%. Preserva sinal. `Money` não tem divisão que devolva `Money`.

**Sinal** — Convenção do domínio: **despesa é negativa, receita é positiva**. O sinal vive no valor, não num campo de tipo separado. Somar uma lista de lançamentos dá o resultado líquido sem nenhum `if`.

---

## Tempo e competência

**Competencia** — O mês de calendário ao qual um número é atribuído, em `America/Sao_Paulo`. Representada como `DATE` fixada no dia 1. É a unidade de agregação de todo relatório e de todo `Planejamento`.

> **Invariantes**
> - `competencia` sempre tem `dia = 1`.
> - A competência de um instante é calculada convertendo o instante para `America/Sao_Paulo` **antes** de extrair mês e ano. Nunca a partir do UTC nu.
> - O domínio nunca usa offset fixo (`-03:00`). Sempre a zona IANA — o Brasil já teve horário de verão e pode voltar a ter.

**Janela** — Todo intervalo de tempo do domínio é **semiaberto, `[inicio, fim)`**, expresso em instantes UTC, com as bordas calculadas em `America/Sao_Paulo`. Uma convenção só, sem exceção — inclusive a janela da fatura. Janelas consecutivas satisfazem `fim(k) = inicio(k+1)` exatamente, o que torna contiguidade e disjunção verificáveis por igualdade em vez de por "o instante seguinte".

> **Invariantes**
> - Nenhuma comparação de janela usa `DATE`. `DATE` não representa instante, e a coerção `DATE → TIMESTAMPTZ` depende do fuso da sessão que escreve.
> - Dois períodos comparados entre si usam a mesma regra de fronteira e a mesma `BaseTemporal` nos dois lados. Comparação com fronteiras ou bases distintas produz variação inventada.

**Ancoragem de dia do mês** — Regra única para avançar uma data mês a mês quando o dia âncora não existe no mês de destino: `min(dia_ancora, ultimo_dia_do_mes)`, **sempre calculado a partir do dia âncora original**, nunca do mês anterior. O ajuste **não é arrastado**: âncora 31 produz 31/jan, 28/fev, **31**/mar.

Quatro entidades a usam e nenhuma pode divergir: `Cartao` (`closing_day`, `due_day`), `GrupoDeParcelamento` (as N parcelas), `Recorrencia` (`dia_do_mes`) e `Assinatura` (o período anual e a contagem de `meses_iniciados` do reembolso). Está nomeada aqui porque estava sendo reescrita em cada uma — e uma regra reescrita quatro vezes diverge na quinta.

> **Invariantes**
> - Nunca pula um mês por falta do dia. Pular faz a competência perder o evento.
> - Nunca transborda para o mês seguinte. Transbordar dá duas ocorrências ao mês seguinte.
> - Aplicada em `America/Sao_Paulo`, antes de qualquer conversão para instante.

**Data civil** — Campo que nomeia um **dia**, não um instante: `Fatura.data_fechamento`, `Fatura.data_vencimento`, `Objetivo.prazo`, `Planejamento.competencia`. Sempre interpretado em `America/Sao_Paulo`. Nomeado com prefixo `data_`/`prazo`/`competencia` justamente para não ser confundido com instante e coagido por engano — os instantes são `posted_at`, `settled_at`, `periodo_inicio`, `periodo_fim`.

**posted_at** — Instante. Competência do `Lancamento`: quando o fato econômico aconteceu. É o campo que decide em qual `Fatura` uma compra de cartão cai e em qual competência ela aparece no relatório. Imutável depois de criado.

**settled_at** — Instante. Compensação: quando o dinheiro **de fato** saiu ou entrou do caixa. Nulo enquanto não aconteceu. Em `Lancamento` de `Conta`, é escrito quando o lançamento compensa. Em `Lancamento` de `Cartao`, é escrito quando a `Fatura` que o contém é **paga** — nunca antes, e nunca com a data de vencimento. Ver ADR 0007.

> Este campo se chamava `effective_at`. O nome foi **aposentado**: "efetivação" é lido como *fato* por metade dos leitores e como *previsão* pela outra metade, e a ambiguidade produziu dois modelos de dados incompatíveis entre dois arquitetos trabalhando em paralelo. `settled_at` — compensação, liquidação — só tem uma leitura.

**Realizado depende do eixo.** A palavra tem significados diferentes nos dois eixos, e aplicar a definição de um ao outro produz uma tela em que três números não fecham:

> - No eixo **competência**, realizado é o que **aconteceu**: `settled_at` presente **ou** `posted_at` já passado.
> - No eixo **caixa**, realizado é o que **se moveu**: `settled_at` presente, e nada mais.

> **Invariantes**
> - Toda agregação nomeia o eixo. Não há padrão implícito — escolher o eixo é de quem pergunta.
> - **`agora` é entrada da consulta, não o relógio lido dentro dela.** O instante que separa realizado de previsto é parâmetro do recorte, fixado uma vez pelo servidor e ecoado na resposta. Duas respostas comparadas entre si — a listagem e o resumo, uma página e a seguinte — usam **o mesmo `agora`**; sem isso, um lançamento cuja competência cruza o instante da leitura aparece em dois baldes ao mesmo tempo, sem nenhuma escrita entre as duas requisições, e a igualdade "soma das páginas = resumo" deixa de ser bem definida. O transporte desse instante entre requisições é decisão de arquitetura; que ele seja entrada é decisão de domínio.
> - Dentro de um eixo, a identidade fecha: `saldo anterior + Σ baldes = saldo`. Ela **decorre** da exaustividade da partição de `Balde`, e é a exaustividade que se testa.
> - Os dois eixos **nunca** aparecem na mesma linha de resposta. Uma despesa pendente é *realizada* na competência e *prevista* no caixa, e as duas leituras estão certas — no eixo delas.
>
> Encontrado pelo `validador-financeiro` (bateria do épico 2, cenário RP-4) depois de o código já estar escrito: uma despesa pendente de R$ 100,00 entrava em `despesa_realizada` e não no `saldo`, e o rodapé exibia `1.000 + (−100) = 1.000`.

**Eixo caixa** — Como se responde "quanto há, e quanto haverá, na conta". Soma **duas** coisas, e nenhuma delas é lançamento de cartão:

1. Lancamentos de `Conta`, por `settled_at` (realizado) ou por `posted_at` (agendados ainda não compensados).
2. `Fatura`s não pagas, pelo seu **total**, na `data_vencimento`, debitando a Conta de pagamento.

Uma compra de cartão **não sai do bolso** — quem sai é a fatura. Projetar por lançamento de cartão exigiria roteá-lo até uma Conta pelo cartão, seria mais caro e estaria errado quando a fatura fosse paga por outra conta. A `Fatura` é a unidade certa: é uma linha por ciclo em vez de N, e é o que o Usuario de fato paga.

> **Invariantes**
> - Nenhum `Lancamento` de `Cartao` entra no eixo caixa, em nenhuma circunstância.
> - Uma `Fatura` entra na projeção **enquanto não estiver `paga`**. Depois de paga, quem representa a saída é a perna de débito da `Transferencia`, na Conta. Nunca as duas — é aqui que a dupla contagem entraria.
> - O eixo caixa e o eixo competência nunca se misturam na mesma resposta, e o eixo usado aparece no payload.

**Vencimento previsto** — Quando uma `Fatura` deve virar desembolso: a própria `Fatura.data_vencimento`. É propriedade da Fatura, **jamais coluna de `Lancamento`**. Copiá-la para a linha a transformaria numa compensação que não aconteceu — foi exatamente o defeito que fez toda compra de cartão nascer `efetivada`.

**Base temporal (BaseTemporal)** — Qual das referências de tempo de um lançamento de cartão o relatório usa para atribuí-lo a uma competência: `data_compra`, `data_parcela` (padrão) ou `data_fatura`. Só afeta lançamentos de `Cartao`. Ver ADR 0007.

**Ciclo de faturamento** — A regra recorrente de um `Cartao`: `closing_day` e `due_day`. Gera as janelas. Não é uma entidade — é a configuração que as produz.

**Janela da Fatura** — O intervalo concreto de uma `Fatura`: `[periodo_inicio, periodo_fim)`, em `TIMESTAMPTZ`, onde `periodo_fim` é **00h00 de `America/Sao_Paulo` do dia seguinte ao `closing_day`**. Isso mantém a decisão do ADR 0007 — uma compra **no dia exato do fechamento**, a qualquer hora, entra na fatura que fecha naquele dia — usando a convenção semiaberta única do domínio. Ver ADR 0007.

---

## Entidades

**Tenant** — Unidade de isolamento. Uma assinatura, um espaço de dados. Toda tabela de negócio referencia `tenant_id`, protegida por Row-Level Security. Um Tenant pode ter vários Usuários.

**Usuario** — Pessoa autenticada. Pertence a um ou mais Tenants com um Papel.

**Papel** — `proprietario` (tudo, inclusive billing), `membro` (lança e consulta), `visualizador` (só leitura). Base do compartilhamento familiar. **Papel concede permissão; `Plano` concede capacidade.** São eixos independentes: um `visualizador` num plano `Negocio` continua sem poder lançar. `Plano`, `Cota` e `Assinatura` vivem na seção **Assinatura e cobrança**.

**Origem** — Procedência do dado de uma `Conta` ou de um `Cartao`: `manual` (o Usuario mantém) ou `conectado` (um adapter do `BankSyncProvider` mantém). **Não é uma classe de conta** — é de onde vêm os lançamentos. Uma conta `conectado` não aceita edição destrutiva de lançamentos importados; ver `Conciliacao`.

**Conta** — Onde o dinheiro repousa. Tem saldo inicial, moeda, `tipo`, `origem` e `incluir_no_saldo_geral`. **Não** inclui cartão de crédito.

- `tipo` — `corrente`, `poupanca`, `dinheiro`, `investimento`, `digital`, `outra`. **Mantemos o tipo**, contra o modelo do Organizze, que só tem nome e ícone. Motivo: sem tipo é impossível separar *dinheiro disponível* de *patrimônio investido* no relatório, e uma conta de investimento inflando o número principal do produto faz o número mentir. O tipo é **rótulo de relatório e ícone padrão** — nunca entra em aritmética, nunca infere sinal, nunca decide sozinho o que soma no saldo geral.
- `incluir_no_saldo_geral` — Booleano. Decide se a conta entra no **Saldo geral**. É escolha do Usuario; o `tipo` apenas define o valor **inicial** (`investimento` nasce `false`, todos os demais nascem `true`).

> **Invariantes**
> - **Toda Conta e todo Cartao de um Tenant têm a moeda base do Tenant.** Multi-moeda não existe no MVP e o modelo o impede — não é decisão de tela. Sem isso o Saldo geral não tem número correto possível: somar centavos de moedas distintas viola a regra 2 do `CLAUDE.md`, e converter exige uma entidade de câmbio que não existe. Introduzir multi-moeda exige ADR própria com taxa datada e fonte declarada.
> - `moeda` é imutável depois que a Conta tem qualquer `Lancamento`.
> - `incluir_no_saldo_geral = false` **nunca** altera o saldo da própria Conta, só a soma do Saldo geral.
> - Mudar `tipo` nunca muda saldo, sinal, nem `incluir_no_saldo_geral` já persistido.
> - Conta com `origem = conectado` tem uma `Conexao` associada; `origem = manual` não tem.

**Cartao** — Cartão de crédito. Não é Conta: não guarda dinheiro, acumula dívida. Tem `limite`, `closing_day`, `due_day`, `origem` e uma Conta de pagamento padrão. **Não tem `incluir_no_saldo_geral`** — não tem saldo para incluir.

> **Invariantes**
> - `closing_day` e `due_day` ∈ [1, 31]. Em mês que não tem o dia, a data é **fixada no último dia do mês** (`min(dia, ultimo_dia_do_mes)`), sem propagar o ajuste para o mês seguinte.
> - Se `due_day <= closing_day`, o vencimento cai no **mês seguinte** ao do fechamento.
> - A Conta de pagamento padrão pertence ao mesmo Tenant e tem a mesma moeda do Cartao.

**Lancamento** — O átomo do sistema. Um movimento de dinheiro: valor (`Money` com sinal), Categoria, Conta **ou** Cartao, `posted_at`, `settled_at`, descrição. Nunca é editado destrutivamente — alterações passam pelo audit log.

> **Invariantes**
> - Aponta para exatamente uma Conta **ou** um Cartao. Nunca zero, nunca ambos.
> - `valor.moeda` = moeda da Conta ou do Cartao.
> - `valor ≠ 0`.
> - `posted_at` é imutável.
> - `settled_at != null ⟹` o dinheiro se moveu. Nunca recebe data futura.
> - **`categoria_id` é obrigatório**, exceto em perna de `Transferencia`, onde é obrigatoriamente nulo. Não existe lançamento de receita ou despesa sem Categoria — quando o Usuario não escolhe, o domínio atribui a Categoria de sistema `Sem categoria` da natureza correspondente ao sinal. Sem isso, todo agregado por natureza (teto global, relatório por categoria) perde silenciosamente os lançamentos sem categoria.
> - O sinal do `valor` **pode** discordar da `natureza` da Categoria. Um crédito numa categoria de despesa é um `Estorno`; um débito numa categoria de receita é uma devolução de receita. Impor concordância tornaria o estorno irrepresentável.
> - Se aponta para um Cartao, pertence a exatamente uma `Fatura`.

**Status de lançamento** — **Derivado, nunca coluna.** `efetivado` se `settled_at != null`; senão `previsto` se `posted_at` está no futuro; senão `pendente`. Derivar elimina a classe de bug em que um job esquece de virar o status e o número congela.

- `previsto` — ainda não aconteceu (parcela futura, agendamento, recorrência materializada à frente).
- `pendente` — aconteceu, o dinheiro ainda não se moveu (compra na fatura aberta, débito não compensado).
- `efetivado` — o dinheiro se moveu.

**Realizado** — Soma dos Lancamentos **`efetivado` + `pendente`** de um recorte: tudo que já aconteceu. **Projetado** — Realizado + os `previsto`. O par realizado × projetado é o eixo conceitual dos relatórios e do `Planejamento`. Nunca some os dois na mesma linha.

> `Saldo` **não** é Realizado. Saldo conta só `efetivado` — dinheiro que se moveu. Realizado conta o que aconteceu, movido ou não. Uma compra de cartão da fatura aberta está no Realizado do mês e não no Saldo. São perguntas diferentes e a UI precisa rotular as duas.

**Balde** — A classe de um `Lancamento` numa agregação monetária. **Enum fechado de quatro valores**, e todo Lancamento cai em **exatamente um**:

| Balde | Quem cai nele |
|---|---|
| `receita` | `Categoria.natureza = receita` |
| `despesa` | `Categoria.natureza = despesa` |
| `transferencia` | `transfer_group_id IS NOT NULL` (perna) |
| `nao_analitica` | `Categoria.analitica = false` |

A função `baldeDe(lancamento)` vive em `packages/domain` e é **total**: ela não tem caminho que devolva nulo, e não tem `default`. Que ela seja total decorre de duas invariantes já escritas do `Lancamento` — `categoria_id` é obrigatório fora de perna, e obrigatoriamente nulo na perna. Um Lancamento sem balde tem de ser **erro de tipo**, não divergência descoberta em produção. Ver ADR 0022.

> **Invariantes**
> - **A partição é por `Categoria.natureza`, nunca pelo sinal do `valor`.** Pelo sinal, um `Estorno` de despesa (positivo) viraria receita, e o mês fecharia com receita inventada e despesa maior do que foi gasta. O sinal governa a soma; a natureza governa o balde.
> - Os baldes são **disjuntos e exaustivos** sobre o universo da consulta. `Σ dos baldes = Σ dos lançamentos do recorte`, exatamente — e é esta a propriedade a testar, não a identidade do rodapé, que decorre dela.
> - O **universo** é `(eixo, escopo)` e é definido *antes* da partição. Lancamento com `deleted_at` e Lancamento de `Cartao` no eixo caixa estão **fora do universo** — não são baldes. Transformá-los em balde permitiria somá-los por engano; a exclusão precisa acontecer um passo antes.
> - No eixo caixa, a `Fatura` em aberto entra pelo total, no vencimento. Ela **não é Lancamento e não tem balde** — é um segundo somatório, disjunto do primeiro. Ver **Eixo caixa**.
> - Todo Balde tem o par `realizada`/`prevista`, separado pelo predicado do eixo. O resumo é **indexado pelo enum**, nunca por campos nomeados à mão: foi uma lista escrita à mão que perdeu o quarto balde por uma revisão inteira.
> - Toda grandeza que altera o `Saldo` tem um Balde. É a regra que faltava quando `Ajuste de saldo` movia o saldo em −R$ 300,00 e não aparecia em lugar nenhum do rodapé.

**Transferencia** — Movimento entre duas Contas próprias. **Materializada como dois Lancamentos** (uma perna negativa, uma positiva) unidos por `transfer_group_id`. Não é receita nem despesa — não aparece em relatório de gastos nem em `Planejamento`. A soma das pernas é sempre zero.

> **Invariantes**
> - Um `transfer_group_id` tem exatamente duas pernas não excluídas, e a soma delas é zero.
> - **As duas Contas são distintas.** `origem ≠ destino`, recusado na construção com `ORIGEM_IGUAL_DESTINO`. A definição diz *entre duas Contas* — duas, não a mesma duas vezes. A → A não move dinheiro e passa em toda invariante aritmética: as pernas somam zero, o saldo não muda, o Saldo geral não muda. É por isso que a proibição precisa ser de tipo e não de teste — nenhuma soma a encontraria, e o Usuario receberia um extrato com R$ 500,00 entrando e saindo da mesma conta no mesmo dia, que ele não consegue explicar.
> - **As duas pernas compartilham `settled_at`.** Entre contas próprias a transferência é instantânea por definição: as duas compensam juntas ou nenhuma compensa, e `criarTransferencia` grava um só instante nas duas. Pernas com compensação divergente fazem o Saldo geral perder o valor transferido por um dia — a tela diz que o Usuario empobreceu R$ 500,00 enquanto o dinheiro está entre duas contas dele. Dinheiro em trânsito é um conceito de TED interbancária; se um dia for preciso, é entidade própria com ADR, nunca duas datas soltas.
> - **Excluir uma perna isolada é proibido.** A exclusão é da Transferencia inteira e marca as duas pernas na mesma transação. Uma perna solta cria dinheiro do nada: o saldo do destino sobe e nada o compensa.
> - Editar o valor de uma perna edita as duas. Não existe caminho que altere uma só.
> - A soma-zero é verificada considerando apenas pernas com `deleted_at IS NULL`.
> - Transferencia é excluída de **toda** agregação de receita ou despesa, por construção — no tradutor de filtro único, nunca por predicado repetido em cada consulta. Ela pode aparecer como linha na listagem; nunca pode entrar num total.

**Fatura** — Ciclo de cobrança de um Cartao. Tem `periodo_inicio` e `periodo_fim` (instantes), `data_fechamento`, `data_vencimento` e `competencia` (datas civis), e um estado. **Agrega os Lancamentos que apontam para ela por `fatura_id`** — a pertinência é um vínculo explícito, não uma consulta por janela.

**Mes de fechamento** — O mês cujo `closing_day` encerra a janela de uma Fatura. É a chave pela qual o domínio identifica um ciclo: `janelaDaFatura`, `vencimentoDaFatura` e `faturaAlvo` falam todos em mês de fechamento.

> **Não confundir com `competencia`.** A competência de uma Fatura é o mês do **vencimento**. Num ciclo 25/5, a fatura de mês de fechamento **março** fecha em 25/mar, vence em 05/abr e tem competência **abril** — dois meses diferentes para a mesma fatura. Chamar os dois de "competência" foi o que produziu, no épico 3, um teste que conferia o mês errado sem que nada falhasse. O termo existe para que a colisão não volte.

**Regra de atribuição** — Um Lancamento novo vai para a Fatura cuja janela contém seu `posted_at`; se essa Fatura não estiver `aberta`, vai para a **Fatura aberta mais antiga** do Cartao e é marcado `retroativo`. Separar a regra da definição é o que permite o retroativo sem que a definição de Fatura passe a mentir.

> **Invariantes**
> - `competencia` da Fatura é o mês de `data_vencimento` — o mês em que o Usuario paga. Uma fatura que fecha em 25/set e vence em 05/out tem competência **outubro**.
> - As janelas de um Cartao são contíguas e disjuntas: `periodo_fim` de uma fatura **é igual** ao `periodo_inicio` da seguinte. Nenhum instante em duas janelas, nenhum instante fora de todas. Esta invariante fala de **janelas**, não de lançamentos — um retroativo não a viola.
> - `periodo_inicio < periodo_fim`, e `data_fechamento <= data_vencimento`.
> - Todo Lancamento de Cartao tem exatamente um `fatura_id`.
> - **`total` exclui pernas de Transferencia.** O total é a soma dos lançamentos da fatura com `transfer_group_id IS NULL`. Sem isso, a perna de crédito do pagamento zera a fatura que ela acabou de quitar.
> - O total de uma Fatura `fechada` ou `paga` é imutável. Um lançamento novo nunca reabre uma fatura fechada — vai para a aberta mais antiga.
> - Composição da fatura: `compras do ciclo + parcelas de compras anteriores + retroativos − estornos = total`. São **quatro** parcelas, não três; sem o balde de retroativos a conferência não fecha.

**Estado de fatura** — `aberta` (recebendo lançamentos), `fechada` (janela encerrada, valor travado), `paga`, `parcialmente_paga`, `vencida`.

**Pagamento de fatura** — **É uma Transferencia** da Conta para o Cartao, nunca uma despesa. Contá-la como despesa duplicaria o gasto — o erro mais comum da categoria.

> **Invariantes**
> - O vínculo pagamento ↔ fatura é **`transferencias.fatura_id`**, e só ele. A perna de crédito **não** recebe `lancamentos.fatura_id`: dentro da fatura, ela anularia o total.
> - Ao a Fatura passar a `paga`, o domínio grava `settled_at` = instante de efetivação do pagamento em **todos** os lançamentos daquela Fatura, na mesma transação. É aí que a compra de cartão vira desembolso.
> - Pagamento parcial não grava `settled_at` em lançamento nenhum. A Fatura fica `parcialmente_paga` e seus lançamentos seguem `pendente`.

**Estorno** — Lançamento **novo**, de sinal oposto, que desfaz total ou parcialmente um lançamento anterior. Aponta para o original por `estorno_de_lancamento_id`. Nunca é edição nem exclusão do original — o fato aconteceu e depois foi desfeito, e as duas coisas ficam registradas.

> **Invariantes**
> - Sinal oposto ao do original, mesma Conta ou Cartao, mesma Categoria e mesma moeda. **As duas Categorias são iguais e nenhuma é nula** — escrita como igualdade simples, a regra é vacuamente satisfeita por dois nulos.
> - **O original não é perna de Transferencia.** `transfer_group_id IS NULL` e `categoria_id IS NOT NULL` no original, recusado com `ESTORNO_DE_PERNA_PROIBIDO`. Estornar uma perna produziria uma perna de crédito sem par, com `transfer_group_id` nulo: a soma-zero do grupo continua valendo, ninguém reclama, e o saldo do destino sobe R$ 500,00 do nada. Desfazer uma Transferencia é excluir a Transferencia inteira.
> - **O original não é `previsto`.** Estornar exige que o fato tenha acontecido: `pendente` e `efetivado` podem ser estornados, `previsto` é recusado com `ESTORNO_DE_PREVISTO_PROIBIDO`. Desfazer o que ainda não aconteceu é excluir ou editar, e as duas operações estão disponíveis porque não há fato consumado a preservar. Exigir `settled_at` no original seria estrito demais na direção oposta: uma compra de cartão na fatura aberta é `pendente` até a fatura ser paga, e o reembolso do lojista antes disso é o estorno mais comum que existe.
> - **O `settled_at` do estorno é fato próprio**, nunca copiado do original: nulo até o dinheiro voltar. Num Cartao, é o pagamento da Fatura que o escreve, como em qualquer lançamento dela — o estorno de uma compra da fatura aberta cai na mesma Fatura e compensa junto com ela.
> - **Estorno de estorno é proibido** (`ESTORNO_DE_ESTORNO_PROIBIDO`): o original de um Estorno tem `estorno_de_lancamento_id IS NULL`. Uma recobrança depois de um reembolso é **fato econômico novo**, não desfazimento — o caminho é um Lancamento comum, na mesma Categoria, com o sinal do original. Os números são os mesmos e a guarda continua sendo uma soma de um nível só: permitir a cadeia obrigaria `estornoAcumulado` a uma recursão de profundidade ilimitada sob `FOR UPDATE`, no caminho de escrita.
> - `|valor do estorno| <= |valor do original|`, somado a estornos anteriores do mesmo original.
> - **Excluir o original exclui a cadeia inteira**, na mesma transação. Uma despesa de R$ 100,00 estornada em R$ 100,00 soma zero; excluindo só o original sobra `+10000` solto, o saldo sobe R$ 100,00 do nada e o mês fecha com despesa positiva. É o mesmo defeito da perna solta, numa estrutura que ninguém protegeu. O caminho inverso é livre: **excluir um estorno isolado é permitido** — o estorno registrado por engano some, o original volta a valer inteiro e o acumulado é liberado.
> - Um estorno **nunca** altera o `valor` do original nem o `valor_total` de um `GrupoDeParcelamento`. O grupo continua dizendo o que a compra custou; o estorno diz o que voltou.
> - Estorno de compra parcelada é um lançamento único na competência em que o dinheiro voltou. As parcelas futuras **não** encolhem — encolhê-las quebraria `Σ filhos = valor_total` e produziria parcela de valor zero.
> - Sob a base `data_compra`, o estorno de uma compra parcelada é atribuído à competência da **`data_compra` do grupo estornado**, não à sua própria. É a única forma de o relatório de julho deixar de mostrar um gasto que foi desfeito.

**GrupoDeParcelamento** — A compra parcelada como objeto, dona dos fatos que pertencem à **compra**, não a cada parcela: `data_compra`, `valor_total`, `installment_total` e a descrição original. Os N Lancamentos filhos apontam para ele por `installment_group_id`, cada um com seu `installment_number`.

> **Invariantes**
> - **`valor_total` carrega o sinal do domínio.** Uma compra parcelada de R$ 100,00 tem `valor_total = −10000` e filhos negativos. Guardá-lo como magnitude positiva faria `Σ filhos = valor_total` falhar literalmente, invertida em sinal.
> - Soma dos `valor` dos N filhos = `valor_total`, exatamente, para qualquer total e qualquer N. O resto segue a regra única de `ratear`: distribuído **nas primeiras parcelas**, um centavo por parcela.
> - **`|valor_total| >= N`.** Não se divide R$ 0,01 em 3 parcelas: duas delas seriam zero, e `valor ≠ 0` é invariante do `Lancamento`. O parcelamento é **rejeitado** na construção, não silenciosamente reduzido a menos parcelas do que o Usuario pediu.
> - `installment_number` ∈ [1, N], sem lacuna e sem repetição.
> - `data_compra` é o mesmo fato para as N parcelas — persistido **uma vez**, no grupo. Nunca copiado para os filhos.
> - `data_compra <= posted_at` de toda parcela.
> - Parcela 1 tem `posted_at = data_compra`. As demais avançam mês a mês a partir de `data_compra`, com o dia fixado em `min(dia_da_compra, ultimo_dia_do_mes)` **sem arrastar o ajuste**: compra em 31/jan em 3x gera 31/jan, 28/fev, **31**/mar.
> - Excluir o grupo exclui as N parcelas (soft delete). Excluir uma parcela isolada é proibido.

**Parcelamento** — A operação que cria um `GrupoDeParcelamento` e seus N Lancamentos. Gerados no momento da compra, um por Fatura futura.

**Recorrencia** — Regra que gera Lancamentos repetidos (salário, aluguel, assinatura). Guarda a regra, não as ocorrências; um job materializa as ocorrências dentro de um horizonte. Editar a regra não reescreve o passado.

> **Invariantes**
> - `dia_do_mes` em mês que não o tem é **fixado no último dia do mês**: `min(dia_do_mes, ultimo_dia_do_mes)`, sempre calculado a partir do `dia_do_mes` da regra, nunca do mês anterior. Dia 31 produz 28/fev (29 em bissexto) e volta a 31 em março.
> - A recorrência **nunca pula** um mês por falta do dia, e **nunca transborda** para o mês seguinte. Pular faz o mês perder o lançamento e o teto ficar verde indevidamente; transbordar dá duas ocorrências ao mês seguinte e estoura o teto dele.
> - A identidade de uma ocorrência é `(tenant_id, recorrencia_id, competencia_da_ocorrencia)` — a **competência**, não a data exata. Alterar `dia_do_mes` na regra reposiciona ocorrências futuras sem duplicá-las; com a data na chave, a alteração faria o job materializar tudo de novo.
> - Alterar a regra não altera ocorrências já materializadas com `posted_at` no passado.

**Categoria** — Classificação de Lancamento. Hierarquia de dois níveis (categoria → subcategoria). Tem `natureza` (`receita` ou `despesa`), `analitica`, cor, ícone e `arquivada_em`.

- `analitica` — Booleano, padrão `true`. Categoria **não analítica** classifica lançamentos que não são fato econômico e é excluída de todo relatório de gasto e de todo `Planejamento`, exatamente como a Transferencia. Hoje há uma: **`Ajuste de saldo`**. Ajustar saldo é correção de registro, não gasto — sem isso, um ajuste de −R$ 300,00 vira R$ 300,00 de despesa no relatório e consome o teto global.

  > **`analitica` não é "é folha", e a confusão entre as duas leituras é um defeito.** `analitica = false` diz *isto não é um fato econômico*; ela **não** diz nada sobre a posição na árvore. Uma categoria não analítica **recebe** lançamento — se não recebesse, `Ajuste de saldo` seria inalcançável e a única razão do campo existir desapareceria. Ver ADR 0021.

**Categoria-raiz recebe lançamento.** Uma raiz com subcategorias continua aceitando lançamento direto. Não existe regra de folha, não existe `422 CATEGORIA_NAO_E_FOLHA`, e nenhuma restrição do banco deriva o direito de lançar da presença de filhas.

O motivo é a operação mais comum de uma árvore de categorias pessoal: *"uso `Casa` há seis meses e agora quero separar `Luz` e `Água`"*. Sob a leitura estrita, criar a primeira subcategoria tornaria ilegal todo o histórico da raiz, e as três saídas possíveis são ruins — recusar a criação da subcategoria, reclassificar o passado do Usuario sozinho, ou admitir que a invariante não vale para linhas antigas, que é o pior dos três. **A raiz precisa poder guardar o que estava lá antes de os galhos existirem.**

**Realizado próprio** — A soma dos Lancamentos que apontam **para a própria Categoria**, sem descer a árvore. **Realizado agregado** — o próprio mais o de todas as subcategorias. Toda superfície que exibe categoria hierárquica nomeia qual das duas está mostrando.

Na UI, o realizado próprio de uma raiz com filhas aparece como uma linha irmã das subcategorias, rotulada **"Casa (direto)"**. Sem essa linha, o dinheiro lançado na raiz desaparece da árvore ou — pior — a raiz aparece duas vezes na mesma lista, uma com o agregado e outra com o próprio, e os R$ 50,00 são contados duas vezes.

> **Invariantes**
> - `total_agregado(c) = realizado_proprio(c) + Σ total_agregado(filhas de c)`, exatamente, para qualquer recorte.
> - **Nenhuma superfície soma `realizado_proprio` e `total_agregado` da mesma Categoria.** Elas nunca são linhas irmãs somáveis: ou a lista é de agregados (raízes), ou é de próprios (a raiz "(direto)" e suas filhas). Esta é a única forma de contagem dupla que a hierarquia permite, e é ela que a linha "(direto)" fecha.
> - A soma dos `total_agregado` das raízes de uma natureza **é igual** ao balde correspondente do rodapé, para o mesmo recorte. Duas superfícies, um número.
- **Categorias de sistema** — `Sem categoria` (uma por natureza) e `Ajuste de saldo`. Podem ser renomeadas, nunca excluídas e nunca arquivadas: são o destino obrigatório de lançamentos que precisam de Categoria e não têm uma escolhida.

- `arquivada_em` — Timestamp de arquivamento. **Arquivar não é excluir.** Categoria arquivada some dos seletores e da cópia de `Planejamento`, mas continua classificando todo o histórico e continua aparecendo em relatórios do passado. `deleted_at` continua existindo e continua sendo o mecanismo de exclusão — os dois campos coexistem e significam coisas diferentes.

> **Invariantes**
> - Subcategoria tem a mesma `natureza` da categoria-pai.
> - Hierarquia tem no máximo dois níveis: uma subcategoria não tem filhas.
> - **A posição na árvore não restringe quem recebe Lancamento.** Raiz com filhas recebe; raiz sem filhas recebe; subcategoria recebe. Nenhum `CHECK`, nenhum gatilho e nenhuma rota derivam o direito de lançar da presença de subcategorias.
> - `analitica = false` **não** impede o Lancamento — impede a entrada nos baldes de receita e despesa, no relatório de gasto e no `Planejamento`. Um gatilho que recusa lançamento em categoria não analítica torna `Ajuste de saldo` inalcançável.
> - Arquivar uma categoria-pai arquiva as subcategorias.
> - Categoria arquivada não pode receber Lancamento novo; os existentes permanecem intactos.
> - Categorias do sistema podem ser renomeadas, **nunca excluídas e nunca arquivadas**: são o destino obrigatório de lançamentos que precisam de Categoria, e um destino obrigatório indisponível não é destino.

**Etiqueta (Tag)** — Classificação transversal e livre, ortogonal à Categoria. Um Lancamento tem uma Categoria e N Etiquetas. **Chama-se Etiqueta na UI e `Tag` no código, sempre — nunca "marcador".**

**Planejamento** — Valor esperado para uma Categoria numa Competencia. Substitui **Limite** e a **meta de receita mensal** — o piso mensal por categoria, que era o espelho exato do Limite. **Não** substitui o objetivo de acúmulo plurimensal: esse é `Objetivo`, entidade própria. O sinal do `valor` carrega a direção: valor negativo é **teto** de despesa, valor positivo é **piso** de receita. Ver ADR 0008.

- `natureza` (`teto` | `piso`) — **derivada** do sinal de `valor`, nunca persistida. Existe para rotular a UI e para particionar o escopo global.
- `categoria_id` — Opcional. Preenchido, o escopo é a Categoria. Nulo, é um **Planejamento global**.
- `alertas_percentuais` — Percentuais em que o domínio emite evento. Padrão `[80, 100]`.

**Identidade** — `(tenant_id, competencia, natureza, categoria_id)`, com `categoria_id` nulo sendo um valor legítimo e único da chave. Dela decorrem tanto o índice quanto a verificação de existência da cópia. Como `NULL` não colide em índice único nem satisfaz `=` no Postgres, isso exige índices únicos **parciais** e comparação por `IS NOT DISTINCT FROM` — a constraint natural e o `=` ingênuo deixam passar um segundo global e quebram a idempotência da cópia.

**Apuração do realizado** — O realizado de um Planejamento é a soma dos Lancamentos que, na competência, pertencem ao seu escopo e cuja **`Categoria.natureza` é igual à `natureza` do Planejamento**. Um teto agrega despesa; um piso agrega receita. Nunca a soma líquida.

> Isto é o que faz o teto **global** funcionar. Sem partição por natureza, receita anula despesa e o teto global é impossível de estourar para qualquer usuário com superávit: R$ 10.000 gastos sob teto de R$ 3.000, com R$ 20.000 de salário, dariam `+1.000.000 >= −300.000` — dentro do planejado. E a partição é por **natureza da Categoria**, não pelo sinal do lançamento: um estorno de salário é negativo e é receita, e não pode consumir teto de despesa.

**Precedência hierárquica** — Três níveis: **global → categoria-raiz → subcategoria**. Um Planejamento superior agrega o realizado de tudo abaixo; um inferior é um sub-teto legítimo, e o mesmo lançamento conta nos dois. Para não haver contagem dupla, o **total planejado** soma, em cada caminho, apenas o Planejamento de **nível mais alto** que existir. A regra é enunciada **duas vezes, uma por natureza**: há um total planejado de despesa e um de receita, e eles nunca se somam.

**Consumo** — `consumo_bp = razaoEmBp(realizado, valor)`, inteiro com sinal, truncado em direção a zero. `atingiu(pct) ⟺ consumo_bp >= pct * 100`.

> Uma única divisão, uma única comparação, nenhum `if` sobre natureza — e é aqui que a versão anterior errava. Multiplicar os dois lados por `valor` para evitar a divisão **inverte a desigualdade quando `valor` é negativo**: com teto de R$ 500 e R$ 300 gastos, `−30000 × 100 >= 80 × −50000` é verdadeiro e o alerta de 80% dispara a 60% de consumo. O `if` abolido do `dentro_do_planejado` tinha voltado, invertido, dentro do cálculo percentual.
>
> A exibição usa **o mesmo `consumo_bp`**, dividido por 100. Com realizado de −R$ 399,99 sob teto de R$ 500, o truncamento dá 7999 bp: a tela mostra 79,99% e o alerta de 80% não dispara. Formatar por arredondamento a partir de outro número faria a tela anunciar 80,00% sem alerta, ou disparar um centavo antes do limiar.

> **Invariantes**
> - `dentro_do_planejado ⟺ realizado >= valor`, com o sinal do domínio, para teto e piso igualmente. Sem nenhum `if` sobre natureza.
> - `consumo_bp` **pode ser negativo**: um mês cujo único lançamento na categoria é um estorno tem realizado de sinal oposto ao do teto. Barra negativa é exibida como 0% e o número real no detalhe. Nenhum limiar positivo é cruzado por um consumo negativo.
> - `atingiu` é avaliado em aritmética inteira sobre `consumo_bp`, jamais sobre o percentual formatado.
> - Gastar exatamente o teto é `dentro_do_planejado` **e** `consumo_bp = 10000`. O estado exibido é **`no_planejado`**, derivado — nem verde nem estourado. Sem esse terceiro rótulo a tela mostra verde e o sino mostra alerta para o mesmo objeto no mesmo instante.
> - Com `categoria_id` preenchido, `sinal(valor)` concorda com `Categoria.natureza`: despesa ⟹ negativo, receita ⟹ positivo.
> - Com `categoria_id` nulo não há Categoria contra a qual conferir: o sinal **define** a natureza do escopo em vez de ser conferido por ela.
> - `valor ≠ 0` — o que também garante que `razaoEmBp` nunca divide por zero.
> - No máximo um Planejamento por identidade não excluída.
> - Transferencia e Categoria não analítica nunca entram no realizado de um Planejamento.
> - O realizado de um Planejamento usa **sempre** a base temporal `data_parcela`, independentemente da preferência de relatório do Usuario.
> - O total planejado de um mês nunca soma dois Planejamentos do mesmo caminho, nem naturezas diferentes.

**Copiar planejamento** — Operação que replica os Planejamentos de uma competência para outra.

> **Invariantes**
> - Idempotente: executar duas vezes produz o mesmo conjunto — **inclusive com um Planejamento global na origem**. A verificação de existência compara a identidade inteira com `IS NOT DISTINCT FROM`; escrita como `categoria_id = origem.categoria_id`, o global nunca é encontrado (`NULL = NULL` é `NULL`), o `INSERT` é tentado, o índice parcial o rejeita e a transação aborta levando junto as categorias que já tinham sido copiadas.
> - Não destrutiva: só cria Planejamento para identidade que **não existe** na competência de destino. Nunca sobrescreve valor editado pelo Usuario.
> - Ignora categorias com `arquivada_em` preenchido no momento da cópia.
> - Copia o valor literalmente. Sem correção monetária, sem projeção.

**Objetivo** — Acúmulo de um valor até uma data: *"juntar R$ 12.000 até dezembro"*. É **plurimensal e com prazo**, e por isso não é um `Planejamento` — que é mensal e por competência. Substitui o termo **Meta**, aposentado por ambiguidade. Tem `nome`, `valor_alvo`, `prazo` (opcional), `saldo_base` e `concluido_em`.

- `valor_alvo` — `Money` **sempre positivo**. Objetivo é um **estoque-alvo**, não um fluxo: a convenção de sinal do ADR 0005 governa movimentos, e um alvo de acúmulo não tem direção a codificar.
- `prazo` — `DATE` em `America/Sao_Paulo`, **opcional**. Sem prazo, o Objetivo nunca vence — é o caso da reserva de emergência.
- **Modo de apuração**, derivado de `conta_id`, nunca persistido como enum:
  - **Ancorado** (`conta_id` preenchido) — `progresso = saldo(conta) - saldo_base`, onde `saldo_base` é um `Money` **armazenado**, capturado na criação. Nunca derivado de uma data: se fosse recalculado, um lançamento retroativo mudaria o progresso sozinho.
    **Reajuste por retroativo anterior.** Um Lancamento com `settled_at` **anterior** ao `criado_em` do Objetivo ajusta `saldo_base` pelo mesmo valor, preservando o progresso. Sem isso, importar em setembro um depósito feito em agosto — dinheiro que já estava na conta quando o marco foi capturado — dá 30% de progresso sem que o Usuario tenha guardado um centavo. `saldo_base` congela o saldo *conhecido*; o reajuste o corrige para o saldo *real* daquele instante.
  - **Por aportes** (`conta_id` nulo) — `progresso = Σ valor` dos Lancamentos ligados por `Aporte`.
- **Estado**, derivado: `concluido` se `concluido_em != null`; senão `vencido` se `prazo != null && prazo < hoje`; senão `ativo`.
- **Prazo vencido sem atingir o alvo: nada acontece.** O Objetivo passa a `vencido`, sai da lista de ativos, é preservado intacto e o domínio emite `ObjetivoVencido`. Não exclui, não estende sozinho, **não gera Lancamento** — Objetivo nunca move dinheiro.

> **Invariantes**
> - `valor_alvo > 0`.
> - Ancorado: `valor_alvo.moeda = conta.moeda`. Por aportes: `valor_alvo.moeda` = moeda base do Tenant, e todo Lancamento aportado tem essa moeda. Sem conversão silenciosa, nunca.
> - `prazo`, quando informado, é `>= hoje` **no momento da escrita**. Um Objetivo cujo prazo passou pelo tempo é `vencido`, não inválido — a validação é de escrita, não de leitura.
> - `progresso` **não é limitado** ao alvo: pode passar de 100% e pode ficar negativo se houver resgate. A UI pode travar a barra; o domínio devolve o número real.
> - `saldo_base` só muda pelo reajuste de retroativo anterior à criação, e sempre pelo valor do lançamento que o motivou — de modo que o progresso fique inalterado. Nenhum outro caminho o escreve.
> - `concluido_em` é gravado na **primeira** vez que `progresso >= valor_alvo` e é **fixo**: resgate posterior reduz o progresso e não desfaz a conclusão. Atingir foi um fato histórico.
> - A travessia é avaliada **na transação que altera o progresso** — toda escrita que afete o saldo da Conta ancorada ou o conjunto de Aportes reavalia os Objetivos afetados. Nunca na leitura da tela. Apurada na leitura, "primeira travessia" vira "primeira vez que alguém abriu a tela": um objetivo atingido em setembro e resgatado em outubro nunca seria concluído, e a regra do resgate — a que este glossário manda ler duas vezes — nunca chegaria a ser exercida.
> - Reduzir `valor_alvo` para valor já alcançado conclui o Objetivo na hora. **Aumentar** `valor_alvo` acima do progresso **limpa** `concluido_em` e devolve o Objetivo a `ativo` — a fixidez protege contra queda de progresso, não contra redefinição deliberada do alvo.
> - Um Objetivo ancorado não excluído **bloqueia** o soft delete da sua Conta. Para excluir a Conta, exclua o Objetivo antes. O progresso nunca é congelado num campo.
> - Objetivo nunca cria, altera ou exclui `Lancamento`.

**Aporte** — Vínculo entre um `Lancamento` e um `Objetivo` por aportes. O progresso é a soma dos valores vinculados, com o sinal do domínio: a perna positiva de uma Transferencia soma, a negativa (resgate) subtrai. Sem `if`, sem campo de tipo.

> **Invariantes**
> - Um Lancamento pertence a no máximo um Objetivo.
> - Só existe em Objetivo por aportes. Objetivo ancorado não aceita Aporte — seu progresso já é o saldo da Conta, e aceitar os dois contaria o mesmo dinheiro duas vezes.
> - Vincular ou desvincular um Aporte nunca altera o `valor`, a Categoria ou o `status` do Lancamento.

**Saldo** — Sempre **derivado** da soma dos Lancamentos `efetivado` de uma Conta. Cartao não tem saldo — tem dívida em fatura.

**Saldo geral** — Soma dos saldos das Contas com `incluir_no_saldo_geral = true`, na moeda base do Tenant. É o número principal do produto.

> **Invariantes**
> - Todas as Contas somadas têm a mesma moeda, garantido pela invariante de `Conta`. Não há conversão porque não há multi-moeda; se um dia houver, o Saldo geral exige uma taxa datada e uma ADR, não um `SUM`.
> - Alterar `incluir_no_saldo_geral` muda o Saldo geral e nada mais.
> - Saldo geral soma **saldos de Conta**, nunca dívida de Cartao. "Quanto eu tenho" e "quanto eu devo" são dois números e a UI rotula os dois.

**SaldoSnapshot** — Materialização de `(conta_id, dia) → saldo`, existente apenas para desempenho. Reconciliado por job contra o derivado. Divergência é incidente, não warning.

**Projecao** — Saldo futuro = saldo atual + Lancamentos `previsto` até uma data. Não é persistida.

---

## Assinatura e cobrança

Este eixo trata do dinheiro **da Mavia**. Ele nunca se mistura ao dinheiro **do Tenant** — a fronteira está escrita em `Cobranca`, e é a mais importante desta seção.

**Plano** — **Termo comercial.** O que o Tenant assina e paga: `Pessoal`, `Familia`, `Negocio`. Concede `Cota`s. **Item de catálogo, em código, nunca em tabela.** Chave: `(codigo, intervalo)`. Tem `preco` (`Money`), `cotas`, `versao` e `disponivel_para_compra`.

**O que `Plano` não é:** não é `Planejamento`. Não tem competência, não tem natureza, não tem categoria, e **não entra em nenhum agregado financeiro do Tenant**.

> **Invariantes**
> - `cotas` dependem **só** de `codigo`. O `Intervalo` muda preço e duração do período, jamais o que o plano libera — um plano anual com cotas diferentes seria um quarto plano com outro nome.
> - `preco` é **declarado, nunca derivado** de outro preço. O anual não é o mensal vezes dez.
> - Mudança de preço cria `versao` nova. Quem já assinou mantém o preço da versão contratada até migração explícita e comunicada.

**Intervalo** — `mensal` ou `anual`. Muda preço e duração do período; não muda cotas, nem estados, nem a máquina de ciclo de vida.

> **Invariantes**
> - `anual ⟹ periodo_fim = periodo_inicio + 12 meses`, pela **Ancoragem de dia do mês**.
> - Trocar de Intervalo nunca altera `Cota` alguma.

**Cota** — Teto de **recurso** que um `Plano` concede: pessoas, espaços, armazenamento, conexões bancárias. Contagem inteira de coisas, nunca `Money`.

O nome foi escolhido para não ser `Limite`, e **confirmo a escolha**. Ela deixa a raiz `limite` com exatamente um significado em todo o código: **`Cartao.limite`**, o limite de crédito — que é `Money` e é do banco, não nosso. `Limite` já estava aposentado como entidade de orçamento, em favor de `Planejamento`; se voltasse como teto de assinatura, teríamos três sentidos para uma palavra em três camadas do sistema.

> **A fronteira que importa: `Cota` bloqueia, `Planejamento` avisa.**
>
> **Invariantes**
> - Cruzar uma `Cota` **recusa a ação** daquele tipo de recurso, e só dele: criar lançamento continua funcionando enquanto um convite é recusado.
> - Cruzar um `Planejamento` **emite evento e não impede nada**. Estourar o teto de Alimentação nunca bloqueia um lançamento — o dinheiro do Usuario é dele.
> - Um `Planejamento` que bloqueia é bug de domínio. Uma `Cota` que apenas avisa é falha de cobrança.
> - `Cota` é contagem inteira. Não usa `Money`, não usa `competencia`, não tem natureza, não tem `consumo_bp`.
> - **Acima da cota é estado tolerado**, alcançável só por rebaixamento: nada é apagado, nada é escondido, **nada vira somente-leitura**. Bloqueia-se apenas a criação daquele tipo até a contagem voltar.

**Assinatura** — O vínculo entre um `Tenant` e um `Plano`, com estado e ciclo de vida. Uma por Tenant, sempre.

**Estado de assinatura** — `teste` (7 dias, sem cartão), `ativa`, `em_atraso` (14 dias, escrita continua funcionando), `cancelada` (funciona até o fim do período pago), `expirada` (leitura e exportação completas, escrita bloqueada).

> **A invariante que governa tudo o mais: o estado da `Assinatura` não é gatilho de retenção de nenhuma classe de dado.**
>
> **Invariantes**
> - `expirada` mantém **leitura completa e exportação completa, indefinidamente**. Nenhum dado é apagado, encurtado ou escondido por falta de pagamento. Esconder o passado de quem parou de pagar é sequestro de dado com outro nome.
> - Nenhum `Plano` encurta histórico. Retenção é função de base legal e de pedido do titular, **nunca** de estado comercial.
> - Exportação, eliminação de dados, exclusão do espaço e revogação de conexão funcionam em **todos** os estados. São direitos do art. 18 da LGPD — nunca atrás de pagamento, nunca com atrito adicional.
> - Exatamente uma Assinatura por Tenant. O espaço nasce com ela, em `teste`.
> - `estado = teste ⟹` não existe assinatura no provedor de pagamento.
> - `teste_termina_em` é fixado na criação e **imutável**. Prorrogar é operação nomeada e auditada, nunca um `UPDATE` solto.
> - `estado` só é escrito pelo processador de `EventoDeCobranca` ou pelo job de fim de teste. Nenhuma rota de produto o escreve.
> - `[periodo_inicio, periodo_fim)`, semiaberta, pela convenção única de `Janela`.
> - **Nenhuma coluna de PAN, CVV, nome impresso ou validade completa do cartão.** Veto permanente. Os últimos quatro dígitos e a bandeira existem para o titular reconhecer o próprio cartão.

**Cobranca** — O evento monetário da assinatura: uma por fatura do provedor. Tem `valor` (`Money`), estado, período e as datas de emissão e pagamento.

**Nunca se chama "fatura".** `Fatura` é o ciclo do `Cartao` do Usuario e não empresta o nome — são as duas coisas que mais se parecem e menos se confundem impunemente.

> **A fronteira `Cobranca` × `Lancamento`.** As duas carregam `Money` e as duas descrevem a mesma mensalidade no mundo. São entidades diferentes porque são **dinheiros diferentes**: `Cobranca` é receita da Mavia contra o Tenant; `Lancamento` é movimento no razão do Usuario.
>
> Se o Usuario quiser acompanhar a mensalidade da Mavia como despesa dele, ele **lança um `Lancamento` comum** — à mão, ou por importação do extrato ou da fatura do cartão. Esse Lancamento é uma despesa ordinária, com Categoria, e **não sabe que existe uma `Cobranca`**. Os dois coexistem e não se referenciam.
>
> **Invariantes**
> - `Cobranca` nunca entra em `Saldo`, `Saldo geral`, `Realizado`, `Projetado`, relatório, `Planejamento` ou `Objetivo`. Não existe agregado do Tenant que a inclua.
> - **Nenhuma `Cobranca` cria, altera ou exclui `Lancamento`.** *(teste de arquitetura, como em `Objetivo`)* Criá-lo automaticamente seria a Mavia escrevendo no razão do Usuario — e erraria a conta sempre que ele pagasse por um cartão que não acompanha aqui.
> - Não existe `lancamento.cobranca_id` nem `cobranca.lancamento_id`. O vínculo ausente é deliberado: é ele que impediria a tentação anterior.
> - Os dois **podem divergir** — o Usuario pode não lançar, ou lançar valor diferente. É correto: o extrato dele é dele.
> - A convenção de sinal do ADR 0005 **não se aplica**: `valor` é o montante cobrado, positivo. Sinal governa movimento no razão do Tenant, e `Cobranca` não é um.
> - `valor` é imutável depois de emitida.
> - O valor devolvido é persistido em `valor_reembolsado` (`Money`, zero por padrão), com `0 <= valor_reembolsado <= valor`. 🔺 **Lacuna a fechar com o `product-financeiro`:** os três estados `paga | falhou | reembolsada` não distinguem reembolso integral de parcial, e a fórmula de reembolso proporcional produz parciais. Sem o campo, o valor devolvido existe só no provedor.
> - **Sobrevive à eliminação do espaço** por obrigação fiscal. É o único lugar, com `DadosFiscais`, onde dado do titular sobrevive — e por isso precisa estar escrito em português claro na tela de privacidade, não só nos termos. Retenções diferentes para o mesmo fato do mundo são a prova de que `Cobranca` e `Lancamento` são entidades distintas.

**DadosFiscais** — CPF ou CNPJ do assinante, com `tipo_documento` e, para CNPJ, a razão social. Tabela própria, chaveada por Tenant. Coletado **só no checkout**, com finalidade única de emissão fiscal.

> **Invariantes**
> - **Nunca é identificador.** Não serve para login, não é chave de nada, não indexa busca, não aparece em URL.
> - **Nunca é antifraude.** Não detecta teste repetido, conta duplicada nem abuso.
> - **Nunca é enriquecido nem consultado** em base externa. A validação é por dígito verificador, aritmética local.
> - **Nunca sai:** não vai em log, métrica, notificação, e-mail, resposta a não-`proprietario`, nem exportação de outro membro.
> - Só existe se houver ou tiver havido Assinatura fora de `teste`. Nenhum caminho o cria durante o teste.
> - `tipo_documento = cnpj ⟹` razão social preenchida.
> - Qualquer uso fora da emissão fiscal é **finalidade nova** e exige decisão própria. Não existe "aproveitando que já temos".

**EventoDeCobranca** — O evento vindo do provedor de pagamento, e o livro de idempotência do webhook. O `id` do provedor **é** a chave primária: esse é o mecanismo inteiro.

> **Exceção de tenancy, declarada.** O evento chega **antes** de sabermos o Tenant, então a tabela **não tem `tenant_id`** e vive fora da RLS — como `outbox_pendencias`.
>
> **Invariantes**
> - A exceção só é segura porque a tabela **não contém dado pessoal**: id, tipo, horários, tentativas e resultado. Nunca o payload do provedor, nunca e-mail, nunca valor.
> - O efeito do evento é aplicado numa **segunda transação**, com o tenant fixado, sob RLS.
> - Reprocessar o mesmo id não produz efeito novo.
> - Não entra na exportação do titular, e a justificativa é a ausência de dado pessoal — declarada, não presumida.

**ListaDeEspera** — E-mail de quem quer ser avisado quando a conexão bancária existir. **É o único dado do sistema sobre alguém que não é cliente e não tem `Tenant`.** Base legal: consentimento.

> **Invariantes**
> - **A RLS não a protege, porque RLS é por `tenant_id` e aqui não há um.** É a terceira exceção de tenancy, e a única das três que **contém dado pessoal** — logo a justificativa das outras duas ("não tem dado pessoal") não vale aqui, e a exceção exige controle compensatório explícito: nenhuma rota autenticada de produto a expõe, e só um papel de serviço a lê.
> - **Eliminação é `DELETE` físico, não soft delete.** A regra 17 do `CLAUDE.md` — `deleted_at`, nunca `DELETE` — governa dado **financeiro**, e este não é. Manter `deleted_at` de quem pediu para sair é manter o dado de quem revogou o consentimento.
> - `descadastrado_em` apaga a linha **na hora**.
> - Apagada 30 dias após o aviso, se a pessoa não virar cliente.
> - **Uso secundário é vetado.** Nada de newsletter, nada de promoção, nenhum repasse. Uma finalidade, uma comunicação.
> - Nunca é cruzada com `Usuario`, `Tenant` ou `DadosFiscais`.

---

## Ingestão bancária

**BankSyncProvider** — A interface única por onde todo dado bancário externo entra. Nenhum código de aplicação conhece o provider concreto. Ver `docs/adr/0003`.

**Adapter de sincronização** — Implementação concreta do `BankSyncProvider`: `manual`, `ofx-import`, `csv-import`, `pluggy` (previsto). Trocar de agregador é adicionar um arquivo.

**Conexao** — Vínculo autorizado entre um Tenant e uma instituição financeira, através de um adapter. Guarda credenciais cifradas, escopo consentido e validade. Cria Contas e Cartoes com `origem = conectado`.

**Consentimento** — Autorização explícita, versionada e com prazo, dada pelo Usuario para acessar dados de uma instituição. Revogável a qualquer momento; revogação interrompe a sincronização e dispara a política de retenção. Exigência do Open Finance **e** da LGPD.

**Sincronizacao** — Execução de um adapter contra uma Conexao. Registra início, fim, resultado e quantos Lancamentos foram criados, atualizados ou ignorados por duplicidade.

**LancamentoBruto** — Registro cru como veio da fonte, antes de virar Lancamento. Preservado para auditoria e reprocessamento. Chave de idempotência: `(tenant_id, provider, external_id)` + hash de conteúdo.

**Deduplicacao** — Regra que impede o mesmo LancamentoBruto de virar dois Lancamentos. Nunca depende só da descrição.

**Conciliacao** — Casamento entre um Lancamento importado e um lançado à mão pelo Usuario. Produz uma **sugestão**; o Usuario confirma. O sistema jamais apaga o registro do Usuario sozinho.

**Categorizacao automatica** — Atribuição de Categoria a um Lancamento por regra do Usuario, histórico do Tenant ou modelo. Sempre reversível, sempre com o motivo visível.

---

## Termos proibidos

Não use — geram ambiguidade e bugs reais:

| Não use | Use | Por quê |
|---|---|---|
| `transaction` | `Lancamento` | Colide com transação de banco de dados |
| `amount: number` | `Money` | Ponto flutuante em dinheiro é defeito, não estilo |
| `balance` como coluna mutável | `SaldoSnapshot` | Deixa claro que é derivado |
| `date` | `posted_at` / `settled_at` | Colapsar competência e efetivação quebra o cartão |
| "a data" de um lançamento de cartão | `data_compra` · `posted_at` · `Fatura.competencia` | São três bases distintas; "a data" não existe |
| `purchase_date` no `Lancamento` | `GrupoDeParcelamento.data_compra` | Repetir o fato em N linhas permite que N linhas divirjam |
| `card account` | `Cartao` | Cartão não guarda dinheiro |
| `transfer` como um lançamento | `Transferencia` (duas pernas) | Uma perna só desequilibra o sistema |
| `user` como dono de dados | `Tenant` | Isolamento é por Tenant, não por Usuario |
| "espaço" | `Tenant` | Vocabulário do Organizze; um sinônimo a mais é um bug a mais |
| `delete` | `deleted_at` | Dado financeiro não some |
| "arquivar" como sinônimo de excluir | `arquivada_em` ≠ `deleted_at` | Arquivar tira do seletor; excluir tira do sistema |
| "marcadores" | `Etiqueta` / `Tag` | Dois nomes para a mesma coisa — a inconsistência real do Organizze |
| `Limite` como entidade | `Planejamento` (orçamento) · `Cota` (assinatura) | Teto e piso mensais são o mesmo mecanismo; e `limite` fica reservado a `Cartao.limite`, seu único sentido restante |
| `Plano` para orçamento | `Planejamento` | `Plano` é o que o cliente assina. Um `if (plano)` num caminho financeiro é ambíguo entre cobrança e orçamento |
| `dentro_do_plano` | `dentro_do_planejado` | Lê-se como "dentro da assinatura"; confunde guarda de cobrança com verificação de orçamento |
| `no_limite` como estado de `Planejamento` | `no_planejado` | Reintroduz a raiz `limite` no orçamento, de onde ela foi removida |
| `Plano.limites` | `Plano.cotas` | Mesma colisão, um nível abaixo |
| `Cota` medida em `Money` | contagem de recursos | Cota conta pessoas e conexões; teto de dinheiro é `Planejamento` |
| `Plano` ou `Cota` em relatório financeiro | — | Mensalidade é receita da Mavia, não movimento do Tenant |
| `Limite` do plano | `Cota` | Aposentado em favor de `Planejamento`; reusá-lo colide com teto de gasto |
| "fatura da assinatura" | `Cobranca` | `Fatura` é o ciclo do cartão do Usuario — a palavra que carrega o erro clássico da categoria |
| `Cobranca` somada a `Lancamento` | dois eixos separados | Uma é receita da Mavia, o outro é o razão do Usuario |
| `lancamento.cobranca_id` | nenhum vínculo | O vínculo ausente é o que impede a Mavia de escrever no razão do Usuario |
| `trial` | `teste` | Um idioma por conceito |
| `status` da assinatura no provedor como estado do produto | `Assinatura.estado` | O deles descreve dinheiro; o nosso descreve direito de uso |
| estado da assinatura como gatilho de retenção | — | Assinatura expirada mantém leitura e exportação, para sempre |
| número de cartão em qualquer coluna | — | Veto permanente, em qualquer tabela, em qualquer épico |
| `deleted_at` em `ListaDeEspera` | `DELETE` físico | Soft delete de quem revogou consentimento é manter o dado |
| `Meta` | `Planejamento` (piso mensal) · `Objetivo` (acúmulo com prazo) | Um nome para dois conceitos de horizonte diferente. A ambiguidade quase apagou o acúmulo do modelo — foi preciso um veto para recuperá-lo |
| `objetivo.progresso` como coluna | soma derivada (saldo − `saldo_base`, ou Σ Aportes) | Progresso é saldo; saldo é derivado (ADR 0005) |
| `saldo_base` recalculado | `saldo_base` armazenado, com reajuste só por retroativo anterior | Lançamento retroativo faria o progresso mudar sozinho |
| `status` como coluna | `status` derivado de `settled_at` e `posted_at` | Coluna de status envelhece quando um job esquece de virá-la |
| `effective_at` | `settled_at` (fato) · `Fatura.data_vencimento` (previsão) | Lido como fato por uns e como previsão por outros; produziu dois modelos incompatíveis |
| `settled_at` = vencimento da fatura | `settled_at` = pagamento | Data futura em campo de compensação faz toda compra de cartão nascer realizada |
| coluna de previsão de caixa em `lancamentos` | `Fatura.data_vencimento` | Previsão persistida envelhece quando o vencimento do cartão muda |
| lançamento de `Cartao` no eixo caixa | `Fatura` no eixo caixa | Compra de cartão não sai do bolso; a fatura sai |
| `periodo_inicio`/`periodo_fim` como `DATE` | `TIMESTAMPTZ` | `DATE` não representa instante; a coerção depende do fuso da sessão |
| janela `(inicio, fim]` | `[inicio, fim)` | Uma convenção só; duas produzem dia contado em dobro ou em nenhum lugar |
| `lancamentos.fatura_id` na perna do pagamento | `transferencias.fatura_id` | A perna de crédito dentro da fatura zera o total dela |
| editar ou excluir o lançamento original | `Estorno` | O fato aconteceu e depois foi desfeito; os dois ficam registrados |
| `categoria_id` nulo em receita ou despesa | Categoria de sistema `Sem categoria` | Nulo escapa de todo agregado por natureza, em silêncio |
| `analitica` como "é folha" | `analitica` = não é fato econômico | Duas regras ortogonais sob um booleano; a leitura errada torna `Ajuste de saldo` inalcançável |
| `CATEGORIA_NAO_E_FOLHA` | — | Não existe regra de folha: a raiz recebe lançamento |
| recusar lançamento em categoria `analitica = false` | recusá-lo nos **baldes** de receita e despesa | O gatilho impede exatamente o único uso do campo |
| raiz e "(direto)" como linhas somáveis | `realizado_proprio` × `total_agregado`, nomeados | É a única contagem dupla que a hierarquia permite |
| balde decidido pelo **sinal** do valor | balde decidido por `Categoria.natureza` | Pelo sinal, um estorno de despesa vira receita inventada |
| lista de baldes escrita à mão | resumo indexado pelo enum `Balde` | Foi uma lista à mão que perdeu um balde por uma revisão inteira |
| `Transferencia` de uma Conta para ela mesma | `ORIGEM_IGUAL_DESTINO` | Passa em toda invariante aritmética e produz extrato inexplicável |
| pernas de `Transferencia` com `settled_at` distintos | um `settled_at` para as duas | O Saldo geral perde o valor transferido por um dia |
| `Estorno` de um `Estorno` | Lancamento comum, mesma Categoria | Recobrança é fato novo; a cadeia torna a guarda recursiva e ilimitada |
| excluir o original deixando o estorno | excluir a cadeia inteira | Sobra o estorno solto e o saldo sobe do nada |
| `agora` lido dentro da consulta | `agora` como parâmetro do recorte | Listagem e resumo discordam de um balde sem nenhuma escrita |
| resto do rateio "na primeira parcela" | `ratear`: nas primeiras partes | Duas regras que somam certo e divergem R$ 0,03 em 7x |
| `consumo` obtido multiplicando por `valor` | `razaoEmBp`, uma divisão só | Multiplicar por `valor` negativo inverte a desigualdade do alerta |
| percentual formatado como gatilho de alerta | `consumo_bp` inteiro | Um centavo decide o alerta, e o número exibido tem de ser o mesmo que dispara |
| realizado global como soma líquida | soma por `Categoria.natureza` | Receita anula despesa e o teto global nunca estoura |
| `natureza` persistida no `Planejamento` | sinal de `valor` | Enum e sinal podem se contradizer — estado inválido representável |
| `pago: boolean` | `status` | Receita não é "paga", e o booleano apaga o estado `pendente` |
| `Conta.tipo` para decidir saldo ou sinal | `incluir_no_saldo_geral` · sinal do valor | Tipo é rótulo de relatório, nunca aritmética |
| "saldo geral" = soma de todas as contas | soma das que têm `incluir_no_saldo_geral` | O número principal do produto tem exceções por desenho |
| "conta conectada" como tipo de Conta | `Conta.origem = conectado` | Origem é procedência do dado, não classe de conta |
