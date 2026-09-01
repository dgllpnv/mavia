# ADR 0005 — Dinheiro em centavos inteiros e transferência por partida dobrada

- **Status:** Aceita
- **Data:** 2026-09-01

## Contexto

O produto inteiro existe para mostrar números corretos. Duas decisões de modelagem determinam se isso é possível, e ambas são caras de reverter depois que existem dados de clientes.

**Ponto flutuante.** `0.1 + 0.2` não é `0.3` em IEEE 754. Num extrato de milhares de lançamentos, isso vira centavos perdidos que ninguém consegue explicar — e "o app está errado" é fatal para um produto financeiro.

**Transferência.** É tentador modelar como um lançamento com um campo de conta destino. Isso quebra na primeira pergunta séria: a transferência aparece no relatório de despesas? Aparece na conta de origem, na de destino, ou nas duas? Pagamento de fatura de cartão — que é uma transferência — vira despesa e dobra o gasto do mês. Esse é o erro clássico da categoria.

## Decisão

**1. Dinheiro é inteiro de centavos, encapsulado num value object.**

`Money` guarda `bigint` de centavos e moeda ISO 4217. Imutável. `BIGINT` no Postgres. Toda aritmética monetária passa por ele — inclusive somas em SQL, que operam sobre centavos inteiros. Operação entre moedas diferentes lança erro. Nenhum `number`, `float` ou `NUMERIC` implícito em caminho monetário.

Divisão usa `allocate`, com distribuição do resto: a soma das partes é **exatamente** igual ao total, com o resto indo nas primeiras partes.

Sinal vive no valor — despesa negativa, receita positiva — não num enum de tipo. Somar uma lista dá o líquido correto sem nenhum condicional.

**2. Transferência é sempre duas pernas.**

Débito numa conta, crédito na outra, unidos por `transfer_group_id`. A soma das pernas é sempre zero. Transferência não aparece em relatório de receita nem de despesa. **Pagamento de fatura é uma transferência** da conta para o cartão.

**3. Saldo é derivado.**

Verdade é a soma dos lançamentos efetivados. `SaldoSnapshot` existe apenas como materialização para desempenho, com job de reconciliação comparando snapshot e derivado. Divergência é incidente com alerta, nunca correção silenciosa.

## Consequências

**Positivas.** Não há classe de bug de arredondamento por representação. O relatório sempre fecha, porque transferências se anulam por construção. Pagamento de fatura não pode ser contado como despesa — o modelo impede. Auditoria é possível: todo saldo é reproduzível a partir dos lançamentos.

**Negativas.** `bigint` exige cuidado na serialização JSON (é enviado como string no contrato). Toda operação passa pelo value object, o que é mais verboso que somar números soltos — e é exatamente o ponto. Duas pernas por transferência dobram as linhas dessa operação e exigem que toda consulta de gasto as exclua explicitamente. Saldo derivado exige o snapshot e o job de reconciliação para ter desempenho aceitável.

## Verificação

Property-based testing é **obrigatório** aqui, com fast-check. Exemplo escolhido a dedo não prova propriedade aritmética. As propriedades mínimas estão listadas em `.claude/agents/engenheiro-qa-automacao.md` e a bateria completa de invariantes em `.claude/agents/validador-financeiro.md`.

## Alternativas rejeitadas

**`NUMERIC`/`DECIMAL` do Postgres com biblioteca decimal.** Correto do ponto de vista aritmético, mas depende de disciplina em toda a cadeia: um `parseFloat` numa borda quebra tudo, e a borda JS não tem decimal nativo. Inteiro de centavos falha ruidosamente em vez de silenciosamente.

**Transferência como lançamento único com conta destino.** Menos linhas, modelo mais simples de escrever. Rejeitado: torna impossível responder consistentemente sobre relatórios e produz a duplicação de gasto no pagamento de fatura.

**Saldo como coluna mutável.** Muito mais rápido de ler. Rejeitado: diverge silenciosamente sob concorrência e retry, e é irreconciliável depois. O snapshot dá o desempenho sem abrir mão da verdade derivada.
