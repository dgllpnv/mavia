# Épico · O produto no navegador do celular

**Aberto em** 2026-09-05, a pedido do dono: *"fui abrir no navegador do celular,
ficou péssimo… são tantas coisas ruins na navegação que nem vale a pena listar"*.

Não é épico de estética. É estrutural, e a evidência mediu o tamanho.

## O diagnóstico, medido antes de decidir qualquer coisa

| Fato | Número | O que significa |
|---|---|---|
| `<meta name="viewport">` | **correta** — `width=device-width, initial-scale=1`, conferida na resposta de produção | Descarta a causa mais comum e piora o diagnóstico: o navegador **está** renderizando na largura real, e os layouts não têm tratamento para ela |
| Utilitários responsivos em todo o `apps/web` | **12** (9 `lg:`, 3 `sm:`) | Quinze telas, doze utilitários. O produto é desktop-only por omissão, não por decisão |
| Grades de colunas fixas sem prefixo | **2**, não 13 | ⚠️ ver a correção abaixo |
| Contêineres com `overflow-x-auto` | **1** — e é o gráfico de relatórios | Sete tabelas sem contêiner próprio, todas no `/admin` |
| Destinos na barra de navegação | **8** | A `direcao-visual-2-familiar.md:104` decidiu **cinco**. A deriva é o que estoura a barra |
| Telas do app nativo `apps/mobile` | **4** de 15 | O navegador do celular **é** a experiência mobile hoje. Não há para onde empurrar ninguém |

**O que já funciona e não vamos refazer:** a linha do extrato é
`grid-cols-[auto_1fr_auto_auto]` com `truncate` e `min-w-0`
(`lancamentos/page.tsx`). Ela degrada bem em tela estreita.

### ⚠️ Correção do diagnóstico, registrada em vez de apagada

A primeira contagem disse **13 grades fixas**. Estava errada: a busca por
`grid-cols-[0-9]` contou junto as que **já têm prefixo**. Onze delas são
`lg:grid-cols-2` — isto é, **já são mobile-first e já estão corretas**.

As genuinamente sem prefixo são **duas**
(`lancamentos/recorrencias/page.tsx:365` e
`componentes/formulario-de-cartao.tsx:88`), mais duas dentro do formulário de
lançamento, que são do ticket 03.

E as duas **não vão ser convertidas**, por julgamento: são pares de campos
numéricos curtos — *"Fecha no dia"* / *"Vence no dia"*, *"Dia do mês"*. Em 390px
cada coluna recebe ~171px, de sobra para um número de dois dígitos, e os campos
são um par conceitual. Empilhá-los deixaria o formulário mais alto sem ganho
nenhum. **Mobile-first não quer dizer uma coluna sempre** — quer dizer que a
base descreve o celular, e para estes dois campos a base correta é duas colunas.

**O que isso muda no épico:** o transbordo horizontal não vinha das grades. Vinha
esmagadoramente da **barra de navegação** — oito destinos numa linha horizontal,
somando muito mais que 390px, presente em **todas** as telas por estar no
layout. É o ticket 01, e ele sozinho conserta o sintoma nas quinze. Os demais
tickets deixam de ser "consertar o quebrado" e passam a ser "confirmar que não
quebrou" — que é trabalho de verificação, e por isso o ticket 04 vale mais do
que parecia quando foi escrito.

## As oito decisões, do `/grill-me` de 2026-09-05

Todas do dono do produto. **Não se re-litigam em conversa** — o caminho para
mudar é o mesmo de uma ADR.

| # | Pergunta | Decisão |
|---|---|---|
| 1 | O que o mobile web precisa ser? | **O produto inteiro, com paridade de função.** O app nativo vem depois e não é condição |
| 2 | Como navega no celular? | **Barra de abas no rodapé.** Não sanduíche, não rolagem horizontal |
| 3 | Quais cinco lugares? | **visão geral · lançamentos · [+ lançar] · cartões · mais.** O centro é **ação**, não destino |
| 4 | Como aparece o formulário? | **Rota de tela inteira** no celular, com barra própria. Folha só para confirmações curtas |
| 5 | Mobile-first ou preservar o desktop? | **Mobile-first** |
| 6 | O `/admin` entra? | **Só o mínimo:** rolagem própria nas tabelas, barra colapsando |
| 7 | Vale a obrigação do `/prototype` (design.md §4)? | **Recortada:** uma tela prototipada, a escolha governa as outras quatorze |
| 8 | Como provamos? | **Invariante automatizada** mais o telefone do dono como palavra final |

### Os porquês que precisam sobreviver a este épico

**Por que abas no rodapé (2).** O polegar não alcança o topo de um telefone de 6
polegadas com uma mão só, e lançar despesa é a ação que se faz **em pé, no
caixa, com uma mão**. Navegação no topo transforma a ação mais frequente do
produto na mais desconfortável. É também a convenção da categoria, e a DP-31
escolheu deliberadamente a familiaridade.

E há um efeito de contenção: **a barra de abas não deixa a deriva de oito
destinos voltar, porque não cabe.** A restrição vira estrutural em vez de
disciplinar.

**Por que o centro é ação (3).** `app/(app)/page.tsx:25` já declarava por
escrito: *"lançar é o que a pessoa vem fazer, e o lugar de lançar é a primeira
tela"*. Deixar a ação mais frequente como botão dentro de uma tela custa um
toque e uma rolagem em toda despesa registrada no supermercado.

**Por que tela inteira e não folha (4).** O teclado. Com o teclado virtual aberto
num 390×844 sobram ~380px úteis. Uma folha nesse espaço obriga a rolar dentro de
algo que já rola dentro da página — o gesto que mais falha no mobile web, porque
o navegador rouba metade dos toques. Tela inteira dá ao campo em foco para onde
subir, mantém "salvar" alcançável, e dá significado ao botão voltar.

**Por que mobile-first (5), e este é o argumento central do épico.** Não é
pureza: é o **modo de falha** de cada política, e este repositório já rodou o
experimento.

> Sob "desktop-base com exceções", mobile é a exceção que alguém precisa lembrar
> de escrever. O resultado dessa política está medido: **12 utilitários
> responsivos em 15 telas.** Ninguém lembrou.
>
> Sob mobile-first, esquecer a variante dá um layout de celular no desktop —
> largo demais, feio, **utilizável**. Esquecer na outra direção dá o que o dono
> viu no telefone.
>
> Quando a disciplina falhar — e ela falha —, que falhe para o lado que não
> quebra.

**Por que a invariante de largura (8).** *"A página desliza de lado"* não é um
bug: é o sintoma de **qualquer** elemento que estourou. `scrollWidth <=
clientWidth` por rota substitui quinze inspeções visuais e continua valendo para
a tela dezesseis, que ainda não existe. Mesma lógica pela qual este repositório
testa propriedade em dinheiro em vez de exemplo escolhido a dedo.

Ela **não** mede se ficou bom — mede se ficou quebrado. Alvo de toque, contraste
e sensação de uso continuam sendo o telefone do dono, antes do merge.

## O conflito que o protótipo existe para resolver

`direcao-visual-2-familiar.md:113` fixou, para a visão geral, *"rodapé colapsado
com o realizado × previsto"*. A decisão 2 acabou de pôr uma **barra de abas** no
mesmo lugar.

Duas coisas fixas no rodapé de uma tela de 844px de altura é um conflito que não
se resolve por argumento — resolve-se olhando. É o ticket **02**, e é o único
com bloqueio humano.

## Fora de escopo, declarado

- **`apps/mobile`** (Expo). Decisão 1: vem depois.
- **Tratamento completo do `/admin`.** Decisão 6. O painel tem **um** usuário; as
  telas do produto vão ter todos os clientes.
- **Rever a identidade visual.** DP-31 e `direcao-visual-2-familiar.md` estão
  decididas. Este épico adapta a largura, não escolhe a cara do produto — foi por
  isso que a obrigação do `/prototype` entrou recortada e não integral.
- **Gate de risco.** Não cria rota, não coleta dado novo, não toca dinheiro. Se
  algum passo alterar apuração ou formatação de valor, o `validador-financeiro`
  entra na hora — formatação de dinheiro tem dono, e não é o frontend.

## A evidência, medida contra a aplicação

Build de produção servido localmente, API de verdade, sessão real, quatro
larguras, **23 rotas listadas à mão** — incluindo `/cartoes/[id]`, dinâmica.

> ⚠️ **A derivação do ticket 04 produz 25, não 23.** A diferença são rotas
> públicas de credencial que a minha lista não incluiu. O número abaixo é o de
> uma medição própria, e ela **não** é a rede: uma lista escrita à mão é o modo
> de falha que o ticket 04 existe para fechar, e a minha caiu nele. Quem fecha a
> conta é a execução da suíte — ver o residual da porta 4710.

| Largura | Reprovadas |
|---|---:|
| 360px | **0** |
| 390px | **0** |
| 800px — a faixa que estava quebrada | **0** |
| 1280px — desktop | **0** |

`pnpm typecheck` · `pnpm lint` · `pnpm test` (API 675/675, web 107/107).

### Os três defeitos que só a medição encontrou

Nenhum estava na lista escrita a partir da leitura do código, e **um deles foi
introduzido por mim durante o conserto**:

1. **`/lancamentos`, 495/390.** O cabeçalho de card carrega título, navegador de
   período e duas ações. O `shrink-0` que eu tinha posto no grupo de ações —
   para o título absorver o encolhimento — **piorou**: virou um bloco atômico de
   440px que descia inteiro para a segunda linha e continuava estourando. A
   correção é as ações quebrarem **entre si**, não o grupo inteiro.

2. **`/cartoes`, 421/390 — o próprio card.** `grid-cols-[92px_1fr_150px_88px]`:
   a faixa `1fr` tem `min-width: auto`, então o `truncate` da descrição não
   limitava nada e o `min-content` da linha virava o texto inteiro. Um item de
   grade não encolhe abaixo do próprio `min-content`. Virou `minmax(0,1fr)`, com
   as larguras fixas só a partir de `lg`.

3. **`/cartoes/[id]` tinha 402px de colunas fixas, e escapou da medição
   inteira** — a lista de rotas era estática e ela é dinâmica. É exatamente o
   modo de falha que o ticket 04 foi escrito para evitar, e a primeira versão da
   minha própria medição caiu nele. A rota passou a ser descoberta navegando.

> A lição que vale além deste épico: **a leitura do código apontou a barra de
> navegação e errou o resto.** Duas das três causas reais eram propriedades de
> `min-content` que nenhuma busca por `grid-cols` ou `truncate` revelaria — elas
> só existem quando o navegador calcula o layout. A invariante do ticket 04 não
> é uma rede de segurança para o futuro; ela foi o instrumento que achou o
> presente.

## O que a revisão de código encontrou, e o que foi feito

O `revisor-codigo` **bloqueou o merge** com um achado que a invariante de largura
não tinha como pegar, porque ela mede o eixo horizontal.

**A barra de abas cobria o rodapé de resumo de `/lancamentos`.** `sticky
bottom-0` gruda no fundo do *scrollport*, que é o viewport — não no fim do
conteúdo. Durante a rolagem, que é o caso normal de um extrato, o rodapé ficava
exatamente onde a barra está, e a barra pintava por cima. Medido: **56px de
sobreposição em 64**. Saldo e Previsto — o par realizado × previsto — ficavam
invisíveis no celular.

Corrigido com `.rodape-sobre-as-abas`, e remedido: **sobreposição zero em toda
posição de rolagem**, com o rodapé encostando exatamente no topo das abas.

Mais quatro correções da mesma revisão:

- **A fronteira da moldura estava em `md` enquanto o cromo estava em `lg`.**
  Entre 768 e 1023 a barra de abas aparecia, o centro dela navegava para
  `/lancar`, e lá `md:static` tirava a moldura do modo fixo — a barra
  `salvar`/`cancelar` voltava a rolar para fora. A regra que o próprio
  repositório já tinha escrito: *"as duas fronteiras são a mesma decisão e
  precisam ser o mesmo número"*.
- **Quatro comentários diziam `md` onde o código faz `lg`.** Corrigidos, não
  apagados.
- **`role="radio"` sem `role="radiogroup"`** no seletor de natureza. O defeito é
  anterior ao épico; a severidade não é — com a ação de lançar fora do cabeçalho
  no celular, aqueles três botões passaram a ser o **único** caminho para
  receita e transferência num telefone.
- **A contagem de rotas do registro estava errada** (23 à mão contra 25
  derivadas). Corrigida acima.

O que a revisão confirmou sem achado, e vale registrar: **nenhum arquivo deste
épico toca aritmética ou formatação monetária** — o `mutationFn` está idêntico ao
de `092ca33` —, então o `validador-financeiro` não é acionado; `rotuloCurto` é só
rótulo de tela; e continua sendo **um** componente de formulário, com a moldura
decidida por quem monta.

## Residuais aceitos, nomeados

**A faixa 768–1023px do painel fica irregular.** Ali a barra do `/admin` não cabe
numa linha e cada grupo embrulha internamente: três faixas, 104px de altura.
**Não desliza de lado** — e antes desta mudança, nessa mesma largura, ela
estourava (`scrollWidth` 1206 contra 768 úteis). É estritamente melhor do que
era.

Deixá-la decente exigiria um terceiro degrau (`lg`) só para o painel, o que
contraria a trava *"acima de `md`, idêntico ao de hoje"* — e essa trava é o que
protege uma produção viva de uma mudança de interface. A decisão 6 foi de
**orçamento**: o painel tem um usuário. Aceito, registrado, não re-litigado.

**O `Modal` virou folha para os treze diálogos do produto, e a decisão 4 dizia
"folha só para confirmações curtas".** Achado do `revisor-codigo`, e ele está
certo: os usuários do `Modal` não são confirmações — são formulários de cinco
campos ou mais, com teclado, em `formulario-de-cartao`, `contas`,
`recorrencias`, `objetivos`, `planejamento`, `categorias` e `membros`. E
`max-h-[88dvh]` **não encolhe com o teclado virtual no iOS**, porque o teclado
redimensiona o viewport visual e não o de layout.

É literalmente a configuração que o épico rejeitou por escrito para o formulário
de lançamento: *"obriga a rolar dentro de algo que já rola dentro da página"*.

**Aceito como residual, e vira ticket** — não corrijo aqui por três razões: a
folha é estritamente melhor do que o modal centralizado que estava lá antes
(ancorada onde o polegar chega, com área segura); o desktop está intacto; e
converter sete formulários em rota é o mesmo trabalho do ticket 03, sete vezes,
com sete decisões de moldura. É épico próprio, não emenda deste.

**A suíte Playwright do ticket 04 não foi executada contra este código.** Ela
exige `127.0.0.1:4710`, e a porta está ocupada por um `next dev` do **diretório
principal** (PID 39124, iniciado em 2026-09-04). Não foi possível encerrá-lo, e
matar processo alheio não é decisão de quem está de passagem.

O `globalSetup` do ticket 04 **detecta exatamente isso e aborta de propósito** —
ele exige que toda rota estática do disco responda algo diferente de 404 no
servidor alvo, e reportou `/lancar → 404`, `/mais → 404`. Foi o defeito que ele
foi escrito para pegar, pego na primeira execução.

A evidência da seção anterior veio de uma medição própria contra o build de
produção numa porta livre, com a mesma invariante. **Ela não substitui a suíte**:
é uma execução, não uma rede. Para fechar:

```bash
netstat -ano | findstr :4710      # confirme o PID
taskkill /PID <pid> /F
pnpm dev                          # a partir do worktree
pnpm --filter @mavia/web e2e -- --project=mobile
pnpm --filter @mavia/web e2e -- --project=chromium   # o desktop, que precisa continuar verde
```

**As rotas `/admin/clientes/[tenantId]` ficam fora da invariante de largura.**
Elas exigem um resolvedor que declare a hipótese no `Portao` antes, e o layout
não renderiza os filhos sem ela. As quatro rotas estáticas do painel **entram**.

> A dispensa original dizia que o painel inteiro era incobrível porque *"a
> semente do produto não cria sessão de operador"*. **Era falso** —
> `apps/api/src/db/semear.ts:147` concede admin a `demo@mavia.local` em ambiente
> local. Corrigido em vez de apagado: uma dispensa com justificativa falsa é
> pior do que uma dispensa, porque a próxima pessoa acredita nela.

## Tickets

| # | O quê | Estado |
|---|---|---|
| 01 | O cromo: abas no rodapé, topo enxuto, tela "mais" | ✅ |
| 02 | Protótipo do extrato, três tratativas do rodapé | ✅ entregue; **a escolha do dono segue aberta** |
| 03 | O formulário de lançamento como rota | ✅ |
| 04 | A rede: Playwright mobile e a invariante de largura | ✅ escrita; **não executada** — ver residuais |
| 05 | Mobile-first, tela a tela | ✅ |
| 06 | `/admin`: o mínimo | ✅ |

### Uma correção ao ticket 02, registrada

O protótipo foi anunciado como sendo da **visão geral**. Estava errado: o
*"rodapé colapsado com o realizado × previsto"* é do **Extrato**
(`direcao-visual-2-familiar.md:112-113`), não do painel. É no `/lancamentos` que
a barra de abas e o rodapé disputam o mesmo lugar, e é ele, além disso, a tela
mais densa e mais usada. O protótipo entregue é do extrato.

**A decisão do dono entre as três tratativas continua pendente**, e o que está no
ar é a **A** — resumo empilhado sobre as abas.

Não por escolha: é o que o código já fazia. `lancamentos/page.tsx:230` é
`cartao sticky bottom-0`, e a barra de abas nova entrou embaixo dele. A
tratativa A é o **estado natural** de não decidir nada, e o custo dela é
concreto: cerca de 100px permanentes num telefone, entre resumo e navegação.

Minha recomendação continua sendo a **B** — resumo no topo, rodapé só para
navegação —, pelo argumento de que o realizado × previsto é número de chegada,
não algo que se acompanha durante a rolagem. Mas mudar a tratativa é mudar uma
decisão de design registrada na `direcao-visual-2-familiar.md:113`, e essa é do
dono, não minha. Trocar depois é barato: um `sticky bottom-0` vira um bloco no
topo, num arquivo.
