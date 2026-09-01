# ADR 0006 — Identidade visual autoral, recusa explícita à estética genérica de IA

- **Status:** Aceita · **emendada em 2026-09-01** (ver Emenda 1)
- **Data:** 2026-09-01

## Contexto

Boa parte da interface deste produto será escrita com assistência de modelos de linguagem. Modelos convergem para uma estética média e reconhecível: primária roxa ou índigo, gradiente para rosa, glassmorphism, cada informação dentro de um card com raio grande e sombra, grade de três colunas iguais, emoji como ícone, Inter em todos os pesos sem contraste de escala, animação decorativa em toda entrada.

Essa estética é competente e esquecível. Num produto financeiro, parecer template compromete a única coisa que o produto precisa transmitir: confiança de que os números estão certos. Além disso, é a mesma cara de milhares de projetos — não constrói marca.

Sem uma decisão registrada, cada sessão de agente reconverge para o default, e a identidade nunca se forma.

## Decisão

A identidade visual é autoral e a recusa ao default é explícita e verificável.

`docs/design.md` é normativo, não sugestivo. Ele define o que é proibido (seção 1), o que fazer no lugar (seção 2), o elemento-assinatura (seção 3), o processo (seção 4) e a auditoria obrigatória antes de cada entrega de UI (seção 5).

Os princípios que sustentam a decisão:

- **Tipografia conduz, não a caixa.** O número é o protagonista; algarismos tabulares obrigatórios em toda coluna de valor; contraste de escala agressivo faz a hierarquia.
- **Densidade é feature.** A referência é a página de jornal financeiro, não a landing page de SaaS.
- **Cor com opinião e pouca.** Sem roxo. Cor de marca nunca é usada para dado.
- **Assimetria com intenção**, contra a simetria default de quem não decidiu.
- **Movimento só quando explica** alguma mudança.
- **Um elemento-assinatura** levado com rigor a todas as telas.

**Processo:** toda superfície de UI nova nasce de três direções radicalmente diferentes, produzidas com `/prototype` no ramo de UI e escolhidas pelo humano. Os tokens da direção escolhida são fixados em `packages/ui`; componente novo compõe tokens, não inventa valores.

## Consequências

**Positivas.** O produto fica reconhecível. Algarismos tabulares e densidade adequada tornam o extrato genuinamente mais legível — a decisão estética coincide com a funcional. A auditoria da seção 5 dá um critério objetivo de reprovação, em vez de discussão de gosto.

**Negativas.** Custa mais tempo por tela: três direções antes de escolher uma, mais uma auditoria por entrega. Exige que o humano participe da escolha de identidade, o que é um gargalo real. Fugir do default significa abandonar componentes prontos que já vêm com a estética default, e portanto construir mais em `packages/ui`.

## Alternativas rejeitadas

**Adotar uma biblioteca de componentes pronta e aceitar a estética.** Muito mais rápido. Rejeitado: entrega exatamente a aparência genérica que esta decisão existe para evitar.

**Deixar o design a critério de cada sessão.** Rejeitado: sem norma escrita, cada sessão reconverge ao default do modelo e a identidade nunca se acumula.

---

## Emenda 1 — Direção escolhida e compromisso com o claro (2026-09-01)

O processo das três direções exigido pela seção 4 do `docs/design.md` foi executado. As direções
foram desenhadas em `docs/design/direcao-visual.md` e apresentadas ao dono do produto numa página
de comparação. Emenda registrada **antes de qualquer implementação** — não é re-litígio de decisão
consumida.

**Direção escolhida: A — "Papel e trilho".** Elemento-assinatura é o **trilho**, a régua de 2px sob
todo número em curso que torna o par realizado × previsto uma forma em vez de seis linhas de texto.
Neutros de papel quente (matiz ~45°), primária Petróleo `#0B4F5F`, linha de extrato de 36px,
tabela sem card, Archivo para números e Public Sans para texto.

Descartadas: **B — "Livro-razão"** (razão contábil de página inteira, sem dashboard como destino;
risco de parecer software de contador e de inviabilizar o mobile) e **C — "Cronologia"** (eixo de
tempo horizontal no lugar da lista; a mais cara, a mais difícil de tornar acessível por teclado).
Ambas ficam registradas em `docs/design/direcao-visual.md` §8 como alternativas consideradas.

**O claro é a identidade canônica.** Decisão do dono do produto. A Mavia se apresenta sobre papel
quente: é o fundo claro que define a marca, o material de divulgação, as capturas de tela das lojas
e o primeiro contato do usuário. O modo escuro **continua existindo** como preferência do usuário,
especificado em `docs/design/direcao-visual.md` §2.5 e projetado, não invertido — mas ele não é a
cara do produto e não governa decisão de identidade.

**Consequência prática:** quando claro e escuro conflitarem numa escolha de cor, forma ou contraste,
o claro vence. Uma cor que só funciona bem no escuro é motivo para trocar a cor, não para relaxar
o claro.

**Também confirmado nesta rodada:** a resolução da tensão entre a preferência dos clientes pelo
Organizze e a identidade autoral. **Herdamos a arquitetura de informação, a densidade e a economia
de campos; a linguagem visual é nossa.** Copiamos a clareza, não a pele.
