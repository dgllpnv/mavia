# Teardown do Organizze — estudo do produto em uso

- **Data:** 2026-09-01
- **Método:** navegação assistida no app web logado (`app.organizze.com.br`), tela a tela, incluindo formulários abertos sem salvar.
- **Ética:** conta real de cliente. Nenhum dado financeiro pessoal foi registrado neste documento — apenas estrutura, rótulos e comportamento.
- **Não coberto:** `conexão bancária` (vive em `app2.organizze.com.br`, sem permissão de automação na sessão), Tags, Plano, Calculadora, Conversor de moedas.

---

## 1. Navegação global

Barra superior fixa, verde, cinco itens à esquerda e três à direita:

```
[logo]   visão geral · lançamentos · relatórios · limite de gastos · conexão bancária        ⚙ 🔔² 👤
```

- Navegação **plana**: cinco destinos, sem menu lateral, sem hierarquia.
- Toda configuração fica atrás da engrenagem, que abre um dropdown e leva a uma área com **sidebar própria**.
- O sino tem contador de não lidas. O avatar é conta/sessão.

**Sidebar de configurações:**

```
Categorias · Contas · Cartões de crédito
────────────────────────────────────────
Preferências · Plano · Tags · Alertas · Atividades · Chaves de API · Apps conectados
```

O dropdown da engrenagem tem ainda um grupo "mais opções": Calculadora, Conversor de Moedas, **Metas de receitas**.

---

## 2. Visão geral (dashboard)

Layout de duas colunas sob um cabeçalho de largura total.

**Cabeçalho.** Saudação por horário e nome. À esquerda, "Receita mensal" e "Despesa mensal" lado a lado com um botão de gráfico. À direita, quatro ações primárias: **Despesa · Entrada · Transferência · Importar**.

Detalhe: as ações primárias vivem no dashboard, não num botão flutuante. E "Importar" tem o mesmo peso visual de lançar — sinal de que importação é caminho principal, não recurso escondido.

**Coluna esquerda.**
1. *Saldo geral* — valor grande com **ícone de olho para ocultar**. Barra vertical colorida à esquerda indicando sinal.
2. *Minhas contas* — lista: ícone, nome, subtítulo com a origem ("Conta manual"), valor à direita. Rodapé "Gerenciar contas".
3. *Contas a pagar* — faixa de alerta "Contas a pagar atrasadas" em vermelho claro, seguida das atrasadas; depois uma faixa "Próximas" e as futuras. Cada linha: ícone da categoria, descrição, data, valor.

**Coluna direita.**
4. *Lista de cartões de crédito* — estado vazio com ícone, texto e botão "Adicionar cartão".
5. *Maiores gastos do mês atual* — legenda à esquerda (ícone, nome, percentual) e rosca à direita, com "Ver relatório".
6. *Limite de gastos* — estado vazio explicativo.
7. *Receitas a receber* — estado vazio explicativo.

**Observações de IA.** O dashboard é uma coleção de cards independentes; a ordem mistura "estado" (saldo, contas), "urgência" (contas a pagar) e "análise" (maiores gastos). Estados vazios ocupam o mesmo espaço de widgets preenchidos, o que deixa a tela cheia de instruções para quem está começando — bom para onboarding, ruim quando dois ou três nunca serão usados.

---

## 3. Lançamentos — a tela central

**Faixa de alerta** acima do card: "Há N lançamentos passados que ainda não foram pagos", com chevron para expandir.

**Cabeçalho do card:**

```
Lançamentos (+)        ‹  Setembro 2026  ›        [✓ Selecionar] [⇄] [⋮]
```

- **(+)** abre menu: *Nova Despesa · Nova Receita · Nova Transferência*.
- O seletor central é um **alternador de granularidade**, não um seletor de mês: clicar abre *Hoje · Esta semana · Este mês · Escolher período*. As setas navegam **na granularidade ativa** — em "Hoje" andam dia a dia, em "Este mês" mês a mês. O padrão vem de Preferências.
- **Selecionar** entra em modo de seleção em massa (alterar categoria, tags, descrição, ou excluir em lote).
- **⋮** → *Imprimir · Importar arquivo · Exportar para arquivo*.

**Barra de filtros.** Recolhida mostra só "Filtrar por…" e a lupa. Expandida fica laranja e revela quatro dimensões: **Tipo · Contas & Cartões · Categorias · Tags**.

`Tipo` é a taxonomia mais reveladora do produto:

```
todos os lançamentos
receitas · receitas recebidas · receitas não recebidas
despesas · despesas pagas · despesas não pagas
transferências · transferências pagas · transferências não pagas
lançamentos fixos
lançamentos parcelados
lançamentos com marcadores
```

Três eixos ortogonais colapsados numa lista: **natureza** (receita/despesa/transferência), **status** (pago/não pago), e **origem estrutural** (fixo/parcelado/com marcador).

**Lista.** Agrupada por data, com o dia como cabeçalho discreto (`15/09/26`). Cada linha:

```
[ícone da categoria em círculo colorido]  Descrição  3/5      🏦 Conta      -1.116,00   [👎]
```

- O sufixo `3/5` é **número da parcela / total**, em cinza menor, colado na descrição.
- O ícone à direita alterna pago/não pago direto na lista.
- Ao fim de cada grupo de dia: **"Saldo no dia"** com o valor — ligável em Preferências.

**Rodapé fixo** com resumo do período, colapsado em duas linhas (`saldo`, `previsto`) e expansível para:

```
saldo anterior
receita realizada · receita prevista
despesa realizada · despesa prevista
saldo        (realizado)
previsto
```

Este é o modelo **realizado × previsto** completo, e é o coração conceitual do produto.

---

## 4. Formulário de lançamento

Modal centrado, enxuto. Ordem dos campos:

```
Descrição                          (foco inicial, largura total)
Valor          |  Data             (lado a lado)
[toggle] Lançamento pago           (ligado por padrão)
Conta/Cartão   |  Categoria [IA]   (lado a lado)

( 🔁 )  ( 💬 )  ( 📎 )  ( 🏷 )     (atributos opcionais, colapsados)
─────────────────────────────
( 🗑 )      ( ✔ )      ( ⊕ )      (excluir · salvar · salvar e criar outro)
```

Cinco campos primários visíveis, quatro atributos secundários escondidos atrás de ícones (repetição, observação, anexo, marcadores), e três ações no rodapé. **É a peça de design mais bem resolvida do produto** — a densidade que os clientes elogiam vem daqui.

Detalhes que importam:

- O toggle **"Lançamento pago"** é o que decide entre `realizado` e `previsto`. Está em posição de destaque, entre valor e categoria.
- **Categoria carrega um selo "IA"** — sugestão automática de categoria.
- **⊕ "salvar e criar outro"** existe como ação de primeira classe. Quem lança em lote não fecha o modal.

**Repetição (🔁)** abre duas opções mutuamente exclusivas:

- **Lançamento fixo** — recorrência.
- **Lançamento parcelado** — revela `Parcelas` (número) e `Período de lançamento` (Meses, e outras unidades), mais um explicador ao vivo:

  > Serão lançadas **N parcelas** de **R$ X**
  > *Em caso de divisão não exata, a sobra será somada à primeira parcela.*

  Confirma que o **Valor digitado é o total**, dividido em N, com o resto na primeira parcela — a mesma regra do nosso ADR 0005.

---

## 5. Relatórios

Cabeçalho com navegador de período e **quatro abas**: `Categorias · Entradas x Saídas · Contas · Tags`.

**Categorias.** Sub-cabeçalho com botão "Filtros" à esquerda e, à direita, alternador de tipo de gráfico (rosca / linha-barra), imprimir e exportar PDF. Conteúdo em duas seções empilhadas — **Despesas** e **Receitas** — cada uma com lista à esquerda (ícone, nome, valor, percentual), linha de **Total**, e rosca à direita.

**O achado mais importante do teardown** está aqui, como um link discreto no canto:

> Gastos de cartão com base na **data da parcela**

Clicando, três opções:

| Base | Comportamento |
|---|---|
| **Data da fatura** | Apenas compras da fatura daquele mês entram no período |
| **Data da compra** | Todas as compras feitas no mês entram, independente da fatura |
| **Data da parcela** *(padrão)* | Como "data da compra", mas em parceladas considera só a parcela do mês |

São **três eixos temporais distintos** para o mesmo lançamento de cartão. Ver seção 8.

**Entradas x Saídas.** Alternador de agregação — `diário · semanal · mensal · acumulado` — e um checkbox **"Considerar movimentações não pagas"**, que liga o previsto no gráfico.

---

## 6. Limite de gastos e Metas de receitas

São **a mesma tela, espelhada**:

| | Limite de gastos | Metas de receitas |
|---|---|---|
| Onde | Item de primeiro nível na navegação global | Enterrado em ⚙ → mais opções |
| Escopo | Por mês | Por mês |
| Vazio | "Definir limite de gastos" + **"Copiar os últimos definidos"** | "Definir meta de receita" + **"Copiar os últimos definidos"** |

Mesmo mecanismo, direções opostas: um é teto de despesa, o outro é piso de receita. O planejamento é **mensal e não perpétuo** — por isso o "copiar os últimos definidos".

Que dois recursos idênticos estejam em níveis de navegação tão diferentes é uma inconsistência de arquitetura de informação, não uma decisão de produto.

---

## 7. Configurações

**Categorias.** Abas por natureza (Despesas / Receitas). Link "N categorias arquivadas". Hierarquia de **dois níveis**: categoria com ícone colorido, subcategorias listadas abaixo em cinza. Ações no hover: `arquivar` e `+ sub-categoria`. **Arquivar, não excluir.**

**Contas.** Lista simples e "Nova conta", que abre uma escolha:

> **Criar conta conectada** — via Open Finance, importa transações automaticamente
> **Criar conta manual** — controle manual
>
> *Contas e Cartões conectados são criados automaticamente quando você faz uma nova Conexão Bancária.*

Formulário manual: ícone, **Nome** (obrigatório), **Saldo** (com alternador de sinal) e toggle **"Não somar no Saldo Geral"**.

Notável: **conta não tem tipo** (corrente/poupança/investimento). Só nome e ícone.

**Cartões de crédito.** Formulário: ícone, **Nome**, **Limite**, **Fecha dia**, **Vence dia**, **Conta de pagamento padrão**. Mesma escolha conectado/manual.

**Preferências.**

| Opção | Valores |
|---|---|
| Ordenação dos lançamentos | Crescente / Decrescente |
| Período de navegação padrão | Diário / Semanal / Mensal |
| Saldo diário | Sim / Não |
| Começar do zero | "Excluir minhas transações" (preserva contas, cartões, categorias e tags) |
| Excluir conta | "Excluir conta por completo" |

**Alertas.** Três canais: **Desktop** (push do navegador), **E-mail** (com seletor de dia da semana — resumo semanal) e **Celular** (configurado no aparelho).

**Atividades.** "Registro de atividades no sistema dos últimos **90 dias**". Filtros por conta e categoria. Agrupado por data. Cada linha: usuário, verbo ("criou uma despesa"), horário, descrição, e um (+) para expandir o detalhe. É **log de auditoria exposto ao usuário**, e revela que o produto é **multiusuário** — as entradas são atribuídas a pessoas nomeadas.

**Apps conectados.** Integração com agentes de IA:

> Aplicativos de IA conectados à sua conta via **OAuth**. Revogue o acesso quando não precisar mais.
>
> Adicione o Organizze como conector MCP personalizado (Claude: Conectores · ChatGPT: Apps · Manus: Integrações). URL do servidor MCP: `https://mcp.organizze.com.br/mcp`. Faça login, **escolha o espaço** e autorize o acesso (**somente leitura por padrão**). Para permitir criar transações e contas, marque a opção de **escrita** na tela de autorização.

Modelo de segurança: OAuth, escopo por tenant (que eles chamam de **"espaço"**), leitura por padrão, escrita opt-in, revogável. Existe também **Chaves de API** como item separado.

---

## 8. O que isso muda no nosso modelo

### 8.1 Lacuna real: a data da compra em compras parceladas

Nosso `CONTEXT.md` tem `posted_at` (competência) e `effective_at` (efetivação). O Organizze demonstra que cartão precisa de **três** referências:

| Conceito | No nosso modelo |
|---|---|
| Data da compra | Precisa ser preservada no **grupo de parcelamento**, não só na primeira parcela |
| Data da parcela | O `posted_at` de cada `Lancamento` filho — já temos |
| Data da fatura | Derivada da `Fatura` a que a parcela pertence — já temos |

**Ação:** adicionar `purchase_date` ao grupo de parcelamento e permitir que relatórios escolham a base. Sem isso, é impossível responder "quanto comprei em julho" separado de "quanto vou pagar em julho" — e as duas perguntas são legítimas.

### 8.2 Limite e Meta são a mesma entidade

Teto de despesa e piso de receita compartilham escopo (categoria × mês), ciclo de vida e a operação "copiar do mês anterior". Modelar como **uma** entidade com `natureza: teto | piso` e apresentar numa **única tela de Planejamento** corrige a inconsistência do Organizze sem custo.

### 8.3 Campos a adicionar

- `Conta.incluir_no_saldo_geral` (booleano) — o toggle "Não somar no Saldo Geral".
- `Conta.origem` e `Cartao.origem` (`manual` | `conectado`) — já implícito no `BankSyncProvider`, precisa aparecer no modelo e na UI.
- `Categoria.arquivada_em` — arquivar em vez de excluir, já coerente com nosso soft delete.

### 8.4 Confirmações do que já decidimos

| Nossa decisão | Como o Organizze confirma |
|---|---|
| Resto do rateio na primeira parcela (ADR 0005) | Texto literal no formulário de parcelamento |
| `status: previsto / efetivado` | Toggle "Lançamento pago" e todo o rodapé realizado × previsto |
| Transferência como tipo próprio, fora de gastos | Tipo de primeira classe no filtro e no menu de criação |
| Parcelamento como N lançamentos ligados | Badge `3/5` em cada linha da lista |
| Audit log append-only | Tela "Atividades", exposta ao usuário |
| Soft delete | "Arquivar" em categorias |
| MCP somente leitura por padrão, escopo por tenant, revogável | Texto literal em "Apps conectados" |
| Tenant como unidade de isolamento | Eles chamam de "espaço", e o MCP pede para escolher um |

### 8.5 Fraquezas do Organizze que podemos corrigir

1. **Metas escondidas** em "mais opções", enquanto Limite é item de primeiro nível — sendo o mesmo mecanismo.
2. **Conta sem tipo**, o que impede tratar investimento e dinheiro em espécie de forma distinta em relatórios.
3. **Dashboard com estados vazios permanentes** ocupando espaço de widgets úteis.
4. **Três eixos ortogonais colapsados numa lista só** no filtro Tipo — 13 opções lineares onde há três dimensões independentes.
5. **A base temporal do cartão é um link discreto** num canto do relatório, quando é a decisão que mais muda o número na tela.
6. **Sem visão de fatura como objeto** — o cartão aparece como lista de compras, não como ciclo com fechamento e vencimento.
7. **Vocabulário inconsistente**: "Tags" no filtro e em configurações, "marcadores" na lista de tipos.
