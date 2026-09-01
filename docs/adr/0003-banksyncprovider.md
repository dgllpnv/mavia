# ADR 0003 — `BankSyncProvider`: ingestão bancária atrás de um seam único

- **Status:** Aceita
- **Data:** 2026-09-01

## Contexto

Sincronização bancária automática é a feature que define a categoria — é o que o Organizze vende nos planos Conectado e Conectado Plus.

Duas restrições concretas:

1. **Acesso direto às APIs do Open Finance exige ser instituição autorizada pelo Banco Central** — certificados ICP, conformidade FAPI, auditoria. Fora do alcance do projeto hoje.
2. **Agregadores custam caro desde o primeiro mês**, na ordem de milhares de reais mensais (Pluggy e Belvo praticam faixas dessa ordem; Tecnospeed cobra entrada mais mensalidade menor). Verifique os valores correntes antes de decidir — eles mudam.

O produto não pode assumir esse custo antes de ter receita, e também não pode ser arquitetado de um jeito que force reescrita quando puder assumi-lo.

## Decisão

Todo dado bancário entra por uma interface única, `BankSyncProvider`. Nenhum código de aplicação conhece um provider concreto.

Adapters:

| Adapter | Quando |
|---|---|
| `manual` | Desde o dia 1 |
| `ofx-import` | Épico 6 |
| `csv-import` | Épico 6 |
| `pluggy` (ou equivalente) | Épico 12, quando a receita justificar |

O contrato do provider carrega o essencial: identidade do registro na origem, chave de idempotência, valor, datas e dados brutos preservados. Todo registro entra primeiro como `LancamentoBruto`, com chave `(tenant_id, provider, external_id)` mais hash do conteúdo normalizado, antes de virar `Lancamento`.

Lançar com importação de arquivo e entrada manual assistida por IA; plugar agregador quando a receita cobrir o custo.

## Consequências

**Positivas.** Custo variável zero no lançamento. Trocar ou adicionar agregador é escrever um arquivo, não migrar dados. A idempotência e a deduplicação são resolvidas uma vez, no seam, valendo para todos os adapters. Dois adapters reais desde cedo (`manual` e `ofx-import`) tornam o seam legítimo, e não abstração especulativa.

**Negativas.** O produto lança sem a feature mais chamativa da categoria, o que exige compensar com qualidade de categorização, relatórios e velocidade de lançamento. Importação de arquivo é experiência inferior à sincronização automática, e isso pesa na conversão. Parsers de OFX e CSV são frágeis por natureza e demandam manutenção contínua.

## Alternativas rejeitadas

**Agregador desde o dia 1.** Paridade imediata com o Organizze, mas queima caixa em escala de milhares por mês antes de qualquer validação de produto. O risco de morrer antes de validar supera o ganho.

**Participação direta no Banco Central.** Elimina o intermediário e o custo recorrente, mas exige autorização regulatória, certificados, conformidade FAPI e auditoria — prazo de meses a anos. Reavaliar se o produto atingir escala.

**Somente manual, sem seam.** Custo mínimo e código mais simples agora, ao preço de uma reescrita completa da ingestão quando a automação chegar. Economia falsa.

## Revisão

Reavaliar trimestralmente: custo do agregador contra receita recorrente. O gatilho para o épico 12 é a receita cobrir o custo do agregador com margem, não a vontade de ter a feature.
