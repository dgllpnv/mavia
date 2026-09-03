# ADR 0023 — O estorno de compra no cartão entra na fatura aberta, pela regra que já existe

**Estado:** proposto
**Data:** 2026-09-03
**Substitui:** nada. Complementa o ADR 0007 (bases temporais do cartão) e o 0005 (dinheiro e partida dobrada).
**Fecha:** pendência P-6.

---

## Contexto

`estornar` funciona para lançamento de conta e devolve zero linhas para lançamento de cartão. A causa imediata é banal — a função junta com `contas` para descobrir a moeda, e compra de cartão tem `cartao_id`, não `conta_id`. A interface hoje não oferece o botão e diz o porquê, em vez de oferecer um erro.

Mas a pendência foi registrada dizendo que **o que falta não é código**, e isso continua verdadeiro: é a decisão de **em qual fatura o crédito entra**. Uma compra de março é reembolsada em maio. Ela pertence à fatura de março, que já foi fechada e paga, ou à fatura aberta, que é onde o dinheiro de fato volta?

As duas respostas são defensáveis, produzem números diferentes no mês, e uma escolha silenciosa aqui vira divergência de saldo três meses depois.

### O que torna a pergunta difícil

O estorno tem **duas leituras legítimas e incompatíveis**, e cada uma é a resposta certa para uma pergunta diferente:

| Leitura | Pergunta que ela responde | Onde o crédito deveria cair |
|---|---|---|
| **Analítica** | "quanto eu gastei de verdade com aquela compra?" | na fatura da compra — março |
| **De caixa** | "quanto vou pagar neste mês?" | na fatura aberta — maio |

Quem defende março tem razão sobre o relatório por categoria: a despesa de março ficou menor do que o extrato diz, e mantê-la inflada distorce a análise daquele mês para sempre.

Quem defende maio tem razão sobre o dinheiro: **a administradora credita a fatura corrente**. Em maio o titular paga menos, e é isso que sai da conta dele.

---

## Decisão

### D1 · Não existe regra nova. Vale a regra 10.

**Um estorno de compra no cartão é um lançamento de cartão como outro qualquer, com sinal invertido — e a regra 10 do `CLAUDE.md` já diz em qual fatura ele cai:**

> Um lançamento entra na fatura cuja janela contém seu `posted_at`.

O `posted_at` do estorno é **a data em que o reembolso aconteceu**, não a da compra original. O reembolso de maio cai na fatura de maio porque é em maio que ele existe.

Isto não é uma escolha entre as duas leituras: é a constatação de que a pergunta "março ou maio?" pressupõe uma regra especial que não precisa existir. Inventá-la seria criar um segundo caminho de colocação de lançamento em fatura — e dois caminhos divergem.

**A consequência boa, e ela é o teste da decisão:** quando o reembolso chega **antes** de a fatura fechar — que é o caso mais comum, o do estorno de compra na mesma semana —, as duas leituras coincidem sozinhas. A compra e o crédito caem na mesma fatura, o total dela já sai líquido, e não há nada a reconciliar. Uma regra que só funciona no caso raro estaria errada.

### D2 · Fatura fechada não é reescrita. Nunca.

Esta é a razão pela qual março está fora de questão, e ela é mais forte que a preferência analítica.

`Fatura.total_centavos` **é o que o titular vai pagar**. A regra 8b faz o eixo caixa somar as faturas em aberto pelo total, no vencimento — é ele que alimenta o Saldo geral, a projeção e o `Objetivo`.

Creditar março produziria, em ordem:

1. o total da fatura de março cai;
2. `pago_centavos` continua sendo o que foi pago de verdade;
3. a fatura passa a ter **`pago > total`** — um pagamento a maior que nunca existiu no banco;
4. e a projeção de maio continua mostrando o titular pagando a fatura cheia, enquanto a administradora vai cobrar menos.

O item 4 é o que decide: **um número errado no eixo caixa**, que é o eixo que este produto protege com mais cuidado. Os itens 1 a 3 são só a contabilidade denunciando o mesmo erro mais cedo.

O ADR 0007 já estabeleceu o princípio para `data_compra`: ela é **imutável depois que qualquer parcela pertence a uma fatura fechada**. Uma fatura fechada é um fato consumado, e um fato consumado não se reescreve — nem o valor, nem a data.

### D3 · O vínculo analítico sobrevive, e é ele que paga a conta da leitura perdida

O estorno já grava `estorno_de_lancamento_id` apontando para o original. Esse vínculo **atravessa faturas** sem esforço nenhum.

Quer dizer que a leitura analítica não foi descartada: ela foi **adiada, com o dado preservado**. O relatório por categoria mostra hoje o que corresponde ao caixa — despesa em março, crédito em maio —, e no dia em que uma vista "líquido por compra" for pedida, ela é uma consulta sobre um vínculo que já existe, não um modelo novo.

Fosse o contrário — creditar março e perder a correspondência com o caixa —, o dado destruído seria irrecuperável: nada no banco diria que o dinheiro voltou em maio.

### D4 · `settled_at` do estorno é nulo até a fatura ser paga

Este é o segundo defeito, e ele estava escondido atrás do primeiro. A implementação atual de `estornar` grava `settled_at = posted_at` incondicionalmente — o `$5, $5` do `INSERT`.

Para lançamento de conta isso é aceitável: quem estorna informa que o dinheiro voltou. Para cartão é **a violação exata da regra 8**, e é o erro que o ADR 0007 já corrigiu uma vez, sob outro nome:

> `settled_at` só é escrito quando o dinheiro se move. Num lançamento de cartão, quem move dinheiro é o pagamento da fatura.

Um crédito de cartão com `settled_at` preenchido no ato entraria no realizado antes de a fatura ser paga — e, se a fatura for de um mês futuro, preencheria o realizado de um mês que ainda não chegou. É o defeito medido na auditoria do épico 3, reencenado no estorno.

**A regra:** o estorno de cartão nasce com `settled_at` nulo, e recebe a data pelo mesmo caminho que todos os outros lançamentos daquela fatura — a transação que marca a fatura como paga.

### D5 · O que muda no código

| O quê | Como |
|---|---|
| A moeda | vem de `cartoes`, e não de `contas`, quando o original é de cartão |
| `fatura_id` | pela **mesma** função que coloca qualquer compra numa fatura. Não há um segundo caminho |
| `settled_at` | nulo para cartão; preenchido para conta, como hoje |
| `estorno_de_lancamento_id` | inalterado — é ele que preserva a leitura analítica |
| A constraint `cartao_tem_fatura` | inalterada: o estorno tem `fatura_id`, e não é perna de transferência |
| O teto de estorno | inalterado: `Σ|estornos| ≤ |original|`, já implementado e testado |

**Nada disso exige migration.** O modelo já comporta a decisão — o que faltava era a decisão.

### D6 · O que continua proibido

- **Estornar a perna de um pagamento de fatura.** Já é recusado, e continua: desfazer uma perna criaria dinheiro. A transferência tem duas pernas e elas somam zero por construção (regra 4).
- **Estornar para uma fatura escolhida à mão.** Não existe parâmetro de fatura de destino. A fatura é derivada do `posted_at`, como em toda compra, e um parâmetro aqui seria o segundo caminho que a D1 recusa.
- **Estorno com `posted_at` anterior à compra original.** Um crédito antes da despesa não descreve nada real.

---

## Consequências

**O relatório por categoria de março continua mostrando a compra cheia.** É a leitura de caixa, e é a que corresponde ao extrato do cartão daquele mês. Quem quiser o líquido tem o vínculo — e terá a vista, quando ela for pedida.

**O caso comum fica trivial.** Reembolso na mesma janela cai na mesma fatura, e o total sai líquido sem que ninguém precise saber que existe um ADR sobre isso.

**A fatura fechada continua sendo um documento.** É a propriedade que permite ao titular conferir a fatura da Mavia contra a do banco, mês a mês, e encontrar diferença quando há diferença.

**O botão de estorno passa a existir na tela de detalhe de compra de cartão**, com a frase que explica onde o crédito vai cair — porque a pessoa que estorna uma compra de março e vê o crédito em maio precisa entender isso sem abrir um ADR.

---

## Alternativas rejeitadas

**Creditar a fatura da compra original.** Rejeitada pela D2: reescreve fatura fechada, produz `pago > total`, e deixa a projeção de caixa do mês corrente errada. O ganho — um relatório por categoria mais fiel — é obtido pelo vínculo de estorno, sem custo nenhum.

**Uma coluna `fatura_de_destino_id` no estorno, escolhida pelo usuário.** Rejeitada pela D1: cria um segundo caminho de colocação em fatura, e dois caminhos divergem. Além disso transfere ao titular uma decisão que a administradora do cartão já tomou por ele — ele não escolhe qual fatura recebe o crédito, ele **observa** qual recebeu.

**Estorno como categoria de receita.** Rejeitada por inflar receita e despesa ao mesmo tempo: o mês passaria a mostrar entrada de dinheiro que não houve. É o mesmo erro que a regra 12 evita ao tratar pagamento de fatura como transferência.

**Adiar de novo, esperando o épico de relatórios avançados.** Rejeitada porque o botão está desabilitado com uma frase de desculpa numa tela que o usuário visita para resolver um problema real, e porque a decisão não depende de nada que ainda não exista.
