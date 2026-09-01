# CONTEXT — Linguagem ubíqua da Mavia

Este é o glossário do domínio. **Nome no código = nome no banco = nome na UI = nome aqui.** Se um termo não está aqui, ele não existe no projeto ainda — adicione-o antes de usá-lo.

Mantido pelo `arquiteto-dominio-financeiro` via `/domain-modeling`.

**Convenção de nomes de campo.** Conceito de domínio em português (`Lancamento`, `Fatura`, `natureza`, `competencia`). Os campos temporais fixados pelas regras inegociáveis do `CLAUDE.md` permanecem em inglês (`posted_at`, `effective_at`, `closing_day`, `due_day`, `deleted_at`, `*_group_id`) — renomeá-los seria re-litigar regra aceita. Campo novo nasce em português.

**Invariantes.** Cada entidade declara as suas. Elas são escritas para virar teste direto — se uma invariante não pode ser expressa como asserção, ela está mal escrita.

---

## Núcleo monetário

**Money** — Value object. Inteiro de centavos (`bigint`) + moeda ISO 4217. Imutável. Toda aritmética monetária passa por ele. Operações entre moedas distintas lançam erro. _Nunca_ use `number` para dinheiro.

**Rateio (allocate)** — Divisão de uma `Money` em N partes cuja soma é exatamente igual ao total. O resto em centavos é distribuído nas primeiras partes. Base de parcelamento e de divisão de despesa.

**Sinal** — Convenção do domínio: **despesa é negativa, receita é positiva**. O sinal vive no valor, não num campo de tipo separado. Somar uma lista de lançamentos dá o resultado líquido sem nenhum `if`.

---

## Tempo e competência

**Competencia** — O mês de calendário ao qual um número é atribuído, em `America/Sao_Paulo`. Representada como `DATE` fixada no dia 1. É a unidade de agregação de todo relatório e de todo `Planejamento`.

> **Invariantes**
> - `competencia` sempre tem `dia = 1`.
> - A competência de um instante é calculada convertendo o instante para `America/Sao_Paulo` **antes** de extrair mês e ano. Nunca a partir do UTC nu.
> - O domínio nunca usa offset fixo (`-03:00`). Sempre a zona IANA — o Brasil já teve horário de verão e pode voltar a ter.

**posted_at** — Competência do `Lancamento`: quando o fato econômico aconteceu. É o campo que decide em qual `Fatura` uma compra de cartão cai e em qual competência ela aparece no relatório. Imutável depois de criado.

**effective_at** — Efetivação: quando o dinheiro de fato saiu ou entrou do caixa. Em `Lancamento` de `Conta`, é escrito quando o lançamento compensa. Em `Lancamento` de `Cartao`, é **derivado** da `Fatura` — ver ADR 0007.

**Base temporal (BaseTemporal)** — Qual das referências de tempo de um lançamento de cartão o relatório usa para atribuí-lo a uma competência: `data_compra`, `data_parcela` (padrão) ou `data_fatura`. Só afeta lançamentos de `Cartao`. Ver ADR 0007.

**Ciclo de faturamento** — A regra recorrente de um `Cartao`: `closing_day` e `due_day`. Gera as janelas. Não é uma entidade — é a configuração que as produz.

**Janela da Fatura** — O intervalo concreto de uma `Fatura`, `(periodo_inicio, periodo_fim]`, fechado à direita: uma compra **no dia exato do fechamento** entra na fatura que fecha naquele dia. Ver ADR 0007.

---

## Entidades

**Tenant** — Unidade de isolamento. Uma assinatura, um espaço de dados. Toda tabela de negócio referencia `tenant_id`, protegida por Row-Level Security. Um Tenant pode ter vários Usuários.

**Usuario** — Pessoa autenticada. Pertence a um ou mais Tenants com um Papel.

**Papel** — `proprietario` (tudo, inclusive billing), `membro` (lança e consulta), `visualizador` (só leitura). Base do compartilhamento familiar.

**Origem** — Procedência do dado de uma `Conta` ou de um `Cartao`: `manual` (o Usuario mantém) ou `conectado` (um adapter do `BankSyncProvider` mantém). **Não é uma classe de conta** — é de onde vêm os lançamentos. Uma conta `conectado` não aceita edição destrutiva de lançamentos importados; ver `Conciliacao`.

**Conta** — Onde o dinheiro repousa. Tem saldo inicial, moeda, `tipo`, `origem` e `incluir_no_saldo_geral`. **Não** inclui cartão de crédito.

- `tipo` — `corrente`, `poupanca`, `dinheiro`, `investimento`, `digital`, `outra`. **Mantemos o tipo**, contra o modelo do Organizze, que só tem nome e ícone. Motivo: sem tipo é impossível separar *dinheiro disponível* de *patrimônio investido* no relatório, e uma conta de investimento inflando o número principal do produto faz o número mentir. O tipo é **rótulo de relatório e ícone padrão** — nunca entra em aritmética, nunca infere sinal, nunca decide sozinho o que soma no saldo geral.
- `incluir_no_saldo_geral` — Booleano. Decide se a conta entra no **Saldo geral**. É escolha do Usuario; o `tipo` apenas define o valor **inicial** (`investimento` nasce `false`, todos os demais nascem `true`).

> **Invariantes**
> - `moeda` é imutável depois que a Conta tem qualquer `Lancamento`.
> - `incluir_no_saldo_geral = false` **nunca** altera o saldo da própria Conta, só a soma do Saldo geral.
> - Mudar `tipo` nunca muda saldo, sinal, nem `incluir_no_saldo_geral` já persistido.
> - Conta com `origem = conectado` tem uma `Conexao` associada; `origem = manual` não tem.

**Cartao** — Cartão de crédito. Não é Conta: não guarda dinheiro, acumula dívida. Tem `limite`, `closing_day`, `due_day`, `origem` e uma Conta de pagamento padrão. **Não tem `incluir_no_saldo_geral`** — não tem saldo para incluir.

> **Invariantes**
> - `closing_day` e `due_day` ∈ [1, 31]. Em mês que não tem o dia, a data é **fixada no último dia do mês** (`min(dia, ultimo_dia_do_mes)`), sem propagar o ajuste para o mês seguinte.
> - Se `due_day <= closing_day`, o vencimento cai no **mês seguinte** ao do fechamento.
> - A Conta de pagamento padrão pertence ao mesmo Tenant e tem a mesma moeda do Cartao.

**Lancamento** — O átomo do sistema. Um movimento de dinheiro: valor (`Money` com sinal), Categoria, Conta **ou** Cartao, `posted_at`, `effective_at`, descrição, `status`. Nunca é editado destrutivamente — alterações passam pelo audit log.

> **Invariantes**
> - Aponta para exatamente uma Conta **ou** um Cartao. Nunca zero, nunca ambos.
> - `valor.moeda` = moeda da Conta ou do Cartao.
> - `valor ≠ 0`.
> - `posted_at` é imutável.
> - `status = efetivado ⟺ effective_at != null`.
> - Se aponta para um Cartao, pertence a exatamente uma `Fatura`.

**Status de lançamento** — `previsto` (agendado, ainda não aconteceu), `pendente` (aconteceu, não compensou), `efetivado` (compensado). Só `efetivado` conta no **Realizado**; `previsto` alimenta o **Projetado**.

**Realizado** — Soma dos Lancamentos `efetivado` de um recorte. **Projetado** — Realizado + os `previsto` do mesmo recorte. O par realizado × projetado é o eixo conceitual dos relatórios e do `Planejamento`. Nunca some os dois na mesma linha.

**Transferencia** — Movimento entre duas Contas próprias. **Materializada como dois Lancamentos** (uma perna negativa, uma positiva) unidos por `transfer_group_id`. Não é receita nem despesa — não aparece em relatório de gastos nem em `Planejamento`. A soma das pernas é sempre zero.

**Fatura** — Ciclo de cobrança de um Cartao. Tem `periodo_inicio`, `periodo_fim`, `data_fechamento`, `data_vencimento`, `competencia` e um estado. Agrega os Lancamentos do Cartao cuja janela contém seu `posted_at`.

> **Invariantes**
> - `competencia` da Fatura é o mês de `data_vencimento` — o mês em que o Usuario paga. Uma fatura que fecha em 25/set e vence em 05/out tem competência **outubro**.
> - As janelas de um Cartao são contíguas e não se sobrepõem: `periodo_inicio` de uma fatura é o instante seguinte ao `periodo_fim` da anterior.
> - `periodo_inicio < periodo_fim <= data_fechamento <= data_vencimento`.
> - O total de uma Fatura `fechada` ou `paga` é imutável.
> - Todo Lancamento de Cartao pertence a exatamente uma Fatura.

**Estado de fatura** — `aberta` (recebendo lançamentos), `fechada` (janela encerrada, valor travado), `paga`, `parcialmente_paga`, `vencida`.

**Pagamento de fatura** — **É uma Transferencia** da Conta para o Cartao, nunca uma despesa. Contá-la como despesa duplicaria o gasto — o erro mais comum da categoria.

**GrupoDeParcelamento** — A compra parcelada como objeto, dona dos fatos que pertencem à **compra**, não a cada parcela: `data_compra`, `valor_total`, `installment_total` e a descrição original. Os N Lancamentos filhos apontam para ele por `installment_group_id`, cada um com seu `installment_number`.

> **Invariantes**
> - Soma dos `valor` dos N filhos = `valor_total`, exatamente. O resto do rateio vai na **primeira** parcela.
> - `installment_number` ∈ [1, N], sem lacuna e sem repetição.
> - `data_compra` é o mesmo fato para as N parcelas — persistido **uma vez**, no grupo. Nunca copiado para os filhos.
> - `data_compra <= posted_at` de toda parcela.
> - Parcela 1 tem `posted_at = data_compra`. As demais avançam mês a mês a partir de `data_compra`, com o dia fixado em `min(dia_da_compra, ultimo_dia_do_mes)` **sem arrastar o ajuste**: compra em 31/jan em 3x gera 31/jan, 28/fev, **31**/mar.
> - Excluir o grupo exclui as N parcelas (soft delete). Excluir uma parcela isolada é proibido.

**Parcelamento** — A operação que cria um `GrupoDeParcelamento` e seus N Lancamentos. Gerados no momento da compra, um por Fatura futura.

**Recorrencia** — Regra que gera Lancamentos repetidos (salário, aluguel, assinatura). Guarda a regra, não as ocorrências; um job materializa as ocorrências dentro de um horizonte. Editar a regra não reescreve o passado.

**Categoria** — Classificação de Lancamento. Hierarquia de dois níveis (categoria → subcategoria). Tem `natureza` (`receita` ou `despesa`), cor, ícone e `arquivada_em`.

- `arquivada_em` — Timestamp de arquivamento. **Arquivar não é excluir.** Categoria arquivada some dos seletores e da cópia de `Planejamento`, mas continua classificando todo o histórico e continua aparecendo em relatórios do passado. `deleted_at` continua existindo e continua sendo o mecanismo de exclusão — os dois campos coexistem e significam coisas diferentes.

> **Invariantes**
> - Subcategoria tem a mesma `natureza` da categoria-pai.
> - Hierarquia tem no máximo dois níveis: uma subcategoria não tem filhas.
> - Arquivar uma categoria-pai arquiva as subcategorias.
> - Categoria arquivada não pode receber Lancamento novo; os existentes permanecem intactos.
> - Categorias do sistema podem ser renomeadas e arquivadas, nunca excluídas.

**Etiqueta (Tag)** — Classificação transversal e livre, ortogonal à Categoria. Um Lancamento tem uma Categoria e N Etiquetas. **Chama-se Etiqueta na UI e `Tag` no código, sempre — nunca "marcador".**

**Planejamento** — Valor esperado para uma Categoria numa Competencia. Substitui **Limite** e a **meta de receita mensal** — o piso mensal por categoria, que era o espelho exato do Limite. **Não** substitui o objetivo de acúmulo plurimensal: esse é `Objetivo`, entidade própria. O sinal do `valor` carrega a direção: valor negativo é **teto** de despesa, valor positivo é **piso** de receita. Ver ADR 0008.

- `natureza` (`teto` | `piso`) — **derivada** do sinal de `valor`, nunca persistida. Existe para rotular a UI.
- `categoria_id` — Opcional. Preenchido, o escopo é a Categoria. Nulo, é um **Planejamento global**: o sinal define a abrangência (negativo cobre toda despesa do mês, positivo cobre toda receita).
- `alertas_percentuais` — Percentuais de `consumo` em que o domínio emite evento. Padrão `[80, 100]`.

**Precedência hierárquica** — Os escopos formam três níveis: **global → categoria-raiz → subcategoria**. Um Planejamento num nível superior agrega o realizado de tudo abaixo dele; um de nível inferior é um sub-teto legítimo, e o mesmo lançamento conta nos dois. Para não haver contagem dupla, o **total planejado** soma, em cada caminho da hierarquia, apenas o Planejamento de **nível mais alto** que existir naquela competência.

> **Invariantes**
> - `dentro_do_plano ⟺ realizado >= valor`, com o sinal do domínio, para teto e piso igualmente. Sem nenhum `if` sobre natureza.
> - `consumo = realizado / valor`, positivo em ambos os casos.
> - Com `categoria_id` preenchido, `sinal(valor)` concorda com `Categoria.natureza`: despesa ⟹ negativo, receita ⟹ positivo. Discordância é estado inválido, não aviso.
> - Com `categoria_id` nulo não há Categoria contra a qual conferir: o sinal **define** o escopo em vez de ser conferido por ele.
> - `valor ≠ 0`.
> - No máximo um Planejamento por `(tenant_id, categoria_id, competencia)` não excluído.
> - No máximo um Planejamento global **de cada natureza** por `(tenant_id, competencia)`. `NULL` não colide em índice único no Postgres — isso exige dois índices únicos parciais sobre o sinal, não a constraint natural.
> - Transferencia nunca entra no realizado de um Planejamento.
> - O realizado de um Planejamento usa **sempre** a base temporal `data_parcela`, independentemente da preferência de relatório do Usuario.
> - O total planejado de um mês nunca soma dois Planejamentos do mesmo caminho da hierarquia: nunca global com raiz, nunca raiz com subcategoria.

**Copiar planejamento** — Operação que replica os Planejamentos de uma competência para outra.

> **Invariantes**
> - Idempotente: executar duas vezes produz o mesmo conjunto.
> - Não destrutiva: só cria Planejamento para categoria que **não tem** um na competência de destino. Nunca sobrescreve valor editado pelo Usuario.
> - Ignora categorias com `arquivada_em` preenchido no momento da cópia.
> - Copia o valor literalmente. Sem correção monetária, sem projeção.

**Objetivo** — Acúmulo de um valor até uma data: *"juntar R$ 12.000 até dezembro"*. É **plurimensal e com prazo**, e por isso não é um `Planejamento` — que é mensal e por competência. Substitui o termo **Meta**, aposentado por ambiguidade. Tem `nome`, `valor_alvo`, `prazo` (opcional), `saldo_base` e `concluido_em`.

- `valor_alvo` — `Money` **sempre positivo**. Objetivo é um **estoque-alvo**, não um fluxo: a convenção de sinal do ADR 0005 governa movimentos, e um alvo de acúmulo não tem direção a codificar.
- `prazo` — `DATE` em `America/Sao_Paulo`, **opcional**. Sem prazo, o Objetivo nunca vence — é o caso da reserva de emergência.
- **Modo de apuração**, derivado de `conta_id`, nunca persistido como enum:
  - **Ancorado** (`conta_id` preenchido) — `progresso = saldo(conta) - saldo_base`, onde `saldo_base` é um `Money` **capturado e armazenado** na criação. Nunca recalculado: lançamento retroativo muda o saldo do passado, e um `saldo_base` derivado faria o progresso mudar sozinho.
  - **Por aportes** (`conta_id` nulo) — `progresso = Σ valor` dos Lancamentos ligados por `Aporte`.
- **Estado**, derivado: `concluido` se `concluido_em != null`; senão `vencido` se `prazo != null && prazo < hoje`; senão `ativo`.
- **Prazo vencido sem atingir o alvo: nada acontece.** O Objetivo passa a `vencido`, sai da lista de ativos, é preservado intacto e o domínio emite `ObjetivoVencido`. Não exclui, não estende sozinho, **não gera Lancamento** — Objetivo nunca move dinheiro.

> **Invariantes**
> - `valor_alvo > 0`.
> - Ancorado: `valor_alvo.moeda = conta.moeda`. Por aportes: `valor_alvo.moeda` = moeda base do Tenant, e todo Lancamento aportado tem essa moeda. Sem conversão silenciosa, nunca.
> - `prazo`, quando informado, é `>= hoje` **no momento da escrita**. Um Objetivo cujo prazo passou pelo tempo é `vencido`, não inválido — a validação é de escrita, não de leitura.
> - `progresso` **não é limitado** ao alvo: pode passar de 100% e pode ficar negativo se houver resgate. A UI pode travar a barra; o domínio devolve o número real.
> - `concluido_em` é gravado na **primeira** vez que `progresso >= valor_alvo` e é **fixo**: resgate posterior reduz o progresso e não desfaz a conclusão. Atingir foi um fato histórico.
> - Reduzir `valor_alvo` para valor já alcançado conclui o Objetivo na hora. **Aumentar** `valor_alvo` acima do progresso **limpa** `concluido_em` e devolve o Objetivo a `ativo` — a fixidez protege contra queda de progresso, não contra redefinição deliberada do alvo.
> - Um Objetivo ancorado não excluído **bloqueia** o soft delete da sua Conta. Para excluir a Conta, exclua o Objetivo antes. O progresso nunca é congelado num campo.
> - Objetivo nunca cria, altera ou exclui `Lancamento`.

**Aporte** — Vínculo entre um `Lancamento` e um `Objetivo` por aportes. O progresso é a soma dos valores vinculados, com o sinal do domínio: a perna positiva de uma Transferencia soma, a negativa (resgate) subtrai. Sem `if`, sem campo de tipo.

> **Invariantes**
> - Um Lancamento pertence a no máximo um Objetivo.
> - Só existe em Objetivo por aportes. Objetivo ancorado não aceita Aporte — seu progresso já é o saldo da Conta, e aceitar os dois contaria o mesmo dinheiro duas vezes.
> - Vincular ou desvincular um Aporte nunca altera o `valor`, a Categoria ou o `status` do Lancamento.

**Saldo** — Sempre **derivado** da soma dos Lancamentos `efetivado` de uma Conta. Cartao não tem saldo — tem dívida em fatura.

**Saldo geral** — Soma dos saldos das Contas com `incluir_no_saldo_geral = true`, na moeda base do Tenant. É o número principal do produto.

> **Invariantes**
> - Contas de moedas diferentes só entram no Saldo geral após conversão explícita e datada. Somar moedas distintas lança erro.
> - Alterar `incluir_no_saldo_geral` muda o Saldo geral e nada mais.

**SaldoSnapshot** — Materialização de `(conta_id, dia) → saldo`, existente apenas para desempenho. Reconciliado por job contra o derivado. Divergência é incidente, não warning.

**Projecao** — Saldo futuro = saldo atual + Lancamentos `previsto` até uma data. Não é persistida.

---

## Ingestão bancária

**BankSyncProvider** — A interface única por onde todo dado bancário externo entra. Nenhum código de aplicação conhece o provider concreto. Ver `docs/adr/0003`.

**Adapter de sincronização** — Implementação concreta do `BankSyncProvider`: `manual`, `ofx-import`, `csv-import`, `pluggy` (previsto). Trocar de agregador é adicionar um arquivo.

**Conexao** — Vínculo autorizado entre um Tenant e uma instituição financeira, através de um adapter. Guarda credenciais cifradas, escopo consentido e validade. Cria Contas e Cartoes com `origem = conectado`.

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
| "a data" de um lançamento de cartão | `data_compra` · `posted_at` · `Fatura.competencia` | São três bases distintas; "a data" não existe |
| `purchase_date` no `Lancamento` | `GrupoDeParcelamento.data_compra` | Repetir o fato em N linhas permite que N linhas divirjam |
| `card account` | `Cartao` | Cartão não guarda dinheiro |
| `transfer` como um lançamento | `Transferencia` (duas pernas) | Uma perna só desequilibra o sistema |
| `user` como dono de dados | `Tenant` | Isolamento é por Tenant, não por Usuario |
| "espaço" | `Tenant` | Vocabulário do Organizze; um sinônimo a mais é um bug a mais |
| `delete` | `deleted_at` | Dado financeiro não some |
| "arquivar" como sinônimo de excluir | `arquivada_em` ≠ `deleted_at` | Arquivar tira do seletor; excluir tira do sistema |
| "marcadores" | `Etiqueta` / `Tag` | Dois nomes para a mesma coisa — a inconsistência real do Organizze |
| `Limite` como entidade | `Planejamento` | Teto e piso mensais são o mesmo mecanismo; duas entidades duplicam CRUD, alerta e cópia |
| `Meta` | `Planejamento` (piso mensal) · `Objetivo` (acúmulo com prazo) | Um nome para dois conceitos de horizonte diferente. A ambiguidade quase apagou o acúmulo do modelo — foi preciso um veto para recuperá-lo |
| `objetivo.progresso` como coluna | soma derivada (saldo − `saldo_base`, ou Σ Aportes) | Progresso é saldo; saldo é derivado (ADR 0005) |
| `saldo_base` recalculado | `saldo_base` capturado e armazenado | Lançamento retroativo faria o progresso mudar sozinho |
| `natureza` persistida no `Planejamento` | sinal de `valor` | Enum e sinal podem se contradizer — estado inválido representável |
| `pago: boolean` | `status` | Receita não é "paga", e o booleano apaga o estado `pendente` |
| `Conta.tipo` para decidir saldo ou sinal | `incluir_no_saldo_geral` · sinal do valor | Tipo é rótulo de relatório, nunca aritmética |
| "saldo geral" = soma de todas as contas | soma das que têm `incluir_no_saldo_geral` | O número principal do produto tem exceções por desenho |
| "conta conectada" como tipo de Conta | `Conta.origem = conectado` | Origem é procedência do dado, não classe de conta |
