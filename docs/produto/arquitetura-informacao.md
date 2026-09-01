# Arquitetura de informação — Mavia

- **Data:** 2026-09-01
- **Autor:** `product-financeiro`
- **Status:** proposto, aguarda decisão do humano nos pontos marcados 🔺
- **Fontes:** `CONTEXT.md`, `docs/pesquisa/organizze-teardown.md`, `docs/design.md`, `docs/pipeline.md`, ADRs 0002/0005/0006

Este documento define **como o produto se apresenta**: quais destinos existem, o que há em cada tela, o que deliberadamente não há, e em que ordem construímos. Não define visual (isso é `docs/design.md` + processo de três direções) nem esquema de banco.

Regra que atravessa tudo, herdada de `CLAUDE.md`: **nenhuma tela pode exibir um número que possa estar errado sem aviso.** Onde essa regra colide com elegância, ela vence.

---

## 1. Modelo de navegação

### 1.1 Princípio

Navegação **plana**, sem menu lateral no nível global. O Organizze acertou nisso: cinco destinos, um clique cada, nenhuma hierarquia para memorizar. Copiamos a forma, mudamos o conteúdo.

O critério para um item ser de primeiro nível: **o usuário volta a ele pelo menos uma vez por semana e ele responde a uma pergunta diferente das outras.** Cadastro (contas, categorias, etiquetas) não é destino — é manutenção, e mora atrás da engrenagem.

### 1.2 Web

```
[Mavia]   visão geral · lançamentos · cartões · planejamento · relatórios          ⚙  🔔  👤
```

| Destino | Pergunta que responde | Frequência |
|---|---|---|
| **Visão geral** | Quanto eu tenho e o que vence? | diária |
| **Lançamentos** | O que aconteceu e está certo? | diária |
| **Cartões** | Quanto vem na fatura e quando fecha? | semanal |
| **Planejamento** | Posso gastar isso? | semanal |
| **Relatórios** | Para onde meu dinheiro foi? | mensal |

Os três ícones à direita: engrenagem abre a área de Configurações (com sidebar própria), sino abre o painel de Alertas, avatar abre conta/espaço/sair.

**Divergências do Organizze e por quê:**

| Mudança | Justificativa |
|---|---|
| **+ Cartões** no primeiro nível | No Brasil a maior parte do gasto passa por cartão, e a pergunta "quanto vem na fatura" é a mais repetida do produto. No Organizze essa pergunta só é respondível somando uma lista filtrada. Ver §3, fraqueza 6. |
| **Limite de gastos → Planejamento** | Teto de gasto e piso de receita são o mesmo mecanismo em direções opostas (teardown §6 e §8.2). Um destino, não um destino e um item enterrado em "mais opções". |
| **− Conexão bancária** do primeiro nível | Não existe até o épico 12. Importação de arquivo, que existe antes, é **ação** (parte-se dela para uma tela de fluxo), não destino que se visita. Quando o épico 12 chegar, Conexões entra em Configurações → Origem dos dados, não no primeiro nível: conectar um banco é algo que se faz três vezes na vida. |
| Cadastro de cartão sai de Configurações | Se Cartões é destino, o CRUD do cartão mora lá. Configurações fica com o que é realmente configuração. |

**Não crescemos além de seis itens.** Se um sétimo destino for proposto, ele desloca um existente ou não entra.

### 1.3 Mobile

Barra inferior com quatro abas e uma ação central. A ação central **não é uma aba** — é o botão de lançar.

```
┌──────────────────────────────────────────────────┐
│  Visão geral   Lançamentos   ( + )   Cartões   Mais │
└──────────────────────────────────────────────────┘
```

**Por que quatro abas e não cinco.** A barra inferior comporta cinco alvos confortáveis. Um deles é consumido pela ação de lançar, porque o momento de maior valor do app é o instante do gasto — fila do caixa, estacionamento (ADR 0002). Restam quatro destinos, e os dois cortados são os certos:

- **Planejamento** e **Relatórios** vão para "Mais". São atividades de sentar e pensar, de cadência semanal/mensal, e ficam melhor numa tela grande. Custo: um toque a mais num caminho de baixa frequência.
- **Cartões** fica na barra porque "quanto está a fatura" é pergunta de consulta rápida, feita em pé.

**Aba "Mais":** Planejamento · Relatórios · Contas · Categorias · Etiquetas · Recorrências · Importar · Atividades · Configurações · Conta.

**Comportamento do botão ( + ):**

- Toque simples abre o **formulário de despesa**, já pronto, com foco no valor e teclado numérico aberto. Não abre menu.
- Motivo: a despesa é a ampla maioria dos lançamentos manuais. Um menu cobra um toque de todo mundo para poupar um toque da minoria. Em vez do menu, o formulário tem um seletor segmentado **Despesa | Receita | Transferência** no topo — trocar custa um toque e nenhuma navegação.
- Toque longo abre as três opções direto, para quem já sabe.
- Em Cartões e dentro de uma Fatura, o ( + ) pré-seleciona aquele cartão.

**Sem gaveta lateral (drawer).** Gaveta esconde navegação e é hostil ao polegar. "Mais" é uma tela, não um menu deslizante.

### 1.4 O que é ação, não destino

Importar · Exportar · Imprimir · Buscar · Selecionar em massa. Todas vivem no cabeçalho da tela onde fazem sentido (majoritariamente Lançamentos). Importar aparece **também** entre as ações primárias da Visão geral, com o mesmo peso de "Despesa" — sinalizando que importar é caminho principal, não recurso escondido. Esse detalhe é copiado do Organizze de propósito.

---

## 2. Inventário de telas

Convenção deste inventário: **Blocos** estão na ordem vertical de renderização. **Não tem** é decisão, não omissão — cada item ali foi considerado e recusado.

---

### 2.1 Visão geral (Dashboard)

**Propósito:** em cinco segundos, responder "quanto eu tenho, o que vence, e estou dentro do plano?".

**Blocos (web, grade assimétrica — coluna dominante à esquerda):**

1. **Barra de ação e período** — `Despesa · Receita · Transferência · Importar` + navegador de mês + botão de ocultar valores (olho).
2. **Saldo geral** — número grande, algarismos tabulares. Abaixo, em corpo menor: `previsto no fim do mês`. É o par realizado × previsto, o conceito central do produto, presente já no primeiro bloco.
3. **Contas** — linha por conta: ícone, nome, tipo, saldo à direita. Contas marcadas "não somar no saldo geral" aparecem abaixo de uma divisória, com subtotal próprio. Rodapé: "Gerenciar contas".
4. **Cartões — faturas abertas** — linha por cartão: nome, valor parcial da fatura, `fecha em N dias · vence dia D`, barra de limite usado. Clique abre a Fatura.
5. **A pagar e a receber** — atrasados primeiro, sob faixa de alerta; depois os próximos 7 dias. Cada linha permite marcar como efetivado sem sair da tela.
6. **Para onde foi** — cinco maiores categorias do mês com barra proporcional e percentual; link "Ver relatório".
7. **Planejamento** — só as categorias em risco (≥80% do teto) ou estouradas. Nunca a lista inteira.

**Mobile:** mesma ordem, coluna única, blocos 6 e 7 abaixo da dobra. O bloco 1 vira apenas o seletor de mês (as ações estão no ( + )).

**Ações:** ocultar/mostrar valores · trocar mês · lançar (4 tipos) · marcar efetivado · navegar para fatura, conta, relatório.

**Estados:**

| Estado | Comportamento |
|---|---|
| Vazio absoluto (usuário novo) | Não renderiza o dashboard. Redireciona para Onboarding (§2.15). |
| Parcialmente configurado | **Widget sem dado não renderiza.** No lugar, uma única faixa discreta no rodapé: "Falta configurar: cartões · limites". Dispensável, e volta pela engrenagem. Corrige a fraqueza 3 do teardown. |
| Carregando | Esqueleto por bloco. **Nenhum valor monetário renderiza como `0,00` enquanto carrega** — usa `—`. No mobile, o saldo mostra o último valor em cache com carimbo `atualizado às 08:14`. |
| Erro | Erro por bloco, nunca página em branco. Se o saldo falhar, mostra o último snapshot com rótulo explícito `desatualizado` e botão de recarregar. Um número velho identificado é aceitável; um número errado silencioso não é. |
| Offline (mobile) | Banner fino no topo: `offline · N lançamentos na fila`. Tudo continua navegável a partir do cache. |

**Não tem:** score financeiro ou "saúde financeira" em nota de 0 a 10 (métrica inventada, não resolve problema); card de insight gerado por IA no MVP; gamificação, streaks ou medalhas; reordenação de widgets (custo de configuração > ganho); feed de notícias ou dicas; comparação com "usuários como você" (LGPD e desconfiança).

---

### 2.2 Lançamentos

**Propósito:** a tabela onde o usuário confere e corrige o mês. É a tela central do produto — é dela que o cliente fala quando elogia a "organização" do Organizze.

**Blocos:**

1. **Faixa de pendências** — "N lançamentos passados ainda não efetivados", expansível, com ação de marcar todos ou revisar um a um. Só aparece se N > 0.
2. **Cabeçalho** — `Lançamentos (+)` · navegador de período no centro · `Selecionar` · `⋮`.
   - O navegador central é **alternador de granularidade**, não seletor de mês: `Hoje · Esta semana · Este mês · Escolher período`. As setas andam na granularidade ativa. Padrão vem de Preferências. Copiado do Organizze sem alteração — é melhor que o seletor de mês simples.
   - `⋮` → Importar arquivo · Exportar (CSV/OFX) · Imprimir.
3. **Barra de filtros** — recolhida mostra busca + "Filtrar". Expandida mostra **três eixos independentes** mais três dimensões de recorte:

   | Eixo | Controle | Valores |
   |---|---|---|
   | Natureza | segmentado, multi-seleção | Receita · Despesa · Transferência |
   | Status | segmentado, multi-seleção | Efetivado · Pendente · Previsto |
   | Estrutura | caixas de seleção | Fixo (recorrente) · Parcelado · Com etiqueta |
   | Conta/Cartão | multi-seleção | — |
   | Categoria | multi-seleção, hierárquica | — |
   | Etiqueta | multi-seleção | — |

   Acima dos eixos, **três presets nomeados**: `Não pagos` · `Só despesas` · `Parcelados`. Ver §3, fraqueza 4 — a decomposição em eixos é correta, mas encarece o caso comum; os presets devolvem o atalho.
   O estado do filtro é sempre visível como chips removíveis quando a barra está recolhida. Filtro escondido que altera o total é a receita da desconfiança.
4. **Lista** — agrupada por dia, cabeçalho de dia discreto. Linha:
   `[ícone da categoria] Descrição  3/5 · Conta · [valor à direita, tabular] · [alternador efetivado]`
   O `3/5` é parcela/total. Lançamento de transferência exibe as duas pernas ligadas visualmente e rótulo `transferência`. Ao fim de cada dia, opcionalmente, `Saldo no dia`.
5. **Rodapé fixo** — colapsado em duas linhas (`saldo`, `previsto`), expansível para:
   ```
   saldo anterior
   receita realizada · receita prevista
   despesa realizada · despesa prevista
   saldo (realizado)
   previsto
   ```
   Este rodapé é o modelo realizado × previsto completo. **É requisito, não enfeite.**

**Ações:** criar (despesa/receita/transferência) · editar (clique na linha) · alternar efetivado inline · duplicar · excluir (soft) · seleção em massa (categoria, etiquetas, descrição, excluir) · importar · exportar · imprimir · buscar.

**Estados:** vazio no período ("Nenhum lançamento em setembro de 2026." + `Lançar despesa` + `Importar extrato`) · vazio absoluto (→ Onboarding) · carregando (linhas-esqueleto; rodapé mostra `—`, jamais `0,00`) · erro (mantém os dados anteriores em tela, com banner de falha e botão repetir) · seleção ativa (cabeçalho vira barra de ações em lote com contador).

**Não tem:** rolagem infinita atravessando meses (o período é a unidade de trabalho e o rodapé depende dele); linha de criação inline na tabela no MVP (o formulário resolve melhor); colunas configuráveis; visão em calendário (não resolve pergunta que a lista não resolva); múltiplas moedas por espaço no MVP.

---

### 2.3 Formulário de lançamento

**Propósito:** registrar um gasto em segundos, sem pensar. É a peça mais importante do produto e a que mais herdamos do Organizze.

**Forma:** modal centrado na web; folha de tela cheia no mobile. Mesma ordem de campos nas duas.

```
[ Despesa | Receita | Transferência ]          ← segmentado

Valor                                          ← foco inicial, teclado numérico
Descrição
Data                                           ← padrão: hoje
[toggle] Efetivado                             ← ligado por padrão
Conta / Cartão        |   Categoria  (sugerida)

( repetir )  ( observação )  ( anexo )  ( etiquetas )     ← colapsados

──────────────────────────────────────────
( excluir )        ( salvar )        ( salvar e criar outro )
```

**Decisões e divergências:**

| Decisão | Justificativa |
|---|---|
| **Valor tem o foco inicial**, não a descrição (o Organizze foca a descrição) | Na fila do caixa o usuário sabe o valor antes de saber como descrever. Valor é obrigatório; descrição não é. Habilita a meta de toques do §4. 🔺 Divergência a validar em teste com usuário; reversível. |
| **Toggle "Efetivado"** entre valor e categoria | É o campo que decide entre realizado e previsto — o conceito central. Merece a posição de destaque. Nome segue `CONTEXT.md` (`efetivado`), não "pago". |
| **Categoria com sugestão** | Rótulo textual `sugerida` e o motivo ao toque ("você usou Mercado nas últimas 4 compras neste estabelecimento"). Sem selo "IA", sem ícone de brilho (`docs/design.md` §1). Sempre editável. |
| **"Salvar e criar outro"** como ação de primeira classe | Quem lança em lote não fecha o modal. Preserva conta, categoria e data; limpa valor e descrição. |
| Transferência troca Categoria por **Conta origem → Conta destino** | E exibe, sob os campos, a linha: *"Transferência não entra em relatórios de gastos."* Antecipa a dúvida de §6. |

**Repetição (colapsado)** abre duas opções mutuamente exclusivas:

- **Fixo** — cria uma `Recorrencia` (regra). Periodicidade, data de início, fim opcional. Aparece depois em Configurações → Recorrências.
- **Parcelado** — `Parcelas` (N) e `Período` (meses/semanas). Explicador ao vivo, texto normativo:
  > Serão lançadas **N parcelas de R$ X**.
  > Em divisão não exata, a sobra vai na primeira parcela.

  Confirma que o valor digitado é **o total**. Mesma regra do ADR 0005.

**Quando é cartão parcelado**, o formulário exibe adicionalmente:
> Compra em 03/09/2026. Primeira parcela na fatura que vence em 10/10/2026.

Isso torna visível, no momento da entrada, a distinção entre data da compra, da parcela e da fatura (teardown §8.1). O `purchase_date` é gravado no grupo de parcelamento.

**Estados:** novo · edição (mostra "excluir" e, se parcelado/recorrente, pergunta o escopo: *só esta · esta e as futuras · todas*) · salvando (botão desabilitado com progresso; nunca duplo envio) · erro de validação (mensagem no campo, nunca toast genérico) · erro de rede no mobile (**salva na fila offline e confirma ao usuário** — "salvo no aparelho, será enviado quando houver conexão").

**Não tem:** divisão de despesa entre pessoas (sem problema articulado hoje; espera o épico 10); múltipla moeda por lançamento; OCR de recibo no MVP (épico 7); anexo com mais de um arquivo no MVP; campo de "local"/geolocalização (dado sensível sem retorno claro — objeção de LGPD provável).

---

### 2.4 Cartões

**Propósito:** em uma tela, quanto devo em cada cartão e quando cada um fecha.

**Blocos:**

1. **Total em faturas abertas** — número grande. Abaixo: `a vencer nos próximos 30 dias: R$ X`.
2. **Lista de cartões** — linha por cartão: nome, fatura aberta (parcial), `fecha em N dias · vence dia D`, barra de limite usado com o **disponível** em texto (a barra sozinha não comunica; parte dos usuários não distingue cor).
3. **Faturas fechadas e não pagas** — bloco separado, sob faixa de alerta, se houver.
4. Rodapé: `Novo cartão`.

**Ações:** abrir fatura · novo cartão · editar · arquivar · lançar despesa naquele cartão.

**Estados:** vazio ("Nenhum cartão cadastrado. Se você usa cartão de crédito, é aqui que a maior parte do seu gasto aparece." + `Adicionar cartão`) · carregando · erro.

**Não tem:** controle de pontos, milhas ou cashback (produto diferente); arte/bandeira do cartão emitida por terceiro; limite de gasto por cartão (isso é Planejamento, e é por categoria); previsão de juros.

---

### 2.5 Fatura — o objeto de ciclo

O Organizze não tem esta tela. É a nossa maior divergência e a candidata a **elemento-assinatura** (`docs/design.md` §3).

**Propósito:** mostrar a fatura como um ciclo com início, fechamento, vencimento e estado — não como uma lista de compras.

**Blocos:**

1. **Cabeçalho de ciclo** — navegador `‹ Fatura de outubro/2026 ›` (anda de fatura em fatura, não de mês em mês) e o **estado** como rótulo textual: `aberta · fechada · paga · parcialmente paga · vencida`.
2. **Régua do ciclo** — linha do tempo horizontal com quatro marcos: `início do período · hoje · fechamento · vencimento`. É o elemento gráfico que carrega a identidade do produto e o que torna a fatura um objeto e não uma consulta.
3. **Valor** — número grande. Se aberta: `parcial · fecha em 6 dias`. Se fechada: `valor fechado`. Nunca "total" sem qualificar o estado.
4. **Composição** — responde "por que a fatura está alta se eu quase não comprei":
   ```
   compras deste ciclo            R$ ...
   parcelas de compras anteriores R$ ...   (N parcelas)
   estornos                      -R$ ...
   ```
5. **Lançamentos da fatura** — agrupados por dia. Parcelas exibem `3/5` **e a data da compra original**. Estornos com sinal e rótulo próprios.
6. **Pagamento** — bloco no rodapé: `Registrar pagamento`. Abre uma Transferência conta → cartão pré-preenchida com o valor da fatura, editável. Aceita pagamento parcial e pagamento a maior. Texto fixo:
   > Pagamento de fatura é transferência entre sua conta e o cartão. Não é despesa e não é contado de novo nos relatórios.

**Estados:**

| Estado | O que a tela mostra |
|---|---|
| Aberta | Valor parcial, régua com "hoje" antes do fechamento, ( + ) disponível |
| Fechada, não paga | Valor travado, ( + ) redireciona para a próxima fatura com aviso |
| Parcialmente paga | Valor pago, saldo remanescente, e o que acontece com ele explicitamente |
| Paga | Rótulo, data e link para a transferência que a pagou |
| Vencida | Faixa de alerta com dias em atraso |
| Futura | Só parcelas já agendadas, rotulada `projeção` — deixa claro que não é dívida existente |
| Vazia | "Nenhum lançamento neste ciclo." |
| Carregando/erro | Igual às demais: `—`, nunca `0,00`; erro preserva o último valor com carimbo |

**Não tem:** cálculo de juros de rotativo, IOF, multa ou encargo. **Veto explícito** (§6): calcular encargo sem os parâmetros contratuais do banco produz um número errado sem aviso. O encargo entra como lançamento quando o banco o cobra. Também não tem: importação do PDF da fatura no MVP (é Importação); parcelamento de fatura pelo app; antecipação.

---

### 2.6 Planejamento

Unifica o que o Organizze separa em "Limite de gastos" (primeiro nível) e "Metas de receitas" (enterrado). Teardown §8.2.

🔺 **Ponto de glossário a resolver antes de construir.** O `CONTEXT.md` define `Limite` (teto por categoria × mês) e `Meta` (objetivo de acúmulo com valor-alvo e prazo). São coisas diferentes. O que o teardown §8.2 manda unificar é `Limite` com a **meta de receita mensal** do Organizze — não com a `Meta` de acúmulo. Proposta para o `arquiteto-dominio-financeiro`:

- `Limite` ganha `natureza: teto | piso`, mesmo escopo (categoria × mês), mesmo ciclo de vida, mesma operação "copiar do mês anterior". UI: **Tetos** e **Pisos**.
- `Meta` fica restrita ao objetivo de acúmulo plurimensal, com valor-alvo e prazo.
- Sem essa distinção, teremos dois conceitos com um nome ou um conceito com dois — exatamente o que o meu poder de veto proíbe.

**Propósito:** responder "posso gastar isso?" antes de gastar.

**Blocos:**

1. Navegador de mês + `Copiar do mês anterior` (herdado do Organizze; o planejamento é mensal, não perpétuo, e sem essa ação ninguém mantém).
2. **Resumo** — `planejado R$ X · gasto R$ Y · resta R$ Z` e uma linha de comparação: "você planejou gastar 92% do que espera receber".
3. **Tetos** — uma linha por categoria: nome, barra de progresso, `gasto / teto`, restante, e a **projeção**: "no ritmo atual, fecha em R$ 1.480 (teto R$ 1.200)". Ordenado por risco decrescente, nunca alfabético.
4. **Pisos** — meta de receita por categoria, mesmo formato espelhado.
5. **Objetivos** (`Meta` de acúmulo) — bloco separado, sem mês: valor-alvo, prazo, acumulado, ritmo necessário. **Não entra no MVP.**

**Ações:** definir/editar teto ou piso · copiar do mês anterior · remover · configurar alerta de percentual (50/80/100).

**Estados:** vazio (instrutivo e específico: "Você gastou R$ 1.340 em Mercado nos últimos 3 meses, em média. Definir teto?" — o vazio propõe um número real, não um formulário em branco) · sem dados de gasto ainda · carregando · erro.

**Não tem:** envelope budgeting estilo YNAB (modelo mental diferente, exige que o usuário aloque cada real; nossos clientes vêm do Organizze e o custo de troca é alto); orçamento por conta; rollover automático de sobra entre meses (regra ambígua que produz número que o usuário não reconhece).

---

### 2.7 Relatórios

**Propósito:** para onde o dinheiro foi, com uma base de cálculo declarada.

**Blocos:**

1. **Cabeçalho** — navegador de período (com comparação opcional: mês anterior, mesmo mês do ano passado) e, **no mesmo nível hierárquico**, o seletor de base temporal do cartão:
   ```
   Cartão:  [ por data da parcela ▾ ]
   ```
   | Base | Significado (texto exibido na própria lista) |
   |---|---|
   | Data da compra | Tudo que foi comprado no período, independente de quando é pago |
   | Data da parcela *(padrão)* | Como acima, mas em compras parceladas conta só a parcela do período |
   | Data da fatura | Só o que é cobrado na fatura daquele período |

   Corrige a fraqueza 5: no Organizze isso é um link discreto no canto, e é a decisão que mais muda o número na tela. Aqui é persistente, sempre visível, e **impresso no cabeçalho de qualquer exportação ou PDF** — nenhum número sai do produto sem a sua base.
2. **Abas** — `Categorias · Entradas × Saídas · Contas · Etiquetas`.
3. **Categorias** — duas seções empilhadas (Despesas, Receitas), cada uma com lista à esquerda (ícone, nome, valor, percentual, total) e gráfico à direita. Clicar numa categoria abre Lançamentos já filtrado — todo número de relatório é rastreável até as linhas que o compõem. **Requisito, não conveniência.**
4. **Entradas × Saídas** — agregação `diário · semanal · mensal · acumulado` e caixa `considerar lançamentos previstos`.
5. **Rodapé de reconciliação** — linha fixa em toda aba:
   `Transferências (R$ 4.200) e pagamentos de fatura (R$ 3.180) não entram nestes totais.`
   Existe porque a ausência silenciosa desses valores é a principal fonte de "faltou dinheiro no relatório".

**Ações:** trocar período · comparar · trocar base do cartão · filtrar (conta, cartão, categoria, etiqueta) · alternar tipo de gráfico · exportar CSV/PDF · imprimir · descer até os lançamentos.

**Estados:** sem dados no período · dados insuficientes para comparação ("Sem histórico de agosto para comparar") · carregando · erro.

**Não tem:** construtor de relatório livre / pivot (complexidade alta, uso raro, e todo relatório livre acaba produzindo um número que ninguém sabe explicar); relatórios salvos no MVP; previsão de gasto por modelo estatístico (a projeção linear do Planejamento basta e é explicável); patrimônio líquido/investimentos (produto adjacente).

Antes da primeira linha de gráfico: invocar a skill `dataviz` (`docs/design.md` §4.4).

---

### 2.8 Contas

**Propósito:** cadastrar e conferir cada lugar onde o dinheiro está.

**Blocos:** lista agrupada por tipo · subtotal por grupo · contas fora do saldo geral abaixo de divisória · `Nova conta`.

**Formulário:**

| Campo | Nota |
|---|---|
| **Tipo** | `corrente · poupanca · dinheiro · investimento · digital · outra`. **Divergência do Organizze**, que não tem tipo (fraqueza 2). Problema real: "meu saldo geral soma a poupança da reserva e me faz achar que tenho mais disponível do que tenho." O tipo habilita separar disponível de reservado e tratar investimento à parte nos relatórios. |
| Nome, ícone, cor | — |
| **Saldo inicial + data do saldo inicial** | A data é obrigatória. Sem ela o saldo derivado é indefinível. |
| Moeda | ISO 4217, padrão do espaço |
| `Não somar no saldo geral` | Toggle, herdado do Organizze |
| Origem | `manual` ou `conectado` (somente leitura quando conectado) |

**Ações:** criar · editar · arquivar · **ajustar saldo**.

**Regra dura sobre ajustar saldo:** ajustar cria um `Lancamento` visível de categoria "Ajuste de saldo", com o valor da diferença. **Nunca** escreve o saldo diretamente. Saldo é derivado (`CONTEXT.md`); um ajuste invisível é um número errado sem rastro. Ver §6, veto.

**Estados:** vazio (→ Onboarding) · conta conectada com sincronização falhando (rótulo e data da última sincronização bem-sucedida) · carregando · erro.

**Não tem:** exclusão (só arquivar); reordenação manual no MVP; senha por conta; conta compartilhada parcialmente (papéis são por espaço, épico 10).

---

### 2.9 Categorias

**Propósito:** manter a taxonomia que faz os relatórios significarem algo.

**Blocos:** abas por natureza (Despesas / Receitas) · lista hierárquica de **dois níveis** com ícone e cor · link "N categorias arquivadas" · `Nova categoria`.

**Ações:** criar · criar subcategoria · renomear · trocar ícone/cor · **arquivar** (nunca excluir) · desarquivar · **mesclar** (pós-MVP).

Mesclar resolve um problema concreto que o Organizze não resolve: "criei 'Mercado' e 'Supermercado' e agora meu relatório está partido em dois." Move todos os lançamentos, registra no audit log e é desfazível dentro da sessão. Épico 9.

**Estados:** categorias de sistema (renomeáveis, não excluíveis, rótulo `padrão`) · arquivadas (não aparecem no formulário, continuam nos relatórios históricos) · tentativa de arquivar categoria com lançamentos no mês corrente (aviso, não bloqueio).

**Não tem:** três níveis de hierarquia (destrói relatório e confunde; dois níveis é o consenso da categoria); regras de categorização automática nesta tela (elas vivem em Inteligência, épico 7); categorias por conta.

---

### 2.10 Importação

**Propósito:** trazer o extrato do banco sem duplicar nada e sem apagar nada do usuário.

**Fluxo em quatro passos, com barra de progresso:**

1. **Arquivo e destino** — arrastar OFX/CSV, escolher a conta ou cartão de destino. Mostra formatos aceitos e um arquivo de exemplo.
2. **Mapeamento** (só CSV) — associar colunas a data, descrição, valor, e declarar o formato de data e o separador decimal. Prévia com as 5 primeiras linhas já interpretadas, com os valores formatados como serão gravados.
3. **Revisão** — o passo que decide se o produto é confiável. Cada linha classificada:

   | Marca | Significado | Padrão |
   |---|---|---|
   | `novo` | Não existe equivalente | importar |
   | `duplicado` | Já importado antes (chave de idempotência) | ignorar |
   | `conciliar?` | Casa com um lançamento manual existente — mostrado lado a lado, com o que difere destacado | **pedir confirmação** |

   Ações em lote por marca. O sistema **nunca** apaga ou sobrescreve o registro do usuário automaticamente (`CONTEXT.md`, Conciliacao).
4. **Resultado** — `N criados · M ignorados por duplicidade · K conciliados`, com link para ver os lançamentos filtrados por esta importação e um botão **Desfazer esta importação** (reverte o lote inteiro, disponível por 7 dias).

O desfazer em lote não existe no Organizze e é obrigatório aqui: uma importação na conta errada produz 200 linhas sujas, e sem desfazer o usuário abandona o produto naquele instante.

**Estados:** arquivo inválido (diz o que se esperava e mostra exemplo, nunca "erro ao processar") · arquivo já importado ("Este arquivo foi importado em 12/08/2026. Nada a fazer.") · zero linhas novas · importação parcial com falha (mostra o que entrou e o que não) · processamento longo (fica em segundo plano, avisa quando termina).

**Não tem:** aplicação automática sem o passo 3 — **veto**; importação de PDF no MVP; importação de planilha do concorrente no MVP (é migração, épico próprio se houver demanda); merge automático sem confirmação.

---

### 2.11 Conexões (épico 12)

**Propósito:** ver quais bancos estão conectados, o que cada um pode ler, até quando, e como cortar.

**Blocos:**

1. Lista de **Conexões** — instituição, contas e cartões trazidos, última sincronização com hora, estado: `ativa · expira em N dias · expirada · revogada · com erro`.
2. **Consentimento** de cada conexão — escopo autorizado em linguagem comum, data de concessão, validade, e `Revogar` com a consequência escrita: *"A sincronização para. Os lançamentos já importados permanecem no seu espaço."*
3. **Histórico de sincronizações** — início, fim, `criados / atualizados / ignorados por duplicidade`, e o erro quando houve.
4. `Sincronizar agora`, com o limite visível ("2 de 6 sincronizações de hoje").

**Estados:** sem conexões (explica a diferença entre conta conectada e manual, e o custo do plano) · consentimento expirando (faixa de aviso com 7 dias de antecedência) · sincronização falhando repetidamente (instrução, não erro técnico).

**Não tem:** exibição de qualquer credencial ou token, em nenhuma circunstância; sincronização ilimitada sob demanda; reconexão silenciosa após expiração de consentimento (exige ato do usuário — exigência de LGPD e do Open Finance).

Esta tela está no inventário agora, antes de existir, para que Importação e Conexões nasçam no mesmo lugar da IA (Configurações → Origem dos dados) e escrevam pelo mesmo seam (`BankSyncProvider`, ADR 0003).

---

### 2.12 Configurações

**Propósito:** tudo que se configura uma vez e não se visita mais.

**Forma:** área com sidebar própria, atrás da engrenagem — padrão herdado do Organizze, que funciona.

| Grupo | Itens |
|---|---|
| **Dados** | Contas · Categorias · Etiquetas · Recorrências |
| **Origem dos dados** | Importação · Conexões · Apps conectados (MCP/OAuth) · Chaves de API |
| **Espaço** | Preferências · Alertas · Membros e papéis · Atividades |
| **Conta** | Plano e cobrança (§2.12b, só `proprietario`) · Segurança (senha, 2FA, sessões, biometria) · Dados e privacidade |

**Preferências:** ordenação dos lançamentos (crescente/decrescente) · período de navegação padrão (diário/semanal/mensal) · exibir saldo no dia · ocultar valores por padrão ao abrir · moeda e formato · fuso (fixo `America/Sao_Paulo`, exibido) · **Começar do zero** (apaga lançamentos, preserva contas/cartões/categorias/etiquetas, com confirmação por digitação).

**Alertas:** canais push (app), e-mail (com dia da semana para o resumo) e navegador. Eventos: fatura fechando, conta a vencer, teto em 80%/100%, sincronização falhou, alguém do espaço alterou algo relevante.

**Apps conectados:** OAuth, escopo por espaço, **somente leitura por padrão**, escrita opt-in explícito, revogável. Modelo copiado do Organizze porque está certo e coincide com o `CLAUDE.md`.

**Dados e privacidade:** exportar tudo (LGPD, portabilidade) · excluir o espaço por completo com prazo e consequências · política de retenção. Existe por obrigação legal, não por escolha de produto.

**Não tem:** temas customizáveis além de claro/escuro/sistema; idioma além de pt-BR no MVP; webhooks no MVP.

---

### 2.12b Plano e cobrança, página de preços e checkout (épico 11)

Spec completo em `docs/produto/spec-planos-e-assinatura.md`. Aqui fica o que é arquitetura de informação: quais telas existem, o que há em cada uma, e o que deliberadamente não há.

**Três telas, e só uma delas mora atrás de login.**

#### Página de preços (pública)

**Propósito:** em uma tela, quanto custa e o que muda entre os níveis — sem que ninguém precise adivinhar o que não está escrito.

**Blocos:**

1. **Alternador mensal / anual**, no topo, com o desconto dito em palavras (*"dois meses grátis"*), não só em percentual. O estado escolhido vale para os três cartões ao mesmo tempo.
2. **Três cartões** — `Pessoal` · `Família` · `Negócio` —, cada um com preço, as cotas de pessoas, espaços e anexos, e o botão de assinar. **Os três são compráveis** (DP-17).
3. **Linha da conexão bancária**, dentro do comparativo, com `0 / 3 / 10` e a marca `em desenvolvimento` — e **fora** da lista do que o plano entrega hoje. É a única menção permitida dentro do cartão.
4. **O que nenhum plano limita** — bloco próprio, e não rodapé: lançamentos, contas, cartões, categorias, relatórios, importação de arquivo, **histórico** e **exportação**. Declarar a ausência de limite é argumento de venda, e é verificável.
5. **"Se você parar de pagar"** — uma frase, em destaque: *o espaço fica somente leitura, nada é apagado, e a exportação continua funcionando.* Está aqui, e não só nos termos, porque é a dúvida que trava a assinatura.
6. **Por que custa o que custa** — bloco próprio, e **obrigatório** desde a DP-27: com os preços acima do concorrente (R$ 59 · 79 · 99), a página que só mostra números deixa o visitante inventar a explicação — e a que ele inventa é "então deve conectar meu banco". As promessas do §2.6 do spec de planos, em linguagem de gente: a fatura como objeto, nenhum número errado sem aviso, categorização **local** (você não é o produto), portabilidade de verdade, desfazer importação, e a promessa de suporte.
7. **Lista de espera da conexão bancária** — seção separada, depois dos cartões, **nunca dentro de um deles**: e-mail, banco desejado, faixa de disposição a pagar, e o texto de consentimento do §11.6 do spec. Anuncia o preço **vigente** de `Família` e `Negócio`, com o compromisso de 12 meses — nunca um preço futuro. É o insumo da revisão trimestral do ADR 0003.

**Não tem:** nível bloqueado ou acinzentado (§1.1 do spec: porta trancada é propaganda do concorrente); **tabela comparativa lado a lado com o Organizze** — comparamos Mavia com Mavia, porque montar a tabela do outro é escolher perder no eixo dele; contador regressivo, "vagas limitadas" ou qualquer urgência inventada; preço riscado que nunca foi praticado; plano "sob consulta".

**A página não esconde que somos mais caros** — quem vem do Organizze fará a conta de qualquer jeito, e todo mês. Ela responde à conta com o bloco 6, que é a única defesa honesta disponível.

#### Checkout

**Propósito:** cobrar sem susto. É a tela onde cada campo custa conversão, e por isso só existe o que precisa existir.

**Blocos:** resumo do que está sendo comprado (plano, intervalo, valor e **data da próxima cobrança**) · **CPF ou CNPJ**, um campo, com a razão escrita ao lado · botão que leva ao pagamento hospedado pela Stripe.

- **O dado do cartão nunca aparece numa tela nossa.** Não há campo de número, de CVV ou de validade em lugar nenhum do produto.
- **Não tem:** cupom no MVP; upsell de plano superior no meio do fluxo; caixa pré-marcada de coisa nenhuma; pedido de endereço.

#### Configurações › Plano e cobrança (só `proprietario`)

**Blocos:** plano e intervalo atuais, com as cotas e **o quanto de cada uma está em uso** · estado da assinatura e, se `teste`, `em_atraso` ou `cancelada`, **a data exata** do que vem a seguir · cartão em uso (marca e últimos 4) · histórico de `Cobranca` com valor, data, estado e **o valor reembolsado** quando houver · ações: mudar de plano, trocar de intervalo, atualizar cartão, cancelar, **"já paguei"**.

**Estados:** `teste` (contador com data absoluta desde o primeiro dia) · `em_atraso` (faixa com a data limite e o botão de atualizar cartão — e **o produto inteiro continua funcionando**) · `cancelada` (data em que vira leitura, e o desfazer sem atrito) · `expirada` (banner permanente e botão de reativar) · **acima de uma cota** (faixa nomeando a cota, a contagem e as duas saídas).

**Para quem não é `proprietario`:** a tela **não existe**. O que existe é a faixa de estado quando ela explica um botão recusado, dizendo *"o proprietário deste espaço precisa reativar a assinatura"* — sem preço, sem cartão, sem documento.

**Cancelar e excluir são telas diferentes, com textos diferentes**, e a exclusão **nunca** é oferecida como passo do cancelamento. A confusão entre as duas produz os dois erros opostos: quem achou que apagou tudo e não apagou, e quem achou que só cancelou e perdeu o histórico.

---

### 2.13 Atividades

**Propósito:** quem mudou o quê, quando — o audit log em linguagem de gente.

**Blocos:** filtros (pessoa, período, conta, categoria, tipo de ação) · lista agrupada por data · linha: `[avatar] Ana criou uma despesa · 14:32 · Mercado — R$ 214,90` com `+` que expande o detalhe `de → para`.

**Ações:** filtrar · expandir · abrir o lançamento referido · exportar.

**Estados:** sem atividades no período · retenção (MVP expõe 90 dias, alinhado ao Organizze; internamente o log é append-only e permanente).

**Não tem:** edição ou exclusão de entradas (é log); reversão de ação a partir daqui no MVP (desfazer é da tela de origem); busca textual livre.

Existência justificada: o espaço é multiusuário (épico 10) e "quem mexeu nisso?" vira pergunta real no primeiro mês de uso familiar. Além disso é a face visível do requisito de auditoria do `CLAUDE.md` e um instrumento de transparência LGPD.

---

### 2.14 Recorrências (adicionada)

Não existe no Organizze — lá, lançamentos fixos só aparecem como um valor do filtro Tipo.

**Propósito:** ver e alterar tudo que se repete, sem reescrever o passado.

**Justificativa:** `CONTEXT.md` modela `Recorrencia` como **regra** que gera ocorrências. Uma regra sem superfície de gestão é estado invisível: o usuário não consegue responder "que assinaturas eu tenho?" nem "aumentei o aluguel, como corrijo daqui pra frente?". Duas perguntas frequentes e caras.

**Blocos:** lista — descrição, valor, periodicidade, próxima ocorrência, conta/categoria, estado `ativa | pausada | encerrada`. Rodapé: `total mensal comprometido: R$ X`.

**Ações:** pausar · retomar · encerrar a partir de uma data · **editar valor a partir de uma data** (as ocorrências passadas permanecem intactas — regra do `CONTEXT.md`) · abrir as ocorrências geradas.

**Estados:** vazio · regra com ocorrências não materializadas ainda · regra cuja categoria foi arquivada.

**Não tem:** regras condicionais ("se o salário cair, então..."); recorrência com valor variável estimado no MVP.

---

### 2.15 Onboarding (adicionada)

**Propósito:** em até três minutos, o usuário tem um saldo na tela que ele reconhece como verdadeiro.

**Justificativa:** o maior ponto de abandono desta categoria é o produto vazio com números que não batem. Nenhuma outra tela importa se esta falhar.

**Passos (todos puláveis, retomáveis pela faixa "Falta configurar" do dashboard):**

1. **Sua primeira conta** — "Quanto tem hoje na sua conta?" Nome, tipo, saldo, data de hoje. Um campo por vez.
2. **Seu cartão** (opcional) — nome, limite, fecha dia, vence dia, conta de pagamento.
3. **Como começar** — `Importar extrato (OFX/CSV)` ou `Lançar meu primeiro gasto`. Termina levando à ação escolhida, não a uma tela de parabéns.

**Estados:** convidado entrando em espaço existente (pula tudo, vai para o dashboard); retomada parcial; erro de criação.

**Não tem:** tour guiado com balões; questionário de perfil financeiro; escolha de plano antes de ver valor.

---

## 3. As correções — as 7 fraquezas do Organizze (teardown §8.5)

| # | Fraqueza | Decisão | Como | Épico |
|---|---|---|---|---|
| 1 | Metas escondidas em "mais opções" | **Corrigimos** | Destino único **Planejamento**; `Limite` com `natureza: teto \| piso`. Custo próximo de zero — é decisão de IA, não de engenharia. **Adiamos** os Pisos e os Objetivos: o MVP entrega só Tetos. | 8 |
| 2 | Conta sem tipo | **Corrigimos** | `Conta.tipo` já está no `CONTEXT.md`. Habilita separar disponível de reservado e tratar investimento à parte. | 2 |
| 3 | Vazios permanentes no dashboard | **Corrigimos, com nuance** | Vazio instrutivo é bom onboarding e ruim depois. Regra: widget sem dado renderiza como vazio instrutivo nos **primeiros 14 dias**; depois disso some e vira uma faixa única "Falta configurar", dispensável. A correção é temporal, não binária. | 4 |
| 4 | Filtro Tipo com 3 eixos ortogonais colapsados em 13 opções | **Corrigimos, com compensação** | Três controles independentes — Natureza × Status × Estrutura. A decomposição é conceitualmente correta mas **encarece o caso comum**: no Organizze "despesas não pagas" é um clique; em três eixos são dois. Compensação: três presets nomeados acima dos eixos (`Não pagos`, `Só despesas`, `Parcelados`). Sem os presets, esta "correção" seria uma piora. | 4 |
| 5 | Base temporal do cartão escondida num link de canto | **Corrigimos** | Seletor persistente no cabeçalho de Relatórios, no mesmo nível do navegador de período, com o valor corrente sempre visível e uma linha de explicação por opção. Impresso no cabeçalho de toda exportação. **Pré-requisito de dado:** `purchase_date` no grupo de parcelamento precisa entrar no **épico 3**, com os lançamentos de cartão. Se entrar depois, o histórico é irrecuperável. | 9 (dado no 3) |
| 6 | Sem visão de fatura como objeto | **Corrigimos — é a maior aposta** | Tela Fatura (§2.5) com estado, régua de ciclo, composição (compras do ciclo × parcelas antigas) e pagamento como transferência explícita. É onde o produto passa de "lista de compras filtrada" para "eu entendo minha fatura", e é a candidata a elemento-assinatura do `docs/design.md` §3. Justificativa de custo: é a pergunta mais repetida do usuário brasileiro e o lugar onde o erro clássico da categoria (pagamento contado como despesa) se manifesta. | 3 (dado) + 4 (tela) |
| 7 | Vocabulário inconsistente ("Tags" × "marcadores") | **Corrigimos** | `CONTEXT.md` é normativo: **Etiqueta** em todo lugar, no código, na API e na UI. Custo zero se feito desde o começo; caro depois. Vale para todo o glossário: `efetivado`, não "pago". | 0 |

### 3.1 O que mantemos igual ao Organizze, de propósito

Copiar o que está certo não é falta de ambição. Estes pontos foram avaliados e mantidos:

- Navegação plana de cinco destinos, sem menu lateral global.
- Formulário modal denso, com atributos secundários colapsados atrás de ícones, e **"salvar e criar outro"** como ação de primeira classe.
- Rodapé de Lançamentos com o modelo **realizado × previsto** completo.
- Alternador de granularidade de período (dia/semana/mês/período) no lugar de um seletor de mês.
- `Copiar do mês anterior` no Planejamento.
- **Arquivar** em vez de excluir.
- Atividades exposta ao usuário.
- Configurações atrás da engrenagem, com sidebar própria.
- Importar com o mesmo peso visual de lançar.
- OAuth para apps de IA: escopo por espaço, leitura por padrão, escrita opt-in, revogável.

---

## 4. Critérios de aceite testáveis

Verificáveis por quem não participou desta conversa. Cada critério é uma afirmação binária.

### 4.1 Formulário de lançamento

| # | Critério |
|---|---|
| F1 | **Mobile:** a partir de qualquer aba, com o app já aberto, é possível salvar uma despesa com valor, data de hoje, conta padrão e categoria sugerida em **no máximo 3 toques**, além da digitação dos dígitos do valor: `( + )` → `categoria` → `salvar`. |
| F2 | **Mobile, app frio:** do ícone na tela inicial até "despesa salva" em **≤ 15 s**, com desbloqueio biométrico, medido em Pixel 6a e iPhone SE de 3ª geração. |
| F3 | **Web:** o modal abre com o foco no campo Valor; `Tab` percorre os campos na ordem visual; `Enter` salva; `Ctrl+Enter` salva e cria outro. Zero uso de mouse do início ao fim. |
| F4 | "Salvar e criar outro" preserva conta, categoria e data, e limpa valor e descrição. Verificável salvando 3 lançamentos seguidos sem reabrir o modal. |
| F5 | Com parcelamento em `N=3` e valor `R$ 100,00`, o explicador exibe `3 parcelas de R$ 33,33` e a frase da sobra; após salvar, existem 3 `Lancamento` com o mesmo `installment_group_id`, valores `33,34 / 33,33 / 33,33`, e a soma é **exatamente** `100,00`. |
| F6 | Ao selecionar um cartão com fechamento dia 28 e lançar em 29/09, o formulário exibe a fatura de destino correta antes de salvar, e o lançamento cai nessa fatura. |
| F7 | **Mobile offline:** com o modo avião ligado, salvar um lançamento retorna confirmação explícita de gravação local e o lançamento aparece na lista com marca de pendente de envio. Ao voltar a rede, sincroniza sem duplicar. |
| F8 | Duplo toque rápido em "salvar" cria **um** lançamento, nunca dois. |

### 4.2 Lançamentos

| # | Critério |
|---|---|
| L1 | Com o preset `Não pagos` ativo, a lista contém exclusivamente lançamentos com `status ≠ efetivado`, e o rodapé recalcula para o subconjunto exibido. |
| L2 | Os três eixos (Natureza, Status, Estrutura) são combináveis: `Despesa + Previsto + Parcelado` retorna a interseção, não a união. Verificável com massa de dados conhecida. |
| L3 | Com qualquer filtro ativo e a barra recolhida, os filtros aplicados são visíveis como chips na tela. **Nunca** existe filtro ativo invisível. |
| L4 | Durante o carregamento, nenhum campo monetário exibe `0,00`. Verificável com a rede limitada a 3G lento. |
| L5 | O rodapé expandido satisfaz: `saldo anterior + receita realizada − despesa realizada = saldo`, e `saldo + receita prevista − despesa prevista = previsto`. Conferível com calculadora em qualquer período. |
| L6 | Uma transferência aparece na lista com rótulo `transferência` e **não** é somada em "despesa realizada" nem em "receita realizada". |
| L7 | Alternar "efetivado" numa linha atualiza o rodapé em ≤ 300 ms sem recarregar a tela, e persiste após recarregar o navegador. |
| L8 | Com 2.000 lançamentos no período, a lista rola a 60 fps no mobile e o tempo até a primeira linha renderizada é ≤ 1,5 s em 4G. |

### 4.3 Fatura

| # | Critério |
|---|---|
| C1 | Registrar o pagamento integral de uma fatura de `R$ 1.000,00` cria **duas** pernas com o mesmo `transfer_group_id`, soma zero, e o estado da fatura passa a `paga`. |
| C2 | Após C1, o relatório de Categorias do mês do pagamento **não** aumenta em `R$ 1.000,00`. Este é o erro clássico da categoria e tem teste E2E dedicado, não só unitário. |
| C3 | Um pagamento de `R$ 400,00` numa fatura de `R$ 1.000,00` leva ao estado `parcialmente_paga`, exibe `restam R$ 600,00` e explica, em texto, o destino do remanescente. |
| C4 | Uma compra parcelada em 5x feita em 03/09 aparece na fatura de outubro com badge `1/5` e com a data da compra `03/09/2026` visível na linha. |
| C5 | O bloco Composição satisfaz `compras do ciclo + parcelas anteriores − estornos = valor da fatura`, ao centavo. |
| C6 | Uma compra feita após o `closing_day` cai na fatura seguinte, e a tela da fatura corrente não a exibe. |
| C7 | A régua do ciclo posiciona "hoje" corretamente entre os quatro marcos, e o texto `fecha em N dias` bate com o calendário em `America/Sao_Paulo`, inclusive na virada de mês e em fevereiro. |
| C8 | Numa fatura fechada, o botão de lançar avisa que o lançamento irá para a próxima fatura **antes** de o usuário salvar. |

### 4.4 Visão geral

| # | Critério |
|---|---|
| V1 | O saldo geral é igual à soma dos saldos das contas marcadas para somar, e exclui as marcadas com "não somar". Conferível somando a lista da própria tela. |
| V2 | Um espaço sem cartões cadastrados, após o 15º dia de uso, **não** exibe widget vazio de cartões; exibe no máximo a faixa "Falta configurar". |
| V3 | Com a API indisponível, a tela renderiza o último saldo conhecido com o rótulo `desatualizado` e o horário. Não exibe `0,00` nem tela em branco. |
| V4 | O botão de ocultar valores substitui **todos** os valores monetários da tela, incluindo os dos gráficos, e a preferência persiste entre sessões e entre dispositivos. |
| V5 | Do dashboard, lançar uma despesa é 1 clique (web) e o formulário abre em ≤ 200 ms. |
| V6 | "A pagar" lista apenas lançamentos com `status = previsto` e `posted_at ≤ hoje + 7 dias`, com os atrasados acima e sob faixa própria. |

### 4.5 Importação

| # | Critério |
|---|---|
| I1 | Importar o **mesmo** arquivo OFX duas vezes cria `N` lançamentos na primeira e **0** na segunda; a tela de resultado da segunda diz explicitamente que o arquivo já foi importado e quando. |
| I2 | Nenhum lançamento é criado antes do passo 3 (Revisão) ser confirmado pelo usuário. Verificável interrompendo o fluxo no passo 2 e conferindo a lista. |
| I3 | Uma linha marcada `conciliar?` exibe lado a lado o registro importado e o manual, com as diferenças destacadas, e não altera nada sem confirmação explícita. |
| I4 | "Desfazer esta importação" remove exatamente os lançamentos criados por aquele lote, restaura os lançamentos manuais que haviam sido conciliados ao estado anterior, e não toca em nada mais. |
| I5 | Um CSV com data em `DD/MM/AAAA` e decimal com vírgula é interpretado corretamente, e a prévia do passo 2 mostra os valores já formatados como serão gravados. |
| I6 | Um arquivo corrompido produz mensagem que diz o formato esperado e oferece o exemplo, nunca "erro ao processar arquivo". |
| I7 | Toda importação aparece em Atividades com contagem de criados, ignorados e conciliados. |

---

## 5. Priorização — telas × épicos

| Tela | Épico | MVP | Nota |
|---|---|---|---|
| Onboarding | 4 (web) / 5 (mobile) | ✅ | Sem ele o dashboard não tem o que mostrar |
| Contas | 2 | ✅ | Com `tipo` desde o início |
| Categorias | 2 | ✅ | Mesclar fica para o 9 |
| Lançamentos | 2 → 4 | ✅ | Modelo no 2, tela no 4 |
| Formulário de lançamento | 2 → 4 / 5 | ✅ | Parcelamento entra no 3 |
| Cartões | 3 | ✅ | — |
| **Fatura** | 3 (dado) + 4 (tela) | ✅ | Inclui `purchase_date` no grupo de parcelamento |
| Visão geral | 4 | ✅ | — |
| Configurações — Preferências, Segurança | 1 / 4 | ✅ | Mínimo viável |
| Atividades | 1 (log) + 4 (tela) | ✅ leitura | O log é obrigatório desde o épico 1; a tela é barata e compra confiança cedo |
| Importação | 6 | ➖ | Primeiro incremento pós-MVP. É o que sustenta a retenção no mês 2 |
| Etiquetas | 2 | ➖ | Modelo no 2, gestão pós-MVP; o formulário já grava |
| Recorrências | 8 | ➖ | Regra pode ser criada no formulário antes da tela de gestão existir |
| Planejamento — Tetos | 8 | ➖ | — |
| Planejamento — Pisos e Objetivos | 8 | ❌ | Depois dos Tetos, e só se os Tetos forem usados |
| Relatórios | 9 | ❌ | Dashboard cobre a pergunta básica no MVP |
| Seletor de base temporal do cartão | 9 | ❌ | Mas o **dado** é obrigatório no épico 3 |
| Membros e papéis | 10 | ❌ | — |
| Página de preços · Checkout · Plano e cobrança | 11 | ❌ | §2.12b. Depende **de forma dura** do épico 10: os níveis `Família` e `Negócio` vendem pessoas e espaços |
| Lista de espera da conexão bancária | 11 | ❌ | Seção da página de preços. É o insumo da revisão trimestral do ADR 0003 |
| Conexões | 12 | ❌ | Lugar reservado na IA desde já |
| Apps conectados / Chaves de API | pós-12 | ❌ | — |

**MVP = épicos 1 a 5.** Um produto manual completo, web e mobile, com cartão e fatura corretos. É vendável: o plano mais barato do Organizze é exatamente isso.

**Riscos da fatia:** sem Importação (6), o custo de manutenção diário é alto e a retenção no mês 2 sofre. Sem Relatórios (9), o dashboard tem que responder sozinho "para onde foi meu dinheiro" — por isso o bloco 6 do dashboard não é opcional no MVP.

**Ordem sugerida pós-MVP:** 6 (Importação) → 8 (Planejamento) → 9 (Relatórios) → 7 (Inteligência) → 10 → 11 → 12.
Inteligência (7) vem depois de Importação porque categorização automática sem volume de dados importados não tem de onde aprender.

---

## 6. Riscos de produto

Onde o usuário desiste, se confunde ou desconfia — em ordem de gravidade.

| Risco | Onde acontece | Mitigação |
|---|---|---|
| **Pagamento de fatura contado como despesa** — dobra o gasto do mês | Fatura, Relatórios | Transferência de duas pernas por construção + critério C2 como teste E2E obrigatório. É o erro que mata o produto. Se um spec chegar perto disso, o épico para. |
| **Saldo que o usuário não reconhece** | Onboarding, Visão geral | Saldo inicial com data obrigatória; ajuste de saldo sempre via lançamento visível; carimbo de "desatualizado" quando o dado é velho |
| **Importação duplicando lançamentos** | Importação | Idempotência por `(tenant, provider, external_id)` + hash; passo de revisão obrigatório; desfazer o lote inteiro |
| **Custo de manutenção diário** — lançar tudo à mão cansa; abandono típico na 3ª semana | Formulário, mobile | 3 toques (F1); "salvar e criar outro"; recorrências; sugestão de categoria; e Importação como prioridade máxima pós-MVP |
| **Transferência some do relatório e parece dinheiro perdido** | Relatórios | Rodapé de reconciliação nomeando os valores excluídos e o motivo |
| **Realizado × previsto confunde** — "por que o app mostra diferente do meu banco?" | Lançamentos, Visão geral | Rótulos explícitos em toda soma; o previsto nunca aparece sem o realizado ao lado; nenhum número agregado sem sua base declarada |
| **Filtro ativo invisível** altera o total e o usuário acha que sumiu dinheiro | Lançamentos, Relatórios | L3: chips sempre visíveis; totais sempre acompanhados do recorte |
| **Base temporal do cartão** — dois relatórios do mesmo mês com números diferentes | Relatórios | Seletor persistente, explicado, e impresso em toda exportação |
| **Sincronização offline silenciosa** — o usuário lançou e o dado não subiu | Mobile | Fila visível no banner; confirmação explícita de gravação local; retry com backoff; nunca "salvo" sem estar |
| **Categorização automática errada e invisível** | Formulário, Importação | Rótulo `sugerida`, motivo ao toque, sempre editável, nunca aplicada em massa sem revisão |
| **Espaço compartilhado**: alguém apaga o lançamento do outro | épico 10 | Papéis (`visualizador` não escreve) + Atividades + soft delete |
| **Densidade contra acessibilidade** — jornal financeiro numa tela de 5,4" | Todas | Respeitar Dynamic Type / tamanho de fonte do sistema até 200%; nenhum significado dependendo só de cor (`docs/design.md` §2.4); alvos de toque ≥ 44 pt |
| **Vazios permanentes** fazem o produto parecer não usado | Visão geral | Regra dos 14 dias (§3, item 3) |

---

## 7. Objeções e vetos deste documento

1. 🔺 **Ambiguidade `Limite` × `Meta` no `CONTEXT.md`.** A unificação do teardown §8.2 é entre `Limite` (teto) e a **meta de receita mensal** — não entre `Limite` e a `Meta` de acúmulo, que é outra entidade (plurimensal, com prazo). Bloqueia a especificação do épico 8 até o `arquiteto-dominio-financeiro` resolver. Proposta em §2.6.
2. ⛔ **Veto: cálculo de juros de rotativo, IOF, multa ou encargo de cartão.** Sem os parâmetros contratuais do banco, qualquer número produzido está errado sem aviso. Encargo entra como lançamento quando cobrado. Vale para sempre, não só para o MVP.
3. ⛔ **Veto: "ajustar saldo" que escreve o saldo diretamente.** Saldo é derivado. Ajuste cria lançamento visível de categoria "Ajuste de saldo".
4. ⛔ **Veto: importação que aplica lançamentos sem o passo de revisão**, ou que sobrescreve/apaga registro do usuário automaticamente.
5. ⚠️ **Dependência de ordem:** `purchase_date` no grupo de parcelamento precisa entrar no **épico 3**, junto com os lançamentos de cartão. Se ficar para o épico 9 com os relatórios, o histórico anterior é irrecuperável e a base "data da compra" fica permanentemente incompleta.
6. ⚠️ **A decomposição do filtro Tipo em três eixos só é uma melhoria com os presets.** Sem eles, encarecemos o caminho mais usado do produto para ganhar pureza conceitual. Se os presets caírem do escopo, prefiro manter a lista linear do Organizze.

---

## 8. Próximos passos

1. Resolver o item 1 do §7 com o `arquiteto-dominio-financeiro` (`/domain-modeling`) e atualizar o `CONTEXT.md`.
2. `/prototype` com três direções radicalmente diferentes para **Lançamentos** e **Fatura** — as duas telas que carregam a identidade. O humano escolhe (`docs/design.md` §4).
3. Fixar os tokens da direção escolhida em `packages/ui` antes de qualquer outra tela.
4. `/to-spec` do épico 3 (Cartão) incluindo `purchase_date`, e do épico 4 (Web MVP) com este inventário como entrada.
5. Gate de risco (appsec ∥ LGPD ∥ validador-financeiro) sobre os specs — em especial Fatura e Importação.
