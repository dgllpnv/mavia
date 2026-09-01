# Domain Docs

Como as skills de engenharia devem consumir a documentação de domínio deste repositório ao explorar o código.

Layout: **contexto único**.

## Antes de explorar, leia

- **`CONTEXT.md`** na raiz — o glossário e a linguagem ubíqua.
- **`docs/adr/`** — os ADRs que tocam a área em que você vai trabalhar.
- **`CLAUDE.md`**, seção 2 — as regras inegociáveis. Elas têm precedência sobre qualquer preferência de estilo.
- **`docs/design.md`** — obrigatório antes de qualquer trabalho de interface.

## Use o vocabulário do glossário

Quando sua saída nomear um conceito de domínio (título de issue, proposta de refactor, hipótese, nome de teste), use o termo como definido em `CONTEXT.md`. Não escorregue para sinônimos que o glossário evita explicitamente — a seção "Termos proibidos" existe porque cada um daqueles termos já causou ambiguidade real nesta categoria de produto.

Se o conceito que você precisa não está no glossário, isso é sinal: ou você está inventando linguagem que o projeto não usa (reconsidere), ou existe uma lacuna real (registre para `/domain-modeling`).

## Sinalize conflito com ADR

Se sua saída contradiz um ADR existente, diga isso explicitamente em vez de sobrescrever em silêncio:

> _Contradiz o ADR 0003 (BankSyncProvider) — mas vale reabrir porque…_

ADR aceita não se re-litiga em conversa. Se a decisão precisa mudar, escreva um ADR novo que substitua o anterior.

## Estrutura

```
/
├── CLAUDE.md
├── CONTEXT.md
├── docs/
│   ├── adr/
│   │   ├── 0001-stack-typescript-monorepo.md
│   │   ├── 0002-mobile-react-native-expo.md
│   │   ├── 0003-banksyncprovider.md
│   │   ├── 0004-saas-multi-tenant-rls.md
│   │   ├── 0005-dinheiro-centavos-partida-dobrada.md
│   │   └── 0006-identidade-visual-autoral.md
│   ├── design.md
│   ├── pipeline.md
│   ├── team.md
│   └── agents/
└── .scratch/            ← issues e specs
```
