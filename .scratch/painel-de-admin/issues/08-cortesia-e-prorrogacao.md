Status: ready-for-agent
Blocked by: 05

# 08 · `cortesia_ate`, `origem_da_ultima_escrita` e o tempo concedido pelo operador

## Objetivo

Depois deste ticket o operador concede tempo a um cliente sem tocar `periodo_fim` — o campo que o webhook sobrescreve —, e toda escrita em `assinaturas` passa a dizer quem a fez. `fim_efetivo` vira a leitura normativa do fim do direito de uso, e `atualizado_em` deixa de depender de alguém lembrar.

## A seção do spec que governa

- **§8.4 (F-12, F-13)** — `periodo_fim` **não entra em `GRANT` nenhum**; o tempo concedido vive em `cortesia_ate`; `fim_efetivo = greatest(periodo_fim, coalesce(cortesia_ate, periodo_fim))` é **normativo**; duas funções e não uma, com teto e razão.
- **§8.6 (F-15)** — `origem_da_ultima_escrita`, escrita por **todo** caminho que toca `assinaturas`, e por que ela entra agora mesmo sem o job existir.
- **Modelo de dados** — o `ALTER TABLE assinaturas` com as três colunas (duas colunas e uma `CHECK`), e o gatilho `assinaturas_atualizado_em` (F-16).
- **§8.3** — por que `plano` e `intervalo` continuam no `GRANT` de `mavia_admin_contrato` e **nenhuma função os escreve**.

## O que entra, e onde

**Migration `0033_assinatura_cortesia_e_origem.sql`.**

1. ```sql
   ALTER TABLE assinaturas
     ADD COLUMN cortesia_ate             TIMESTAMPTZ,
     ADD COLUMN origem_da_ultima_escrita TEXT NOT NULL DEFAULT 'stripe'
         CHECK (origem_da_ultima_escrita IN ('stripe','painel','cliente','sistema')),
     ADD CONSTRAINT cortesia_depois_do_periodo
         CHECK (cortesia_ate IS NULL OR cortesia_ate > periodo_inicio);
   ```
2. `CREATE TRIGGER assinaturas_atualizado_em BEFORE UPDATE ON assinaturas FOR EACH ROW EXECUTE FUNCTION tocar_atualizado_em();`
3. `CREATE OR REPLACE FUNCTION auth.aplicar_estado_da_assinatura(…)` marcando `origem_da_ultima_escrita = 'stripe'`. **Migration é forward-only; a `0025` não é editada.** A função existe hoje em `0025_assinatura.sql:169-190`, escrevendo `estado`, `graca_ate`, `periodo_fim` e `atualizado_em` (`:179-185`) e nada mais.
4. `GRANT UPDATE (cortesia_ate, origem_da_ultima_escrita) ON assinaturas TO mavia_admin_contrato` — completando a lista que o ticket 01 abriu. **`periodo_fim` e `periodo_inicio` continuam fora.**
5. `admin.prorrogar_teste(…)` e `admin.conceder_cortesia(…)` — dono `mavia_admin_contrato`, `SET search_path`, duas linhas novas em `FUNCOES_DE_ADMIN`.
6. `cobranca.controller.ts` — a rota de troca de plano do cliente passa a marcar `origem_da_ultima_escrita = 'cliente'` (hoje ela escreve `plano`, `intervalo` e `atualizado_em` em `:133-138`).

**Código:** `fim_efetivo` no domínio (`packages/domain`), e as duas rotas `POST /v1/admin/clientes/:tenantId/teste/prorrogar` e `POST /v1/admin/clientes/:tenantId/cortesia`, cada uma com a sua chave em `ROTAS_DE_ADMIN`.

**Os tetos, padrão vigente:**

| Função | Estado exigido | Escreve | Teto |
|---|---|---|---|
| `admin.prorrogar_teste` | `estado = 'teste'` | `cortesia_ate` | **uma vez por Tenant**, no máximo **+7 dias** — o mesmo prazo da DP-15, e não mais que ele |
| `admin.conceder_cortesia` | `estado ∈ {ativa, em_atraso, cancelada}` | `cortesia_ate` | **+30 dias por chamada, +60 acumulados** no mesmo período. Exige `razao` (texto livre, obrigatório), que vai na linha de auditoria |

`estado = 'expirada'` é **recusado nas duas**.

## Critérios de aceite

**Domínio** (property-based, `fast-check`)

1. `fim_efetivo = greatest(periodo_fim, coalesce(cortesia_ate, periodo_fim))`: **nunca** menor que `periodo_fim`; monótono não-decrescente em `cortesia_ate`; e **igual** a `periodo_fim` quando a cortesia é nula.

**Esquema**

2. `estado`, `graca_ate`, `cortesia_ate` e `origem_da_ultima_escrita` estão no `GRANT` de `mavia_admin_contrato` e **em nenhum outro papel do painel**; `mavia_admin_escrita` **não tem `UPDATE` em `assinaturas`**.
3. **`periodo_fim` e `periodo_inicio` não aparecem em `GRANT` de nenhum papel do painel** — nem por coluna, nem por tabela. *Reafirmação do ticket 01 depois do `ALTER`, porque é aqui que a tentação aparece.*
4. `assinaturas` tem o gatilho `BEFORE UPDATE` de `atualizado_em`, e ele dispara **também** para o webhook: um `UPDATE` que **não mencione** a coluna a atualiza mesmo assim.
5. Nenhuma das funções de `admin` contém `UPDATE … SET plano` ou `SET intervalo` no corpo (`pg_get_functiondef`) — reafirmado com as duas funções novas.
6. `FUNCOES_DE_ADMIN` continua exato, com `prorrogar_teste` e `conceder_cortesia` na família `contrato`, donas de `mavia_admin_contrato`.

**Integração** (Postgres real)

7. Prorrogar o teste escreve `cortesia_ate` e **não altera `periodo_fim`**, comparado antes e depois. A **segunda** prorrogação do mesmo Tenant é recusada, e **mais de 7 dias** também.
8. Conceder cortesia num tenant `expirada` é **recusado**; em `ativa`, escreve `cortesia_ate` e **não toca `periodo_fim`**; acima de **30 dias por chamada** ou **60 acumulados**, recusado.
9. **O webhook não apaga a cortesia:** conceder 60 dias, entregar um `invoice.payment_succeeded` com `current_period_end` anterior, e `cortesia_ate` continua **intacto** — `aplicar_estado_da_assinatura` escreve `periodo_fim`, e `fim_efetivo` continua o maior dos dois.
10. Toda escrita de contrato deixa `origem_da_ultima_escrita = 'painel'`, e o webhook deixa `'stripe'`. *Sem isso, o job de reconciliação do épico 11 trata cada atendimento como incidente.*
11. `cortesia_ate` anterior ou igual a `periodo_inicio` é **rejeitado pelo banco** (`cortesia_depois_do_periodo`).
12. As duas funções rodam **na primeira execução** contra o esquema recém-migrado, pelo pool de escrita — sem `permission denied` de esquema, de tabela, de `concessoes_de_admin` ou de `auditoria`.
13. Chamar qualquer das duas **sem** `admin.abrir_espaco_para_escrita` levanta erro; com `p_alvo` diferente do `app.tenant_id` aberto, levanta erro também.
14. Cada uma deixa **duas** linhas de `auditoria` com a mesma `correlacao`, a de efeito com `de`/`para` preenchidos e iguais ao antes e depois lidos na tabela. Uma escrita que falha deixa **zero**. A `razao` de `conceder_cortesia` aparece na linha.
15. **Nenhuma escrita do painel cria `Lancamento`:** contagem de `lancamentos`, `transferencias`, `contas`, `faturas` e `saldo_snapshots` idêntica antes e depois de uma cortesia.

## Armadilhas conhecidas

- **F-12 · O webhook sobrescreve `periodo_fim`.** `auth.aplicar_estado_da_assinatura` faz `periodo_fim = coalesce(p_periodo_fim, periodo_fim)` (`0025_assinatura.sql:182`), com o valor vindo de `current_period_end` do evento (`cobranca.controller.ts:237`, e `fimDoPeriodo` em `:299-302`). O operador concede 60 dias; na próxima fatura os 60 dias **somem sem uma linha de auditoria**, porque quem escreveu foi `mavia_auth`, no caminho do webhook, que não passa pelo log do painel. **Não conceda `UPDATE (periodo_fim)` a nenhum papel do painel, por nenhum motivo.**
- **F-13 · Num tenant em `teste`, "adicionar tempo" é literalmente o `UPDATE` vetado.** `CONTEXT.md:407` e `spec-planos:456` dizem que prorrogar é *"operação nomeada e auditada, nunca um `UPDATE` solto"* — e **na implementação o fim do teste é `periodo_fim`**: o gatilho grava `now() + interval '7 days'` ali (`0025_assinatura.sql:78-79`), e **não existe coluna `teste_termina_em`**. Quem procurar a coluna do glossário no banco não a encontra, e a "correção óbvia" é exatamente a invariante violada.
- **`estado = 'expirada'` é recusado nas duas.** Dar tempo a quem já expirou é reativar sem pagamento, que é a transição `reativou` (`catalogo.ts:183`) e é **ato do titular** na tela de cobrança. É a mesma recusa de §8.1, pelo mesmo motivo.
- **`fim_efetivo` é normativo, e é a metade que decide se a cortesia vale alguma coisa.** Todo caminho que decidir expiração — o job do 8º dia, o de fim de graça, o de fim de período, **quando existirem** — lê `fim_efetivo`, **nunca `periodo_fim` cru**. O critério 1 é o único controle contra a cortesia evaporar em silêncio no dia em que o job nascer.
- **Honestidade que precisa estar no ticket: hoje nenhum job expira nada.** As quatro transições de tempo — `prazo_de_teste_acabou`, `graca_acabou`, `periodo_terminou`, `reativou` — existem em `catalogo.ts:163-185` e no teste dele, **e em nenhum outro lugar do repositório**. O único consumidor de `transicao()` em runtime é o webhook (`cobranca.controller.ts:228`). "Adicionar tempo" é, neste instante, uma escrita que muda o que o cliente lê e não muda o que o sistema faz. A coluna entra agora mesmo assim, porque (a) ela é o que impede o `UPDATE` vetado de F-13 já no primeiro ticket e (b) acrescentá-la depois exigiria descobrir, linha a linha, quais `periodo_fim` haviam sido esticados à mão — a migração de dado de cliente pagante que `spec-planos:62` manda evitar.
- **F-16 · `atualizado_em` fora do `GRANT` e escrita por todo caminho existente.** `cobranca.controller.ts:135` na troca de plano do cliente, `0025_assinatura.sql:183` no webhook — e ela sai na exportação. Sem gatilho, ou a escrita do painel falha na coluna, ou omite-a e a linha exportada **mente sobre quando foi tocada**. A coluna permanece na lista de `mavia_admin_contrato` só para que um `UPDATE` que a mencione não estoure por privilégio; **o valor que vale é o do gatilho**.
- **`origem_da_ultima_escrita` entra agora porque não dá para acrescentá-la depois (§8.6).** Uma coluna de origem criada no dia do job precisa de um valor para as linhas já escritas, e esse valor é uma **adivinhação sobre quem escreveu o quê** — exatamente a informação que ela existe para não perder. E ela é escrita por **todo** caminho, não só pelo painel: sem o `CREATE OR REPLACE` do webhook, o `DEFAULT 'stripe'` mente a partir da segunda escrita do cliente.
- **`plano` e `intervalo` estão no `GRANT` e nenhuma função os escreve (§8.3).** A coluna existe no privilégio para que a emenda futura não precise de nova migration de papel; o critério 5 é o que impede alguém de "aproveitar" o privilégio.
- **`GRANT` de dono (`bootstrap-papeis.sql:36-44`)**: o `GRANT UPDATE` por coluna desta migration roda como `mavia_migrate`. O critério 2 é quem pega o `WARNING` silencioso.

## Decisões pendentes que este ticket toca

- **DP-38** — *cortesia é dinheiro?* **Padrão vigente: não, e por isso ela é tempo, medido em dias e nunca em centavos.** É o que este ticket implementa. `docs/decisoes-do-produto.md:141` ainda registra a forma fraca do parecer (`valor_centavos = 0` em `pagamentos_manuais`); o spec v3.2 a rejeita por escrito. **Se o dono quiser o valor concedido como número**, ele é **derivado** do plano e dos dias na tela, nunca uma coluna de dinheiro. Ver `README.md`.
- **DP-39** — *o painel escreve na Stripe, ou no nosso banco com marca de origem?* **Sem padrão vigente — é a única das cinco assim, e depende de a chave de API da Stripe existir (P-14).** Este ticket entrega a **coluna** nos dois casos, porque acrescentá-la depois exige adivinhar. **Enquanto DP-39 não for respondida, F-15 não fecha, e o painel não alcança cliente real (C-11).** Se a resposta for **A** (o painel escreve na Stripe), nada muda no job e a coluna vira registro; se for **B**, o job do épico 11 precisa **reconhecer** `origem_da_ultima_escrita = 'painel'` e reconciliar em favor da nossa linha dentro de uma janela declarada — e essa exceção a *"a correção segue a Stripe"* (`spec-planos:579`) tem de ser escrita **naquele spec**, não neste.
- **DP-40** — *o painel troca o plano?* **Padrão vigente: não neste épico.** Nada aqui o implementa.

## O que este ticket não faz

- Não escreve `periodo_fim` nem `periodo_inicio`, por nenhum caminho.
- Não cria job de expiração nenhum — não existe nenhum, e continua não existindo.
- Não implementa o job de reconciliação do épico 11, que também não existe. F-15 é uma colisão **marcada**, não um incidente de hoje.
- Não cria `pagamentos_manuais` (ticket 07) nem `cadastrar_cliente` (09).
