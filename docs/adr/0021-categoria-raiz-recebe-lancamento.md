# ADR 0021 — A categoria-raiz recebe lançamento, e `analitica` não é "é folha"

- **Status:** Aceita
- **Data:** 2026-09-02
- **Autor:** `arquiteto-dominio-financeiro`
- **Fecha:** lacuna **L3** da bateria do épico 2 (cenário CAT-1), e desfaz o nó que ela tem com **L2** (cenários SD-10 e RP-5).
- **Toca:** `CONTEXT.md` (**Categoria**, **Balde**) · migration `0006_nucleo.sql` (gatilho `lancamento_coerente`) · relatório por categoria · importador do épico 8.

## Contexto

A bateria de aceite do épico 2 registrou uma contradição entre dois documentos aceitos:

> *"Só folha recebe lançamento" não está escrito em `CONTEXT.md` nem no esquema, e o cenário 4.5 da auditoria anterior — homologado ✅ — usa "Alimentação (raiz) −40000" como realizado próprio da raiz, ou seja, assume o contrário.*

Três fontes, três respostas:

| Fonte | Diz |
|---|---|
| `CONTEXT.md` (**Categoria**) | três invariantes de hierarquia, **nenhuma** sobre quem recebe lançamento |
| `docs/validacao/auditoria-financeira-spec.md` §4.5, homologado | a raiz **recebe** — `Alimentação (raiz) −40000` fecha a soma dos escopos |
| migration `0006_nucleo.sql` | a raiz **não** recebe — comentário e gatilho |

Uma regra que existe em três lugares com dois valores não é uma regra. E o desempate não podia ser "o código já escolheu", porque o código escolheu **por um caminho errado**, que é o achado central deste ADR.

### O que o código realmente fez: dois conceitos sob um booleano

O comentário da coluna, em `0006_nucleo.sql`, é literal:

```sql
  -- Só folha recebe lançamento. É `CHECK`, não convenção: uma categoria-pai
  -- que aceita lançamento faz a soma da árvore contar o mesmo dinheiro duas
  -- vezes, e a divergência aparece só no relatório.
  analitica     BOOLEAN NOT NULL DEFAULT TRUE,
```

E o gatilho `lancamento_coerente` recusa qualquer lançamento em categoria com `analitica = false`, com `CATEGORIA_NAO_ANALITICA`.

Mas `analitica` **já tinha um significado no glossário**, e não é esse:

> `analitica` — Categoria **não analítica** classifica lançamentos que não são fato econômico e é excluída de todo relatório de gasto e de todo `Planejamento`. Hoje há uma: **`Ajuste de saldo`**.

São duas regras ortogonais empilhadas num booleano só:

- **(a)** *não é fato econômico* — sai dos relatórios, entra no saldo. É o glossário.
- **(b)** *tem filhas* — não recebe lançamento. É o comentário do esquema.

A consequência é aritmética e imediata: **`Ajuste de saldo` nasce `analitica = false` e o gatilho recusa todo lançamento nela.** A única categoria para a qual o campo foi criado é a única em que ele é inalcançável. Os cenários SD-10, RP-5 e a linha `U` de ST-1 — os três que provam a lacuna L2 — não são representáveis no esquema do épico 2. O sétimo balde nunca foi escrito porque nada podia cair nele.

Hoje isso não produziu incidente porque nada no código cria categoria não analítica: `analitica` é `DEFAULT TRUE`, nenhuma migration semeia `Ajuste de saldo`, e o ramo do gatilho é código morto. O custo de corrigir é o de agora; o de descobrir no épico 5, com `Planejamento` no ar, seria outro.

## Decisão

**1. `analitica` significa exatamente uma coisa: o lançamento não é fato econômico.** Não diz nada sobre posição na árvore. Categoria não analítica **recebe** lançamento — o gatilho que a recusa é removido, e a exclusão passa a acontecer no balde, que é onde ela sempre pertenceu.

**2. Não existe regra de folha.** Raiz com filhas, raiz sem filhas e subcategoria recebem lançamento igualmente. Nenhum `CHECK`, gatilho ou rota deriva o direito de lançar da presença de subcategorias. `CATEGORIA_NAO_E_FOLHA` não existe.

**3. O relatório por categoria distingue `realizado_proprio` de `total_agregado`**, com `total_agregado(c) = realizado_proprio(c) + Σ total_agregado(filhas)`. Nenhuma superfície as exibe como linhas irmãs somáveis: ou a lista é de agregados, ou é de próprios. Na UI, o próprio de uma raiz com filhas é a linha **"Casa (direto)"**, irmã das subcategorias.

**4. `analitica = false` continua fora dos baldes `receita` e `despesa`, do relatório de gasto e do `Planejamento`** — e ganha o balde `nao_analitica`, definido no ADR 0022. É o que faz a identidade do rodapé voltar a fechar contra o saldo derivado.

## Por quê

### A leitura estrita não tem resposta para a árvore que cresce

O argumento a favor de "só folha recebe" é a contagem dupla. Ele é real, e a decisão 3 o fecha inteiro — a contagem dupla vem de **exibir próprio e agregado como irmãos**, não de a raiz receber lançamento.

O argumento contra é que a leitura estrita não tem saída não-destrutiva para a operação mais comum de uma árvore de categorias pessoal:

> *"Uso `Casa` há seis meses. Agora quero separar `Luz` e `Água`."*

No instante em que a primeira subcategoria nasce, todo o histórico da raiz vira ilegal. As três saídas possíveis:

| Saída | Custo |
|---|---|
| Recusar a criação da subcategoria | O produto proíbe o Usuario de organizar as próprias categorias |
| Reclassificar o histórico sozinho | O relatório de março muda depois de fechado — o defeito que CAT-3 existe para impedir |
| Deixar as linhas antigas violando a regra | Não é invariante, é validação de escrita com exceções legadas: o pior dos três, porque toda consulta passa a ter de lidar com o caso que a regra jurava não existir |

**A raiz precisa poder guardar o que estava lá antes de os galhos existirem.** Isso não é conveniência de UI: é a única forma de a árvore ser editável sem reescrever o passado.

### A migração de quem vem de outro produto

O Organizze permite lançar na categoria-mãe (teardown §7), e Mobills também. Um Usuario que migra chega com `Alimentação −400,00` direto na raiz. Sob a leitura estrita, o importador do épico 8 tem três caminhos, e **nenhum deles evita a linha "(direto)"** — apenas escolhe um lugar pior para ela:

- **Recusar a importação** — inaceitável; é o primeiro contato do Usuario com o produto.
- **Criar uma subcategoria sintética `Alimentação (geral)`** — é a linha "(direto)", só que persistida como Categoria real que o Usuario nunca criou, aparece em todo seletor para sempre, e ele pode renomeá-la, arquivá-la ou reparentá-la. A árvore de "exatamente dois níveis" passa a ter uma folha fantasma por raiz.
- **Jogar em `Sem categoria`** — os R$ 400,00 somem de `Alimentação`, e o relatório do Usuario deixa de bater com o do produto de onde ele veio, no primeiro mês.

A leitura estrita não economiza a linha "(direto)": ela a transforma numa entidade persistida, editável e mentirosa. A leitura permissiva a mantém onde ela é verdade — uma projeção de relatório, derivada, que não existe no banco.

### E o cenário 4.5 continua homologado

A Leitura B é a que a auditoria já homologou. Escolher a estrita exigiria re-litigar um cenário aceito e refazer a aritmética de precedência de escopos do ADR 0008 — cujos números, conferidos com `Alimentação (raiz) −40000`, fecham exatamente. Coerência com decisão aceita não é o argumento principal, mas quando ela aponta para o mesmo lado dos dois anteriores, é sinal de que a leitura estrita foi um acidente de implementação, não uma escolha.

## Consequências

**Muda no esquema.** O ramo `IF NOT v_analitica THEN RAISE 'CATEGORIA_NAO_ANALITICA'` sai de `lancamento_coerente`, por migration **nova** — migrations são forward-only. Nenhum dado precisa ser corrigido: nada hoje viola a regra nova, porque a regra velha só bloqueava linhas que ninguém conseguiu criar. O comentário da coluna `analitica` é reescrito com o significado do glossário.

**Muda no gatilho de sinal.** A checagem `natureza × sinal` de `lancamento_coerente` roda hoje para toda categoria com `estorno_de_lancamento_id IS NULL`. Ela **não deve rodar** para categoria não analítica: `Ajuste de saldo` não tem natureza econômica e um ajuste pode ser de qualquer sinal. A categoria de sistema precisa de uma `natureza` no esquema porque a coluna é `NOT NULL`; o valor é irrelevante e nada pode derivar dele.

**Muda no relatório por categoria.** Ganha `realizado_proprio` ao lado de `total_agregado`, e a invariante-ponte de CAT-2 passa a ser conferida contra a soma dos agregados das raízes. CAT-2 é reescrito com um lançamento direto na raiz, senão não exercita a decisão.

**Muda em CAT-1.** `POST /lancamentos` com `categoria_id = Casa` passa a ser **aceito**. O cenário deixa de esperar `422`.

**Muda na UI.** Toda superfície hierárquica declara qual das duas grandezas exibe. A linha "(direto)" só aparece quando a raiz tem filhas **e** tem realizado próprio no recorte — numa árvore sem lançamento direto na raiz, nada muda na tela.

**Não muda.** Os dois níveis continuam sendo dois. A herança de natureza continua. O arquivamento em cascata continua. `Sem categoria` continua sendo o destino de quem não escolhe.

**Risco assumido.** Alguém escreverá, em algum épico, um relatório que lista raízes e subcategorias na mesma lista plana e soma tudo. É a contagem dupla que a Leitura A eliminava por construção. A defesa é a invariante escrita, a linha "(direto)" nomeada no glossário, e a invariante-ponte de CAT-2 — total do relatório por categoria **é igual** ao balde do rodapé — que reprova exatamente esse erro com um número.

## Alternativas rejeitadas

**Leitura A, com subcategoria sintética na migração.** Rejeitada acima: persiste no banco uma categoria que o Usuario não criou, para representar o que já é uma projeção de relatório.

**Leitura A, sem migração — recusar a importação de lançamento em raiz.** Transfere o problema para o primeiro dia de uso de todo Usuario que vem de um concorrente. O produto existe para receber essas pessoas.

**Manter `analitica` com os dois sentidos e criar `folha` como campo derivado.** Não resolve nada: o gatilho continuaria recusando `Ajuste de saldo`, que é o defeito real. E um booleano com dois sentidos é o que produziu esta ADR.

**Adiar para o épico 5, com o `Planejamento`.** A hierarquia de escopos do `Planejamento` (ADR 0008) depende de qual leitura vale: `realizado(Casa)` é uma coisa sob A e outra sob B. Decidir depois significaria decidir com código de duas telas apoiado na resposta errada.
