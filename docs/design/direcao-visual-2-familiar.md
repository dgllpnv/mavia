# Direção visual da Mavia — "Familiar"

> **Status: APROVADA em 2026-09-02.** **Substitui** `docs/design/direcao-visual.md`
> ("Papel e trilho") como direção normativa. Decisão do dono do produto: DP-31.
>
> O documento anterior **não é apagado**. Ele fica como registro do que foi
> tentado e por quê, e várias das suas seções continuam valendo — a paleta, a
> escala tipográfica, a composição do valor monetário e as regras de sinal são
> as mesmas. O que muda é a disposição.

---

## 1. A decisão, e o que ela corrige

A direção anterior perseguia **diferenciação**: sem card, linha de 36px,
densidade máxima, um elemento-assinatura próprio. O argumento era que copiar a
pele do concorrente produziria um produto sem identidade.

O dono do produto olhou o resultado e disse duas coisas:

> "Achei feio e sem facilidade pro usuário."
> "Olhe o Organizze, faça muito parecido […] meus clientes estão acostumados."

**As duas frases importam, e a segunda mais que a primeira.** "Feio" é gosto, e
gosto se discute. "Sem facilidade" e "meus clientes estão acostumados" não são
gosto: são um custo de migração que quem vende o produto conhece melhor do que
quem o desenha. Um cliente que já sabe onde ficam as coisas no Organizze e não
encontra nada na Mavia não vai elogiar a nossa densidade.

O erro da direção anterior não foi de execução. Foi de premissa: ela tratou a
familiaridade como um custo a pagar pela identidade, quando ela é o ativo que
o produto está comprando ao entrar nesta categoria.

**O que copiamos:** a disposição, os formatos, a hierarquia das telas.
**O que não copiamos:** a paleta. As cores continuam nossas.

---

## 2. O que muda, item a item

| | Papel e trilho | Familiar |
|---|---|---|
| Fundo da página | papel quente, quase branco | cinza `#EAE6DA` |
| Blocos | **sem card**; agrupamento por rótulo e régua | **card branco**, raio 8, sombra leve |
| Altura da linha | 36px | **56px** |
| Categoria na linha | quadrado de 8px | **círculo de 32px com a inicial** |
| Navegação | barra de 48px sobre papel | **barra sólida de 56px na cor da marca** |
| Painel | 7fr/4fr, blocos separados por espaço | **duas colunas de cards independentes** |
| Estado do lançamento | segmentado de três estados | **interruptor "Lançamento pago"** |
| Resumo do extrato | rodapé fixo com trilho | **rodapé colapsado, expansível** |
| Filtros | três seletores sempre visíveis | três seletores **atrás de "filtrar por…"** |
| Elemento-assinatura | o trilho, em toda tela | **não há**; ver §4 |

---

## 3. O que **não** muda

Continua valendo, na íntegra, do documento anterior:

- **§2.5 a §2.9** — a paleta inteira: neutros quentes, petróleo como primária,
  verde e vermelho de direção do dinheiro, paleta de dados separada da paleta de
  marca, anel de foco duplo.
- **§3** — a tipografia dos números: Archivo e Public Sans, algarismos
  tabulares em coluna, a composição de sinal · símbolo · reais · centavos, e os
  quatro canais de sinal dos quais três funcionam em escala de cinza.
- **A regra de que cor nunca carrega significado sozinha.**
- **O modo escuro projetado**, e não invertido (DP-30).

E continua valendo a lista obrigatória do `docs/design.md` §5, com **duas
emendas**, porque a decisão do dono do produto a contradiz em dois pontos:

| Item | Emenda |
|---|---|
| "Nem toda informação está dentro de um card" | **Suspenso.** O card é a unidade de agrupamento do painel e das listas. O que se mantém é o que ele proíbe de verdade: card **dentro** de card, e card em volta de um único número |
| "Zero emoji na interface" | **Mantido.** Os glifos `✓ ○ ⇄ ‹ ›` são tipográficos, e o ícone de categoria é uma **letra**, não um desenho |

---

## 4. O trilho sai — e o que fica no lugar

O trilho era o elemento-assinatura: uma régua de 2px sob todo número em curso,
respondendo "quanto disto já é fato". Ele sai porque a disposição familiar não
tem onde acomodá-lo sem parecer enfeite, e porque a segunda passagem da
auditoria já havia mostrado que o par que ele media no painel estava errado
(I-2: ele acusava estouro num mês sem estouro).

O que responde à mesma pergunta, agora:

- no painel, a frase específica — *"ainda há R$ 149,00 previstos para sair"*;
- no extrato, o **saldo no dia** no cabeçalho de cada grupo;
- no rodapé, o modelo **realizado × previsto** completo, expansível.

A geometria testada (`packages/ui/src/trilho.ts`, 12 testes, uma propriedade
que achou um defeito real) **fica no repositório**. Ela é código puro e correto,
e a tela de fatura pode voltar a usá-la para o ciclo — que é o uso em que ela
nunca esteve errada.

---

## 5. O que herdamos do Organizze, tela a tela

Referência: `docs/pesquisa/organizze-teardown.md`.

**Navegação** (§1). Barra sólida, plana, cinco destinos, conta à direita. Sem
menu lateral: em finanças pessoais a pessoa vai a um de poucos lugares.

**Painel** (§2). Duas colunas de cards. Esquerda: saldo geral com botão de
ocultar, minhas contas com rodapé "gerenciar contas", contas a pagar. Direita:
cartões, onde o dinheiro foi. Ações primárias no cabeçalho — lançar é o que a
pessoa vem fazer, e o lugar de lançar é a primeira tela.

**Extrato** (§3). Card com cabeçalho, filtros recolhidos, lista agrupada por
dia, saldo no dia, rodapé colapsado com o realizado × previsto.

**Formulário** (§4). A ordem dos campos é a deles, na íntegra: descrição,
valor + data, interruptor "pago", conta/cartão + categoria, atributos
colapsados, três ações. É a peça mais bem resolvida do produto deles.

**Categorias** (§7). Dois níveis, arquivar em vez de excluir.

---

## 6. Onde nos afastamos, e por quê

Cinco desvios, todos correções de fraquezas que o próprio teardown registrou
(§8.5) — não são gosto:

1. **Estados vazios compactos.** Os deles ocupam o espaço de um widget cheio
   para sempre. Bom no primeiro dia, ruim em todos os outros.
2. **Três eixos de filtro independentes**, e não treze opções lineares. O
   `Tipo` deles colapsa natureza, estado e origem numa lista só.
3. **Fatura como objeto com ciclo.** O cartão deles é uma lista de compras; um
   cartão não tem saldo, tem uma janela que abre, fecha e vence.
4. **Conta tem tipo.** Sem isso não dá para tratar investimento e dinheiro em
   espécie de forma distinta.
5. **Rótulo em texto no lugar de ícone nu.** Os atributos do formulário deles
   são `🔁 💬 📎 🏷` sem legenda; aqui são palavras. Emoji na interface de
   produto continua proibido.

E um desvio que é nosso: o **interruptor representa dois estados** enquanto o
modelo tem três. Não é simplificação — `pendente` é derivado, não escolhido: é
o que a data já passou e o dinheiro não se moveu, e quem decide isso é o
servidor. O que o usuário informa é só se o dinheiro **saiu**.

---

## 7. O que esta direção ainda não entregou

- **Faixa de alerta de atraso** no topo do extrato, como a deles.
- **Seleção em massa** de lançamentos.
- **Alternador de granularidade** — hoje / semana / mês / período — no
  navegador de período. Hoje só há mês.
- **Rosca no painel.** A participação por categoria é uma barra; uma rosca
  responde à mesma pergunta pior, e a decisão de não usá-la é deliberada.
