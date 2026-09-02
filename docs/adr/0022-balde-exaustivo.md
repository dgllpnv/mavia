# ADR 0022 — `Balde` como enum fechado e exaustivo em `domain/agregacao`

- **Status:** Aceita
- **Data:** 2026-09-02
- **Autor:** `arquiteto-dominio-financeiro`
- **Origem:** proposta do `validador-financeiro`, bateria do épico 2 §8.1. **Aceita com três emendas.**
- **Fecha:** lacuna **L2**. Depende da decisão do **ADR 0021**.
- **Toca:** `packages/domain/agregacao` · `packages/contracts/filtro-lancamentos` · `apps/api/src/agregacao/` · `docs/arquitetura/sistema.md` §4.1/§4.4 (do `arquiteto-solucao`).

## Contexto

Três defeitos do épico 2 têm a mesma assinatura: **uma grandeza que altera o saldo sem ter balde no rodapé.**

| Defeito | Grandeza sem balde | Custo na tela |
|---|---|---|
| B1 (auditoria anterior) | perna de `Transferencia` | R$ 300,00 na lista e não no rodapé |
| RP-4 | `pendente` no eixo caixa | `1.000 + (−100) = 1.000` |
| RP-5 / SD-10 | `analitica = false` | R$ 300,00 de divergência contra o saldo derivado |

O balde de transferência foi criado depois de B1. Os outros dois não foram — e a razão é estrutural: os baldes são **seis campos nomeados à mão** numa interface, e `sistema.md` §4.1 prometia sete enquanto o SQL do §4.4 entregava seis. Ninguém contou. Uma lista escrita à mão não sabe quando está incompleta.

O `validador-financeiro` propôs a correção certa:

> A correção não é somar mais um `CASE`. É `domain/agregacao` declarar o `Balde` como **enum fechado e exaustivo**, com o compilador exigindo que todo lançamento caia em exatamente um. Um lançamento sem balde tem de ser erro de tipo, não divergência descoberta em produção.

## Decisão

**Aceita.** Com três emendas, sem as quais a proposta não entrega o que promete.

### O enum

```ts
export type Balde = 'receita' | 'despesa' | 'transferencia' | 'nao_analitica'
```

Quatro valores. Não sete: o validador contou os *campos do resumo*, que são o produto cartesiano `Balde × {realizada, prevista}` mais `saldoAnterior` — nove, não sete. Contar campos é o que perdeu o balde da vez passada.

### A função de classificação, total

```ts
export function baldeDe(l: LancamentoClassificavel): Balde {
  if (l.transferGroupId !== null) return 'transferencia'
  if (!l.categoria.analitica) return 'nao_analitica'
  return l.categoria.natureza === 'receita' ? 'receita' : 'despesa'
}
```

Sem `null`, sem `undefined`, sem `default`, sem `throw`. Ela é **total**, e a totalidade não é uma promessa: decorre de duas invariantes já escritas do `Lancamento` —

> `categoria_id` é obrigatório, exceto em perna de `Transferencia`, onde é obrigatoriamente nulo.

— que tornam os dois primeiros testes mutuamente exclusivos e o terceiro alcançável sempre. `LancamentoClassificavel` carrega `categoria: { analitica, natureza }` como campo **não anulável**, e é a assinatura que impede a chamada com uma perna carregada sem categoria. O tipo é a prova; a leitura do banco faz o `JOIN` porque o tipo exige.

### Emenda 1 — a partição é por `natureza`, nunca pelo sinal

`apps/api/src/agregacao/agregacao.ts` particiona hoje por `valor_centavos > 0` / `< 0`. Está errado e a bateria já registra o número: um `Estorno` de R$ 100,00 numa categoria de despesa é positivo e vira `receita_realizada = +10000`, com `despesa_realizada = −10000` — receita inventada, e uma despesa maior do que o Usuario gastou (ES-1).

O sinal governa a **soma**. A `Categoria.natureza` governa o **balde**. É a mesma regra que o ADR 0008 já fixou para o realizado do `Planejamento`, e ela vale em todo agregado, não só lá.

### Emenda 2 — o resumo é **indexado pelo enum**

Um enum exaustivo não conserta nada se o resumo continuar sendo campos nomeados à mão: `baldeDe` seria exaustiva e `BaldesDoPeriodo` continuaria podendo esquecer um. A exaustividade precisa **propagar até a forma do resumo**:

```ts
export type Valores = { readonly realizada: Money; readonly prevista: Money }

export interface ResumoDoPeriodo {
  readonly saldoAnterior: Money
  readonly baldes: Readonly<Record<Balde, Valores>>   // não seis campos soltos
  readonly saldo: Money
  readonly projetado: Money
}
```

Com `Record<Balde, _>`, acrescentar um valor ao enum vira **erro de compilação em todo lugar que constrói um resumo** — a API, o contrato, o SQL que o preenche, o web, o mobile. Com campos soltos, acrescentar um valor ao enum compila em silêncio e o rodapé volta a mentir por desenho. Esta emenda é o que transforma a proposta de convenção em garantia.

E o cálculo deixa de listar os baldes:

```ts
saldo     = saldoAnterior + Σ_{b ∈ Balde} baldes[b].realizada
projetado = saldo         + Σ_{b ∈ Balde} baldes[b].prevista
```

`identidadeDoResumo` deixa de existir como verificação. Ela era uma soma escrita à mão conferindo outra soma escrita à mão — e as duas listas divergem exatamente na hora em que a verificação seria útil. A identidade passa a ser **verdadeira por construção**.

### Emenda 3 — o universo vem antes da partição

Os quatro baldes são disjuntos e exaustivos **sobre o universo da consulta**, e o universo é `(eixo, escopo)`, fixado *antes*. Ficam **fora do universo**, e por isso não são baldes:

| Fora do universo | Por quê |
|---|---|
| `deleted_at IS NOT NULL` | Excluído não é uma classe de dinheiro, é ausência de dinheiro. Como balde, poderia ser somado por engano — e a linha existe justamente para nunca somar. |
| `Lancamento` de `Cartao`, no eixo caixa | Regra 8b: compra de cartão não sai do bolso. Quem sai é a `Fatura`. |
| `Fatura` em aberto, no eixo caixa | **Não é `Lancamento` e não tem balde.** É um segundo somatório, disjunto, pelo total no vencimento. |

Sem esta emenda, o épico 3 tenta transformar "cartão" num quinto balde, e o eixo caixa volta a somar compra e fatura — a dupla contagem que o `CONTEXT.md` chama de erro clássico da categoria.

### A propriedade que se testa

Não é a identidade do rodapé. É a exaustividade, que é mais forte e da qual a identidade decorre:

```
∀ recorte:  Σ_{b ∈ Balde} (baldes[b].realizada + baldes[b].prevista)  =  Σ lançamentos do universo
```

Property-based, com `fast-check`, sobre conjuntos gerados que incluam pernas, estornos e categorias não analíticas. Nenhuma linha em dois baldes, nenhuma linha em nenhum. E um teste de arquitetura: `SUM(` só existe em `apps/api/src/agregacao/`, como `sistema.md` §2.5 já exige.

## Consequências

**Fecha L2.** O balde `nao_analitica` existe, `Ajuste de saldo` reaparece no rodapé, e SD-10 volta a fechar: `100000 + 300000 − 50000 + 0 − 30000 = 320000`, contra o saldo derivado, exato.

**Reprova o SQL atual.** Os `FILTER` por sinal viram `FILTER` por natureza, o que exige `JOIN categorias`. Custo real, benefício maior: é o mesmo `JOIN` que o balde `nao_analitica` exige de qualquer forma.

**Quebra `BaldesDoPeriodo` em `packages/domain`.** É mudança de tipo público consumida por API, web e mobile. Feita agora, no início do épico 3, custa uma rodada de `typecheck`; feita no épico 5, atravessa `Planejamento`, relatórios e as duas telas principais.

**Acrescentar um balde passa a ser barato e seguro.** Se o épico 3 concluir que a `Fatura` precisa de representação própria no rodapé, o valor entra no enum e o compilador aponta cada lugar que precisa responder. É a diferença entre uma decisão de modelagem e uma caçada.

**O risco que sobra.** `analitica` e `natureza` viram entrada de uma função de domínio pura, e quem lê do banco precisa trazê-las. Uma leitura que as omita não compila — é o ponto —, mas uma que as traga **erradas** (categoria de outro tenant, por exemplo) classifica errado em silêncio. A defesa é a RLS, não o tipo, e isso está declarado aqui para não ser descoberto depois.

## Alternativas rejeitadas

**Somar um sétimo `CASE` ao SQL.** É o que a proposta do validador recusa, e com razão: conserta este defeito e deixa a classe de defeito intacta. Foi assim que B1 foi corrigido e RP-4 e RP-5 nasceram.

**Enum exaustivo com o resumo em campos nomeados à mão** — a proposta sem a emenda 2. `baldeDe` seria exaustiva e o resumo continuaria podendo esquecer um balde, que é literalmente o defeito que estamos corrigindo. Meia correção que se parece com a correção inteira é pior que nenhuma.

**`excluido` como quinto balde.** Rejeitada na emenda 3: representar ausência de dinheiro como uma classe de dinheiro convida a somá-la.

**Balde derivado do sinal, com uma exceção para estorno.** É o `if` que o domínio abole em todo lugar. E a exceção teria de ser reescrita em cada superfície — que é a definição de `AND` repetido, proibido pela regra 12b.
