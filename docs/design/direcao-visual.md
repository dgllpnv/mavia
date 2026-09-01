# Direção visual da Mavia — "Papel e trilho"

> **Status: APROVADA em 2026-09-01.** O dono do produto escolheu a direção **A — "Papel e trilho"**,
> **sobre fundo claro**. O claro é a identidade canônica da Mavia; o modo escuro da §2.5 permanece
> como preferência do usuário, não como a cara do produto. Quando os dois conflitarem numa escolha,
> **o claro vence**. As direções B e C da §8 ficam como registro do que foi considerado e descartado.
> Ver `docs/adr/0006`, Emenda 1. Prévia navegável: `docs/design/preview-direcao-visual.html`.


- **Status:** **Aprovada.** Proposta pelo `engenheiro-frontend-web`, escolhida pelo dono do produto em 2026-09-01, sobre fundo claro. Normativa a partir daqui.
- **Data:** 2026-09-01
- **Normativo acima deste documento:** `docs/design.md` (seções 1, 2, 3 e 5) e `docs/adr/0006-identidade-visual-autoral.md`
- **Pesquisa de base:** `docs/pesquisa/organizze-teardown.md`
- **Vocabulário:** `CONTEXT.md`. Nenhum sinônimo novo foi inventado aqui.

## A tensão, e como ela se resolve

Os clientes gostam da **organização** do Organizze. Eles não gostam do verde saturado, nem do card branco com sombra, nem do ícone em círculo colorido — eles nunca falaram disso. Eles falaram que "acham tudo rápido" e que "o formulário não atrapalha".

Então herdamos, sem cerimônia:

- a **arquitetura de informação** (navegação plana, cinco destinos, configuração atrás de um único portão);
- a **economia de campos** do formulário de lançamento — cinco primários, quatro atributos colapsados, salvar-e-criar-outro;
- a **densidade** do extrato agrupado por dia, com totalizador fixo no rodapé;
- o modelo **realizado × previsto** como coração conceitual.

E recusamos, integralmente, a pele: o verde-marca de primeira, a moldura de card em torno de cada informação, o ícone-em-círculo como unidade de identidade visual, e o esconderijo dos controles que mais mudam o número na tela.

**Copiamos a clareza, não a pele.**

---

## 1. O elemento-assinatura: **o trilho**

### 1.1 A ideia

Todo número da Mavia que representa algo em curso repousa sobre um **trilho**: uma régua horizontal de 2px, quadrada nas pontas, imediatamente abaixo do número, com três partes e uma só gramática.

```
   R$ 4.281,90
   ███████████████████████▌ · · · · · · · · │ · · · ·
   └─ realizado ──────────┘ └─ pendente ──┘ ↑
                                        previsto
```

| Parte | O que é | Como se desenha |
|---|---|---|
| **Trilho** (track) | o total esperado — o denominador | 2px, cor `--line`, largura da caixa do número, raio 0 |
| **Carga** (fill) | o que já é fato — o realizado | 2px, cor `--ink-1`, cresce a partir da borda de origem |
| **Marca** (tick) | onde o esperado termina | 1px × 8px vertical, `--ink-2`, atravessa o trilho |

Uma única frase define a semântica em todas as telas: **quanto disto já é fato, e onde estava previsto terminar.** O denominador muda de tela para tela e é sempre nomeado em texto ao lado; a forma, nunca.

Três regras fecham a gramática:

1. **A carga nunca usa a cor da marca nem verde/vermelho.** Ela é tinta. O trilho é estrutura, não dado categórico — pintá-lo de petróleo faria o usuário achar que a cor da marca significa alguma coisa (`docs/design.md` §2.4).
2. **Estouro é textura, não cor.** Quando o realizado passa a marca, o trecho excedente é preenchido com hachura a 45° em `--despesa`, e um rótulo curto aparece: `+R$ 312 acima`. Cor sozinha nunca carrega isso.
3. **Direção codifica sinal.** Trilho de despesa carrega da **direita para a esquerda**; trilho de receita, da **esquerda para a direita**. Segundo canal, gratuito, independente de cor.

### 1.2 Por que isso serve a um produto financeiro

Porque a pergunta que um produto de finanças pessoais existe para responder não é "quanto eu tenho" — é **"quanto disto já aconteceu e quanto ainda vai acontecer"**. O Organizze tem essa resposta: está no rodapé colapsado do extrato, em seis linhas de texto que o usuário precisa expandir. O teardown chama isso de "coração conceitual do produto" — e ele está escondido atrás de um chevron.

O trilho tira o realizado × previsto do rodapé e o cola embaixo de **todo número que importa**, como forma, custando 2 pixels de altura. É a rara decisão em que a escolha estética e a funcional são a mesma: o usuário para de ler seis linhas e passa a ver uma proporção.

Além disso o trilho resolve, sozinho, três exigências do `docs/design.md`:

- **Remove a caixa** (§2.2). O trilho cria ritmo horizontal e agrupa blocos sem precisar de `shadow-lg`. Onde há trilho, não há card.
- **É o movimento que explica** (§2.6). A carga anima sua largura quando o dado muda — e só então. Nada mais no produto anima. Sob `prefers-reduced-motion`, a largura salta sem transição.
- **É reconhecível.** Uma captura de tela de 200px de largura da Mavia mostra um trilho. Nenhum concorrente da categoria tem esse elemento.

### 1.3 O trilho nas quatro telas

**Dashboard.** Um único trilho grande (largura total da coluna dominante, 3px em vez de 2px) sob o saldo herói. Denominador: o **saldo previsto do mês**. A carga é o realizado até hoje. A marca fica no previsto do mês. Rótulo: `realizado de R$ 6.400 previstos`. Nas linhas de conta, um micro-trilho de 32px de largura à direita do valor mostra a participação daquela conta no saldo geral — mesma gramática, denominador diferente e nomeado.

**Lançamentos.** Cada grupo de dia termina em `saldo no dia` com um trilho curto (largura da coluna de valor). Denominador: o saldo previsto para o fim daquele dia. Ou seja, o usuário rola o extrato e lê, dia a dia, o quanto o dia já se cumpriu. O rodapé fixo tem o trilho do mês inteiro, e é o mesmo trilho do dashboard — a continuidade entre as telas é o ponto.

**Fatura.** Aqui o denominador é **tempo**, e é o único lugar onde o trilho tem **duas marcas** — `fecha` e `vence`. Isto é a fatura como objeto físico com ciclo, que o teardown aponta como ausente no Organizze (§8.5, item 6). A carga avança com os dias; o segmento entre as duas marcas é o período de graça, desenhado com o trilho mais alto (4px) e vazado. Abaixo, um segundo trilho, o de valor: carga = lançamentos já na fatura, marca = projeção de fechamento.

```
   Fatura de setembro · Nubank
   R$ 2.184,30
   ████████████████████████████████│░░░░░░░│
   1 set                        fecha 28   vence 5 out
```

**Relatório.** O trilho vira o mark principal: a composição por categoria é uma lista de trilhos empilhados, um por categoria, alinhados à esquerda, com o valor à direita em algarismos tabulares. Onde existe Limite, a marca é o teto e o estouro é hachurado. Onde não existe, a marca é o realizado do mesmo mês do ano anterior. Uma rosca de categorias não aparece em lugar nenhum do produto (ver §6.2).

---

## 2. Tokens

Root `font-size: 16px`. Todos os tokens vivem em `packages/ui`; componente novo compõe token, não inventa valor.

### 2.1 Escala tipográfica

| Token | rem | px | line-height | tracking | Uso |
|---|---|---|---|---|---|
| `--text-heroi` | 3.5 | 56 | 1.00 | -0.03em | O número herói. **Um por tela.** |
| `--text-4` | 2.25 | 36 | 1.05 | -0.02em | Valor de fatura, total de seção |
| `--text-3` | 1.5 | 24 | 1.15 | -0.015em | Título de tela |
| `--text-2` | 1.125 | 18 | 1.30 | -0.005em | Subtítulo, valor de linha em destaque |
| `--text-1` | 1 | 16 | 1.45 | 0 | Valor no extrato, descrição de lançamento |
| `--text-corpo` | 0.9375 | 15 | 1.50 | 0 | Texto de interface (o corpo) |
| `--text-sm` | 0.8125 | 13 | 1.40 | 0 | Metadados: conta, parcela `3/5`, data |
| `--text-xs` | 0.6875 | 11 | 1.35 | +0.06em | Rótulo de coluna, caixa alta. Nunca frase. |

**Contraste de escala: 56 / 15 = 3.73 : 1.** O `docs/design.md` §5 exige ao menos 3:1. Passa com folga, e passa por salto de tamanho, não por cinza mais claro. A escala salta de 24 para 36 e de 36 para 56 exatamente para que não exista "tamanho médio confortável" — o default de quem não decidiu.

Pesos: 400 (corpo), 500 (rótulo), 600 (valor realizado, título), 700 (herói). **Peso é canal semântico:** realizado é 600, previsto é 400. Ver §3.5.

### 2.2 Escala de espaçamento

Base 4, com a cauda deliberadamente não-linear:

```
--s-2: 2px    --s-4: 4px    --s-6: 6px    --s-8: 8px
--s-12: 12px  --s-16: 16px  --s-20: 20px  --s-24: 24px
--s-32: 32px  --s-44: 44px  --s-64: 64px  --s-96: 96px
```

Não existem 40 e 48. O buraco entre 24 e 44 é intencional: separação **dentro** de um bloco usa até 24; separação **entre** blocos começa em 44. Isso torna a estrutura da página legível sem uma única borda, e é o que substitui o card (`docs/design.md` §2.2).

Gutter de grade: `--s-44` no desktop, `--s-24` no tablet, `--s-16` no mobile.

### 2.3 Raios — deliberadamente não uniformes

`docs/design.md` §1 marca "raio de borda idêntico em absolutamente tudo" como sinal de template. Aqui o raio **classifica**:

| Token | Valor | Significa |
|---|---|---|
| `--r-0` | 0 | Estrutura fixa: trilhos, linhas divisórias, cabeçalho de tabela, eixos e áreas de gráfico |
| `--r-1` | 2px | Controle: input, botão, chip, célula selecionada |
| `--r-2` | 4px | Ponta de dado de gráfico (exigência da skill `dataviz`), menu |
| `--r-3` | 8px | **Só o que se move ou se dispensa:** modal, popover, toast |

Nada acima de 8px existe no produto. `rounded-2xl` é motivo de reprovação em revisão.

### 2.4 Elevação — uma hierarquia, três degraus

| Token | Claro | Escuro (projetado, não invertido) |
|---|---|---|
| `--elev-0` | nenhuma sombra; separação por `1px solid var(--line)` | idem |
| `--elev-1` | `0 1px 2px rgba(28,26,22,.06), 0 4px 12px rgba(28,26,22,.10)` | `--surface-2` + `1px solid var(--line-forte)` + `0 8px 20px rgba(0,0,0,.55)` |
| `--elev-2` | `0 2px 4px rgba(28,26,22,.08), 0 16px 40px rgba(28,26,22,.18)` | `--surface-3` + `1px solid var(--line-forte)` + `0 16px 40px rgba(0,0,0,.70)` |

`--elev-0` cobre ~95% da interface. No escuro, sombra praticamente não comunica elevação: a elevação passa a ser **superfície mais clara + borda**, que é a diferença mais visível entre um escuro projetado e um escuro invertido.

### 2.5 Neutros — temperatura quente, escolhida e mantida

A referência é papel de jornal financeiro, não terminal. Os neutros têm matiz ~45° e croma mínimo — quentes o bastante para não serem cinza, discretos o bastante para não serem bege.

| Token | Claro | Escuro | Contraste vs. superfície base |
|---|---|---|---|
| `--paper-0` (plano da página) | `#FFFEFB` | `#0E0D0B` | — |
| `--surface-1` (superfície base) | `#FBF9F4` | `#161512` | — |
| `--surface-2` (recuada / zebra / thead) | `#F4F1E8` | `#1E1C18` | 1.07 : 1 |
| `--surface-3` (modal) | `#EDE9DD` | `#262320` | — |
| `--line` (hairline) | `#E3DED2` | `#2E2A24` | 1.28 : 1 |
| `--line-forte` | `#CFC8B6` | `#453F36` | 1.59 : 1 |
| `--ink-4` (desabilitado) | `#A79F8B` | `#6B6558` | 2.50 : 1 |
| `--ink-3` (muted) | `#756E5D` | `#8E887A` | **4.82 : 1** / 5.18 : 1 |
| `--ink-2` (secundário) | `#575144` | `#B8B2A4` | 7.49 : 1 / 8.64 : 1 |
| `--ink-1` (corpo) | `#1C1A16` | `#F2EFE7` | 16.51 : 1 / 15.89 : 1 |
| `--ink-0` (número em destaque) | `#0E0D0B` | `#FFFDF6` | 18.46 : 1 / 17.94 : 1 |

Nota sobre o escuro projetado: o claro é quente e razoavelmente cromático; o escuro **reduz o croma dos neutros** porque marrom escuro fica lamacento em tela retroiluminada, e **abre a distância entre `--surface-1` e `--surface-2`** porque no escuro a elevação depende dela. `--ink-3` no escuro é mais claro em valor absoluto do que a inversão daria, para compensar o halo do texto claro sobre fundo escuro.

### 2.6 Primária — **Petróleo**

Nem roxo, nem índigo, nem violeta, nem o verde do Organizze. Um azul-petróleo profundo (matiz ≈ 192°), escuro o suficiente para funcionar como tinta institucional e frio o suficiente para nunca ser confundido com a semântica de receita.

| Passo | Hex | Papel |
|---|---|---|
| `--petroleo-50` | `#EEF7F9` | fundo de estado selecionado (claro) |
| `--petroleo-100` | `#D6EBF0` | |
| `--petroleo-200` | `#A9D6E1` | hover de texto primário (escuro) |
| `--petroleo-300` | `#5FC0D6` | **primária no escuro** — 8.69 : 1 |
| `--petroleo-400` | `#2E9BB4` | active (escuro) |
| `--petroleo-500` | `#12798F` | |
| `--petroleo-600` | `#0E6478` | hover (claro), anel de foco (claro) — 6.41 : 1 |
| `--petroleo-700` | `#0B4F5F` | **primária no claro** — 8.69 : 1 |
| `--petroleo-800` | `#083B47` | active (claro) |
| `--petroleo-900` | `#062A33` | |

A simetria de 8.69 : 1 nos dois modos não é coincidência: os dois passos foram escolhidos para que o botão primário tenha exatamente o mesmo peso ótico em claro e escuro. Papel do petróleo: **navegação, ação e identidade. Nunca dado.**

### 2.7 Semânticas de direção do dinheiro

| Papel | Claro | Contraste | Escuro | Contraste | Fundo sutil claro / escuro |
|---|---|---|---|---|---|
| Receita | `#0F6B43` | 6.23 : 1 | `#4FB98A` | 7.51 : 1 | `#E8F2EC` / `#12241C` |
| Despesa | `#A32B22` | 6.82 : 1 | `#EF8577` | 7.21 : 1 | `#F7EAE7` / `#2A1714` |
| Atenção (vence ≤ 3 dias) | `#8A5A00` | 5.63 : 1 | `#E0A63C` | 8.42 : 1 | — |
| Transferência | `--ink-2` | 7.49 : 1 | `--ink-2` | 8.64 : 1 | — |
| Previsto | **não é cor** — é peso 400 + trilho vazio | — | idem | — | — |

Três decisões de opinião aqui:

- **Transferência é neutra, de propósito.** Ela não é receita nem despesa (`CONTEXT.md`), e pintá-la de verde ou vermelho é exatamente o erro que faz pagamento de fatura virar despesa duplicada. Transferência recebe `--ink-2` e um ícone de duas setas.
- **Previsto não tem cor própria.** Cor comunicaria "outro tipo de dinheiro"; peso comunica "menos certo". Realizado é 600, previsto é 400, e o trilho fecha o sentido.
- **O verde e o vermelho são reajustados no escuro**, não invertidos: no claro são escuros e pouco saturados; no escuro são claros e mais dessaturados que o simples clareamento daria, porque saturam demais sobre fundo escuro (`docs/design.md` §2.4).

### 2.8 Paleta de dados — separada da paleta de marca

Nenhum hex desta seção aparece em botão, navegação ou estado. Nenhum hex das seções 2.6 e 2.7 aparece em gráfico. A separação é o ponto: se a cor da marca aparecer num gráfico, o usuário vai procurar significado nela.

Ordem fixa de seis slots, atribuída por **entidade** (a categoria), nunca por posição ou por rank. Filtro que remove uma série não repinta as sobreviventes.

| Slot | Família | Claro | Escuro |
|---|---|---|---|
| 1 | azul-aço | `#1B6FA8` | `#3E92CE` |
| 2 | terracota | `#8C4A28` | `#A85830` |
| 3 | verde-mar | `#17A177` | `#1DAE80` |
| 4 | vinho | `#9E2E62` | `#B33470` |
| 5 | mostarda | `#B08C10` | `#B08C10` |
| 6 | rosa | `#D2649A` | `#B85084` |
| — | **Outros** (sempre por último, nunca um slot) | `#8C8474` | `#8E887A` |

Sequencial (magnitude contínua — mapa de calor de gastos por dia da semana), matiz única do slot 1:

`#7FB2DC → #5D9BD0 → #2E86C4 → #1B6FA8 → #12557F` (claro)
`#DCEAF5 → #B9D5EC → #8FBBE0 → #5D9BD0 → #2E86C4` (escuro)

Divergente para **direção do dinheiro** (acima/abaixo de zero): despesa `#A32B22` ↔ ponto médio neutro (`--line` claro / `#383530` escuro) ↔ receita `#0F6B43`, sempre com o glifo de sinal e, no modo de acessibilidade, com hachura 45°/135°. Divergente para **desvio de meta** (não-monetário): mostarda `#B08C10` ↔ neutro ↔ azul-aço `#1B6FA8`.

A validação computada desta paleta está na §6.1.

### 2.9 Foco

Anel duplo, para funcionar sobre qualquer superfície: `2px solid var(--petroleo-600)` (claro) / `var(--petroleo-300)` (escuro), com `outline-offset: 2px`, e um segundo anel de `1px` em `--surface-1` por baixo. Contraste do anel contra a superfície: 6.41 : 1 no claro, 8.69 : 1 no escuro — muito acima dos 3:1 exigidos para componente não-textual.

---

## 3. Tipografia dos números

### 3.1 A escolha

| Papel | Fonte | Por quê |
|---|---|---|
| **Números, valores, títulos** | **Archivo** (variável, OFL, auto-hospedada) | Grotesca americana de aberturas fechadas e terminações horizontais, com numerais de caráter próprio: o `1` tem bandeira e base, o `4` é fechado, o `9` tem cauda reta. Tem eixo de largura — o número herói usa Archivo Semi-Expanded 700, o que dá presença sem apelar para uma fonte display. Traz `tnum`, `lnum` e `zero` (zero cortado) de verdade, não emulados. |
| **Texto corrido de interface** | **Public Sans** (variável, OFL, auto-hospedada) | Neo-grotesca deliberadamente neutra e de altura-x alta, feita para texto denso de formulário e legenda. Ela existe para **não** competir com os números. |
| Identificadores (final do cartão, IDs) | `ui-monospace` do sistema | não é conteúdo de leitura |

Nenhuma fonte é servida por CDN — todas entram no bundle em `woff2` com `font-display: swap` e métricas de fallback declaradas via `size-adjust`, para que a troca não mexa na altura das linhas do extrato.

Por que não Inter: `docs/design.md` §1 a nomeia como marca do genérico, e o argumento é correto — os numerais da Inter são impecáveis e completamente anônimos. A Archivo tem opinião, e num produto em que o número é o protagonista, o numeral é o rosto da marca.

### 3.2 Algarismos tabulares — obrigatório e onde

```css
.valor { font-variant-numeric: tabular-nums lining-nums slashed-zero; }
```

Aplicado em: **toda** coluna de valor, todo eixo de gráfico, toda tabela, todo campo de entrada de valor, todo saldo de dia, todo total.

**Não** aplicado em: o número herói e os valores de stat tile isolados. Em 56px, `tabular-nums` dá a cada dígito a largura de um `0` e um `121` fica frouxo. Números isolados usam as figuras proporcionais da Archivo. Isto é a regra da skill `dataviz` e vale aqui inteira: tabular só onde há alinhamento vertical.

### 3.3 Alinhamento

Rótulo à esquerda, valor à direita. **Sem exceção.** A coluna de valor tem largura fixa dimensionada para o maior valor plausível (`R$ 999.999,99`), não `auto` — largura elástica faz a coluna dançar entre paginações e destrói a leitura vertical.

O glifo de sinal ocupa uma **posição própria e reservada** na célula, à esquerda do `R$`, com a largura de um dígito tabular. Assim os valores positivos e negativos alinham perfeitamente pelo `R$`, e o sinal fica numa coluna de leitura vertical própria.

### 3.4 Como um valor monetário é composto

```
      −  R$  1.116,00
      │   │      │  └── decimais
      │   │      └───── milhar (ponto, pt-BR)
      │   └──────────── símbolo
      └──────────────── sinal, em posição reservada
```

| Elemento | Em coluna (extrato, fatura, relatório) | Isolado (herói, stat tile) |
|---|---|---|
| Sinal | 1em, `--ink-1`, largura de dígito tabular | 0.72em, alinhado ao topo da altura-de-caixa |
| `R$` | 0.72em, `--ink-3`, `letter-spacing: 0`, seguido de `0.18em` de espaço | 0.42em, `--ink-3`, alinhado ao topo |
| Milhar | 1em | 1em |
| Separador decimal | 1em | 1em |
| **Decimais** | **1em, mesma cor, mesmo peso** | **0.55em, `--ink-2`, alinhado ao topo da altura-de-caixa** |

A decisão sobre os decimais é a única que muda com o contexto, e é deliberada:

- **Em coluna, decimais são tamanho cheio.** Reduzi-los quebra o alinhamento tabular que a coluna inteira existe para preservar, e o extrato é onde o usuário confere centavo. Diminuir centavos numa tabela financeira é enfeite que custa exatidão percebida.
- **Isolado, decimais são 0.55em.** Num saldo de 56px, o par de centavos ocupa cerca de 30% da massa visual para 1% da informação. Reduzi-lo e subi-lo à linha de caixa devolve o protagonismo aos reais sem apagar os centavos.

Toda composição sai do formatador central de `packages/domain`. Nenhum `toFixed(2)`, nenhum `Intl` solto em componente.

### 3.5 Sinal sem depender de cor

Quatro canais, dos quais **três funcionam em escala de cinza**:

1. **Glifo, sempre presente.** Despesa leva `−` (U+2212 minus, não hífen). Receita leva `+`. **Sim, o `+` é sempre renderizado** — a ausência do sinal negativo é um sinal fraco demais para quem não distingue as duas cores. Isto nos afasta do Organizze, que só mostra o `−`.
2. **Direção da carga do trilho.** Despesa carrega da direita para a esquerda; receita, da esquerda para a direita.
3. **Peso.** Realizado 600 / previsto 400 — separa a outra dimensão (certeza), também sem cor.
4. **Cor.** Verde e vermelho, por último, como reforço — nunca sozinhos.

Para leitores de tela, o valor traz `aria-label` composto pelo formatador: `"despesa de mil cento e dezesseis reais, previsto"`. O `−` visual não é lido como "menos" solto.

---

## 4. Densidade

### 4.1 A decisão

**A linha do extrato tem 36px de altura.** Sem ícone em círculo, sem avatar, sem card.

| Elemento da linha | Altura reservada |
|---|---|
| Altura da linha | **36px** |
| Padding vertical | 8px em cima, 8px embaixo |
| Conteúdo | 20px — descrição em `--text-1` (16px, lh 1.45 ≈ 23px, recortada para 20px de caixa) |
| Metadados (conta, `3/5`, hora) | mesma linha, `--text-sm`, `--ink-3` |
| Separador | `1px solid var(--line)` — sem margem |
| Cabeçalho de grupo de dia | 24px, `--text-xs` caixa alta, `--surface-2` |

Modo confortável, opção do usuário em Preferências: 44px. **Compacto é o padrão**, e essa é a decisão. `docs/design.md` §2.3: "resista ao impulso de dar 24px de respiro a cada linha".

Categoria não vira ícone em círculo colorido. Vira um **quadrado de 8px** (raio 0) na cor do slot de dados da categoria, seguido do nome em `--text-sm`. Custa 8px de altura em vez de 32px, e mantém a cor de dado fora do território da marca.

### 4.2 Quantas linhas cabem em 900px

Viewport de 900px de altura útil. Contando o cromo real de cada produto:

| | Mavia | Organizze |
|---|---|---|
| Barra de navegação global | 48 | 56 |
| Cabeçalho da tela + navegador de período | 64 | 64 (cabeçalho do card) |
| Faixa de alerta / barra de filtros | 32 (barra de filtros achatada, sticky) | 88 (faixa de alerta 44 + barra de filtros 44) |
| Cabeçalho de colunas (sticky) | 28 | — (não existe) |
| Rodapé de resumo (fixo) | 56 | 72 |
| Padding do card | 0 (não há card) | 32 |
| **Cromo total** | **228** | **312** |
| **Área útil** | **672** | **588** |
| Cabeçalhos de dia (5 grupos) | 5 × 24 = 120 | 5 × 40 = 200 |
| Sobra para linhas | 552 | 388 |
| Altura da linha | **36** | **56** |
| **Lançamentos visíveis** | **15** | **6** |

**15 contra 6.** Dois e meio para um.

O ganho não vem de apertar a tipografia — o texto da descrição tem 16px nos dois. Ele vem de três remoções:

1. **O ícone de categoria em círculo colorido.** Sozinho, ele impõe o piso de 56px da linha do Organizze. Um quadrado de 8px carrega a mesma informação.
2. **O card.** Padding de 16px em cima e embaixo, mais a sombra que exige margem em volta, custam 32px de altura por tela e não informam nada.
3. **A faixa de alerta permanente.** "Há N lançamentos passados que ainda não foram pagos" ocupa 44px fixos. Na Mavia isso é um contador no cabeçalho de colunas (`3 em atraso`) que filtra ao ser clicado — 0px adicionais.

O argumento contra o Organizze é este: com 6 linhas por tela, comparar a segunda quinzena com a primeira exige rolar e memorizar. Com 15, meio mês cabe de uma vez. **Densidade aqui não é estética; é a diferença entre comparar e lembrar.**

Listas longas são virtualizadas e paginadas no servidor — 15 linhas por tela significa que o usuário rola muito, e rolar precisa ser barato.

---

## 5. Anatomia de quatro telas

Grade base: 12 colunas, `max-width: 1240px`, gutter `--s-44`. **Nenhuma tela usa três colunas iguais.**

### 5.1 Dashboard

**Grade: 7fr / 4fr** (≈ 64% / 36%) com um gutter de 44px. A coluna dominante carrega estado e urgência; a de apoio carrega análise e ações. A proporção é próxima da áurea de propósito — simetria é o default de quem não decidiu (`docs/design.md` §2.5).

**Hierarquia:**
1. O saldo geral, como número herói (56px), com o trilho grande logo abaixo. Um herói por tela.
2. A frase específica, em `--text-corpo`, `--ink-2`: *"Você gastou R$ 340 a mais que em agosto."* — não um slogan.
3. Contas a pagar e a receber, agrupadas por urgência, em linhas de 36px.
4. Cartões, como faturas-objeto com trilho de ciclo.
5. Composição do mês, como trilhos empilhados por categoria.

**A assinatura:** o trilho herói é o primeiro elemento da tela e define a leitura de tudo abaixo.

**Estados vazios não ocupam espaço de widget.** A crítica do teardown (§8.5, item 3) vale: os vazios permanentes do Organizze roubam a coluna direita para sempre. Na Mavia, um módulo sem dado colapsa para uma linha de 32px com um convite específico (`Nenhum cartão. Adicionar cartão →`), e só o primeiro vazio da lista se expande.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ mavia    visão geral  lançamentos  relatórios  planejamento      ⌕  ⚙  ▣  │ 48
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  SALDO GERAL · SETEMBRO                    ‹  setembro 2026  ›             │
│                                                                            │
│  R$ 8.412⁵⁰                             ┌──────────────────────────┐       │
│  ██████████████████████▌· · · · ·│      │  + despesa   + receita   │       │
│  realizado de R$ 9.180 previstos │      │  ⇄ transferência         │       │
│                                                                     │      │
│  Você gastou R$ 340 a mais que em        │  ↥ importar extrato      │       │
│  agosto, sobretudo em Alimentação.       └──────────────────────────┘       │
│                                                                            │
│  ────────────────────────────────────    ─────────────────────────────     │
│  CONTAS                        SALDO     CARTÕES                           │
│  Nubank                   R$ 4.120,10    Nubank · fatura de setembro       │
│                              ▪▪▪▪▪·      R$ 2.184,30                        │
│  Itaú                     R$ 3.902,40    ████████████████│░░░░░│           │
│                              ▪▪▪▪·       1 set      fecha 28  vence 5 out  │
│  Dinheiro                   R$ 390,00                                      │
│                              ▪·          Inter · fatura fechada            │
│  ────────────────────────────────────    R$ 812,00        vence em 3 dias  │
│                                          ███████████████████████│          │
│  A PAGAR                                                                   │
│  ⚠ 3 em atraso              R$ 612,00    ─────────────────────────────     │
│  ▪ Aluguel        05/09   − R$ 1.800,00  ONDE O DINHEIRO FOI               │
│  ▪ Internet       10/09   −   R$ 129,90  Moradia    ████████▌  R$ 2.100    │
│  ▪ Energia        12/09   −   R$ 214,30  Alimentação ██████▏   R$ 1.480    │
│  ▪ Cartão Nubank  05/10   − R$ 2.184,30  Transporte  ███▏      R$   760    │
│                                          Saúde       ██▏       R$   520    │
│  A RECEBER                               Outros      █▌        R$   410    │
│  ▪ Salário        30/09   + R$ 7.200,00                    ver relatório → │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

Note o que não está lá: nenhuma borda de card, nenhuma sombra, nenhum ícone em círculo, nenhum emoji. O agrupamento é feito por rótulo em caixa alta de 11px, uma régua de 1px e o buraco de 44px da escala de espaçamento.

### 5.2 Lançamentos

**Grade: coluna única de largura total**, com proporções internas assimétricas na tabela. Filtros numa **linha acima** de tudo que eles escopam, sticky, achatada em 32px.

Proporção interna das colunas (de 12): `estado 1 · data 1 · descrição 5 · categoria 2 · conta 1 · valor 2`. A descrição domina; o valor é a segunda maior porque nele mora o alinhamento.

**Correção sobre o Organizze:** o filtro `Tipo` do Organizze colapsa **três eixos ortogonais** em 13 opções lineares (teardown §3). Na Mavia são três controles independentes na mesma linha: **Natureza** (receita / despesa / transferência), **Estado** (previsto / pendente / efetivado) e **Origem** (fixo / parcelado / importado). O que era uma lista de 13 vira três seletores de 3–4.

**A assinatura:** trilho curto sob cada `saldo no dia`, e o trilho do mês no rodapé fixo.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ mavia    visão geral  LANÇAMENTOS  relatórios  planejamento      ⌕  ⚙  ▣  │
├────────────────────────────────────────────────────────────────────────────┤
│  Lançamentos          ‹  setembro 2026  ▾ mês  ›     + lançar   ⋯          │ 64
│  natureza ▾   estado ▾   origem ▾   conta ▾   categoria ▾   etiqueta ▾   ⌕ │ 32
├──┬─────┬───────────────────────────────┬──────────┬───────┬────────────────┤
│  │DATA │ DESCRIÇÃO                     │ CATEGORIA│ CONTA │          VALOR │ 28
├──┴─────┴───────────────────────────────┴──────────┴───────┴────────────────┤
│  SEG 15 SET                                                                │ 24
│ ✓  15/09  Mercado Extra              3/5 ▪ Alimentação  Nubank  − R$ 316,40 │ 36
│ ✓  15/09  Uber                           ▪ Transporte   Itaú    −  R$ 24,90 │ 36
│ ○  15/09  Academia                       ▪ Saúde        Nubank  − R$ 149,00 │ 36
│                                          saldo no dia          + R$ 8.412,50│ 24
│                                                          ██████████▌· · ·│ │
│  TER 16 SET                                                                │ 24
│ ✓  16/09  Salário                        ▪ Renda        Itaú   + R$ 7.200,00│ 36
│ ⇄  16/09  Para reserva                   ⇄ Transferência Itaú  −  R$ 500,00 │ 36
│ ⇄  16/09  De conta corrente              ⇄ Transferência Nubank +  R$ 500,00 │ 36
│                                          saldo no dia         + R$ 15.612,50│ 24
│                                                          ████████████████│  │
│  …                                                                         │
├────────────────────────────────────────────────────────────────────────────┤
│  saldo anterior R$ 1.212  ·  receitas + R$ 7.200  ·  despesas − R$ 490,30  │ 56
│  SALDO  R$ 15.612⁵⁰   ███████████████████▌· · · · ·│  previsto R$ 17.180   │
└────────────────────────────────────────────────────────────────────────────┘
```

`✓` efetivado · `○` previsto · `⇄` transferência — o estado é um glifo clicável na primeira coluna, que alterna pago/não pago direto na lista (herdado do Organizze, que acertou nisso).

### 5.3 Fatura de cartão

**Grade: faixa de largura total para o objeto-fatura, depois 8fr / 4fr.** Esta é a tela em que a Mavia mais se afasta do Organizze, que não tem visão de fatura como objeto (teardown §8.5, item 6).

**Hierarquia:**
1. O objeto: nome do cartão, valor da fatura em `--text-4` (36px), e **o trilho de ciclo com duas marcas** — a assinatura no seu uso mais literal.
2. O seletor de **base temporal** — data da fatura / data da compra / data da parcela — como um controle **de primeira classe no cabeçalho**, não um link discreto no canto de um relatório. O teardown (§8.5, item 5) identifica isso como "a decisão que mais muda o número na tela"; ela merece estar visível.
3. A lista de lançamentos da fatura, no mesmo formato de linha de 36px, com o badge `3/5` de parcela.
4. À direita: o pagamento (que é uma **Transferência**, com o rótulo dizendo isso), o limite como trilho, e a projeção das próximas faturas.

```
┌────────────────────────────────────────────────────────────────────────────┐
│  ‹ cartões    Nubank                            base: data da parcela ▾    │
│                                                                            │
│  FATURA DE SETEMBRO · fechada                                              │
│  R$ 2.184³⁰                                                                │
│  ███████████████████████████████████████│░░░░░░░░░░░│                       │
│  1 set                              fecha 28 set   vence 5 out             │
│  ──────────────────────────────────────────────────────────────────────────│
│                                                                            │
│  ┌──── lançamentos da fatura ─────────────────────┐ ┌── pagamento ────────┐│
│  │ 03/09  Mercado Extra      3/5  ▪ Alim.  316,40 │ │ vence em 4 dias     ││
│  │ 05/09  Netflix                 ▪ Lazer   55,90 │ │ ⇄ pagar com Itaú    ││
│  │ 09/09  Posto Shell             ▪ Trans. 210,00 │ │   pagamento é uma   ││
│  │ 12/09  Farmácia                ▪ Saúde   88,70 │ │   transferência,    ││
│  │ 15/09  Academia                ▪ Saúde  149,00 │ │   não uma despesa   ││
│  │ …                                              │ ├─────────────────────┤│
│  │ ───────────────────────────────────────────────│ │ LIMITE              ││
│  │ TOTAL                       R$ 2.184,30        │ │ ██████████▌· · · ·│ ││
│  │ parcelas futuras já lançadas   R$ 1.264,00     │ │ 2.184 de 5.000      ││
│  └────────────────────────────────────────────────┘ ├─────────────────────┤│
│                                                     │ PRÓXIMAS            ││
│  ‹ ago  R$ 1.902   [set  R$ 2.184]   out R$ 1.264 › │ out    R$ 1.264     ││
│                                                     │ nov    R$   948     ││
└────────────────────────────────────────────────────────────────────────────┘
```

### 5.4 Formulário de lançamento

A peça mais bem resolvida do Organizze (teardown §4). **Preservamos a estrutura inteira** — cinco campos primários, quatro atributos colapsados, três ações no rodapé, salvar-e-criar-outro como ação de primeira classe — e trocamos a linguagem.

Modal de **560px**, `--r-3` (8px, porque se move e se dispensa), `--elev-2`. Grade interna assimétrica: **`Valor 3fr | Data 2fr`** e **`Conta 2fr | Categoria 3fr`** — o valor e a categoria pesam mais que a data e a conta, e a grade diz isso.

O que muda em relação ao Organizze:

| Organizze | Mavia | Por quê |
|---|---|---|
| Toggle "Lançamento pago" | Segmentado de 3 estados: `previsto · pendente · efetivado` | `CONTEXT.md` tem três estados, não dois. Um toggle não representa três. |
| Ícones nus (🔁 💬 📎 🏷) | Rótulo em texto de 13px + glifo desenhado | `docs/design.md` §1 proíbe emoji na interface de produto |
| Selo "IA" na categoria | `sugerida · Alimentação` com um `↺` para descartar | Categorização automática é "sempre reversível, sempre com o motivo visível" (`CONTEXT.md`) |
| — | **Trilho sob o campo Valor**, quando parcelado | A assinatura entra no formulário mostrando o rateio ao vivo |

```
┌──────────────────────────────────────────────────────────┐
│  Nova despesa                                         ✕  │
│  ────────────────────────────────────────────────────────│
│                                                          │
│  Descrição                                               │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Mercado Extra                                     ▏│  │   ← foco inicial
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  Valor                            Data                   │
│  ┌────────────────────────┐  ┌──────────────────────┐    │
│  │ −  R$  316,40          │  │ 15/09/2026        ▾  │    │
│  └────────────────────────┘  └──────────────────────┘    │
│                                                          │
│  ( previsto )( pendente )( ▪ EFETIVADO )                 │
│                                                          │
│  Conta ou cartão              Categoria                  │
│  ┌────────────────┐  ┌────────────────────────────────┐  │
│  │ Nubank      ▾  │  │ ▪ Alimentação   sugerida  ↺ ▾  │  │
│  └────────────────┘  └────────────────────────────────┘  │
│                                                          │
│  ─────────────────────────────────────────────────────── │
│   ⟳ repetir    ✎ observação    ⊞ anexo    ◇ etiquetas    │
│  ─────────────────────────────────────────────────────── │
│                                                          │
│   🗑 excluir                    salvar    salvar e novo → │
└──────────────────────────────────────────────────────────┘
```

Com `⟳ repetir` aberto em **parcelado**, o trilho aparece:

```
│  ⟳ repetir                                          ✕    │
│  ( fixo )  ( ▪ PARCELADO )                               │
│                                                          │
│  Parcelas          Período                               │
│  ┌────────┐   ┌────────────────┐                         │
│  │   5    │   │ meses       ▾  │                         │
│  └────────┘   └────────────────┘                         │
│                                                          │
│  ██▌ ██▏ ██▏ ██▏ ██▏                                     │
│  5 parcelas de R$ 63,28 — a primeira leva R$ 63,32.      │
│  O valor digitado é o total.                             │
```

Cinco blocos, cada um a largura da sua parcela; o primeiro é 4 centavos mais largo e o texto diz exatamente isso. É o ADR 0005 (resto na primeira parcela) desenhado, não descrito. `salvar e novo →` mantém o modal aberto, limpa descrição e valor, e **preserva** data, conta e categoria — quem lança em lote lança do mesmo lugar.

---

## 6. Regras de gráfico

> A skill `dataviz` foi invocada e lida antes desta seção, incluindo `references/choosing-a-form.md`, `references/palette.md`, `references/marks-and-anatomy.md` e `references/anti-patterns.md`. A paleta de dados da §2.8 foi **computada**, não escolhida no olho: `scripts/validate_palette.js` foi rodado contra as nossas superfícies.

### 6.1 Validação executada

```
$ node validate_palette.js "#1B6FA8,#8C4A28,#17A177,#9E2E62,#B08C10,#D2649A" \
    --mode light --surface "#FBF9F4"

  [PASS] Lightness band       all 6 inside L 0.43–0.77
  [PASS] Chroma floor         all 6 >= 0.1
  [PASS] CVD separation       worst adjacent #9E2E62↔#17A177 ΔE 13.8 (deutan) · tritan 8.5
  [PASS] Normal-vision floor  worst adjacent #D2649A↔#B08C10 ΔE 21.3 (normal)
  [PASS] Contrast vs surface  all 6 >= 3:1
  → ALL CHECKS PASS

$ node validate_palette.js "#3E92CE,#A85830,#1DAE80,#B33470,#B08C10,#B85084" \
    --mode dark --surface "#161512"

  [PASS] Lightness band       all 6 inside L 0.48–0.67
  [PASS] Chroma floor         all 6 >= 0.1
  [PASS] CVD separation       worst adjacent #1DAE80↔#A85830 ΔE 12.7 (deutan) · tritan 11.1
  [PASS] Normal-vision floor  worst adjacent #B85084↔#B08C10 ΔE 22.3 (normal)
  [PASS] Contrast vs surface  all 6 >= 3:1
  → ALL CHECKS PASS

$ node validate_palette.js "#7FB2DC,#5D9BD0,#2E86C4,#1B6FA8,#12557F" \
    --ordinal --mode light --surface "#FBF9F4"
  → ALL CHECKS PASS   (extremo claro 2.15:1, acima do piso de 2:1)
```

Pior par adjacente sob deuteranopia: **ΔE 13.8** no claro e **12.7** no escuro, contra alvo de 8. Nenhum slot precisa de alívio de contraste. **Seis slots, não oito** — foi uma escolha: um relatório de finanças pessoais que precisa de oito cores está pedindo uma tabela, e a sétima categoria dobra em *Outros* (`#8C8474` / `#8E887A`), sempre por último, nunca num slot.

O ciano foi excluído do pool de dados de propósito: sua matiz encosta na do Petróleo da marca, e a cor da marca não pode parecer que significa alguma coisa num gráfico.

### 6.2 Que gráfico usamos, e para quê

| Pergunta do usuário | Forma | Por quê |
|---|---|---|
| "Quanto tenho agora?" | **Número herói** + trilho | Um número não é um gráfico de uma barra |
| "Entrou e saiu quanto, mês a mês?" | **Colunas agrupadas**, eixo em zero, com a **marca do previsto** como um traço de 1px no topo de cada coluna | O previsto entra como marca, não como segunda barra ou segundo eixo — a assinatura entra no gráfico |
| "Como o saldo evoluiu?" | **Linha de 2px**, área a 10%, período anterior sempre visível em `--ink-4` | Comparação de períodos é exigência da definição do agente |
| "Para onde o dinheiro foi?" | **Barras horizontais ordenadas** (que são trilhos) — **nunca rosca** | Rosca não permite comparar valores próximos; o Organizze usa rosca no dashboard e no relatório, e essa é uma das coisas que copiamos ao contrário |
| "Estourei o limite?" | **Medidor** — o trilho em tamanho grande, com a marca no teto e hachura no excedente | O medidor e o trilho são o mesmo objeto. Uma ideia, em todo lugar. |
| "Em que dia da semana gasto mais?" | **Mapa de calor** 7 × 5, rampa sequencial azul | Magnitude contínua sobre grade |
| "Qual categoria explodiu?" | **Ênfase**: a categoria em questão no slot 1, todas as outras em `--ink-4` | Oito matizes quando a história é uma série é o erro mais comum |

**Proibições explícitas.** Nada de eixo duplo, jamais — duas medidas de escalas diferentes viram dois gráficos ou índice base 100. Nada de rosca para comparar. Nada de rampa de valor em categorias nominais. Nada de matiz gerada a partir da sétima série. Nada de hachura ligada por padrão — ela é canal de acessibilidade, 45°/135°, acionada por preferência, impressão ou `forced-colors`.

### 6.3 Regras de eixo, para dados financeiros

- **Eixo de valor começa em zero em barras e colunas.** Sem exceção, sem "zoom para mostrar a variação".
- **Ticks nunca têm centavos.** `R$ 2 mil`, `R$ 12 mil`, `R$ 1,2 mi` — abreviados pelo formatador central de `packages/domain`, nunca no componente.
- **Máximo de 5 ticks no eixo de valor**, arredondados para números limpos.
- **Grade em hairline sólido de 1px** em `--line`, só horizontal, nunca tracejada. Tracejado no produto significa **uma coisa só**: projeção. Uma grade tracejada roubaria esse significado.
- **A linha do previsto é tracejada, e essa é a exceção deliberada** à regra da skill contra tracejado: aqui o tracejado carrega sentido (o futuro não aconteceu), reforçado por hachura na área e por um rótulo `previsto`. É a única linha tracejada do produto.
- **Eixo de tempo em minúsculas e abreviado** em pt-BR: `set`, `out`, `nov`. O ano aparece só em janeiro ou no primeiro tick da série.
- **"Hoje" é uma régua vertical de 1px** em `--ink-2`, rotulada, em toda série temporal. Tudo à direita dela é previsto.
- **Zero é uma linha de base mais forte** (`--line-forte`) que as demais linhas de grade, quando a série cruza o zero.

### 6.4 Legenda, rótulos e o gêmeo tabular

- **Legenda sempre presente a partir de duas séries.** Uma série não tem legenda — o título já diz o que é.
- **Até quatro séries, rótulo direto** no fim da linha ou no topo da coluna, com linha-guia quando convergirem. Nunca um número em cada ponto.
- **Texto nunca veste a cor do dado.** Rótulos, valores e legendas usam `--ink-1/2/3`; a identidade vem do quadrado colorido ao lado. A exceção única é o rótulo dentro de um preenchimento, que escolhe tinta ou papel pela luminância do fundo.
- **Todo gráfico tem um gêmeo tabular**, acessível por um controle `ver como tabela` — que é também o caminho de exportação. Tooltip nunca é o único jeito de ler um valor.
- **Filtros numa linha só, acima de tudo que escopam.** Nunca dentro do quadro de um gráfico, nunca um por gráfico.
- Em refetch, o gráfico anterior **permanece em opacidade reduzida**. Nada de esqueleto piscando, nada de `animate-pulse`.

---

## 7. Acessibilidade

Alvo: **WCAG 2.2 AA**, verificado, não presumido.

### 7.1 Contrastes medidos

Superfície clara `#FBF9F4`; superfície escura `#161512`. Todos os valores abaixo foram calculados, não estimados.

| Par | Claro | Escuro | Exigência |
|---|---|---|---|
| Corpo `--ink-1` | **16.51 : 1** | **15.89 : 1** | 4.5 |
| Número em destaque `--ink-0` | **18.46 : 1** | **17.94 : 1** | 4.5 |
| Secundário `--ink-2` | **7.49 : 1** | **8.64 : 1** | 4.5 |
| Muted `--ink-3` (metadados, 13px) | **4.82 : 1** | **5.18 : 1** | 4.5 |
| Primária Petróleo | **8.69 : 1** | **8.69 : 1** | 4.5 |
| Texto sobre botão primário | **8.69 : 1** | **8.69 : 1** | 4.5 |
| Receita | **6.23 : 1** | **7.51 : 1** | 4.5 |
| Despesa | **6.82 : 1** | **7.21 : 1** | 4.5 |
| Receita sobre fundo de receita | **5.72 : 1** | **6.67 : 1** | 4.5 |
| Despesa sobre fundo de despesa | **6.11 : 1** | **6.74 : 1** | 4.5 |
| Atenção | **5.63 : 1** | **8.42 : 1** | 4.5 |
| Anel de foco | **6.41 : 1** | **8.69 : 1** | 3.0 |
| Slot de dados 1 (o mais escuro) | **5.14 : 1** | **5.40 : 1** | 3.0 |

Os seis slots de dados passam de 3:1 nos dois modos (verificado pelo validador). `--ink-4` (2.50 : 1) é **exclusivo de estado desabilitado**, isento por WCAG 1.4.3, e nunca carrega informação.

### 7.2 Teclado

- **Ordem de tabulação segue a ordem visual.** Nenhum `tabindex` positivo em lugar nenhum.
- **Anel de foco de 2px com offset de 2px**, sempre visível, jamais removido. Anel duplo (petróleo + papel) para funcionar sobre linha zebrada e sobre superfície elevada.
- **O extrato é uma grade navegável**: `↑ ↓` entre linhas, `→` abre a linha, `Espaço` alterna efetivado/previsto, `E` edita, `Delete` arquiva (com desfazer de 8 segundos numa região `role="status"`). O modo de seleção em massa usa `Shift + ↑↓`.
- **Atalhos globais**: `N` nova despesa, `Shift+N` nova receita, `T` transferência, `/` busca, `[` e `]` navegam o período. Todos listados num diálogo em `?`.
- **Modal com foco preso**, foco inicial na Descrição, `Esc` fecha com confirmação se houver mudança suja, e o foco retorna ao elemento que abriu.
- **Gráfico é focável**: `Tab` entra, `← →` percorrem os pontos, e o foco mostra **exatamente** o que o hover mostra. `Esc` sai.
- **Salto para o conteúdo** como primeiro elemento focável de toda página.
- **Alvo mínimo de 24 × 24px** em todo controle, inclusive o glifo de estado na primeira coluna do extrato — a linha tem 36px, o alvo cobre a altura inteira.

### 7.3 Receita e despesa sem cor

Quatro canais independentes, três deles sobrevivendo à escala de cinza (§3.5): **glifo de sinal sempre renderizado** (`−` e `+`), **direção da carga do trilho**, **peso tipográfico** para realizado/previsto, e cor por último. Some a cor do produto inteiro e o extrato continua legível.

Complementos:

- **Nenhum estado é comunicado só por cor.** Atrasado leva `⚠` e a palavra `em atraso`; efetivado leva `✓`; transferência leva `⇄`.
- **Categoria não é só cor.** O quadrado de 8px vem sempre acompanhado do nome.
- **`aria-live="polite"`** nos totais que mudam sozinhos — saldo do rodapé, total da fatura, medidor de limite. Nunca `assertive`: o usuário está digitando.
- **`aria-label` monetário completo** vindo do formatador: `"despesa de trezentos e dezesseis reais e quarenta centavos, efetivada, categoria Alimentação"`.
- **`prefers-reduced-motion`** desliga a única animação do produto (a carga do trilho), que passa a saltar para a largura final.
- **`forced-colors`** liga a hachura nos gráficos e nos trilhos, e substitui as cores de dado pelas cores do sistema.
- **Modo de alto contraste próprio**, opcional, que sobe `--ink-3` para `--ink-2` e engrossa `--line` para `--line-forte`.

---

## 8. As três direções a prototipar

`docs/design.md` §4 exige três direções radicalmente diferentes na mesma rota, trocáveis por parâmetro de URL, antes de fixar qualquer token. A recomendação acima é a **A**. As outras duas não são variações de cor — mudam a forma como o produto pensa.

**Rota de protótipo:** `/prototype/extrato?dir=a|b|c` e `/prototype/dashboard?dir=a|b|c`, no ramo de UI.

### A — "Papel e trilho" (recomendada)

Tudo o que está nas seções 1 a 7. Papel quente, Petróleo, densidade de 36px, o trilho como assinatura, tabela sem card, tipografia Archivo/Public Sans. Aposta: a organização do Organizze com o peso de um jornal financeiro, e uma ideia própria — o realizado × previsto virando forma sob cada número.

### B — "Livro-razão"

Um razão contábil de página inteira, e nada mais. Não existe dashboard como destino: o topo do razão **é** o dashboard, com o saldo de abertura, e as colunas de débito, crédito e saldo corrente descem pela página numa única linha contínua do ano inteiro, com o saldo corrente na margem externa como num livro impresso. A tipografia é a interface toda: uma serifada de texto para descrição e categoria (voz de imprensa econômica, não de SaaS), e figuras monoespaçadas para os números. Zero superfícies, zero ícones, zero cor além da tinta e de um único vermelho de contabilidade para saldo negativo; categoria é versalete, não quadrado colorido. A navegação é uma régua vertical de períodos à esquerda, e gráficos não existem na superfície principal — moram numa seção separada, chamada de "pranchas", impressa e exportável. A aposta é radical: um produto financeiro em que **nada é clicável por engano**, denso a 28px por linha, que assume que quem controla dinheiro quer ler, não navegar. O risco é igualmente radical — pode parecer software de contador em vez de app pessoal, e o mobile fica difícil.

### C — "Cronologia"

A superfície principal é um **eixo de tempo horizontal contínuo**, não uma lista vertical. O passado à esquerda, o futuro à direita, e "hoje" como uma régua vertical fixa no centro da tela; o usuário arrasta o tempo, não rola uma lista. O saldo é a área sob a curva, sólida à esquerda de hoje e hachurada à direita — projeção é a **visão padrão**, não um relatório. Cada conta e cada cartão é uma faixa horizontal própria, empilhada, e a fatura aparece naturalmente como um segmento do eixo com colchetes de fechamento e vencimento — o ciclo deixa de precisar de uma tela. Lançamentos são marcas sobre as faixas, agrupadas por densidade quando o zoom afasta; a lista vertical vira uma gaveta que se abre sobre o eixo quando o usuário seleciona um intervalo. O zoom vai de dia a ano num só controle, substituindo o alternador de granularidade do Organizze. A aposta é que a pergunta real de finanças pessoais é temporal ("tenho dinheiro até dia 28?") e merece uma superfície temporal. O risco é que é a mais cara de construir, a mais difícil de tornar acessível por teclado, e pode ser fascinante na demonstração e cansativa no uso diário.

---

## 9. Auditoria da seção 5 do `docs/design.md`

| Item | Situação |
|---|---|
| Zero roxo, índigo ou violeta como primária | Petróleo `#0B4F5F` / `#5FC0D6`. Nenhuma matiz entre 250° e 320° existe em token algum |
| Zero gradiente decorativo, zero texto com gradiente | Nenhum gradiente em nenhum token |
| Zero glassmorphism | Nenhum `backdrop-blur`; elevação é sombra no claro e superfície + borda no escuro |
| Zero emoji na interface | Glifos desenhados; o formulário do Organizze foi reimplementado justamente para tirá-los |
| Nem toda informação está dentro de card | `--elev-0` cobre ~95% da UI; card só para modal, popover e toast |
| Contraste de escala ≥ 3:1 | **3.73 : 1** (56 / 15) |
| Coluna de valor tabular e à direita | `tabular-nums` obrigatório em coluna; alinhamento à direita sem exceção; largura fixa |
| Modo escuro projetado | Croma reduzido, hierarquia de elevação trocada, verde/vermelho reajustados, `--ink-3` recalibrado |
| Nenhuma animação decorativa | Uma única animação no produto (a carga do trilho); `prefers-reduced-motion` respeitado |
| WCAG AA verificado, nada só por cor | §7.1 com valores medidos; §7.3 com quatro canais |
| Texto cita algo específico | "Você gastou R$ 340 a mais que em agosto" |
| A assinatura aparece na tela | O trilho está nas quatro anatomias e nos gráficos |
| Alguém saberia dizer que é a Mavia | Papel quente + petróleo + trilho + 36px. Nenhum concorrente da categoria tem os quatro |

## 10. Próximos passos

1. `/prototype` no ramo de UI com as três direções em `?dir=a|b|c` nas rotas de dashboard e extrato, com dados reais de seed.
2. **Escolha humana.** A identidade do produto não é decisão do agente (ADR 0006).
3. Fixar os tokens da direção escolhida em `packages/ui` — cor, tipografia, espaçamento, raio, elevação, e o componente `<Trilho>` como primitivo.
4. Publicar o formatador monetário de `packages/domain` com as duas composições da §3.4 (em coluna e isolada) antes de qualquer tela consumir valor.
5. Rodar `validate_palette.js` no CI sempre que um token de cor de dado mudar.
