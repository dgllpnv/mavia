# Issue tracker: Local Markdown

Issues e specs (você pode conhecer spec como PRD) deste repositório vivem como arquivos markdown em `.scratch/`.

Escolha registrada porque o repositório é local, sem remoto GitHub ou GitLab. Se um remoto for adicionado depois, rode `/setup-matt-pocock-skills` novamente para migrar.

## Convenções

- Uma feature por diretório: `.scratch/<feature-slug>/`
- O spec é `.scratch/<feature-slug>/spec.md`
- Issues de implementação são um arquivo por ticket em `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numerados a partir de `01` — nunca um arquivo único combinando tickets
- O estado de triagem é uma linha `Status:` no topo do arquivo (ver `triage-labels.md`)
- Comentários e histórico são anexados ao fim do arquivo sob um heading `## Comments`

## Convenção adicional deste projeto

Todo spec registra o resultado do **gate de risco** (ver `docs/pipeline.md`, fase 3) sob um heading `## Gate de risco`, com uma linha por revisor:

```
## Gate de risco
- especialista-seguranca-appsec: aprovado | objeções (…)
- especialista-lgpd-compliance: aprovado | objeções (…)
- validador-financeiro: aprovado | objeções (…)
```

Um spec sem esta seção completa não avança para `/to-tickets`.

## Quando uma skill diz "publique no issue tracker"

Crie um arquivo novo sob `.scratch/<feature-slug>/`, criando o diretório se necessário.

## Quando uma skill diz "busque o ticket relevante"

Leia o arquivo no caminho referenciado. O usuário normalmente passa o caminho ou o número do issue diretamente.

## Operações de wayfinding

Usadas por `/wayfinder`. O **mapa** é um arquivo com um arquivo **filho** por ticket.

- **Mapa**: `.scratch/<effort>/map.md` — corpo com Notes, Decisions-so-far e Fog.
- **Ticket filho**: `.scratch/<effort>/issues/NN-<slug>.md`, numerado a partir de `01`, com a pergunta no corpo. Uma linha `Type:` registra o tipo (`research`/`prototype`/`grilling`/`task`); uma linha `Status:` registra `claimed`/`resolved`.
- **Bloqueio**: uma linha `Blocked by: NN, NN` no topo. Um ticket está desbloqueado quando todos os arquivos listados estão `resolved`.
- **Fronteira**: varra `.scratch/<effort>/issues/` por arquivos abertos, desbloqueados e não reivindicados; o menor número vence.
- **Reivindicar**: defina `Status: claimed` e salve antes de qualquer trabalho.
- **Resolver**: anexe a resposta sob um heading `## Answer`, defina `Status: resolved`, e anexe um ponteiro de contexto (resumo mais link) ao Decisions-so-far do `map.md`.
