# Triage Labels

As skills falam em cinco papéis canônicos de triagem. Esta tabela mapeia cada papel para a string usada neste repositório.

Como o tracker é markdown local, o "label" é o valor da linha `Status:` no topo do arquivo do issue.

| Papel em mattpocock/skills | Status neste repositório | Significado |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Precisa ser avaliado |
| `needs-info` | `needs-info` | Aguardando informação de quem reportou |
| `ready-for-agent` | `ready-for-agent` | Totalmente especificado, pronto para um agente autônomo |
| `ready-for-human` | `ready-for-human` | Exige implementação humana |
| `wontfix` | `wontfix` | Não será tratado |

## Status adicional deste projeto

| Status | Significado |
| --- | --- |
| `needs-risk-gate` | Spec escrito, aguardando o gate de risco (appsec, LGPD, validador financeiro) |
| `blocked-by-risk` | Gate de risco levantou objeção não resolvida. **Não implemente.** |

Um spec **nunca** passa direto de `needs-triage` para `ready-for-agent`. Ele passa por `needs-risk-gate`, e só recebe `ready-for-agent` quando a seção `## Gate de risco` do spec estiver completa e sem objeções abertas. Ver `docs/pipeline.md`, fase 3.
