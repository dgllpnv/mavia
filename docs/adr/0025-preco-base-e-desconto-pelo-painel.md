# ADR 0025 — Preço-base e desconto pelo painel: o que sai do código e o que nunca sai

**Estado:** **aceita**, **emendada em 2026-09-05**
**Data:** 2026-09-04 · Pedida pelo dono do produto em 2026-09-04.
**Emenda de 2026-09-05:** a **D3** dizia que tudo esperava a conta Stripe. **Estava errada**, e a pergunta que a derrubou foi do dono: *"precisa mesmo do Stripe para fazer esta função?"* Ver a D3 reescrita.
**Emenda:** `docs/adr/0020-billing-e-assinatura.md` **D3** (catálogo em código). Não a substitui — recorta uma metade dela.
**Depende de:** **DP-39** (o painel escreve na Stripe e espera o webhook) e **DP-41** (preços alinhados ao Organizze).

---

## Contexto

O dono do produto pediu, no painel de administração, *"uma opção que troca os valores base dos planos ou adiciona descontos"*.

Duas normas aceitas dizem que isso não pode existir como pedido:

| Norma | Texto | O que o pedido faz |
|---|---|---|
| ADR 0020 **D3** | *"O catálogo de planos vive em código, não em tabela. Uma tabela de planos permite que alguém mude uma cota — ou um preço — sem revisão, sem migração e sem que nenhum teste perceba."* | Põe o preço numa tabela editável em produção |
| **DP-39** | *"O painel escreve na Stripe e espera o webhook"* — é a única alternativa que não cria uma segunda verdade sobre quanto o cliente paga | Um número editado só do nosso lado é exatamente a segunda verdade |

E um fato mecânico decide mais do que as duas normas juntas:

> **Um `Price` da Stripe é imutável.** Não existe operação que mude o valor de um preço existente. Trocar um preço é **criar outro** `Price` e arquivar o antigo. As assinaturas vivas continuam apontando para o `Price` velho até serem explicitamente migradas.

Isso significa que um número editado numa tabela nossa **não muda o que é cobrado de ninguém**. Ele muda a vitrine, e só. Uma tela de "trocar preço" que grave apenas em `precos.valor_centavos` produziria o pior resultado possível: a página de preços anuncia R$ 39, a Stripe cobra R$ 45, e a diferença aparece na fatura do cliente.

### O argumento da D3, examinado nas duas metades

A D3 defende **cotas e preço** com a mesma frase. As duas metades não são iguais.

**Cotas.** O argumento é integralmente válido e nada aqui o toca. `cotasVigentes(estado, plano)` é função pura, testável sem banco, e é o que decide se um convite passa ou é recusado. Uma cota editada em produção muda o comportamento do produto para todo mundo, imediatamente, sem que nenhum teste perceba. **Cotas não saem do código, e esta ADR reafirma isso.**

**Preço.** Aqui o argumento já é mais fraco do que parecia quando a D3 foi escrita, e a razão é a DP-39: **o preço no código já é uma cópia.** A verdade sobre quanto um cliente paga está no `Price` da Stripe ao qual a assinatura dele aponta. `PLANOS.pessoal.mensal` é o que a nossa vitrine anuncia e o que o catálogo espelha — não é o que o cartão é debitado. A D3 protege a pureza de um valor que **não é a fonte de verdade dele mesmo**.

O que a D3 protege de fato, no caso do preço, é o **portão de revisão**: `pnpm typecheck && pnpm test`, revisão de código, deploy. Esse portão é real e vale muito. A pergunta desta ADR não é "código ou tabela"; é **o que substitui o portão** quando o gatilho passa a ser um clique.

---

## D1 — Desconto por cliente sai do catálogo e entra no painel

Desconto **nunca** foi plausível como código. Ele é por cliente, por negociação, por circunstância — "esse assinou na primeira semana", "esse ficou três dias sem acesso por culpa nossa", "esse é o meu primo". Nada disso versiona.

**Forma:** percentual em **pontos-base inteiros** (15% é `1500`) ou quantia fixa, com duração `uma_vez` · `meses(n)` · `sempre`. É a forma do `Coupon` da Stripe de propósito — quando ela existir, cada desconto vira um cupom sem tradução.

```sql
stripe_coupon_id TEXT          -- anulável. Ver a D3 reescrita.
```

> **A versão original desta seção exigia `NOT NULL` aqui**, e chamava isso de "a regra estrutural que impede a segunda verdade". A D3 reescrita explica por que estava errada: sem cobrança nenhuma no sistema, um desconto sem cupom não é segunda verdade — é a única. A trava mudou de lugar, não sumiu: **abrir uma assinatura na Stripe com desconto ativo sem cupom é recusado**.

**O valor descontado não é calculado por nós quando a Stripe existir** — quanto sai da fatura é ela que decide e o webhook que informa. `packages/domain/src/desconto.ts` produz **estimativa**, e a tela a rotula: *"≈ R$ 169,92 · valor final confirmado pela Stripe"*. Nenhuma multiplicação de percentual entra no caminho do dinheiro; a pergunta de arredondamento (regra 3) fica confinada a um número que a tela chama de aproximado — e ainda assim é provada por propriedade, porque uma estimativa errada por um centavo faz o operador conferir a fatura e concluir que a fatura está errada.

---

## D2 — O preço-base passa a ser editável pelo painel, e a edição é **criar**, nunca alterar

Tabela `precos_vigentes`, **append-only**, chave `(plano, intervalo, vigente_desde)`:

```sql
stripe_price_id TEXT           -- anulável. Ver a D3 reescrita.
```

Trocar o preço do Pessoal mensal escreve uma **linha nova**; a anterior permanece, porque assinaturas apontam para ela. O `stripe_price_id` é preenchido quando existir Stripe — e enquanto não existir, a linha sem ele **é o preço que vale**, porque não há outro.

**Três propriedades que a forma append-only dá de graça:**

1. **Retroatividade é irrepresentável.** Não há `UPDATE` a executar — a madrugada de que a D3 tem medo não tem instrução disponível. O pior erro possível é criar um preço errado para vendas futuras, que se corrige criando outro.
2. **O grandfathering não depende de disciplina.** A D3 da ADR 0020 já o exigia (*"`Assinatura` guarda `plano_versao` e mantém o preço contratado até migração explícita e comunicada"*). Sendo a tabela append-only, quem contratou a R$ 35 continua a R$ 35 **porque não existe instrução que altere aquela linha** — e não porque alguém lembrou de não mexer. Quando a Stripe entrar, o `Price` imutável dela reforça a mesma propriedade do outro lado.
3. **O histórico de preço é o próprio dado.** "Quanto custava o Família em março?" é um `SELECT`, e não uma arqueologia de `git log`.

**O catálogo em código não morre — muda de papel.** Ele continua declarando as **cotas** (D3 intacta), os nomes, o `disponivelParaCompra`, e o **preço de origem**: os seis valores da DP-41, que são o que vale enquanto a tabela estiver vazia e o que a migration usa para semear a primeira linha de cada par. Um sistema sem Stripe configurada continua tendo preço, e continua sendo testável sem banco.

### O que substitui o portão de revisão

Quatro coisas, e nenhuma delas é um aviso na tela:

| | Controle |
|---|---|
| **Auditoria** | Linha em `auditoria` com `de` → `para`, operador, motivo e correlação. O mesmo caminho de toda escrita financeira do painel |
| **Confirmação com o antes e o depois** | A tela exige que o operador leia o valor atual, o novo, e a contagem de assinaturas afetadas — que é **sempre zero**, e dizer isso em voz alta é metade do controle |
| **A Stripe primeiro — quando ela existir** | Com a conta configurada, o `Price` é criado antes da linha: se a chamada falhar, nada é gravado. Sem conta, a linha é gravada sozinha e **a venda é que fica bloqueada** (D3) |
| **`disponivelParaCompra` continua em código** | Fechar ou abrir um nível de plano **não** é operação de painel. É a decisão da §2.6 da spec, e ela merece o portão inteiro |

### O que esta ADR **não** autoriza

- **Mexer em cota pelo painel.** A D3 vale inteira para cotas. Não há rota, não há coluna, não há tela.
- **Mudar o preço de uma assinatura viva.** Nem por edição, nem por "aplicar a todos". Migrar cliente para preço novo é operação comunicada, com aviso prévio, e não existe neste épico.
- **Preço abaixo de zero ou desconto acima de 100%.** Recusa no banco (`CHECK`) e no domínio, não só na tela.
- **Trocar a moeda.** `BRL` é `NOT NULL DEFAULT 'BRL'` e não há caminho que a mude. Moeda diferente é plano diferente.

---

## D3 — Nada disto espera a Stripe *(reescrita em 2026-09-05)*

> **A versão anterior desta seção dizia o contrário**, e o erro fica registrado em vez de apagado. Ela afirmava que as duas travas `NOT NULL` faziam a ausência da Stripe "se manifestar como impossibilidade de criar a linha", e tratava isso como virtude. O dono do produto perguntou se a função precisava mesmo da Stripe. Não precisa.

### O erro, nomeado
A invariante que a ADR protege é uma só:

> **nenhum cliente é cobrado um valor diferente do que a gente mostra.**

Eu a codifiquei como *"não existe linha de preço sem um `Price` da Stripe"*. As duas são equivalentes **apenas quando a Stripe é quem cobra**. Hoje ela não é — e não é por pouco:

- não existe cliente Stripe de saída na base (só o webhook de entrada);
- **não existe tabela `cobrancas`**, nem qualquer migration que a crie;
- nenhuma assinatura tem `stripe_subscription_id`, porque nenhuma foi criada.

**Ninguém é cobrado coisa nenhuma.** Nesse mundo, a nossa tabela não é uma segunda verdade sobre o preço: ela é a **única**. A `NOT NULL` bloqueia uma função que funcionaria, para impedir uma divergência que não tem como acontecer.

É o erro clássico de encodar a invariante no lugar mais fácil de escrever em vez do lugar onde o dano mora.

### Onde a trava vai, em vez de onde estava
O dano não é *"existe linha de preço sem `Price` da Stripe"*. O dano é **cobrar por ela**: abrir um checkout com um preço que a Stripe desconhece, ou com um desconto que ela não vai aplicar. A trava, portanto, é na **venda**, não na criação:

| | Antes (errado) | Agora |
|---|---|---|
| `precos_vigentes.stripe_price_id` | `NOT NULL` | **anulável** |
| `descontos_de_cliente.stripe_coupon_id` | `NOT NULL` | **anulável** |
| Onde a Stripe é exigida | ao criar a linha | **ao iniciar uma cobrança** |

A guarda vira uma só, no épico 11: uma assinatura da Stripe **não pode ser aberta** para um preço vigente sem `stripe_price_id`, nem para um espaço com desconto ativo sem `stripe_coupon_id`. Ela **recusa em voz alta** em vez de cobrar errado.

Isso é estritamente melhor do que a versão anterior: a função existe hoje, e o dano continua impossível.

### O risco de segunda ordem, e por que ele está coberto
Um desconto criado hoje, sem cupom, **não se aplicaria sozinho** quando a Stripe chegar. Silenciosamente, o cliente pagaria cheio.

É exatamente o que a guarda acima impede: ao abrir a assinatura, o desconto ativo sem cupom **bloqueia a abertura** até que o cupom seja criado. Falha ruidosa, na hora certa, no único lugar que sabe o suficiente para decidir.

E há um segundo dever, de mão única: quando a conta Stripe existir, a entrada em produção do épico 11 precisa **criar um `Price` para cada linha vigente** antes de vender qualquer coisa. Isso é passo de implantação, não de migration — está registrado no ticket 15.

### Ordem de construção, corrigida

| | O que | Bloqueio |
|---|---|---|
| 1 | `Desconto` em `packages/domain` | **nenhum** — ✅ feito |
| 2 | Tabelas, funções `admin.*`, rotas e telas | **nenhum** |
| 3 | Cliente Stripe de saída + a guarda de venda | **conta Stripe** |

Só o item 3 espera, e ele é do épico 11 — não desta ADR. **A troca de preço e o desconto pelo painel funcionam sem Stripe nenhuma**, porque hoje o preço que vale é o nosso.

---

## Consequências

- A ADR 0020 **D3 continua válida para cotas** e passa a valer, para preço, apenas como *origem* — o valor que vale antes de existir tabela e o que semeia a primeira linha.
- `packages/domain/src/catalogo.ts` deixa de ser a única resposta a "quanto custa o Pessoal". A resposta passa a ser uma função da camada de aplicação que lê a tabela e cai no catálogo quando ela está vazia. **O domínio continua puro**; quem consulta banco é quem sempre consultou.
- A §2.4 da spec de planos ganha um segundo leitor: os descontos anuais herdados da DP-41 (52,4% · 25,9% · 27,5%) deixam de ser um acidente e passam a ser um número que o painel pode mover.
- **O risco que fica registrado, sem re-litígio:** com o preço editável, a política de reembolso da §6.3 passa a depender de um valor que muda. A fórmula usa `preco_mensal_do_plano`; se o preço-base mudou depois da compra, ela precisa usar o preço **contratado**, não o vigente. Isso é um ticket, e está nomeado no épico.
