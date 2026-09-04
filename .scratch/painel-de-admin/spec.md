# Painel de administração — ponteiro para o spec

Status: needs-risk-gate

O spec **não** vive aqui. Ele está em:

**`docs/superpowers/specs/2026-09-04-perfil-de-admin-design.md`** — versão **v3.1**

E o pré-requisito arquitetural, aceito, em:

**`docs/adr/0024-acesso-administrativo-entre-espacos.md`**

## Por que este arquivo é um ponteiro e não o spec

`docs/agents/issue-tracker.md` diz que o spec de uma feature vive em `.scratch/<slug>/spec.md`. A skill de brainstorming, que foi quem escreveu este, grava em `docs/superpowers/specs/`. As duas convenções são reais e discordam.

Copiar seiscentas linhas para cá criaria duas fontes de verdade sobre um documento que já foi reprovado duas vezes por afirmar coisa que não se confirmava. Duas cópias divergindo é o modo de falha mais provável, e o mais caro — alguém implementaria a errada.

Então: o spec fica onde a skill o pôs, os tickets ficam aqui, e este arquivo carrega o que o tracker precisa ler — o estado do gate.

## Histórico do gate

| Passada | Documento | Veredito |
|---|---|---|
| 1ª | v1 | **Reprovado.** A alegação central era falsa: citava uma regra de lint que não existe (`eslint.config.js` não tem nenhuma sobre `comTenant`, e a função nem se chama `withTenant`) |
| 2ª | v2 | **Reprovado.** *"O spec descreve travas de banco de dados sobre uma topologia de conexão que não as suporta."* Um `Pool` único como `mavia_app`, e todo papel proposto a um `SET ROLE` de distância. Medido: `SET LOCAL ROLE leitor; RESET ROLE; UPDATE` commita |
| 3ª | v3 → v3.1 | **Aprovado com condições.** Nove de nove achados anteriores fechados. Cinco condições de ticket, fechadas na v3.1; cinco de deploy, abertas por desenho |

## Gate de risco

_A seção definitiva vive no próprio spec, sob o heading `## Gate de risco`. Esta é a cópia curta que o tracker lê._

- especialista-seguranca-appsec: **aprovado com condições** — C-1 a C-5 (ticket) fechadas na v3.1; C-6 a C-10 bloqueiam o **deploy**, não o ticket
- especialista-lgpd-compliance: _aguardando parecer sobre a v3.1_
- validador-financeiro: _aguardando primeiro parecer_

## Comments

**2026-09-04** — Criado ao fim da terceira passada do gate. Os tickets só saem quando as três linhas acima estiverem preenchidas e sem objeção aberta, conforme `docs/agents/triage-labels.md`: *"um spec nunca passa direto de `needs-triage` para `ready-for-agent`"*.
