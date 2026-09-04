# ADR 0025 — Preço-base e desconto pelo painel: o que sai do código e o que nunca sai

**Estado:** **aceita**
**Data:** 2026-09-04 · Pedida pelo dono do produto em 2026-09-04.
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

**Mecanismo: `Coupon` da Stripe**, aplicado à assinatura do cliente. Percentual ou valor fixo, com `duration` de `once` · `repeating(n meses)` · `forever`.

**A regra estrutural que impede a segunda verdade:**

```sql
stripe_coupon_id TEXT NOT NULL
```

Uma linha de desconto **não pode existir** sem o cupom que a Stripe criou. Não é uma validação que alguém pode esquecer de chamar — é uma coluna que o banco recusa. A ordem é: cria na Stripe, recebe o id, grava a linha. Se a Stripe falhar, não há linha; se a linha existe, a Stripe já cobra o valor descontado.

**O valor descontado não é calculado por nós.** Nós gravamos o cupom e o cliente; quanto sai da fatura é a Stripe que decide e o webhook que informa. Nenhuma multiplicação de percentual acontece no caminho do dinheiro — o que evita a pergunta de arredondamento inteira (regra 3 do `CLAUDE.md`) num lugar onde ela não teria uma resposta boa: 15% de R$ 199,90 é R$ 29,985.

> **O que exibimos antes de confirmar é estimativa, e é rotulada como tal.** A tela mostra *"≈ R$ 169,92 · valor final confirmado pela Stripe"*. Um número nosso apresentado como o valor cobrado seria a segunda verdade entrando pela porta da UI depois de ter sido barrada na do banco.

---

## D2 — O preço-base passa a ser editável pelo painel, e a edição é **criar**, nunca alterar

Tabela `precos_vigentes`, **append-only**, chave `(plano, intervalo, vigente_desde)`:

```sql
stripe_price_id TEXT NOT NULL
```

A mesma trava da D1, pela mesma razão. Não existe linha de preço sem o `Price` que a Stripe criou. Trocar o preço do Pessoal mensal escreve uma **linha nova**; a anterior permanece, porque as assinaturas que apontam para ela continuam existindo.

**Três propriedades que a forma append-only dá de graça:**

1. **Retroatividade é irrepresentável.** Não há `UPDATE` a executar — a madrugada de que a D3 tem medo não tem instrução disponível. O pior erro possível é criar um preço errado para vendas futuras, que se corrige criando outro.
2. **O grandfathering deixa de depender de disciplina.** A D3 já o exigia (*"`Assinatura` guarda `plano_versao` e mantém o preço contratado até migração explícita e comunicada"*). Com o `Price` imutável da Stripe do outro lado, quem contratou a R$ 35 continua a R$ 35 **porque não existe operação que o mude** — não porque alguém lembrou de não mexer.
3. **O histórico de preço é o próprio dado.** "Quanto custava o Família em março?" é um `SELECT`, e não uma arqueologia de `git log`.

**O catálogo em código não morre — muda de papel.** Ele continua declarando as **cotas** (D3 intacta), os nomes, o `disponivelParaCompra`, e o **preço de origem**: os seis valores da DP-41, que são o que vale enquanto a tabela estiver vazia e o que a migration usa para semear a primeira linha de cada par. Um sistema sem Stripe configurada continua tendo preço, e continua sendo testável sem banco.

### O que substitui o portão de revisão

Quatro coisas, e nenhuma delas é um aviso na tela:

| | Controle |
|---|---|
| **Auditoria** | Linha em `auditoria` com `de` → `para`, operador, motivo e correlação. O mesmo caminho de toda escrita financeira do painel |
| **Confirmação com o antes e o depois** | A tela exige que o operador leia o valor atual, o novo, e a contagem de assinaturas afetadas — que é **sempre zero**, e dizer isso em voz alta é metade do controle |
| **A Stripe primeiro** | Se a chamada à Stripe falhar, nada é gravado. O operador não consegue produzir um preço que só existe do nosso lado |
| **`disponivelParaCompra` continua em código** | Fechar ou abrir um nível de plano **não** é operação de painel. É a decisão da §2.6 da spec, e ela merece o portão inteiro |

### O que esta ADR **não** autoriza

- **Mexer em cota pelo painel.** A D3 vale inteira para cotas. Não há rota, não há coluna, não há tela.
- **Mudar o preço de uma assinatura viva.** Nem por edição, nem por "aplicar a todos". Migrar cliente para preço novo é operação comunicada, com aviso prévio, e não existe neste épico.
- **Preço abaixo de zero ou desconto acima de 100%.** Recusa no banco (`CHECK`) e no domínio, não só na tela.
- **Trocar a moeda.** `BRL` é `NOT NULL DEFAULT 'BRL'` e não há caminho que a mude. Moeda diferente é plano diferente.

---

## D3 — A parte que está bloqueada, e por quê

**Nada disto funciona hoje, e a razão não é o código.** Não existe cliente Stripe de saída na base: `apps/api/src/cobranca/cobranca.controller.ts` implementa e testa o **webhook de entrada**, e é tudo. Não há SDK, não há chave, não há conta.

As duas travas `NOT NULL` desta ADR são deliberadas quanto a isso: elas fazem com que a ausência da Stripe se manifeste como **impossibilidade de criar a linha**, e não como uma linha órfã que parece funcionar. Enquanto a conta não existir, a tela de preço mostra o catálogo e recusa a escrita com uma mensagem que nomeia o que falta.

Ordem de construção, em consequência:

| | O que | Bloqueio |
|---|---|---|
| 1 | `Desconto` em `packages/domain` — as regras de dinheiro, puras e provadas por propriedade | **nenhum** |
| 2 | Migrations, funções `admin.*`, telas | **nenhum** para escrever; a escrita real espera o item 3 |
| 3 | Cliente Stripe de saída (`criarPreco`, `criarCupom`, `aplicarCupom`) | **conta Stripe** — §4 de `docs/o-que-depende-de-voce.md` |

O item 3 é o mesmo bloqueio da condição **C-11** e da DP-39. Três pedidos diferentes esperando a mesma conta.

---

## Consequências

- A ADR 0020 **D3 continua válida para cotas** e passa a valer, para preço, apenas como *origem* — o valor que vale antes de existir tabela e o que semeia a primeira linha.
- `packages/domain/src/catalogo.ts` deixa de ser a única resposta a "quanto custa o Pessoal". A resposta passa a ser uma função da camada de aplicação que lê a tabela e cai no catálogo quando ela está vazia. **O domínio continua puro**; quem consulta banco é quem sempre consultou.
- A §2.4 da spec de planos ganha um segundo leitor: os descontos anuais herdados da DP-41 (52,4% · 25,9% · 27,5%) deixam de ser um acidente e passam a ser um número que o painel pode mover.
- **O risco que fica registrado, sem re-litígio:** com o preço editável, a política de reembolso da §6.3 passa a depender de um valor que muda. A fórmula usa `preco_mensal_do_plano`; se o preço-base mudou depois da compra, ela precisa usar o preço **contratado**, não o vigente. Isso é um ticket, e está nomeado no épico.
