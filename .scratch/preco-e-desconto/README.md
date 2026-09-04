# Preço-base e desconto pelo painel — ordem de execução

Escrito contra **`docs/adr/0025-preco-base-e-desconto-pelo-painel.md`** (aceita) e as decisões **DP-39** (o painel escreve na Stripe e espera o webhook) e **DP-41** (preços alinhados ao Organizze).

Pedido do dono em 2026-09-04: *"uma opção que troca os valores base dos planos ou adiciona descontos"*.

---

## O bloqueio que define tudo aqui

**Não existe cliente Stripe de saída nesta base.** `apps/api/src/cobranca/cobranca.controller.ts` implementa e testa o **webhook de entrada** — e é tudo. Sem SDK, sem chave, sem conta.

Isso não é um detalhe de implementação: é o que decide o que cada ticket pode fazer. Um `Price` da Stripe é **imutável**, e um número editado só do nosso lado não muda o que é cobrado de ninguém. A ADR 0025 responde a isso com duas colunas `NOT NULL` (`stripe_price_id`, `stripe_coupon_id`) que fazem a ausência da Stripe se manifestar como **impossibilidade de criar a linha**, e não como uma linha órfã que parece funcionar.

| | Precisa da conta Stripe? |
|---|---|
| 13 · `Desconto` no domínio | **não** — ✅ **feito** |
| 14 · migrations e funções `admin.*` | não, para escrever |
| 15 · cliente Stripe de saída | **sim** |
| 16 · rotas do painel | não, para escrever; a escrita real espera o 15 |
| 17 · telas | não |

Os tickets 14, 16 e 17 são escrevíveis e testáveis hoje contra um dublê da interface do 15. **Nenhum deles vai a produção antes do 15**, e o 15 espera a §4 de `docs/o-que-depende-de-voce.md`.

---

## Grafo de bloqueio

```
13 desconto-no-dominio ✅ ─┬─→ 14 tabelas-e-funcoes ─┬─→ 16 rotas-do-painel ─→ 17 telas
                           │                          │
                           └─→ 15 cliente-stripe ─────┘   (15 bloqueado pela conta Stripe)
```

| NN | Fatia | Blocked by | Migration | Estado |
|---|---|---|---|---|
| 13 | `desconto-no-dominio` | — | — | ✅ **resolved** |
| 14 | `tabelas-e-funcoes` | 13 | `0042_precos_e_descontos.sql` | open |
| 15 | `cliente-stripe` | 13 | — | **blocked** · conta Stripe |
| 16 | `rotas-do-painel` | 14, 15 | — | open |
| 17 | `telas` | 16 | — | open |

---

## 13 · `desconto-no-dominio` ✅ resolved

`packages/domain/src/desconto.ts` — 15 testes, 4 por propriedade.

O que ficou provado, e a razão de cada propriedade existir:

- **`preco = final + desconto`, exatamente.** A mesma propriedade que `ratear` tem de provar. O arredondamento incide sobre o **desconto**, e não sobre o preço final, para que a subtração feche por construção.
- **Monotonicidade sobre cupom de valor fixo.** A propriedade que pega o clamp escrito como `if (bruto > preco) bruto = 0n` — leitura errada plausível de "o cupom não cabe". **Verificado quebrando a implementação de propósito:** a propriedade da soma e a da faixa **passaram** as duas; só a monotonicidade reprovou.
- **Percentual em pontos-base inteiros.** `0.15` traria IEEE 754 para dois passos de uma `Money` (`19990 * 0.15 = 2998.4999999999995`).

O módulo **não calcula quanto o cliente paga** — produz estimativa rotulada, porque quem cobra é a Stripe (DP-39).

---

## 14 · `tabelas-e-funcoes`

`0042_precos_e_descontos.sql`.

**`precos_vigentes`** — append-only, `(plano, intervalo, vigente_desde)`:

- `stripe_price_id TEXT NOT NULL` — a trava da ADR 0025 D2.
- `valor_centavos BIGINT NOT NULL CHECK (valor_centavos > 0)`, `moeda TEXT NOT NULL DEFAULT 'BRL' CHECK (moeda = 'BRL')`.
- **Sem `UPDATE` para papel nenhum.** Retroatividade tem de ser irrepresentável, e não desencorajada.
- Semeada pela migration com os seis valores da DP-41 — mas `stripe_price_id` é `NOT NULL`, então **a semeadura só roda quando os ids existirem**. Até lá a tabela nasce vazia e a leitura cai no catálogo. O ticket precisa decidir como: coluna anulável na semeadura seria abrir a porta que a D2 fecha.

**`descontos_de_cliente`** — `stripe_coupon_id TEXT NOT NULL`, `tenant_id`, `especie`, `pontos_base` ou `valor_centavos`, `duracao`, `revogado_em`. Append-only com revogação por coluna, nunca `DELETE` (regra 17).

**Funções:** `admin.criar_preco`, `admin.aplicar_desconto`, `admin.revogar_desconto`. GRANT por coluna, como todo o resto do épico do painel — `0039` registra a regra.

**Critérios que não podem faltar:**

1. Nenhum papel do painel tem `UPDATE` em `precos_vigentes`. Teste percorre `information_schema.column_privileges`.
2. `INSERT` sem `stripe_price_id` é recusado **pelo banco**, e o teste afirma a mensagem.
3. Duas linhas com o mesmo `(plano, intervalo, vigente_desde)` violam índice único.
4. A auditoria da criação de preço grava `de` → `para` com o valor anterior — inclusive quando o anterior veio do catálogo e não da tabela.
5. **Cota não tem coluna, não tem rota, não tem tela.** Teste que falha se `precos_vigentes` ganhar qualquer coluna de cota.

---

## 15 · `cliente-stripe` — **blocked**

Interface pequena, três operações: `criarPreco`, `criarCupom`, `aplicarCupomNaAssinatura`.

Módulo profundo atrás de interface pequena, no mesmo formato do `BankSyncProvider` (ADR 0003): **nenhum código de aplicação conhece "Stripe"**. Um dublê em memória implementa a mesma interface e é contra ele que 14, 16 e 17 são testados.

Destrava também a **C-11** e a **DP-39**, que esperam exatamente este cliente. Três pedidos diferentes, uma conta.

---

## 16 · `rotas-do-painel`

`POST /admin/planos/:plano/:intervalo/preco` · `POST /admin/clientes/:tenantId/desconto` · `DELETE …/desconto/:id`.

**A ordem é: Stripe primeiro, banco depois.** Se a chamada falhar, nada é gravado — o operador não consegue produzir um preço que só existe do nosso lado. O teste que importa é o da falha: dublê que rejeita, e a asserção de que **nenhuma linha** foi escrita.

Sem chave configurada, a rota recusa com mensagem que **nomeia o que falta**, no mesmo formato de `MAVIA_ALERTA_OPERACAO`.

---

## 17 · `telas`

Duas: preços dos planos, e desconto dentro da ficha do cliente.

- A estimativa é **rotulada**: *"≈ R$ 169,92 · valor final confirmado pela Stripe"*. A ADR 0025 D1 exige o rótulo, e ele não é decorativo — é o que impede a segunda verdade de entrar pela UI depois de barrada no banco.
- A confirmação de preço mostra **o antes, o depois e a contagem de assinaturas afetadas**, que é sempre zero. Dizer isso em voz alta é metade do controle.
- `docs/design.md` §5 antes de entregar, como todas as outras.

---

## O risco registrado, e o ticket que ele vai gerar

**A fórmula de reembolso da §6.3 usa `preco_mensal_do_plano`.** Com o preço editável, ela precisa usar o preço **contratado** — o da assinatura —, não o vigente. Hoje isso não quebra nada porque a fórmula não existe em código; quando existir, esta nota é o motivo de ela nascer certa.
