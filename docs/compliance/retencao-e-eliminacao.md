# Retenção e eliminação de dados pessoais

- **Data:** 2026-09-01
- **Autor:** `especialista-lgpd-compliance`
- **Status:** Normativo. É o **estado alvo** para o qual o job `retencao.aplicar` converge. Contradizer este documento exige ADR.
- **Destrava:** B-01, B-02, B-03, B-04, B-05, B-06, B-07, B-09, B-11, B-12, B-13, B-14, B-15, B-16, B-17 do `docs/validacao/gate-risco-spec.md`
- **Insumos:** LGPD (Lei 13.709/2018), arts. 6º, 7º, 9º, 11, 12, 13, 16, 18, 33, 37, 39, 46, 48 · `docs/arquitetura/sistema.md` §3 e §5.2 · `CONTEXT.md` · `CLAUDE.md` §2 (regras 16–20) · `docs/produto/arquitetura-informacao.md` §2.10–2.13
- **Documentos irmãos:** `docs/seguranca/matriz-de-acesso.md` · `docs/adr/0018-envelope-encryption.md`

> Este documento existe porque `sistema.md` §5.2 define o job `retencao.aplicar` como *"declarativo: converge para o estado alvo"* e o estado alvo não estava definido em documento nenhum. Das ~35 classes de dado pessoal do produto, duas tinham prazo. Um job de retenção sem política é pior do que não ter job, porque produz a impressão de que o assunto está resolvido.

---

## 1. Como este documento vira código

Três artefatos, nesta ordem:

1. **`packages/domain/retencao/politica.ts`** — transcrição literal das tabelas da §3. Uma entrada por classe, com `{ tabela, colunas, gatilho, prazo, acao }`. Puro, sem I/O, testado em S1.
2. **`apps/api/src/retencao/aplicar.ts`** — o processador do job. Lê a política como configuração versionada em código, nunca como parâmetro de runtime. Executa sob o papel `mavia_retencao` (§4.3), por tenant, com `SET LOCAL app.tenant_id`.
3. **Teste que quebra o build (S1):** um teste percorre o schema Drizzle e falha se existir tabela sem entrada na política, ou entrada na política sem tabela. **Criar tabela nova sem declarar retenção não compila.** É o único mecanismo que faz esta conformidade sobreviver ao épico 12 — sem ele, este documento envelhece em três sprints.

**Métricas obrigatórias por classe:** `mavia_retencao_vencidos`, `mavia_retencao_tratados`, `mavia_retencao_falhas`. Falha em qualquer classe é alerta ao operador, não linha de log.

**Vocabulário das ações.** Uma palavra, um mecanismo:

| Ação | O que é, exatamente |
|---|---|
| `apagar` | `DELETE` físico da linha, e do objeto no storage quando houver. Não é `deleted_at` |
| `anonimizar` | Substituição irreversível do identificador **com destruição do caminho de reidentificação** (§4.4). Depois disso o registro sai do escopo da LGPD (art. 12) |
| `pseudonimizar` | Substituição reversível mediante segredo separado (art. 13 §4). **Estado intermediário, nunca estado final** |
| `truncar` | `DROP PARTITION` de partição inteira vencida. O único descarte viável em volume |
| `crypto-shred` | Destruição da DEK, tornando o texto cifrado irrecuperável mesmo a partir de cópias (ADR 0018) |
| `descartar` | Dado derivado, recalculável. Pode sumir a qualquer momento sem consequência jurídica |

---

## 2. Princípios e limites

### 2.1 "Para sempre" não é prazo

Toda classe tem prazo em unidade de tempo e um **gatilho de contagem** — o evento a partir do qual o relógio corre. `sistema.md` §3.6 diz que a auditoria é "permanente" e, três palavras depois, "retenção maior por compliance". As duas frases não concordam entre si e nenhuma delas é um prazo. Este documento substitui as duas (§8).

### 2.2 O que a Mavia deliberadamente **não** coleta

Declarar a ausência vale tanto quanto declarar a presença: dado não coletado é dado que não vaza, e a lista abaixo é o que impede alguém de adicionar um campo "porque pode ser útil".

| Não coletamos | Por quê |
|---|---|
| **CPF ou qualquer documento** | Nenhuma funcionalidade do MVP precisa. Não existe coluna no modelo de dados, e criar uma exige ADR |
| **Número de cartão (PAN), CVV, validade** | `Cartao` guarda nome, limite, `closing_day` e `due_day`. Não somos ambiente de pagamento e não entramos no escopo PCI-DSS. **Veto:** nenhuma coluna de PAN, em nenhuma tabela, em nenhum épico |
| **Geolocalização** | Já recusada por decisão de produto (`arquitetura-informacao.md` §2.3) com o argumento correto: dado sensível sem retorno claro |
| **Endereço, telefone, data de nascimento** | Não usados. Telefone entraria só com MFA por SMS, que não é a decisão (TOTP — A-17) |
| **Senha bancária em texto claro, em qualquer momento fora da transação de escrita** | Regra 19 + ADR 0018. Para o adapter `pluggy`, a credencial do banco **nunca chega à Mavia** (ADR 0018 §D0) |
| **Contatos, agenda, lista de apps instalados no mobile** | Não pedimos a permissão |

### 2.3 Campos livres são coletores incidentais de dado sensível

`lancamentos.descricao`, `lancamentos.observacao`, `objetivos.nome` e `etiquetas.nome` são texto livre. Um extrato real contém `"Consulta Dra. Fulana — oncologia"`, `"Dízimo Igreja X"`, `"Advogado do divórcio"`, `"Farmácia — insulina"`. Isso é **dado sensível na acepção do art. 5º II** (saúde, convicção religiosa, filiação política) chegando por inferência a partir de dado comum, e o regime de tratamento muda em três pontos concretos:

1. **Nunca sai para terceiro** sem base própria e aviso no ponto de uso (§9).
2. **Nunca aparece** em log, métrica, mensagem de erro, push ou e-mail (regra 20, A-38, A-43).
3. **Nunca é escrito em claro em `auditoria.de/para`** — vai como hash + comprimento (§8.2).

**O que não fazemos:** criar campo estruturado de saúde, religião ou política, em nenhuma hipótese. A inferência incidental é tolerável — a coleta deliberada não é, e mudaria o regime do produto inteiro (art. 11).

### 2.4 O `Tenant` é a unidade de isolamento; não é a unidade de titularidade

Esta é a tensão estrutural do compartilhamento familiar, e ela governa metade das decisões deste documento:

> Cada membro é titular dos **seus** dados pessoais, dentro de um espaço que é **coletivo**. Todo direito do art. 18 é individual; quase todo dado do espaço é compartilhado. Onde os dois colidem, vale: **o art. 18 VI alcança o dado do qual o requerente é titular, e não alcança o dado de terceiros que ele por acaso consegue ler.**

Consequência prática, escrita para não ser redescoberta em produção: quando a pessoa B pede eliminação, os `Lancamento` do espaço **permanecem**. Eles são o saldo de A também. Eliminá-los seria eliminar dado de que A é cotitular, a pedido de B — o que a LGPD não autoriza e o produto não pode fazer sem quebrar o saldo de outra pessoa. O que é eliminado é a **identidade de B** dentro daquele histórico (§5.2).

---

## 3. O mapa de retenção — todas as classes de dado pessoal

Uma linha por classe. **Finalidade em uma frase**: se não coube numa frase, a finalidade não está clara e não há base legal.

Colunas: **Classe** · **Finalidade** · **Base legal** · **Gatilho de contagem** · **Prazo** · **No vencimento** (verbo do §1 + o que acontece exatamente).

### 3.1 Identidade e acesso

| Classe | Finalidade | Base legal | Gatilho | Prazo | No vencimento |
|---|---|---|---|---|---|
| `usuarios.email` | Identificar e autenticar quem acessa | Execução de contrato (7º V) | Eliminação da conta, a pedido do titular | Vida da conta | `apagar` — `DELETE` físico da linha em `usuarios` |
| `usuarios.senha_hash` | Provar que quem acessa é quem diz ser | Execução de contrato | Idem | Vida da conta | `apagar` com a linha |
| `usuarios.nome` | Atribuir ações a pessoas no espaço compartilhado | Execução de contrato | Idem | Vida da conta | `apagar` com a linha |
| `usuarios.mfa_segredo_cifrado` | Verificar o segundo fator | Execução de contrato + legítimo interesse (7º IX) | Desativação de MFA, ou eliminação da conta | Até o gatilho | `crypto-shred` — DEK do propósito `usuario.mfa` destruída (ADR 0018) |
| `usuarios.ultimo_acesso_em` | Detectar conta comprometida e conta inativa | Legítimo interesse (7º IX) | Eliminação da conta | Vida da conta | `apagar` com a linha |
| `sessoes.*` (`refresh_hash`, `dispositivo`, `familia_id`) | Manter a sessão aberta e permitir revogá-la | Execução de contrato + legítimo interesse | `expira_em` ou `revogada_em`, o que vier antes | **90 dias** | `apagar` — a janela existe só para investigar reuso de refresh (A-14) |
| `codigos_recuperacao_mfa` (hash) | Permitir recuperar acesso sem suporte humano | Execução de contrato | Consumo do código, ou desativação de MFA | Até o gatilho | `apagar` |
| `tickets_step_up` (Redis) | Autorizar uma operação sensível pontual | Legítimo interesse (segurança) | Emissão | **5 min** | `apagar` — TTL do Redis, não job |
| `contadores_rate_limit` (Redis, hash do e-mail e IP) | Conter força bruta e enumeração | Legítimo interesse (7º IX) | Última tentativa | **15 min** (auth) / **24 h** (cotas diárias) | `apagar` — TTL. **A chave nunca contém e-mail em claro** (A-13) |

### 3.2 Espaço, vínculo e convite

| Classe | Finalidade | Base legal | Gatilho | Prazo | No vencimento |
|---|---|---|---|---|---|
| `tenants.nome`, `timezone` | Nomear e localizar o espaço do titular | Execução de contrato | Eliminação do espaço | Vida do contrato | `apagar` |
| `tenant_usuarios` (`papel`, `convidado_por`, `aceito_em`, `termo_versao`) | Registrar quem entrou no espaço, quando, a convite de quem e sob qual termo | Execução de contrato + exercício de direitos (7º VI) | `removido_em` | **5 anos** após a saída | `anonimizar` — o vínculo permanece como prova; `usuario_id` vira `membro_removido:<hash>` conforme §4.4 |
| `tenant_usuarios` — exibição do nome do ex-membro | Mostrar em Atividades quem fez o quê enquanto era membro | Execução de contrato | `removido_em` | **90 dias** | `anonimizar` na exibição: a UI passa a mostrar "Membro removido" (B-09) |
| `convites` (e-mail de quem ainda não é usuário) | Entregar o convite para o espaço | Legítimo interesse do convidante (7º IX), com LIA em §8.1 | Emissão | Validade **7 dias**; e-mail apagado em **30 dias**, ou na hora se recusado | `apagar` — dado de **terceiro** que não contratou nada. Nunca usado para marketing, nunca para sugerir conexões (B-10) |
| `preferencias` (`ordenacao`, `periodo_padrao`, `base_temporal_cartao`…) | Guardar como o titular quer ver o produto | Execução de contrato | Fim do vínculo `(tenant, usuario)` | Com o vínculo | `apagar` |

### 3.3 Dados financeiros do espaço

Todas as classes abaixo têm a mesma finalidade-mãe — *permitir que o titular controle o próprio dinheiro* — e a mesma base legal, execução de contrato (art. 7º V). O que varia é o prazo e o que acontece no descarte.

| Classe | Finalidade | Base legal | Gatilho | Prazo | No vencimento |
|---|---|---|---|---|---|
| `lancamentos.*` (valor, datas, conta/cartão, status) | Calcular saldo, fatura e relatório | Execução de contrato | `deleted_at` (exclusão pelo usuário) | **12 meses** após `deleted_at` | `apagar` — o soft delete é a operação de produto; a purga física é o fim do ciclo (§4.2) |
| `lancamentos.descricao`, `.observacao` | Permitir que o titular reconheça o próprio movimento | Execução de contrato | Idem | Idem | `apagar`. Campo livre — §2.3 vale integralmente |
| `lancamentos.criado_por` | Dizer, no espaço compartilhado, quem lançou | Execução de contrato | Saída do membro, ou eliminação do titular | **90 dias** após a saída | `anonimizar` (§4.4) — o lançamento fica, a autoria some |
| `lancamento_etiquetas` | Classificar transversalmente | Execução de contrato | Com o lançamento | Com o lançamento | `apagar` em cascata |
| `contas` (`nome`, `saldo_inicial`, `tipo`) | Representar onde o dinheiro repousa | Execução de contrato | `deleted_at` | 12 meses após `deleted_at` | `apagar`. `arquivada_em` **não** dispara retenção — arquivar não é excluir |
| `cartoes` (`nome`, `limite`, ciclo) | Representar a dívida rotativa | Execução de contrato | `deleted_at` | 12 meses | `apagar` |
| `categorias`, `etiquetas` (`nome`) | Classificar. `etiquetas.nome` é campo livre — §2.3 | Execução de contrato | `deleted_at` | 12 meses | `apagar` |
| `transferencias`, `parcelamentos`, `faturas` | Preservar os fatos que pertencem à operação e não a cada linha | Execução de contrato | `deleted_at` do grupo | 12 meses | `apagar` em cascata com as pernas/parcelas |
| `recorrencias` | Guardar a regra que gera lançamentos repetidos | Execução de contrato | `deleted_at` | 12 meses | `apagar` |
| `planejamentos` | Comparar realizado contra teto e piso do mês | Execução de contrato | `deleted_at` | 12 meses | `apagar` |
| `objetivos.nome`, `valor_alvo`, `prazo` | Nomear o que o titular está juntando dinheiro para fazer | Execução de contrato | `deleted_at` | 12 meses | `apagar`. `objetivos.nome` é campo livre — §2.3 |
| `aportes` (vínculo `Lancamento` ↔ `Objetivo`) | Apurar o progresso do objetivo por aportes | Execução de contrato | Com o objetivo ou com o lançamento | Com o menor dos dois | `apagar` |
| `saldo_snapshots` | Acelerar a leitura de saldo | Execução de contrato (derivado) | — | **Derivado** | `descartar` a qualquer momento; recalculável a partir dos lançamentos |
| `notificacoes.payload` | Avisar o titular de um evento do seu dinheiro | Execução de contrato; **consentimento por canal** para push e e-mail | `enviado_em`, ou `agendado_para` se nunca enviada | **180 dias** | `apagar`. O payload que sai para push/e-mail **nunca contém valor monetário nem descrição** (A-43) |
| `anexos` (linha + objeto no storage) | Guardar o comprovante do lançamento | Execução de contrato | `deleted_at` do lançamento, ou exclusão do anexo | **90 dias** | `apagar` a linha **e o objeto**. Recibos são o caminho mais provável de dado de saúde entrar (§9.3) |
| `exportacoes` (linha + objeto) | Entregar a portabilidade pedida | Execução de contrato + direito do titular (18 V) | Criação | `expira_em` ≤ **7 dias** | `apagar` a linha **e o objeto do storage** (A-28) |
| `outbox.payload` | Publicar o evento de domínio sem janela de perda | Execução de contrato | `publicado_em` | **72 h** | `apagar`. O payload carrega descrição e valor — não é fila inócua, é dado financeiro em trânsito (A-01) |
| `mutacoes_sync` (idempotência do mobile) | Impedir que um retry crie o lançamento duas vezes | Execução de contrato | Aplicação da mutação | **30 dias** | `apagar` |

### 3.4 Ingestão bancária e consentimento

| Classe | Finalidade | Base legal | Gatilho | Prazo | No vencimento |
|---|---|---|---|---|---|
| `conexoes.credenciais_cifradas` | Autorizar a Mavia a ler o extrato daquela instituição | **Consentimento** (7º I), específico e destacado | `revogado_em`, `valida_ate`, ou exclusão | **Imediato** na revogação, síncrono | `crypto-shred` — `dek_cifrada = NULL` e `credenciais_cifradas = NULL` na **mesma transação** (§10, ADR 0018) |
| `conexoes.dek_cifrada` | Envelopar a credencial daquela conexão | Consentimento | Idem | Imediato | `crypto-shred` |
| `conexoes.escopo` | Mostrar ao titular o que ele autorizou | Consentimento + transparência (art. 9º) | `revogado_em` | Imediato para o escopo operacional; a cópia probatória vive em `consentimentos` | `apagar` a coluna; a prova fica na tabela própria |
| `conexoes` metadados (`instituicao`, `provider`, `status`, datas, `criado_por`) | Mostrar o histórico de conexões e provar o que existiu | Execução de contrato + exercício de direitos | Revogação | **5 anos** | `anonimizar` — `criado_por` conforme §4.4 |
| `consentimentos.*` (`versao_texto`, `escopo`, `concedido_em`, `expira_em`, `revogado_em`) | **Provar** que o consentimento foi dado, quando, por quem e para quê | Obrigação legal / exercício de direito (7º II e VI); o ônus da prova é do controlador (art. 8º §2º) | `revogado_em` ou `expira_em` | **5 anos** após a revogação | `apagar` — expurgo por job. Enquanto o prazo corre, `consentimentos` é a única tabela que **sobrevive à eliminação do espaço** (§5.3) |
| `consentimentos.ip_hash`, `.user_agent_hash` | Corroborar o ato de consentimento | Obrigação legal | Com o registro | Com o registro (5 anos) | `apagar` com a linha. **`HMAC-SHA256` com pepper de 256 bits no guardião de chaves**, nunca hash simples (A-39) |
| `sincronizacoes.*` | Mostrar o histórico e diagnosticar falha de sincronização | Execução de contrato | `terminada_em` | **12 meses** | `apagar` |
| `lancamentos_brutos.payload` | Preservar o registro cru para auditar e reprocessar a importação | Execução de contrato, **após minimização** (§7) | Promoção, ou criação se não promovido | **7 dias** se não promovido · **90 dias** se promovido · **imediato** se a conexão foi revogada | `apagar`. Contém dado de **terceiros** — o prazo é curto por necessidade (art. 6º III), não por conveniência |
| `lancamentos_brutos` campos normalizados (`posted_at`, `valor`, `descricao_origem`, `conteudo_hash`) | Sustentar a idempotência da regra 13 | Execução de contrato | Idem `payload` | **24 meses** — o hash precisa sobreviver ao payload para que reimportar não duplique | `apagar`. Só o `conteudo_hash` e o `external_id` seguem além do payload |
| `conciliacao_sugestoes` (`score`, `motivo`) | Casar importado com manual sem sobrescrever o registro do usuário | Execução de contrato | `decidida_em`; se pendente, `criado_em` | **90 dias** após decisão · **180 dias** se nunca decidida | `apagar` |
| `regras_categorizacao` (`condicoes JSONB`) | Classificar automaticamente conforme a regra do próprio titular | Execução de contrato | `deleted_at` | 12 meses | `apagar`. `condicoes` pode conter trecho de descrição — campo livre, §2.3 |

### 3.5 Registro, segurança e acesso programático

| Classe | Finalidade | Base legal | Gatilho | Prazo | No vencimento |
|---|---|---|---|---|---|
| `auditoria` — eventos de **escrita financeira** | Registrar quem alterou o quê, para transparência entre membros e apuração | Legítimo interesse (7º IX) + accountability (arts. 37 e 46), com **LIA em §8.1** | `ocorrido_em` | **90 dias** visíveis na tela · **5 anos** de retenção interna | `truncar` — `DROP PARTITION` mensal vencida (§8.3) |
| `auditoria` — eventos de **segurança** (login, senha, sessão, MFA, membros, chaves) | Apurar incidente e responder ao art. 48 | Legítimo interesse + obrigação de segurança (art. 46) | `ocorrido_em` | **5 anos** | `truncar` |
| `auditoria` — eventos de **leitura em massa** (exportação, download de anexo, requisição por token/chave, sincronização, envio a fornecedor de IA) | Saber, num vazamento, **quem foi afetado e quais dados** (art. 48) | Legítimo interesse (7º IX) | `ocorrido_em` | **12 meses** | `truncar` |
| `auditoria.usuario_id` | Atribuir a ação a uma pessoa | Legítimo interesse | Saída do membro ou eliminação do titular | **90 dias** após a saída | `anonimizar` (§4.4) — a ação fica, o autor some |
| `auditoria.de/para` | Mostrar o antes e o depois na tela Atividades | Legítimo interesse | Com a partição | Com a partição | `truncar`. **Minimizado na escrita** (§8.2): campo livre e valor entram como hash + comprimento |
| `auditoria.ip_hash`, `.user_agent_hash` | Investigar acesso indevido | Legítimo interesse | Com a partição | Com a partição | `truncar`. HMAC com pepper (A-39); a rotação do pepper a cada 12 meses limita a janela de correlação, e isso é desejado |
| `retencao_execucoes` | Provar que a política foi executada, quando, sobre o quê e por quem | Accountability (art. 37) | `executado_em` | **5 anos** | `apagar`. **Não contém dado pessoal** — só classe, contagem e horário. É a âncora imutável da cadeia (§4.3) |
| `eliminacoes_journal` | Garantir que uma restauração de backup não ressuscite dado eliminado | Obrigação de eliminar (art. 18 VI) | `concluido_em` | **5 anos** | `apagar`. Guarda apenas `(tenant_id \| usuario_id, tipo, concluido_em)` — nenhum conteúdo. **Vive fora do domínio de backup do Postgres** (§5.5) |
| `chaves_api` (`hash`, `ultimos_4`, escopo, `ultimo_uso_em`, `ultimo_ip_hash`) | Permitir acesso programático rastreável e revogável | Execução de contrato | Revogação ou expiração | Expiração obrigatória ≤ **365 dias**, padrão 90; registro de uso **12 meses** após revogar | `apagar` |
| `autorizacoes_oauth` / `tokens` | Permitir que um app de IA leia o espaço, com prazo | Consentimento (7º I) do titular à autorização | `revogado_em` ou expiração | Autorização **90 dias**; access token ≤ 15 min; refresh até rotação | `apagar`. Token é opaco e verificado a cada requisição — revogar corta em ≤ 60 s |
| `clientes_oauth` (dados do desenvolvedor) | Registrar quem opera o app conectado | Execução de contrato com o desenvolvedor | Descadastro | 5 anos | `apagar` |

### 3.6 Cobrança (épico 11, declarado agora)

| Classe | Finalidade | Base legal | Gatilho | Prazo | No vencimento |
|---|---|---|---|---|---|
| Dados de assinatura e nota fiscal (nome, documento se exigido pelo fisco, valor, data) | Cumprir obrigação fiscal e tributária | **Obrigação legal** (7º II) | Emissão do documento fiscal | **5 anos** (prazo decadencial tributário) | `apagar`. Esta é a **única** classe que sobrevive à eliminação do espaço além de `consentimentos`, e a razão precisa estar escrita na política de privacidade |
| Dados de cartão de pagamento | — | — | — | **Não coletamos.** Tokenização pelo gateway; a Mavia guarda o token do gateway e os últimos 4 dígitos, nada mais | — |

### 3.7 Inteligência (épico 7, condicionado a §9)

| Classe | Finalidade | Base legal | Gatilho | Prazo | No vencimento |
|---|---|---|---|---|---|
| Registro de envio a fornecedor de IA/OCR (`o que`, `para quem`, `quando`, hash do conteúdo) | Reconstituir, num incidente do fornecedor, exatamente o que saiu | Legítimo interesse (7º IX) + art. 48 | `enviado_em` | **12 meses** | `truncar` com a partição de leitura de `auditoria`. **O conteúdo enviado nunca é persistido** — só hash e comprimento |
| Resultado do OCR (`anexo.ocr`) | Sugerir os campos do lançamento a partir do comprovante | Execução de contrato | Confirmação ou descarte pelo usuário | **7 dias**, ou imediato após confirmação | `apagar`. Sugere, nunca preenche valor sozinho |
| Contadores de qualidade do modelo (aceitou / rejeitou a sugestão) | Medir se a categorização automática está melhorando | Legítimo interesse (7º IX) | Agregação diária | Contadores agregados: **indefinido**, porque **não são dado pessoal** (art. 12) | `agregar` na origem: o contador nasce sem `usuario_id` e sem texto. Ver §9.4 |

---

## 4. A colisão: regra 17 × regra 18 × art. 18 VI

As três não podem estar todas certas ao mesmo tempo:

- **Regra 17** (`CLAUDE.md`): *"Soft delete em tudo que é financeiro. `deleted_at`, nunca `DELETE`."*
- **Regra 18** (`CLAUDE.md`): *"Audit log append-only em toda escrita financeira"*, implementada como `REVOKE UPDATE, DELETE ON auditoria`.
- **Art. 18 VI da LGPD:** o titular tem direito à **eliminação** dos dados tratados com seu consentimento. E o art. 16 determina que o dado seja eliminado após o término do tratamento.

Soft delete não é eliminação. Um log que ninguém pode alterar não pode ser expurgado. Se as três valem literalmente, o produto **não consegue eliminar nada** e a afirmação "eliminamos seus dados" na política de privacidade é falsa.

### 4.1 A resolução, em uma frase

> **Cede a regra 17, por reescopamento — e cede a leitura ampliada da regra 18, não o seu texto. O art. 18 VI não cede, e não precisa: a LGPD aceita a anonimização como forma de encerrar o tratamento (art. 12), desde que a anonimização seja real.**

### 4.2 Por que a regra 17 é quem cede

Duas razões, e a segunda importa mais que a primeira.

**A primeira é hierárquica.** A regra 17 é uma convenção de engenharia deste repositório. O art. 18 VI é lei. Uma convenção não revoga uma obrigação legal, e portanto a pergunta útil não é "qual das duas está certa" — é "qual é o escopo real de cada uma".

**A segunda é sobre o que a regra 17 foi escrita para impedir.** Ela existe contra **um** modo de falha: código de aplicação destruindo histórico financeiro por acidente, por `DELETE` sem `WHERE`, ou por uma decisão de produto descuidada. Esse modo de falha vive inteiramente **dentro da vida de um espaço ativo**. A regra 17 nunca teve nada a dizer sobre o fim da relação, porque no fim não sobrou saldo para proteger.

Reescopada, ela fica assim — e continua tão forte quanto era:

> **A regra 17 vincula o papel `mavia_app` e toda operação que um usuário executa dentro de um espaço vivo. Ela não vincula o papel `mavia_retencao` nem o job de eliminação. `DELETE` físico existe, e existe em exatamente três lugares: a expiração de prazo da §3, a eliminação do titular (§5.2) e a eliminação do espaço (§5.3). Cada um é nominado, auditado, e alcançável apenas por um papel que não sabe fazer mais nada.**

Nenhuma exceção nova, nenhum `if` em código de aplicação: `mavia_app` continua sem `DELETE` nas tabelas financeiras. O que muda é que existe **um segundo caminho**, com outro papel de banco, outro processo e outro log.

### 4.3 O que a regra 18 concede, exatamente

O texto da regra 18 permanece literal: `REVOKE UPDATE, DELETE ON auditoria FROM mavia_app`. O que deixa de valer é a leitura não escrita de que *ninguém, nunca* pode tocar a auditoria.

```sql
CREATE ROLE mavia_retencao NOLOGIN;
-- Não tem SELECT em nenhuma tabela de negócio.
GRANT UPDATE (usuario_id, de, para) ON auditoria TO mavia_retencao;
GRANT INSERT ON retencao_execucoes TO mavia_retencao;
-- Partições vencidas: DROP concedido por procedimento SECURITY DEFINER, nunca DROP amplo.
```

Cinco travas, todas verificáveis:

1. `mavia_retencao` pode `UPDATE` **três colunas** de `auditoria` (`usuario_id`, `de`, `para`) e nada mais. Não pode inserir, não pode ler outra tabela, não pode alterar `ocorrido_em`, `entidade`, `acao` — **o fato registrado é imutável para sempre; só a identificação do autor e o conteúdo é que envelhecem.**
2. `DROP PARTITION` acontece por procedimento `SECURITY DEFINER` que só aceita partições cujo limite superior é anterior ao prazo da §3.5. Não existe `DROP` arbitrário.
3. Toda execução grava em **`retencao_execucoes`**, que é append-only de verdade (`REVOKE UPDATE, DELETE` para *todos* os papéis, inclusive `mavia_retencao`) e **não contém dado pessoal** — só classe, contagem, horário e versão da política. É a âncora imutável no fim da cadeia: a auditoria pode ser anonimizada, mas o registro de que ela foi anonimizada não pode.
4. `mavia_retencao` não tem `LOGIN`. Ele é assumido por `SET ROLE` dentro do job, a partir de `mavia_jobs`, e a transição é registrada.
5. `mavia_retencao` **não tem `BYPASSRLS`** — o veto de `sistema.md` §3.9 continua sem exceção. O job roda por tenant, com `SET LOCAL app.tenant_id`.

### 4.4 A anonimização precisa ser real, não nominal

Aqui está o erro que a maioria dos projetos comete e que este documento recusa: **trocar `usuario_id` por `hash(usuario_id)` é pseudonimização, não anonimização** (art. 13 §4). Enquanto existir caminho de volta, o dado continua pessoal e continua sob a LGPD — e a afirmação "eliminamos" continua falsa.

A anonimização só se completa quando o caminho de reidentificação é destruído. O mecanismo, portanto, destrói os três caminhos na **mesma execução**:

| Caminho de volta | Como é destruído |
|---|---|
| A tabela `usuarios`, que mapeia `usuario_id` → pessoa | A linha é **apagada fisicamente** no mesmo job (§5.2) |
| O *pepper* usado no hash | `hash = HMAC-SHA256(usuario_id, pepper_do_tenant)`, com pepper de 256 bits guardado no **guardião de chaves** (ADR 0018), nunca no banco. Na eliminação do espaço, o pepper daquele tenant é destruído — e com ele qualquer possibilidade de recomputar o hash a partir de um `usuario_id` conhecido |
| O conteúdo do `de/para`, que poderia identificar por singularidade | Minimizado **na escrita** (§8.2): campo livre e valor entram como hash + comprimento, nunca em claro |

O que sobra em `auditoria` depois disso é: *"às 14:32 de 12/08/2026, `membro_removido:7f3a…` alterou a categoria do lançamento X de A para B"*, sem caminho de volta a uma pessoa. Isso é dado anonimizado no sentido do art. 12, e sai do escopo da lei — e é **defensável**, porque a afirmação é sobre um mecanismo, não sobre uma intenção.

### 4.5 Ordem de precedência para as próximas colisões

Escrita agora para que a próxima não seja re-litigada:

1. **Obrigação legal enumerada** (fiscal, prova de consentimento) — lista fechada, uma linha por item na §3.
2. **Art. 18 VI — eliminação**.
3. **Regra 18 — append-only**, no escopo do §4.3.
4. **Regra 17 — soft delete**, no escopo do §4.2.

A convenção de engenharia é o último item porque é a única que este time pode reescrever sozinho.

### 4.6 As duas exceções que precisam estar na política de privacidade

Uma promessa de eliminação com exceções não declaradas é uma promessa falsa. São duas, e as duas são inevitáveis:

1. **Backups.** O dado eliminado sobrevive nas cópias de segurança por até **N dias** (§5.5).
2. **Registro anonimizado.** As linhas de `auditoria` sobrevivem sem identificação, pelos prazos da §3.5.

Ambas em português claro na tela "Dados e privacidade", não enterradas nos termos.

---

## 5. O mecanismo de eliminação

### 5.1 Três operações que hoje estão confundidas em uma palavra

| Operação | O que é | Mecanismo | Rota |
|---|---|---|---|
| **Excluir um registro** | Operação de produto dentro de um espaço vivo. **Não é eliminação LGPD** | `deleted_at` (regra 17 intacta), com purga física ao vencer o prazo da §3.3 | `DELETE /lancamentos/:id` etc. |
| **Eliminar o titular** | Direito do art. 18 VI sobre os dados **dele** | `apagar` o que é dele; `anonimizar` a presença dele no que é do espaço | `DELETE /auth/eu` |
| **Eliminar o espaço** | Fim do contrato | `DELETE` físico de todas as tabelas do tenant, purga do storage, crypto-shred das DEKs, destruição do pepper | `DELETE /tenants/:id` |

### 5.2 Eliminar o titular — `DELETE /auth/eu`

**Apagado fisicamente:** a linha em `usuarios` (e-mail, nome, `senha_hash`, `ultimo_acesso_em`), `usuarios.mfa_segredo_cifrado` por crypto-shred, todas as `sessoes`, todos os `codigos_recuperacao_mfa`, todas as `preferencias` e `notificacoes` do titular em todos os tenants, todas as `chaves_api` e autorizações OAuth criadas por ele, e todas as `exportacoes` que ele pediu (linha **e** objeto).

**Anonimizado:** `lancamentos.criado_por`, `transferencias.criado_por`, `auditoria.usuario_id`, `conciliacao_sugestoes.decidida_por`, `conexoes.criado_por`, `tenant_usuarios.usuario_id` — todos para `membro_removido:<hash>`, pelo mecanismo do §4.4.

**Preservado, com a razão escrita:** os `Lancamento` dos espaços de que ele participava. Eles são o saldo dos outros titulares (§2.4). A base do tratamento deles nunca foi o consentimento do eliminado — é a execução do contrato com quem fica (art. 7º V e art. 16 II).

**Preservado por obrigação legal:** `consentimentos` (5 anos, minimizados) e os documentos fiscais da §3.6.

**Bloqueio necessário:** se o titular é o **único `proprietario`** de um tenant que tem outros membros, a eliminação da conta é recusada até que ele transfira a propriedade ou elimine o espaço — um espaço sem proprietário é um espaço sem quem responda por ele. A mensagem nomeia os espaços e oferece as duas saídas.

### 5.3 Eliminar o espaço — `DELETE /tenants/:id`

`DELETE` físico de **todas** as tabelas com aquele `tenant_id`, na ordem de dependência; purga de todos os objetos de storage (anexos e exportações); `crypto-shred` das DEKs de todas as `conexoes`; destruição do pepper de auditoria daquele tenant no guardião de chaves; expurgo de cache e de qualquer índice derivado.

**Sobrevive apenas:**

| O que | Por quê | Como fica |
|---|---|---|
| `consentimentos` | Ônus da prova do controlador (art. 8º §2º) | 5 anos, com `usuario_id` anonimizado e `escopo` reduzido a instituição + data + versão do texto |
| Documentos fiscais (§3.6) | Obrigação legal tributária | 5 anos, fora do banco operacional |
| `eliminacoes_journal` | Impedir que uma restauração ressuscite o espaço | Só `(tenant_id, tipo, concluido_em)`, sem conteúdo |
| `retencao_execucoes` | Accountability (art. 37) | Contagens, sem dado pessoal |

Nada mais. Se alguém precisar acrescentar um item a esta lista, ele vira uma linha aqui com a base legal ao lado — nunca uma exceção em código.

### 5.4 "Começar do zero" — `POST /tenants/:id/comecar-do-zero`

Está em `arquitetura-informacao.md` §2.12 sem definição do que apaga. A definição é esta:

**Apaga fisicamente:** `lancamentos`, `lancamento_etiquetas`, `lancamentos_brutos`, `faturas`, `parcelamentos`, `transferencias`, `aportes`, `conciliacao_sugestoes`, `anexos` (linha **e** objeto), `saldo_snapshots`, `notificacoes` de eventos financeiros.

**Preserva:** `contas` (com `saldo_inicial` intacto), `cartoes`, `categorias`, `etiquetas`, `recorrencias`, `planejamentos`, `objetivos`, `preferencias`, `conexoes`, membros e papéis.

**Grava:** **uma** entrada em `auditoria` com a contagem do que foi apagado por tabela — não uma entrada por linha.

**Avisa, no diálogo, antes da confirmação por digitação:** que os saldos das contas voltam ao saldo inicial, que a operação **não tem desfazer**, e que o registro em Atividades de que a limpeza aconteceu permanece.

### 5.5 Prazos, jobs e backups

| Item | Regra |
|---|---|
| Janela de arrependimento | **7 dias** para `DELETE /auth/eu` e `DELETE /tenants/:id`, comunicada ao titular por e-mail no ato, com link de cancelamento |
| Execução | Job `eliminacao.aplicar`, **nunca** ticket humano. Idempotente, retomável, por lote |
| Prazo total | ≤ **30 dias** entre o pedido e a conclusão, com e-mail de confirmação ao concluir |
| Reautenticação | Obrigatória nas duas rotas (`matriz-de-acesso.md` §4) |
| Backups | O dado eliminado sobrevive nos backups por até **N dias**, onde N é a retenção de backup definida por `sre-devops-vps` — **N ≤ 90 é requisito desta política**, e o valor efetivo precisa ser declarado na política de privacidade |
| Restauração | **Uma restauração re-executa a fila de eliminações pendentes antes de servir tráfego.** Não é opcional e não é um passo de runbook que alguém pode pular: é um `preflight` que impede o processo de aceitar requisições |
| Onde a fila de eliminações vive | `eliminacoes_journal` é replicado **fora do domínio de backup do Postgres**. Se ele vivesse só no banco, restaurar o banco restauraria também o esquecimento de que havia eliminações a executar — o backup desfaria a própria correção. Este é o detalhe que faz a §4.6.1 ser uma exceção limitada em vez de um furo |
| Prazo real de descarte de credencial | O crypto-shred torna a credencial irrecuperável **exceto** a partir de um backup anterior à revogação que contenha a DEK. **Isso fixa N como o prazo real de descarte da credencial bancária** — e é a razão pela qual N tem teto nesta política, e não é só uma decisão de infraestrutura (ADR 0018) |

---

## 6. O que a exportação precisa enumerar

`escopo JSONB` livre é uma promessa não verificável. `zEscopoExportacao` em `packages/contracts` enumera as entidades abaixo, e a exportação "tudo" as inclui **todas** por padrão.

### 6.1 Entidades exportadas

`tenant` (nome, timezone, plano) · `membros` (nome, papel, `aceito_em` — e-mail apenas para `proprietario`) · `contas` · `cartoes` · `categorias` · `etiquetas` · `lancamentos` · `lancamento_etiquetas` · **`transferencias`** · **`parcelamentos`** (com `data_compra`) · **`faturas`** · **`recorrencias`** · **`planejamentos`** · **`objetivos`** · **`aportes`** · **`conexoes`** (metadados, nunca a credencial) · **`consentimentos`** · **`sincronizacoes`** · **`lancamentos_brutos`** (campos normalizados, nunca o `payload`) · **`conciliacao_sugestoes`** · **`regras_categorizacao`** · **`anexos`** (metadados **e** os binários) · **`notificacoes`** · **`preferencias`** · **`atividades`** · `chaves_api` e `apps_conectados` (metadados, nunca o segredo).

As em negrito são as que o gate encontrou **ausentes dos dois fluxos** (B-02). `saldo_snapshots` fica de fora com justificativa declarada: é derivado e recalculável.

### 6.2 Formato — portabilidade de verdade (art. 18 V)

Um ZIP contendo:

- **`manifesto.json`** — versão do schema, data de geração, tenant, escopo pedido, base temporal declarada, e o aviso explícito de que **valores monetários são inteiros de centavos** com a moeda ao lado. Sem esse aviso, quem receber o arquivo divide por 100 errado.
- **um `.jsonl` por entidade** — uma linha por registro, legível por máquina, com os nomes de campo do `CONTEXT.md`.
- **`anexos/`** — os binários, com o nome original sanitizado e um índice apontando para o `id` do lançamento.

O CSV e o OFX de lançamentos de `arquitetura-informacao.md` §2.2 continuam existindo como conveniência de produto. **Eles não são a portabilidade** — um CSV de lançamentos não transfere parcelamentos, objetivos nem consentimentos.

### 6.3 Regras de conteúdo

1. **A exportação nunca contém mais do que o solicitante já pode ler pela API.** O gerador aplica a `matriz-de-acesso.md`: para `membro` e `visualizador`, filtra as atividades de segurança de outros membros e omite o e-mail dos demais. Sem isso, a exportação vira um caminho de escalada de leitura.
2. **Nunca sai:** `senha_hash`, `refresh_hash`, `mfa_segredo_cifrado`, `credenciais_cifradas`, `dek_cifrada`, `ip_hash`, `user_agent_hash`, `lancamentos_brutos.payload`. Os mesmos sete campos da regra R-5 da matriz de acesso.
3. **`lancamentos_brutos`** sai normalizado. O payload cru contém agência, conta e chave Pix de **terceiros** (§7) — exportá-lo entregaria a um titular o dado pessoal de pessoas que nunca contrataram a Mavia.
4. **Prazo:** gerada automaticamente em ≤ **72 h**, e nunca mais de **15 dias** (art. 19 §3º combinado com a expectativa razoável do titular).
5. **Saída de membro:** ao ser removido, o ex-membro recebe automaticamente uma exportação do que **ele** criou, disponível por 30 dias, com aviso por e-mail (B-09). É o único caminho pelo qual ele exerce portabilidade depois de perder o acesso.

### 6.4 O teste que impede a regressão

Um teste (S2) percorre o schema Drizzle e falha se uma tabela de negócio não estiver em `zEscopoExportacao` **nem** numa lista explícita de exclusões justificadas. É o mesmo mecanismo do §1, e é o que faz esta conformidade sobreviver ao épico 12. Sem ele, a décima entidade nasce fora dos dois fluxos exatamente como as dezoito primeiras nasceram.

---

## 7. `lancamentos_brutos.payload` — dado cru de terceiros, sem prazo

**O problema.** *"Preservado para auditoria e reprocessamento"* (`CONTEXT.md`) não é prazo — é a definição de "para sempre". E o conteúdo é o pior possível do ponto de vista de necessidade: o payload cru de um OFX ou CSV bancário contém agência, número de conta, identificadores da instituição e, com frequência, a **chave Pix da contraparte** — que é CPF, telefone ou e-mail de um **terceiro que nunca contratou a Mavia e não tem aqui nenhum caminho para exercer direito nenhum**.

Acumular isso indefinidamente contraria o art. 6º III (necessidade) de forma difícil de defender: guardamos o dado de alguém que não é nosso cliente, sem prazo, para uma finalidade ("reprocessar") que expira em dias.

**Três controles, nesta ordem:**

1. **Minimização na entrada.** `domain/ingestao.normalizar()` extrai os campos necessários e **redige do `payload` persistido** os identificadores de conta, agência, documento e chave Pix da contraparte, substituindo-os por um marcador de tipo (`<chave-pix-redigida>`). O `conteudo_hash` continua sendo calculado sobre o **conteúdo normalizado completo, antes da redação** — logo a regra 13 (idempotência) não é afetada, e reimportar o mesmo OFX continua sendo no-op.
2. **Prazo curto.** 7 dias para bruto não promovido; 90 dias para promovido (o `Lancamento` é a fonte de verdade a partir da promoção, e o "desfazer importação" tem janela de 7 dias); **imediato** para brutos de conexão revogada. Os campos normalizados e o `conteudo_hash` seguem até 24 meses, porque a idempotência precisa sobreviver ao payload.
3. **Nunca sai por API.** `zBrutoResposta` é allowlist (`matriz-de-acesso.md` §3.10). Diagnóstico se faz por acesso operacional auditado ao banco, não por endpoint — devolver o payload por rota é pior que registrá-lo em log, porque o cliente também o guarda.

---

## 8. O log de atividades

### 8.1 LIA — o teste de balanceamento que não existia

`auditoria` se apoia em legítimo interesse (art. 7º IX), e legítimo interesse **exige teste de balanceamento documentado**. Ele é este.

**Finalidade legítima e concreta.** Três, todas verificáveis: (a) **integridade financeira** — responder "por que meu saldo mudou" num sistema onde o passado é editável; (b) **transparência entre membros** de um espaço compartilhado, onde "quem mexeu nisso?" é pergunta real no primeiro mês de uso familiar; (c) **apuração de incidente** e cumprimento do art. 48 — sem log não há como dizer à ANPD quem foi afetado e o quê.

**Necessidade.** Não existe meio menos invasivo de atingir as três. Um log só de contagens não responde (a) nem (b); ausência de log torna (c) uma estimativa, o que é simultaneamente ineficaz e indefensável. O escopo é o mínimo: registra-se **escrita financeira**, **evento de segurança** e **leitura em massa ou por terceiro** — e explicitamente **não** se registra leitura interativa comum de tela, porque registrar tudo é caro, inútil e cria um segundo banco de dados de comportamento para proteger.

**Salvaguardas ao titular** — o que inclina o balanço:

| Salvaguarda | Onde está |
|---|---|
| Minimização do `de/para` (hash + comprimento para campo livre e valor) | §8.2 |
| `ip_hash` por HMAC com pepper rotacionado, nunca hash simples | §3.5, A-39 |
| Prazos definidos, com expurgo executado por job e comprovado | §3.5, §8.3 |
| Acesso restrito por papel; `ip_hash` nunca sai em resposta de API | `matriz-de-acesso.md` §3.12 |
| **O log é exposto ao próprio titular** na tela Atividades — ele não é um registro secreto sobre a pessoa, é um instrumento que ela usa | `arquitetura-informacao.md` §2.13 |
| Anonimização do autor 90 dias após a saída do membro | §4.4 |

**Conclusão do balanceamento:** o legítimo interesse prevalece, com as salvaguardas acima como condição — não como intenção. Retirada qualquer uma delas, a LIA precisa ser refeita.

*(A mesma estrutura, em escala menor, sustenta o legítimo interesse do convite a terceiro da §3.2: finalidade única de entregar o convite, prazo de 30 dias, nenhum uso secundário, link de recusa que apaga na hora.)*

### 8.2 Minimização do `de/para` — o log não pode reconstituir o extrato

Hoje `auditoria.de/para JSONB` guarda o antes e o depois de cada escrita financeira, ou seja, **a descrição e o valor do lançamento estão dentro do log**. Duas consequências: excluir um lançamento pela UI não remove o conteúdo do sistema, e um vazamento da tabela `auditoria` entrega o extrato do cliente.

**Objetivo declarado, que vira asserção de teste:** *um vazamento de `auditoria` não pode reconstituir o extrato de nenhum cliente.*

| Categoria de campo | O que vai para `de/para` |
|---|---|
| Estruturais (`categoria_id`, `conta_id`, `cartao_id`, `status`, `fatura_id`, datas, `arquivada_em`) | **Em claro.** São ids e enums; sem eles a tela Atividades não diz nada útil |
| **Valor monetário** | **Em claro apenas quando o valor é o objeto da mudança** (`valor_centavos` alterado de X para Y) — porque "alterou o valor" sem os números é inútil na tela. Nos demais eventos, ausente |
| **Campo livre** (`descricao`, `observacao`, `objetivos.nome`, `etiquetas.nome`, `regras_categorizacao.condicoes`) | **`{ hash, comprimento }`**, nunca o texto. A tela mostra "alterou a descrição", não a descrição antiga |
| Credencial, token, segredo | **Nunca**, em nenhuma forma, nem hash |

A lista acima é normativa e fechada. Campo novo nasce **fora** do `de/para` até que alguém o adicione aqui explicitamente.

### 8.3 O caminho de expurgo que não existia

`auditoria` é particionada por mês. O expurgo é `DROP PARTITION`, executado pelo procedimento restrito do §4.3 — é o único descarte viável em volume, e é também o único que não precisa de `DELETE` linha a linha numa tabela append-only.

A pseudonimização do autor (`UPDATE usuario_id`) usa as três colunas concedidas a `mavia_retencao`. Ela **precede** e não substitui o `DROP`: uma partição de 4 anos atrás já teve seus autores anonimizados há muito tempo.

### 8.4 O que o titular precisa ver

Uma frase, em dois lugares, em português claro:

- **No diálogo de exclusão de um lançamento:** *"O registro de que este lançamento existiu e foi excluído fica em Atividades por 90 dias."*
- **Na tela Atividades:** *"Guardamos estes registros por 90 dias para você e por até 5 anos internamente, para apurar problemas de segurança e responder a questionamentos sobre o seu dinheiro."*

Sem isso, o titular acredita que "excluir" apagou tudo — e isso é um problema de transparência (art. 9º) antes de ser um problema técnico.

---

## 9. Inteligência: categorização e OCR

### 9.1 O spec não responde se há terceiro — e as duas leituras têm consequências jurídicas opostas

`sistema.md` §1.1 diz que *"o modelo estatístico fica em `apps/api`"*; §5.2 define o job `anexo.ocr`; §6.3 expõe `GET /inteligencia/sugerir-categoria` sem grupo em §4.1. Duas leituras são possíveis: **modelo local na VPS** (nenhuma transferência a terceiro) ou **chamada a API externa** (transferência de dado pessoal, potencialmente sensível por inferência, potencialmente internacional).

**Enquanto não houver ADR, a rota fica bloqueada, não permissiva.** Este é o item de veto do papel: *envio de dado pessoal a terceiro sem contrato, sem ciência do titular ou sem registro.*

### 9.2 Se for local

Declarar explicitamente no spec e na política de privacidade — é diferencial competitivo real e barato de afirmar quando é verdade. Nenhuma dependência que faça chamada de rede entra no módulo `inteligencia`, e um teste de rede no CI prova isso (o mesmo mecanismo do sandbox de A-34: processo sem rede). O requisito de terceiro desaparece; a sandbox de parsing **permanece obrigatória**.

### 9.3 Se for terceiro

Sete condições, todas bloqueantes:

1. **Contrato de operador** (art. 39) com **vedação expressa de uso dos dados para treinamento do fornecedor**, região de processamento declarada e retenção zero no terceiro.
2. **Art. 33** se o processamento ocorrer fora do Brasil — cláusulas-padrão contratuais registradas. Será o caso com qualquer provedor grande de LLM ou OCR.
3. **Subprocessadores listados publicamente** em `docs/compliance/subprocessadores.md` e na política, com aviso prévio de mudança.
4. **Aviso no ponto de uso**, não enterrado nos termos: o selo `sugerida` ganha, ao toque, a frase *"a descrição deste lançamento foi enviada para \<Fornecedor\> para sugerir a categoria"*.
5. **Opt-out por tenant que não quebra o produto.** Desligado, a categorização cai para as regras do usuário e o histórico local, que já existem em `domain/categorizacao`.
6. **Minimização:** envia-se a descrição. Nunca o valor, nunca o `payload` bruto, nunca o anexo inteiro quando um recorte serve, nunca o `usuario_id`.
7. **Registro de cada envio** (§3.7), para que seja possível dizer, num incidente do fornecedor, exatamente o que saiu.

**OCR tem exigência adicional.** `lerRecibo(anexoId)` processa a foto de um comprovante, e uma nota de farmácia lista medicamentos — **dado de saúde, art. 11**, cujo compartilhamento com terceiro exige consentimento específico e destacado. Se o OCR for de terceiro, o consentimento para anexos é **separado** do consentimento para categorização, obtido no primeiro upload de anexo, com texto que menciona explicitamente que recibos podem conter informação de saúde. Se for local, o requisito desaparece e a sandbox continua obrigatória.

### 9.4 "Métrica offline" — o risco que a expressão esconde

`sistema.md` §2.3 diz que *"o modelo estatístico não é testado por asserção de acerto; é medido por métrica offline"*. Como decisão de **teste**, está correta: acurácia de modelo em suíte de CI produz teste intermitente. Mas a expressão sugere uma terceira coisa que não foi decidida por ninguém — **treinar com dado de cliente** —, que é **finalidade nova**, não coberta pela execução do contrato de categorização, e que exigiria base própria.

**Decisão desta política, para o MVP:**

> A métrica offline é calculada exclusivamente sobre **contadores agregados** — quantas sugestões foram aceitas e quantas rejeitadas, por dia e por tipo de regra. O contador nasce **sem `usuario_id` e sem nenhum texto**; ele registra o resultado de uma ação do próprio titular, não o conteúdo do lançamento. Dado agregado sem identificação está fora do escopo da LGPD (art. 12), e nenhuma base nova é necessária.
>
> **Nenhum modelo é treinado com dado de cliente no MVP.** Nenhum corpus de descrições de lançamento é montado, exportado ou versionado. Um conjunto de avaliação, se necessário, é sintético ou vem de titulares que optaram explicitamente.

Se o dono do produto quiser treinar com dado de cliente algum dia, isso é **[DP-8]** e exige, antes de uma linha de código: finalidade declarada, base própria (legítimo interesse com LIA e opt-out visível, **ou** consentimento específico), e — na prática — que o tratamento seja sobre dado agregado ou anonimizado (art. 12). **Escrever ou proibir; não deixar implícito.** Este documento proíbe até que haja decisão.

---

## 10. Revogação de consentimento de conexão bancária

O que o spec já tem e está certo: `consentimentos` append-only e versionado, `DELETE /conexoes/:id` como revogação, a recusa explícita de reconexão silenciosa após expiração. O que falta é o **efeito**.

### 10.1 Revogar precisa destruir a credencial

Hoje o estado alvo descrito em `sistema.md` §5.2 é *"sync interrompida, brutos além do prazo purgados, conexão marcada `revogada`"*. **`credenciais_cifradas` e `dek_cifrada` não são mencionadas.** Uma conexão revogada que mantém a credencial armazenada continua sendo um ativo roubável, e a revogação vira um rótulo — exatamente o que o item de veto proíbe.

```sql
UPDATE conexoes
   SET status = 'revogada',
       credenciais_cifradas = NULL,
       dek_cifrada          = NULL,
       escopo               = NULL,
       revogada_em          = now()
 WHERE id = $1;
```

Na **mesma transação** que grava `consentimentos.revogado_em`. O descarte da DEK é o mecanismo de descarte (crypto-shredding, ADR 0018): a credencial torna-se irrecuperável mesmo a partir de cópias do banco, salvo backups anteriores à revogação que contenham a DEK — o que fixa N como o prazo real (§5.5). `consentimentos` **não** é apagado: ele é a prova, e ganha `revogado_em`.

### 10.2 Revogar é síncrono onde precisa ser síncrono

O corte não pode depender do poller do outbox nem do cron das 04:00. `DELETE /conexoes/:id` executa, **antes de responder 200**:

1. Grava `revogado_em` e zera as credenciais (§10.1).
2. **Remove da fila** os jobs `repeatable` e `delayed` daquela conexão — `sync:${conexao_id}:*`. Um job agendado que sobrevive à revogação sincroniza dado sem autorização.
3. Chama **`BankSyncProvider.revogar(conexao)`** — método **novo na interface do ADR 0003**, obrigatório para todo adapter, com no-op documentado para `manual`, `ofx-import` e `csv-import`, e chamada real para `pluggy`. **Sem isso, a Mavia deixa de usar o acesso, mas o acesso continua existindo no agregador** — o que é a definição de revogação incompleta perante o Open Finance e perante o art. 8º §5º.
4. Publica `consentimento.revogado` no outbox para a limpeza assíncrona do resto (brutos, sincronizações, contas com `origem = conectado`).

Uma sincronização **em voo** verifica o estado da conexão a cada lote e aborta. Teste de S2: iniciar sincronização, revogar no meio, provar que nenhum `LancamentoBruto` novo é gravado após a revogação.

> **Dependência declarada:** o passo 3 altera a interface do ADR 0003, que não é deste papel alterar sozinho. Ele exige ADR conjunta com `especialista-open-finance` — ver §11.

### 10.3 O titular precisa ter escolha sobre o histórico já sincronizado

A tela hoje decide por ele: *"Os lançamentos já importados permanecem no seu espaço."* Isso é **defensável** — ao revogar, o titular retira a autorização de *acesso continuado à instituição*, não necessariamente pede a eliminação do próprio histórico, e a base do tratamento dos `Lancamento` já promovidos deixa de ser o consentimento e passa a ser a execução do contrato de controle financeiro. Mas só é legítimo com duas condições que hoje não existem: **estar escrito no texto de consentimento antes da concessão**, e **haver a alternativa**.

O diálogo de revogação oferece **duas** escolhas explícitas:

- **Manter meu histórico** (padrão): a sincronização para; os lançamentos permanecem; a base passa a ser a execução do contrato; a `origem` das contas vira `manual`.
- **Revogar e apagar o que veio deste banco**: apaga fisicamente os `LancamentoBruto` e os `Lancamento` originados daquela conexão **que não foram editados manualmente**, com aviso de que **saldos e relatórios vão mudar** e com a contagem exata antes de confirmar. Lançamentos editados pelo titular ou conciliados com registro manual **permanecem** — a regra 15 protege o registro do usuário — e o diálogo diz isso.

A escolha é registrada em `consentimentos` como prova da decisão do titular.

### 10.4 Consentimento versionado: textos, reconsentimento e prazo

1. **Textos versionados** em `packages/contracts/consentimentos/textos/v<N>.md`, **imutáveis depois de publicados**. `consentimentos.versao_texto` referencia o arquivo, e um teste falha se referenciar versão inexistente.
2. **Mudança material do texto exige reconsentimento:** a conexão vai para `expirada` e a sincronização para até o titular aceitar a versão nova.
3. **`expira_em` máximo de 12 meses.** Job diário marca vencidos; aviso de 7 dias por notificação, além da faixa na tela.
4. **Reconexão exige ato do titular.** Nunca renovação silenciosa — decisão já tomada em `arquitetura-informacao.md` §2.11; o job precisa respeitá-la.

### 10.5 Texto de consentimento — v1

Exibido integralmente antes do botão de autorizar, sem juridiquês e sem link obrigatório:

> **Conectar o Banco X à Mavia**
>
> Ao autorizar, você permite que a Mavia leia, **somente para você**:
> - o saldo e o extrato das contas que você escolher;
> - as faturas e os lançamentos dos cartões que você escolher.
>
> **A Mavia não movimenta dinheiro.** Nunca fazemos pagamento, transferência ou qualquer operação na sua conta. Só leitura.
>
> **Por quanto tempo:** 12 meses. Depois disso, você precisa autorizar de novo — não renovamos sozinhos.
>
> **Onde ficam suas credenciais:** guardadas cifradas, com uma chave que não fica no nosso banco de dados nem no servidor do aplicativo. Ninguém da Mavia consegue vê-las, e elas nunca aparecem na tela nem em relatório.
>
> **Como cancelar:** em Configurações → Conexões → Revogar. A leitura para na hora e suas credenciais são apagadas na hora. Você escolhe, nesse momento, se quer **manter** os lançamentos que já vieram deste banco ou **apagar** todos eles.
>
> **Quem mais vê:** todas as pessoas do espaço "\<nome do espaço\>" veem os lançamentos importados, como veem qualquer lançamento do espaço.
>
> Registramos a data, a hora e a versão deste texto para comprovar sua autorização.

### 10.6 Texto de aceite do espaço compartilhado — v1

Nenhum membro é adicionado sem este aceite explícito, **inclusive** o convidado que já tem conta. `tenant_usuarios` ganha `termo_versao TEXT NOT NULL`.

> **Ao entrar no espaço "Casa da Ana", você vai:**
> - ver **todos** os lançamentos, contas, cartões e valores do espaço, inclusive os anteriores à sua entrada;
> - deixar que os outros membros vejam **tudo** o que você lançar aqui, com o seu nome;
> - aparecer em Atividades, onde ficam registradas suas ações por 90 dias.
>
> O proprietário do espaço pode remover você e pode excluir o espaço inteiro, com os lançamentos que você criou.
> Você pode sair quando quiser e levar uma cópia dos seus dados.

---

## 11. O que este documento **não** decide

| # | Pergunta | Padrão vigente enquanto não houver decisão | De quem é |
|---|---|---|---|
| **DP-5** ✅ | Conta inativa é eliminada? | **NÃO ELIMINA.** **Decidido pelo dono do produto em 2026-09-01.** O produto guarda até o titular pedir. Finanças pessoais é uso intermitente — some por meses e volta na virada do ano. Nenhum job de eliminação por inatividade é implementado. |
| **DP-6** ✅ | Quanto tempo um lançamento excluído sobrevive antes da purga física? | **12 meses.** **Decidido pelo dono do produto em 2026-09-01.** Define até quando o suporte reverte um erro do usuário, e cobre o caso de descobrir na declaração anual que apagou algo do ano anterior. |
| **DP-7** ✅ | O valor de **N**, a retenção de backup | **N = 30 dias.** **Decidido pelo dono do produto em 2026-09-01.** Cobre a janela real de recuperação de desastre e de erro humano descoberto tarde, e mantém curta a janela em que dado eliminado ainda existe em backup. Deve constar na política de privacidade. |
| **DP-8** ✅ | Treinar modelo com dado de cliente | **PROIBIDO.** **Decidido pelo dono do produto em 2026-09-01.** Decisão firme, não adiamento. A categorização opera por regra do usuário e histórico do próprio espaço. Reverter exige finalidade declarada, base legal própria e opt-out visível, numa decisão nova. |
| **DP-9** ✅ | O destino dos dados já sincronizados após revogação | **PERMANECEM, e param de atualizar.** **Decidido pelo dono do produto em 2026-09-01.** Credencial e DEK são destruídas na mesma transação da revogação e a sincronização cessa; os lançamentos já importados continuam, porque passaram a ser o histórico financeiro do próprio usuário. Apagá-los porque ele desconectou o banco destruiria o produto dele sem pedido. |
| **DP-10** | `BankSyncProvider.revogar()` na interface do ADR 0003 | Exigido por §10.2, mas alterar o ADR 0003 não é ato deste papel | `arquiteto-solucao` + `especialista-open-finance`, via ADR nova |
| **DP-11** ✅ | Se `inteligencia/*` é local ou de terceiro | **LOCAL, sem terceiro.** **Decidido pelo dono do produto em 2026-09-01.** Regra do usuário e histórico do espaço, ambos determinísticos e explicáveis, sem custo por lançamento e sem transferência de dado pessoal. A rota é desbloqueada nesses termos. Adotar terceiro exige ADR nova. |

---

## 12. Requisitos que viram ticket

Redigidos para virar asserção. Cada um tem dono e critério.

| # | Requisito | Seam | Achado |
|---|---|---|---|
| R-01 | `packages/domain/retencao/politica.ts` transcreve a §3; teste falha se existir tabela no schema Drizzle sem entrada na política, ou o inverso | S1 | B-01 |
| R-02 | `retencao.aplicar` roda sob `mavia_retencao`, por tenant, com `SET LOCAL app.tenant_id`; sem `BYPASSRLS`; emite as três métricas por classe | S2 | B-01 |
| R-03 | `mavia_retencao` tem `UPDATE` em exatamente três colunas de `auditoria` e nenhum `SELECT` em outra tabela; `mavia_app` continua sem `UPDATE`/`DELETE` em `auditoria` | S2 | B-05 |
| R-04 | `retencao_execucoes` é append-only para **todos** os papéis e não contém dado pessoal | S2 | B-05 |
| R-05 | `zEscopoExportacao` enumera todas as entidades da §6.1; teste percorre o schema e falha se uma tabela de negócio não estiver nela nem na lista de exclusões justificadas | S2 | B-02 |
| R-06 | A exportação de um `membro` não contém e-mail de outro membro nem atividade de segurança alheia | S2 | B-02, A-28 |
| R-07 | `DELETE /auth/eu` apaga fisicamente as classes da §5.2 e anonimiza as demais; um teste verifica que nenhum `usuario_id` do eliminado sobra em nenhuma tabela | S2 | B-03 |
| R-08 | `DELETE /tenants/:id` não deixa nenhuma linha com aquele `tenant_id` em nenhuma tabela, exceto as quatro da §5.3 | S2 | B-03 |
| R-09 | Restauração de backup executa `eliminacao.aplicar` sobre `eliminacoes_journal` **antes** de aceitar tráfego; provado no teste de recuperação anual | runbook + S2 | B-03 |
| R-10 | `auditoria.de/para` nunca contém texto de campo livre; um teste de propriedade gera descrições e afirma que só hash e comprimento aparecem | S1 + S2 | B-05 |
| R-11 | `auditoria` é particionada por mês; `DROP PARTITION` só aceita partição vencida | S2 | B-04 |
| R-12 | `normalizar()` redige chave Pix, agência, conta e documento do `payload` persistido, e o `conteudo_hash` continua igual ao de antes da redação (reimportar não duplica) | S1 + S3 | B-07 |
| R-13 | `DELETE /conexoes/:id` zera `dek_cifrada` e `credenciais_cifradas` na mesma transação; um teste lê a linha depois e afirma `NULL` nos dois | S2 | B-14 |
| R-14 | Revogar durante uma sincronização em voo: nenhum `LancamentoBruto` novo após a revogação; nenhum job `sync:${conexao_id}:*` sobra na fila | S2 | B-15 |
| R-15 | `BankSyncProvider.revogar()` existe na suíte de contrato e é executada contra **todos** os adapters | S3 | B-15 |
| R-16 | Nenhuma dependência de `inteligencia` faz chamada de rede quando a decisão for "local"; o processo de teste roda sem rede | S2 | B-11 |
| R-17 | Nenhum envio a fornecedor de IA acontece sem entrada correspondente no registro de acesso da §3.7 | S2 | B-11, B-13 |
| R-18 | `tenant_usuarios.termo_versao` é `NOT NULL`; nenhum caminho cria vínculo sem aceite | S2 | B-08 |
| R-19 | Remover um membro revoga, na mesma transação, sessões, tokens OAuth e chaves de API daquele tenant, com efeito ≤ 60 s, e enfileira a exportação de saída | S2 | B-09 |
| R-20 | `outbox.payload`, `notificacoes.payload` e `exportacoes` vencidos somem — inclusive o **objeto no storage**, não só a linha | S2 | A-28, B-01 |
