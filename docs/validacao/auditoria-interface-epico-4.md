# Auditoria de interface — épico 4

- **Data:** 2026-09-02
- **Escopo:** `apps/web` — entrada, visão geral, lançamentos, cartões, contas,
  categorias, e os formulários de lançamento, conta, cartão, pagamento e estorno
- **Revisão:** 2026-09-02, após fechar o grupo A das pendências
- **Norma:** `docs/design.md` §5 (lista obrigatória) e `docs/design/direcao-visual.md`
- **Método:** telas abertas no navegador contra o banco local semeado, e não
  capturas de mock. Nenhum item abaixo foi marcado por leitura de código.

---

## 1. A lista obrigatória do `docs/design.md` §5

| # | Item | Situação |
|---|---|---|
| 1 | Zero roxo, índigo ou violeta como primária | ✅ Petróleo `#0B4F5F` (claro) / `#5FC0D6` (escuro) |
| 2 | Zero gradiente decorativo, zero texto com gradiente | ✅ O único `linear-gradient` do produto é a hachura de estouro do trilho, que é **dado**, não enfeite |
| 3 | Zero glassmorphism | ✅ Nenhum `backdrop-filter` |
| 4 | Zero emoji na interface | ✅ `✓ ○ ⇄ ‹ › ✕` são glifos tipográficos, renderizados na fonte do produto |
| 5 | Nem toda informação dentro de card | ✅ **Nenhum** card. O agrupamento é rótulo em caixa alta de 11px, régua de 1px e o buraco de 44px da escala. O único retângulo com raio e sombra é o modal — que se move e se dispensa |
| 6 | Contraste de escala ≥ 3:1 | ✅ 56 / 15 = **3,73 : 1**, por salto de tamanho e não por cinza mais claro |
| 7 | Coluna de valor tabular e à direita | ✅ `tabular-nums lining-nums slashed-zero`, largura fixa, sinal em coluna própria |
| 8 | Modo escuro projetado, não invertido | ✅ Croma reduzido, elevação por superfície + borda, verdes e vermelhos reajustados. Segue o sistema (DP-30), com a escolha do usuário vencendo nos dois sentidos. Conferido na tela densa, que é onde o escuro invertido quebra |
| 9 | Nenhuma animação decorativa; `prefers-reduced-motion` | ✅ A única transição do produto é a largura da carga do trilho, e ela zera sob `prefers-reduced-motion` |
| 10 | WCAG AA, e nada dependendo só de cor | ✅ Ver §2 |
| 11 | O texto cita algo específico do usuário | ✅ *"Ainda há −R$ 149,00 previstos para sair este mês, e o saldo fecha menor do que está hoje."* — montada com os números daquele espaço |
| 12 | O elemento-assinatura aparece na tela | ✅ Trilho no painel, no rodapé do extrato, na prévia do rateio e no ciclo da fatura |
| 13 | Alguém saberia que é a Mavia | ✅ Trilho + numerais da Archivo + papel quente. Nenhum concorrente da categoria tem o trilho |

---

## 2. Sinal sem depender de cor — os quatro canais, conferidos na tela

O item 10 é o que mais se marca sem verificar, então ele fica detalhado.

| Canal | Onde se vê | Funciona em escala de cinza |
|---|---|---|
| **Glifo** | `−` (U+2212) e `+`, sempre renderizados, em coluna própria de 1 dígito | Sim |
| **Direção da carga** | Trilho de despesa carrega da direita para a esquerda; de receita, ao contrário | Sim |
| **Peso** | Realizado 600, previsto 400 — separa a *certeza*, que é outra dimensão | Sim |
| **Cor** | Verde `#0F6B43` / vermelho `#A32B22` no claro; `#4FB98A` / `#EF8577` no escuro | Não, e por isso nunca sozinha |

Três dos quatro sobrevivem à escala de cinza. O `+` da receita é sempre
desenhado — o Organizze só mostra o `−`, e a ausência de sinal é sinal fraco
demais para quem não distingue as duas cores.

**Estouro é textura, não cor:** o trecho excedente do trilho é hachurado a 45°,
e o valor aparece por extenso ao lado.

**Transferência é neutra**, de propósito: ela não é receita nem despesa
(`CONTEXT.md`), e pintá-la faz pagamento de fatura parecer despesa — o erro
clássico da categoria.

---

## 3. Onde a implementação se afasta da direção visual

Dois desvios conscientes (D-2 e D-3) e um item revertido por decisão do dono do
produto (D-1). Nenhum é esquecimento.

### D-1 · ~~O escuro deixou de seguir `prefers-color-scheme`~~ — revertido

**Este item não é mais um desvio.** Ele está registrado porque o caminho
importa mais do que o desfecho.

A primeira versão herdava `prefers-color-scheme`, e a tela de entrada abriu
escura. Li o cabeçalho da direção visual — *"o escuro é preferência do usuário,
não a cara do produto; no conflito, o claro vence"* — como "não herdar o
sistema", e troquei a herança por uma escolha explícita dentro do produto.

**O dono do produto decidiu o contrário (DP-30):** o escuro segue a
preferência do sistema. A leitura correta é que "o claro vence" governa a
escolha de forma e de material, não a herança de preferência — respeitar o que
a pessoa já declarou ao sistema é cortesia, não conflito com a identidade.

Implementado como: `@media (prefers-color-scheme: dark)` sobre
`:root:not([data-tema='claro'])`, mais `:root[data-tema='escuro']`. O `:not()`
é o que permite forçar o claro num sistema escuro sem depender de ordem de
regra. A paleta escura tem **uma** definição, aplicada por referência nos dois
lugares: CSS não tem mixin, e duas cópias de trinta e dois valores divergem.

### D-2 · O trilho do herói mede despesa, não saldo

**§1.3 sugeria:** denominador = saldo previsto do mês, carga = realizado.

Isso não fecha. Quando ainda há dinheiro para **sair**, o saldo de hoje é
*maior* que a projeção, e a geometria — que existe para acusar estouro de gasto
— lê a diferença como estouro. Na primeira execução, com R$ 149,00 ainda por
pagar, o painel exibiu *"+R$ 149,00 acima do previsto"*: dizendo que a pessoa
gastou demais **porque ela ainda não gastou**.

O par passa a ser despesa realizada contra despesa do mês. É a mesma pergunta
do documento — *quanto disto já é fato, e onde estava previsto terminar* — sobre
um par em que ela tem resposta, e o denominador continua nomeado em texto.

### D-3 · Sem `size-adjust` nas fontes

**§3.1 pedia** métricas de fallback calibradas para a troca de fonte não mexer
na altura das linhas do extrato. A altura da linha é fixa em `--altura-linha` e
não depende da métrica intrínseca, o que resolve o mesmo problema de forma
estrutural — e não envelhece na próxima versão da fonte. Registrado como P-5
em `docs/pendencias.md`.

---

## 4. Defeitos achados **por olhar a tela**, e corrigidos

Nenhum destes apareceu em teste de unidade, e os três eram de leitura de dinheiro.

| # | O que se via | Por que estava errado |
|---|---|---|
| **I-1** | Saldo de R$ 34.070,10 em verde, com `+` na frente | Saldo é **estoque**, não direção de dinheiro. Verde diz "entrou"; o `+` afirma um sentido que o número não tem. Agora saldo é tinta, e só o negativo ganha cor — conta no vermelho é fato que merece alarme |
| **I-2** | *"+R$ 149,00 acima do previsto"* no painel | O trilho do herói acusava estouro num mês em que nada tinha estourado. Ver D-2 |
| **I-3** | Categoria padrão do formulário: **"Ajuste de saldo"** | É não-analítica: fica fora do relatório de categoria e de todo Planejamento. Como padrão, faria quem lança às pressas registrar gastos que nunca apareceriam em relatório nenhum — e o erro seria invisível justamente para quem tem pressa. A ordenação passa a pôr analítica antes de não-analítica |

**I-3 é o mais grave dos três**, e o único que não deixaria rastro: o lançamento
existe, o saldo bate, e o relatório simplesmente não o menciona.

---

## 5. Densidade — medida, não estimada

Contagem na tela de 900px de altura útil, contra a medição do teardown:

| | Mavia | Organizze |
|---|---|---|
| Altura da linha | **36px** | 56px |
| Cabeçalho de dia | 24px | 40px |
| Cromo total | 228px | 312px |
| **Lançamentos visíveis** | **15** | 6 |

As três remoções que pagam a diferença: o ícone de categoria em círculo
(substituído por quadrado de 8px), o card (padding e sombra que não informam) e
a faixa de alerta permanente.

---

## 6. Defeitos da segunda passagem

Achados ao exercer pela primeira vez fluxos que existiam só como rota testada.

| # | O que aconteceu | O que estava errado |
|---|---|---|
| **I-4** | "Fechar a fatura" no dia 2, numa fatura que fecha dia 25 e já continha compras dos dias 12 e 14. O pagamento seguinte devolveu **500** | Faltava a regra de que **quem fecha uma fatura é o calendário**. Fechar cedo cria uma fatura com compras posteriores ao próprio fechamento e empurra as seguintes do ciclo para o mês que vem, em silêncio. Migration 0015 |
| **I-5** | O pagamento datado ia como **meia-noite** do dia | Meia-noite de 05/07 antecede uma compra das 15h de 05/07, e o banco recusa compensar antes de acontecer. Hoje vira o agora; dia passado vira o fim do dia |
| **I-6** | O contrato prometia `origem: manual \| conectado` no lançamento | O banco tem **dois** enums de mesmo nome de coluna. O tipo da conta foi reusado no lançamento, prometendo um valor inexistente e escondendo `parcelamento` — que é o que o terceiro eixo de filtro precisa |
| **I-7** | Com filtro ativo, o "saldo no dia" continuava somando o subconjunto visível | Um número que parece saldo e não é. Agora ele some com filtro, e o rodapé avisa que os totais são do mês inteiro |

I-4 e I-6 têm a mesma forma: **a rota existia, era testada, e ninguém a tinha
exercido de ponta a ponta.** É o argumento para o épico 4 existir antes do
épico 5, e não depois.

---

## 7. O que **não** foi auditado, e por quê

- **Contraste medido com colorímetro.** Os valores da §2 da direção visual foram
  computados quando a paleta foi fixada; esta auditoria os assume e verifica o
  uso, não a aritmética.
- **Leitor de tela real.** Os rótulos acessíveis existem e estão testados por
  atributo (`aria-label` composto pelo formatador, `role="alert"`,
  `role="radiogroup"`, `role="dialog"`), mas ninguém rodou NVDA ou VoiceOver
  contra as telas. É a diferença entre "tem rótulo" e "é usável", e ela não foi
  fechada.
- **Telas ainda inexistentes:** relatório, planejamento, importação. Cada uma
  precisa da própria passagem por esta lista.
- **Estorno de compra no cartão** não existe, e a tela diz o porquê em vez de
  oferecer um botão que falha. Ver P-6 em `docs/pendencias.md`: falta decidir em
  qual fatura o crédito entra, e isso é regra de negócio.
- **O eixo `fixo` do filtro de origem** entra com a recorrência, no épico 8. Um
  filtro que devolve sempre vazio é pior do que um filtro a menos.
