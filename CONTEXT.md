# CONTEXT — Linguagem ubíqua da Mavia

Este é o glossário do domínio. **Nome no código = nome no banco = nome na UI = nome aqui.** Se um termo não está aqui, ele não existe no projeto ainda — adicione-o antes de usá-lo.

Mantido pelo `arquiteto-dominio-financeiro` via `/domain-modeling`.

---

## Núcleo monetário

**Money** — Value object. Inteiro de centavos (`bigint`) + moeda ISO 4217. Imutável. Toda aritmética monetária passa por ele. Operações entre moedas distintas lançam erro. _Nunca_ use `number` para dinheiro.

**Rateio (allocate)** — Divisão de uma `Money` em N partes cuja soma é exatamente igual ao total. O resto em centavos é distribuído nas primeiras partes. Base de parcelamento e de divisão de despesa.

**Sinal** — Convenção do domínio: **despesa é negativa, receita é positiva**. O sinal vive no valor, não num campo de tipo separado. Somar uma lista de lançamentos dá o resultado líquido sem nenhum `if`.

---

## Entidades

**Tenant** — Unidade de isolamento. Uma assinatura, um espaço de dados. Toda tabela de negócio referencia `tenant_id`, protegida por Row-Level Security. Um Tenant pode ter vários Usuários.

**Usuario** — Pessoa autenticada. Pertence a um ou mais Tenants com um Papel.

**Papel** — `proprietario` (tudo, inclusive billing), `membro` (lança e consulta), `visualizador` (só leitura). Base do compartilhamento familiar.

**Conta** — Onde o dinheiro repousa. Tipos: `corrente`, `poupanca`, `dinheiro`, `investimento`, `digital`, `outra`. Tem saldo inicial e moeda. **Não** inclui cartão de crédito.

**Cartao** — Cartão de crédito. Não é Conta: não guarda dinheiro, acumula dívida. Tem `limite`, `closing_day` (dia de fechamento) e `due_day` (dia de vencimento). Vinculado a uma Conta de pagamento padrão.

**Lancamento** — O átomo do sistema. Um movimento de dinheiro: valor (`Money` com sinal), Categoria, Conta **ou** Cartao, `posted_at`, `effective_at`, descrição, `status`. Nunca é editado destrutivamente — alterações passam pelo audit log.

**Status de lançamento** — `previsto` (agendado, ainda não aconteceu), `pendente` (aconteceu, não compensou), `efetivado` (compensado). Só `efetivado` conta no saldo realizado; `previsto` alimenta a projeção.

**Transferencia** — Movimento entre duas Contas próprias. **Materializada como dois Lancamentos** (uma perna negativa, uma positiva) unidos por `transfer_group_id`. Não é receita nem despesa — não aparece em relatório de gastos. A soma das pernas é sempre zero.

**Fatura** — Ciclo de cobrança de um Cartao. Tem janela (`periodo_inicio`, `periodo_fim`), `data_fechamento`, `data_vencimento` e um estado. Agrega os Lancamentos do Cartao cujo `posted_at` cai na janela.

**Estado de fatura** — `aberta` (recebendo lançamentos), `fechada` (janela encerrada, valor travado), `paga`, `parcialmente_paga`, `vencida`.

**Pagamento de fatura** — **É uma Transferencia** da Conta para o Cartao, nunca uma despesa. Contá-la como despesa duplicaria o gasto — o erro mais comum da categoria.

**Parcelamento** — Compra dividida em N Lancamentos futuros, unidos por `installment_group_id`, cada um com `installment_number` e `installment_total`. Gerados no momento da compra, um por Fatura futura. O resto do rateio vai na primeira parcela.

**Recorrencia** — Regra que gera Lancamentos repetidos (salário, aluguel, assinatura). Guarda a regra, não as ocorrências; um job materializa as ocorrências dentro de um horizonte. Editar a regra não reescreve o passado.

**Categoria** — Classificação de Lancamento. Hierarquia de dois níveis (categoria → subcategoria). Tem `natureza` (`receita` ou `despesa`), cor e ícone. Categorias do sistema podem ser renomeadas mas não excluídas.

**Etiqueta (Tag)** — Classificação transversal e livre, ortogonal à Categoria. Um Lancamento tem uma Categoria e N Etiquetas.

**Limite (Budget)** — Teto de gasto por Categoria num período. Compara previsto e realizado, dispara alerta em percentuais configuráveis.

**Meta** — Objetivo de acúmulo com valor-alvo e prazo, associado a uma Conta ou virtual. Distinta de Limite: Limite restringe saída, Meta persegue entrada.

**Saldo** — Sempre **derivado** da soma dos Lancamentos efetivados de uma Conta. `SaldoSnapshot` é um materializado por conta/dia para performance, reconciliado por job. Snapshot divergente do derivado é incidente.

**Projecao** — Saldo futuro = saldo atual + Lancamentos `previsto` até uma data. Não é persistida.

---

## Ingestão bancária

**BankSyncProvider** — A interface única por onde todo dado bancário externo entra. Nenhum código de aplicação conhece o provider concreto. Ver `docs/adr/0003`.

**Adapter de sincronização** — Implementação concreta do `BankSyncProvider`: `manual`, `ofx-import`, `csv-import`, `pluggy` (previsto). Trocar de agregador é adicionar um arquivo.

**Conexao** — Vínculo autorizado entre um Tenant e uma instituição financeira, através de um adapter. Guarda credenciais cifradas, escopo consentido e validade.

**Consentimento** — Autorização explícita, versionada e com prazo, dada pelo Usuario para acessar dados de uma instituição. Revogável a qualquer momento; revogação interrompe a sincronização e dispara a política de retenção. Exigência do Open Finance **e** da LGPD.

**Sincronizacao** — Execução de um adapter contra uma Conexao. Registra início, fim, resultado e quantos Lancamentos foram criados, atualizados ou ignorados por duplicidade.

**LancamentoBruto** — Registro cru como veio da fonte, antes de virar Lancamento. Preservado para auditoria e reprocessamento. Chave de idempotência: `(tenant_id, provider, external_id)` + hash de conteúdo.

**Deduplicacao** — Regra que impede o mesmo LancamentoBruto de virar dois Lancamentos. Nunca depende só da descrição.

**Conciliacao** — Casamento entre um Lancamento importado e um lançado à mão pelo Usuario. Produz uma **sugestão**; o Usuario confirma. O sistema jamais apaga o registro do Usuario sozinho.

**Categorizacao automatica** — Atribuição de Categoria a um Lancamento por regra do Usuario, histórico do Tenant ou modelo. Sempre reversível, sempre com o motivo visível.

---

## Termos proibidos

Não use — geram ambiguidade e bugs reais:

| Não use | Use | Por quê |
|---|---|---|
| `transaction` | `Lancamento` | Colide com transação de banco de dados |
| `amount: number` | `Money` | Ponto flutuante em dinheiro é defeito, não estilo |
| `balance` como coluna mutável | `SaldoSnapshot` | Deixa claro que é derivado |
| `date` | `posted_at` / `effective_at` | Colapsar competência e efetivação quebra o cartão |
| `card account` | `Cartao` | Cartão não guarda dinheiro |
| `transfer` como um lançamento | `Transferencia` (duas pernas) | Uma perna só desequilibra o sistema |
| `user` como dono de dados | `Tenant` | Isolamento é por Tenant, não por Usuario |
| `delete` | `deleted_at` | Dado financeiro não some |
