# Spec — Planos e assinatura (épico 11)

- **Data:** 2026-09-01
- **Autores:** `product-financeiro` + `especialista-lgpd-compliance` (papéis acumulados)
- **Status:** proposto. Os pontos marcados 🔺 são decisão do dono do produto, com padrão declarado.
- **Decisões de origem:** **DP-13** (espelhar os três níveis do Organizze) · **DP-14** (Stripe) · **DP-15** (teste de 7 dias, sem cartão), em `docs/decisoes-do-produto.md`
- **Insumos:** `CONTEXT.md` · `CLAUDE.md` §2 · `docs/pesquisa/organizze-teardown.md` · `docs/pipeline.md` (épicos 11 e 12) · `docs/adr/0003-banksyncprovider.md` · `docs/adr/0018-envelope-encryption.md` · `docs/adr/0019-revogacao-no-banksyncprovider.md` · `docs/produto/arquitetura-informacao.md` §2.12 · `docs/compliance/retencao-e-eliminacao.md` · `docs/seguranca/matriz-de-acesso.md` §2.3 · `docs/arquitetura/sistema.md` §3, §4, §5
- **Decisões de 2026-09-01 já incorporadas:** DP-16 (sem nota fiscal automática) · DP-17 (vender os três) · DP-18 (nomes) · DP-19 (mensal **e** anual)
- **Exige alteração em:** `CONTEXT.md`, pelo `arquiteto-dominio-financeiro` (§9.2) · `docs/compliance/retencao-e-eliminacao.md` §2.2, §3.6, §5.3, §6.1 e §11 — **feitas junto com este documento** (§15)

Referência de mercado (teardown, seção de Plano não coberta na navegação; valores informados pelo dono do produto): Organizze **Manual R$ 35**, **Conectado R$ 45** com até 3 contas conectadas, **Conectado Plus R$ 69** com até 10 contas e suporte a PJ, teste de 7 dias.

---

## 1. A tensão, e a posição

**O problema.** Os dois planos superiores do Organizze cobram por **conexão bancária automática**. Na Mavia isso é o **épico 12**, e o ADR 0003 fixou que o gatilho do épico 12 é *a receita cobrir o custo do agregador com margem*. Se os planos superiores só existirem quando a conexão existir, e a conexão só existir quando houver receita dos planos superiores, o produto trancou a si mesmo num círculo.

**A proposta do coordenador:** modelar os três planos desde já e manter os Conectados **indisponíveis para compra** até o épico 12.

### 1.1 Posição: aceito o modelo, recuso a indisponibilidade

Aceito, e mantenho como regra dura, a parte que importa:

> **Nunca cobramos por uma função que não funciona.** Nenhum plano à venda pode listar conexão bancária automática entre o que entrega, em nenhuma tela, em nenhum e-mail, enquanto o épico 12 não estiver em produção. Isso não é cautela jurídica — é o que separa uma assinatura de um pedido de reembolso.

E recuso a conclusão de que isso obrigue a deixar dois planos trancados. **Trancar não é necessário, e é caro em três frentes:**

1. **Uma porta trancada é propaganda do concorrente.** A tabela de preços com dois níveis cinzentos diz ao visitante, no primeiro contato, exatamente o que o produto não faz — e ele já sabe onde isso existe, por R$ 45.
2. **Garante receita zero nos dois níveis superiores**, que é pior do que a receita pequena que eles renderiam. E é justamente a receita que o ADR 0003 espera para destravar o épico 12.
3. **Assume, sem necessidade, que o único eixo de diferenciação é o agregador.** Não é.

### 1.2 O que os planos superiores vendem enquanto a conexão não existe

Olhando o que o Organizze cobra no terceiro nível — *até 10 contas conectadas e suporte a PJ* —, metade não depende de agregador nenhum. E, na ordem do `docs/pipeline.md`, o **épico 10 (Compartilhamento: múltiplos usuários por Tenant, papéis) vem antes do épico 11 (Billing)**. Quando a cobrança existir, o compartilhamento já existe.

Logo, os três níveis se diferenciam por coisas que entregamos no dia do lançamento:

| Nível | Eixo de valor entregue hoje |
|---|---|
| 1 | Uma pessoa, um espaço. O produto manual completo. |
| 2 | O espaço **compartilhado** — casal, família, quem divide contas. |
| 3 | **Mais de um espaço** — pessoa física separada da PJ, ou do negócio paralelo. É a leitura honesta de "suporte a PJ" no nosso modelo: um `Tenant` a mais, com contas, categorias e relatórios próprios. |

Quando o épico 12 chegar, a conexão bancária **entra nos níveis 2 e 3 sem aumento de preço**, com as cotas de 3 e 10 conexões espelhando o Organizze. Aumento de valor sem aumento de preço é o melhor evento de retenção disponível, e transforma a desvantagem de hoje no argumento de amanhã. É prometível com segurança porque é uma promessa sobre **preço**, não sobre prazo de entrega de função.

### 1.3 O que faço com a lista de espera, e o que recuso

- **Lista de espera: sim.** Uma seção própria da página de preços, fora dos cartões de plano, com o texto do §11.6. Ela é o instrumento que faltava ao ADR 0003: a revisão trimestral hoje compara custo do agregador contra receita *no escuro*. Uma lista com nome do banco e faixa de disposição a pagar transforma essa revisão numa conta.
- **Preço anunciado na lista: sim, com compromisso.** Anunciar preço sem compromisso é isca; não anunciar torna o sinal inútil. Regra: *quem entra na lista antes do lançamento paga o preço anunciado por 12 meses, ou não anunciamos preço nenhum.*
- **Pré-venda com desconto: recuso.** Receber dinheiro hoje por função de daqui a dois ou três trimestres é, em ordem: reembolso diferido, exposição ao art. 35 do CDC (serviço ofertado e não prestado) e, se o épico atrasar, um evento de estorno em massa que degrada nossa classificação de risco na Stripe e ameaça a conta de pagamentos inteira. O ganho de caixa não paga isso.
- **Nomes "Conectado" e "Conectado Plus": recuso.** O nome promete o agregador. Além disso são o vocabulário do concorrente, e `CONTEXT.md` é severo com sinônimo importado. Proposta no §2.

### 1.4 O que continua valendo da proposta original

Modelar os três planos **desde já**, mesmo que a decisão 🔺 do §2.4 acabe sendo vender só um. O catálogo com três níveis, as cotas e a máquina de estados custam o mesmo escrevendo agora, e uma cota introduzida depois exige migração de dado de cliente pagante — a pior hora para descobrir que `assinaturas` não previa o campo.

---

## 2. Os três planos

Preços em reais, **impostos incluídos** (CDC art. 6º III: o preço à vista total é o que se anuncia). Cobrança **mensal ou anual** (DP-19), em `BRL`, sempre como `Money` em centavos.

| | **Mavia Pessoal** | **Mavia Família** | **Mavia Negócio** |
|---|---|---|---|
| Preço/mês | **R$ 35** | **R$ 45** | **R$ 69** |
| Preço/ano — *dois meses grátis* | **R$ 350** | **R$ 450** | **R$ 690** |
| Pessoas no espaço | **1** | **5** | **10** |
| Espaços em que é proprietário | **1** | **1** | **3** |
| Anexos por espaço | **2 GB** | **10 GB** | **30 GB** |
| Conexões bancárias *(épico 12)* | 0 | **3** | **10** |
| Todo o resto | ilimitado (§4) | ilimitado (§4) | ilimitado (§4) |

**Nomes — decidido (DP-18):** `Pessoal` · `Família` · `Negócio`. Descartados: *Conectado/Conectado Plus* (o nome promete o agregador e é vocabulário do concorrente); *Básico/Pro/Premium* (não dizem para quem é, e "Básico" ensina o cliente a se sentir mal).

**Os três à venda desde o lançamento — decidido (DP-17).** Diferenciados por pessoas e espaços (§1.2). `disponivel_para_compra = true` nos três. O booleano permanece no catálogo porque é o mecanismo que permitiria fechar um nível sem migração de dado.

**Preços** — mantidos exatamente nos três pontos do Organizze, conforme DP-13. Registro a desvantagem sem enfeite: enquanto a conexão não existir, **a comparação direta nos níveis 2 e 3 é desfavorável** — mesmo preço, entrega diferente. Não há como evitá-la, só como escolher o que se compara. Por isso a página de preços compara Mavia com Mavia, e nunca constrói a tabela lado a lado com o concorrente.

**A linha da conexão bancária aparece na tabela desde já, com valor 0/3/10 e a marca `em desenvolvimento`** — e **fora** da lista do que o plano entrega hoje. É a única menção permitida dentro do cartão de plano. Ela existe para que o cliente que assina hoje saiba, por escrito, qual cota terá quando a função chegar, e para que ninguém possa dizer que descobriu depois.

### 2.4 O desconto anual: dez pelo preço de doze

**Desconto proposto: `anual = 10 × mensal`** — "dois meses grátis", ≈16,7%.

Por que 10× e não um percentual: (a) é a forma mais legível de anunciar um desconto em português — "pague 10, use 12" não precisa de conta; (b) produz preços redondos nos três níveis (R$ 350, R$ 450, R$ 690), sem centavo quebrado em nenhuma tela; (c) é discreto o bastante para não estabelecer expectativa de desconto maior no futuro, e essa expectativa é difícil de desfazer.

**Regras de dinheiro, não negociáveis:**

- O preço anual é uma `Money` **própria no catálogo**, declarada em centavos. **Nunca é obtido multiplicando o mensal em tempo de execução** — preço derivado por aritmética é preço que diverge entre a vitrine, a Stripe e o reembolso.
- "≈ R$ 29,17/mês" e equivalentes são **texto de vitrine**, arredondados só para exibição, e **jamais entram em cálculo** de cobrança, proração ou reembolso. Nenhuma divisão acontece no caminho do dinheiro (§6.3).

### 2.5 O que a decisão do anual custa — registrado

A decisão é do dono (DP-19) e é contra a minha recomendação. Registro o que ela traz, e o que dela sobrevive à correção:

**O meu argumento mais forte caiu, e o coordenador está certo sobre isso.** Eu objetei que o anual vende doze meses de uma promessa. Com `Família` e `Negócio` renomeados e vendendo pessoas e espaços — coisas que existem hoje —, o anual vende doze meses **do que já funciona**. A objeção era contra o nome, não contra o intervalo, e o nome foi corrigido.

**O que sobrevive, e vira requisito neste documento:**

| Consequência | Onde é tratada |
|---|---|
| Proração na troca de plano dentro do período | §6.2 |
| Reembolso parcial — sem ele, o anual é uma armadilha para um produto sem histórico de retenção no mês 2 | §6.3 |
| Renovação anual é a cobrança-surpresa clássica: R$ 690 caindo num cartão doze meses depois, de um produto que a pessoa esqueceu que assinou | §6.4, avisos obrigatórios em D-30 e D-7 |
| Reajuste de preço com anual pago | §6.4 |
| Estorno (chargeback) de valor alto é muito mais danoso à nossa conta na Stripe do que um de R$ 35 | §13 |

---

## 3. As cotas, campo a campo

**Nome no domínio: `Cota`.** Nunca "Limite" — `Limite` é termo **proibido** pelo `CONTEXT.md`, reservado ao que virou `Planejamento`. Uma cota de plano e um teto de gasto são coisas diferentes e não podem dividir palavra.

| Cota | Como se conta, exatamente | Por que existe |
|---|---|---|
| `pessoas` | Linhas de `tenant_usuarios` com `aceito_em IS NOT NULL AND saiu_em IS NULL`, **mais** `convites` não expirados e não recusados. Todos os papéis contam, inclusive `visualizador` | Cada pessoa é suporte, é sessão, é superfície de acesso. É o custo mais previsível que temos |
| `espacos` | `Tenant`s em que o usuário tem papel `proprietario` e `saiu_em IS NULL` | Um espaço a mais é um conjunto inteiro de dados, jobs e backup |
| `armazenamento_anexos_bytes` | Soma de `anexos.tamanho_bytes` não excluídos do `Tenant` | Único custo em bytes que cresce sem teto natural. Lançamento é texto; foto de recibo não |
| `conexoes` | `conexoes` com `status = 'ativa'` (épico 12) | Custo marginal real e recorrente do agregador (ADR 0003). É a única cota que corresponde a uma fatura que a Mavia paga por unidade |

Contagem sempre no servidor, sob RLS, na mesma transação da criação. Cota conferida na UI é conveniência; cota conferida só na UI é defeito.

O catálogo vive em **código** — `packages/domain/billing/catalogo.ts` —, não em tabela. Mesmo argumento que a política de retenção usa (`retencao-e-eliminacao.md` §1): configuração versionada em código não é alterável em produção sem deploy e sem teste, e `limitesDoPlano(codigo)` vira função pura testável em S1. A Stripe guarda os `price_id`; o catálogo guarda o mapa.

---

## 4. O que **não** é limitado, e por quê

Limitar o que não custa é hostil, e é a forma mais rápida de ensinar o cliente que o produto trabalha contra ele. A lista abaixo é normativa: **nenhum destes itens pode ganhar cota de plano sem revisão deste documento.**

| Nunca limitado | Por quê |
|---|---|
| **Lançamentos** | É o ato central do produto. Limitar o número de lançamentos é limitar o uso. Uma linha de texto e dois inteiros não custam nada |
| **Contas e Cartões manuais** | O Organizze não limita, e não há custo por unidade. Quem tem seis contas não é um cliente maior, é um cliente mais bagunçado — e é exatamente quem precisa do produto |
| **Categorias, Etiquetas, Recorrências, Planejamentos, Objetivos** | Estrutura, não volume |
| **Histórico** | **Nenhum plano encurta retenção.** O estado da assinatura não é gatilho de retenção de nenhuma classe (§11.5). Esconder o passado de quem parou de pagar é sequestro de dado com outro nome |
| **Importação de arquivo (OFX/CSV)** | É o substituto da conexão bancária no MVP (ADR 0003). Cobrar por ela seria cobrar pelo remendo da função que ainda não temos |
| **Relatórios, filtros, base temporal do cartão** | Cálculo derivado. E um relatório atrás de paywall produz cliente que desconfia do número que vê |
| **Exportação e portabilidade** | **Direito do titular** (LGPD art. 18 V). Funciona em **todos** os estados da assinatura, inclusive `expirada` e `cancelada`. Não é função de plano e nunca será |
| **Eliminação de dados, exclusão do espaço, revogação de conexão** | Direitos do art. 18. Nunca atrás de pagamento, nunca com atrito adicional |
| **Anexos por lançamento, tamanho de arquivo individual** | Governado por segurança (limites do Traefik e do sandbox de parsing), não por plano |
| **Sincronizações sob demanda** | Já limitadas a 6/dia por conexão por razão operacional (`sistema.md` §5.2). Razão técnica declarada não vira alavanca comercial |
| **Dispositivos, sessões, uso do app mobile** | Custo zero, atrito alto |
| **Suporte** | Todo mundo recebe resposta. Fila prioritária por plano é aceitável; ausência de resposta não |

---

## 5. O que acontece ao estourar uma cota

Três estados, e o terceiro é o que quase todo SaaS erra.

| Situação | Comportamento |
|---|---|
| **Abaixo da cota** | Normal |
| **Na cota** | A criação **daquele tipo** é recusada com `409` e código `cota_do_plano`. O corpo do erro nomeia o recurso, a cota, a contagem atual e as **duas saídas** ("remover uma" · "mudar de plano"). Nenhum outro recurso é afetado: criar lançamento continua funcionando enquanto o convite é recusado |
| **Acima da cota** (só alcançável por rebaixamento — §8) | **Estado tolerado.** Nada é apagado, nada é escondido, nada vira somente-leitura. Bloqueia-se apenas a criação daquele tipo até a contagem voltar |

**Regras duras, sem exceção:**

1. **Nunca apagamos dado do cliente por causa de cota.** Nem lançamento, nem conta, nem anexo, nem membro, nem espaço. Estourar uma cota é um estado, não um evento destrutivo.
2. **Nunca degradamos silenciosamente.** Não existe "seu relatório mostra só 90 dias porque seu plano mudou". Ou o recurso funciona, ou ele diz por que não funciona, no ponto do clique.
3. **A recusa nomeia o número.** "Seu plano permite 5 pessoas e o espaço tem 5" — nunca "limite atingido".
4. **A conexão bancária é a única cota com tratamento próprio** (§8.3), porque é a única que nos custa dinheiro todo mês enquanto existir. Mesmo lá, o mecanismo é **pausar**, nunca apagar.

---

## 6. Ciclo de vida da assinatura

Cinco estados. Uma `Assinatura` por `Tenant`.

```
       criação do espaço
              │
              ▼
         ┌────────┐  assina  ┌────────┐  falha de pagamento  ┌───────────┐
         │ teste  │─────────▶│ ativa  │─────────────────────▶│ em_atraso │
         └────────┘          └────────┘◀── pagamento ────────└───────────┘
              │                   │            recuperado          │
        8º dia│           cancela │                                │ 14 dias
              │                   ▼                                │
              │             ┌───────────┐   fim do período pago    │
              │             │ cancelada │──────────────┐           │
              │             └───────────┘              ▼           │
              └───────────────────────────────────▶┌──────────┐◀───┘
                                                   │ expirada │
                                                   └──────────┘
                                                        │ reativa
                                                        └────────▶ ativa
```

| Estado | O que o usuário **faz** | O que **vê** | Por quanto tempo |
|---|---|---|---|
| **`teste`** | Tudo, nas cotas do nível **Família** | Contador honesto desde o primeiro dia: *"Seu teste vai até 08/09. Não pedimos cartão e não cobramos nada."* | **7 dias**, contados do `criado_em` do Tenant. Sem prorrogação automática |
| **`ativa`** | Tudo, nas cotas do plano | Nada sobre cobrança fora de Configurações → Plano e cobrança | Enquanto pagar |
| **`em_atraso`** | **Tudo continua funcionando — leitura e escrita** | Faixa clara, com a data limite exata e o botão de atualizar o cartão. Repetida em e-mail nos dias 1, 3, 7 e 12 | **14 dias**, alinhados à janela de retentativa da Stripe. Depois → `expirada` |
| **`cancelada`** | **Tudo continua funcionando até o fim do período já pago** | A data exata em que vira leitura, e o que acontece com os dados (texto do §6.5). Botão de desfazer o cancelamento, sem atrito | Até `periodo_fim`. O cliente pagou por ele |
| **`expirada`** | **Leitura completa. Exportação completa.** Escrita bloqueada com `402` e explicação no ponto do clique | Banner permanente, botão de reativar, histórico intacto na tela | **Indefinidamente. Nunca apagamos** (DP-5) |

**Por que `em_atraso` não degrada nada.** Bloquear o produto no instante em que um cartão falha é a forma mais comum de perder um cliente que queria ficar — e a maioria das falhas é cartão vencido ou limite momentâneo, não desistência. Catorze dias de produto inteiro nos custam quase nada e salvam a assinatura.

**Jobs durante `expirada`:** `recorrencia.materializar` pausa (geraria dado novo); `alertas.avaliar` pausa; leitura, saldo e exportação continuam. Ao reativar, a materialização preenche as competências passadas — o job é idempotente por `(tenant_id, recorrencia_id, competencia)` e nada se perde.

**Membros num espaço `expirada`** veem a mesma leitura, e a faixa diz *"o proprietário deste espaço precisa reativar a assinatura"* — nunca dado de cobrança, que é exclusivo do `proprietario` (`matriz-de-acesso.md` §2.3).

### 6.1 O intervalo não muda a máquina de estados

Mensal e anual usam **os mesmos cinco estados**, a mesma janela semiaberta `[periodo_inicio, periodo_fim)` e a mesma janela de graça de 14 dias. Muda só a duração do período e o `stripe_price_id`. Nenhum estado novo, nenhum ramo novo — a diferença é um campo, `Assinatura.intervalo`.

A graça de 14 dias vale igualmente para o anual, e ali ela importa mais: uma cobrança de R$ 690 falha por limite de cartão com muito mais frequência que uma de R$ 69, e quase sempre por motivo que o titular resolve em um dia.

### 6.2 Upgrade, downgrade e troca de intervalo

| Movimento | Quando vale | Dinheiro |
|---|---|---|
| **Upgrade de plano** (Pessoal → Família, mesmo intervalo) | Imediato. As cotas novas valem no mesmo instante | Proração da Stripe: a parte não usada do período vira **crédito**. Nunca cobrança retroativa |
| **Mensal → anual** | Imediato | O que resta do mês vira crédito no anual |
| **Downgrade de plano** | **No fim do período pago.** Nunca no meio | Sem devolução: o cliente comprou aquele período inteiro (mas ver §6.3 — cancelar é outro caminho, e esse tem reembolso) |
| **Anual → mensal** | No fim do período anual | Idem |

**A resolução de excesso do §8.1 vale igual, com horizonte de doze meses no anual.** O lembrete de sete dias antes da data efetiva passa a ser o único aviso que a pessoa vai lembrar — por isso ele nomeia o excesso item a item, não em número agregado.

### 6.3 Reembolso — a fórmula, e por que ela não divide

Três camadas, da mais forte para a mais fraca:

1. **Arrependimento — 7 dias, integral, sem pergunta.** CDC art. 49. É **obrigação legal**, não política comercial, e vale igualmente para mensal e anual.
2. **Primeira cobrança, até 30 dias — integral** (🔺 DP-20, pendente; padrão proposto). Custa pouco e remove o medo de assinar o anual.
3. **Cancelamento depois disso — proporcional aos meses não iniciados**, a qualquer momento, sem perguntar o motivo:

```
reembolso = max(0, valor_pago − meses_iniciados × preco_mensal_do_plano)
```

**Por que esta fórmula e não "valor pago ÷ 12 × meses restantes".** Três razões, e as três importam:

- **Não há divisão.** Uma subtração e uma multiplicação em centavos, e nenhum arredondamento a declarar — a regra 3 do `CLAUDE.md` não é acionada e `ratear` não entra no caminho do dinheiro. A alternativa exigiria dividir o preço anual por 12, que não é exato em nenhum dos três planos.
- **Devolve o desconto que não foi ganho.** Quem usou 3 meses do Negócio anual recebe `69000 − 3 × 6900 = R$ 483,00` e terá pago exatamente a tarifa mensal cheia pelo que usou. Sem isso, o desconto anual vira opção grátis: assina anual, cancela no mês 2, e paga barato pelo uso mensal.
- **Nunca cobra a mais.** O `max(0, …)` garante que o pior caso é reembolso zero, jamais uma cobrança de saída.

`meses_iniciados` conta pela **Ancoragem de dia do mês** do `CONTEXT.md` — o termo que o `arquiteto-dominio-financeiro` promoveu justamente porque a regra estava reescrita em quatro lugares: o mês `k` começa em `periodo_inicio + k meses`, com o dia sempre calculado a partir do **dia âncora original** e **sem arrastar o ajuste**. Contagem em `America/Sao_Paulo`, janela semiaberta. A `Assinatura` é a quinta entidade a usá-la, e a razão de o termo existir é exatamente esta: que a quinta não divirja das quatro.

O reembolso é executado **na Stripe**, com `Idempotency-Key` derivada de `cobranca:${stripe_invoice_id}:reembolso`. Reembolsar duas vezes é tão grave quanto cobrar duas vezes, e o mecanismo é o mesmo.

**E o valor devolvido é persistido em `Cobranca.valor_reembolsado`** (§9.1). Com o anual, reembolso parcial é caminho comum e não exceção: sem persistir, a Mavia saberia *que* devolveu e não *quanto* — e a resposta passaria a viver só do lado da Stripe, contra a §10.1.

### 6.4 Renovação anual e reajuste de preço

**Renovação nunca é surpresa.** Dois avisos obrigatórios antes de toda renovação anual, por e-mail e no app:

- **D-30** e **D-7**, cada um com: a data exata da cobrança, o **valor exato**, o cartão que será usado (marca e últimos 4) e um link de cancelamento que funciona em um clique, sem passar por tela de retenção.
- Se qualquer um dos dois falhar em ser enviado, a renovação **é adiada**, não executada às cegas. Cobrar R$ 690 de alguém que não foi avisado é o caminho mais curto para um estorno, e estorno de valor alto é o dano do §13.

**Reajuste de preço.** `Assinatura` guarda `plano_versao` e o preço contratado.

- Quem pagou anual **mantém o preço contratado pelo período inteiro**. Um reajuste anunciado no mês 4 não toca a cobrança já feita.
- O preço novo só vale **na renovação**, e o aviso de D-30 passa a trazer as duas linhas: preço anterior, preço novo, data da cobrança. Nunca só o valor final.
- Se o reajuste for anunciado a menos de 30 dias da renovação, ele **pula um ciclo**: renova no preço antigo e o novo vale no seguinte. Regra simples que torna impossível o caso ruim.

### 6.5 O que acontece com os dados de quem cancela

Texto normativo, exibido no diálogo de cancelamento **antes** da confirmação:

> **Se você cancelar:**
> - Você continua com tudo até **08/10/2026**, o fim do período que já pagou.
> - Depois disso, o espaço fica **somente leitura**: você continua vendo todos os seus lançamentos, contas, cartões e relatórios, e continua podendo exportar tudo.
> - **Não apagamos nada.** Seu histórico fica guardado enquanto você quiser, sem prazo. Se voltar em dois anos, ele estará aqui.
> - Se quiser que a gente apague de verdade, isso é outra coisa e você pede em **Configurações → Dados e privacidade → Excluir o espaço**. É irreversível e tem prazo de arrependimento de 7 dias.
> - Guardamos por 5 anos os documentos fiscais das cobranças que já aconteceram, porque a lei tributária exige.

**Cancelar ≠ eliminar.** São duas operações, dois botões, dois textos, e a confusão entre elas é a origem de dois problemas opostos: o cliente que achou que tinha apagado tudo e não apagou, e o cliente que achou que só tinha cancelado e perdeu o histórico. O produto separa as duas em telas diferentes e nunca oferece a eliminação como passo do cancelamento.

**Conciliação com `retencao-e-eliminacao.md`:** os prazos daquela política são disparados por `deleted_at`, por pedido do titular ou por obrigação legal. **`assinaturas.estado` não é gatilho de retenção em nenhuma classe** — cancelar não encurta prazo nenhum, e expirar não apaga nada. Isso é coerente com a **DP-5** (conta inativa não é eliminada) e precisa ser afirmado na política de privacidade, porque é diferença real em relação ao mercado.

---

## 7. O oitavo dia — o fim do teste sem cartão

É o momento de maior atrito do produto inteiro e o de maior chance de o cliente se sentir enganado. As regras abaixo são desenhadas para que, no dia 8, **nada seja surpresa**.

1. **Nunca existe cobrança sem cartão.** Não há caminho de código que crie assinatura na Stripe sem uma sessão de checkout iniciada por um clique do usuário numa tela que mostra o preço. O teste não cria `Customer` na Stripe (§10.2). Isso é afirmável em texto na página inicial, e é verdade verificável: *"não pedimos cartão, e ninguém é cobrado sem digitar um."*
2. **A data final aparece desde o primeiro minuto**, não a partir do dia 5. Data absoluta ("até 08/09"), nunca só "faltam 3 dias".
3. **Três avisos: D-3, D-1 e D0**, por e-mail e faixa no app. Cada um traz a data exata, o que acontece (leitura continua, escrita para), e o preço. Nenhum outro aviso — durante o teste não se pede cartão em pop-up. Um lembrete respeitoso converte mais que sete interrupções.
4. **No dia 8, o dashboard continua sendo o dashboard.** Não existe modal cobrindo a tela, não existe "paywall" sobre os dados. Os botões de escrita ficam desabilitados e explicam no clique. Os números do cliente continuam na tela dele.
5. **Zero dado apagado**, nunca. `expirada` é permanente e inofensiva (§6).
6. **Reativar é um clique**, e ao reativar tudo volta exatamente como estava — inclusive as pessoas que estavam no espaço.
7. **O teste dá as cotas do nível Família**, para que a experimentação inclua o compartilhamento, que é o argumento de venda do nível 2. Consequência: quem convidou 4 pessoas e depois tenta assinar o Pessoal recebe a recusa do §8.1, que é honesta e é, ela própria, o argumento para o Família.

**Abuso do teste sem cartão.** Sem cartão, um teste novo custa um e-mail novo. Guardas aceitáveis: **um teste por usuário** (não por espaço) e o teto de criação de tenants que a segurança já impôs (A-18). Um segundo espaço criado pela mesma pessoa não ganha teste novo — ele é coberto pela cota `espacos` do plano dela. Guardas que **recusamos**: exigir cartão, exigir documento, impressão digital de dispositivo. A perda por abuso é menor que a perda de conversão de pedir cartão, e essa é uma troca deliberada. Métrica para vigiar: proporção de testes que nunca passam de 5 lançamentos e vêm do mesmo IP.

---

## 8. Downgrade — oito conexões caindo para um plano de três

Regra que governa tudo: **nunca apagar.** Dela decorrem três comportamentos distintos, um por tipo de excesso.

### 8.1 Downgrade voluntário — resolve-se antes

O pedido de downgrade **mostra o excesso e pede a decisão na hora**:

> Você tem **8 conexões bancárias** e o plano Família permite **3**.
> Escolha as 3 que continuam sincronizando. As outras 5 **param de atualizar** — nenhum lançamento é apagado.
> Isso vale a partir de **08/10/2026**, quando o novo plano começa.

O downgrade é **agendado**, não recusado. Sete dias antes da data efetiva, um lembrete. Se a escolha não for feita até lá, aplica-se a regra determinística do §8.3.

Para **pessoas** e **espaços**, o downgrade voluntário abaixo da contagem atual **é recusado no ato**: *"você tem 8 pessoas neste espaço; o Pessoal permite 1. Remova as pessoas antes, ou escolha o Família."* Remover pessoa é decisão do titular, jamais efeito colateral de uma mudança de plano — arrancar o acesso de alguém a um histórico financeiro compartilhado por causa de um evento de cobrança é destrutivo e não tem desfazer social.

### 8.2 Rebaixamento involuntário — tolera, nunca recusa

Falha de pagamento e mudança feita no portal da Stripe chegam por webhook e **não podem ser recusadas** — a mudança já aconteceu do lado do dinheiro. Nesse caminho:

- **Pessoas acima da cota:** ninguém é removido. Todos mantêm acesso pleno. Apenas `POST /convites` passa a devolver `409`, com faixa permanente e visível. *Sim, isso é explorável* — assinar Negócio por um mês, convidar 10 pessoas e cair para Pessoal mantém as 10. Aceitamos: o abuso é raro e o remédio automático (remover pessoas) é pior que a doença. O evento fica em `auditoria`.
- **Espaços acima da cota:** nenhum espaço é fechado. Criar espaço novo é bloqueado.
- **Armazenamento acima da cota:** nenhum arquivo é apagado. Upload novo é bloqueado.
- **Conexões:** §8.3.

### 8.3 Conexões — a única cota com custo nosso por unidade

Conexão ativa é fatura do agregador todo mês (ADR 0003). Manter oito num plano de três nos cobra por cinco. Por isso ela tem regra própria — e, ainda assim, **não destrutiva**:

1. Ficam **ativas** as `N` conexões com **sincronização bem-sucedida mais recente**; empate resolvido por `criado_em` crescente. Determinístico, provável em teste, e explicável ao cliente.
2. As demais vão para **`pausada`**: a sincronização para; **nenhum `Lancamento`, nenhum `LancamentoBruto` e nenhuma `Conta` é apagado** (DP-9). O titular vê quais foram e troca qualquer uma por outra em um toque.
3. **Pausada não é revogada.** A credencial continua cifrada e existindo — e é aí que mora o problema, porque uma credencial que ninguém usa é só um ativo roubável. Por isso: **conexão pausada por mais de 30 dias é revogada**, com avisos no dia 0, 15 e 25. A revogação é a do §10 da política de retenção e do ADR 0019: `crypto-shred` de `dek_cifrada` e `credenciais_cifradas` na mesma transação, remoção dos jobs `sync:${conexao_id}:*`, e chamada de `BankSyncProvider.revogar()`. Os lançamentos já importados **permanecem** (DP-9), e o aviso do dia 25 diz isso com todas as letras.
4. Reativar o plano superior **não ressuscita a conexão revogada** — exige novo consentimento, novo ato do titular, versionado. Nunca reconexão silenciosa (`arquitetura-informacao.md` §2.11).

---

## 9. Modelo de dados

Vocabulário do `CONTEXT.md`. Colunas comuns de toda tabela de negócio conforme `sistema.md` §3: `id`, `tenant_id NOT NULL`, `criado_em`, `atualizado_em`, `deleted_at`. Dinheiro sempre `BIGINT` de centavos + `moeda CHAR(3)`.

### 9.1 Entidades

**`Plano`** — item de catálogo, **em código**, não em tabela. Chave: **`(codigo, intervalo)`** — `codigo` ∈ `pessoal | familia | negocio`, `intervalo` ∈ `mensal | anual`. Campos: `nome`, `preco` (`Money`, declarada, **nunca derivada** — §2.4), `stripe_price_id`, `cotas`, `disponivel_para_compra`, `versao`, `ordem`.

> As `cotas` dependem só do `codigo`; o `intervalo` muda preço e duração do período, jamais o que o plano libera. Um plano anual que desse cotas diferentes do mensal seria um quarto plano com outro nome.

> **Versionamento de preço.** Mudança de preço cria `versao` nova. `Assinatura` guarda `plano_versao` e **mantém o preço da versão que contratou** até uma migração explícita e comunicada. Reajustar silenciosamente quem já é cliente é o caminho mais curto para o estorno.

**`Assinatura`** — uma por `Tenant`. `tenant_id` (único), `plano_codigo`, **`intervalo`** (`mensal | anual`), `plano_versao`, `estado` (`teste | ativa | em_atraso | cancelada | expirada`), `teste_termina_em`, `periodo_inicio`, `periodo_fim`, `cancelada_em`, `cancelamento_efetivo_em`, `stripe_customer_id`, `stripe_subscription_id`, `metodo_ultimos4`, `metodo_marca`, `metodo_expira_em` (mês/ano), `ultimo_evento_em`, `ultimo_evento_id`.

> **Invariantes**
> - Exatamente uma `Assinatura` por `Tenant`, sempre. O espaço nasce com ela, no estado `teste`.
> - `estado = 'teste' ⟹ stripe_subscription_id IS NULL`. O teste não existe na Stripe (§10.2).
> - `periodo_inicio < periodo_fim`, janela **semiaberta** `[inicio, fim)` em `TIMESTAMPTZ`, com as bordas calculadas em `America/Sao_Paulo` — a mesma convenção única do domínio.
> - `teste_termina_em` é fixado na criação e **imutável**. Prorrogar é uma operação nomeada, auditada, nunca um `UPDATE` solto.
> - **Nenhuma coluna de PAN, CVV, nome impresso no cartão ou validade completa.** Veto permanente (`retencao-e-eliminacao.md` §2.2). `metodo_ultimos4` e `metodo_marca` existem para o titular reconhecer o próprio cartão; `metodo_expira_em` existe para o aviso de 15 dias antes do vencimento, que evita a falha de pagamento.
> - `estado` só é escrito pelo processador de eventos (§10.3) ou pelo job do 8º dia. Nenhuma rota de produto o escreve direto.
> - `intervalo = 'anual'` implica `periodo_fim = periodo_inicio + 12 meses`, pela **Ancoragem de dia do mês** (`CONTEXT.md`).
> - O preço contratado é o do par `(plano_codigo, intervalo, plano_versao)` e **não muda dentro de um período já pago** (§6.4).

**`Cobranca`** — uma por fatura da Stripe. `stripe_invoice_id` (único), `valor` (`Money`), **`estado`** (`paga | falhou | anulada`), **`valor_reembolsado`** (`Money`, zero por padrão), `emitida_em`, `paga_em`, `periodo_inicio`, `periodo_fim`, `intervalo`, `documento_fiscal_id` (**reservado e nulo** — não emitimos nota hoje, §11.4.1). **Sobrevive à eliminação do espaço** por obrigação fiscal (§11.5).

#### O reembolso é um segundo eixo, e é **derivado** — nunca um valor do enum

O `arquiteto-dominio-financeiro` apontou a lacuna certa: `paga | falhou | reembolsada` não distingue reembolso integral de parcial, e a fórmula do §6.3 produz parciais o tempo todo — com o anual (DP-19), quem cancela no quinto mês recebe de volta a parte não usada, e isso deixa de ser exceção para virar caminho comum. Sem resolver, **quanto** devolvemos existiria só na Stripe, o que contradiz a §10.1 deste documento.

**Resolução: `reembolsada` sai do enum.** O enum descreve **o que aconteceu com a cobrança**; o reembolso descreve **quanto voltou**. São eixos independentes:

| Eixo | Como existe | Valores |
|---|---|---|
| `estado` | **Persistido** | `paga` · `falhou` · `anulada` |
| `reembolso` | **Derivado** de `valor_reembolsado` e `valor`, **nunca coluna** | `nenhum` (`= 0`) · `parcial` (`0 < r < valor`) · `integral` (`r = valor`) |

É o mesmo mecanismo que o projeto já usa três vezes, e pela mesma razão: `Status de lançamento` derivado de `settled_at`, `Planejamento.natureza` derivada do sinal, `Objetivo.estado` derivado de `concluido_em`. Enum ao lado do número que ele descreve é **estado inválido representável** — `estado = 'reembolsada'` com `valor_reembolsado = 0` seria escrevível, e alguém escreveria.

`anulada` entra porque é real: a Stripe anula fatura na proração de troca de plano, e sem esse valor uma fatura anulada ficaria para sempre como `falhou` — errado num registro que é fiscal.

> **Invariantes**
> - `0 <= valor_reembolsado <= valor`, na mesma moeda. *(declarada pelo `arquiteto-dominio-financeiro`)*
> - **`valor_reembolsado > 0` implica `estado = 'paga'`.** Não se devolve o que nunca entrou. É exatamente a invariante que o enum único não conseguia enunciar.
> - `valor` é imutável depois de emitida. `valor_reembolsado` **é projeção da releitura na Stripe** (§10.4), nunca incrementado por delta do payload de um evento. Um reembolso que falha no provedor simplesmente não aparece — e é isso que mantém a §10.1 verdadeira também para o reembolso, e não só para a cobrança.
> - A UI mostra os dois eixos juntos e nunca só um: *"Paga · R$ 690,00 · reembolsada em parte (R$ 483,00)"*. "Reembolsada" sozinha não é informação — é metade dela.
> - Quando a emissão fiscal existir (§11.4.1), `valor_reembolsado > 0` exigirá nota de cancelamento ou substitutiva. Registrado agora para que a decisão futura não descubra o caso tarde.

**`EventoDeCobranca`** — o livro de idempotência do webhook. `id` = `event.id` da Stripe (**chave primária** — é o mecanismo inteiro), `tipo`, `recebido_em`, `processado_em`, `tentativas`, `resultado`, `evento_criado_em`.

> **Exceção de tenancy, declarada.** O evento chega **antes** de sabermos o tenant. Por isso `eventos_cobranca` **não tem `tenant_id`** e vive fora da RLS, como `outbox_pendencias` e a view `tenants_ativos` (`sistema.md` §3). Para que a exceção seja segura, a tabela **não contém dado pessoal**: só id, tipo, horários e resultado — nunca o payload da Stripe, nunca e-mail, nunca valor. O efeito do evento é aplicado numa segunda transação, com `SET LOCAL app.tenant_id`, sob RLS. *Uma exceção escrita é auditável; uma exceção implícita não é.*

**`DadosFiscais`** — `tenant_id` (PK), `documento`, `tipo_documento` (`cpf | cnpj`), `nome_fiscal` (só para CNPJ), `criado_em`, `atualizado_em`. Tabela **própria**, nunca colunas em `usuarios` ou `assinaturas` (§11.4.3). Escrita só no checkout; leitura só por `proprietario`. Fora da allowlist de toda resposta que não seja a tela de cobrança, junto dos sete campos da regra R-5 da matriz de acesso.

> **Invariantes**
> - Só existe se houver ou tiver havido `Assinatura` fora do estado `teste`. Nenhum caminho a cria durante o teste.
> - `tipo_documento = 'cnpj' ⟹ nome_fiscal IS NOT NULL`.
> - `documento` valida por dígito verificador, **sem nenhuma consulta externa**.
> - Nunca é chave de nada, nunca indexa busca, nunca aparece em URL (§11.4.4).

**`ListaDeEspera`** (§1.3) — `email`, `instituicao_desejada`, `faixa_disposicao`, `consentimento_versao`, `criado_em`, `avisado_em`, `descadastrado_em`. Sem `tenant_id`: é gente que ainda não é cliente. Base legal **consentimento** (§11.6).

### 9.2 O que entra no glossário — e uma colisão a resolver antes

Termos novos para `CONTEXT.md`: **`Assinatura`**, **`Plano`**, **`Intervalo`** (`mensal | anual`), **`Cota`**, **`Cobranca`**, **`DadosFiscais`**, **`EventoDeCobranca`**, **`ListaDeEspera`**, e os cinco valores de `estado`.

Três decisões de nome, para o `arquiteto-dominio-financeiro`:

1. **`Cota`, nunca `Limite`.** `Limite` é termo proibido pelo `CONTEXT.md`, aposentado em favor de `Planejamento`. Cota de plano e teto de gasto não podem dividir palavra.
2. **Colisão `Plano` × `Planejamento` — resolvida.** O `Planejamento` usava o campo derivado `dentro_do_plano`, e "plano" passaria a significar duas coisas no mesmo produto — a ambiguidade que matou `effective_at`. O `arquiteto-dominio-financeiro` renomeou **`dentro_do_plano` para `dentro_do_planejado`** e, junto, **`no_limite` para `no_planejado`**, que tinha o mesmo problema diante de `Cota`. `tenants.plano` passa a referenciar `Plano.codigo`.
3. **`Cobranca`, nunca "fatura".** `Fatura` é o ciclo do `Cartao` e não empresta o nome para mais nada. A fatura da Stripe é `Cobranca` em todo lugar — código, API e UI.

Termos proibidos a acrescentar à tabela do `CONTEXT.md`:

| Não use | Use | Por quê |
|---|---|---|
| `Limite` do plano | `Cota` | `Limite` está aposentado em favor de `Planejamento`; reusá-lo colide com teto de gasto |
| "fatura da assinatura" | `Cobranca` | `Fatura` é o ciclo do cartão do usuário. Dois significados para a palavra que carrega o erro clássico da categoria |
| `dentro_do_plano` | `dentro_do_planejado` | Com `Plano` comercial no modelo, "plano" passa a ter dois donos. Renomeado |
| `no_limite` | `no_planejado` | Mesmo problema diante de `Cota`: "limite" passaria a ter dois donos. Renomeado |
| `estado = 'reembolsada'` | `estado` + `valor_reembolsado`, derivando `nenhum` / `parcial` / `integral` | Enum ao lado do número que ele descreve é estado inválido representável |
| `trial` | `teste` | Um idioma por conceito |
| `subscription.status` da Stripe como estado do produto | `Assinatura.estado` | Fonte de verdade única (§10.1). O estado deles descreve dinheiro; o nosso descreve direito de uso |
| número de cartão em qualquer coluna | — | Veto permanente. Não existe campo, em nenhuma tabela, em nenhum épico |

---

## 10. Stripe — fronteira, webhooks e idempotência

### 10.1 Quem é fonte de verdade de quê

> **A Stripe é a fonte de verdade do pagamento. A Mavia é a fonte de verdade do direito de uso.**
>
> `Assinatura.estado` **nunca** é consultado na Stripe em tempo de requisição, e **nunca** é escrito por nada além do processador de eventos. Toda decisão de permissão lê a nossa linha; toda mudança de dinheiro nasce lá e chega por webhook.

Por que precisa ser de um lado só: se os dois lados escrevem, um webhook fora de ordem somado a uma ação de tela produz um estado que nenhum dos dois consegue explicar, e o cliente vê *"paguei e continuo bloqueado"* — a pior frase que um produto de cobrança pode produzir. Com a divisão acima, cada pergunta tem exatamente um dono, e a divergência entre eles é detectável (§10.5) em vez de ser um mistério.

| Fica com a Stripe | Fica com a Mavia |
|---|---|
| Dado de cartão (PAN, CVV, validade). **Nunca tocamos** — Checkout hospedado, e por isso não entramos no escopo PCI-DSS | `Assinatura.estado` e `plano_codigo`: o que este espaço pode fazer agora |
| Meios de pagamento, 3DS/SCA, antifraude | As `Cota`s e sua verificação (código, S1) |
| A proração aritmética na troca de plano | A **fórmula de reembolso** do §6.3, que é nossa e não usa divisão |
| Retentativa de cobrança e calendário de cobrança | Os prazos de graça, o teste de 7 dias e a máquina de estados |
| Fatura hospedada, recibo, portal do cliente (trocar cartão, cancelar) | O texto de tudo que o cliente lê dentro do produto |
| O registro autoritativo do que foi cobrado, quando e se deu certo | O registro autoritativo do que o cliente pode ver e escrever |

### 10.2 O teste de 7 dias não existe na Stripe

Sem cartão não há `Customer`, não há `Subscription`, não há nada a criar. O teste é inteiramente nosso: `estado = 'teste'` + `teste_termina_em`, e um job diário que expira. A assinatura na Stripe nasce **no clique de assinar**, nunca antes.

Consequências: não usamos `customer.subscription.trial_will_end`; os avisos de D-3/D-1/D0 são nossos; e — o que mais importa — **durante o teste a Mavia não envia nenhum dado pessoal para a Stripe** (§11.3).

### 10.3 Os webhooks que importam

Assinamos o mínimo. Cada evento a mais é uma superfície a mais a testar.

| Evento | O que faz |
|---|---|
| `checkout.session.completed` | Liga `Customer` ↔ `Tenant` pelo `client_reference_id`. É o único evento que estabelece o vínculo |
| `customer.subscription.created` · `.updated` · `.deleted` | Portador do estado: `status`, `cancel_at_period_end`, `current_period_end`, e o `price` → `plano_codigo` |
| `invoice.paid` | Estende o período e grava a `Cobranca` |
| `invoice.payment_failed` | Entra em `em_atraso` e dispara a régua de avisos |
| `charge.refunded` | **Reprojeta `Cobranca.valor_reembolsado`** pela releitura, e com ele o eixo derivado `reembolso`. Existe porque um reembolso feito à mão no painel da Stripe também precisa chegar até nós — sem ele, o nosso registro diverge do dinheiro, e num reembolso parcial nem saberíamos de quanto |

**Ignorados de propósito:** tudo o mais. Um evento não assinado é um caminho de código que não existe.

### 10.4 Idempotência — os dois lados, e é aqui que a cobrança duplica

**Entrada (webhook).** A Stripe entrega **pelo menos uma vez** e **fora de ordem**. Quatro camadas, nesta ordem:

1. **Assinatura HMAC verificada sobre o corpo cru**, antes de qualquer parse, com tolerância de 5 minutos. Armadilha concreta a evitar: o Nest/Fastify não pode consumir e reserializar o corpo desta rota — a verificação precisa do byte original. Corpo inválido → `400`, nada escrito, nada revelado.
2. **Reivindicação da linha:** `INSERT INTO eventos_cobranca (id, …) … ON CONFLICT DO NOTHING RETURNING id`. Só processa quem reivindicou. É o **mesmo padrão do `outbox`** (`sistema.md` §5.1) — nenhum mecanismo novo.
3. **Ordem irrelevante por construção:** o processador **não aplica o payload do evento**. Ele **relê a assinatura na API da Stripe** e projeta o estado corrente. Um evento atrasado que chega depois busca o objeto atual e escreve a mesma coisa. Segunda camada: `ultimo_evento_em` guarda o `created` do evento, e um evento mais antigo que o último aplicado não regride o estado.
4. **Resposta `2xx` assim que o evento está gravado**, com o trabalho num job. Trabalho lento dentro do handler estoura o tempo da Stripe, que retenta — e retentativa somada a trabalho parcial é exatamente como se cobra duas vezes.

**Saída (nossas chamadas).** Toda chamada mutante leva `Idempotency-Key` **determinística e derivada do domínio** — `assinatura:${tenant_id}:${acao}:${plano_codigo}:${intervalo}:${plano_versao}` para criação e troca, `cobranca:${stripe_invoice_id}:reembolso` para reembolso —, **nunca** um UUID novo por tentativa: uma chave aleatória por tentativa não impede nada, e é o defeito clássico. O `intervalo` entra na chave porque assinar mensal e depois anual no mesmo minuto são duas intenções distintas e a chave não pode colapsá-las. O botão "Assinar" segue a mesma regra do critério F8: toque duplo cria **uma** assinatura, e **reembolsar duas vezes é tão grave quanto cobrar duas vezes**.

**A rota do webhook é pública e assinada.** Ela é exceção declarada ao guard "nega por padrão" (`sistema.md` §4.0): declarada no manifesto como `publica-assinada`, para continuar aparecendo no teste que percorre as rotas. Com limite de taxa próprio, e sem revelar em nenhuma resposta se um `Customer` existe.

### 10.5 Reconciliação e a saída de emergência

- **Job diário** compara `assinaturas` com as assinaturas alteradas na Stripe desde a última execução. **Divergência é incidente**, não warning — mesma linguagem de `saldo.reconciliar`. A correção segue a Stripe (fonte do dinheiro), grava em `auditoria`, e, quando **reduz** acesso, avisa o `proprietario` por e-mail com o motivo antes de valer.
- **Botão "já paguei"** na tela de cobrança: força uma releitura na Stripe, com limite de taxa. Existe porque webhook cai, e sem ele o cliente que pagou fica preso esperando um evento — e liga para o suporte com razão.

---

## 11. LGPD — dado de pagamento é dado pessoal

### 11.1 Mapa de dados da feature

| Classe | Finalidade (uma frase) | Base legal | Onde vive | Prazo | No vencimento |
|---|---|---|---|---|---|
| `assinaturas.stripe_customer_id`, `stripe_subscription_id` | Ligar este espaço à assinatura no provedor de pagamento | Execução de contrato (7º V) | Nosso banco | Vida da assinatura | `apagar` com o espaço |
| `assinaturas.metodo_ultimos4`, `metodo_marca` | Permitir que o titular reconheça qual cartão está pagando | Execução de contrato | Nosso banco | Até a troca de cartão ou o cancelamento | `apagar` |
| `assinaturas.metodo_expira_em` | Avisar 15 dias antes de o cartão vencer, evitando a falha de pagamento | Legítimo interesse (7º IX) — interesse do próprio titular em não perder o serviço | Nosso banco | Idem | `apagar` |
| `cobrancas` (valor, datas, estado, `stripe_invoice_id`) | Provar o que foi cobrado e sustentar a escrituração fiscal | **Obrigação legal** (7º II) | Nosso banco | **5 anos** de 1º/jan do ano seguinte à cobrança (CTN art. 173 I) | `apagar` |
| `dados_fiscais.documento` (CPF ou CNPJ) e `nome_fiscal` | Emitir a nota fiscal do serviço contratado | **Obrigação legal** (7º II) | Nosso banco, tabela própria | Enquanto houver `Cobranca` do tenant dentro do prazo acima | `apagar` a linha. Quatro vetos de uso secundário em §11.4.4 |
| `eventos_cobranca` | Garantir que um evento repetido não cobre nem altere duas vezes, e permitir apurar uma disputa | Legítimo interesse (7º IX) | Nosso banco, **sem dado pessoal** | **12 meses** | `apagar` |
| `lista_espera.email` | Avisar uma única vez quando a conexão bancária existir | **Consentimento** (7º I) | Nosso banco | Até o aviso + 30 dias, ou descadastro imediato | `apagar` |
| E-mail e nome enviados à Stripe | Emitir recibo e permitir que o titular gerencie o próprio pagamento | Execução de contrato | **Stripe** (§11.3) | Retenção da Stripe, declarada na política | — |

### 11.2 O que deliberadamente **não** guardamos

Reafirma e estende `retencao-e-eliminacao.md` §2.2:

- **PAN, CVV, validade completa, nome impresso, endereço de cobrança do cartão.** Nenhuma coluna, em nenhuma tabela, em nenhum épico. Checkout hospedado pela Stripe: o dado do cartão **nunca transita pelo nosso servidor**, o que nos mantém fora do escopo PCI-DSS por desenho, não por promessa.
- **Nada durante o teste.** Sete dias de produto inteiro sem que uma única informação de pagamento exista — nossa ou da Stripe. É consequência do §10.2 e é afirmável ao cliente.
- **Nenhum dado financeiro do espaço vai para a Stripe.** Nem saldo, nem lançamento, nem descrição, nem nome de conta. Nem como metadado, nem como "contexto". A Stripe recebe o mínimo do §11.3 e nada além.

### 11.3 A Stripe — o que ela vê, e em que papel

Recebe: e-mail, nome (opcional), o `tenant_id` como referência opaca, o `price_id`, e o dado de cartão que o titular digita direto nela.

**Duplo papel, declarado com honestidade:** a Stripe é **operadora** para a finalidade que contratamos — processar o pagamento sob nossas instruções — e **controladora independente** para as obrigações regulatórias dela (prevenção a fraude, KYC, retenção fiscal na jurisdição dela). Chamá-la só de operadora seria simplificação conveniente e errada.

Requisitos bloqueantes, antes da primeira cobrança real:

1. **DPA da Stripe assinado e arquivado**, com as cláusulas-padrão de transferência internacional (**art. 33**) — o processamento ocorre fora do Brasil, e isso é fato, não hipótese.
2. **`docs/compliance/subprocessadores.md` criado**, listando a Stripe, o que ela recebe, para quê e onde processa. O arquivo é prometido em `retencao-e-eliminacao.md` §9.3 e ainda não existe; a cobrança é o que o torna obrigatório.
3. **Política de privacidade** nomeando a Stripe, a transferência internacional e a retenção fiscal de 5 anos, em português claro, na tela "Dados e privacidade" — não enterrado nos termos.
4. **Nenhum dado financeiro do espaço** no payload, conforme §11.2.

### 11.4 DP-16 — nota fiscal, e a decisão sobre CPF/CNPJ

#### 11.4.1 O que o dono decidiu

**Sem emissão automática de nota fiscal no lançamento.** Nenhuma integração fiscal entra no épico 11: o produto não emite NFS-e, não chama provedor fiscal, não guarda número de nota. `Cobranca.documento_fiscal_id` fica declarado e **nulo**, reservado.

**Desenho futuro, registrado como comentário e não como implementação:** a intenção do dono é emitir **por conta própria, junto à prefeitura de Salvador (BA)**. Quando isso for feito, três coisas precisam ser verificadas *naquele momento*, com a contabilidade, e não agora: qual sistema municipal está vigente (o padrão nacional de NFS-e vem absorvendo os municipais, e Salvador pode já estar migrada quando a hora chegar), quais campos do tomador são exigidos, e se o endereço entra. **Nada disso é decidido aqui, e nenhuma linha de código de emissão nasce agora.**

Uma frase que não é minha para resolver, e que registro por dever: a obrigação de emitir nasce com a prestação do serviço, não com a decisão de automatizá-la. O intervalo entre a primeira venda e a primeira nota é assunto do dono com a contabilidade dele. **O que é meu é garantir que o dado necessário exista quando a hora chegar — e essa é exatamente a pergunta do §11.4.2.**

#### 11.4.2 A pergunta: coletar CPF/CNPJ no checkout mesmo sem emitir?

**Recomendo coletar. Um campo, obrigatório, no checkout.**

O argumento não é sobre qual lado é mais nobre — os dois são reais. É sobre **qual erro tem volta**:

| Se coletarmos e não precisarmos | Se não coletarmos e precisarmos |
|---|---|
| Apagamos uma coluna e uma tabela, executamos o descarte, gravamos em `retencao_execucoes` e acabou. **Custo baixo e reversível em um deploy.** | Temos de pedir documento a quem já é cliente. Baixa taxa de resposta, contato constrangedor ("preciso do seu CPF para uma nota de um serviço que você já pagou"), e **quem cancelou antes do pedido é inalcançável para sempre** — vendas que nunca poderão ser documentadas direito. **Custo alto, crescente com a base, e irreversível.** |

Assimetria decide. O atrito de um campo num checkout brasileiro — onde CPF é esperado, não estranhado — é o preço mais barato disponível para eliminar um retrabalho que só piora com o tempo.

**As duas consequências, escritas:**

**Consequência 1 — o que assumimos ao coletar.** Passamos a guardar um identificador nacional único, que é o dado de correlação por excelência: ele liga a pessoa a qualquer outra base do país. Isso muda o perfil de risco de um vazamento nosso, e por isso vem com os vetos do §11.4.4 e com a exigência de que a §2.2 da política de retenção seja **corrigida por escrito**, e não fique se contradizendo. Um documento normativo que promete não coletar o que o produto coleta é pior do que não ter documento: ele torna todo o resto suspeito.

**Consequência 2 — o que evitamos.** A dívida fiscal retroativa. A partir da primeira venda, cada mês sem o documento é um mês de cobranças que, quando a emissão começar, exigirão uma campanha de coleta com resposta parcial. Coletar agora custa um campo; coletar depois custa a base inteira, e nunca fecha em 100%.

#### 11.4.3 Como fica, exatamente

| Item | Decisão |
|---|---|
| **Obrigatório ou opcional** | **Obrigatório**, um campo só ("CPF ou CNPJ"), tipo inferido pelo comprimento. Opcional seria o pior dos mundos: o custo de LGPD por inteiro e metade do benefício, porque a metade não preenchida é exatamente a campanha retroativa que queríamos evitar |
| **Quando** | **Só no checkout**, só de quem assina. **Nunca durante o teste** — sete dias de produto inteiro sem pedir documento continuam verdadeiros (§11.2) |
| **Onde** | Tabela própria, **`dados_fiscais`** (`tenant_id` PK, `documento`, `tipo_documento`, `nome_fiscal`), nunca em `usuarios` nem em `assinaturas`. Separar permite allowlist de resposta trivial, restrição por coluna, e apagamento em bloco se a decisão mudar |
| **Nome** | `nome_fiscal` só é pedido quando o documento é **CNPJ** (razão social). Para CPF, o nome que já temos serve |
| **Endereço** | **Não coletamos.** A promessa da §2.2 sobre endereço permanece intacta. Se a emissão o exigir, é decisão nova com ADR — não se antecipa coleta "por precaução" |
| **Validação** | Dígito verificador, que é aritmética local. **Nunca consulta à Receita Federal, Serpro ou qualquer enriquecimento** — isso seria transferência a terceiro e coleta de dado que não pedimos |
| **Base legal** | **Obrigação legal** (art. 7º II). A obrigação de emitir nasce com a venda; o documento do tomador é elemento necessário dela. A execução diferida não apaga a obrigação — e se o dono decidir **nunca** emitir, a base desaparece e **o dado é apagado junto** (§11.4.5) |
| **Retenção** | **5 anos contados de 1º de janeiro do ano seguinte ao da `Cobranca`** — o prazo decadencial do CTN art. 173 I, e não um "5 anos" solto sem gatilho. `dados_fiscais` é apagada quando não houver nenhuma `Cobranca` do tenant dentro do prazo |

#### 11.4.4 Os quatro vetos que tornam a coleta defensável

O que a ANPD ataca não é a coleta de CPF para obrigação fiscal — é o CPF virando identificador de uso geral. Portanto, e isso é normativo:

1. **Nunca é identificador.** Não serve para login, não é chave, não aparece em URL, não indexa nada.
2. **Nunca é antifraude.** Não é usado para detectar teste repetido, conta duplicada ou abuso (§7). A guarda de abuso continua sendo "um teste por usuário", e nada mais.
3. **Nunca é enriquecido nem consultado** em base externa, pública ou paga.
4. **Nunca sai:** não vai em log, métrica, notificação, push, e-mail, resposta de API para não-`proprietario`, nem exportação de outro membro. Entra na mesma lista de campos proibidos em resposta da regra R-5 da matriz de acesso.

Qualquer uso fora da emissão fiscal é **finalidade nova** e exige decisão própria. Não há "aproveitando que já temos".

#### 11.4.5 A saída, se a decisão mudar

Se o dono decidir definitivamente não emitir nota: `dados_fiscais` é apagada por inteiro — `DELETE` físico da tabela sob o papel `mavia_retencao` —, a entrada some da política de retenção, e a §2.2 volta ao texto original. Uma entrada em `retencao_execucoes` prova que aconteceu. **Esta saída existe por escrito justamente para que a coleta não vire permanente por inércia.**

#### 11.4.6 Texto no checkout

> **CPF ou CNPJ**
> Precisamos dele para emitir a nota fiscal do seu pagamento. Usamos **só para isso** — nunca para identificar você, nunca para consultar seus dados em outro lugar, e nunca compartilhamos.

### 11.5 Efeito nos fluxos de exportação e eliminação

**Exportação** (`retencao-e-eliminacao.md` §6.1). `assinatura` e `cobrancas` entram em `zEscopoExportacao`. Não é opcional: o teste S2 que percorre o schema Drizzle **quebra o build** se uma tabela de negócio ficar fora dos dois fluxos. `eventos_cobranca` fica de fora com justificativa declarada — não contém dado pessoal. `stripe_customer_id` **sai**: é a referência do titular na Stripe e ele tem direito a ela. `metodo_ultimos4` e o documento fiscal saem **apenas para o `proprietario`**, nunca para outros membros do espaço.

**Eliminação do espaço** (§5.3 daquela política). `DELETE /tenants/:id` passa a fazer, além do que já faz:

1. **Cancelar a assinatura na Stripe imediatamente** — antes de qualquer apagamento. Continuar cobrando alguém cujos dados apagamos é, ao mesmo tempo, escândalo de cobrança e problema de dado.
2. **Apagar o `Customer` na Stripe.** Ela retém o que a lei dela exige; isso é limite conhecido e vai declarado na política.
3. **`assinaturas`** e **`eventos_cobranca`** daquele tenant: apagados.
4. **`cobrancas` e `dados_fiscais` sobrevivem 5 anos**, por obrigação legal. Isso já está previsto na §3.6, e este documento nomeia as tabelas. **É o único lugar onde nome e documento do titular sobrevivem à eliminação** — e por isso precisa estar escrito em português claro na tela "Dados e privacidade", não só nos termos. Uma promessa de eliminação com exceção não declarada é uma promessa falsa.

**Eliminação do titular** (`DELETE /auth/eu`). Se ele é o único `proprietario` de um espaço com assinatura ativa, vale o bloqueio que já existe (§5.2), acrescido da consequência de cobrança: *"este espaço tem assinatura ativa; cancele ou transfira a propriedade antes."* Ninguém sai deixando uma cobrança órfã rodando.

### 11.6 Texto de consentimento da lista de espera — v1

Pessoa que ainda não é cliente, dando e-mail para uma finalidade futura. Base **consentimento**: específico, revogável em um clique, e sem uso secundário.

> **Avise-me quando a conexão bancária chegar**
>
> A Mavia ainda **não** conecta automaticamente ao seu banco. Hoje você traz seus lançamentos por arquivo (OFX/CSV) ou lançando à mão.
>
> Se você deixar seu e-mail, nós o usamos para **uma coisa só**: avisar quando a conexão bancária existir. Nada de newsletter, nada de promoção, e não repassamos seu e-mail a ninguém.
>
> Você sai da lista em um clique, em qualquer e-mail que enviarmos. Quando a função chegar e você for avisado, apagamos seu e-mail em 30 dias se você não virar cliente.

O `descadastrado_em` apaga a linha na hora. Reaproveitar essa lista para qualquer outra comunicação é **vetado**.

---

## 12. Critérios de aceite

Verificáveis por quem não participou desta conversa. Seams conforme `sistema.md` §2.1.

### Catálogo e cotas

| # | Critério | Seam |
|---|---|---|
| P1 | `limitesDoPlano('pessoal').pessoas === 1`, `('familia').pessoas === 5`, `('negocio').espacos === 3`. Todo preço é `Money` em `BRL`; nenhum `number` monetário no módulo `billing` | S1 |
| P2 | Um teste falha se um par `(codigo, intervalo)` do catálogo não tiver `stripe_price_id` mapeado no ambiente, ou se um `price_id` do ambiente não estiver no catálogo. São **seis** pares: três planos × dois intervalos | S1 + S2 |
| P3 | Com 5 pessoas no espaço e plano Família, `POST /convites` devolve `409` com código `cota_do_plano`, nomeando recurso, cota (`5`), contagem atual (`5`) e as duas saídas. **No mesmo teste**, `POST /lancamentos` devolve `201` — nenhum outro recurso degrada | S2 |
| P4 | Convite pendente conta na cota: com 4 aceitos e 1 pendente no Família, o 6º convite é recusado | S2 |
| P5 | Acima da cota (por rebaixamento), nenhuma linha é apagada em nenhuma tabela: contagens antes e depois idênticas para `lancamentos`, `contas`, `cartoes`, `anexos`, `tenant_usuarios` | S2 |

### Ciclo de vida

| # | Critério | Seam |
|---|---|---|
| P6 | Espaço criado nasce com exatamente uma `Assinatura` em `teste`, `teste_termina_em = criado_em + 7 dias` calculado em `America/Sao_Paulo`, e cotas do Família | S2 |
| P7 | No 8º dia sem assinatura: todo `GET` responde `200`; toda rota mutante responde `402` com explicação; **`POST /exportacoes` responde `202`** | S2 |
| P8 | Em `em_atraso`, `POST /lancamentos` responde `201`. A degradação só ocorre ao fim dos 14 dias | S2 |
| P9 | Em `cancelada` com `periodo_fim` no futuro, escrita continua funcionando; no instante de `periodo_fim`, e não antes, o estado vira `expirada` | S2 |
| P10 | Nenhum caminho de código cria assinatura na Stripe sem uma sessão de checkout iniciada pelo usuário. Provado pelo dublê: zero chamadas de criação em todo o fluxo de teste | S2 |
| P11 | Avisos de fim de teste são enviados em D-3, D-1 e D0, uma vez cada, com a data absoluta no corpo. Rodar o job duas vezes no mesmo dia envia **um** | S2 |
| P12 | Reativar um espaço `expirada` restaura escrita e todos os membros, sem perder nenhum registro | S2 |

### Anual: preço, reembolso e renovação

| # | Critério | Seam |
|---|---|---|
| P12a | O preço anual vem **declarado** do catálogo. Um teste falha se qualquer preço anual for igual a uma multiplicação calculada em tempo de execução a partir do mensal, e afirma os três valores literais: `35000`, `45000`, `69000` centavos | S1 |
| P12b | `reembolso(valor_pago, meses_iniciados, preco_mensal)` é property-based: o resultado **nunca é negativo**, **nunca excede `valor_pago`**, e é monótono não-crescente em `meses_iniciados`. **Nenhuma divisão** aparece na implementação | S1 |
| P12c | Caso concreto: Negócio anual (`69000`), cancelado com 3 meses iniciados → reembolso de `48300` centavos, ao centavo | S1 |
| P12d | Cancelamento dentro de 7 dias devolve **o valor integral**, e não o resultado da fórmula | S1 + S2 |
| P12e | `meses_iniciados` de um período que começa em 31/01 conta 28/02 e 31/03 como meses 1 e 2, sem arrastar o ajuste | S1 |
| P12f | Renovação anual sem os avisos de D-30 e D-7 registrados como enviados **não cobra**: o job adia e alerta o operador | S2 |
| P12g | O aviso de D-30 contém data exata, valor exato, marca e últimos 4 do cartão, e um link de cancelamento que resolve em um passo | S2 |
| P12h | Reajuste de preço anunciado a menos de 30 dias da renovação: a renovação sai **no preço antigo** | S2 |
| P12i | Upgrade mensal → anual no meio do mês gera crédito de proração e **nenhuma cobrança retroativa** (asserção sobre o dublê) | S2 |
| P12j | Reembolsar a mesma `Cobranca` duas vezes produz **um** reembolso na Stripe (mesma `Idempotency-Key`) | S2 |
| P12k | `reembolso` é **derivado**: não existe coluna com esse nome no schema, e um teste percorre a tabela para provar. Com `valor = 69000` e `valor_reembolsado = 48300`, a derivação dá `parcial`; com `69000`, `integral`; com `0`, `nenhum` | S1 + S2 |
| P12l | Gravar `valor_reembolsado > 0` numa `Cobranca` com `estado <> 'paga'` é **rejeitado** pelo banco, não por `if` na aplicação | S2 |
| P12m | Após um reembolso parcial, `Cobranca.valor_reembolsado` é igual ao que a Stripe reporta na releitura, e não à soma dos deltas dos eventos recebidos — provado entregando o mesmo evento duas vezes e um evento fora de ordem | S2 |

### Stripe

| # | Critério | Seam |
|---|---|---|
| P13 | O **mesmo `event.id`** entregue duas vezes produz: uma transição de estado, uma linha em `cobrancas`, uma entrada em `auditoria` | S2 |
| P14 | Dois eventos de assinatura entregues **fora de ordem** deixam `Assinatura.estado` igual ao objeto corrente da Stripe | S2 |
| P15 | Webhook com assinatura HMAC inválida ou ausente: `400`, zero escritas, e a resposta não revela se o `Customer` existe | S2 |
| P16 | Duas tentativas de assinar em sequência usam a **mesma** `Idempotency-Key` e produzem **uma** assinatura na Stripe (asserção sobre o dublê) | S2 |
| P17 | O corpo cru chega intacto ao verificador de assinatura — um teste envia payload com espaçamento não canônico e a verificação passa | S2 |
| P18 | O job de reconciliação detecta uma divergência plantada, grava em `auditoria` e, quando a correção reduz acesso, envia o aviso antes de aplicar | S2 |

### Downgrade e conexões

| # | Critério | Seam |
|---|---|---|
| P19 | Downgrade voluntário para plano com menos pessoas que a contagem atual: `409`, o plano **não** muda, e a mensagem nomeia a contagem | S2 |
| P20 | Rebaixamento involuntário com 8 conexões para cota 3: exatamente 3 ficam `ativa` e 5 `pausada`, pela regra determinística; zero `Lancamento`, `LancamentoBruto` e `Conta` apagados | S2 |
| P21 | Conexão `pausada` há 31 dias: `status = 'revogada'`, `dek_cifrada IS NULL`, `credenciais_cifradas IS NULL`, `BankSyncProvider.revogar()` chamado, nenhum job `sync:${conexao_id}:*` na fila, e a contagem de `lancamentos` inalterada | S2 + S3 |

### LGPD

| # | Critério | Seam |
|---|---|---|
| P22 | Nenhuma resposta de API, log, métrica, notificação ou exportação contém PAN, CVV ou validade completa. Teste de propriedade sobre a allowlist de resposta | S1 + S2 + S4 |
| P23 | A exportação do espaço inclui `assinatura` e `cobrancas`; o teste que percorre o schema **falha** se uma tabela de cobrança ficar fora da exportação **ou** da política de retenção | S2 |
| P24 | `DELETE /tenants/:id` cancela a assinatura e apaga o `Customer` na Stripe (asserção sobre o dublê) **antes** de apagar linha alguma; `cobrancas` sobrevive; nenhuma outra linha daquele `tenant_id` sobrevive | S2 |
| P25 | `eventos_cobranca` não contém e-mail, nome, valor nem payload da Stripe. Teste sobre as colunas da tabela | S2 |
| P26 | Um `membro` recebe `403` em toda rota de cobrança, e sua exportação não contém `metodo_ultimos4` nem documento fiscal | S2 |
| P27 | Descadastro da lista de espera apaga a linha fisicamente e o e-mail não é mais alcançável por nenhuma consulta | S2 |
| P28 | Nenhum caminho cria `dados_fiscais` durante o estado `teste`. Sete dias inteiros de uso, e a tabela continua vazia | S2 |
| P29 | `documento` não aparece em nenhum log, métrica, notificação, e-mail, resposta a `membro`/`visualizador`, nem na exportação de outro membro. Teste de propriedade sobre a allowlist de resposta e sobre o serializador de log | S1 + S2 + S4 |
| P30 | `documento` não é aceito como parâmetro de busca em nenhuma rota, e não existe índice sobre ele. Teste percorre o schema e o manifesto de rotas | S2 |
| P31 | A validação do documento **não faz nenhuma chamada de rede**: o processo de teste roda sem rede, como em R-16 | S1 |
| P32 | `dados_fiscais` de um tenant sem nenhuma `Cobranca` dentro do prazo do CTN é apagada pelo job de retenção; com uma `Cobranca` dentro do prazo, sobrevive | S2 |

---

## 13. Riscos de produto

Onde o cliente desiste, se irrita ou pede reembolso — em ordem de gravidade.

| Risco | Onde | Mitigação |
|---|---|---|
| **O 8º dia** — o cliente experimentou, gostou, e no dia seguinte encontra o produto trancado sem ter entendido que ia acontecer | Fim do teste | Data absoluta desde o dia 1; três avisos; dashboard preservado; leitura e exportação permanentes; zero cobrança sem cartão (§7) |
| **A comparação com o Organizze nos níveis 2 e 3** — mesmo preço, sem conexão bancária | Página de preços | Vender o que entregamos (pessoas e espaços), nunca listar a conexão como entregue, e prometer que ela entra sem aumento de preço (§1.2) |
| **Webhook perdido** — o cliente pagou e continua bloqueado | Após o pagamento | Reconciliação diária + botão "já paguei" que força a releitura (§10.5) |
| **Cobrança duplicada** | Assinar, retentativa de webhook | Reivindicação por `event.id`, releitura em vez de aplicação de payload, `Idempotency-Key` determinística, proteção de toque duplo (§10.4) |
| **Cartão vencido derruba a sincronização bancária** — "meu banco parou e eu não sabia" | `em_atraso` → conexões pausadas | Aviso 15 dias antes do vencimento do cartão; 14 dias de produto inteiro em atraso; avisos em D0/D15/D25 antes de revogar (§8.3) |
| **Downgrade que destrói um espaço familiar** | Mudança de plano | Recusa no ato para pessoas e espaços; pausa reversível e determinística para conexões; nunca remoção automática de gente (§8) |
| **Cancelar entendido como apagar (ou o contrário)** | Cancelamento | Duas telas, dois textos, e o texto normativo do §6.5. A eliminação nunca é oferecida como passo do cancelamento |
| **Abuso do teste sem cartão** | Cadastro | Um teste por usuário + teto de criação de tenants. Troca deliberada: conversão vale mais que o abuso. Métrica vigiada (§7) |
| **Sensação de refém** — "se eu parar de pagar, perco meu histórico" | Decisão de assinar | `expirada` é leitura completa e permanente; exportação funciona sempre; e isso é dito **na página de preços**, porque é diferencial real |
| **Preço reajustado sem aviso** | Renovação | Versão de plano congelada na assinatura; migração exige comunicação explícita (§9.1) |
| **Nota fiscal ausente** — cliente PJ não consegue lançar a despesa e pede o cancelamento | Primeira cobrança PJ | Decidido não emitir agora (DP-16). O documento é coletado desde a primeira venda (§11.4), de modo que a emissão futura não precise de campanha retroativa. Risco residual assumido pelo dono |
| **Atrito do campo de CPF no checkout** | Checkout | Um campo, com a razão escrita ao lado (§11.4.6). Medir a queda de conversão na etapa; se for material, é decisão nova, não ajuste silencioso |
| **Renovação anual esquecida** — R$ 690 num cartão doze meses depois | Renovação | Avisos obrigatórios em D-30 e D-7 com valor, data e cancelamento em um clique; renovação **adiada** se o aviso falhar (§6.4) |
| **Estorno de valor anual** — muito mais danoso à conta na Stripe que um de R$ 35 | Anual | Reembolso proporcional sem perguntar motivo (§6.3) remove o motivo de estornar; avisos de renovação removem a surpresa |
| **Membro descobre o cartão do proprietário** | Espaço compartilhado | `billing` é exclusivo de `proprietario` (`matriz-de-acesso.md` §2.3); critério P26 |

---

## 14. 🔺 Decisões do dono do produto

Onde a decisão não é minha. Cada uma tem padrão, e o padrão vale enquanto não houver escolha.

| # | Pergunta | Padrão proposto |
|---|---|---|
| **DP-16** ✅ | Emitir nota fiscal automaticamente? | **Não.** Decidido em 2026-09-01. Sem integração fiscal no épico 11; intenção futura de emitir por conta própria junto à prefeitura de **Salvador (BA)**, com os campos a verificar **naquele momento** (§11.4.1). Decorrência resolvida por mim: **coletamos CPF/CNPJ no checkout mesmo assim** (§11.4.2) |
| **DP-17** ✅ | Vender os três planos desde o lançamento, ou só o Pessoal? | **Os três**, diferenciados por pessoas e espaços. Decidido em 2026-09-01 (§1.2, §2) |
| **DP-18** ✅ | Nomes dos planos | **Pessoal · Família · Negócio.** Decidido em 2026-09-01 (§2) |
| **DP-19** ✅ | Mensal só, ou mensal e anual? | **Mensal e anual com desconto.** Decidido em 2026-09-01, **contra a minha recomendação**. Desconto proposto por mim: `anual = 10 × mensal` (§2.4). As consequências que apontei viraram requisito em §2.5, §6.2, §6.3 e §6.4 — o anual só é seguro **com** o reembolso proporcional e os avisos de renovação |
| **DP-20** 🔺 | Reembolso além do prazo legal | O arrependimento de **7 dias** do CDC art. 49 é **obrigação**, não escolha. A escolha é ser mais generoso: proponho **reembolso integral da primeira cobrança em até 30 dias, sem perguntar o motivo**. Com o anual aprovado, isso deixou de ser gentileza: é o que torna R$ 690 adiantados uma compra sem medo |
| **DP-21** 🔺 | Janela de graça em `em_atraso` | **14 dias**, alinhados à retentativa da Stripe, iguais para mensal e anual (§6.1) |
| **DP-22** 🔺 | Anunciar preço na lista de espera da conexão bancária | **Sim, com compromisso de 12 meses ao preço anunciado** — ou não anunciar nada (§1.3) |
| **DP-27** 🔺 | Confirmar o desconto anual | **`anual = 10 × mensal`** — dois meses grátis, ≈16,7% (§2.4). O dono decidiu *que* haverá anual; *quanto* de desconto ainda é dele |

---

## 15. O que este documento exige de outros documentos

Nenhum destes é opcional: sem eles, este spec não passa no gate de risco.

| Documento | Mudança |
|---|---|
| `CONTEXT.md` | **Com o `arquiteto-dominio-financeiro`, não por este documento.** Acrescentar `Assinatura`, `Plano`, `Intervalo`, `Cota`, `Cobranca`, `DadosFiscais`, `EventoDeCobranca`, `ListaDeEspera` e os cinco estados; acrescentar as linhas de termos proibidos do §9.2; **renomear `dentro_do_plano` para `dentro_do_planejado`** |
| `docs/compliance/retencao-e-eliminacao.md` | ✅ **Feito neste mesmo passo**, porque a contradição não podia ficar de pé: §2.2 corrigida (o documento fiscal deixa de ser “não coletamos” e vira exceção enumerada, com os quatro vetos); §3.6 substituída pelo mapa completo do §11.1; §5.3 nomeando `cobrancas` e `dados_fiscais` como sobreviventes e acrescentando o cancelamento na Stripe; §6.1 incluindo `assinatura` e `cobrancas`; §11 com a linha DP-16 |
| `docs/compliance/subprocessadores.md` | **Criar.** Stripe. Provedor fiscal **não entra** — não existe, por decisão de DP-16 |
| `docs/adr/` | ADR de billing registrando: fonte de verdade de um lado só (§10.1), teste fora da Stripe (§10.2), catálogo em código (§3), e a **coleta de documento fiscal** como exceção nominada à §2.2 — esta última é exigida pelo próprio texto da §2.2 |
| `docs/produto/arquitetura-informacao.md` | §2.12 “Plano e cobrança” ganha inventário próprio; a página de preços (com o alternador mensal/anual), o checkout e a lista de espera entram como telas |
| `docs/seguranca/matriz-de-acesso.md` | A linha `billing` já existe e cobre as rotas. Acrescentar a rota de webhook como `publica-assinada` no manifesto |
| `docs/pipeline.md` | Épico 11 passa a depender do 10 (compartilhamento) de forma dura, e não só por ordem: os níveis 2 e 3 vendem o espaço compartilhado |
