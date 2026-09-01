# ADR 0019 — `BankSyncProvider.revogar()`: a revogação como ato técnico dos dois lados

- **Status:** Aceita
- **Data:** 2026-09-01
- **Autor:** `arquiteto-solucao` + `especialista-open-finance` (decisão conjunta exigida pela DP-10)
- **Emenda:** ADR 0003. **Não o substitui** — ver §"O que do ADR 0003 continua valendo".
- **Complementa:** ADR 0018 (§D0, §D8) · `docs/compliance/retencao-e-eliminacao.md` §10 · regra 13 e regra 19 do `CLAUDE.md`
- **Resolve:** **DP-10** de `retencao-e-eliminacao.md` §11 · R-15 e R-14 da §12 · achado B-15 do gate de risco
- **Pressupõe decidido:** **DP-9** (dono do produto, 2026-09-01): *os dados já sincronizados permanecem e param de atualizar*
- **Documentos irmãos:** `docs/arquitetura/sistema.md` §1.4 (módulo `ingestao`) e §2.2 (seam **S3**)

> **Nota de numeração.** `sistema.md` §7 lista uma decisão futura sob o número 0019 (política de conflito offline). Aquela lista é uma proposta de pauta, não uma reserva de número; este ADR ocupa o 0019 porque foi escrito primeiro. A decisão de conflito offline continua pendente e receberá o próximo número livre.

---

## Contexto

O ADR 0003 pôs toda a ingestão bancária atrás de uma interface única, `BankSyncProvider`, para que trocar de agregador fosse escrever um arquivo. A interface cobriu o caminho de entrada — conectar, sincronizar, receber arquivo, promover bruto — e **não cobriu a saída.**

`retencao-e-eliminacao.md` §10.2 encontrou o buraco e o descreveu na única frase que importa:

> **Sem isso, a Mavia deixa de usar o acesso, mas o acesso continua existindo no agregador** — o que é a definição de revogação incompleta perante o Open Finance e perante o art. 8º §5º.

Isso é o problema inteiro. Destruir `credenciais_cifradas` e `dek_cifrada` (ADR 0018 §D8) torna o material **irrecuperável para a Mavia**. Não desfaz nada do lado da instituição financeira nem do agregador: o `item` continua ativo, o consentimento continua registrado lá, e — dependendo do agregador — continua sendo **cobrado** e continua sincronizando contra a conta do titular. Crypto-shredding sem chamada remota é revogação pela metade, e é a metade que não aparece em nenhuma tela.

O documento de conformidade exige, **antes do 200** de `DELETE /conexoes/:id`: destruir credencial e DEK na mesma transação, tirar os jobs `sync:${conexao_id}:*` da fila, e **chamar o provider**. Alterar a interface do ADR 0003 não era ato do papel de compliance, e a pendência ficou registrada como DP-10, aguardando a DP-9.

A DP-9 foi decidida e desbloqueou esta: **os dados permanecem, a sincronização cessa.** Isso fixa o escopo do que a revogação destrói e, principalmente, fixa o que ela **não pode** tocar.

### A tensão que esta ADR existe para resolver

Duas afirmações verdadeiras que se contradizem quando a Pluggy está fora do ar:

1. **O direito do titular não depende do uptime de terceiro.** Ele pediu; o efeito local acontece agora. Uma revogação que falha porque um agregador está indisponível é uma revogação que o produto não tem o direito de recusar.
2. **A revogação não está completa enquanto o acesso existir lá.** Responder "pronto, revogado" quando o `item` segue ativo no agregador é a revogação-rótulo que o §10.1 proíbe — e é pior que não responder, porque o titular para de procurar.

A saída fácil é escolher uma das duas e ignorar a outra: ou prender o `DELETE` à disponibilidade do agregador, ou declarar sucesso e torcer. **Esta ADR recusa as duas.** O que ela decide é que *o efeito local é síncrono e incondicional*, *o efeito remoto é perseguido até conseguir*, e *o titular vê a diferença entre os dois*.

---

## Decisão

### D1 · A assinatura

`BankSyncProvider` ganha **uma** operação. A interface do ADR 0003 permanece no resto.

```ts
/** Descritor da revogação. Não carrega material cifrado e não é a linha de `conexoes`. */
type AlvoRevogacao = {
  tenantId: string
  conexaoId: string
  provider: string
  /** id do recurso na origem (`item_id`, `consent_id`). `null` quando o adapter não tem um. */
  externalId: string | null
  motivo: 'titular' | 'expiracao' | 'reconsentimento' | 'eliminacao_espaco' | 'eliminacao_titular'
  /** Estável entre tentativas: `revogacao:${conexaoId}`. Repassado ao provider quando ele aceitar. */
  chaveIdempotencia: string
  tentativa: number
  /**
   * Presente SOMENTE para adapter que declarou `modeloDeCredencial: 'credencial-por-conexao'`
   * (ADR 0018 §D0). Vive em memória, decifrado dentro da transação de revogação, zerado depois.
   * NUNCA é persistido, nunca entra em payload de job, nunca é relido do banco — o banco já não o tem.
   */
  segredo?: SegredoEfemero
}

type OpcoesRevogacao = { sinal: AbortSignal; prazoMs: number }

type ResultadoRevogacao =
  | { estado: 'revogado';         em: Date; referencia?: string }
  | { estado: 'ja_revogado';      em?: Date }
  | { estado: 'nao_aplicavel';    motivo: string }
  | { estado: 'falha_temporaria'; codigo: CodigoRevogacao; tentarApos?: Date }
  | { estado: 'falha_permanente'; codigo: CodigoRevogacao; detalhe: string }

interface BankSyncProvider {
  // … tudo do ADR 0003 permanece …
  revogar(alvo: AlvoRevogacao, opcoes: OpcoesRevogacao): Promise<ResultadoRevogacao>
}
```

**O que cada resultado significa** — e o significado é normativo, não sugestão de nomenclatura:

| Estado | O provider afirma | O orquestrador faz |
|---|---|---|
| `revogado` | O acesso existia e **deixou de existir agora**. `referencia` é o protocolo do agregador, quando houver | `revogacao_remota = 'confirmada'`. Fim |
| `ja_revogado` | Não há acesso a encerrar: `item` inexistente, consentimento já expirado ou já revogado lá (404/410) | **Sucesso.** `revogacao_remota = 'confirmada'`. É o caso de idempotência (D4) |
| `nao_aplicavel` | Este adapter **não tem acesso continuado** a encerrar. `motivo` é texto fixo do adapter, para a auditoria | `revogacao_remota = 'nao_aplicavel'`. Sem I/O, sem job, sem alerta |
| `falha_temporaria` | O provider não respondeu, ou respondeu que agora não dá (timeout, 429, 5xx, rede, manutenção) | Mantém `pendente` e deixa o job `conexao.revogar-no-provedor` retentar (D3) |
| `falha_permanente` | O provider respondeu e retentar não muda nada (401/403 da **nossa** chave, `item` de outra conta, contrato encerrado) | `revogacao_remota = 'falhou'` imediatamente. **Alerta ao operador** e aviso ao titular (D3) |

Quatro regras de contrato, todas verificáveis em S3 (D7):

1. **`revogar` é total.** Não lança para nenhum dos casos acima. Uma exceção que escape é tratada pelo chamador como `falha_temporaria` — a defesa existe, mas o adapter que a aciona reprova a suíte de contrato.
2. **`revogar` não escreve no banco e não conhece `tenancy`.** Ele fala com o terceiro e devolve um valor. Persistir estado é do orquestrador. É o que mantém o módulo profundo e o adapter substituível.
3. **`revogar` não devolve segredo.** Nem em `detalhe`, nem em `referencia`, nem em log. `detalhe` é texto do nosso vocabulário, nunca o corpo da resposta do agregador.
4. **`registrarAdapter` recusa** adapter que não declare, na sua ficha, `modeloDeCredencial` (ADR 0018 §D0) e `revogacaoRemota: 'sem-segredo' | 'exige-segredo-do-titular' | 'nao-aplicavel'`. Declaração ausente não compila em runtime de registro — o adapter simplesmente não entra.

### D2 · O que `DELETE /conexoes/:id` faz, em ordem

**Fase 1 — síncrona, transacional, incondicional.** Nada aqui depende de terceiro.

```sql
UPDATE conexoes
   SET status              = 'revogada',
       credenciais_cifradas = NULL,
       dek_cifrada          = NULL,
       escopo               = NULL,
       revogada_em          = now(),
       revogacao_remota     = 'pendente'   -- ou 'nao_aplicavel', pela ficha do adapter
 WHERE id = $1;
```

Na **mesma transação**: `consentimentos.revogado_em`, a escolha do titular registrada, a entrada em `auditoria`, a remoção dos jobs `sync:${conexao_id}:*` (`repeatable` **e** `delayed`), e a publicação em `outbox` de `consentimento.revogado` **e** de `conexao.revogar-no-provedor`.

O job de revogação remota é enfileirado **pelo outbox, antes de qualquer tentativa** — não depois. Não existe janela em que a intenção de revogar lá fora se perca porque o processo caiu entre o commit e a chamada.

Se o adapter declara `modeloDeCredencial: 'credencial-por-conexao'`, a credencial é decifrada **dentro** desta transação, mantida em variável local e zerada ao fim do request. É a única cópia que existirá.

**Fase 2 — tentativa síncrona, com prazo duro, fora da transação.** Depois do commit e antes do 200, uma chamada a `revogar()` com `prazoMs = 3000`. No caminho feliz — que é a maioria — o titular recebe a confirmação completa sem sair da tela. Resultado `revogado` / `ja_revogado` / `nao_aplicavel` grava `confirmada` e o job vira no-op quando rodar.

**Nunca dentro da transação.** I/O de rede sob transação aberta prende conexão de pool e lock por segundos, e — o que decide a questão — um timeout faria `ROLLBACK`, deixando a credencial **viva** depois que o titular pediu para destruí-la. O pior resultado possível, produzido pela ordem mais intuitiva.

**Fase 3 — assíncrona, o volume.** O evento `consentimento.revogado` dispara a limpeza que não é acesso e sim massa: `lancamentos_brutos.payload` daquela conexão (prazo **imediato**, §3.4), cache Redis da conexão, `contas.origem` de `conectado` para `manual`, e o que mais a política de retenção fizer convergir.

**A resposta 200 diz o que é verdade, separadamente:**

```json
{
  "status": "revogada",
  "credencial_destruida": true,
  "revogacao_no_provedor": "confirmada | pendente | falhou | nao_aplicavel",
  "lancamentos_mantidos": 412
}
```

Nunca uma palavra só. "Revogada" descreve o que a Mavia fez; `revogacao_no_provedor` descreve o que sabemos do outro lado. São dois fatos e o produto não tem o direito de fundi-los.

### D3 · Quando o provider falha — sem mentir e sem prender o titular

O eixo remoto tem quatro valores e vive em coluna própria:

```sql
ALTER TABLE conexoes
  ADD COLUMN revogacao_remota            TEXT,         -- nao_aplicavel | confirmada | pendente | falhou
  ADD COLUMN revogacao_remota_em         TIMESTAMPTZ,
  ADD COLUMN revogacao_remota_tentativas SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN revogacao_remota_erro       TEXT;         -- código do nosso vocabulário, nunca corpo do provider
```

**A tentativa persistente.** `conexao.revogar-no-provedor`, fila `externa`, `jobId = revogacao:${conexaoId}` (estável, portanto colapsa duplicatas), backoff exponencial de 1 min até teto de 6 h, **orçamento total de 72 h**. Enquanto `pendente`, o job continua. Ao esgotar o orçamento, o estado vira `falhou` — nunca `confirmada`, nunca silêncio.

**O que o titular vê**, em português, na tela de Conexões:

- `pendente`: *"Acesso encerrado na Mavia e suas credenciais foram apagadas. Ainda estamos confirmando o encerramento com \<Agregador\>."*
- `falhou`: *"Suas credenciais foram apagadas aqui e a Mavia não acessa mais este banco. Não conseguimos confirmar o encerramento com \<Agregador\> — para garantir, encerre também o acesso pelo aplicativo do seu banco."* Com botão **Tentar de novo**, que rearma o job.
- `confirmada` / `nao_aplicavel`: sem faixa. Não há nada pendente para contar.

**O que o operador vê.** Métrica `mavia_revogacao_remota_pendentes` por adapter; alerta se qualquer conexão ficar `pendente` por mais de 1 h (incidente do agregador) e alerta imediato em `falha_permanente` (quase sempre é a **nossa** chave de API, não o titular). `falhou` também notifica o titular por e-mail, uma vez.

**A restrição que isto impõe a adapters futuros, deliberadamente.** Como a credencial é destruída na Fase 1, um adapter que só consiga revogar **usando a credencial do titular** tem exatamente **uma** tentativa: a síncrona da Fase 2, com o segredo efêmero em memória. Falhando, vai direto a `falhou`. A retentativa persistente não existe para ele, porque a alternativa seria persistir a credencial para poder retentar — o que desfaz a revogação inteira para salvar a confirmação dela. Adapter assim declara `revogacaoRemota: 'exige-segredo-do-titular'`, e essa declaração é um sinal para preferir o modelo sem credencial do ADR 0018 §D0, não uma acomodação.

**Ordem inegociável:** destruir local primeiro, confirmar remoto depois. Se o mundo só permitir uma das duas coisas, a que acontece é a que o titular pediu e que está sob nosso controle.

### D4 · Idempotência

**No provider.** `revogar()` chamado duas vezes com o mesmo `AlvoRevogacao` devolve `revogado` na primeira e `revogado` ou `ja_revogado` na segunda — **nunca** `falha_*`, e sem efeito colateral adicional. Consentimento já expirado na origem, `item` já apagado, 404 e 410 são **`ja_revogado`**, que é sucesso: o estado desejado é *"não existe acesso"*, e o provider provando que não existe satisfaz o pedido tão bem quanto apagando.

**Na rota.** `DELETE /conexoes/:id` sobre conexão já revogada devolve **200** com o estado atual. Não 404 (a conexão existe como metadado por 5 anos), não 409 (não há conflito: o estado pedido é o estado corrente). Ela **não** reescreve `revogada_em`, **não** cria linha nova em `consentimentos` e **não** reenfileira quando `confirmada`. Quando `pendente` ou `falhou`, rearma o job — é exatamente a rota do botão *Tentar de novo*. Grava `auditoria` com ação distinta (`conexao.revogar.repetida`), porque é outro fato.

**No job.** Ao rodar, relê o estado; se já `confirmada` ou `nao_aplicavel`, é no-op. `jobId` estável impede que revogações concorrentes virem duas filas de retentativa.

**No agregador.** `chaveIdempotencia` é repassada quando o agregador aceitar cabeçalho de idempotência.

### D5 · Cada adapter

| Adapter | `modeloDeCredencial` | `revogacaoRemota` | O que `revogar()` faz |
|---|---|---|---|
| `manual` | `sem-credencial` | `nao-aplicavel` | Devolve `nao_aplicavel` (*"conexão local, sem acesso externo"*). **Zero I/O.** A "conexão" é um rótulo do titular sobre lançamentos que ele mesmo digitou |
| `ofx-import` | `sem-credencial` | `nao-aplicavel` | Devolve `nao_aplicavel` (*"importação de arquivo, sem acesso continuado"*). **Zero I/O.** O acesso foi o titular entregar um arquivo, uma vez; não há sessão para encerrar. O que precisa sumir aqui é o **payload** do bruto, e disso cuida a Fase 3 |
| `csv-import` | `sem-credencial` | `nao-aplicavel` | Idem `ofx-import` |
| `pluggy` | `sem-credencial` (§D0: o titular digita a credencial no fluxo do agregador; guardamos `item_id` opaco) | `sem-segredo` | **Chamada real.** `DELETE /items/{externalId}`, autenticando com a **chave de API da Mavia** obtida do guardião — não com nada que estivesse na linha de `conexoes`. É por isso que a retentativa persistente funciona depois do shredding |

Mapeamento de resposta do `pluggy`, normativo:

| Resposta | Resultado |
|---|---|
| 200 / 204 | `revogado` |
| 404 / 410 (item inexistente ou já removido) | `ja_revogado` |
| 401 / 403 (nossa chave), item de outra conta, contrato encerrado | `falha_permanente` |
| 408 / 429 / 5xx / timeout / erro de rede / DNS | `falha_temporaria` |

**`nao_aplicavel` é um valor devolvido, não um erro engolido.** É a diferença entre os três adapters de arquivo declararem seu comportamento e eles lançarem `NotImplementedError` — que obrigaria o orquestrador a saber qual adapter concreto está chamando, exatamente a dependência que o ADR 0003 proíbe.

### D6 · O efeito sobre os dados, conforme a DP-9

**Destruído na transação da revogação (síncrono, antes do 200):**

| O quê | Como |
|---|---|
| `conexoes.credenciais_cifradas` | `NULL` — crypto-shred (ADR 0018 §D8) |
| `conexoes.dek_cifrada` | `NULL`, na mesma transação. É a destruição da chave que torna o ciphertext irrecuperável |
| `conexoes.escopo` | `NULL`. A cópia probatória fica em `consentimentos` |
| **Tokens do agregador** (access/refresh, `item_id` de sessão) | Vivem **dentro** de `credenciais_cifradas` e somem com ela. **Veto:** nenhuma outra cópia de token de conexão em Redis, em variável de módulo, em cache de processo ou em log |
| Jobs de fila | `sync:${conexao_id}:*`, `repeatable` **e** `delayed`, removidos na mesma unidade de trabalho. Um job agendado que sobrevive sincroniza sem autorização |
| Sincronização em voo | Verifica o estado da conexão a cada lote e aborta. Nenhum `LancamentoBruto` novo após a revogação |

**Destruído logo depois (Fase 3, assíncrono, com métrica e prazo alvo de 15 min):**

| O quê | Por quê assíncrono |
|---|---|
| `lancamentos_brutos.payload` daquela conexão | Prazo **imediato** já é o da §3.4. É volume, não acesso: o payload não abre porta nenhuma, mas guarda agência, conta e chave Pix **de terceiros** (§7), e por isso o prazo é o mais curto do documento. Assíncrono porque pode ser dezenas de milhares de linhas, e transação longa é pior que 15 minutos |
| Cache Redis da conexão | Cursor de sincronização, listagem de contas do agregador, qualquer coisa em `sync:${conexao_id}:*` |
| `contas.origem` | De `conectado` para `manual` — a conta continua existindo e passa a ser mantida pelo titular |

**Permanece — e esta é a DP-9:**

| O quê | Por quê |
|---|---|
| `lancamentos` já promovidos | **É o histórico financeiro do próprio titular.** A base do tratamento deixa de ser consentimento e passa a ser execução do contrato (art. 7º V). Revogar o acesso ao banco não é pedir a destruição do próprio extrato |
| `lancamentos_brutos` **sem payload**: campos normalizados, `external_id` e `conteudo_hash` | Até 24 meses (§3.4). **Sobrevivem ao payload de propósito**, e agora com razão nomeada: são o que impede a reconexão de duplicar o histórico que o titular escolheu manter (D7-10). Sem eles, a DP-9 se contradiz na primeira reconexão |
| Conciliações **já feitas** | Desfazê-las recriaria as duplicatas que elas resolveram, no histórico que permanece. E a decisão foi ato do titular — regra 15 |
| `conciliacao_sugestoes` pendentes | Seguem o prazo próprio (§3.4). O lançamento importado permanece; casá-lo com um manual continua fazendo sentido |
| `sincronizacoes` | 12 meses. É como o titular vê o que aconteceu e **quando parou** |
| `consentimentos` | 5 anos. É a prova, ganha `revogado_em`, e **nunca** é apagado pela revogação |
| `conexoes` metadados | 5 anos, anonimizados conforme §4.4. Instituição, provider, datas, contagem |

**A exceção honesta, repetida porque some fácil:** um backup anterior à revogação contém a DEK antiga. O prazo real de descarte da credencial é **N = 30 dias** (DP-7, §5.5, ADR 0018 §D8). Nenhuma chamada a `revogar()` alcança um backup.

**O que a revogação nunca faz:** apagar lançamento. A opção *"revogar e apagar o que veio deste banco"* de §10.3, se o produto vier a oferecê-la, é **operação separada**, com confirmação e contagem próprias, executada depois da revogação — não um efeito dela. A DP-9 fixou o padrão; misturar as duas na mesma chamada seria destruir dado do titular numa rota cujo nome não diz isso.

### D7 · O que a `Conexao` vira

**Dois eixos, de propósito.**

- `status`: `ativa | erro | expirada | revogada`. **`revogada` é terminal e absorvente** — nenhuma transição sai dela, em nenhuma hipótese. É o que a Mavia fez, e é imediato.
- `revogacao_remota`: `nao_aplicavel | confirmada | pendente | falhou`. É o que **sabemos** do outro lado, e é eventual.

Fundir os dois num enum só obrigaria a escolher entre duas mentiras: marcar `revogada` enquanto o acesso talvez exista lá (mentira sobre o mundo), ou manter `revogando` enquanto a credencial já foi destruída (mentira sobre nós). Duas colunas custam uma migration e compram a verdade.

**A UI.** A conexão sai da lista de ativas e vai para **Conexões encerradas**, mostrando instituição, período em que esteve ativa, data da revogação, **quantos lançamentos vieram dela e permanecem**, e a faixa de estado remoto da D3. **Nenhum botão "reativar"** — não existe o que reativar.

**Reconectar cria conexão nova.** Linha nova, `id` novo, DEK nova, `kek_versao` corrente, linha nova em `consentimentos` com a `versao_texto` vigente. Três razões, e a primeira sozinha basta: (a) a DEK morreu, não há credencial a ressuscitar; (b) consentimento é ato novo, e §10.4.4 já proíbe renovação silenciosa; (c) a prova precisa de duas linhas, não de uma linha editada — um `revogado_em` sobrescrito apaga o fato de que houve revogação.

**A consequência sobre a idempotência de ingestão — e ela é o motivo de este item estar num ADR.** A chave da regra 13 é `(tenant_id, provider, external_id)` mais `conteudo_hash`. Ela **não inclui `conexao_id`**, e isso deixa de ser detalhe de implementação para virar decisão registrada:

> Reconectar o mesmo banco produz uma `Conexao` nova, mas os **mesmos** `external_id` na origem. Com a chave sem `conexao_id`, reimportar o período sobreposto é **no-op** — exatamente o que a DP-9 exige, porque os lançamentos que permaneceram não podem aparecer duas vezes. Se `conexao_id` entrasse na chave, cada reconexão duplicaria todo o histórico sobreposto e o titular veria o extrato dobrado, sem nada na tela explicando por quê.

Dois corolários:

1. `lancamentos_brutos.conexao_id` continua apontando para a conexão **revogada**. Não se repontam brutos para a conexão nova: o fato é de onde eles vieram.
2. Se um agregador **não** der `external_id` estável entre `item`s recriados — Pluggy pode renumerar transações ao recriar o item —, quem segura a deduplicação é o `conteudo_hash` do conteúdo normalizado, com a janela de tolerância da conciliação como rede. **Isto precisa ser provado para o adapter `pluggy` antes do épico 12 entrar em produção**, e o teste está na lista da D8.

### D8 · O seam

**Nenhum seam novo.** `revogar()` entra em **S3**, o contrato do `BankSyncProvider`, que já roda parametrizado contra cada adapter (`bank-sync-provider.contrato.ts`). O veto 7 de `sistema.md` §8 é respeitado, e a regra do arquiteto também: o seam mais alto que ainda observa o comportamento já existe.

**O que a suíte de contrato precisa provar** — um caso por linha, executado contra **todos** os adapters registrados:

| # | Caso | O que ele impede |
|---|---|---|
| C1 | Todo adapter registrado implementa `revogar` e **não lança** em nenhum caso enumerado | O `NotImplementedError` de `manual`/`ofx-import`/`csv-import` que a D5 recusa |
| C2 | O retorno satisfaz `zResultadoRevogacao`; adapters `nao-aplicavel` devolvem `nao_aplicavel` **sem tocar em rede** (fake de socket que reprova se aberto) | Adapter de arquivo "revogando" alguma coisa por engano |
| C3 | **Idempotência:** duas chamadas seguidas; a segunda é `revogado` ou `ja_revogado`, nunca `falha_*`, sem efeito colateral novo | A segunda revogação virar erro na tela do titular |
| C4 | **Consentimento já expirado / `item` inexistente** na origem (fake 404/410) → `ja_revogado`, tratado como sucesso pelo orquestrador | Ficar `pendente` para sempre por algo que já está resolvido |
| C5 | **Taxonomia de falha:** timeout, 429 e 5xx → `falha_temporaria`; 401/403 e item de outra conta → `falha_permanente` | O adapter que classifica tudo como permanente (perde o retry) ou tudo como temporário (retenta 72 h contra um 401 que nunca vai mudar) |
| C6 | **Prazo duro:** com o fake pendurado, `revogar()` honra `AbortSignal`/`prazoMs` e devolve `falha_temporaria` **dentro** do prazo | O `DELETE` travar porque o agregador travou |
| C7 | **Nenhum segredo vaza:** nem o `ResultadoRevogacao` nem o log emitido contêm credencial, token, chave de API ou corpo do provider | O mesmo mecanismo de A-38, aplicado ao caminho novo |
| C8 | **O adapter não escreve no banco:** fake de Drizzle que reprova se tocado | A tentação de o adapter "marcar a conexão" ele mesmo, dissolvendo o seam |
| C9 | `registrarAdapter` **recusa** adapter sem `modeloDeCredencial` e `revogacaoRemota` declarados | Adapter novo nascer sem ficha, que é como o §D0 do ADR 0018 é esquecido |
| C10 | **Reingestão após reconexão é no-op:** mesma fixture de extrato; conexão A revogada, conexão B nova; ingerir de novo → **zero** lançamentos e zero brutos novos | A duplicação de histórico da D7 — o modo de falha mais caro e mais silencioso desta ADR |

**O que fica em S2, e não em S3, para o seam não inchar:** a nulidade de `dek_cifrada` e `credenciais_cifradas` depois do 200 (R-13), a ausência de jobs `sync:${conexao_id}:*` na fila e a revogação durante sincronização em voo (R-14), o contrato HTTP da resposta da D2, a visibilidade de `revogacao_remota` pela API, e o rearme pelo `DELETE` repetido (D4). **S3 prova o comportamento do adapter; S2 prova a orquestração.** Quem confundir os dois vai acabar com um mock de Postgres dentro da suíte de contrato.

---

## O que do ADR 0003 continua valendo

Integralmente, e esta ADR não abre exceção em nenhum ponto:

- **A regra:** nenhum código de aplicação conhece Pluggy, Belvo ou OFX. Todo dado bancário entra por `BankSyncProvider` — e agora **sai** por ele também.
- **A tabela de adapters** e o cronograma: `manual` no dia 1, `ofx-import` e `csv-import` no épico 6, `pluggy` no épico 12 quando a receita cobrir o custo. `revogar()` nasce com os três primeiros, não espera o quarto.
- **A idempotência** por `(tenant_id, provider, external_id)` mais `conteudo_hash`. Esta ADR não a altera; ela **registra a razão** de `conexao_id` estar fora da chave (D7).
- **`LancamentoBruto` preservado antes de virar `Lancamento`.** O que muda é o prazo do `payload` na revogação, que já era o da §3.4.
- **A justificativa econômica** e o gatilho de reavaliação trimestral.
- **As alternativas rejeitadas** do 0003 (agregador no dia 1, participação direta no BCB, só manual sem seam) continuam rejeitadas pelas mesmas razões.

O que esta ADR acrescenta é **uma operação na interface** e o comportamento dela em cada adapter. O 0003 permanece a decisão de fronteira; este é o capítulo que faltava nela.

---

## Consequências

**Positivas.** A revogação passa a ter efeito nos dois lados, que é o que o art. 8º §5º exige e o que B-15 cobrava — e o efeito local não fica refém de terceiro nenhum: ele acontece no commit, sempre, mesmo com o agregador fora do ar. O produto nunca afirma o que não sabe, porque os dois eixos de estado são visíveis ao titular e a resposta 200 os separa. `nao_aplicavel` como **valor** mantém a operação total: o orquestrador nunca precisa saber qual adapter concreto está chamando, que é a propriedade inteira do ADR 0003. A tentativa persistente converte "o agregador estava fora do ar" de perda silenciosa em pendência com prazo, métrica e alerta. A chave de idempotência sem `conexao_id` torna a reconexão segura por construção, e a DP-9 deixa de se contradizer na primeira vez que alguém reconecta. E, como `revogar()` não escreve no banco e não recebe a linha de `conexoes`, o adapter continua sendo um arquivo que se troca.

**Negativas.** Duas colunas novas e um vocabulário novo na tela — *"revogada, mas confirmando"* é um estado que o suporte vai ter de explicar, e nenhuma frase o torna simples. A tentativa síncrona de 3 s acrescenta latência ao caminho feliz do `DELETE`, e um agregador lento faz a requisição parecer travada justamente na operação em que o titular está mais ansioso. Mais um processador de job, mais uma métrica e mais um alerta para operar numa VPS única, com o guardião já a exigir desselamento manual (ADR 0018). O estado `falhou` transfere trabalho ao titular — *"encerre também pelo aplicativo do banco"* — o que é honesto e continua sendo uma experiência ruim, criada por uma falha que não é dele nem nossa. O alerta de `pendente` vai gerar ruído durante um incidente longo do agregador, e alguém vai querer silenciá-lo permanentemente; o procedimento de silenciamento temporário precisa existir antes disso. A ordem "local primeiro" fecha a porta para adapters que só revoguem com a credencial do titular, o que é intencional mas é uma restrição real sobre agregadores futuros. E a exceção do backup permanece: por N = 30 dias, a DEK anterior à revogação existe em cópia, e nenhuma decisão desta ADR alcança isso.

---

## Alternativas rejeitadas

**Chamar o provider dentro da transação, antes do commit.** É a ordem mais intuitiva — "só confirmo a revogação se ela funcionou dos dois lados". Rejeitada por três razões independentes: prende o direito do titular ao uptime da Pluggy; mantém transação aberta durante I/O de rede, segurando lock e conexão de pool por segundos; e, decisivamente, um timeout produziria `ROLLBACK` — a credencial **sobreviveria** ao pedido de destruição. A ordem intuitiva é a que produz o pior resultado possível.

**Bloquear o 200 até o provider confirmar.** Revogação estritamente síncrona ponta a ponta. Rejeitada: transforma a indisponibilidade de um terceiro em recusa de um direito que o produto não pode recusar. O titular receberia um erro por um problema que não é dele, e a única saída dele seria tentar de novo mais tarde — sem saber se a credencial já foi destruída ou não.

**Só o job assíncrono, sem tentativa síncrona.** Mais simples e mais uniforme: uma via só. Rejeitada porque, no caminho comum, a confirmação chega em menos de um segundo e o titular pode sair da tela sabendo de tudo; adiar isso para o poller transformaria o caso normal no caso pendente, e `pendente` é o estado que exige explicação. O documento de conformidade também exige síncrono onde é síncrono.

**Best-effort sem estado visível — "tentamos, e pronto".** Uma coluna a menos e nenhuma faixa na UI. Rejeitada: é a mentira. Responder 200 "revogado" quando o `item` pode seguir ativo no agregador é precisamente a revogação-rótulo que a §10.1 proíbe, e é pior que o silêncio, porque o titular para de procurar.

**`revogar()` lança exceção em quem não tem o que revogar.** O caminho que a maioria dos códigos toma por omissão. Rejeitada: obriga `try/catch` no orquestrador, torna "não se aplica" indistinguível de "falhou" no log e na métrica, e faz o comportamento correto depender de saber qual adapter concreto está do outro lado — que é exatamente a dependência que o ADR 0003 existe para proibir.

**`revogar(conexao: Conexao)`, recebendo a linha inteira.** Assinatura óbvia e conveniente. Rejeitada: leva material cifrado para dentro do adapter, sugere que ele leia e escreva o banco, e — o argumento que encerra — **não funciona depois do shredding**, porque a linha já não tem credencial. Um descritor sem segredo é o que torna a retentativa persistente possível.

**Persistir a credencial até a confirmação remota chegar.** Resolveria a retentativa de adapters que exigem o segredo do titular. Rejeitada sem hesitação: mantém vivo o ativo que a revogação existe para destruir, por até 72 h, para salvar a **confirmação** da revogação. Desfaz a coisa para provar que ela foi feita.

**Um enum só, fundindo estado local e remoto.** Uma coluna a menos. Rejeitada: obriga a escolher qual das duas verdades esconder, e as duas importam ao titular por motivos diferentes.

**Reativar a conexão antiga ao reconectar.** Menos linhas em `conexoes`, histórico mais curto. Rejeitada: não há o que reativar (a DEK morreu), o consentimento novo exige ato novo e linha nova de prova, e um `revogado_em` sobrescrito apagaria o registro de que houve revogação — que é justamente o que `consentimentos` precisa provar por 5 anos.

**Incluir `conexao_id` na chave de idempotência de ingestão.** Pareceria mais correto: cada conexão, seu conjunto de brutos. Rejeitada: duplicaria todo o histórico sobreposto a cada reconexão, contra a DP-9, de forma silenciosa e cara de desfazer.

**Apagar os lançamentos originados da conexão na revogação.** Rejeitada pela DP-9: destruiria o histórico financeiro do titular sem que ele tenha pedido, porque ele desconectou um banco. Se a opção de apagar existir, é operação separada, com confirmação própria e contagem exibida antes.

**Seam novo para revogação.** Rejeitada: S3 já é o contrato do `BankSyncProvider`, e a revogação é parte desse contrato. Seam novo aqui seria superfície permanente para provar o que a superfície existente já prova, contra o veto 7 de `sistema.md` §8.

---

## Revisão

Reavaliar quando o adapter `pluggy` entrar em produção (épico 12). Três coisas precisam ser confirmadas contra o agregador real, e nenhuma delas é confirmável hoje: o mapeamento de códigos da D5; se `DELETE /items/{id}` encerra também o consentimento no Open Finance ou só o vínculo com o agregador — se for só o vínculo, esta ADR precisa de uma segunda chamada, e é falha de conformidade até que tenha; e a estabilidade do `external_id` entre `item`s recriados (D7, caso C10).
