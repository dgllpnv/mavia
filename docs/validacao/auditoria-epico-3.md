# Auditoria do épico 3 — Cartão de crédito

- **Data:** 2026-09-02
- **Autor:** `validador-financeiro`
- **Objeto:** o **código entregue**, não a especificação. Commits `2850ba6`, `58aceb2`, `b7014ce`
- **Superfície:** `packages/domain/src/{fatura,parcelamento,balde}.ts` · `apps/api/migrations/0008`–`0012` · `apps/api/src/agregacao/{agregacao,projecao}.ts` · `apps/api/src/cartoes/cartoes.controller.ts`
- **Bateria anterior:** `docs/validacao/bateria-epico-2.md` · respondida em `resposta-lacunas-epico-2.md`, ADR 0021 e ADR 0022

**Veredito: REPROVADO.** Cinco bloqueios, sete ressalvas. Os cinco perdem dinheiro do usuário ou o exibem errado, e nenhum deles é hipotético: todos foram reproduzidos contra Postgres real, com números redondos, e a saída está colada abaixo.

---

## 0. Como esta auditoria foi feita

Linha de base, antes de qualquer sonda:

```
pnpm test
 @mavia/domain     155 passed (11 arquivos)
 @mavia/api        108 passed (6 arquivos)
 @mavia/contracts   12 passed (1 arquivo)
 Tasks: 3 successful, 3 total
```

Sobre essa base rodei duas sondas próprias, uma no domínio (Vitest) e outra contra o Postgres real do `subirPostgres()` (Testcontainers, migrations reais, papéis reais). As sondas estão arquivadas fora da árvore, em `probe-dominio.ts` e `probe-api.ts` do scratchpad da sessão, e **não** foram deixadas no repositório: a suíte continua verde, com a mesma contagem de antes. Os contraexemplos abaixo trazem o trecho que os reproduz.

Cada achado tem: o número que deveria sair, o número que sai, e a linha de código responsável.

---

## 1. Bloqueios

### CT-1 🔴 A compra na fatura aberta some da projeção e do Saldo geral

**A regra.** `CLAUDE.md` §2, regra 8b: *"Saldo, Saldo geral, projeção e `Objetivo` somam lançamentos de `Conta` (por `settled_at`) e **Faturas em aberto (pelo total, no vencimento)**."*

**O que o código faz.** `faturas.total_centavos` nasce `DEFAULT 0` e é escrito por **exatamente uma** instrução em todo o sistema — `UPDATE ... SET total_centavos = v_total` dentro de `fechar_fatura` (`0012_fechamento_de_fatura.sql:43`). Nenhum gatilho o mantém. Portanto **toda fatura no estado `aberta` tem total zero**, e as duas consultas que a somam (`SQL_PROJECAO` item 3 e `saldoGeralDoTenant`) somam zero.

Do outro lado, `sqlBaldes` exclui o lançamento de cartão do eixo caixa por `AND l.conta_id IS NOT NULL` (`agregacao.ts:87`). O resultado é que a compra do ciclo corrente **não existe em lugar nenhum do eixo caixa**: nem como lançamento, nem como fatura.

**Contraexemplo.** Conta com R$ 1.000,00. Cartão fecha 25, vence 5. Fatura de dezembro **aberta**. Uma compra de R$ 300,00 em 10/dez. Projeção até 31/jan — depois, portanto, do vencimento em 05/jan.

| Grandeza | Correto | Obtido |
|---|---:|---:|
| `projetarCaixa(ate = 31/jan)` | **R$ 700,00** | **R$ 1.000,00** |
| `saldoGeralDoTenant().faturasEmAberto` | **−R$ 300,00** | **R$ 0,00** |

```
C1 projecao = 100000 (esperado 70000)
C1 fatura na tabela = { estado: 'aberta', total_centavos: '0' }
C1 saldoGeral.faturasEmAberto = 0
```

**Reprodução.**

```ts
const conta  = /* contas.saldo_inicial_centavos = 100000 */
const fatura = /* faturas: periodo 26/11→26/12, venc 2036-01-05, estado default 'aberta' */
await comprar(cartao, fatura, -30000, '2035-12-10T15:00:00Z')
await projetarCaixa(c, { tenantId, ate: new Date('2036-01-31T00:00:00Z'), contaId: conta, moeda: 'BRL' })
// → 100000n
```

**Agravante.** O comportamento está **congelado como esperado** em `apps/api/test/cartao.test.ts:591` (*"a compra de cartão não entra na projeção da conta"*), cujo comentário diz literalmente *"A fatura ainda está aberta com total zero — o fechamento é que o calcula"* e afirma `expect(projetado.centavos).toBe(50000n)`. O teste prova a metade certa da regra (a compra não desconta a conta) e ratifica a metade errada (a fatura também não). Corrigir CT-1 exige reescrever esse teste, e por isso ele precisa ser tratado como parte do defeito.

**Por que é bloqueio.** Para quem usa cartão, o gasto do ciclo corrente é a maior parte do gasto do mês. "Quanto vou ter na conta em 30 dias" ignora tudo o que foi comprado desde o último fechamento e então **cai de repente** no dia em que a fatura fecha. É a definição de saldo errado na tela.

**Correção mínima.** `total_centavos` da fatura aberta tem de ser derivado, não materializado só no fechamento: ou um gatilho `AFTER INSERT/UPDATE/DELETE ON lancamentos` que o mantém, ou a consulta da projeção soma `lancamentos` da fatura quando `estado = 'aberta'` e usa `total_centavos + pago_centavos` a partir de `fechada`. A segunda mantém a verdade derivada (regra 5) e não cria um segundo número mutável.

---

### CT-2 🔴 Parcelamento coloca duas parcelas na mesma fatura e pula faturas inteiras

**A regra.** Regra 11: *"Parcelamento gera N lançamentos futuros"*, um por ciclo. Regra 10: o lançamento entra na fatura cuja janela contém seu `posted_at`.

**O que o código faz.** `gerarParcelas` calcula a data da parcela *k* como "dia da compra, `k−1` meses adiante, com ancoragem de mês curto" — e a fatura é depois **re-derivada** por `faturaAlvo` a partir dessa data. A composição não é injetora: quando o dia da compra é maior que o `closing_day`, o encolhimento do mês curto joga duas datas de parcela dentro da mesma janela, e a janela seguinte fica vazia.

**Contraexemplo.** Cartão que **fecha dia 30**. Compra de **R$ 1.200,00 em 12x** (R$ 100,00 por parcela) em **31/01/2026**.

| Fatura | Parcelas que caem nela | Cobrança |
|---|---|---:|
| fevereiro | 31/jan **e** 28/fev | **R$ 200,00** |
| março | — | **R$ 0,00** |
| abril | 31/mar **e** 30/abr | R$ 200,00 |
| maio | — | R$ 0,00 |
| junho | 31/mai **e** 30/jun | R$ 200,00 |
| julho | — | R$ 0,00 |
| agosto | 31/jul | R$ 100,00 |
| setembro | 31/ago **e** 30/set | R$ 200,00 |
| outubro | — | R$ 0,00 |
| novembro | 31/out **e** 30/nov | R$ 200,00 |
| dezembro | — | R$ 0,00 |
| janeiro/27 | 31/dez | R$ 100,00 |

**12 parcelas em 7 faturas.** A soma continua exata — R$ 1.200,00 — e é exatamente por isso que nenhum teste de soma pega: o dinheiro está certo e o **fluxo de caixa está errado**, com o dobro cobrado em cinco meses e nada em cinco outros.

**Reprodução** (sonda de domínio):

```ts
const c = { closingDay: 30, dueDay: 10 }
const r = gerarParcelas({ centavos: -120000n, moeda: 'BRL' }, 12, sp(2026, 1, 31))
const alvos = r.valor.map((p) => faturaAlvo(c, p.postedAt))
new Set(alvos.map((a) => a.ano * 12 + a.mes)).size  // → 7, deveria ser 12
```

Saída da varredura (`closingDay` × dia da compra):

```
cd=28 compra dia 29: 1 parcela na mesma fatura
cd=28 compra dia 30: 1 parcela na mesma fatura
cd=28 compra dia 31: 1 parcela na mesma fatura
cd=30 compra dia 31: 5 parcelas na mesma fatura
```

**Agravante.** O teste `apps/api/test/cartao.test.ts:178` chama-se *"gera N parcelas somando exatamente a compra, **uma por fatura**"* e verifica só duas coisas: `sum = -10000` e `count = 3`. Ele **não** verifica que as faturas são distintas, e usa um ciclo (25/5) e um dia de compra (10) que não exercitam a colisão. O título promete a invariante que falta.

**Correção.** A fatura da parcela *k* é `faturaAlvo(ciclo, dataDaCompra)` avançada de `k−1` **competências**, não `faturaAlvo` da data da parcela. A data da parcela continua servindo para exibição e para `posted_at`; quem decide o ciclo é a contagem de faturas, que é injetora por construção.

---

### CT-3 🔴 "Fatura fechada é imutável" só vale para `INSERT`

**O que o código faz.** `fatura_fechada_nao_recebe` é declarado `BEFORE INSERT ON lancamentos` (`0008_cartao.sql:191`). `UPDATE` e soft delete não passam por ele. O total travado por `fechar_fatura` deixa então de ser a soma dos lançamentos da fatura — e ninguém reclama.

**Contraexemplo A — editar o valor.** Fatura fechada com uma compra de R$ 100,00.

```sql
UPDATE lancamentos SET valor_centavos = -99999 WHERE fatura_id = :f;
```

```
C7 UPDATE de valor em fatura fechada = ACEITOU
C7 total travado vs soma real = { total_centavos: '-10000', soma_real: '-99999' }
```

**Contraexemplo B — excluir uma compra.** Fatura fechada com R$ 100,00 + R$ 50,00 = R$ 150,00. Soft delete da compra de R$ 100,00:

```
C9 soft delete em fatura fechada = ACEITOU
C9 total travado vs soma viva = { total_centavos: '-15000', soma_viva: '-5000' }
```

A fatura continua cobrando **R$ 150,00** enquanto as compras vivas somam **R$ 50,00** — e `registrar_pagamento_de_fatura` aceita alegremente o pagamento de R$ 150,00, porque valida contra `total_centavos` e nunca contra os lançamentos. **R$ 100,00 saem da conta sem lançamento que os justifique.**

Isto viola a regra 5 (saldo é derivado, nunca um campo mutável isolado): `total_centavos` é exatamente esse campo, e não há reconciliação que o compare com o derivado.

**Correção.** Estender o gatilho para `UPDATE` — recusando alteração de `valor_centavos`, `posted_at`, `fatura_id` e `deleted_at` em lançamento de fatura não `aberta` — e adicionar o par ao job de reconciliação: `Σ lancamentos vivos da fatura = total_centavos` para toda fatura fechada. Divergência é incidente.

---

### CT-4 🔴 Fatura credora vira dinheiro na conta, e o produto deixa "pagá-la"

Este é o caso 6 do escopo — o estorno de compra de cartão, que o `arquiteto-dominio-financeiro` classificou como *"o estorno mais comum que existe"* (`resposta-lacunas-epico-2.md` §3, L10). Ele está representável e está errado em dois lugares.

**Contraexemplo.** Conta com R$ 1.000,00.

1. Novembro: compra de R$ 100,00 no cartão. Fatura fecha em −10000 e é paga em 05/dez com as duas pernas. Conta: **R$ 900,00**.
2. Dezembro: o lojista devolve os R$ 100,00. O estorno cai na fatura **aberta** de dezembro, que não tem outras compras. Fecha com `total_centavos = +10000` — a fatura é **credora**.

| Grandeza | Correto | Obtido |
|---|---:|---:|
| projeção antes do reembolso | R$ 900,00 | R$ 900,00 ✅ |
| projeção depois do reembolso | **R$ 900,00** | **R$ 1.000,00** |
| `registrar_pagamento_de_fatura(+10000)` | recusar | **aceito** |
| projeção depois de "pagar" o crédito | **R$ 900,00** | **R$ 800,00** |

```
C2b projecao ANTES do reembolso = 90000 (esperado 90000)
C2b total da fatura de dezembro = 10000 (credito)
C2b projecao DEPOIS do reembolso = 100000 (deveria continuar 90000)
C2b "pagar" uma fatura CREDORA foi aceito? = true
C2b projecao depois de "pagar" o credito = 80000
```

**Dois defeitos distintos, um cenário.**

1. `SQL_PROJECAO` soma `f.total_centavos + f.pago_centavos` sem restringir o sinal. Um crédito no cartão **não** é dinheiro que vai cair na conta: ele fica no cartão e abate a próxima fatura. Somá-lo à conta promete R$ 100,00 que não chegarão.
2. `registrar_pagamento_de_fatura` valida com `v_pago + p_valor > abs(v_total)`. O `abs()` apaga o sinal, e uma fatura credora de +10000 aceita um "pagamento" de 10000, marca `estado = 'paga'`, e a transferência tira R$ 100,00 reais da conta. O `CHECK pago_nao_excede_total` também usa `abs` dos dois lados e não impede nada.

A distância entre o correto (R$ 900,00) e o obtido no fim do cenário (R$ 800,00) é de **R$ 200,00** numa sequência de três operações que qualquer usuário de cartão faz.

**Correção.** A projeção soma faturas apenas na parte **devedora**: `least(total + pago, 0)`. E o pagamento recusa fatura cujo saldo devedor não seja negativo, com erro nomeado — `FATURA_NAO_TEM_SALDO_DEVEDOR`. O crédito do cartão é assunto do próximo ciclo, e o desenho para levá-lo adiante é decisão do `product-financeiro`, não do gatilho.

---

### CT-5 🔴 `settled_at` aceita data futura, vinda do relógio do cliente

**A regra.** Regra 8: *"`settled_at` é o fato: só é gravado quando o dinheiro se move, é nulo até lá, e **nunca recebe data futura**"*. Regra 9: *"Data de negócio nunca vem do relógio do cliente."*

**O que o código faz.** `zPagarFatura.pagoEm` é um `z.string().datetime()` sem limite superior; o controlador faz `const quando = new Date(d.pagoEm)` e grava esse valor em `settled_at` das duas pernas **e** em `settled_at` de todos os lançamentos da fatura quitada. A única restrição do esquema é `compensacao_nao_antecede_competencia` (`settled_at >= posted_at`), que não olha para o presente.

**Contraexemplo.** Fatura de R$ 100,00 fechada. `POST /v1/cartoes/faturas/:id/pagamentos` com `pagoEm: "2099-01-01T12:00:00Z"`:

```
C8 pagamento com settled_at em 2099 = ACEITOU
C8 saldo derivado HOJE = { saldo: '90000' } (esperado 100000 ate 2099)
```

O saldo cai R$ 100,00 **hoje** por um pagamento datado em 2099, porque todo predicado de caixa do sistema é `settled_at IS NOT NULL` — nunca `settled_at <= agora`. E a fatura passa a `paga`, saindo da projeção.

**Correção.** `CHECK (settled_at <= now())` não serve para dado importado com atraso de relógio, mas a borda serve: o controlador recusa `pagoEm` no futuro comparando com o **relógio do servidor**, com folga declarada, e o contrato documenta a regra. Vale também para `POST /v1/lancamentos` — a mesma porta existe lá.

---

## 2. Ressalvas

### CT-6 🟠 `data_fechamento` gravada e devolvida com um dia a mais

`abrirFatura` calcula `const fecha = new Date(janela.fim.getTime() - 1)` e grava `dia(fecha)`, onde `dia = (d) => d.toISOString().slice(0, 10)` — leitura em **UTC** de um instante cujo dia civil é de São Paulo. O último instante da janela é 23:59:59.999 em SP, que em UTC já é o dia seguinte.

| Ciclo | Competência pedida | Fecha de fato | `data_fechamento` gravada |
|---|---|---|---|
| 25/5 | 2035-12 | **25/12/2035** | `2035-12-26` |
| 25/5 | 2026-02 | 25/02/2026 | `2026-02-26` |
| 5/15 | 2026-04 | 05/04/2026 | `2026-04-06` |

Vale para **todo** cartão e **toda** fatura: a data de fechamento é sempre o dia seguinte ao real. O helper de teste `criarFatura` (`cartao.test.ts:26`) repete a mesma expressão, então a suíte não distingue.

Correção: `formatarDataCivil(dataCivilDe(new Date(janela.fim.getTime() - 1)))`, que já existe no domínio e lê no fuso.

### CT-7 🟠 `competencia` significa duas coisas na mesma requisição

`POST /v1/cartoes/:id/faturas` recebe `{ano, mes}` e o usa como **competência do ciclo** (é o que `janelaDaFatura` consome). Grava, porém, `competencia = mês do vencimento` — e devolve esse valor no mesmo nome de campo.

```
POST { ano: 2035, mes: 12 }   ciclo 25/5
  → janela 26/11 → 26/12   (a fatura de dezembro)
  → resposta { competencia: "2036-01-01" }
```

`faturaAlvo`, que é a função que diz em qual fatura a compra cai, devolve a competência do **ciclo** — `{2035, 12}`. Quem casar lançamento com fatura pela coluna `competencia` vai procurar `2035-12-01` e não achar nada, ou achar a fatura errada. Hoje ninguém faz esse casamento (ver CT-12), o que degrada o achado de bloqueio para ressalva — mas as duas convenções coexistem sem tradutor, com o mesmo nome, e a próxima fatia vai escolher uma delas ao acaso.

Correção: nomes distintos. `competencia_do_ciclo` e `mes_de_vencimento`, ou uma só convenção declarada em `CONTEXT.md`. O glossário hoje não decide.

### CT-8 🟠 Vencimento pode empatar com o fechamento, e o teste que deveria pegar isso testa cinco pares

`vencimentoDaFatura` compara `dueDay > closingDay` sobre os dias **brutos**, e só depois ancora no mês. A ancoragem é `min(dia, últimoDiaDoMês)`, que é monótona mas **não estritamente** monótona: dois dias distintos colapsam no mesmo.

| Ciclo | Competência | Fechamento | Vencimento |
|---|---|---|---|
| 30/31 | abril/2026 | 30/04 | **30/04** |
| 30/31 | fevereiro/2026 | 28/02 | **28/02** |
| 29/30 | fevereiro/2026 | 28/02 | **28/02** |
| 28/31 | fevereiro/2026 | 28/02 | **28/02** |

Uma compra às 22h do dia 30/04 entra numa fatura que venceu naquele mesmo dia — contra o comentário do próprio código: *"Igual conta: fechar e vencer no mesmo dia significaria pagar antes de saber o total."*

Combinado com CT-6, o ciclo 30/31 em fevereiro grava `data_fechamento = 2026-03-01` e `data_vencimento = 2026-02-28`: **o vencimento fica dois dias antes do fechamento na mesma linha**, e nenhum `CHECK` da tabela `faturas` compara os dois.

O teste `o vencimento é sempre posterior ao fechamento` (`fatura.test.ts:135`) percorre cinco pares escolhidos à mão — `[1,2] [25,5] [15,15] [31,1] [5,28]` — e uma única competência (junho/2026). A varredura completa (31 × 31 pares × 14 meses) devolve 12 violações só nas primeiras posições. Isto é uma propriedade: pede `fast-check` ou a varredura exaustiva, que custa 600 ms.

Correção: comparar as datas **ancoradas**, não os dias brutos, e adicionar `CONSTRAINT vencimento_apos_fechamento CHECK (data_vencimento > data_fechamento)`.

### CT-9 🟠 A fronteira do vencimento é avaliada em UTC, não em São Paulo

`SQL_PROJECAO` filtra `f.data_vencimento <= $2::date`, com `$2` um `timestamptz` e a sessão em UTC. Regra 7 exige que as bordas de janela sejam calculadas em `America/Sao_Paulo` antes da comparação.

**Contraexemplo.** Fatura de R$ 100,00 vencendo em **06/03**. Projeção "até agora", às **23h00 de 05/03** em São Paulo (= 06/03 02h00 UTC):

```
C6 projecao ate 05/03 23h SP = 90000 (esperado 100000)
```

A fatura de amanhã entra na projeção de hoje. Erro de um dia, sempre no mesmo sentido, nas três horas finais de todo dia.

### CT-10 🟠 As datas devolvidas pela API dependem do fuso do processo Node

`dia()` também é aplicado às colunas `DATE` (`competencia`, `data_fechamento`, `data_vencimento`) nas rotas `faturas` e `abrirFatura`. O driver `pg` converte `DATE` em `Date` na **meia-noite local do processo**; `toISOString()` volta para UTC. Em qualquer fuso a leste de Greenwich, a data volta um dia:

```
TZ = America/Sao_Paulo | local = Sat Jan 05 2036 00:00:00 GMT-0300 | dia() = 2036-01-05
TZ = Europe/Berlin     | local = Sat Jan 05 2036 00:00:00 GMT+0100 | dia() = 2036-01-04
TZ = Asia/Tokyo        | local = Sat Jan 05 2036 00:00:00 GMT+0900 | dia() = 2036-01-04
```

Latente enquanto a VPS estiver no Brasil, e é exatamente o tipo de defeito que aparece na primeira migração de servidor. Correção: `pg.types.setTypeParser(1082, (v) => v)` — `DATE` chega como a string `YYYY-MM-DD` que já é, e nenhuma conversão acontece.

### CT-11 🟡 Fatura de total zero não tem estado terminal

Estorno integral dentro do mesmo ciclo — compra de R$ 200,00 e reembolso de R$ 200,00 na mesma fatura:

```
C2 total após estorno total = 0
C2 tentativa de quitar fatura zerada = PAGAMENTO_EXCEDE_A_FATURA
C2 estado final = { estado: 'fechada', n: '2' }   // 2 lançamentos sem settled_at
```

A fatura fica `fechada` **para sempre**: `p_valor <= 0` é recusado e `v_pago + p_valor > abs(0)` recusa qualquer valor positivo. Ela permanece no conjunto "em aberto" (`estado <> 'paga'`) do índice `faturas_eixo_caixa`, da projeção e do Saldo geral — contribuindo zero, então sem erro aritmético — e os dois lançamentos nunca ganham `settled_at`.

Não perde dinheiro. Suja o produto: uma fatura eternamente pendente na lista, e um par de lançamentos eternamente sem compensação. Precisa de uma transição declarada — `paga` com `pago = 0` quando `total = 0`, ou um estado `quitada_sem_pagamento`.

### CT-12 🟡 Escopo: nenhuma rota cria compra de cartão nem parcelamento

`gerarParcelas` **não é chamado por nenhum código de aplicação** — só por testes. `faturaAlvo` é importado por `cartoes.controller.ts` e reexportado na última linha do arquivo (`export { faturaAlvo }`) sem nenhum uso no controlador. Não há endpoint que crie um lançamento de cartão, atribua `fatura_id`, abra as faturas futuras de um parcelamento ou grave um `parcelamentos`.

Consequência para esta auditoria: as regras 10 e 11 **não são exercitáveis pelo produto**. Tudo que verifiquei nelas foi verificado no domínio e em SQL direto, que é onde os testes entregues também operam. Registro para que "épico 3 entregue" não seja lido como "o usuário consegue lançar uma compra parcelada".

---

## 3. O que passou — e como foi verificado

Nada aqui é leitura de código: cada linha é uma medição.

### Ciclo de fatura

| Verificação | Resultado |
|---|---|
| Janelas contíguas, 24 meses × `closingDay` de 1 a 31 (744 janelas) | ✅ `fim(k) === inicio(k+1)` em todas; nenhuma janela vazia ou invertida |
| Cobertura total, amostra **horária** de 24 meses, `closingDay ∈ {1,5,25,28,29,30,31}` (≈ 122 mil instantes) | ✅ todo instante em **exatamente uma** fatura; `faturaAlvo` sempre concorda com a janela que o contém |
| Compra às **23h59** do dia do fechamento (SP) | ✅ entra na fatura que fecha naquele dia |
| Compra às **00h01** do dia seguinte | ✅ cai na fatura seguinte |
| **Fechamento dia 31 em fevereiro** | ✅ ancora em 28/02; 28/02 23h59 → fatura de fevereiro, 01/03 00h01 → fatura de março |
| Vencimento igual ao fechamento (`dueDay === closingDay`) | ✅ vai para o mês seguinte — mas ver **CT-8** para os pares que empatam por ancoragem |

A contiguidade é estrutural, e isso é mérito do desenho: `inicio` e `fim` saem da **mesma** função `diaSeguinteAoFechamento`, então `fim(c) = inicio(c+1)` por igualdade e não por "o instante seguinte". Não há como abrir buraco sem reescrever a função.

### Parcelamento

| Verificação | Resultado |
|---|---|
| Soma exata, `N` de 1 a 60 × 7 valores (`−10000`, `−10001`, `−9999`, `−999`, `−123457`, `+50000`, `−100`) | ✅ `Σ parcelas = valor` em todos os 420 casos |
| `max − min <= 1` centavo entre parcelas | ✅ em todos |
| Resto nas **primeiras** parcelas | ✅ R$ 100,00 em 3x → `−3334, −3333, −3333` |
| **31/jan em 3x** | ✅ `31/01, 28/02, 31/03` — sem arrasto |
| **31/jan em 12x** | ✅ volta a 31 sempre que o mês permite; termina em 31/12 |
| **31/jan em 13x** | ✅ 13ª parcela em `2027-01-31` |
| **29/fev/2028 em 13x** | ✅ 1ª em `2028-02-29`, 2ª em `2028-03-29`, 13ª em `2029-02-28` |
| Parcelamento indivisível | ✅ `−11` em 12x recusado (`parcelamento-indivisivel`); `−12` em 12x aceito, 1 centavo por parcela |
| Sinal preservado | ✅ compra negativa gera parcelas negativas |

O rateio está correto e a ancoragem de data está correta. O que quebra é a **composição** com o ciclo — CT-2.

### Pagamento de fatura

| Verificação | Resultado |
|---|---|
| O pagamento não aparece como despesa em **nenhum** balde | ✅ mês do pagamento, eixo competência: `receita 0 · despesa 0 · transferencia 0 · nao_analitica 0` |
| A compra continua no mês da competência dela | ✅ fevereiro, eixo competência: `despesa −10000` — uma vez, não duas |
| Perna de crédito fora da fatura | ✅ `cartao_tem_fatura` recusa `cartao_id NOT NULL AND transfer_group_id NOT NULL AND fatura_id NOT NULL` |
| Duas pernas, soma zero, recipientes distintos | ✅ `transferencia_equilibrada` (corrigido em `0009` para conta → cartão) |
| **Pagamento parcial** | ✅ R$ 60,00 de R$ 100,00 → `parcialmente_paga`, e **nada** compensa |
| Soma de parciais quita | ✅ 6000 + 4000 → `paga`, e os lançamentos compensam **na data do segundo** pagamento |
| **Pagamento que excede** | ✅ 10001 sobre 10000 → `PAGAMENTO_EXCEDE_A_FATURA` (mas ver CT-4 para a fatura credora) |
| Pagar antes de fechar | ✅ `FATURA_AINDA_ABERTA` |
| Fechar duas vezes | ✅ `FATURA_JA_FECHADA` — recusa, não idempotência silenciosa |
| `INSERT` retroativo em fatura fechada | ✅ `FATURA_FECHADA_NAO_RECEBE` (mas ver CT-3 para `UPDATE`) |

**Dupla contagem fatura × perna de débito — o ponto 3 do escopo.** Verificado com R$ 100,00 de fatura e R$ 60,00 pagos, conta com R$ 1.000,00:

```
C5 estado = parcialmente_paga
C5 projecao = 90000 (esperado 90000)   ✅
```

`total + pago = −10000 + 6000 = −4000` e a perna de débito já tirou 6000. Soma: 90000. **A aritmética que impede a dupla contagem está certa**, e está certa por construção — chega a zero na quitação sem depender de um `if` sobre o estado. É a melhor decisão do épico.

### A compra que não sai do bolso

| Verificação | Resultado |
|---|---|
| Lançamento de cartão nunca tem `conta_id` | ✅ `uma_origem_de_dinheiro CHECK (num_nonnulls(conta_id, cartao_id) = 1)` |
| Lançamento de cartão nasce sem `settled_at` | ✅ só `registrar_pagamento_de_fatura` o escreve, e só na quitação |
| Compra fora do eixo caixa | ✅ `AND l.conta_id IS NOT NULL` no universo da agregação, **antes** da partição |
| Compra fora da projeção da conta | ✅ |
| Fatura na projeção pelo **saldo devedor** e não pelo total | ✅ para fatura `fechada`/`parcialmente_paga`; ❌ para fatura `aberta` (**CT-1**) e para fatura credora (**CT-4**) |

O ponto 4 do escopo, portanto, está **meio certo**: a compra está corretamente fora do eixo caixa; a fatura só está corretamente dentro dele depois de fechada e enquanto for devedora.

### O balde novo

| Verificação | Resultado |
|---|---|
| `Ajuste de saldo` é criável | ✅ o gatilho `lancamento_coerente` reescrito em `0010` já não recusa categoria não analítica; `0011` semeia por gatilho em `tenants`, e não só nas linhas existentes |
| Entra no saldo | ✅ |
| Fica fora do relatório de gasto | ✅ balde `nao_analitica`, nunca `despesa` |
| Todo balde aparece, mesmo zerado | ✅ os quatro em toda resposta |

Medição, conta com R$ 1.000,00 + salário R$ 500,00 − mercado R$ 200,00 − ajuste R$ 50,00:

```
C4 baldes: { receita: '50000/0', despesa: '-20000/0', transferencia: '0/0', nao_analitica: '-5000/0' }
C4 saldoAnterior = 100000
C4 identidade = 125000 (esperado 125000)   ✅
```

`saldoAnterior + Σ(realizada + prevista) = saldo final`, ao centavo. O `Ajuste de saldo` move o saldo e **não** entra na despesa — que era o furo B1 um nível abaixo, e está fechado. O agrupamento `GROUP BY 1` sobre o `CASE`, em vez de uma coluna por balde, faz o balde novo aparecer sozinho: acrescentar um quinto não exige lembrar de nada. Boa decisão.

**Uma observação, não um achado:** no eixo **caixa**, o balde `transferencia` do mês do pagamento marca `−10000`, não zero, porque a perna do cartão foi excluída do universo. Está **certo** para o saldo — é o que de fato saiu do caixa, e é o que faz a identidade fechar — mas significa que `transferencia` tem leituras diferentes nos dois eixos: soma zero em competência, saída líquida em caixa. Isso não está escrito em lugar nenhum. Pertence ao `CONTEXT.md`, verbete **Balde**, antes de a interface rotular a linha.

---

## 4. Resumo dos números

| # | Achado | Contraexemplo | Correto | Obtido | Erro |
|---|---|---|---:|---:|---:|
| CT-1 | Compra na fatura aberta some da projeção | R$ 300,00 na fatura aberta | 70000 | 100000 | **R$ 300,00** |
| CT-2 | Parcelas colidem na mesma fatura | R$ 1.200,00 em 12x, 31/jan, fecha 30 | 12 faturas | 7 faturas | **R$ 100,00/mês** |
| CT-3 | Fatura fechada aceita `UPDATE` | soft delete de R$ 100,00 | −5000 | −15000 cobrados | **R$ 100,00** |
| CT-4 | Fatura credora vira dinheiro e é "paga" | reembolso de R$ 100,00 | 90000 | 80000 | **R$ 200,00** |
| CT-5 | `settled_at` no futuro | `pagoEm: 2099-01-01` | 100000 hoje | 90000 hoje | **R$ 100,00** |
| CT-6 | `data_fechamento` +1 dia | cartão que fecha 25 | `2035-12-25` | `2035-12-26` | 1 dia |
| CT-7 | `competencia` com dois significados | `POST {2035,12}` | `2035-12-01` | `2036-01-01` | 1 mês |
| CT-8 | Vencimento empata com fechamento | ciclo 30/31, abril | venc > fech | 30/04 = 30/04 | — |
| CT-9 | Fronteira do vencimento em UTC | 23h de 05/03, venc 06/03 | 100000 | 90000 | **R$ 100,00** |
| CT-10 | `DATE` lida no fuso do processo | `TZ=Europe/Berlin` | `2036-01-05` | `2036-01-04` | 1 dia |
| CT-11 | Fatura zerada sem estado terminal | estorno integral | terminal | `fechada` eterna | — |
| CT-12 | Nenhuma rota cria compra ou parcelamento | — | — | — | escopo |

---

## 5. Veredito

# REPROVADO

**Bloqueios — nenhum merge antes de todos os cinco:**

1. **CT-1** — a compra do ciclo corrente não existe na projeção nem no Saldo geral. Exige corrigir o código **e** reescrever `cartao.test.ts:591`, que congela o comportamento errado.
2. **CT-2** — parcelamento com `closing_day` 28, 29 ou 30 e compra nos dias 29 a 31 cobra duas parcelas num mês e nenhuma no seguinte.
3. **CT-3** — `UPDATE` e soft delete atravessam a imutabilidade da fatura fechada; o total cobrado descola das compras.
4. **CT-4** — fatura credora entra na projeção como dinheiro na conta e aceita pagamento, que tira dinheiro de verdade.
5. **CT-5** — `settled_at` no futuro, escolhido pelo cliente, derruba o saldo hoje.

**Ressalvas — corrigir antes do épico 4, não bloqueantes para o merge se os cinco acima caírem:** CT-6, CT-7, CT-8, CT-9, CT-10, CT-11, CT-12.

**O que este épico acertou, e vale registrar:** a janela semiaberta com as duas bordas saindo da mesma função (contiguidade por igualdade, verificada em 122 mil instantes); o `EXCLUDE` com `tstzrange` no banco em vez de conferência na aplicação; `total + pago` chegando a zero na quitação, que impede a dupla contagem por aritmética e não por `if`; o rateio com resto nas primeiras parcelas, exato em 420 casos; e o `GROUP BY` sobre o balde, que faz o enum exaustivo do ADR 0022 valer em SQL e não só em TypeScript.

O padrão dos cinco bloqueios é um só, e vale mais que a lista: **o épico modelou muito bem o instante em que o dinheiro se move, e mal o intervalo em que ele está prometido.** Fatura aberta, fatura credora, fatura editada depois de fechada e pagamento datado no futuro são todos o mesmo buraco visto de quatro ângulos — o estado intermediário entre "comprei" e "paguei", que é onde o usuário de cartão passa a maior parte do mês.

---

## 6. Encaminhamentos

| Para | O quê |
|---|---|
| `engenheiro-backend` | CT-1 a CT-5 (bloqueios), CT-6, CT-9, CT-10. Migration forward-only para o gatilho de `UPDATE` (CT-3) e o `CHECK` de vencimento (CT-8) |
| `engenheiro-qa-automacao` | Congelar como propriedades permanentes: **(a)** `Σ faturas de um parcelamento = N` faturas distintas e consecutivas, `fast-check` sobre `closingDay × diaDaCompra`; **(b)** `vencimento > fechamento` para os 961 pares × 24 competências; **(c)** `total_centavos = Σ lançamentos vivos` para toda fatura não aberta; **(d)** projeção com fatura aberta. Reescrever `cartao.test.ts:591` e o título de `cartao.test.ts:178`, que promete "uma por fatura" e não verifica |
| `arquiteto-dominio-financeiro` | CT-7 (duas convenções de `competencia`, uma só palavra no glossário) · CT-11 (estado terminal da fatura de total zero) · o destino do **crédito de cartão** entre ciclos, que CT-4 expõe e que o modelo hoje não tem |
| `product-financeiro` | O que a tela mostra entre o fechamento e o pagamento, e o que acontece com um cartão que deve ao usuário |
| `arquiteto-solucao` | CT-12: onde entram as rotas de compra e de parcelamento, e quem abre as faturas futuras de um 12x |
