# Spec de autenticação — entrada, sessão, cadastro e o primeiro tenant

- **Data:** 2026-09-01
- **Autores:** `arquiteto-solucao` + `especialista-seguranca-appsec` (papéis acumulados)
- **Status:** Normativo. Contradizer este documento exige ADR.
- **Decisão do dono do produto que ele materializa:** **DP-12 — entrada por Google *e também* por e-mail e senha. Os dois caminhos, não um só.**
- **Fecha:** a lacuna registrada no fim de `apps/api/test/rls.test.ts` (`mavia_app` sem `INSERT` em `tenants`, `usuarios` e `tenant_usuarios` — o cadastro não funciona hoje)
- **Insumos:** `CLAUDE.md` (§2, regras 16–20) · `CONTEXT.md` (Tenant, Usuario, Papel) · `docs/arquitetura/sistema.md` §3.1, §3.9, §4.0–4.2 · `docs/seguranca/matriz-de-acesso.md` §1, §3.1, §4, §5 · `docs/compliance/retencao-e-eliminacao.md` §3.1, §5.2, §6 · ADR 0004 · ADR 0018 · `apps/api/migrations/0001_fundacao.sql`
- **Documentos que este spec obriga a emendar:** `docs/seguranca/matriz-de-acesso.md` (§3.1, §4, §5.1) · `docs/compliance/retencao-e-eliminacao.md` (§3.1, §6.1) · `docs/decisoes-do-produto.md` (DP-23 a DP-26)

> Este documento existe porque a entrada na plataforma era a única superfície do produto sem spec, e é ao mesmo tempo (a) a porta de todo o resto, (b) o lugar onde o cadastro está literalmente quebrado, e (c) o único fluxo em que o produto recebe dado pessoal de um terceiro (Google). As três coisas se resolvem juntas ou não se resolvem.

---

## 0. As nove decisões, em uma tabela

Quem só vai ler uma seção, leia esta.

| # | Decisão | Onde |
|---|---|---|
| **D1** | A identidade no Google é o par `(issuer, sub)`. **O e-mail nunca é chave de identidade** — é atributo mutável e, em domínio corporativo, reatribuível a outra pessoa | §1 |
| **D2** | **Nunca vinculamos contas automaticamente por e-mail coincidente.** Vincular exige provar uma credencial que a conta existente já possui. Posse do e-mail nunca basta | §2 |
| **D3** | `email_verified = false` no token do Google encerra o fluxo. Sem consulta por e-mail, sem criação, sem vinculação | §2.3 |
| **D4** | Argon2id com parâmetros calibrados e gravados no próprio hash (string PHC). **Sem pepper**, por uma razão específica desta VPS | §3 |
| **D5** | `POST /auth/senha/recuperar` **não cria senha em conta que não tem senha**, e **não é caminho de bypass de MFA**. É a regra que fecha o buraco de reatribuição de endereço | §3.4 |
| **D6** | Access token **opaco** de 15 min resolvido no Redis; refresh opaco rotacionado a cada uso, com família e detecção de reuso em `sessoes`. Cookie `__Host-` no web, Keychain/Keystore no mobile | §4 |
| **D7** | MFA **opcional**, com step-up nas onze operações da matriz — e **obrigatório** em duas delas (`POST /conexoes`, `POST /chaves-api`). Conta com MFA ativo só faz step-up com MFA | §5 |
| **D8** | `mavia_app` **não recebe `INSERT` em `tenants`.** Recebe `EXECUTE` em funções `SECURITY DEFINER` estreitas, de propriedade de um papel novo `mavia_auth` **sem `BYPASSRLS`**. Cadastro por e-mail só toca `tenants` **depois** do e-mail provado | §6 |
| **D9** | Ausência de `X-Mavia-Tenant` é **400 também quando o usuário tem exatamente um tenant**. Nunca escolha implícita | §7 |

---

## 1. Fluxo Google — OpenID Connect, Authorization Code com PKCE

### 1.1 O perfil exato

| Item | Valor | Por quê |
|---|---|---|
| Fluxo | `authorization_code` + **PKCE S256 obrigatório** | Mesma regra já fixada para `GET /oauth/autorizar` na matriz §3.16. Sem `implicit`, sem `password` grant |
| Escopos | **`openid email profile` e nada mais** | Não pedimos `offline_access`, não pedimos escopo de Gmail, Drive ou Agenda. Escopo não pedido é dado que não chega |
| Cliente | Confidencial. `client_secret` **só no servidor** | O app mobile nunca tem segredo do Google |
| `redirect_uri` | Uma por plataforma, registrada, comparada por **igualdade exata de string** | Prefixo e "startsWith" são a origem clássica do open redirect |
| `state` | 256 bits aleatórios, guardado no servidor (Redis, TTL 10 min), **uso único** | CSRF no retorno de autorização |
| `nonce` | 256 bits aleatórios, guardado junto do `state`, comparado com a claim `nonce` do `id_token` | Replay de `id_token` |
| `prompt` | `select_account` no login normal; **`prompt=login` + `max_age=0`** no step-up (§5.3) | Step-up precisa de ato de autenticação, não de sessão do navegador |
| Validação do `id_token` | Assinatura RS256 contra a JWKS do Google (cacheada, com rotação); `iss` **exatamente** `https://accounts.google.com`; `aud` = nosso `client_id`; `exp`/`iat` com tolerância ≤ 5 min; `nonce` confere | `alg: none` e `HS256` assinado com o `client_secret` são recusados antes da verificação, não durante |
| Troca do código | **Sempre no backend da Mavia**, inclusive no mobile | §1.4 |
| Tokens do Google | `access_token` e `refresh_token` do Google são **descartados na mesma função** que validou o `id_token`. Nunca persistidos, nunca logados | Não precisamos de API do Google. Guardá-los criaria um ativo sob ADR 0018 sem finalidade |

**O `id_token` nunca entra em log, métrica, mensagem de erro ou resposta de API.** Ele é credencial e portador de PII ao mesmo tempo (regra 20 do `CLAUDE.md` + R-5 da matriz).

### 1.2 O que guardamos do Google, campo a campo

Tabela nova `identidades_federadas` (SQL em §6.4).

| Campo do provedor | Guardamos? | Como | Por quê |
|---|---|---|---|
| `iss` | **Sim** — `issuer TEXT NOT NULL` | Literal | A identidade é `(provedor, issuer, subject)`. Guardar o `iss` hoje, com um provedor só, é o que permite acrescentar um segundo sem migrar identidade |
| `sub` | **Sim** — `subject TEXT NOT NULL` | Literal | **É a chave de identidade.** Estável por conta Google, nunca reutilizado, não muda quando o e-mail muda |
| `email` | **Sim, como dica** — `email_no_provedor` | Minúsculas, não é chave | Serve para mostrar "você entrou como fulano@…" e para o desempate humano de §2. **Nunca** para autenticar |
| `email_verified` | **Sim** — `email_verificado_no_provedor BOOLEAN` | Literal | Sem ele, o campo `email` é texto que o usuário digitou em outro produto |
| `name` | **Sim, uma vez** | Copiado para `usuarios.nome` **apenas na criação**, e editável depois | Evita pedir o nome duas vezes. Um login posterior **não** sobrescreve o nome que a pessoa editou |
| `picture` | **Não** | — | Entraria na lista de §2.2 do documento de retenção: URL de terceiro, atualiza sozinha, cria requisição de saída da nossa página para o Google em toda tela. Avatar é iniciais |
| `hd` (domínio) | **Não** | — | Não temos funcionalidade corporativa. Coletar "onde a pessoa trabalha" sem finalidade é coleta sem base |
| `access_token`, `refresh_token` | **Não** | Descartados | §1.1 |

### 1.3 Por que o `sub` e não o e-mail

Três razões independentes, e qualquer uma delas basta:

1. **O e-mail muda; o `sub` não.** Uma pessoa que troca `ana@gmail.com` por `ana.silva@gmail.com` continua sendo a mesma conta Google, com o mesmo `sub`. Se a identidade fosse o e-mail, ela perderia o acesso ao próprio espaço financeiro por ter mudado de endereço.
2. **O e-mail é reatribuível.** Em domínio gerenciado (Google Workspace), o administrador pode desativar `ana@empresa.com` e entregar **o mesmo endereço** a outra pessoa, com uma conta Google nova e um `sub` novo. Com o e-mail como chave, Beatriz entra e vê o extrato bancário de Ana. Este é o cenário que governa metade das decisões de §2.
3. **O e-mail não é único no tempo dentro do próprio Google.** O `sub` é garantido único e não reutilizado dentro do `iss`. É a única coisa no token que tem essa propriedade.

> **Invariante.** Nenhuma consulta de autenticação usa `email` na cláusula que decide *quem é* o usuário. `email` só aparece em consultas que decidem *se existe conflito a resolver por humano* (§2), e o resultado dessas nunca é "entrou".

### 1.4 As duas plataformas

**Web.** Redirect normal para o Google, retorno em `GET /v1/auth/google/retorno`, troca do código no servidor, emissão da sessão Mavia, `Set-Cookie` do refresh e redirect para a aplicação.

**Mobile.** O `authorization_code` **não é trocado no dispositivo**:

1. O app abre a autorização no **user-agent do sistema** — `ASWebAuthenticationSession` no iOS, Custom Tabs no Android. **WebView embutida é proibida**: ela dá ao app a capacidade técnica de ler a senha do Google, e o próprio Google a bloqueia.
2. O `redirect_uri` é um **App Link/Universal Link do domínio da Mavia**, isto é, uma rota do nosso backend — não um esquema `mavia://`, que qualquer app instalado pode reivindicar no Android.
3. O backend troca o código, emite a sessão Mavia e devolve ao app um **código de entrega de uso único** (60 s, ligado ao `state`), que o app troca por `POST /auth/google/concluir`.
4. O dispositivo nunca vê `client_secret`, `id_token` nem token do Google. Ele recebe um refresh token da Mavia e mais nada.

**Nota para o `engenheiro-mobile`:** a diretriz 4.8 da App Store trata de apps que usam login de terceiro. Como a Mavia oferece e-mail e senha como caminho equivalente e não coleta dado além de nome e e-mail, a leitura é que a exigência está atendida — mas **isso precisa ser confirmado antes da primeira submissão**, não depois da recusa.

### 1.5 Quando o e-mail no Google muda

O `sub` é conhecido, o `email` do token difere de `identidades_federadas.email_no_provedor`. Então, nesta ordem:

1. A pessoa **entra** — a identidade não mudou.
2. `email_no_provedor` é atualizado. É uma dica; atualizá-la é manutenção de dica.
3. **`usuarios.email` NÃO é tocado.** Nunca, por este caminho.
4. O titular é notificado nos dois endereços que conhecemos (o de `usuarios.email` e o novo), e o evento entra em `auditoria` com `classe = 'seguranca'`.

**Por que `usuarios.email` não segue o Google.** `usuarios.email` é o canal de recuperação e o canal de notificação de segurança da Mavia. Se ele seguisse o Google automaticamente, quem comprometesse a conta Google por dez minutos moveria o canal de recuperação da Mavia para um endereço próprio e manteria o acesso **depois** de a vítima recuperar o Google. Trocar `usuarios.email` é um fluxo próprio, autenticado, com step-up e confirmação nos dois endereços — e não está no escopo deste MVP.

### 1.6 Quando duas contas Google diferentes carregam o mesmo e-mail histórico

Duas contas Google não podem ter o mesmo endereço **ao mesmo tempo**. Portanto, um `sub` desconhecido apresentando um e-mail verificado que já pertence a uma `identidades_federadas` nossa **com outro `sub`, do mesmo provedor** significa uma coisa só: **o endereço mudou de dono**.

Não é "a mesma pessoa com uma segunda conta" — isso é impossível para o mesmo endereço. É reatribuição (Workspace) ou reciclagem. A regra está em §2.4 e é a mais dura do documento: **recusa definitiva, sem oferta de vinculação, sem criação de conta.**

---

## 2. Vinculação de contas — a decisão mais consequente

### 2.1 O que está em jogo

Este é o ponto onde produtos entregam a conta de uma pessoa a outra. Três desenhos são comuns e dois são defeituosos:

| Desenho | Falha |
|---|---|
| **Vincular automaticamente por e-mail verificado** | *Pre-account hijack.* O atacante registra `vitima@gmail.com` com senha **antes** de a vítima usar o produto. A vítima chega meses depois, entra pelo Google, o produto vincula, e os dois passam a ter acesso ao mesmo espaço financeiro — o atacante com uma senha que a vítima não sabe que existe. Também é o desenho que entrega a conta de Ana a Beatriz no caso §1.6 |
| **Criar uma conta nova em paralelo** | Duas contas, dois espaços, saldo dividido, e a pressão inevitável por um "fundir contas" operado por gente. Canal humano de fusão de contas é o vetor de engenharia social mais barato que existe num produto financeiro |
| **Exigir prova da credencial existente** | Custa um passo a mais no primeiro login federado de quem já tinha conta. É o que adotamos |

### 2.2 A regra

> **V-1.** Uma conta Mavia existente só é vinculada a uma identidade federada nova depois que a pessoa **prova, na mesma sessão, o controle de uma credencial que aquela conta já possui**: senha, código TOTP, código de recuperação de MFA, ou outra identidade federada já vinculada. **A posse do e-mail nunca é prova suficiente.**
>
> **V-2.** A vinculação é operação de step-up (§5.3), entra em `auditoria` com `classe = 'seguranca'` e notifica o titular em `usuarios.email`. O mesmo vale para a desvinculação.
>
> **V-3.** Uma conta nunca fica sem nenhum caminho de entrada: **desvincular a última identidade federada de uma conta sem senha é recusado** (409). Antes, defina uma senha.

### 2.3 E-mail não verificado no token

`email_verified = false` (ou ausente) é tratado como **e-mail ausente**, não como e-mail suspeito:

- Não consultamos `usuarios` por aquele endereço — nem para dizer que existe, nem para dizer que não.
- Não criamos conta. Uma conta cujo endereço não foi provado não tem canal de recuperação nem canal de notificação de segurança, e num produto financeiro isso não é um detalhe de cadastro.
- Se o `sub` já for **conhecido**, a pessoa **entra normalmente** — a identidade não depende do e-mail. Apenas a dica não é atualizada.
- Resposta genérica, sem revelar qual verificação falhou: *"Não foi possível concluir a entrada com o Google. Verifique seu endereço na sua Conta Google e tente de novo."*

### 2.4 A matriz de decisão

Seis casos. É a tabela inteira do problema, e é **função pura** (§8.4).

| # | `sub` | `email_verified` | Estado na Mavia | Decisão |
|---|---|---|---|---|
| **C1** | conhecido | qualquer | — | **Entra.** Atualiza `ultimo_login_em`; se o e-mail mudou, §1.5 |
| **C2** | novo | `false` | — | **Recusa.** §2.3. Nenhuma consulta por e-mail |
| **C3** | novo | `true` | nenhum usuário com aquele e-mail | **Cadastro** — cria usuário + identidade + primeiro tenant, atomicamente (§6) |
| **C4** | novo | `true` | usuário existe **e tem senha ou MFA** | **Exige prova (V-1).** Tela de vinculação: "Já existe uma conta Mavia com este endereço. Entre com sua senha para vincular sua Conta Google." Ao provar, vincula, audita e notifica |
| **C5** | novo | `true` | usuário existe, **sem senha e sem MFA**, e possui identidade do **mesmo provedor com outro `sub`** | **Recusa definitiva.** É reatribuição de endereço (§1.6). Nunca vincula, nunca cria, e a mensagem é a genérica de C2 — não confirma que existe conta |
| **C6** | novo | `true` | usuário existe, sem senha e sem MFA, **sem** identidade do mesmo provedor | **Impossível por construção** — todo usuário nasce com pelo menos uma credencial (§6.2). Se ocorrer, é corrupção de dado: recusa e alerta ao operador |

### 2.5 Por que C4 pode revelar que a conta existe, e C5 não pode

C4 exibe "já existe uma conta com este endereço" para alguém que **acabou de provar ao Google que controla aquele endereço**. Enumeração em massa é impossível: o atacante precisaria controlar cada caixa postal que quisesse testar. E a mesma informação já é obtenível pela recuperação de senha por qualquer pessoa que tenha a caixa.

C5 é o oposto: quem está no teclado controla a caixa **hoje** e não controlava **quando a conta foi criada**. Dizer "existe uma conta Mavia associada a este endereço" entregaria a Beatriz o fato de que Ana usava a Mavia, e a partir daí o alvo. Por isso C5 usa a mensagem genérica de C2, indistinguível de "o Google recusou".

### 2.6 A direção inversa: cadastro por e-mail sobre conta que já entra pelo Google

`POST /auth/registrar` com um endereço que já pertence a um usuário **não cria nada e não revela nada** — resposta e tempo idênticos ao caso novo, como a matriz §3.1 já exige (A-13). O que muda é o e-mail enviado ao titular: em vez do link de confirmação, ele recebe *"alguém tentou criar uma conta com o seu endereço. Você já tem conta — entre pelo Google"*, **sem nenhum token acionável dentro**. Um e-mail de aviso que carrega um link que cria algo é um convite a ser usado como arma contra o próprio titular.

### 2.7 Não existe canal humano

**Suporte não vincula, não desvincula, não transfere e não recupera conta.** Não há exceção, não há formulário, não há "prova de identidade por documento" — inclusive porque a Mavia não coleta documento (retenção §2.2) e passaria a coletá-lo justamente para operar o vetor de ataque.

Consequência honesta, que precisa estar na tela: **quem perder o acesso à Conta Google usada para entrar, e não tiver senha nem MFA na Mavia, perde o espaço.** É por isso que a tela de sucesso do cadastro por Google oferece, uma vez e de forma visível, *"defina também uma senha"*. A consequência é do dono do produto assumir — **DP-25**.

---

## 3. E-mail e senha

### 3.1 Hash

**Argon2id**, `@node-rs/argon2` (binding nativo, sem dependência de rede, lockfile fixado, auditoria no CI).

| Parâmetro | Valor de partida | Regra |
|---|---|---|
| `m` (memória) | **64 MiB** | Calibrar para que **um** hash custe 250–500 ms na VPS alvo. O piso, mesmo se a VPS for pequena, é 19 MiB / `t=2` |
| `t` (iterações) | 3 | |
| `p` (paralelismo) | 1 | |
| Sal | 16 bytes, CSPRNG, por senha | |
| Saída | 32 bytes | |
| Formato em coluna | **String PHC** (`$argon2id$v=19$m=65536,t=3,p=1$…`) em `usuarios.senha_hash TEXT` | Os parâmetros viajam com o hash. Quando forem elevados, o login **re-hasheia na hora** (é o único momento em que a senha em claro existe) sem migration e sem invalidar ninguém |

**Duas consequências operacionais que não são opcionais:**

1. **Semáforo de concorrência.** 64 MiB × N verificações simultâneas é um caminho de exaustão de memória da VPS que qualquer pessoa dispara com um laço. O módulo `auth` limita verificações simultâneas (partida: 4) e devolve **429** ao exceder — antes de alocar. O rate limit `RL-AUTH` é a primeira barreira; o semáforo é a que sobra quando o Redis está fora.
2. **Verificação fantasma.** Endereço inexistente executa uma verificação Argon2 contra um hash constante antes de responder. Sem isso, o tempo de resposta enumera a base — e a matriz §3.1 exige ±50 ms.

### 3.2 Sem pepper — e a razão é específica deste projeto

Um pepper guardado no guardião de chaves (ADR 0018) tornaria um dump do Postgres, sozinho, inútil para ataque offline. É um ganho real, e mesmo assim **não o adotamos**.

Motivo: pela decisão **D3.3** do dono do produto, a KEK vive num guardião local **selado**, que exige desselamento manual a cada reboot da VPS. Amarrar a verificação de senha a ele significa que **ninguém entra na plataforma até um humano desselar** — a falha deixa de ser "a sincronização bancária parou" (degradação já aceita e documentada) e vira "o produto está fora do ar". Trocar disponibilidade total por defesa contra um cenário em que o atacante já tem o dump inteiro é o negócio errado.

Registrado aqui para não ser redescoberto: **se um dia a KEK migrar para um KMS externo de alta disponibilidade, o pepper de senha passa a valer a pena e exige ADR própria.**

### 3.3 Política de senha

Segue NIST SP 800-63B, e o que ela **não** tem é tão normativo quanto o que tem.

| Regra | Valor |
|---|---|
| Comprimento mínimo | **12 caracteres** |
| Comprimento máximo | 128 (validado antes do hash, para não virar DoS) |
| Conjunto de caracteres | Unicode inteiro, espaços incluídos. Normalização **NFKC** antes do hash. Nenhum truncamento, em nenhum ponto |
| Regra de composição (maiúscula, número, símbolo) | **Não existe.** Produz `Senha@2026` e nada mais |
| Expiração periódica | **Não existe.** Rotação forçada produz senha derivada da anterior |
| Perguntas de segurança | **Proibidas.** São um segundo fator com a entropia de uma conversa de família |
| Bloqueio de senha ruim | Lista local: 100 mil senhas mais vazadas + tokens derivados do e-mail, do nome e do nome do tenant. **Verificação local, sem chamada a terceiro** — nenhuma consulta sai da VPS por causa de uma senha |
| Medidor de força na tela | Sim, e ele **informa**; quem barra é a lista, não o medidor |
| Mudança de senha | Exige a senha atual (matriz §3.1), e ao concluir **revoga todas as sessões exceto a corrente** — obrigatório |

O dono do produto pode querer, mais adiante, consultar a base do *Have I Been Pwned* por k-anonimato (envia 5 caracteres de um hash SHA-1, não a senha). Isso é uma chamada a terceiro e uma dependência de disponibilidade: fica registrado como possibilidade, **não** adotado.

### 3.4 Recuperação — e por que é o caminho mais atacado

**O mecanismo.**

| Item | Regra |
|---|---|
| Token | 256 bits de CSPRNG, armazenado como **SHA-256** em `recuperacoes_senha.token_hash` (segredo de alta entropia não precisa de Argon2) |
| Validade | **30 minutos**, uso único |
| Invalidação | Consumido no uso; **todos** os tokens do usuário são invalidados a cada troca de senha, a cada login bem-sucedido e a cada emissão de um token novo |
| Resposta HTTP | Idêntica e de tempo constante para endereço existente e inexistente (matriz §3.1) |
| Conta **sem** `senha_hash` | **Nenhum token é emitido.** O e-mail enviado é informativo: *"sua conta entra pelo Google"*. A resposta HTTP é a mesma |
| Conta com MFA ativo | O consumo do token exige **também** um código TOTP ou um código de recuperação. Recuperar senha **não** desliga MFA e **não** contorna MFA |
| Ao concluir | Revoga **todas** as sessões e todos os tickets de step-up; **não** autentica a pessoa — ela vai para a tela de entrada. Notifica o titular. Entra em `auditoria` com `classe = 'seguranca'` |
| Rate limit | `RL-AUTH` por hash do e-mail e por IP, mais teto de 3 tokens vivos por usuário |

**A linha D5 é a mais importante do documento inteiro.** "Conta sem senha não recebe token de recuperação" parece um detalhe de UX e é, na verdade, a trava que fecha §1.6: sem ela, Beatriz — que agora controla `ana@empresa.com` — pediria recuperação de senha, *definiria* uma senha numa conta que só entrava pelo Google, e entraria. A recusa de vinculação de C5 seria contornada pela porta dos fundos, e o produto teria duas regras contraditórias sobre o mesmo fato.

**Por que a recuperação é o caminho mais atacado de qualquer produto financeiro.** Quatro propriedades que só ela reúne:

1. **É a única superfície não autenticada que *substitui* uma credencial.** Login compara; recuperação escreve.
2. **Ela terceiriza a segurança do produto para uma caixa postal** cuja higiene não controlamos — reutilização de senha, ausência de MFA no provedor, encaminhamento automático esquecido, endereço corporativo com acesso do administrador.
3. **Todo instinto de produto empurra na direção errada.** "Não faça o usuário entrar de novo depois de redefinir" vira bypass de sessão; "não exija MFA de quem acabou de provar o e-mail" vira bypass de MFA; "diga que o endereço não existe para poupar a pessoa" vira enumeração; "deixe o link valer um dia" vira uma janela de 24 h para quem tem acesso à caixa.
4. **Na Mavia o prêmio é maior que o normal.** Atrás da senha há histórico financeiro completo, conexões bancárias vivas e `POST /exportacoes`, que leva tudo em uma requisição.

---

## 4. Sessão

### 4.1 O que é emitido

| Token | Forma | Vida | Onde vive |
|---|---|---|---|
| **Access** | **Opaco**, 256 bits, sem claims | **15 min** | Servidor: Redis `sess:<sha256(token)>` → `{sessao_id, usuario_id, expira_em}`, TTL 15 min. Cliente: **memória** no web, memória no mobile |
| **Refresh** | Opaco, 256 bits | Deslizante, com teto absoluto (§4.3) | Servidor: `sessoes.refresh_hash` (SHA-256), Postgres é a autoridade. Cliente: cookie `__Host-` (web) ou Keychain/Keystore (mobile) |

**Por que o access token é opaco e não um JWT.** A matriz §3.1 exige que `POST /auth/sessoes/revogar-todas` tenha efeito em ≤ 60 s "mesmo com access token válido em circulação". Um JWT auto-contido só cumpre isso com uma lista de revogação consultada a cada requisição — que é exatamente uma busca em Redis, o mesmo custo do token opaco, com um formato a mais para versionar e um conjunto de claims a mais para vazar. Com token opaco a revogação é **imediata (0 s)**, o requisito de 60 s sobra, e o token não carrega nenhuma informação sobre quem é o portador. A mesma decisão já vale para tokens de OAuth/MCP na matriz §3.16; ter dois modelos de token no mesmo produto seria a inconsistência.

**Redis é autoridade do access; Postgres é autoridade do refresh.** Perder o Redis desloga ninguém: os clientes renovam pelo refresh, silenciosamente. Perder o Postgres é incidente de banco, não de sessão.

### 4.2 A conversa com a tabela `sessoes` e com a policy por `app.usuario_id`

`sessoes` é criada na migration 0003 (§6.5), com a policy que `sistema.md` §3.9 já prevê:

```sql
CREATE POLICY sessao_do_usuario ON sessoes
  USING      (usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid)
  WITH CHECK (usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid);
```

**E aqui há um problema de galinha e ovo que a arquitetura não tinha notado, e que este spec resolve:**

> Para resolver um refresh token é preciso ler `sessoes` por `refresh_hash`. A policy filtra por `app.usuario_id`. Mas `app.usuario_id` é justamente o que aquela leitura vai descobrir. **Sob a policy, a consulta de autenticação retorna zero linhas — sempre.** O mesmo vale para `usuarios` no login por e-mail: a policy `usuario_proprio` exige `app.usuario_id`, que ainda não existe.

Três saídas, e a escolha importa:

| Saída | Por que não / por que sim |
|---|---|
| `BYPASSRLS` no papel da API | **Vetado.** Contraria o ADR 0004 e destrói a garantia de todo o resto |
| Papel de banco `mavia_auth` com login próprio e `SELECT` em `usuarios` e `sessoes` | Rejeitado: uma conexão comprometida **despeja a base inteira de e-mails e hashes** em uma consulta |
| **Funções `SECURITY DEFINER` estreitas, no esquema `auth`** | **Adotado.** Cada função recebe um hash exato ou um e-mail exato e devolve **no máximo uma linha**. Não existe função que devolva conjunto. Uma conexão comprometida sonda um endereço por vez — enumeração custosa, despejo impossível |

É o mesmo padrão da exceção declarada de `outbox_pendencias` em `sistema.md` §3.9: **uma exceção escrita é auditável; uma exceção implícita não é.**

**O detalhe que silenciosamente anularia tudo:** a migration roda como `mavia_migrate`, que **tem `BYPASSRLS`**. Uma função `SECURITY DEFINER` criada por ele executa com `BYPASSRLS` — ou seja, a "função estreita" teria acesso irrestrito à base. Por isso toda função de `auth` recebe `ALTER FUNCTION … OWNER TO mavia_auth` **na mesma migration que a cria**, e `mavia_auth` é `NOLOGIN NOBYPASSRLS`. Isto é critério de aceite testável (§8.2, `AB-41`).

### 4.3 Vida, rotação e revogação

**Rotação.** Todo `POST /auth/refresh` consome o refresh apresentado e emite outro. A linha antiga permanece com `revogada_em` e `substituida_por` — ela é a armadilha.

**Detecção de reuso.** Apresentar um refresh já consumido significa que existem duas cópias do mesmo token no mundo. Efeito: **revoga a `familia_id` inteira** (todas as sessões descendentes do mesmo login), grava em `auditoria` com `classe = 'seguranca'` e notifica o titular. É o que `sistema.md` §3.1 já previa com `familia_id`; aqui ele ganha o gatilho.

**Vidas propostas** (números são **DP-24**, do dono do produto; o piso de segurança é a rotação e o teto absoluto existirem):

| Plataforma | Deslizante | Teto absoluto | Razão |
|---|---|---|---|
| Web | 14 dias | **30 dias** | Navegador compartilhado, sessão que precisa morrer sozinha |
| Mobile | 60 dias | **180 dias** | Dispositivo pessoal com desbloqueio biométrico; exigir login a cada 14 dias em app de finanças é o que faz a pessoa escolher uma senha pior |

**Revogação, em quatro caminhos:** `POST /auth/sair` (a corrente), `DELETE /auth/sessoes/:id` (uma, com `dono-usuario`), `POST /auth/sessoes/revogar-todas` (todas menos a corrente, sem step-up — matriz §4), e automática: troca de senha, redefinição de senha, desvinculação de identidade, remoção do membro do tenant, eliminação da conta, reuso de refresh detectado.

### 4.4 Web

- Refresh em cookie **`__Host-mavia_rt`**: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/v1/auth`. O prefixo `__Host-` proíbe `Domain` e impõe `Path=/` — **usamos `__Host-` com `Path=/`** e restringimos o alcance por CORS e por rota; nenhum outro caminho lê o cookie porque nenhum outro handler o consulta.
- `SameSite=Lax` e não `Strict`: o retorno do Google é uma navegação de topo vinda de `accounts.google.com`, e `Strict` a descartaria. `Lax` já bloqueia POST cross-site.
- Defesa adicional em `/auth/refresh` e `/auth/sair`: exigem o header `X-Mavia-Client`, que não é um header simples — força preflight CORS, e a origem cruzada não passa.
- **O access token nunca vai para `localStorage` nem para `sessionStorage`.** Vive numa variável de módulo. XSS continua roubando 15 minutos; não rouba semanas.

### 4.5 Mobile

- Refresh em `expo-secure-store` (Keychain / Android Keystore), com `WHEN_UNLOCKED_THIS_DEVICE_ONLY` — não sai em backup do dispositivo.
- **Biometria é conveniência, nunca fator.** Ela destrava a leitura local do refresh; ela não autentica contra o servidor e nunca substitui MFA. É a regra 3 do papel de AppSec, e é onde apps financeiros costumam mentir para si mesmos.
- **Offline.** O cache SQLite continua legível com o access token expirado — o usuário no metrô vê o próprio saldo. Mutações vão para a fila local. Quando o refresh volta a valer, `POST /sync/mutacoes` reaplica **com o mesmo guard da rota equivalente** (matriz §3.14): a fila local não é autoridade de autorização.
- **Refresh além do teto absoluto, ou revogado:** o app exige login novo, **preserva a fila de mutações** e a reaplica depois. Descartar mutações locais porque a sessão expirou é perder lançamento do usuário — é bug financeiro, não bug de auth.
- **Sessão revogada:** ao receber 401 com `SESSAO_REVOGADA`, o app **apaga o cache SQLite** antes de mostrar a tela de login. Revogar no servidor e deixar o extrato no aparelho não é revogar.

---

## 5. MFA

### 5.1 A decisão

**Opcional, com exigência em operações sensíveis — e obrigatório em duas delas.**

Obrigatório para todos seria a decisão mais segura e é a errada para um produto de finanças pessoais em lançamento: expulsa a metade dos usuários que nunca configurou TOTP, no exato momento em que o produto ainda não provou valor. Puramente opcional deixa `POST /conexoes` (credencial bancária) e `POST /chaves-api` (acesso programático perpétuo) protegidos por uma senha só.

| Regra | |
|---|---|
| **M-1** | MFA é opcional e incentivado. TOTP (RFC 6238). **SMS é proibido** (retenção §2.2) |
| **M-2** | Se a conta **tem** MFA ativo, todo step-up exige **MFA**. Senha sozinha não faz step-up numa conta com MFA — senão MFA seria rebaixável por quem tem a senha |
| **M-3** | **`POST /conexoes` e `POST /chaves-api` exigem MFA ativo.** Quem não tem é levado à inscrição, não recebe 403 seco |
| **M-4** | Login com MFA usa **sessão parcial**: o access token só é emitido depois de `POST /auth/mfa/verificar`. A sessão parcial vale 5 min, não serve para nenhuma outra rota e não cria linha em `sessoes` |
| **M-5** | Conta que entra **só** pelo Google também pode ativar MFA da Mavia — e deve, se quiser M-3. O MFA da Mavia é independente do MFA do Google: quem comprometer a Conta Google não passa por ele |

MFA obrigatório para todo `proprietario` é decisão do dono do produto — **DP-23**. Enquanto não houver decisão, vale M-1 a M-5.

### 5.2 Parâmetros

TOTP SHA-1 (compatibilidade com todo autenticador), 6 dígitos, passo de 30 s, janela de ±1 passo. Segredo de 160 bits, cifrado sob envelope com `proposito = usuario.mfa` (ADR 0018 §D0 — `usuarios` é global e não tem tenant). Dez códigos de recuperação de uso único, exibidos **uma vez**, guardados como SHA-256 (alta entropia). **Contador do último passo aceito** por usuário (`mfa_ultimo_passo`), para que um código capturado não seja reutilizado dentro da própria janela. Teto de 5 tentativas por desafio (matriz §3.1).

### 5.3 Step-up: conciliação com as onze operações da matriz

A matriz §4 lista onze operações que exigem "senha ou MFA no ato". "Senha" não é enunciável numa conta que entra só pelo Google. Então o mecanismo é reescrito em termos de **fator**, sem mudar nenhuma das onze linhas:

> **Step-up = provar de novo, agora, um fator que a conta possui.** Em ordem de precedência: (1) se MFA está ativo → **TOTP ou código de recuperação, obrigatoriamente** (M-2); (2) senão, se a conta tem senha → senha; (3) senão → **reautenticação no provedor federado com `prompt=login` e `max_age=0`**, e o `id_token` retornado precisa trazer `auth_time` dentro dos últimos 120 s.

O ticket permanece exatamente como a matriz §4 define: opaco, 5 min, escopado a `(acao, recurso)`, uso único, no Redis com o `sessao_id`, apresentado em `X-Mavia-StepUp`. `AB-28` continua valendo sem alteração.

| Operação (matriz §4) | Fator aceito |
|---|---|
| `POST /conexoes` · `POST /chaves-api` | **MFA, sempre** (M-3) |
| `POST /exportacoes` escopo "tudo" · `DELETE /auth/eu` · `DELETE /tenants/:id` · `POST /tenants/:id/comecar-do-zero` · `POST /auth/senha/alterar` · `PATCH`/`DELETE` de membro · `GET /oauth/autorizar` | Precedência de §5.3 |
| `POST /auth/mfa/inscrever` · `POST /auth/mfa/confirmar` · `DELETE /auth/mfa` | Precedência de §5.3. `DELETE /auth/mfa` exige o **próprio MFA** — desligar MFA sem apresentar MFA é MFA que não existe |
| **Novas deste spec:** `POST /auth/identidades` (vincular) · `DELETE /auth/identidades/:id` (desvincular) · `POST /auth/senha/definir` em conta sem senha | Precedência de §5.3 |

As três novas linhas **precisam entrar na matriz §4**, que passará a listar quatorze operações. Este spec não edita aquele documento; a emenda é ticket.

---

## 6. Cadastro e a criação do primeiro tenant — fechando a lacuna

### 6.1 O que está quebrado hoje, exatamente

`0001_fundacao.sql` concede a `mavia_app` apenas `GRANT SELECT ON tenants, usuarios, tenant_usuarios`. O cadastro precisa inserir nas três, na mesma transação. Sob o papel da requisição, ele falha. Está registrado no fim de `rls.test.ts` e a decisão de não resolver ali estava certa.

### 6.2 A forma da solução, e por que não é um `GRANT`

Conceder `INSERT ON tenants TO mavia_app` resolveria a falha e criaria quatro problemas:

1. Qualquer bug em qualquer rota autenticada passaria a poder criar tenant.
2. Nada garantiria que um tenant nascesse com um `proprietario` — um tenant órfão é um espaço que ninguém pode administrar e ninguém pode eliminar.
3. O teto ("3 por dia, 10 ativos" — matriz §3.2) viveria só na aplicação, e um teto que existe só na aplicação é um teto que a próxima rota esquece.
4. Criação em massa de tenants ficaria a uma requisição de distância.

**A forma adotada:** `mavia_app` continua **sem `INSERT` em `tenants`**. Ele recebe `EXECUTE` em nove funções `SECURITY DEFINER` do esquema `auth`, de propriedade do papel novo **`mavia_auth` (`NOLOGIN`, `NOBYPASSRLS`)**, cada uma atômica, cada uma com os tetos **dentro do banco**:

| Função | O que faz | Teto embutido |
|---|---|---|
| `auth.buscar_credencial(p_email)` | Devolve **uma** linha: `usuario_id`, `senha_hash`, `mfa_ativo`, `tem_identidade` | Devolve no máximo 1 linha, sempre |
| `auth.resolver_sessao(p_refresh_hash)` | Devolve **uma** linha de `sessoes` pelo hash exato | Idem. Nunca aceita `usuario_id` como entrada |
| `auth.resolver_recuperacao(p_token_hash)` | Devolve **uma** linha de `recuperacoes_senha` pelo hash exato, e o `usuario_id` que ela aponta | Idem. É o que permite `SET LOCAL app.usuario_id` no fluxo de recuperação, que é pré-autenticação por definição |
| `auth.registrar_pendente(...)` | Grava a intenção de cadastro. **Não cria usuário nem tenant** | Um pendente vivo por endereço (índice único). Não revela se o e-mail já existe |
| `auth.emitir_recuperacao(...)` | Emite token de recuperação | **Recusa silenciosamente conta sem `senha_hash`** (D5). Teto de 3 tokens vivos |
| `auth.concluir_recuperacao(...)` | Consome o token e escreve a senha nova | Numa transação. Falha se expirado, consumido, ou se a conta não tem senha |
| `auth.confirmar_cadastro(p_token_hash)` | Consome `cadastros_pendentes` e cria `usuarios` + `tenants` + `tenant_usuarios(proprietario)` numa transação | 1 tenant por cadastro. Falha se o e-mail já existir |
| `auth.cadastrar_federado(p_issuer, p_subject, p_email, p_nome)` | Cria `usuarios` + `identidades_federadas` + `tenants` + `tenant_usuarios` | Idem. Falha se `(issuer, subject)` já existir |
| `auth.criar_tenant(p_usuario_id, p_nome)` | O `POST /tenants` da matriz §3.2 | **3 por usuário nas últimas 24 h; 10 ativos por usuário** — contados dentro da função |

**Nenhuma delas devolve conjunto. Nenhuma delas aceita lista.**

### 6.3 O teto de taxa em quatro camadas

Criar tenants em massa precisa furar as quatro:

| Camada | Controle |
|---|---|
| **1. Estrutural** | **Cadastro por e-mail nunca toca `tenants` antes de o endereço ser provado.** `POST /auth/registrar` grava em `cadastros_pendentes` (e-mail, hash Argon2 da senha, hash do token, TTL 24 h) e **não cria usuário nem tenant**. O tenant nasce em `auth.confirmar_cadastro`, no clique do link. Criar mil tenants exige provar mil caixas postais distintas. É a camada que faz as outras três serem defesa em profundidade, e não a defesa |
| **2. Rede** | Classe de rate limit nova **`RL-CADASTRO`**: 3/h e 10/dia por IP, 30/dia por faixa `/24`, `RL-AUTH` por hash do e-mail. Emenda à matriz §5.1 |
| **3. Aplicação** | Guard global; `POST /tenants` na classe `RL-CARA` (3/h, 10/dia), como a matriz já manda |
| **4. Banco** | Os tetos dentro de `auth.criar_tenant`. É a camada que sobrevive a um bug de guard |

Mais um **disjuntor global**: cadastros concluídos por hora acima do padrão histórico dispara alerta ao operador (`mavia_cadastros_concluidos`, `mavia_cadastros_recusados`). Detecção não é prevenção, mas é a diferença entre descobrir hoje e descobrir na fatura do disco.

### 6.4 O SQL — migration 0002 (identidade e credenciais)

No estilo de `0001_fundacao.sql`: comentário explica o *porquê*, nunca o óbvio.

```sql
-- 0002 — Identidade: credenciais, identidades federadas e cadastro pendente.
--
-- Implementa docs/produto/spec-autenticacao.md §1, §2, §3 e §6.
-- A decisão que esta migration materializa: a chave de identidade federada é
-- (provedor, issuer, subject) — nunca o e-mail. O e-mail é atributo mutável e,
-- em domínio corporativo, reatribuível a outra pessoa.

-- ---------------------------------------------------------------------------
-- Colunas de credencial em `usuarios`
-- ---------------------------------------------------------------------------
-- `usuarios.email` continua TEXT com índice único sobre lower(email), como em
-- 0001. `sistema.md` §3.1 dizia CITEXT; migrar o tipo exigiria a extensão e não
-- compraria nada — o índice funcional já garante a unicidade insensível a
-- caixa. A divergência fica registrada aqui, não corrigida em silêncio.
ALTER TABLE usuarios
  ADD COLUMN senha_hash           TEXT,          -- string PHC do Argon2id; NULL = conta só federada
  ADD COLUMN senha_atualizada_em  TIMESTAMPTZ,
  ADD COLUMN email_verificado_em  TIMESTAMPTZ,   -- toda linha nasce com valor (ver §6.3, camada 1)
  ADD COLUMN mfa_segredo_cifrado  BYTEA,         -- envelope, proposito = usuario.mfa (ADR 0018)
  ADD COLUMN mfa_kek_versao       SMALLINT,
  ADD COLUMN mfa_ativado_em       TIMESTAMPTZ,
  ADD COLUMN mfa_ultimo_passo     BIGINT,        -- anti-replay dentro da janela de 30 s
  ADD COLUMN ultimo_acesso_em     TIMESTAMPTZ;

-- Se há segredo de MFA, há versão de KEK. Sem isso a rotação incremental de
-- KEK (A-37) não sabe o que reembrulhar.
ALTER TABLE usuarios
  ADD CONSTRAINT mfa_tem_versao_de_kek
  CHECK (num_nonnulls(mfa_segredo_cifrado, mfa_kek_versao) <> 1);

-- ---------------------------------------------------------------------------
-- Identidades federadas
-- ---------------------------------------------------------------------------
CREATE TYPE provedor_federado AS ENUM ('google');

CREATE TABLE identidades_federadas (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id                   UUID NOT NULL REFERENCES usuarios (id),
  provedor                     provedor_federado NOT NULL,
  -- `issuer` guardado hoje, com um provedor só, é o que permite acrescentar um
  -- segundo provedor sem migrar identidade nenhuma.
  issuer                       TEXT NOT NULL,
  subject                      TEXT NOT NULL,
  -- Dica de vinculação e de exibição. NUNCA entra em consulta que decide quem
  -- é o usuário — ver §1.3.
  email_no_provedor            TEXT,
  email_verificado_no_provedor BOOLEAN NOT NULL DEFAULT FALSE,
  vinculado_em                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_login_em              TIMESTAMPTZ
);

-- A identidade. Sem `WHERE deleted_at IS NULL`: `identidades_federadas` não
-- tem soft delete de propósito — desvincular é DELETE físico, porque uma linha
-- morta aqui reservaria um `subject` para sempre e deixaria a pessoa sem poder
-- vincular a própria conta Google de novo.
CREATE UNIQUE INDEX identidade_federada_unica
  ON identidades_federadas (provedor, issuer, subject);

CREATE INDEX identidades_por_usuario ON identidades_federadas (usuario_id);

-- Detecta o caso C5 (reatribuição de endereço, §1.6) em uma consulta:
-- "existe identidade deste provedor com este e-mail e outro subject?"
CREATE INDEX identidades_por_email_no_provedor
  ON identidades_federadas (provedor, lower(email_no_provedor));

-- ---------------------------------------------------------------------------
-- Cadastro pendente — a camada 1 do teto de taxa (§6.3)
-- ---------------------------------------------------------------------------
-- Nenhuma linha em `tenants` nasce de um e-mail não provado. Enquanto o clique
-- no link não acontece, o cadastro vive aqui e não existe usuário nem tenant.
CREATE TABLE cadastros_pendentes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL,
  nome          TEXT        NOT NULL,
  senha_hash    TEXT        NOT NULL,   -- Argon2id já aplicado; a senha em claro nunca chega aqui
  token_hash    BYTEA       NOT NULL,   -- SHA-256 de 256 bits de CSPRNG
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em     TIMESTAMPTZ NOT NULL,
  consumido_em  TIMESTAMPTZ
);
CREATE UNIQUE INDEX cadastro_pendente_por_token ON cadastros_pendentes (token_hash);
-- Um cadastro pendente vivo por endereço: sem isso, mil requisições geram mil
-- e-mails para a mesma vítima, e o produto vira ferramenta de assédio.
CREATE UNIQUE INDEX cadastro_pendente_por_email
  ON cadastros_pendentes (lower(email)) WHERE consumido_em IS NULL;

-- ---------------------------------------------------------------------------
-- Recuperação de senha
-- ---------------------------------------------------------------------------
CREATE TABLE recuperacoes_senha (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id    UUID        NOT NULL REFERENCES usuarios (id),
  token_hash    BYTEA       NOT NULL,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em     TIMESTAMPTZ NOT NULL,
  consumido_em  TIMESTAMPTZ,
  ip_hash       BYTEA                   -- pepper no guardião (A-39). Nunca sai em resposta
);
CREATE UNIQUE INDEX recuperacao_por_token ON recuperacoes_senha (token_hash);
CREATE INDEX recuperacao_por_usuario ON recuperacoes_senha (usuario_id)
  WHERE consumido_em IS NULL;

-- ---------------------------------------------------------------------------
-- Códigos de recuperação de MFA
-- ---------------------------------------------------------------------------
-- SHA-256 e não Argon2id: são 128 bits de CSPRNG. Argon2 protege segredo de
-- baixa entropia; aqui só encareceria a verificação.
CREATE TABLE mfa_codigos_recuperacao (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id    UUID        NOT NULL REFERENCES usuarios (id),
  codigo_hash   BYTEA       NOT NULL,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumido_em  TIMESTAMPTZ
);
CREATE UNIQUE INDEX mfa_codigo_unico ON mfa_codigos_recuperacao (codigo_hash);
CREATE INDEX mfa_codigos_por_usuario ON mfa_codigos_recuperacao (usuario_id)
  WHERE consumido_em IS NULL;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Estas quatro tabelas são globais como `usuarios` e `sessoes`: a policy é por
-- app.usuario_id, nunca por app.tenant_id. Ver matriz-de-acesso.md §3.1.
ALTER TABLE identidades_federadas   ENABLE ROW LEVEL SECURITY;
ALTER TABLE identidades_federadas   FORCE  ROW LEVEL SECURITY;
CREATE POLICY identidade_do_usuario ON identidades_federadas
  USING      (usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid)
  WITH CHECK (usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid);

ALTER TABLE mfa_codigos_recuperacao ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_codigos_recuperacao FORCE  ROW LEVEL SECURITY;
CREATE POLICY mfa_codigo_do_usuario ON mfa_codigos_recuperacao
  USING      (usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid)
  WITH CHECK (usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid);

-- `cadastros_pendentes` e `recuperacoes_senha` são pré-autenticação: não existe
-- app.usuario_id no momento em que são lidas. RLS ligada e NENHUMA policy:
-- com RLS ligada e sem policy, todo papel lê zero linhas. O acesso passa a ser
-- exclusivamente pelas funções de 0004, que trazem a única policy que existirá
-- sobre estas duas tabelas, nomeada e restrita a `mavia_auth`. Assim, um GRANT
-- indevido no futuro continua não lendo nada.
ALTER TABLE cadastros_pendentes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cadastros_pendentes FORCE  ROW LEVEL SECURITY;
ALTER TABLE recuperacoes_senha  ENABLE ROW LEVEL SECURITY;
ALTER TABLE recuperacoes_senha  FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------------
-- mavia_app enxerga a própria identidade federada (tela Config › Segurança) e
-- desvincula. Não recebe nada em cadastros_pendentes nem recuperacoes_senha.
GRANT SELECT, INSERT, DELETE ON identidades_federadas   TO mavia_app;
GRANT SELECT, INSERT, UPDATE ON mfa_codigos_recuperacao TO mavia_app;

-- GRANT por COLUNA, e não na tabela: os fluxos pós-autenticação (definir senha,
-- inscrever MFA, carimbar último acesso) precisam escrever em `usuarios`, mas
-- `email` NÃO está na lista. Trocar o endereço de recuperação é um fluxo
-- próprio, autenticado e com step-up (§1.5) — e enquanto ele não existir,
-- nenhum caminho da API consegue alterar `usuarios.email`. A policy
-- `usuario_proprio` de 0001 limita a linha; o GRANT por coluna limita o campo.
GRANT UPDATE (nome, senha_hash, senha_atualizada_em, mfa_segredo_cifrado,
              mfa_kek_versao, mfa_ativado_em, mfa_ultimo_passo, ultimo_acesso_em)
  ON usuarios TO mavia_app;

-- ATENÇÃO — sem esta policy, o GRANT acima é uma escalada de privilégio.
-- A policy `usuario_proprio` de 0001 é:
--     id = app.usuario_id OR EXISTS (vínculo no mesmo tenant)
-- Ela foi escrita para LEITURA (mostrar o nome dos membros do espaço). Como ela
-- não tem WITH CHECK, o Postgres reusa o USING como check no UPDATE — e o ramo
-- do EXISTS passaria a autorizar um `membro` a escrever `senha_hash` de OUTRO
-- membro do mesmo tenant. RESTRICTIVE porque policies restritivas são
-- combinadas por AND: esta corta o ramo do EXISTS sem alterar a leitura.
CREATE POLICY usuario_escreve_so_a_propria_linha ON usuarios
  AS RESTRICTIVE FOR UPDATE TO mavia_app
  USING      (id = nullif(current_setting('app.usuario_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.usuario_id', true), '')::uuid);
```

### 6.5 O SQL — migration 0003 (sessões)

```sql
-- 0003 — Sessões, famílias de refresh e detecção de reuso.
--
-- Implementa docs/produto/spec-autenticacao.md §4 e sistema.md §3.1/§3.9.

CREATE TYPE plataforma_de_sessao AS ENUM ('web', 'mobile');

CREATE TABLE sessoes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id          UUID NOT NULL REFERENCES usuarios (id),
  -- A família é o login. Rotacionar o refresh cria linha nova na MESMA família;
  -- detectar reuso revoga a família inteira, não só a linha (sistema.md §3.1).
  familia_id          UUID NOT NULL,
  refresh_hash        BYTEA NOT NULL,          -- SHA-256 de 256 bits de CSPRNG
  geracao             INTEGER NOT NULL DEFAULT 1,
  substituida_por     UUID REFERENCES sessoes (id),
  plataforma          plataforma_de_sessao NOT NULL,
  dispositivo         TEXT,                    -- rótulo legível, nunca o user agent cru
  ip_hash             BYTEA,                   -- pepper no guardião (A-39)
  user_agent_hash     BYTEA,
  -- Marca o instante em que o segundo fator foi apresentado NESTE login. É o
  -- que permite a M-2 sem consultar o Redis.
  mfa_verificada_em   TIMESTAMPTZ,
  criada_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_uso_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em           TIMESTAMPTZ NOT NULL,    -- deslizante
  expira_absoluto_em  TIMESTAMPTZ NOT NULL,    -- teto; nunca estendido
  revogada_em         TIMESTAMPTZ,
  motivo_revogacao    TEXT,

  CONSTRAINT deslizante_nao_passa_do_absoluto CHECK (expira_em <= expira_absoluto_em)
);

CREATE UNIQUE INDEX sessao_por_refresh ON sessoes (refresh_hash);
CREATE INDEX sessoes_vivas_por_usuario ON sessoes (usuario_id, expira_em)
  WHERE revogada_em IS NULL;
CREATE INDEX sessoes_por_familia ON sessoes (familia_id);
-- Purga da retenção: sessoes.* vive 90 dias após expirar ou ser revogada
-- (retencao-e-eliminacao.md §3.1). A janela existe para investigar reuso.
CREATE INDEX sessoes_para_purga ON sessoes (expira_absoluto_em);

ALTER TABLE sessoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessoes FORCE  ROW LEVEL SECURITY;
CREATE POLICY sessao_do_usuario ON sessoes
  USING      (usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid)
  WITH CHECK (usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid);

-- Pós-autenticação, mavia_app opera as próprias sessões sob a policy acima:
-- GET /auth/sessoes, DELETE /auth/sessoes/:id, revogar-todas, rotação.
-- A LEITURA pré-autenticação (resolver o refresh apresentado) NÃO passa por
-- aqui — passa por auth.resolver_sessao, em 0004. Ver §4.2.
GRANT SELECT, INSERT, UPDATE ON sessoes TO mavia_app;
```

### 6.6 O SQL — migration 0004 (cadastro: papel, policies e funções)

**É esta migration que fecha a lacuna.**

```sql
-- 0004 — O caminho de cadastro.
--
-- Fecha a lacuna registrada no fim de apps/api/test/rls.test.ts.
--
-- A decisão que esta migration materializa: `mavia_app` NÃO recebe INSERT em
-- `tenants`. Ele recebe EXECUTE em funções estreitas, de propriedade de um
-- papel que não tem BYPASSRLS, e que impõem no BANCO os invariantes que a
-- aplicação não pode ser a única a lembrar:
--   (a) tenant nunca nasce sem proprietário;
--   (b) tenant nunca nasce de um e-mail não provado;
--   (c) o teto de tenants por usuário existe mesmo se um guard falhar.

-- ---------------------------------------------------------------------------
-- O papel dono das funções
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mavia_auth') THEN
    CREATE ROLE mavia_auth NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- mavia_migrate precisa ser membro de mavia_auth para poder transferir a
-- propriedade das funções. Sem a transferência, elas nasceriam pertencendo a
-- mavia_migrate — que TEM BYPASSRLS — e cada SECURITY DEFINER viraria um
-- buraco irrestrito na RLS. Este é o detalhe que anularia a migration inteira
-- em silêncio.
GRANT mavia_auth TO mavia_migrate;

CREATE SCHEMA auth;
-- O esquema pertence a `mavia_auth`, e não a quem roda a migration. Não é
-- estética: `ALTER FUNCTION … OWNER TO mavia_auth` exige que o novo dono tenha
-- CREATE no esquema que contém a função — sem isto, a transferência de
-- propriedade abaixo falha com "permission denied for schema auth", e a
-- tentação seria removê-la, que é exatamente o erro que ela existe para evitar.
-- `mavia_migrate` continua podendo criar aqui por ser membro de `mavia_auth`.
ALTER SCHEMA auth OWNER TO mavia_auth;
GRANT USAGE ON SCHEMA auth TO mavia_app;

-- ---------------------------------------------------------------------------
-- Policies para mavia_auth
-- ---------------------------------------------------------------------------
-- Policies são por papel (cláusula TO). mavia_auth NÃO é dono das tabelas,
-- então o FORCE de 0001 não se aplica a ele e a RLS comum vale: o que ele pode
-- é exatamente o que estas policies dizem, e nada mais.
--
-- O `USING (true)` não é frouxidão: a contenção deste caminho é a SUPERFÍCIE
-- DAS FUNÇÕES — nenhuma devolve conjunto, nenhuma aceita lista, mavia_auth é
-- NOLOGIN e ninguém mais tem EXECUTE. Amarrar as policies a um GUC seria pior:
-- o GUC é definível por quem chama.
CREATE POLICY cadastro_le_usuarios   ON usuarios        FOR SELECT TO mavia_auth USING (true);
CREATE POLICY cadastro_cria_usuarios ON usuarios        FOR INSERT TO mavia_auth WITH CHECK (true);
CREATE POLICY cadastro_atualiza_usuarios ON usuarios    FOR UPDATE TO mavia_auth
  USING (true) WITH CHECK (true);

CREATE POLICY cadastro_le_tenants    ON tenants         FOR SELECT TO mavia_auth USING (true);
CREATE POLICY cadastro_cria_tenants  ON tenants         FOR INSERT TO mavia_auth WITH CHECK (true);

CREATE POLICY cadastro_le_vinculos   ON tenant_usuarios FOR SELECT TO mavia_auth USING (true);
CREATE POLICY cadastro_cria_vinculos ON tenant_usuarios FOR INSERT TO mavia_auth WITH CHECK (true);

CREATE POLICY cadastro_le_sessoes    ON sessoes         FOR SELECT TO mavia_auth USING (true);
CREATE POLICY cadastro_le_identidades ON identidades_federadas FOR SELECT TO mavia_auth USING (true);
CREATE POLICY cadastro_cria_identidades ON identidades_federadas FOR INSERT TO mavia_auth WITH CHECK (true);
CREATE POLICY cadastro_opera_pendentes ON cadastros_pendentes FOR ALL TO mavia_auth
  USING (true) WITH CHECK (true);
CREATE POLICY cadastro_opera_recuperacoes ON recuperacoes_senha FOR ALL TO mavia_auth
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON usuarios              TO mavia_auth;
GRANT SELECT, INSERT         ON tenants               TO mavia_auth;
GRANT SELECT, INSERT         ON tenant_usuarios       TO mavia_auth;
GRANT SELECT                 ON sessoes               TO mavia_auth;
GRANT SELECT, INSERT         ON identidades_federadas TO mavia_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON cadastros_pendentes TO mavia_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON recuperacoes_senha  TO mavia_auth;

-- ---------------------------------------------------------------------------
-- Funções — nenhuma devolve conjunto
-- ---------------------------------------------------------------------------
-- `SET search_path = pg_catalog, public` em TODAS: sem isso, quem controla o
-- search_path da sessão redireciona uma chamada de dentro da função para um
-- objeto que ele mesmo criou, e SECURITY DEFINER vira escalada de privilégio.

CREATE FUNCTION auth.buscar_credencial(p_email TEXT)
RETURNS TABLE (usuario_id UUID, senha_hash TEXT, mfa_ativo BOOLEAN, tem_identidade BOOLEAN)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.senha_hash, u.mfa_ativado_em IS NOT NULL,
         EXISTS (SELECT 1 FROM identidades_federadas i WHERE i.usuario_id = u.id)
    FROM usuarios u
   WHERE lower(u.email) = lower(p_email) AND u.deleted_at IS NULL
   LIMIT 1;
$$;

-- Entrada é o hash exato do refresh apresentado. Não existe assinatura que
-- aceite usuario_id: com ela, um bug de aplicação listaria as sessões alheias.
CREATE FUNCTION auth.resolver_sessao(p_refresh_hash BYTEA)
RETURNS TABLE (sessao_id UUID, usuario_id UUID, familia_id UUID, geracao INTEGER,
               expira_em TIMESTAMPTZ, expira_absoluto_em TIMESTAMPTZ,
               revogada_em TIMESTAMPTZ, mfa_verificada_em TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.usuario_id, s.familia_id, s.geracao, s.expira_em,
         s.expira_absoluto_em, s.revogada_em, s.mfa_verificada_em
    FROM sessoes s
   WHERE s.refresh_hash = p_refresh_hash
   LIMIT 1;
$$;

-- `POST /auth/registrar`. Não cria usuário, não cria tenant: é a camada 1 do
-- teto de §6.3. Devolve `false` quando o endereço já é de um usuário — e a
-- rota responde EXATAMENTE a mesma coisa nos dois casos (A-13).
CREATE FUNCTION auth.registrar_pendente(
  p_email TEXT, p_nome TEXT, p_senha_hash TEXT, p_token_hash BYTEA, p_expira_em TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM usuarios u
              WHERE lower(u.email) = lower(p_email) AND u.deleted_at IS NULL) THEN
    RETURN FALSE;
  END IF;

  -- Reemitir para o mesmo endereço substitui o pendente anterior em vez de
  -- acumular: mil requisições geram um registro e um e-mail, não mil.
  DELETE FROM cadastros_pendentes
   WHERE lower(email) = lower(p_email) AND consumido_em IS NULL;

  INSERT INTO cadastros_pendentes (email, nome, senha_hash, token_hash, expira_em)
  VALUES (p_email, p_nome, p_senha_hash, p_token_hash, p_expira_em);
  RETURN TRUE;
END;
$$;

-- `POST /auth/senha/recuperar`. A regra D5 mora AQUI, e não na aplicação:
-- conta sem `senha_hash` não recebe token, ponto. É a trava que impede que a
-- recuperação vire a porta dos fundos da recusa de vinculação de C5 (§1.6).
CREATE FUNCTION auth.emitir_recuperacao(
  p_email TEXT, p_token_hash BYTEA, p_expira_em TIMESTAMPTZ, p_ip_hash BYTEA)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_usuario UUID; v_vivos INTEGER;
BEGIN
  SELECT u.id INTO v_usuario FROM usuarios u
   WHERE lower(u.email) = lower(p_email)
     AND u.deleted_at IS NULL
     AND u.senha_hash IS NOT NULL;     -- D5
  IF NOT FOUND THEN RETURN FALSE; END IF;

  SELECT count(*) INTO v_vivos FROM recuperacoes_senha r
   WHERE r.usuario_id = v_usuario AND r.consumido_em IS NULL AND r.expira_em > now();
  IF v_vivos >= 3 THEN RETURN FALSE; END IF;

  INSERT INTO recuperacoes_senha (usuario_id, token_hash, expira_em, ip_hash)
  VALUES (v_usuario, p_token_hash, p_expira_em, p_ip_hash);
  RETURN TRUE;
END;
$$;

-- Consome o token e escreve a senha nova na mesma transação. A verificação de
-- MFA (§3.4) acontece ANTES, na aplicação, sob app.usuario_id devolvido por
-- auth.resolver_recuperacao — e é por isso que esta função recebe o token de
-- novo: ela não confia no que a aplicação lembrou entre as duas chamadas.
CREATE FUNCTION auth.concluir_recuperacao(p_token_hash BYTEA, p_senha_hash TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_usuario UUID;
BEGIN
  UPDATE recuperacoes_senha SET consumido_em = now()
   WHERE token_hash = p_token_hash AND consumido_em IS NULL AND expira_em > now()
   RETURNING usuario_id INTO v_usuario;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECUPERACAO_INVALIDA' USING ERRCODE = 'P0001';
  END IF;

  UPDATE usuarios SET senha_hash = p_senha_hash, senha_atualizada_em = now()
   WHERE id = v_usuario AND senha_hash IS NOT NULL;   -- D5, de novo, na escrita
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTA_SEM_SENHA' USING ERRCODE = 'P0001';
  END IF;

  -- Os demais tokens do usuário morrem junto. A revogação das SESSÕES é da
  -- aplicação, sob a policy de app.usuario_id.
  UPDATE recuperacoes_senha SET consumido_em = now()
   WHERE usuario_id = v_usuario AND consumido_em IS NULL;

  RETURN v_usuario;
END;
$$;

-- O fluxo de recuperação é pré-autenticação por definição. Esta função é o que
-- devolve o usuario_id que a aplicação usará no `SET LOCAL app.usuario_id` das
-- etapas seguintes — inclusive a leitura de mfa_codigos_recuperacao, que vive
-- sob policy de app.usuario_id.
CREATE FUNCTION auth.resolver_recuperacao(p_token_hash BYTEA)
RETURNS TABLE (recuperacao_id UUID, usuario_id UUID, expira_em TIMESTAMPTZ,
               consumido_em TIMESTAMPTZ, mfa_ativo BOOLEAN)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT r.id, r.usuario_id, r.expira_em, r.consumido_em,
         u.mfa_ativado_em IS NOT NULL
    FROM recuperacoes_senha r
    JOIN usuarios u ON u.id = r.usuario_id
   WHERE r.token_hash = p_token_hash
   LIMIT 1;
$$;

-- O clique no link de confirmação. Usuário, tenant e vínculo numa transação.
CREATE FUNCTION auth.confirmar_cadastro(p_token_hash BYTEA, p_nome_do_tenant TEXT)
RETURNS TABLE (usuario_id UUID, tenant_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_pendente cadastros_pendentes%ROWTYPE;
  v_usuario  UUID;
  v_tenant   UUID;
BEGIN
  -- FOR UPDATE: dois cliques simultâneos no mesmo link criariam dois tenants.
  SELECT * INTO v_pendente FROM cadastros_pendentes
   WHERE token_hash = p_token_hash AND consumido_em IS NULL AND expira_em > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CADASTRO_INVALIDO' USING ERRCODE = 'P0001';
  END IF;

  -- email_verificado_em nasce preenchido: só chega aqui quem clicou no link.
  INSERT INTO usuarios (email, nome, senha_hash, senha_atualizada_em, email_verificado_em)
  VALUES (v_pendente.email, v_pendente.nome, v_pendente.senha_hash, now(), now())
  RETURNING id INTO v_usuario;

  INSERT INTO tenants (nome) VALUES (p_nome_do_tenant) RETURNING id INTO v_tenant;

  -- Na mesma transação: um tenant nunca existe sem proprietário.
  INSERT INTO tenant_usuarios (tenant_id, usuario_id, papel)
  VALUES (v_tenant, v_usuario, 'proprietario');

  UPDATE cadastros_pendentes SET consumido_em = now() WHERE id = v_pendente.id;

  RETURN QUERY SELECT v_usuario, v_tenant;
END;
$$;

-- Cadastro por Google. Só é chamada no caso C3 da matriz de §2.4 — a decisão
-- de QUAL caso é este é pura e mora em packages/domain/identidade (§8.4).
-- O UNIQUE de (provedor, issuer, subject) e o de lower(email) são o que faz a
-- corrida entre duas requisições simultâneas falhar fechada, e não duplicar.
CREATE FUNCTION auth.cadastrar_federado(
  p_issuer TEXT, p_subject TEXT, p_email TEXT, p_nome TEXT, p_nome_do_tenant TEXT)
RETURNS TABLE (usuario_id UUID, tenant_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_usuario UUID; v_tenant UUID;
BEGIN
  INSERT INTO usuarios (email, nome, email_verificado_em)
  VALUES (p_email, p_nome, now())
  RETURNING id INTO v_usuario;

  INSERT INTO identidades_federadas
    (usuario_id, provedor, issuer, subject, email_no_provedor,
     email_verificado_no_provedor, ultimo_login_em)
  VALUES (v_usuario, 'google', p_issuer, p_subject, p_email, TRUE, now());

  INSERT INTO tenants (nome) VALUES (p_nome_do_tenant) RETURNING id INTO v_tenant;
  INSERT INTO tenant_usuarios (tenant_id, usuario_id, papel)
  VALUES (v_tenant, v_usuario, 'proprietario');

  RETURN QUERY SELECT v_usuario, v_tenant;
END;
$$;

-- POST /tenants (matriz §3.2). O teto vive AQUI, e não só no guard: um teto
-- que existe só na aplicação é um teto que a próxima rota esquece.
CREATE FUNCTION auth.criar_tenant(p_usuario_id UUID, p_nome TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_no_dia INTEGER; v_ativos INTEGER; v_tenant UUID;
BEGIN
  SELECT count(*) FILTER (WHERE t.criado_em > now() - interval '1 day'),
         count(*)
    INTO v_no_dia, v_ativos
    FROM tenant_usuarios tu
    JOIN tenants t ON t.id = tu.tenant_id
   WHERE tu.usuario_id = p_usuario_id
     AND tu.papel = 'proprietario'
     AND t.deleted_at IS NULL;

  IF v_no_dia >= 3  THEN RAISE EXCEPTION 'TETO_DIARIO_DE_TENANTS'  USING ERRCODE = 'P0001'; END IF;
  IF v_ativos >= 10 THEN RAISE EXCEPTION 'TETO_DE_TENANTS_ATIVOS'  USING ERRCODE = 'P0001'; END IF;

  INSERT INTO tenants (nome) VALUES (p_nome) RETURNING id INTO v_tenant;
  INSERT INTO tenant_usuarios (tenant_id, usuario_id, papel)
  VALUES (v_tenant, p_usuario_id, 'proprietario');
  RETURN v_tenant;
END;
$$;

-- ---------------------------------------------------------------------------
-- Propriedade e EXECUTE
-- ---------------------------------------------------------------------------
-- A transferência de propriedade é o que impede que estas funções rodem com o
-- BYPASSRLS de mavia_migrate. Sem ela, tudo acima é decoração.
ALTER FUNCTION auth.buscar_credencial(TEXT)                       OWNER TO mavia_auth;
ALTER FUNCTION auth.resolver_sessao(BYTEA)                        OWNER TO mavia_auth;
ALTER FUNCTION auth.resolver_recuperacao(BYTEA)                   OWNER TO mavia_auth;
ALTER FUNCTION auth.registrar_pendente(TEXT, TEXT, TEXT, BYTEA, TIMESTAMPTZ) OWNER TO mavia_auth;
ALTER FUNCTION auth.emitir_recuperacao(TEXT, BYTEA, TIMESTAMPTZ, BYTEA)      OWNER TO mavia_auth;
ALTER FUNCTION auth.concluir_recuperacao(BYTEA, TEXT)             OWNER TO mavia_auth;
ALTER FUNCTION auth.confirmar_cadastro(BYTEA, TEXT)               OWNER TO mavia_auth;
ALTER FUNCTION auth.cadastrar_federado(TEXT, TEXT, TEXT, TEXT, TEXT) OWNER TO mavia_auth;
ALTER FUNCTION auth.criar_tenant(UUID, TEXT)                      OWNER TO mavia_auth;

-- PUBLIC recebe EXECUTE por padrão em toda função criada. Revogar não é zelo:
-- sem isso, mavia_jobs também poderia criar tenants.
REVOKE ALL ON FUNCTION auth.buscar_credencial(TEXT)                       FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.resolver_sessao(BYTEA)                        FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.resolver_recuperacao(BYTEA)                   FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.registrar_pendente(TEXT, TEXT, TEXT, BYTEA, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.emitir_recuperacao(TEXT, BYTEA, TIMESTAMPTZ, BYTEA)      FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.concluir_recuperacao(BYTEA, TEXT)             FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.confirmar_cadastro(BYTEA, TEXT)               FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.cadastrar_federado(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.criar_tenant(UUID, TEXT)                      FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth.buscar_credencial(TEXT)                       TO mavia_app;
GRANT EXECUTE ON FUNCTION auth.resolver_sessao(BYTEA)                        TO mavia_app;
GRANT EXECUTE ON FUNCTION auth.resolver_recuperacao(BYTEA)                   TO mavia_app;
GRANT EXECUTE ON FUNCTION auth.registrar_pendente(TEXT, TEXT, TEXT, BYTEA, TIMESTAMPTZ) TO mavia_app;
GRANT EXECUTE ON FUNCTION auth.emitir_recuperacao(TEXT, BYTEA, TIMESTAMPTZ, BYTEA)      TO mavia_app;
GRANT EXECUTE ON FUNCTION auth.concluir_recuperacao(BYTEA, TEXT)             TO mavia_app;
GRANT EXECUTE ON FUNCTION auth.confirmar_cadastro(BYTEA, TEXT)               TO mavia_app;
GRANT EXECUTE ON FUNCTION auth.cadastrar_federado(TEXT, TEXT, TEXT, TEXT, TEXT) TO mavia_app;
GRANT EXECUTE ON FUNCTION auth.criar_tenant(UUID, TEXT)                      TO mavia_app;

-- `mavia_app` continua SEM INSERT em tenants, usuarios e tenant_usuarios.
-- Esta ausência é o ponto da migration e é verificada por teste (AB-40).
```

### 6.6a O SQL das §6.4–6.6 foi executado, não apenas escrito

Contra PostgreSQL 17 real, num banco descartável, aplicando `0001_fundacao.sql` e as três migrations em sequência sob um papel com `BYPASSRLS` — reproduzindo a condição de produção. O que a execução provou, e o que ela **corrigiu**:

| Verificação | Resultado |
|---|---|
| As três migrations aplicam limpas sobre a 0001 | ✅ |
| As nove funções: `prosecdef = true`, `proowner = mavia_auth`, `proconfig` com `search_path`, `PUBLIC` sem `EXECUTE`; `mavia_auth` com `rolbypassrls = false`, `rolcanlogin = false` | ✅ (`AB-41`) |
| `mavia_app` inserindo em `tenants`, `usuarios`, `tenant_usuarios` | ✅ `permission denied` nas três (`AB-40`) |
| `registrar_pendente` → `confirmar_cadastro` | ✅ um usuário, um tenant, um `proprietario`, numa transação |
| `emitir_recuperacao` para conta federada sem senha | ✅ devolve `false` e **não grava linha** (`AB-32`, D5) |
| `registrar_pendente` para e-mail já existente | ✅ `false`, nenhum pendente vivo |
| Quarta chamada a `criar_tenant` no mesmo dia | ✅ `TETO_DIARIO_DE_TENANTS` (`AB-39`) |
| `resolver_sessao` com hash aleatório | ✅ zero linhas (`AB-42`) |
| **Membro escrevendo `senha_hash` de outro membro do mesmo tenant** | ✅ `UPDATE 0` — e o mesmo membro **enxerga** a linha (`SELECT` devolve 1), que é exatamente a assimetria que a policy restritiva existe para criar (`AB-51`, `AT-18`) |
| Membro alterando a própria coluna `email` | ✅ `permission denied for table usuarios` (grant por coluna) |

**Um defeito real foi encontrado assim, e está corrigido acima:** `ALTER FUNCTION … OWNER TO mavia_auth` falhava com `permission denied for schema auth`, porque o Postgres exige que o novo dono tenha `CREATE` no esquema. Escrito e nunca executado, o remédio óbvio teria sido remover a transferência de propriedade — e as nove funções passariam a rodar com o `BYPASSRLS` de `mavia_migrate`, anulando em silêncio a garantia inteira do ADR 0004. A correção é `ALTER SCHEMA auth OWNER TO mavia_auth`.

### 6.7 O que o cadastro cria, e o que ele não cria

O primeiro tenant nasce com `nome` proposto pelo produto (o primeiro nome da pessoa, editável), `moeda_base = 'BRL'` e `timezone = 'America/Sao_Paulo'` (o `CHECK` de 0001 não admite outro valor hoje). **O cadastro não cria conta, cartão nem categoria** — isso é o Onboarding (`arquitetura-informacao.md` §2.15), que já existe e é a próxima tela. As categorias de sistema (`Sem categoria` por natureza, `Ajuste de saldo`) são semeadas na mesma transação do tenant, porque `CONTEXT.md` as declara destino obrigatório e um tenant sem elas tem um estado inválido representável.

---

## 7. Resolução de tenant

### 7.1 As quatro etapas continuam intactas

`sistema.md` §3.9 já as fixa e este spec **não as altera**:

1. Autentica e obtém `usuario_id` do token.
2. Abre transação com `SET LOCAL app.usuario_id`, **sem** `app.tenant_id`.
3. Consulta `tenant_usuarios` sob a policy de `app.usuario_id` para obter papel e pertencimento.
4. **Se e somente se** houver linha, define `app.tenant_id` e o papel no `TenantContext`.

O que este spec acrescenta é o que vem **antes** da etapa 1 e o que acontece **no primeiro acesso**.

### 7.2 Antes da etapa 1

O access token opaco é resolvido no Redis (`sess:<hash>`); miss → 401. O token **não carrega `tenant_id`**, e isso é decisão, não omissão: um token com tenant embutido faria a troca de espaço exigir token novo, faria `GET /tenants` e `POST /tenants` viverem fora do modelo, e transformaria o token em segunda fonte de verdade sobre pertencimento — que é exatamente a forma do IDOR que R-3 da matriz fechou para o path da URL.

**Custo:** a etapa 3 é uma consulta por requisição. **Mitigação:** cache em Redis de `(usuario_id, tenant_id) → papel`, TTL **60 s**, invalidado em qualquer escrita em `tenant_usuarios`. O TTL é o mesmo orçamento de propagação que a matriz já usa para revogação ("efeito ≤ 60 s"), e não inventa um número novo.

### 7.3 Primeiro acesso, e o usuário com exatamente um tenant

`sistema.md` §3.9 diz: *"Ausência de `X-Mavia-Tenant` com múltiplos tenants é 400, nunca escolha implícita do primeiro."* Ele é silencioso sobre um tenant só. **A decisão é: 400 também.**

Razão: um caminho que escolhe implicitamente quando há um tenant é um caminho que **passa a estar errado no dia em que a pessoa aceita o convite para um segundo espaço** — e esse dia chega sem que ninguém toque no código de autenticação. Ele também produz dois modos de operação para o mesmo endpoint, e o modo raro é o que ninguém testa. Um caminho só, sempre explícito.

**Como isso não custa uma volta de rede.** As três rotas que não exigem tenant devolvem a lista:

| Rota sem tenant | Devolve |
|---|---|
| `POST /auth/entrar` · `POST /auth/google/concluir` · `POST /auth/refresh` | Tokens **e** `tenants: [{ id, nome, papel }]` |
| `GET /auth/eu` | Identidade própria + tenants + papel em cada (matriz §3.1) |
| `GET /tenants` · `POST /tenants` | Espaços do usuário |

Então o cliente já sai do login com o valor do header. Sequência do primeiro acesso: `POST /auth/entrar` → resposta traz um tenant → cliente guarda o id → toda requisição seguinte leva `X-Mavia-Tenant`. Zero volta extra, e o cliente com dois espaços usa exatamente o mesmo código.

**A lista de rotas que operam sem `app.tenant_id` é fechada e declarada:** tudo sob `/v1/auth/*`, mais `GET /tenants` e `POST /tenants`. Rota nova fora dessa lista que não exija tenant é mudança de desenho, não detalhe de implementação. Header com tenant não pertencente continua **403 sem troca de contexto**, como §3.9 manda.

---

## 8. Modelo de ameaças e casos de abuso

### 8.1 O que um atacante tentaria aqui

| ID | Ameaça | Controle |
|---|---|---|
| `AT-01` | **Credential stuffing** com listas de vazamentos | `RL-AUTH` (5/15 min por e-mail, 20/15 min por IP), atraso 0/1/2/4/8 s, bloqueio 15 min, lista local de senhas vazadas no cadastro, MFA disponível |
| `AT-02` | **Enumeração de contas** por `registrar`, `entrar`, `recuperar` | Resposta e tempo idênticos (±50 ms), verificação Argon2 fantasma, mensagem genérica única |
| `AT-03` | **Pre-account hijack** — registrar com o e-mail da vítima antes dela e esperar o login federado vincular | **V-1** (§2.2): vinculação exige prova da credencial existente. Além disso, o cadastro por e-mail só cria usuário **após** o clique no link, que vai para a caixa da vítima |
| `AT-04` | **Reatribuição de endereço corporativo** — o sucessor de `ana@empresa.com` entra e assume o espaço de Ana | **C5** (§2.4) recusa; **D5** (§3.4) impede a rota alternativa pela recuperação de senha; §2.7 fecha o canal humano |
| `AT-05` | **Forja de `id_token`** — `alg: none`, `HS256` com o `client_secret`, `iss`/`aud` errados, token de outro cliente | Validação de §1.1, com allowlist de algoritmo antes da verificação de assinatura |
| `AT-06` | **Injeção de código de autorização / CSRF no retorno** | `state` de 256 bits, servidor, uso único; `nonce` ligado ao `state`; PKCE S256; `redirect_uri` por igualdade exata |
| `AT-07` | **Roubo do refresh token** (backup do dispositivo, XSS, cópia de cookie) | Rotação a cada uso + detecção de reuso + revogação da família; `__Host-`/`HttpOnly` no web; Keychain `THIS_DEVICE_ONLY` no mobile; teto absoluto |
| `AT-08` | **Recuperação como bypass de MFA** | O consumo do token exige TOTP ou código de recuperação (§3.4) |
| `AT-09` | **Recuperação criando senha em conta federada** | D5: conta sem `senha_hash` não recebe token |
| `AT-10` | **Sequestro de inscrição de MFA** por sessão roubada | Step-up para inscrever; notificação ao titular; `DELETE /auth/mfa` exige o próprio MFA |
| `AT-11` | **Criação em massa de tenants** (custo de disco, spam, abuso de cota) | As quatro camadas de §6.3, com a camada 1 sendo estrutural |
| `AT-12` | **Escalada por `SECURITY DEFINER`** — `search_path` sequestrado, ou função herdando `BYPASSRLS` do dono | `SET search_path` em toda função; `OWNER TO mavia_auth`; `mavia_auth` é `NOLOGIN NOBYPASSRLS`; `REVOKE … FROM PUBLIC` |
| `AT-13` | **DoS por Argon2** — laço de logins esgotando a memória da VPS | Semáforo de 4 verificações simultâneas + `RL-AUTH` antes de alocar |
| `AT-14` | **Vazamento por log e telemetria** — `id_token`, refresh, e-mail completo, `state` | Mascaramento na borda do logger (regra 20); R-5 da matriz vale para os campos novos; nenhum rótulo de métrica recebe e-mail ou `usuario_id` (A-07) |
| `AT-15` | **Comprometimento da Conta Google** vira comprometimento da Mavia | MFA da Mavia é independente do Google (M-5) e é exigido em `POST /conexoes` e `POST /chaves-api` (M-3) |
| `AT-16` | **Fixação de sessão** — a sessão sobrevive à troca de credencial | Troca e redefinição de senha revogam todas as sessões; a redefinição **não** autentica |
| `AT-18` | **Escrita em credencial de co-membro** — a policy `usuario_proprio` de 0001 casa também com membros do mesmo tenant, e um `GRANT UPDATE` ingênuo transformaria isso em "trocar a senha do outro" | Policy **restritiva** `usuario_escreve_so_a_propria_linha` + `GRANT UPDATE` por coluna (§6.4). É a razão pela qual `email` ficou fora da lista de colunas |
| `AT-17` | **Tenant confuso** — token de um espaço usado noutro | O token não carrega tenant; a etapa 3 é reexecutada por requisição; header de tenant alheio é 403 |

### 8.2 Casos de abuso — para o `engenheiro-qa-automacao`

Mesmo formato e mesma numeração contínua da `matriz-de-acesso.md` §8, que termina em `AB-28`. **Todos cabem nos seams existentes. Nenhum seam novo.**

| ID | Caso | Regra que prova | Seam |
|---|---|---|---|
| `AB-29` | Atacante registra `vitima@x.com` com senha; a vítima entra pelo Google com o mesmo endereço → **não vincula**, exige a senha; sem a senha, não entra | V-1 / AT-03 | S2 |
| `AB-30` | `id_token` válido em tudo, com `email_verified: false` → recusa; **nenhuma** consulta por e-mail é emitida | D3 / §2.3 | S2 |
| `AB-31` | `sub` novo, e-mail verificado igual ao de uma identidade Google existente com **outro** `sub` → recusa com a mensagem genérica, **indistinguível** da recusa de `email_verified: false` | C5 / AT-04 | S2 |
| `AB-32` | `POST /auth/senha/recuperar` para conta **sem** `senha_hash` → resposta idêntica à do caso comum; **nenhum** token gravado em `recuperacoes_senha` | D5 / AT-09 | S2 |
| `AB-33` | Recuperação concluída em conta com MFA sem apresentar TOTP → recusada; concluída com TOTP → todas as sessões revogadas e a pessoa **não** fica autenticada | AT-08 / AT-16 | S2 |
| `AB-34` | Refresh já rotacionado é apresentado de novo → **toda a família** revogada, entrada em `auditoria` com `classe = 'seguranca'`, notificação emitida | AT-07 | S2 |
| `AB-35` | `POST /auth/sessoes/revogar-todas`; o access token antigo é usado em seguida → 401 **imediato** | §4.1, §4.3 | S2 |
| `AB-36` | `id_token` com `alg: none`; com `HS256` assinado pelo `client_secret`; com `aud` de outro cliente; com `nonce` de outro fluxo → recusa nos quatro, sem criar sessão | AT-05 | S2 |
| `AB-37` | Retorno do Google com `state` ausente, expirado, ou de outro fluxo → recusa; `state` reapresentado → recusa (uso único) | AT-06 | S2 |
| `AB-38` | 4 cadastros do mesmo IP na mesma hora → o 4º é 429; **`tenants` não ganhou nenhuma linha** em nenhuma das quatro tentativas antes do clique no link | §6.3 camadas 1 e 2 / AT-11 | S2 |
| `AB-39` | `auth.criar_tenant` chamada 4 vezes **direto no banco**, sem passar pela rota → a 4ª levanta `TETO_DIARIO_DE_TENANTS` | §6.3 camada 4 | S2 (suíte de `rls.test.ts`) |
| `AB-40` | `mavia_app` tenta `INSERT` direto em `tenants`, `usuarios` e `tenant_usuarios` → **erro de privilégio** nas três | D8 / §6.6 | S2 (`rls.test.ts`) |
| `AB-41` | Toda função de `auth` tem `proowner = mavia_auth`, `prosecdef = true`, `proconfig` com `search_path`, e `mavia_auth.rolbypassrls = false`; `PUBLIC` não tem `EXECUTE` em nenhuma | AT-12 | S2 (`rls.test.ts`) |
| `AB-42` | `auth.resolver_sessao` com um hash aleatório → zero linhas; a assinatura da função **não aceita** `usuario_id` (verificado em `pg_proc`) | §4.2 | S2 (`rls.test.ts`) |
| `AB-43` | Usuário com **exatamente um** tenant chama `GET /lancamentos` sem `X-Mavia-Tenant` → **400**, nunca 200 | D9 / §7.3 | S2 |
| `AB-44` | Conta com MFA ativo tenta step-up apresentando **só a senha** → recusado; `DELETE /auth/mfa` sem apresentar MFA → recusado | M-2 / §5.3 | S2 |
| `AB-45` | Conta **só federada** faz step-up: senha não existe, TOTP não existe → o único caminho aceito é reautenticação no Google com `auth_time` ≤ 120 s | §5.3 | S2 |
| `AB-46` | `POST /conexoes` e `POST /chaves-api` por usuário sem MFA → recusa com código que leva à inscrição, nunca 403 seco | M-3 | S2 |
| `AB-47` | Nenhuma resposta de `/auth/*` contém `senha_hash`, `refresh_hash`, `mfa_segredo_cifrado`, `id_token`, `code`, `state` ou o refresh em corpo JSON no web | R-5 da matriz / AT-14 | **S4** + parse dentro de S2 |
| `AB-48` | Senha de 11 caracteres, senha na lista de vazadas, senha igual ao e-mail → recusadas; senha de 12 caracteres com espaços e emoji → aceita, e o login seguinte funciona (prova a normalização NFKC e a ausência de truncamento) | §3.3 | **S1** (política pura) + S2 |
| `AB-49` | Login com e-mail inexistente e com e-mail existente e senha errada → diferença de tempo dentro de ±50 ms em 100 amostras | AT-02 | S2 |
| `AB-50` | Dois cliques simultâneos no mesmo link de confirmação → **um** usuário e **um** tenant; a segunda chamada falha | §6.6 (`FOR UPDATE`) | S2 (`rls.test.ts`) |
| `AB-51` | `membro` A, sob `app.usuario_id` dele e no tenant compartilhado, tenta `UPDATE usuarios SET senha_hash = … WHERE id = <B>` → **zero linhas afetadas**. E `UPDATE usuarios SET email = …` sobre a própria linha → **erro de privilégio de coluna** | Policy restritiva + `GRANT` por coluna, §6.4 | S2 (`rls.test.ts`) |

### 8.3 Onde os testes moram — sem seam novo

| Seam | Arquivo | O que observa |
|---|---|---|
| **S1** | `packages/domain/identidade/*.spec.ts` | A matriz de decisão de §2.4 (função pura) e a política de senha de §3.3 |
| **S2** | `apps/api/test/http/auth.spec.ts` | Os fluxos completos: `AB-29` a `AB-38`, `AB-43` a `AB-49` |
| **S2** | `apps/api/test/rls.test.ts` (arquivo existente) | As provas de SQL: `AB-39` a `AB-42`, `AB-50`. **E a "lacuna conhecida" no fim do arquivo é apagada** — ela deixa de existir |
| **S4** | `packages/contracts/test/auth.spec.ts` | `AB-47`: allowlist das respostas de `auth` |
| **S5** | `apps/web/e2e/entrada.spec.ts` | Jornada: cadastro por e-mail → confirmação → Onboarding; e cadastro por Google |
| **S6** | `apps/mobile/.maestro/login.yaml` | Fumaça de login, já prevista em `sistema.md` §2.3 |

**Orçamento de seam desta feature: zero.** O TOTP é verificado em S2 (o teste calcula o código a partir do segredo que a inscrição devolveu) e não em S1, porque `packages/domain` não pode importar `node:crypto` — a regra de dependência de §1 é mais importante do que a conveniência de testar aritmética de TOTP no seam mais alto.

### 8.4 Módulo novo em `packages/domain`

Um só: **`identidade`**.

```
decidirEntradaFederada(
  apresentado: { issuer, subject, emailVerificado, email },
  estado: EstadoDeIdentidade
): DecisaoDeEntrada   // 'entra' | 'cadastra' | 'exige_vinculo' | 'recusa'
```

**Teste da deleção:** sem ele, os seis casos de §2.4 viram uma escada de `if` dentro de um controller, e a diferença entre C4 e C5 — que é a diferença entre "pede a senha" e "entrega a conta de Ana a Beatriz" — passa a depender da ordem das condições no dia em que alguém mexer. Com ele, a diferença é uma tabela de decisão testada com property-based em S1. Muito comportamento consequente atrás de uma função: **módulo profundo**, e paga o aluguel.

`politica-acesso` **não é tocado**: papel × ação × recurso continua sendo dele; identidade é outra pergunta.

---

## 9. LGPD

### 9.1 Receber dado do Google é tratamento de dado pessoal vindo de terceiro

Não é coleta direta do titular, e por isso três coisas precisam estar escritas.

| Item | Decisão |
|---|---|
| **Papéis** | A Mavia é **controladora** do que recebe. O Google **não é operador da Mavia** — ele é fonte, e divulga por autorização do próprio titular na tela de consentimento dele. Não há contrato de operador a firmar, e afirmar que há seria errado |
| **Finalidade** | Uma frase, como manda o §3 do documento de retenção: **identificar e autenticar quem acessa, sem que a pessoa precise criar mais uma senha** |
| **Base legal** | **Execução de contrato (art. 7º V)** para `sub`, `issuer`, `email` e `email_verified` — são o mínimo indispensável para prestar o serviço que a pessoa pediu ao clicar em "entrar com o Google". Para `nome`, também execução de contrato, e ele é **editável e opcional**. O *consentimento* que aparece na tela do Google é a autorização de **divulgação** dada ao Google, não a nossa base de tratamento — confundir as duas produz um registro de base legal que não se sustenta |
| **Minimização (art. 6º III)** | Escopos `openid email profile` e nada mais; `picture` e `hd` **não coletados**; tokens do Google **descartados** na mesma função que os recebeu; `id_token` nunca persistido |
| **Transparência (art. 9º)** | A tela "Dados e privacidade" diz, em português: *"Ao entrar com o Google, recebemos seu identificador de conta, seu e-mail e seu nome. Não recebemos sua senha, e não temos acesso ao seu Gmail, à sua Agenda nem ao seu Drive."* Está no ponto de uso, não enterrado nos termos |

### 9.2 Linhas a acrescentar em `retencao-e-eliminacao.md` §3.1

| Classe | Finalidade | Base legal | Gatilho | Prazo | No vencimento |
|---|---|---|---|---|---|
| `identidades_federadas.subject`, `.issuer` | Reconhecer quem volta pelo mesmo provedor | Execução de contrato (7º V) | Desvinculação, ou eliminação da conta | Vida do vínculo | `apagar` — `DELETE` físico da linha |
| `identidades_federadas.email_no_provedor` | Mostrar por qual conta a pessoa entrou e sustentar a decisão de vinculação | Execução de contrato | Idem | Vida do vínculo | `apagar` com a linha |
| `cadastros_pendentes` (e-mail, nome, hash da senha, hash do token) | Concluir um cadastro cujo e-mail ainda não foi provado | Diligências pré-contratuais (7º V) | Criação | **24 h** | `apagar` — job, e o índice único garante que nada se acumule |
| `recuperacoes_senha` (hash do token, `ip_hash`) | Permitir redefinir a senha e investigar abuso do fluxo | Execução de contrato + legítimo interesse (7º IX) | Consumo ou expiração | **24 h** | `apagar`. O **evento** permanece em `auditoria` com `classe = 'seguranca'`, pelos prazos da §3.5 |
| `usuarios.senha_hash` | *(linha já existente)* | — | — | — | Sem alteração |

`mfa_codigos_recuperacao` e `sessoes.*` **já estão** na §3.1 e não mudam. O teste de §1 daquele documento — "tabela sem entrada na política não compila" — cobre as quatro tabelas novas automaticamente, e é por isso que ele existe.

### 9.3 O que aparece na exportação (art. 18 V)

`identidades_federadas` **entra em `zEscopoExportacao`** (`retencao-e-eliminacao.md` §6.1), com os campos: `provedor`, `issuer`, `subject`, `email_no_provedor`, `vinculado_em`, `ultimo_login_em`.

O `subject` sai, e a decisão merece a justificativa: ele é **dado do titular**, e não é credencial — conhecer um `sub` não autentica ninguém, porque a autenticação exige um `id_token` assinado pelo Google que contenha aquele `sub`. Omiti-lo empobreceria a portabilidade sem ganho de segurança. A regra R-5 da matriz continua valendo integralmente: `senha_hash`, `refresh_hash`, `mfa_segredo_cifrado`, `ip_hash` e `user_agent_hash` **nunca** saem — nem na exportação, nem em resposta de API.

`cadastros_pendentes` e `recuperacoes_senha` **não** entram: quando a exportação é possível, o cadastro já virou usuário e o token de recuperação já morreu. `sessoes` entra com metadado (dispositivo, plataforma, IP mascarado `/24`, criada em, último uso), como `GET /auth/sessoes` já mostra.

### 9.4 O que acontece na eliminação

Acréscimo ao `retencao-e-eliminacao.md` §5.2 (`DELETE /auth/eu`), na lista de **apagados fisicamente**: `identidades_federadas`, `cadastros_pendentes` do mesmo endereço, `recuperacoes_senha`, `mfa_codigos_recuperacao`.

Duas consequências que precisam estar escritas:

1. **Apagar a identidade federada é obrigatório, não zelo.** Se a linha sobrevivesse, o mesmo `sub` reencontraria o `usuario_id` eliminado e ressuscitaria a conta no login seguinte — a eliminação seria desfeita pelo próprio produto, sem ninguém notar.
2. **`eliminacoes_journal` (§5.5 daquele documento) cobre a restauração de backup.** Restaurar o Postgres traria a identidade de volta; o `preflight` que reexecuta a fila de eliminações antes de servir tráfego a apaga de novo. Isso já existe — este spec só depende dele.

O bloqueio da §5.2 (não eliminar quem é o **único `proprietario`** de um tenant com outros membros) vale sem alteração, e agora tem um par: **desvincular a última identidade de uma conta sem senha é recusado** (V-3), pelo mesmo motivo de fundo — não deixar um objeto sem quem responda por ele.

---

## 10. Migrations necessárias

Forward-only, como manda o `CLAUDE.md` §6. Nenhuma edita `0001_fundacao.sql`.

| # | Arquivo | Conteúdo | Épico |
|---|---|---|---|
| **0002** | `0002_identidade.sql` | Colunas de credencial em `usuarios`; `identidades_federadas`; `cadastros_pendentes`; `recuperacoes_senha`; `mfa_codigos_recuperacao`; RLS e policies das quatro; `GRANT` a `mavia_app`. SQL em §6.4 | 1 |
| **0003** | `0003_sessoes.sql` | `sessoes` com `familia_id`, `geracao`, `substituida_por`, teto absoluto; RLS por `app.usuario_id`; índices; `GRANT` a `mavia_app`. SQL em §6.5 | 1 |
| **0004** | `0004_cadastro.sql` | Papel `mavia_auth`; esquema `auth`; policies `TO mavia_auth`; as nove funções `SECURITY DEFINER`; `OWNER TO`; `REVOKE … FROM PUBLIC`; `GRANT EXECUTE` a `mavia_app`. **É a que fecha a lacuna.** SQL em §6.6 | 1 |
| **0005** | `0005_categorias_de_sistema.sql` | Semeadura de `Sem categoria` (uma por natureza) e `Ajuste de saldo` dentro da transação de criação do tenant (§6.7) | 1 — **depende da migration de `categorias`**, que não é deste spec. Se `categorias` ainda não existir, 0005 desloca para depois dela e `auth.confirmar_cadastro` ganha a chamada por emenda |

**Fora do escopo deste spec, registrado para não parecer esquecimento:** as colunas de `tenant_usuarios` que a arquitetura §3.1 prevê (`convidado_por`, `aceito_em`, `removido_em`, `termo_versao`) e o `CONSTRAINT TRIGGER` do último `proprietario` (R-4.3 da matriz) pertencem à fatia de **convites e membros**, não à de entrada.

---

## 11. O que este documento **não** decide

Onde a escolha é do dono do produto, ela está aqui e **não** foi tomada por mim. Enquanto não houver decisão, vale o padrão proposto.

| # | Pergunta | Padrão proposto (vigente até haver decisão) | O que muda se a decisão for outra |
|---|---|---|---|
| **DP-23** | MFA é **obrigatório** para todo `proprietario`? | **Não.** Opcional, com step-up nas quatorze operações, e **obrigatório** em `POST /conexoes` e `POST /chaves-api` (M-3) | Obrigatório para todos protege mais e cobra atrito no momento mais frágil da adoção. Se a resposta mudar, muda `M-1` e nasce uma tela de inscrição forçada no Onboarding |
| **DP-24** | Vidas de sessão: web 14/30 dias, mobile 60/180 dias | Os números de §4.3 | São conforto × exposição, não segurança pura. O piso técnico (rotação, família, teto absoluto) não é negociável; os números são |
| **DP-25** | **Não existe canal humano de recuperação.** Quem perde a Conta Google e não tem senha nem MFA na Mavia perde o espaço | Confirmar a posição, e aceitar o custo de suporte e de churn que ela traz | Criar o canal significa construir o vetor de engenharia social mais barato de um produto financeiro, e provavelmente coletar documento — que hoje a §2.2 da retenção proíbe |
| **DP-26** | Quantos tenants um plano permite | Os tetos da matriz (3/dia, 10 ativos) valem para todos | É decisão de **planos** (DP-13), e o teto por plano precisa nascer em `auth.criar_tenant`, não num `if` de aplicação |

Também **não** decido aqui, por serem de outros papéis:

- A **calibragem final** dos parâmetros do Argon2id na VPS de produção — de `sre-devops-vps`, com o número medido, não estimado (§3.1).
- A confirmação da **diretriz 4.8 da App Store** antes da primeira submissão iOS — de `engenheiro-mobile` (§1.4).
- **Passkeys / WebAuthn.** É o sucessor natural de senha e de TOTP, e é fora do MVP. Fica registrado que o modelo de §2 já o acomoda: uma passkey é mais uma credencial que a conta *possui*, e V-1 passa a aceitá-la sem reescrita.
