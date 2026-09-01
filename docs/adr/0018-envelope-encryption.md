# ADR 0018 — Envelope encryption das credenciais de `Conexao`

- **Status:** Aceita, com uma escolha de implementação declarada como pendente de decisão humana (D3.3)
- **Data:** 2026-09-01
- **Autor:** `especialista-seguranca-appsec`
- **Substitui:** nada. **Complementa:** regra 19 do `CLAUDE.md`, ADR 0003, ADR 0004
- **Documentos irmãos:** `docs/seguranca/matriz-de-acesso.md` · `docs/compliance/retencao-e-eliminacao.md`

## Contexto

A regra 19 do `CLAUDE.md` diz *o quê*: "segredos de provider com envelope encryption". O `sistema.md` §3.5 acrescenta duas colunas (`credenciais_cifradas BYTEA`, `dek_cifrada BYTEA`) e uma frase — "DEK por conexão, KEK fora do banco". O próprio `sistema.md` §7 lista esta ADR como não escrita, com a justificativa: *"falta o como, incluindo o que acontece na rotação e no backup."*

O gate de risco (A-37) enumerou oito lacunas nessa frase: algoritmo e modo não declarados; nenhum AAD, o que permite **transplantar** um blob de credencial de uma conexão para outra por quem tenha escrita no banco; nenhuma coluna `kek_versao`, o que torna a rotação impossível de executar incrementalmente; "fora do banco" não é especificação; nenhum procedimento de rotação; nenhuma resposta para o backup; nenhum mecanismo de descarte; e `usuarios.mfa_segredo_cifrado` fora do esquema.

### O ativo

A KEK é o único ativo do sistema cujo comprometimento **não é proporcional ao acesso obtido**. Todo o resto vaza um tenant por vez: uma sessão roubada entrega um espaço; uma falha de RLS entregaria um tenant. A KEK destrava as credenciais bancárias de *todos* os tenants, a partir de qualquer cópia do banco ou de qualquer backup, para sempre e sem deixar rastro no sistema.

### O caminho que esta ADR precisa tornar impossível

O gate classificou este como o vetor mais grave do spec (A-32 + A-34 + A-37), e ele é uma cadeia de quatro elos:

1. **OFX 2.x é XML.** Um parser de Node com resolução de DTD e de entidades externas habilitada — o padrão de várias bibliotecas — processa `<!ENTITY xxe SYSTEM "file:///proc/self/environ">` e devolve o conteúdo dentro do resultado do parse.
2. **O produto ecoa o resultado de volta ao usuário** no passo 3 da importação (Revisão), na coluna de descrição. O atacante lê o que quiser do host.
3. **O parser roda no mesmo processo que desembrulha DEKs.** O worker executa `sync.executar` (credenciais bancárias em claro em memória) e `anexo.ocr` (PDF, o formato de entrada mais hostil dos três, processado por bibliotecas nativas com histórico denso de RCE).
4. **"KEK fora do banco", numa VPS auto-hospedada com `docker-compose`, quase sempre significa `.env` no mesmo host.** Ler arquivo no host é ler a KEK.

Cada elo isolado é um bug comum. Encadeados, entregam a base inteira a um atacante externo sem conta, através de um upload.

**A decisão abaixo não reduz a probabilidade desse caminho. Ela remove dois dos quatro elos por ausência de material — não há o que ler onde o parser roda, e não há arquivo de KEK onde o atacante procuraria.**

## Decisão

### D0 · O melhor segredo é o que não existe

Antes de decidir como guardar a credencial, decidir se ela precisa existir. Para o adapter `pluggy` (e para qualquer agregador equivalente), o modelo correto é: **a credencial do banco do titular nunca chega à Mavia**. O titular a digita no fluxo do agregador; a Mavia guarda um `item_id` opaco. O único segredo do lado da Mavia passa a ser a **nossa** chave de API com o agregador — um segredo único, independente de tenant, que vive no guardião (D3) e nunca no banco.

O envelope existe para os casos em que um segredo **por conexão** é inevitável, e para reduzir o dano quando ele é. Ele não é licença para coletar credencial quando existe caminho sem coletar. Todo adapter novo declara, na sua ficha do ADR 0003, qual dos dois modelos usa — e escolher o modelo com credencial exige justificativa.

### D1 · Algoritmo, modo e formato do blob

**AES-256-GCM.** Nonce de **96 bits aleatório por operação**, de CSPRNG, jamais reutilizado com a mesma DEK. Nunca contador, nunca derivado do id da linha.

O blob persistido é autodescritivo e versionado:

```
versao_formato(1) || kek_versao(2, big-endian) || nonce(12) || ciphertext || tag(16)
```

`versao_formato` permite trocar de algoritmo sem migração destrutiva. `kek_versao` viaja no blob **e** numa coluna (D4): no blob para que o material seja recuperável isoladamente, na coluna para que a rotação seja indexável. Os dois entram no AAD, portanto adulterar qualquer um deles produz falha de autenticação, não decifragem silenciosa.

### D2 · AAD — o que impede transplante de blob

Sem dado autenticado adicional, quem tiver escrita no banco copia `credenciais_cifradas` e `dek_cifrada` de uma conexão para outra — inclusive de um tenant para outro — e o desembrulho funciona normalmente. O envelope protegeria contra leitura e não contra substituição.

```
AAD = proposito || 0x00 || tenant_id || 0x00 || recurso_id || 0x00 || kek_versao
```

`proposito` é um enum fechado:

| `proposito` | `tenant_id` | `recurso_id` | Uso |
|---|---|---|---|
| `conexao.credenciais` | o tenant da conexão | `conexoes.id` | Credencial de instituição financeira |
| `usuario.mfa` | `00000000-…-0000` (constante) | `usuarios.id` | `usuarios.mfa_segredo_cifrado` — `usuarios` é global, não tem tenant (A-17) |

O AAD é reconstruído do contexto no momento do desembrulho, **nunca lido do blob**. Um blob movido para outra linha falha a autenticação, porque o AAD reconstruído não bate.

### D3 · Onde a KEK vive — a decisão central

#### D3.1 O que fica proibido

A KEK **não existe** como sequência de bytes legível por nenhum processo que interpreta entrada de usuário, e **não existe** em nenhum destes lugares, em nenhuma circunstância:

`.env` · variável de ambiente do container da API ou do worker · qualquer arquivo do filesystem do container da API ou do worker · imagem de container · repositório · `docker-compose.yml` · variável de CI · backup do Postgres · destino do backup · log · resposta de API · qualquer processo que execute parsing de OFX, CSV, PDF ou imagem.

Isto é veto, não recomendação. Um `grep` no ambiente do container da API que encontre material de KEK reprova o deploy.

#### D3.2 O guardião de chaves

A KEK vive atrás de um **processo separado**, `mavia-guardiao`, cuja única interface é:

```ts
gerarDek(aad): { dek: Uint8Array, dekCifrada: Uint8Array }   // DEK nasce aqui, com CSPRNG do guardião
envelopar(aad, dek): dekCifrada
desenvelopar(aad, dekCifrada): dek
reenvelopar(aad, dekCifrada, kekVersaoDestino): dekCifrada    // rotação; a DEK não sai
hmac(proposito, dados): Uint8Array                             // pepper de ip_hash (A-39)
```

Cinco propriedades, cada uma verificável:

1. **Nenhuma operação retorna material de KEK.** Não existe `exportarKek()`. A API pode desembrulhar enquanto vive; não pode levar a chave embora.
2. **Container próprio, UID próprio, sem porta TCP.** A comunicação é por **socket Unix** montado read-write apenas nos containers de API e worker. O guardião não escuta rede, e portanto não é alcançável por SSRF a partir do parser (que, de todo modo, não tem rede — D6).
3. **Rate limit e alarme no desembrulho.** Teto por processo e por hora, dimensionado ao uso legítimo (uma conexão sincroniza no máximo 6×/dia). Um pedido de desembrulho em massa — o padrão de quem comprometeu a API e quer levar tudo — **sela o guardião** e alerta o operador. Isto é o que converte "improvável" em "limitado e detectado" no cenário residual do §Consequências.
4. **Todo desembrulho é registrado** com `proposito`, `tenant_id`, `recurso_id`, `kek_versao` e horário, num log do próprio guardião, fora do Postgres. É o insumo do art. 48 quando o incidente é neste ativo.
5. **`reenvelopar` existe para que a DEK nunca precise transitar** durante a rotação. A rotação de KEK não expõe DEK à aplicação.

#### D3.3 De onde o guardião obtém a KEK — a escolha pendente

Duas implementações satisfazem D3.1 e D3.2. **A escolha entre elas é do dono do produto com `sre-devops-vps`, porque é uma decisão de custo e de operação, não de segurança** — as duas fecham o caminho A-32.

| | **Opção A — KMS/Vault externo** | **Opção B — guardião local com KEK selada** |
|---|---|---|
| Onde a KEK vive | Dentro do KMS. **Nunca sai**; `envelopar`/`desenvelopar` acontecem lá | Em memória do guardião (`tmpfs`, `mlock`), carregada no boot |
| Como o guardião obtém | Não obtém — é cliente do KMS | Desselamento no boot: arquivo cifrado por chave que **não está no host** (operador, `age` com identidade externa, ou serviço de desselamento) |
| Custo | Mensal, e dependência de terceiro | Zero |
| Fraqueza | Terceiro na cadeia; latência de rede; e uma decisão de residência de dados a registrar | Reboot da VPS exige desselamento; enquanto não desselado, sincronização não funciona (o resto do produto sim) |
| Vazamento por leitura de arquivo no host | **Impossível** | **Impossível** — a KEK não toca disco em claro |

**Recomendação:** A quando houver orçamento; B é aceitável desde o primeiro dia e **não** é dívida disfarçada — ela satisfaz D3.1 integralmente. O que **não** é aceitável, em nenhuma hipótese, é a terceira opção que o silêncio do spec produziria: KEK em `.env` no host da aplicação.

Se B for a escolha, o ADR registra a data de revisão (12 meses) e o gatilho de migração (primeiro cliente que exija certificação, ou primeira conexão real via agregador).

### D4 · Colunas novas

```sql
ALTER TABLE conexoes
  ADD COLUMN kek_versao   SMALLINT     NOT NULL,
  ADD COLUMN dek_criada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN criado_por    UUID        NOT NULL REFERENCES usuarios(id);

ALTER TABLE usuarios
  ADD COLUMN mfa_kek_versao SMALLINT;

CREATE INDEX ON conexoes (kek_versao) WHERE dek_cifrada IS NOT NULL;
```

`kek_versao` é o que torna a rotação incremental possível. Sem ela restam duas opções ruins: reenvelopar tudo num único movimento atômico (indisponibilidade e risco de perda), ou nunca rotacionar. `criado_por` sustenta a regra de revogação da `matriz-de-acesso.md` §2.2.

### D5 · Rotação

| O que | Quando | Como |
|---|---|---|
| **KEK** | A cada **12 meses**, e **imediatamente** sob suspeita de incidente | Nova versão passa a ser a de escrita; job `kek.reenvelopar` percorre `conexoes WHERE kek_versao < atual` em lotes, chamando `reenvelopar`. **O ciphertext das credenciais não é tocado** — só a DEK muda de envelope |
| **DEK** | A cada renovação de consentimento, e a cada atualização de credencial | Nova DEK, novo ciphertext. A DEK antiga é descartada, não reenvelopada |

**Duas versões de KEK são válidas durante a janela de rotação** — a antiga para desembrulhar, a nova para embrulhar. A rotação **não exige indisponibilidade** e é idempotente por `kek_versao`: rodar o job duas vezes não reenvelopa nada duas vezes.

**Métrica:** `mavia_kek_reenvelope_pendentes` por versão. Zero é o estado esperado fora da janela.

**Destruição da KEK antiga** exige as duas condições, nesta ordem: (a) `SELECT count(*) FROM conexoes WHERE kek_versao = antiga` retorna 0; **e** (b) passou o prazo de retenção de backup **N** (`retencao-e-eliminacao.md` §5.5). Destruir antes de (b) torna os backups daquele período irrecuperáveis — o que é bom para privacidade e péssimo para recuperação de desastre, e é uma escolha que precisa ser tomada de olhos abertos, não por acidente de sequenciamento.

### D6 · Nenhum processo que manipula DEK executa parsing de arquivo de usuário

Esta é a metade da decisão que fecha o elo 3 do caminho descrito no Contexto, e ela é parte desta ADR — não uma nota de rodapé sobre upload.

Parsing de OFX, CSV, PDF e imagem, e o OCR, executam num **processo filho descartável por arquivo**, com:

- usuário sem privilégio;
- **nenhuma variável de ambiente de segredo** — a `DATABASE_URL` e o socket do guardião **não existem** nesse ambiente;
- **sem acesso de rede** (namespace de rede vazio / `--network none`);
- filesystem somente-leitura, exceto um `tmpfs` do tamanho do arquivo;
- cgroup de memória (256 MB) e CPU, `seccomp` restritivo;
- timeout duro de 30 s com `SIGKILL`.

A comunicação é por arquivo de entrada e JSON de saída **validado por Zod** — o processo pai não confia na saída do filho. E o parser XML roda com **DTD desabilitada, resolução de entidades externas desabilitada, sem resolver de rede ou de filesystem**, por configuração explícita, com teste que alimenta um payload XXE de fixture e exige erro tipado.

### D7 · Backup e restauração

| Item | Regra |
|---|---|
| Conteúdo do dump | `pg_dump` contém `credenciais_cifradas` **e** `dek_cifrada`. Nunca a KEK |
| Destino do backup | **Nunca** contém a KEK e **nunca** fica no mesmo host que ela. A KEK não é versionada junto com a infraestrutura |
| Cifragem do backup | Em repouso, com chave **distinta** da KEK, custodiada em outro lugar. Quem leva o backup precisa quebrar duas custódias independentes |
| Teste de recuperação | **Obrigatório e anual**, com **dois** critérios de aceite: (a) a restauração funciona; (b) **restaurar sem acesso ao guardião não recupera nenhuma credencial de conexão** — provado no relatório, com a tentativa registrada |
| Ordem da restauração | restaurar banco → **executar `eliminacao.aplicar` sobre `eliminacoes_journal`** (`retencao-e-eliminacao.md` §5.5) → apontar para o guardião → aceitar tráfego. Os três primeiros passos são `preflight`, não runbook |

O critério (b) é o que transforma "o envelope protege" de afirmação em fato observado. Se um dia ele falhar, o envelope estava decorativo.

### D8 · Descarte — crypto-shredding

Revogar ou excluir uma conexão zera `dek_cifrada` **e** `credenciais_cifradas` na **mesma transação** (`retencao-e-eliminacao.md` §10.1). Como a DEK é a única cópia da chave daquele ciphertext e ela nunca existiu em outro lugar, o material torna-se irrecuperável — inclusive a partir de cópias do banco.

A exceção honesta, que precisa estar escrita: **um backup anterior à revogação contém a DEK antiga.** Portanto o prazo real de descarte da credencial é **N**, a retenção de backup. É por isso que N tem teto nesta arquitetura (≤ 90 dias) e não é apenas uma preferência de infraestrutura.

O mesmo mecanismo vale para `usuarios.mfa_segredo_cifrado` na eliminação do titular, e para o **pepper de auditoria por tenant**, cuja destruição é o que completa a anonimização do §4.4 do documento de retenção.

### D9 · Escopo: o que usa o guardião e o que não usa

| Segredo | Onde vive | Por quê |
|---|---|---|
| Credencial de `Conexao` | DEK por conexão, envelope sob KEK no guardião | Comprometimento cruza todos os tenants |
| `usuarios.mfa_segredo_cifrado` | Idem, `proposito = usuario.mfa` | Fecha o item 8 de A-37 |
| Chave de API da Mavia com o agregador | Guardião, sem DEK (segredo único, não por tenant) | Idem |
| *Pepper* de `ip_hash` e `user_agent_hash` | Guardião, via `hmac()` | Comprometê-lo **despseudonimiza** todos os registros (A-39) |
| Chave de assinatura do cursor de paginação | Segredo comum da aplicação | Seu comprometimento **não** atravessa a fronteira de tenant: o servidor compara o `tenant_id` do payload com o do contexto de sessão. Pôr no guardião custaria uma chamada por página, sem ganho |
| `senha_hash` | Argon2id no banco | Não é cifragem reversível e não deve ser |

## Consequências

**Positivas.** O caminho de A-32 deixa de existir por **ausência de material**, não por vigilância: mesmo que o parser XXE funcione perfeitamente, ele roda num processo onde não há segredo, não há socket do guardião e não há rede; e mesmo que um atacante leia todo o filesystem e todo o ambiente do container da API, não encontra KEK, porque não há arquivo nem variável a encontrar. O AAD elimina a classe inteira de ataques por transplante de blob, que é a falha silenciosa típica deste desenho. `kek_versao` torna a rotação um job de manutenção em vez de um evento. O crypto-shredding dá à revogação de consentimento um efeito técnico real, que é o que o art. 8º §5º exige e o que o gate cobrava em B-14. E o critério (b) do teste anual de restauração produz, uma vez por ano, uma **prova** de que o envelope faz o que diz — a única forma de saber isso antes de precisar.

**Negativas.** Um processo a mais para operar, monitorar e atualizar numa VPS única — e um processo cuja indisponibilidade quebra sincronização e login com MFA, ainda que o resto do produto continue de pé. Na opção B, todo reboot exige desselamento, que é trabalho humano num sistema que deveria subir sozinho; e a tentação de automatizar o desselamento guardando a chave de desselamento no host desfaz a ADR inteira em uma linha de `docker-compose` — este é o modo de falha mais provável desta decisão, e ele é humano, não técnico. A latência de cada desembrulho cresce (socket Unix é barato, KMS de rede não é), o que importa no job de sincronização em lote. O sandbox de parsing torna a importação mais lenta e mais complicada de depurar, e vai gerar pressão para "só desta vez" rodar o parser no processo principal. O rate limit do guardião pode gerar falso positivo numa migração legítima em massa, e o procedimento de desbloqueio precisa existir antes de ser necessário. E a decisão de destruir a KEK antiga somente após N dias significa que, por N dias após uma rotação de emergência, a chave comprometida ainda destrava backups — o que é indefensável se a rotação foi motivada por vazamento da própria KEK, e nesse caso o procedimento correto é rotacionar **e** destruir os backups do período, aceitando a perda.

## Alternativas rejeitadas

**KEK em `.env` no mesmo host da aplicação.** É o que o spec produziria por omissão, e é o padrão de fato de uma VPS com `docker-compose`. Rejeitada: é exatamente o quarto elo do caminho A-32, e falha contra os dois vetores mais prováveis do produto — leitura de arquivo por parser hostil e cópia de backup. Um envelope cuja chave está ao lado do cofre não é envelope; é um passo a mais para o atacante.

**Uma DEK global, ou cifrar direto com a KEK.** Menos código, menos colunas. Rejeitada: sem DEK por conexão não existe crypto-shredding — revogar um consentimento não teria como destruir só aquela credencial —, e o raio de dano de qualquer comprometimento vira a base inteira. A DEK por conexão é o que torna a revogação um ato técnico em vez de um rótulo.

**`pgcrypto` com a chave passada na query.** Nativo, sem processo novo. Rejeitada por três razões independentes: a chave aparece no `pg_stat_activity` e nos logs de query lenta; o Postgres passa a ser o lugar onde o texto claro existe, o que anula o propósito de a chave estar "fora do banco"; e um dump com a chave em qualquer log de sessão entrega tudo.

**Cifragem de disco / TDE como substituto.** Rejeitada: protege contra roubo do disco desligado e contra nada mais. Não protege contra `pg_dump`, contra leitura de arquivo por processo comprometido, nem contra o backup — que são os três caminhos reais deste produto.

**Sem AAD.** Um campo a menos, um erro a menos de reconstrução de contexto. Rejeitada: sem AAD o envelope autentica que o blob não foi corrompido, e não autentica que ele pertence àquela linha. Quem tiver escrita no banco move o blob e desembrulha. É a diferença entre "cifrado" e "cifrado corretamente", e ela não custa nada.

**Rotação big-bang, sem `kek_versao`.** Uma coluna a menos. Rejeitada: obriga a reenvelopar tudo numa transação, com indisponibilidade e com um ponto de falha que perde credenciais se cair no meio — e, na prática, produz o resultado de que ninguém rotaciona nunca, porque o procedimento é assustador demais para ser executado.

**Guardar a KEK num serviço, mas deixar a API buscá-la no boot e mantê-la em memória.** Parece equivalente e é bem mais simples de implementar. Rejeitada: a KEK volta a existir como bytes dentro do processo que executa código de aplicação, e um `/proc/self/maps` ou um core dump a recupera. A propriedade que interessa não é "a KEK veio de longe" — é "a KEK nunca está no processo que o atacante alcança".

**Rodar o parser no mesmo processo, confiando na desabilitação de DTD.** Um controle em vez de dois, e a configuração do parser é barata. Rejeitada: é confiar a totalidade do ativo mais valioso do sistema a uma opção de biblioteca que uma atualização de dependência pode redefinir em silêncio, num ecossistema onde exatamente isso já aconteceu várias vezes. E não cobre o OCR, que é código nativo onde o vetor é RCE, não XXE — contra RCE, configuração de parser não faz nada. A defesa precisa ser estrutural: no processo certo não há o que roubar.

**Deixar a decisão de custódia (D3.3) para o momento da implementação.** Rejeitada como forma: é precisamente assim que a decisão vira `.env`. A escolha entre A e B pode ficar aberta; a proibição de D3.1 não fica.
