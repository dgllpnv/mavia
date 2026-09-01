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

## As três que mais moldam o produto

**A chave mestra num guardião local** troca custo mensal por trabalho manual. Todo reboot da VPS exige desselamento, e enquanto isso a sincronização bancária fica parada — o resto do produto funciona. A falha é silenciosa para o usuário: os lançamentos simplesmente param de chegar. Por isso ela precisa de alerta e de runbook, e não apenas de documentação. Migrar para um KMS externo quando houver orçamento não exige ADR nova.

**Treinar modelo com dado de cliente está proibido**, e isso foi decidido como posição, não adiado. A categorização opera por regra do usuário e por histórico do próprio espaço — ambos determinísticos, explicáveis e sem transferência de dado a terceiro. Reverter exige finalidade declarada, base legal própria e opt-out visível, numa decisão nova.

**Os dados sincronizados permanecem após a revogação.** A credencial e a chave são destruídas na mesma transação, mas os lançamentos já importados continuam: eles deixaram de ser "dados do banco" e passaram a ser o histórico financeiro do usuário. Apagá-los porque ele desconectou o banco destruiria o produto dele sem que tivesse pedido.

---

## Como usar este índice

Uma decisão registrada aqui **não se re-litiga em conversa**. Se ela precisar mudar, o caminho é o mesmo de uma ADR: escrever a decisão nova, com o contexto que mudou e o custo da reversão, e marcar a antiga como substituída.

Decisão nova do dono do produto entra nesta tabela **e** no documento de origem. O índice sozinho não é registro suficiente — ele não carrega a justificativa.
