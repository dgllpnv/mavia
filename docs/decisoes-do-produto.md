# Decisões do dono do produto

Índice das escolhas que **não** eram do time. Cada uma foi levantada por um especialista que se recusou a decidir no lugar do dono, e está registrada em detalhe no documento de origem.

Este arquivo é um índice, não a fonte. A justificativa completa e as consequências vivem no documento indicado.

---

## Resolvidas em 2026-09-01

| # | Decisão | Escolha | Onde está o detalhe |
|---|---|---|---|
| **DP-1** | Um `membro` pode conectar o próprio banco? | **Sim.** `visualizador` continua fora | `docs/seguranca/matriz-de-acesso.md` |
| **DP-2** | Um `membro` pode convidar outras pessoas? | **Não.** Exclusivo do `proprietario` | `docs/seguranca/matriz-de-acesso.md` |
| **DP-3** | Um `membro` pode criar chave de API ou autorizar app de IA? | **Não.** Exclusivo do `proprietario` | `docs/seguranca/matriz-de-acesso.md` |
| **DP-4** | Um `membro` pode excluir lançamento de outro membro? | **Sim.** O dado é do espaço, e a exclusão é rastreável | `docs/seguranca/matriz-de-acesso.md` |
| **DP-5** | Conta inativa é eliminada automaticamente? | **Não elimina.** Guarda até o titular pedir | `docs/compliance/retencao-e-eliminacao.md` |
| **DP-6** | Quanto tempo um lançamento excluído sobrevive? | **12 meses** até a purga física | `docs/compliance/retencao-e-eliminacao.md` |
| **DP-7** | Retenção de backup | **30 dias.** Deve constar na política de privacidade | `docs/compliance/retencao-e-eliminacao.md` |
| **DP-8** | Treinar modelo com dado de cliente | **Proibido.** Decisão firme, não adiamento | `docs/compliance/retencao-e-eliminacao.md` |
| **DP-9** | Destino dos dados sincronizados após revogação | **Permanecem e param de atualizar** | `docs/compliance/retencao-e-eliminacao.md` |
| **DP-11** | Categorização por IA: local ou terceiro | **Local, sem terceiro.** Regra do usuário e histórico do espaço | `docs/compliance/retencao-e-eliminacao.md` |
| **D3.3** | Onde vive a chave mestra (KEK) | **Guardião local com KEK selada** | `docs/adr/0018-envelope-encryption.md` |
| **DP-12** | Como as pessoas entram na plataforma | **Google e também e-mail e senha.** Os dois caminhos | `docs/produto/spec-autenticacao.md` |
| **DP-13** | Estrutura de planos no lançamento | **Espelhar o Organizze**, com os três níveis | `docs/produto/spec-planos-e-assinatura.md` |
| **DP-14** | Provedor de assinatura | **Stripe** | `docs/produto/spec-planos-e-assinatura.md` |
| **DP-15** | Experimentação | **7 dias, sem exigir cartão** | `docs/produto/spec-planos-e-assinatura.md` |
| **DP-16** | Emissão de nota fiscal | **Sem emissão automática no lançamento.** No futuro, integração própria com a prefeitura de Salvador (BA) | `docs/produto/spec-planos-e-assinatura.md` |
| **DP-17** | Vender os três planos desde o lançamento da cobrança | **Sim, os três** | `docs/produto/spec-planos-e-assinatura.md` |
| **DP-18** | Nomes dos planos | **Pessoal · Família · Negócio** | `docs/produto/spec-planos-e-assinatura.md` |
| **DP-19** | Ciclo de cobrança | **Mensal e anual com desconto** | `docs/produto/spec-planos-e-assinatura.md` |
| **DP-20** | Reembolso além do prazo legal | **Integral em 30 dias, sem perguntar o motivo** | `docs/produto/spec-planos-e-assinatura.md` |
| **DP-21** | Graça no pagamento em atraso | **14 dias**, alinhados à retentativa da Stripe | `docs/produto/spec-planos-e-assinatura.md` |
| **DP-23** | MFA obrigatório para `proprietario`? | **Não.** Opcional, com reautenticação em doze operações e obrigatório para conectar banco e criar chave de API | `docs/produto/spec-autenticacao.md` |
| **DP-24** | Vidas de sessão | Padrão aceito: **14/30 dias web, 60/180 mobile** | `docs/produto/spec-autenticacao.md` |
| **DP-25** | Existe canal humano de recuperação? | **Não existe.** Confirmado | `docs/produto/spec-autenticacao.md` |
| **DP-26** | Teto de tenants por usuário | Padrão aceito: **3 por dia, 10 ativos** | `docs/produto/spec-autenticacao.md` |
| **DP-27** ⛔ | Preços e desconto anual | ~~R$ 59 · R$ 79 · R$ 99; anual = 10 × mensal~~ — **substituída pela DP-41** | `docs/produto/spec-planos-e-assinatura.md` |
| **DP-42** | Encarregado de dados (LGPD art. 41) | **Davi Gonçalves Lopes**, `davilopesg@gmail.com`. O dono do produto acumula a função. Nome e endereço **têm de aparecer na política de privacidade** — art. 41 §2º I exige que a identidade e o contato sejam publicamente divulgados, e um formulário genérico de contato não cumpre | **O-6** |
| **DP-41** | Preços alinhados ao Organizze | **R$ 35 · R$ 45 · R$ 69** por mês; anual à vista **R$ 199,90 · R$ 399,90 · R$ 599,90**, sem fórmula ligando os dois | `docs/produto/spec-planos-e-assinatura.md` §2.4, §2.6 |
| **DP-28** | Ajustar cotas por causa do preço maior | **Não.** Cotas mantidas como estão. Sem promessa de prazo de suporte na página | `docs/produto/spec-planos-e-assinatura.md` |
| **DP-29** | Duração do teste (7 dias) | **Mantida.** Reavaliar com dado de conversão, não por opinião | `docs/produto/spec-planos-e-assinatura.md` |
| **DP-30** | O modo escuro segue a preferência do sistema? | **Sim.** `prefers-color-scheme` aplica o escuro; a escolha explícita no produto vence nos dois sentidos | `docs/design/direcao-visual.md` |
| **DP-31** | Disposição das telas | **Muito parecida com a do Organizze** — cards, linha de 56px, ícone de categoria em círculo, formulário na ordem deles. As cores continuam nossas. Substitui a direção "Papel e trilho" | `docs/design/direcao-visual-2-familiar.md` |

**DP-10** (`BankSyncProvider.revogar()`) era consequência técnica da DP-9, não escolha do dono. Resolvida por ADR própria.

---

## Os planos — e a proposta do coordenador que foi recusada

O dono do produto escolheu espelhar a estrutura de três planos do Organizze. O coordenador ressalvou que os dois planos superiores de lá vendem **conexão bancária automática**, que na Mavia é o épico 12, e propôs modelá-los mas mantê-los **indisponíveis para compra** até lá.

**O `product-financeiro` recusou essa proposta, e a recusa foi aceita.** O argumento:

> Trocar a porta trancada por receita real é o que destrava o gatilho do ADR 0003.

Um plano que ninguém pode comprar gera receita zero — e o gatilho para contratar o agregador **é a receita**. A proposta do coordenador atrasava exatamente aquilo que pretendia proteger.

A solução usa a ordem dos épicos: compartilhamento (10) vem **antes** de billing (11). Quando a cobrança entrar no ar, os planos superiores terão o que vender de verdade — **pessoas no espaço** e **múltiplos espaços**. Quando o épico 12 chegar, a conexão entra nos dois **sem aumento de preço**, que é o melhor evento de retenção disponível.

Daí os nomes `Pessoal`, `Família` e `Negócio`: eles nomeiam o que o plano entrega, continuam verdadeiros antes e depois do épico 12, e não prometem o que ainda não existe. Pré-venda com desconto foi recusada — reembolso diferido, art. 35 do CDC e risco de estorno em massa.

## Nota fiscal, e a coleta de documento — resolvido

Não haverá emissão automática no lançamento. Nenhuma integração fiscal entra no épico 11. A intenção futura é emitir por conta própria, junto à prefeitura de **Salvador, na Bahia** — e o que estará vigente lá é verificação para *aquele* momento, com a contabilidade, não agora.

**Mas o CPF ou CNPJ passa a ser coletado no checkout desde a primeira venda.** O `product-financeiro` recomendou coletar, e a recomendação foi adotada. O argumento não é sobre qual lado é mais nobre, e sim sobre **qual erro tem volta**:

| Coletar e não precisar | Não coletar e precisar |
|---|---|
| Apaga-se uma tabela, registra-se o descarte, acabou. Reversível num deploy | Pedir documento a quem já é cliente: baixa resposta, contato constrangedor, e **quem cancelou antes é inalcançável para sempre** |

> Coletar agora custa um campo; coletar depois custa a base inteira, e nunca fecha em 100%.

A assimetria decide. Em contrapartida, o documento vem com quatro vetos escritos: nunca é identificador, nunca é antifraude, nunca é enriquecido em base externa, nunca sai em log ou resposta a quem não é `proprietario`. E a política de retenção foi **corrigida por escrito** — ela prometia não coletar documento algum, e um documento normativo que promete o que o produto não cumpre torna todo o resto suspeito.

Se a emissão for definitivamente abandonada, a base legal desaparece e a tabela é apagada por inteiro. A saída está escrita para a coleta não virar permanente por inércia.

---

## Preço — o que o patamar escolhido implica

**Reescrito em 2026-09-04 pela DP-41.** O texto anterior explicava o que um preço *acima* do concorrente obriga; a premissa deixou de existir.

Os preços definidos pelo dono do produto são **R$ 35 (Pessoal), R$ 45 (Família) e R$ 69 (Negócio)** por mês, e os anuais à vista **R$ 199,90 · R$ 399,90 · R$ 599,90**. São os seis valores do Organizze, espelhados um a um na posição equivalente: Pessoal↔Manual, Família↔Conectado, Negócio↔Conectado Plus.

Registro factual, sem juízo — **paridade de preço não é o alívio que parece**:

| Nível | Nosso preço | Equivalente | Quem entrega mais hoje |
|---|---:|---|---|
| Pessoal | R$ 35,00 | Manual · R$ 35 | **empate honesto** — nenhum dos dois conecta banco, e damos 2 pessoas contra 1 |
| Família | R$ 45,00 | Conectado · R$ 45 | **eles** — 3 conexões bancárias, que o épico 12 ainda não construiu |
| Negócio | R$ 69,00 | Conectado Plus · R$ 69 | **eles** — 10 conexões, PF e PJ |

Enquanto estávamos mais caros, o cliente precisava de uma **razão** para pagar a diferença, e razão se constrói com argumento. Igualados, ele não precisa de razão nenhuma: põe as duas tabelas lado a lado e conta linhas.

**A consequência que precisa estar escrita no produto** mudou de forma: não é mais "declare a promessa implícita do preço maior", e sim **o épico 12 virou pré-condição de venda dos níveis `Família` e `Negócio`**. Cobrar R$ 45 é cobrar o preço de mercado da conexão bancária. A recomendação do time — decisão do dono, ainda em aberto — é `disponivelParaCompra = false` nesses dois níveis até a função existir. Ver §2.6 da spec.

Duas coisas **não** mudaram, e é bom que não: as cotas revistas pela DP-28 continuam válidas (a de `pessoas` virou argumento em vez de amortecedor), e o catálogo continua declarando cada preço em centavos, sem fórmula — agora por necessidade, não só por disciplina.

---

## Cotas mantidas — o risco registrado

O `product-financeiro` recomendou subir duas cotas por causa do preço mais alto: `pessoas` no Pessoal de 1 para 2, e anexos de 2/10/30 para 5/20/50 GB. **O dono do produto decidiu manter as cotas como estão.**

O risco que ele apontou fica registrado, sem re-litígio: *dizer a alguém que ele não pode dividir o controle com quem divide as contas dele é a objeção mais previsível que existe* — e casal é o caso mais comum de finanças pessoais no Brasil.

**A DP-41 mudou o peso desse risco.** O argumento original era "a R$ 35 um plano solo é o barato; a R$ 59 acima do mercado, não". Agora estamos **nos R$ 35**, frente a frente com um Manual que é individual — e a cota de 2 pessoas deixou de compensar preço para virar **a única linha em que o Pessoal ganha item a item**.

**A reversão é barata, e é isso que torna a decisão de baixo risco.** Cota é catálogo, não arquitetura: subir `pessoas` no Pessoal é editar uma configuração e fazer deploy, sem migração de dado e sem retrabalho. Se a objeção aparecer na conversão ou no cancelamento, muda-se.

Também decidido: **nenhuma promessa de prazo de suporte na página de preços.** É a promessa mais barata de escrever e a mais cara de quebrar, e o projeto tem uma pessoa. Atender bem sem publicar prazo é possível; publicar prazo e falhar, não.

---

## Perder a Conta Google significa perder o espaço

Confirmado pelo dono do produto: **não existe canal humano de recuperação.**

O motivo é duro e vale estar escrito: qualquer canal humano de recuperação é também o caminho de quem se passa pelo cliente. Suporte capaz de devolver acesso é suporte capaz de dar acesso a um impostor — e num produto financeiro essa é a superfície mais atacada que existe.

O custo é real e recai sobre o produto, não sobre o cliente: a tela de cadastro precisa dizer isso com todas as letras, e a de sucesso precisa oferecer criar senha ou MFA **na hora**, não num menu de configurações que ninguém visita.

---

## As três que mais moldam o produto

**A chave mestra num guardião local** troca custo mensal por trabalho manual. Todo reboot da VPS exige desselamento, e enquanto isso a sincronização bancária fica parada — o resto do produto funciona. A falha é silenciosa para o usuário: os lançamentos simplesmente param de chegar. Por isso ela precisa de alerta e de runbook, e não apenas de documentação. Migrar para um KMS externo quando houver orçamento não exige ADR nova.

**Treinar modelo com dado de cliente está proibido**, e isso foi decidido como posição, não adiado. A categorização opera por regra do usuário e por histórico do próprio espaço — ambos determinísticos, explicáveis e sem transferência de dado a terceiro. Reverter exige finalidade declarada, base legal própria e opt-out visível, numa decisão nova.

**Os dados sincronizados permanecem após a revogação.** A credencial e a chave são destruídas na mesma transação, mas os lançamentos já importados continuam: eles deixaram de ser "dados do banco" e passaram a ser o histórico financeiro do usuário. Apagá-los porque ele desconectou o banco destruiria o produto dele sem que tivesse pedido.

---

## Resolvidas em 2026-09-04

| # | Decisão | Escolha | Onde está o detalhe |
|---|---|---|---|
| **DP-35** | Em qual fatura entra o estorno de uma compra no cartão? | **Na fatura vigente** — a que está aberta na data do reembolso, *"como é padrão nos bancos"*. Não na fatura da compra original, que já foi fechada e paga | [ADR 0023](adr/0023-estorno-de-compra-no-cartao.md), **aceito** |

---

## Resolvidas em 2026-09-04 — o painel de administração

Todas decididas pelo dono do produto. As sete que tinham "padrão vigente" foram
**confirmadas**; a DP-39 não tinha padrão e foi escolhida.

| # | Decisão | Escolha | Onde está o detalhe |
|---|---|---|---|
| **DP-32** ✏️ | Até quando o painel opera sem MFA? | **Revista em 2026-09-05 pelo dono: o painel foi a produção sem MFA.** A decisão anterior era "antes do primeiro cliente pagante". O que a torna defensável **hoje** é que o único usuário do sistema é o próprio dono — o operador e o titular são a mesma pessoa, e não há dado de terceiro a proteger. **Ela deixa de ser defensável no dia em que o primeiro cliente se cadastrar**, e o MFA passa a ser dívida com prazo. A contrapartida que o gate de segurança pediu ao adiar o MFA — allowlist de IP — **não foi entregue**, porque depende do domínio | `retencao-e-eliminacao.md` §8.1.1 |
| **DP-33** | Por quanto tempo um `motivo` + `referencia` autoriza aberturas? | **30 minutos.** Cada abertura continua gerando a própria linha; o que a janela reaproveita é a hipótese, nunca o registro | spec v3.2 §5 |
| **DP-34** | Com um operador só, o aviso vai para onde? | **Destino externo ao painel.** Uma notificação que só existe dentro do sistema que ela vigia não detecta o comprometimento desse sistema | spec v3.2 §6.3 |
| **DP-36** | Pagamento por fora muda o estado da assinatura? | **Muda, e só onde o domínio permite.** `em_atraso` recupera; `expirada`, `teste` e `cancelada` **recusam** — registrar dinheiro que não muda contrato nenhum é pior do que recusar | Achado **F-1**, corrigido em **FC-1** |
| **DP-37** | Qual competência a baixa registra? | **A do recebimento**, uma linha por pagamento. Doze linhas exigiriam dividir, e R$ 590,00 e R$ 790,00 não dividem por 12 em centavos exatos | Achado **F-5** |
| **DP-38** | `cortesia` é receita? | **Não — e saiu da tabela.** Zerar o valor consertaria o total e não a exportação, onde uma linha de R$ 0,00 continuaria saindo ao titular como pagamento que ele nunca fez. Cortesia virou **tempo**, em dias | Achado **F-6** |
| **DP-39** | Quando o operador troca o plano, o que acontece na Stripe? | **O painel escreve na Stripe e espera o webhook.** É a única alternativa que não cria uma segunda verdade sobre quanto o cliente paga. Custa uma chamada de API e a espera do retorno | Achado **F-15** · condição **C-11** |
| **DP-40** | O operador pode rebaixar no meio de um ciclo pago? | **Não**, e a ação saiu do escopo do painel: o caminho que ela deveria reusar **não existe** (**P-17**). A resposta governa as duas rotas quando aquele caminho for construído | Achado **F-8** · **P-17** |

---

## Como usar este índice

Uma decisão registrada aqui **não se re-litiga em conversa**. Se ela precisar mudar, o caminho é o mesmo de uma ADR: escrever a decisão nova, com o contexto que mudou e o custo da reversão, e marcar a antiga como substituída.

Decisão nova do dono do produto entra nesta tabela **e** no documento de origem. O índice sozinho não é registro suficiente — ele não carrega a justificativa.
