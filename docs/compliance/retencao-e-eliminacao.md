# Retenção e eliminação de dados pessoais

- **Data:** 2026-09-01 · **revisado em 2026-09-04** pelo épico do painel de administração (§3.8, §8.1.1, e os carve-outs de §3.5, §3.6, §4.4, §5.3, §8.2)
- **Autor:** `especialista-lgpd-compliance`
- **Status:** Normativo. É o **estado alvo** para o qual o job `retencao.aplicar` converge. Contradizer este documento exige ADR.
- **Destrava:** B-01, B-02, B-03, B-04, B-05, B-06, B-07, B-09, B-11, B-12, B-13, B-14, B-15, B-16, B-17 do `docs/validacao/gate-risco-spec.md`
- **Insumos:** LGPD (Lei 13.709/2018), arts. 6º, 7º, 9º, 11, 12, 13, 16, 18, 33, 37, 39, 46, 48 · `docs/arquitetura/sistema.md` §3 e §5.2 · `CONTEXT.md` · `CLAUDE.md` §2 (regras 16–20) · `docs/produto/arquitetura-informacao.md` §2.10–2.13
- **Documentos irmãos:** `docs/seguranca/matriz-de-acesso.md` · `docs/adr/0018-envelope-encryption.md` · `docs/superpowers/specs/2026-09-04-perfil-de-admin-design.md`

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
| **CPF ou CNPJ para qualquer finalidade que não seja a nota fiscal** | ⚠️ **Corrigido em 2026-09-01.** O texto anterior dizia que documento não é coletado em hipótese alguma, e isso deixou de ser verdade: `docs/produto/spec-planos-e-assinatura.md` §11.4 coleta **um** documento (CPF ou CNPJ), **no checkout**, **de quem assina**, **nunca durante o teste**, com base em **obrigação legal** (7º II) e finalidade única de emissão fiscal. Vive em tabela própria, `dados_fiscais`, enumerada na §3.6. **Fora dessa finalidade a proibição continua integral**, com quatro vetos: nunca é identificador, nunca é antifraude, nunca é enriquecido ou consultado em base externa, nunca sai em log, métrica, notificação ou resposta a quem não é `proprietario`. Qualquer outro documento — RG, CNH, título — continua sem coluna e exige ADR |
| **Número de cartão (PAN), CVV, validade** | `Cartao` guarda nome, limite, `closing_day` e `due_day`. Não somos ambiente de pagamento e não entramos no escopo PCI-DSS. **Veto:** nenhuma coluna de PAN, em nenhuma tabela, em nenhum épico |
| **Geolocalização** | Já recusada por decisão de produto (`arquitetura-informacao.md` §2.3) com o argumento correto: dado sensível sem retorno claro |
| **Endereço, telefone, data de nascimento** | Não usados. Telefone entraria só com MFA por SMS, que não é a decisão (TOTP — A-17). **Endereço continua fora inclusive na cobrança:** se a emissão fiscal futura o exigir, é decisão nova com ADR, e não coleta antecipada "por precaução" |
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
| `auditoria.usuario_id` | Atribuir a ação a uma pessoa | Legítimo interesse | Saída do membro ou eliminação do titular | **90 dias** após a saída | `anonimizar` (§4.4) — a ação fica, o autor some. **Não alcança `ator_tipo = 'operador'`** — carve-out da §3.8, repetido em §4.4 |
| `auditoria.de/para` | Mostrar o antes e o depois na tela Atividades | Legítimo interesse | Com a partição | Com a partição | `truncar`. **Minimizado na escrita** (§8.2): campo livre e valor entram como hash + comprimento |
| `auditoria.ip_hash`, `.user_agent_hash` | Investigar acesso indevido | Legítimo interesse | Com a partição | Com a partição | `truncar`. HMAC com pepper (A-39); a rotação do pepper a cada 12 meses limita a janela de correlação, e isso é desejado |
| `retencao_execucoes` | Provar que a política foi executada, quando, sobre o quê e por quem | Accountability (art. 37) | `executado_em` | **5 anos** | `apagar`. **Não contém dado pessoal** — só classe, contagem e horário. É a âncora imutável da cadeia (§4.3) |
| `eliminacoes_journal` | Garantir que uma restauração de backup não ressuscite dado eliminado | Obrigação de eliminar (art. 18 VI) | `concluido_em` | **5 anos** | `apagar`. Guarda apenas `(tenant_id \| usuario_id, tipo, concluido_em)` — nenhum conteúdo. **Vive fora do domínio de backup do Postgres** (§5.5) |
| `chaves_api` (`hash`, `ultimos_4`, escopo, `ultimo_uso_em`, `ultimo_ip_hash`) | Permitir acesso programático rastreável e revogável | Execução de contrato | Revogação ou expiração | Expiração obrigatória ≤ **365 dias**, padrão 90; registro de uso **12 meses** após revogar | `apagar` |
| `autorizacoes_oauth` / `tokens` | Permitir que um app de IA leia o espaço, com prazo | Consentimento (7º I) do titular à autorização | `revogado_em` ou expiração | Autorização **90 dias**; access token ≤ 15 min; refresh até rotação | `apagar`. Token é opaco e verificado a cada requisição — revogar corta em ≤ 60 s |
| `clientes_oauth` (dados do desenvolvedor) | Registrar quem opera o app conectado | Execução de contrato com o desenvolvedor | Descadastro | 5 anos | `apagar` |

> **O carve-out da anonimização, e por que ele é estreito.** A regra dos 90 dias existe para que a saída de um membro apague a identidade dele do histórico de um espaço que continua vivo. Aplicada ao acesso de operador, ela produz o resultado oposto ao que a §8.1.1 promete: seis meses depois de um operador ser desligado, o registro diria que *alguém* leu a base de clientes, sem dizer quem — e a evidência de quem teve acesso desapareceria justamente no caso em que ela é mais necessária. Por isso `auditoria.usuario_id` **não é anonimizado quando `ator_tipo = 'operador'`**: essas linhas seguem identificadas pelos 5 anos da §3.8, e só somem com a partição.
>
> O carve-out é estreito de propósito: ele é por `ator_tipo`, não por classe de evento. Um operador não deixa de ser identificado porque a linha é de leitura; um titular não passa a ser preservado porque a linha é de segurança. A base do carve-out é a mesma que sustenta `concessoes_de_admin` — accountability (arts. 37 e 46) sobre quem opera o controlador, e não sobre quem é cliente dele.

### 3.6 Cobrança (épico 11, declarado agora)

> Substitui, em 2026-09-01, as duas linhas genéricas anteriores. Fonte: `docs/produto/spec-planos-e-assinatura.md` §11. Provedor: **Stripe** (DP-14), que é **operadora** para o processamento que contratamos e **controladora independente** para as obrigações regulatórias dela — os dois papéis vão declarados em `subprocessadores.md` e na política de privacidade, junto da transferência internacional (art. 33).

| Classe | Finalidade | Base legal | Gatilho | Prazo | No vencimento |
|---|---|---|---|---|---|
| `assinaturas.stripe_customer_id`, `.stripe_subscription_id` | Ligar este espaço à assinatura no provedor de pagamento | Execução de contrato (7º V) | Eliminação do espaço | Vida da assinatura | `apagar` |
| `assinaturas.metodo_ultimos4`, `.metodo_marca` | Permitir que o titular reconheça qual cartão está pagando | Execução de contrato | Troca de cartão ou cancelamento | Até o gatilho | `apagar` |
| `assinaturas.metodo_expira_em` (mês/ano) | Avisar 15 dias antes de o cartão vencer, evitando a falha de pagamento | Legítimo interesse (7º IX), no interesse do próprio titular | Idem | Até o gatilho | `apagar` |
| `cobrancas` (valor, **`valor_reembolsado`**, datas, estado, `stripe_invoice_id`) | Provar o que foi cobrado, **e quanto foi devolvido**, e sustentar a escrituração fiscal | **Obrigação legal** (7º II) | `emitida_em` | **5 anos contados de 1º de janeiro do ano seguinte** (CTN art. 173 I) | `apagar`. **Sobrevive à eliminação do espaço** (§5.3) |
| `dados_fiscais` (`documento` CPF/CNPJ, `tipo_documento`, `nome_fiscal`) | Emitir a nota fiscal do serviço contratado | **Obrigação legal** (7º II) | Vencimento da última `Cobranca` do tenant | Enquanto houver `Cobranca` dentro do prazo acima | `apagar` a linha. **Sobrevive à eliminação do espaço** (§5.3). Quatro vetos de uso secundário na §2.2 |
| `pagamentos_manuais` (`valor_centavos`, `moeda`, `competencia`, `meio`, `registrado_por`, `registrado_em`) | Provar que um pagamento recebido fora da Stripe foi recebido, de quem, quando, por qual meio e por qual operador | **Obrigação legal** (7º II) — é receita da Mavia e entra na mesma escrituração das `cobrancas` | `registrado_em` | **5 anos contados de 1º de janeiro do ano seguinte** (CTN art. 173 I) | `apagar`. **Sobrevive à eliminação do espaço** (§5.3). `registrado_por` **não** é anonimizado: é operador, não titular — §3.8 |
| `pagamentos_manuais.observacao` (texto livre) | Deixar o operador anotar o que o campo estruturado não expressa (nº do comprovante, acordo pontual) | Legítimo interesse (7º IX) — **não** é elemento da escrituração; o que a obrigação legal exige são valor, data e meio | `registrado_em` | **12 meses** | `apagar` a coluna (`UPDATE ... SET observacao = NULL`), preservando a linha. Campo livre — §2.3 vale integralmente, e a UI avisa ao operador, ao lado do campo, que a observação sai na exportação pedida pelo cliente |
| `eventos_cobranca` (`event.id`, tipo, horários, resultado) | Impedir que um evento repetido cobre ou altere duas vezes, e permitir apurar uma disputa | Legítimo interesse (7º IX) | `recebido_em` | **12 meses** | `apagar`. **Não contém dado pessoal** — nunca payload, nunca e-mail, nunca valor. É a razão de a tabela poder viver fora da RLS |
| `lista_espera` (`email`, instituição desejada, faixa de disposição a pagar) | Avisar **uma vez** quando a conexão bancária existir | **Consentimento** (7º I), texto na §10.7 | Envio do aviso, ou descadastro | **30 dias** após o aviso · **imediato** no descadastro | `apagar`. Dado de quem **não é cliente**. Nunca usado para outra comunicação — veto |
| Dados de cartão de pagamento (PAN, CVV, validade completa, nome impresso, endereço de cobrança) | — | — | — | **Não coletamos.** Checkout hospedado: o dado do cartão nunca transita pelo nosso servidor, e por isso não entramos no escopo PCI-DSS | — |
| Emissão de nota fiscal | — | — | — | **Não emitimos hoje** (DP-16). Nenhuma integração fiscal, nenhum número de nota guardado. `cobrancas.documento_fiscal_id` fica reservado e nulo | — |

> **Se o dono decidir definitivamente não emitir nota**, a base legal de `dados_fiscais` desaparece e a tabela é apagada por inteiro sob `mavia_retencao`, com entrada em `retencao_execucoes`. A saída está escrita para que a coleta não vire permanente por inércia.

### 3.7 Inteligência (épico 7, condicionado a §9)

| Classe | Finalidade | Base legal | Gatilho | Prazo | No vencimento |
|---|---|---|---|---|---|
| Registro de envio a fornecedor de IA/OCR (`o que`, `para quem`, `quando`, hash do conteúdo) | Reconstituir, num incidente do fornecedor, exatamente o que saiu | Legítimo interesse (7º IX) + art. 48 | `enviado_em` | **12 meses** | `truncar` com a partição de leitura de `auditoria`. **O conteúdo enviado nunca é persistido** — só hash e comprimento |
| Resultado do OCR (`anexo.ocr`) | Sugerir os campos do lançamento a partir do comprovante | Execução de contrato | Confirmação ou descarte pelo usuário | **7 dias**, ou imediato após confirmação | `apagar`. Sugere, nunca preenche valor sozinho |
| Contadores de qualidade do modelo (aceitou / rejeitou a sugestão) | Medir se a categorização automática está melhorando | Legítimo interesse (7º IX) | Agregação diária | Contadores agregados: **indefinido**, porque **não são dado pessoal** (art. 12) | `agregar` na origem: o contador nasce sem `usuario_id` e sem texto. Ver §9.4 |

### 3.8 Operação interna (épico do painel de administração)

**Esta é a primeira classe do produto cujo titular não é cliente.** Em todas as seções anteriores o titular é quem contratou a Mavia ou alguém do espaço dele; aqui o titular é o **operador**, um funcionário ou o próprio dono do produto. A LGPD não faz distinção: dado pessoal de quem trabalha para o controlador é dado pessoal, com finalidade, base legal, prazo e direito de acesso.

Duas consequências práticas, escritas para não serem redescobertas:

1. **O operador precisa ser informado, no ato da concessão**, de que todo acesso dele fica registrado, por quanto tempo, e que o registro **sobrevive ao desligamento dele**. Transparência (art. 9º) vale para o funcionário; um monitoramento que ele descobre depois é o mesmo problema jurídico que a DA-2 cria para o cliente, com um agravante trabalhista.
2. **Estes dados não são do espaço de ninguém.** As linhas de concessão e revogação nascem com `tenant_id` nulo (§3 do spec), e a policy padrão as torna invisíveis a todos os papéis de requisição. Isso é o desejado, e está declarado para não parecer acidente.

| Classe | Finalidade | Base legal | Gatilho | Prazo | No vencimento |
|---|---|---|---|---|---|
| `concessoes_de_admin` (`usuario_id`, `email_no_ato`, `concedida_em`, `concedida_por`, `revogada_em`, `revogada_por`) | Provar quem teve acesso à base de clientes, em qual janela de tempo, e por concessão de quem | Accountability e obrigação de segurança (arts. 37 e 46) + legítimo interesse (7º IX), com **LIA em §8.1.1** | `revogada_em` | **5 anos** após a revogação | `apagar` a linha. Até lá é append-only: revogar preenche `revogada_em`, nunca apaga a concessão. **`email_no_ato` é cópia própria**, independente da FK — a §5.2 apaga fisicamente a linha em `usuarios`, e sem a cópia o desligamento de um operador destruiria a prova de quem teve acesso |
| `auditoria` — eventos de **acesso de operador** (`ator_tipo = 'operador'`: abrir espaço, buscar cliente, ver perfil, ler o próprio registro, escrita financeira no painel), com `motivo`, `referencia`, `rota` e `registros` | Responder "quem da Mavia leu o espaço de quem, quando e sob qual hipótese legítima" — para o art. 48, para o pedido do titular (art. 18 I e II) e para apurar abuso interno | Accountability e segurança (arts. 37, 46 e 48) + legítimo interesse (7º IX), com **LIA em §8.1.1** | `ocorrido_em` | **5 anos** | `truncar`. **`usuario_id` nunca é anonimizado** — carve-out da §3.5 e da §4.4 |
| `auditoria` — termo de busca do painel | Detectar varredura da base de clientes, que é a superfície de enumeração mais barata do produto | Legítimo interesse (7º IX) | `ocorrido_em` | Com a classe acima | `truncar`. **O termo entra hasheado, com a contagem de resultados ao lado** — nunca em claro: uma busca por "maria@" em claro é dado pessoal de quem foi procurado, e o log não pode virar um segundo índice de e-mails |
| `pagamentos_manuais.registrado_por` (identidade do operador) | Dizer quem deu baixa num pagamento recebido fora da Stripe | Accountability (art. 37) + obrigação legal, com o registro fiscal | Com a linha (§3.6) | **5 anos**, como a linha | `apagar` com a linha. Não é anonimizado na saída do operador, pela mesma razão do carve-out |

**Os 5 anos, e por que não são os 12 meses da classe "leitura em massa".** A §3.5 fixou 12 meses para leitura em massa porque aquela classe foi escrita para **atos do próprio titular** — ele exportou, ele baixou o anexo, ele autorizou o app. O prazo dela é o horizonte útil de responder a um vazamento recente sobre uma ação que a própria pessoa praticou. Acesso de operador é o oposto em três eixos: o ato é de outra pessoa, alcança um espaço a que ela não pertence, e é exatamente o registro que se consulta quando a suspeita de abuso aparece tarde — por reclamação de cliente, por saída conflituosa de funcionário, ou por uma requisição de autoridade. Doze meses aqui significaria que o registro do acesso morre antes da desconfiança. Cinco anos alinha esta classe às demais classes probatórias do documento — `consentimentos`, `tenant_usuarios`, `eliminacoes_journal`, `retencao_execucoes` — e ao prazo prescricional de que a Mavia depende para se defender.

**O que isso faz com o `DROP PARTITION`.** `auditoria` é particionada por mês e o expurgo é da partição inteira (§8.3), então **a partição só pode cair quando a classe de maior prazo dentro dela vencer**. Isso já valia antes deste épico — as classes de escrita financeira e de segurança já são de 5 anos —, e a classe de acesso de operador não muda o teto. O que ela muda é o expurgo por linha: se algum dia existir um caminho de `DELETE` seletivo em `auditoria` (o papel `mavia_eliminacao` da §3.2 do spec é o primeiro), ele **não pode** varrer linhas de operador aos 12 meses junto com as de leitura em massa.

**O limite que os 5 anos não vencem, e que fica declarado.** `auditoria` **não** está entre os sobreviventes da §5.3. Quando o cliente elimina o espaço, as linhas de acesso de operador **àquele espaço** são apagadas junto — é o que o art. 18 VI exige e o que o R-08 verifica. Consequência: o registro de que a Mavia leu o espaço de alguém dura 5 anos **ou até esse alguém encerrar o contrato**, o que vier antes. Não há como ter as duas coisas: o que resta são `concessoes_de_admin`, que prova *quem teve acesso à base* e sobrevive porque não tem `tenant_id`, e `retencao_execucoes`, que prova que o expurgo aconteceu. É menos do que se gostaria numa apuração tardia, e é o resultado correto — a eliminação do titular vence a conveniência probatória do controlador.

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

**A exceção: linhas de acesso de operador não são anonimizadas.** O mecanismo acima é bom demais para ser aplicado onde a identidade é a prova. Linhas de `auditoria` com `ator_tipo = 'operador'` ficam **fora** do `UPDATE usuario_id` do §8.3, pelos 5 anos da §3.8.

A razão é que os três caminhos de volta que a §4.4 destrói são exatamente os que precisam continuar existindo aqui:

| Caminho | Por que ele é destruído para o titular | Por que ele é preservado para o operador |
|---|---|---|
| A linha em `usuarios` | O titular pediu eliminação; manter o mapa é manter o tratamento | A §5.2 **proíbe** que quem é, ou foi nos últimos 5 anos, administrador elimine a própria conta pela rota do titular. O mapa não some sozinho — e, se a linha em `usuarios` for apagada por outro caminho, `concessoes_de_admin.email_no_ato` ainda identifica |
| O pepper do tenant | Destruído na eliminação do espaço | Não se aplica: a linha de operador **não pertence ao espaço lido** para efeito de identificação do autor. Destruir o pepper de um cliente não pode apagar quem leu a base |
| O conteúdo do `de/para` | Poderia reconstituir o extrato | Continua minimizado igual — o carve-out é sobre **quem agiu**, nunca sobre **o que foi lido** |

Escrito assim, a assimetria fica explícita e defensável: **a Mavia anonimiza quem é titular e mantém identificado quem opera em nome dela.** O inverso — preservar o cliente e apagar o funcionário — é o desenho que todo log de acesso ruim tem, e produz um registro que só serve para vigiar quem não precisava ser vigiado.

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

**Segundo bloqueio, irmão do primeiro:** **quem é, ou foi nos últimos 5 anos, administrador da Mavia não elimina a própria conta por esta rota.** Desligamento de operador é processo administrativo, não autoatendimento. O art. 18 VI não alcança este caso: a base do tratamento dos dados de operação nunca foi o consentimento dele, e sim accountability e segurança (arts. 37 e 46), que o art. 16 II manda preservar. Sem este bloqueio, um ex-operador apaga a linha de `usuarios` que é o mapa `usuario_id` → pessoa e converte, com um clique legítimo, todo o registro de acesso dele à base de clientes num identificador sem dono. A recusa nomeia o motivo e o prazo, e a resposta ao art. 18 do próprio operador continua devida: ele tem acesso ao que registramos sobre ele.

### 5.3 Eliminar o espaço — `DELETE /tenants/:id`

**Primeiro, antes de apagar linha alguma:** cancelar a assinatura na Stripe e apagar lá o `Customer`. Continuar cobrando alguém cujos dados apagamos é, ao mesmo tempo, escândalo de cobrança e problema de dado — e a ordem importa, porque um erro no meio do apagamento não pode deixar uma cobrança órfã rodando. A Stripe retém o que a legislação dela exige; esse limite é conhecido e vai declarado na política de privacidade.

Em seguida: `DELETE` físico de **todas** as tabelas com aquele `tenant_id`, na ordem de dependência; purga de todos os objetos de storage (anexos e exportações); `crypto-shred` das DEKs de todas as `conexoes`; destruição do pepper de auditoria daquele tenant no guardião de chaves; expurgo de cache e de qualquer índice derivado.

**Sobrevive apenas:**

| O que | Por quê | Como fica |
|---|---|---|
| `consentimentos` | Ônus da prova do controlador (art. 8º §2º) | 5 anos, com `usuario_id` anonimizado e `escopo` reduzido a instituição + data + versão do texto |
| `cobrancas` (§3.6) | Obrigação legal tributária | 5 anos, contados de 1º de janeiro do ano seguinte à cobrança |
| `dados_fiscais` (§3.6) | O documento é elemento necessário da nota fiscal das cobranças que sobrevivem | Com as `cobrancas`. **É o único lugar onde o documento do titular sobrevive à eliminação**, e isso precisa estar em português claro na tela "Dados e privacidade" |
| `pagamentos_manuais` (§3.6) | Obrigação legal tributária — é receita recebida, e o fato de ter entrado por fora da Stripe não a tira da escrituração | 5 anos, contados de 1º de janeiro do ano seguinte ao `registrado_em`. `observacao` já está nula desde os 12 meses (§3.6), então o que sobrevive é valor, moeda, competência, meio e o operador que deu baixa |
| `eliminacoes_journal` | Impedir que uma restauração ressuscite o espaço | Só `(tenant_id, tipo, concluido_em)`, sem conteúdo |
| `retencao_execucoes` | Accountability (art. 37) | Contagens, sem dado pessoal — **e sem `tenant_id`**, por isso não conta no R-08 |

**Cinco tabelas com `tenant_id`** sobrevivem: `consentimentos`, `cobrancas`, `dados_fiscais`, `pagamentos_manuais` e `eliminacoes_journal`. `retencao_execucoes` está na lista porque também não é apagada, mas não carrega `tenant_id` e por isso é invisível ao teste do R-08. Eram quatro antes deste épico; `pagamentos_manuais` é a quinta, e **sem esta linha o R-08 reprova a implementação do painel** — a primeira baixa manual de pagamento deixaria uma linha com `tenant_id` que o teste de eliminação não perdoa.

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

`tenant` (nome, timezone, plano) · `membros` (nome, papel, `aceito_em` — e-mail apenas para `proprietario`) · `contas` · `cartoes` · `categorias` · `etiquetas` · `lancamentos` · `lancamento_etiquetas` · **`transferencias`** · **`parcelamentos`** (com `data_compra`) · **`faturas`** · **`recorrencias`** · **`planejamentos`** · **`objetivos`** · **`aportes`** · **`conexoes`** (metadados, nunca a credencial) · **`consentimentos`** · **`sincronizacoes`** · **`lancamentos_brutos`** (campos normalizados, nunca o `payload`) · **`conciliacao_sugestoes`** · **`regras_categorizacao`** · **`anexos`** (metadados **e** os binários) · **`notificacoes`** · **`preferencias`** · **`atividades`** · `chaves_api` e `apps_conectados` (metadados, nunca o segredo) · **`assinatura`** · **`cobrancas`**.

Entra também **`pagamentos_manuais`** — valor, moeda, competência, meio, data e a `observacao` enquanto ela existir. Ela é tabela de negócio com `tenant_id`, logo o teste da §6.4 a exige em algum dos dois lados, e o lado certo é dentro: é dinheiro que o titular pagou. A `observacao` sai junto **de propósito**, e é essa saída que a UI anuncia ao operador no momento em que ele digita — alinhar o que o operador escreve ao que o cliente pode ler é o que impede a categoria "nota interna sobre o cliente que ninguém previa que sairia". `registrado_por` sai como identificação da Mavia, nunca como `usuario_id` cru: quem deu baixa é operador, e o titular não tem finalidade para receber o identificador interno dele.

`assinatura` e `cobrancas` entram por força do teste da §6.4 — tabela de negócio fora dos dois fluxos quebra o build. `eventos_cobranca` fica de fora com justificativa declarada: não contém dado pessoal. `concessoes_de_admin` também fica, e a justificativa é outra: ela não tem `tenant_id` e o titular dos dados dela é o **operador**, não o cliente — exportá-la na requisição de um cliente entregaria a identidade dos funcionários da Mavia a quem não é titular deles (§3.8). O acesso do próprio operador aos dados dele existe, e é a mesma resposta ao art. 18 que qualquer pessoa recebe. `dados_fiscais` sai **apenas na exportação pedida pelo `proprietario`**; para os demais membros, é filtrado pela regra 1 da §6.3, como o e-mail alheio.

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

### 8.1.1 LIA — acesso de operador da Mavia ao espaço de um cliente

**Por que este teste é novo, e não uma extensão do §8.1.** A §8.1 fecha com *"retirada qualquer uma delas, a LIA precisa ser refeita"*. A **DA-2** do épico do painel retira exatamente uma: *"o log é exposto ao próprio titular"* — e retira a que mais pesava, porque era ela que transformava um registro **sobre** a pessoa num instrumento **da** pessoa. Mas mesmo que nenhuma salvaguarda tivesse caído, o §8.1 não se estenderia: lá o agente é membro do espaço, a finalidade é transparência entre quem divide as contas, e o alcance é um espaço. Aqui o agente é funcionário do controlador, a finalidade é operar a empresa, e o alcance é a base inteira. Três eixos diferentes é tratamento diferente, com teste próprio.

**O tratamento, em uma frase.** Um operador da Mavia abre o espaço de um cliente e lê os dados financeiros dele — saldos, lançamentos, contas, cartões, faturas, objetivos, anexos — sem pertencer àquele espaço.

---

#### Finalidade legítima e concreta

Três, e as três são operações que a empresa não tem como não fazer:

- **(a) Atender ao chamado do próprio titular.** *"Meu saldo está R$ 40,00 diferente"* não se responde sem ver o lançamento, a fatura e a janela. É a hipótese mais frequente e a mais benigna: o titular pediu.
- **(b) Apurar incidente de segurança.** O art. 48 obriga a comunicar **quem** foi afetado e **quais dados**. Sem entrar no espaço, a comunicação vira estimativa — o que é simultaneamente ineficaz e indefensável, exatamente como o §8.1 já disse sobre a ausência de log.
- **(c) Investigar defeito.** Neste produto, defeito não é cosmético: é o saldo errado na conta de alguém. Reproduzir um erro de rateio, de janela de fatura ou de balde exige os dados que o produziram.

A quarta hipótese do enum, `ordem_judicial`, **não se sustenta neste legítimo interesse** e está aqui só para não ficar sem lugar: ela é **obrigação legal (7º II)**, o escopo é o da ordem e não o do operador, e nenhum balanceamento é feito por nós. Separá-la importa porque misturar as duas bases é como uma LIA passa a "provar" o que ela não testou.

#### Necessidade

**Por que não dá para operar o produto sem isto.** A alternativa real nunca foi "nenhum acesso" — era `psql` na VPS às onze da noite, que é acesso mais amplo (DML completo em toda tabela, `0006_nucleo.sql:278`), sem hipótese declarada, sem papel somente-leitura e sem registro. **Este tratamento substitui um tratamento pior que já acontecia.** É o argumento mais forte da LIA e o único que não depende de promessa futura. E não há caminho lateral: não existe canal humano de atendimento (DP-25), não existe atendimento dentro do produto, e o titular que reclama não tem como transferir o problema para outro lugar.

**Por que a leitura completa (DA-1) é necessária.** Um degrau intermediário — "só metadados", "só contagens", "valores mascarados" — é atraente no papel e não responde a nenhuma das três finalidades. Um saldo errado é uma diferença **entre números**; um incidente é sobre **quais dados** saíram; um defeito de fatura é sobre **qual lançamento caiu em qual janela**. Mascarar valor mata (a) e (c) inteiras, e mascarar descrição mata a conciliação, que é onde os defeitos moram.

**Menos invasivo, testado e recusado:**

| Alternativa | Por que não substitui |
|---|---|
| Pedir ao titular que envie print ou exportação | Serve em parte de (a) e em nada de (b) e (c). Transfere ao titular o ônus de diagnosticar, e num incidente ele é a última pessoa a saber |
| Acesso apenas com consentimento pontual do titular | Bom em (a), inviável em (b) — um incidente não espera resposta de e-mail — e sem efeito em ordem judicial. Também é consentimento sob desequilíbrio: quem está com o saldo errado autoriza o que for |
| Ambiente de cópia anonimizada | Não reproduz o dado que causou o defeito. E anonimizar bem uma base financeira inteira é mais caro e mais arriscado que o acesso auditado |

**O que a necessidade exclui, e por isso é normativo:** leitura sem hipótese declarada; escrita no dado financeiro do cliente — garantida pelo papel `mavia_admin`, que só tem `SELECT`, e não por disciplina; personificação do titular; e qualquer finalidade que não seja uma das três — produto, marketing, cobrança ativa ou treino de modelo (este último já proibido pela **DP-8**).

#### Hipóteses de acesso — lista fechada, com referência obrigatória

| `motivo` | O que é | `referencia` obrigatória | Base |
|---|---|---|---|
| `chamado` | Pedido do próprio titular | Identificador do chamado, ou o e-mail e a data em que ele pediu | Execução de contrato (7º V), reforçada pelo pedido |
| `incidente` | Suspeita ou confirmação de comprometimento | Identificador do incidente no registro de incidentes | Legítimo interesse (7º IX) + arts. 46 e 48 |
| `defeito` | Erro reproduzido ou reportado que produz número errado | Identificador da issue em `.scratch/` | Legítimo interesse (7º IX) |
| `ordem_judicial` | Requisição de autoridade | Número do processo ou do ofício | **Obrigação legal (7º II)** — fora desta LIA |

**Fechada é fechada por tipo, não por instrução.** `motivo` é enum no banco; um valor fora da lista não é aceito no `INSERT`, e a mesma instrução que registra é a que efetiva o acesso. "Curiosidade", "conferir uma coisa" e "mostrar numa demonstração" não têm valor de enum, e é por isso que a lista importa: ela não pede honestidade do operador, ela remove a opção.

**`referencia` é identificador, nunca narrativa.** Ela aponta para um caso que existe em outro lugar; não recebe a descrição do problema, o nome do cliente, nem o que ele contou por e-mail. Um campo de motivo que vira diário de atendimento recria dentro do log de acesso o mesmo texto livre que a §8.2 passou o documento inteiro tirando dele.

#### Salvaguardas — as que compensam a que foi retirada

| Salvaguarda | O que ela cobre | Onde |
|---|---|---|
| **Hipótese declarada antes do ato**, na mesma instrução que abre o espaço | É a única do conjunto que atua **antes** da leitura, e a única que muda o comportamento de quem age. As demais são forenses | §3 e §1.2 do spec |
| Papel `mavia_admin`, só `SELECT` nas tabelas de negócio e `INSERT` em `auditoria` | O admin não altera nem apaga dado do cliente — por privilégio, não por rota bem escrita | §1.3 do spec |
| Log imutável contra `mavia_app` **e contra o dono da tabela**, com gatilho e partições pré-criadas | Um operador não apaga o rastro do próprio acesso | §3.1 do spec |
| `rota` e contagem de `registros` na linha | Responde à natureza dos dados afetados que o art. 48 pede, e não só "abriu o espaço" | §3 do spec |
| **5 anos de retenção e carve-out da anonimização** | A identidade de quem acessou sobrevive ao desligamento dele | §3.8, §3.5, §4.4 |
| **Detecção entre pares:** toda abertura notifica os outros operadores, e **ler o registro é evento** | Um log que ninguém lê descobre o incidente quando o cliente reclama. DA-2 proíbe avisar o cliente; não proíbe avisar o segundo operador | §6.3 do spec; limite em **DP-34** |
| **Direito de acesso do titular, mediante pedido**, respondido em até 15 dias com a lista de acessos do período | É o que sobrou da salvaguarda retirada. O texto de consentimento v2 já o promete, o que o torna também obrigação contratual | §10.5, art. 18 I e II |
| Reautenticação nas escritas, com o ticket carregando o `tenant_alvo` | Impede que um ticket emitido para um cliente autorize escrita em outro | §6.5 do spec |
| Hostname próprio, escopo de cookie separado, allowlist de IP ou mTLS | Sem isso, um XSS em qualquer tela do produto, no navegador de um operador, alcança o painel inteiro | §6.1 do spec — **a construir** |
| Termo de busca hasheado, com contagem | O log não vira um segundo índice de e-mails de clientes | §3.8 |

**O que não conta como salvaguarda, e está escrito para não ser contado duas vezes:** o 404 em rota `/admin` — o próprio spec diz que não é controle; e a atomicidade entre log e leitura — ela é real para escrita e retórica para leitura, porque as linhas já estão no processo quando o `COMMIT` roda.

#### A ausência de MFA, declarada como fato

**Não existe MFA no produto.** As colunas estão no schema desde a fundação — `usuarios.mfa_segredo_cifrado`, `.mfa_kek_versao`, `.mfa_ativado_em`, `.mfa_ultimo_passo` (`0002_identidade.sql:19-22`) e a tabela `mfa_codigos_recuperacao` (`0002_identidade.sql:108`) — e **nenhuma rota as usa**: a única leitura em código pergunta se existe senha *ou* MFA para decidir texto de tela (`google.controller.ts:257`). O produto tem o lugar do segundo fator e não tem o segundo fator.

A consequência, sem eufemismo: **o painel que enxerga a base inteira fica atrás de uma senha.** A reautenticação nas escritas protege contra sessão roubada, não contra senha roubada — e senha roubada é precisamente o risco que a ausência de MFA cria. Nenhum dos controles compensatórios reduz a **consequência** de uma credencial de operador comprometida; todos reduzem a probabilidade ou ajudam a reconstituir depois.

Dois fatos que o spec cita e que mudaram, ou que precisam de precisão maior — porque salvaguarda contada errado é pior que salvaguarda ausente:

- **O Redis de produção exige senha no arquivo, e ainda não no container que está rodando.** `infra/producao/docker-compose.yml:87-88` passa `--requirepass` e a linha 111 monta a `REDIS_URL` autenticada, mas a correção é de 2026-09-04 e **o deploy dela depende de autorização do dono**. Até ele rodar, o Redis em produção continua aberto para quem alcança a rede `dados`, e a distância entre "corrigido no repositório" e "corrigido em produção" é exatamente o tipo de coisa que uma LIA não pode arredondar para o lado otimista. O de **desenvolvimento** segue sem senha por decisão registrada (`infra/docker-compose.yml:43`, com o porquê em `infra/README.md`). E o que continua a construir, independente disso, é a instância ou base separada para sessões e a revalidação da sessão no Postgres a cada requisição sob `/admin`.
- A `auditoria` **não existe como tabela** em nenhuma migration — o nome aparece em `0013`, `0022` e `0026`, e não há `CREATE TABLE auditoria`. Todo controle desta LIA que se apoia no log é, hoje, **a construir**. Ela é a condição, não o pressuposto.

Isto não é pendência escondida no rodapé: é o limite declarado deste balanceamento. **DP-32** pede a data em que o MFA entra.

#### Conclusão do balanceamento — e onde ele é apertado

O legítimo interesse prevalece para `chamado`, `incidente` e `defeito`, **com as salvaguardas acima como condição, e não como intenção** — e com a ressalva de que várias delas ainda não existem em código. Enquanto `auditoria`, o papel `mavia_admin` e a função `admin.abrir_espaco` não estiverem construídos, não há acesso de operador legítimo a espaço de cliente: o que existiria seria o `psql` de antes, com uma tela na frente.

Três pontos onde o balanceamento é apertado, escritos aqui para que não sejam descobertos por um titular antes de por nós:

1. **DA-1 sem degrau intermediário.** Toda hipótese custa o mesmo acesso, que é o mais amplo possível. Um defeito de fechamento de fatura não precisaria de `objetivos.nome` nem dos anexos, e ainda assim os alcança. A necessidade é defensável **por hipótese**, não **por linha** — e é essa a distância entre o que a LIA sustenta e o que o desenho entrega. Um recorte por área do produto seria a evolução natural, e não está neste épico.
2. **DA-2 põe a detecção inteira dentro da Mavia.** Quem descobre o abuso está do mesmo lado de quem pode cometê-lo. A salvaguarda que resta ao titular — pedir a lista de acessos — exige que ele suspeite primeiro, e ninguém suspeita de um acesso que não aparece em lugar nenhum. Com **um único operador** (DP-34), a notificação entre pares é vazia e a autovigilância é a única linha de defesa. **É o ponto mais frágil desta LIA**, e ele é consequência direta de uma decisão do dono do produto, não de uma limitação técnica.
3. **Sem MFA**, a probabilidade de comprometimento não é a que este balanceamento assume.

**Refazer esta LIA é obrigatório se** qualquer uma destas mudar: o admin ganhar escrita no dado financeiro do cliente; a lista de motivos deixar de ser fechada ou a referência deixar de ser obrigatória; a notificação entre operadores for desligada; o pedido do titular deixar de ser respondido com a lista de acessos; o painel passar a servir finalidade nova; ou o acesso passar a ser feito por terceiro contratado, e não por pessoa da Mavia.

Esta seção é o núcleo do RIPD da entrada *"acesso de operador a espaço de cliente"* no ROPA, e é dela que sai a declaração genérica na política de privacidade.

### 8.2 Minimização do `de/para` — o log não pode reconstituir o extrato

Hoje `auditoria.de/para JSONB` guarda o antes e o depois de cada escrita financeira, ou seja, **a descrição e o valor do lançamento estão dentro do log**. Duas consequências: excluir um lançamento pela UI não remove o conteúdo do sistema, e um vazamento da tabela `auditoria` entrega o extrato do cliente.

**Objetivo declarado, que vira asserção de teste:** *um vazamento de `auditoria` não pode reconstituir o extrato de nenhum cliente.*

| Categoria de campo | O que vai para `de/para` |
|---|---|
| Estruturais (`categoria_id`, `conta_id`, `cartao_id`, `status`, `fatura_id`, datas, `arquivada_em`) **e os campos de `assinaturas` (`plano`, `intervalo`, `estado`, `periodo_inicio`, `periodo_fim`, `graca_ate`)** | **Em claro.** São ids, enums e instantes; sem eles a tela Atividades não diz nada útil. Os de `assinaturas` entram pela mesma razão e por uma a mais: a mudança de plano é ato de **operador** sobre o contrato do cliente, e "alterou o plano" sem dizer de qual para qual não é registro de nada. Nenhum deles é campo livre, nenhum é PII |
| **Valor monetário** | **Em claro apenas quando o valor é o objeto da mudança** (`valor_centavos` alterado de X para Y) — porque "alterou o valor" sem os números é inútil na tela. Nos demais eventos, ausente. **A baixa de `pagamentos_manuais` é esse caso**: o valor é o próprio ato registrado, e vai em claro. É dinheiro **da Mavia**, não extrato do cliente — o objetivo declarado acima continua intacto |
| **Campo livre** (`descricao`, `observacao`, `objetivos.nome`, `etiquetas.nome`, `regras_categorizacao.condicoes`) | **`{ hash, comprimento }`**, nunca o texto. A tela mostra "alterou a descrição", não a descrição antiga |
| Credencial, token, segredo | **Nunca**, em nenhuma forma, nem hash |

A lista acima é normativa e fechada. Campo novo nasce **fora** do `de/para` até que alguém o adicione aqui explicitamente.

### 8.3 O caminho de expurgo que não existia

`auditoria` é particionada por mês. O expurgo é `DROP PARTITION`, executado pelo procedimento restrito do §4.3 — é o único descarte viável em volume, e é também o único que não precisa de `DELETE` linha a linha numa tabela append-only.

A pseudonimização do autor (`UPDATE usuario_id`) usa as três colunas concedidas a `mavia_retencao`. Ela **precede** e não substitui o `DROP`: uma partição de 4 anos atrás já teve seus autores anonimizados há muito tempo.

O `UPDATE` carrega um predicado, e ele é normativo: `WHERE ator_tipo <> 'operador'`. É o carve-out da §3.8 e da §4.4 no lugar onde ele de fato acontece — sem o predicado, o job que protege o cliente apaga a evidência sobre quem opera a Mavia. E o predicado é da forma que falha fechada: uma linha com `ator_tipo` nulo **não** é anonimizada, e vira alerta em vez de silêncio.

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

### 10.5 Texto de consentimento — v2

Exibido integralmente antes do botão de autorizar, sem juridiquês e sem link obrigatório.

> **Por que existe uma v2.** A v1 respondia *"quem mais vê"* com **"todas as pessoas do espaço"**, e isso deixou de ser a lista completa quando o painel de administração passou a permitir que a Mavia abra o espaço de um cliente em leitura. Um texto de consentimento que omite um leitor não é impreciso — ele é inválido para aquilo que o leitor omitido faz. A §10.4.2 obriga reconsentimento em mudança material, e esta é material.
>
> **O reconsentimento devido é zero**, e isso é uma janela, não uma sorte: no dia desta revisão não existe nenhuma conexão bancária em produção. Ninguém consentiu com a v1, então ninguém precisa reconsentir. Publicar a v2 **antes** da primeira conexão é o que mantém esse custo em zero — depois dela, a mesma correção passa a exigir expirar toda conexão viva e parar a sincronização de cada cliente até ele aceitar de novo.

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
> **A administração da Mavia também consegue ver.** Precisamos dizer isto com todas as letras: uma pessoa da administração pode abrir o seu espaço e ler o que há nele — saldos, lançamentos, contas e cartões. Ela **não consegue alterar nem apagar nada** disso, e não movimenta dinheiro. Só acontece para atender um chamado seu, apurar um incidente de segurança ou investigar um defeito, e nunca sem que a pessoa registre antes qual dos três é o caso. Toda abertura fica gravada — quem abriu, quando, por quê e o que foi consultado — num registro que ninguém da Mavia pode apagar ou editar. Se você pedir seus dados, esse registro vem junto.
>
> Registramos a data, a hora e a versão deste texto para comprovar sua autorização.

### 10.6 Texto de aceite do espaço compartilhado — v2

Nenhum membro é adicionado sem este aceite explícito, **inclusive** o convidado que já tem conta. `tenant_usuarios` ganha `termo_versao TEXT NOT NULL`.

> **Ao entrar no espaço "Casa da Ana", você vai:**
> - ver **todos** os lançamentos, contas, cartões e valores do espaço, inclusive os anteriores à sua entrada;
> - deixar que os outros membros vejam **tudo** o que você lançar aqui, com o seu nome;
> - aparecer em Atividades, onde ficam registradas suas ações por 90 dias.
>
> O proprietário do espaço pode remover você e pode excluir o espaço inteiro, com os lançamentos que você criou.
>
> A administração da Mavia consegue abrir este espaço em **leitura**, para atender chamado, apurar incidente ou investigar defeito. Ela não altera nem apaga nada, e toda abertura fica num registro que a própria Mavia não pode apagar.
>
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
| **DP-10** ✅ | `BankSyncProvider.revogar()` na interface do ADR 0003 | **RESOLVIDA pelo [ADR 0019](../adr/0019-revogacao-no-banksyncprovider.md)**, de `arquiteto-solucao` + `especialista-open-finance`, em 2026-09-01, desbloqueada pela DP-9. `revogar(alvo, opcoes)` entra na interface, **emendando** o ADR 0003 sem substituí-lo: recebe um descritor **sem material cifrado** — e por isso funciona depois do crypto-shredding — e devolve `revogado` · `ja_revogado` (idempotência: consentimento já expirado na origem é sucesso) · `nao_aplicavel` (`manual`, `ofx-import`, `csv-import`, sem I/O e **sem lançar**) · `falha_temporaria` · `falha_permanente`. A destruição local é **síncrona e incondicional** (§10.1 e §10.2 passos 1 e 2, antes do 200); a chamada ao provider é tentada de forma síncrona com prazo de 3 s e, falhando, perseguida pelo job `conexao.revogar-no-provedor` por até 72 h. O eixo `conexoes.revogacao_remota` (`nao_aplicavel \| confirmada \| pendente \| falhou`) fica **visível ao titular**, para que a Mavia nunca afirme um encerramento que não confirmou. Conforme a **DP-9**, nenhum `Lancamento` é apagado; `lancamentos_brutos.payload` daquela conexão vai imediatamente, e os campos normalizados mais o `conteudo_hash` seguem por 24 meses — é o que impede a reconexão de duplicar o histórico mantido. Executada na suíte de contrato **S3** (R-15) contra todos os adapters | Resolvida |
| **DP-11** ✅ | Se `inteligencia/*` é local ou de terceiro | **LOCAL, sem terceiro.** **Decidido pelo dono do produto em 2026-09-01.** Regra do usuário e histórico do espaço, ambos determinísticos e explicáveis, sem custo por lançamento e sem transferência de dado pessoal. A rota é desbloqueada nesses termos. Adotar terceiro exige ADR nova. |
| **DP-32** | **Até quando o painel fica sem MFA?** A §8.1.1 declara a ausência como fato e diz que nenhum controle compensatório reduz a consequência de uma senha de operador vazada. Escolha **um marco**, não uma data vaga: (a) antes do primeiro cliente pagante · (b) antes do décimo espaço em produção · (c) antes do épico 12 (conexão bancária) · (d) o painel entra sem MFA e o assunto volta em 6 meses | **Padrão vigente: (a).** Enquanto não houver escolha, o painel de administração **não vai a produção** com clientes reais. Não é bloqueio inventado: é o que o balanceamento da §8.1.1 assume ao concluir que o legítimo interesse prevalece | Dono do produto |
| **DP-33** | **Por quanto tempo um `motivo` + `referencia` autoriza aberturas antes de ser pedido de novo?** A §9 do spec diz que os dois são pedidos **antes** de abrir o espaço; ela não diz se valem para uma requisição, para uma sessão de trabalho, ou para o dia. Escolha um valor: **uma requisição** · **30 minutos** · **4 horas** | **Padrão vigente: 30 minutos.** Uma requisição é o mais estrito e torna o painel inutilizável (cada clique pediria o número do chamado de novo); o dia inteiro faz a hipótese declarada virar carimbo de manhã. Cada abertura continua gerando **sua própria linha** de auditoria, com rota e contagem — o que a janela reaproveita é a hipótese, nunca o registro | Dono do produto |
| **DP-34** | **Com um único operador, a notificação entre pares vai para onde?** A §6.3 do spec compra detecção notificando *os outros* admins. Hoje há um. A salvaguarda é vazia até existir um segundo — e é a que compensa a DA-2. Aceita mandar a notificação para um **destino externo ao painel** (e-mail pessoal do dono, fora do domínio da aplicação), de modo que quem comprometer o painel não silencie o aviso? **Sim / Não** | **Padrão vigente: sim, destino externo.** Uma notificação que só existe dentro do sistema que ela vigia não detecta o comprometimento desse sistema. Se a resposta for **não**, a §8.1.1 perde a única salvaguarda de detecção e **precisa ser refeita** — está escrito lá | Dono do produto |

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
| R-08 | `DELETE /tenants/:id` não deixa nenhuma linha com aquele `tenant_id` em nenhuma tabela, exceto as **cinco** nominadas na §5.3 — `consentimentos`, `cobrancas`, `dados_fiscais`, `pagamentos_manuais` e `eliminacoes_journal` | S2 | B-03 |
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
| R-21 | **O carve-out da anonimização.** Rodar `retencao.aplicar` sobre linhas de `auditoria` com 91 dias: as de `ator_tipo = 'operador'` mantêm `usuario_id` intacto; as demais viram `membro_removido:<hash>`. O teste afirma as **duas** metades — só a segunda passaria com um `WHERE` errado | S1 + S2 | §3.5, §3.8, §4.4 |
| R-22 | **`pagamentos_manuais` sobrevive à eliminação do espaço.** Depois de `DELETE /tenants/:id`, as linhas continuam lá com `tenant_id`, valor, moeda, competência, meio e `registrado_por`; e nenhuma outra tabela além das **cinco** da §5.3 tem linha com aquele `tenant_id` | S2 | §3.6, §5.3, R-08 |
| R-23 | **Os textos de consentimento estão na v2.** `packages/contracts/consentimentos/textos/` contém a v2 de §10.5 e de §10.6; nenhum caminho de código grava `consentimentos.versao_texto` ou `tenant_usuarios.termo_versao` apontando para a v1, e o teste da §10.4.1 falha se a versão referenciada não existir em disco | S1 + S2 | §10.5, §10.6 |
| R-24 | **Nenhuma leitura de operador sem hipótese.** `abrirEspacoComoAdmin` exige `motivo` da lista fechada e `referencia` não vazia; o enum recusa valor fora da lista no banco; e nenhuma linha de `auditoria` com `ator_tipo = 'operador'` existe com `motivo` ou `referencia` nulos | S2 | §8.1.1 |
| R-25 | **A partição não cai antes dos 5 anos.** O procedimento de `DROP PARTITION` recusa partição que contenha linha de `ator_tipo = 'operador'` com menos de 5 anos; e nenhum caminho de `DELETE` seletivo em `auditoria` alcança essas linhas aos 12 meses da classe "leitura em massa" | S2 | §3.8, §8.3 |
| R-26 | **`concessoes_de_admin` é append-only e sobrevive ao desligamento.** Revogar preenche `revogada_em` sem apagar a concessão; conceder de novo cria linha nova; e apagar a linha correspondente em `usuarios` não derruba nem esvazia o registro — `email_no_ato` continua identificando. `DELETE /auth/eu` recusa quem é ou foi admin nos últimos 5 anos | S2 | §3.8, §5.2 |
| R-27 | **`pagamentos_manuais.observacao` é nula aos 12 meses**, com a linha preservada; e a exportação do titular contém a linha com a `observacao` enquanto ela existir | S1 + S2 | §3.6, §6.1 |
| R-28 | **O termo de busca do painel nunca é gravado em claro** — um teste de propriedade gera e-mails e nomes, executa a busca, e afirma que nenhuma linha de `auditoria` contém o termo, só hash e contagem | S1 + S2 | §3.8, §8.2 |
