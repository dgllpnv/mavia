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

**DP-10** (`BankSyncProvider.revogar()`) era consequência técnica da DP-9, não escolha do dono. Resolvida por ADR própria.

---

## As três que mais moldam o produto

**A chave mestra num guardião local** troca custo mensal por trabalho manual. Todo reboot da VPS exige desselamento, e enquanto isso a sincronização bancária fica parada — o resto do produto funciona. A falha é silenciosa para o usuário: os lançamentos simplesmente param de chegar. Por isso ela precisa de alerta e de runbook, e não apenas de documentação. Migrar para um KMS externo quando houver orçamento não exige ADR nova.

**Treinar modelo com dado de cliente está proibido**, e isso foi decidido como posição, não adiado. A categorização opera por regra do usuário e por histórico do próprio espaço — ambos determinísticos, explicáveis e sem transferência de dado a terceiro. Reverter exige finalidade declarada, base legal própria e opt-out visível, numa decisão nova.

**Os dados sincronizados permanecem após a revogação.** A credencial e a chave são destruídas na mesma transação, mas os lançamentos já importados continuam: eles deixaram de ser "dados do banco" e passaram a ser o histórico financeiro do usuário. Apagá-los porque ele desconectou o banco destruiria o produto dele sem que tivesse pedido.

---

## Como usar este índice

Uma decisão registrada aqui **não se re-litiga em conversa**. Se ela precisar mudar, o caminho é o mesmo de uma ADR: escrever a decisão nova, com o contexto que mudou e o custo da reversão, e marcar a antiga como substituída.

Decisão nova do dono do produto entra nesta tabela **e** no documento de origem. O índice sozinho não é registro suficiente — ele não carrega a justificativa.
