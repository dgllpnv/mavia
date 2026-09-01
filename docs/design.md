# Direção de design — fugir do "padrão IA"

Documento obrigatório para `engenheiro-frontend-web` e `engenheiro-mobile`. Leia antes de desenhar qualquer tela.

O problema: modelos de linguagem convergem para uma estética média, reconhecível e genérica. Ela é competente e absolutamente esquecível. Um produto financeiro que parece um template de landing page não transmite a única coisa que precisa transmitir — **confiança**.

---

## 1. O que é o "padrão IA" — reconheça para evitar

Se a tela tem três ou mais destes, ela é genérica. Refaça.

### Cor
- Roxo, índigo ou violeta como cor primária. É a cor default do Tailwind e virou a assinatura visual do software gerado por IA.
- Gradiente roxo → rosa, ou azul → ciano, em botão, título ou fundo.
- Texto com gradiente aplicado (`bg-clip-text`).
- "Blobs" desfocados coloridos ao fundo, mesh gradient.
- Modo escuro como `slate-900` puro com destaque roxo.

### Forma
- **Tudo é um card.** Cada informação dentro de uma caixa com borda, `rounded-2xl` e `shadow-lg`.
- Grade de três colunas de cards iguais, cada um com ícone em círculo, título e duas linhas de texto.
- *Bento grid* sem motivo funcional.
- Glassmorphism: superfície translúcida com `backdrop-blur` sobre fundo colorido.
- Raio de borda idêntico em absolutamente tudo.

### Tipografia
- Inter (ou a fonte padrão do sistema) em todos os pesos, sem voz própria.
- Tudo em tamanho médio: sem contraste de escala, sem hierarquia real.
- Título centralizado grande, subtítulo cinza, dois botões lado a lado — "Começar" e "Saiba mais".
- Pílula de badge acima do título.

### Ornamento
- Emoji como ícone (🚀 ✨ 💰) na interface de produto.
- Ícone de brilho ✨ associado a qualquer coisa "inteligente".
- `animate-pulse` e fade-in-up em toda entrada de elemento.
- Espaçamento uniforme e generoso em tudo, produzindo uma página que respira demais e não diz nada.

### Escrita
- "Simplifique suas finanças", "Tudo em um só lugar", "Sem complicação". Frases que qualquer produto poderia dizer.

---

## 2. O que fazer no lugar

### 2.1 Tipografia conduz, não a caixa

Este produto exibe **números**. O número é o protagonista, não a caixa em volta dele.

- **Algarismos tabulares obrigatórios** (`font-variant-numeric: tabular-nums`) em toda coluna de valor. Sem isso os dígitos dançam entre as linhas e a lista parece amadora. É o detalhe que separa um produto financeiro sério de um genérico.
- Escolha uma tipografia com **numerais de caráter próprio**. Considere pares como uma grotesca de personalidade para números e títulos com uma neo-grotesca neutra para texto corrido.
- **Contraste de escala agressivo.** O saldo do mês pode ser 4× o tamanho do rótulo. Hierarquia se faz com salto, não com cinza mais claro.
- Alinhe valores à direita, sempre. Rótulos à esquerda. A leitura vertical de uma coluna de dinheiro depende disso.

### 2.2 Remova a caixa

Antes de desenhar um card, pergunte: **o alinhamento já resolve?** Na maior parte das vezes, sim.

Régua tipográfica, espaçamento intencional e uma linha divisória fina fazem o trabalho que um `shadow-lg` finge fazer. Card é para conteúdo que precisa ser movido, dispensado ou agrupado de verdade — não para tudo.

Quando usar superfície, use **uma** hierarquia de elevação com propósito claro, não sombra decorativa em cada elemento.

### 2.3 Densidade é uma feature

Quem controla dinheiro quer **ver muito de uma vez**. O extrato é uma tabela, e uma boa tabela é densa. Resista ao impulso de dar 24px de respiro a cada linha: isso transforma 40 lançamentos em cinco telas de rolagem e destrói a capacidade de comparar.

Referência mental correta: uma página de jornal financeiro ou um terminal, não uma landing page de SaaS.

### 2.4 Cor com opinião, e pouca

- **Nada de roxo.** Escolha uma primária com ponto de vista e comprometa-se com ela.
- A cor de marca **nunca** é usada para dado. Ela é para navegação, ação e identidade. O gráfico usa a paleta de dados; misturar as duas faz o usuário achar que a cor da marca significa alguma coisa.
- Verde e vermelho para direção do dinheiro, **com moderação e nunca sozinhos**. Sinal, ícone ou rótulo sempre acompanham — parte relevante dos usuários não distingue essas duas cores.
- Superfícies em neutros com **temperatura definida** (levemente quentes ou levemente frios, escolha e mantenha). Cinza puro `#808080` é a cor de quem não decidiu.
- Modo escuro **projetado**, não invertido: hierarquia refeita, contraste recalibrado, verde e vermelho reajustados porque eles saturam demais no escuro.

### 2.5 Assimetria e grade com intenção

Simetria perfeita é o estado default de quem não tomou decisão. Uma grade com proporção deliberada — uma coluna dominante e uma de apoio, não três iguais — cria hierarquia sem precisar de caixa.

### 2.6 Movimento a serviço da compreensão

Animação só quando ela **explica** algo:

- O número transiciona quando o dado muda, para o olho ver que mudou.
- A linha some para o lado quando o usuário a arquiva, indicando para onde foi.
- A barra cresce ao carregar um limite, comunicando proporção.

Nada de fade-in-up em elemento estático. Nada de pulsar. Respeite `prefers-reduced-motion`.

### 2.7 Escrita específica

Troque o genérico pelo concreto. Em vez de "Simplifique suas finanças", diga o número: "Você gastou R$ 340 a mais que em agosto." O texto da interface é parte do design — genérico na copy anula qualquer esforço visual.

Vazios são a primeira tela do usuário novo. Um vazio bom instrui e convida; um vazio genérico ("Nenhum item encontrado") desperdiça o momento mais importante do produto.

---

## 3. O elemento-assinatura

Todo produto memorável tem **uma** ideia visual que ninguém mais tem. Escolha a sua e leve-a a todas as telas:

Pode ser o tratamento dos algarismos. Pode ser como a fatura do cartão é representada como um objeto físico com ciclo. Pode ser uma linha do tempo horizontal contínua no lugar da lista vertical. Pode ser a forma como o previsto e o realizado convivem no mesmo eixo.

Uma ideia, executada com rigor, em todo lugar. Não cinco ideias em cinco telas.

---

## 4. Processo obrigatório antes de construir UI

1. **Três direções radicalmente diferentes.** Use `/prototype` no ramo de UI: três variações numa mesma rota, trocáveis por parâmetro de URL. Radicalmente diferentes — não a mesma tela com três cores.
2. **Escolha com o humano.** Você não decide sozinho a identidade do produto.
3. **Fixe os tokens** da direção escolhida em `packages/ui` — cor, escala tipográfica, espaçamento, raio, elevação. A partir daí, componente novo compõe tokens; não inventa valor.
4. **Invoque a skill `dataviz`** antes da primeira linha de gráfico.
5. **Confira as duas listas** — a da seção 1 e a da seção 2 — antes de dizer que a tela está pronta.

---

## 5. Auditoria — rode antes de cada entrega de UI

- [ ] Zero roxo, índigo ou violeta como primária.
- [ ] Zero gradiente decorativo. Zero texto com gradiente.
- [ ] Zero glassmorphism.
- [ ] Zero emoji na interface de produto.
- [ ] Nem toda informação está dentro de um card.
- [ ] Existe contraste de escala tipográfica evidente (relação de pelo menos 3:1 entre o maior e o corpo de texto).
- [ ] Toda coluna de valor usa algarismos tabulares e alinhamento à direita.
- [ ] O modo escuro foi projetado, não invertido.
- [ ] Nenhuma animação puramente decorativa; `prefers-reduced-motion` respeitado.
- [ ] Contraste WCAG AA verificado, e nenhum significado depende só de cor.
- [ ] O texto da tela cita algo específico do usuário, não um slogan genérico.
- [ ] O elemento-assinatura do produto aparece nesta tela.
- [ ] Alguém olharia esta tela e saberia dizer que é a Mavia, e não um template.
