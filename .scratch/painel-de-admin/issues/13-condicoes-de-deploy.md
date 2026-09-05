# 13 · Condições de deploy do painel

Status: ready-for-agent
Blocked by: 01, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12
Dono sugerido: `sre-devops-vps`

## Objetivo

Reunir as condições que os três revisores classificaram como **bloqueantes de deploy, não de ticket**. Elas não impedem escrever código; impedem o painel alcançar produção. Sem este ticket ficariam órfãs — os doze tickets anteriores implementam a aplicação, e nenhum deles é dono da configuração que a cerca.

**Este ticket não entrega funcionalidade.** Ele entrega a diferença entre "o painel funciona na minha máquina" e "o painel pode ver cliente real".

## As condições

### C-6 · Allowlist de IP ou mTLS à frente de `/admin`, e hostname próprio

**Origem:** achado **S-12** do gate de segurança, e é a condição sob a qual o gate aceitou adiar o MFA.

O raciocínio, na voz do revisor: sem MFA, `/admin` no mesmo host e com o mesmo cookie do produto significa que **um XSS em qualquer tela alcança o painel inteiro**. A allowlist é o único controle do épico que exige do atacante algo que ter a senha não dá.

> **Partida em duas, em 2026-09-05.** A afirmação *"depende do domínio próprio"* valia para uma metade e não para a outra, e mantê-las juntas adiava a barata por causa da cara.

#### C-6a · Allowlist de IP — ✅ **implementada em 2026-09-05, deploy pendente**

**Não depende do domínio.** O compose já roteia por `Host()`, e o middleware `IPAllowList` é configuração **dinâmica**, declarada por label no nosso próprio container — nada a escrever na configuração do Traefik do EasyPanel.

Desenho, medições e o parecer dos dois revisores em **`docs/superpowers/specs/2026-09-05-allowlist-de-ip-do-painel.md`**. O que importa aqui:

- A regra **não** é `PathPrefix('/v1/admin')`, como o handoff supôs — esse caminho o Traefik nunca vê, porque a API não é publicada. Nem `PathPrefix('/admin') || PathPrefix('/api/v1/admin')`, que foi **contornado contra esta produção** por caixa (`/API/...`) e por normalização (`/api//v1/...`). A regra casa **um segmento igual a `admin`**, insensível à caixa.
- O roteador do produto **exclui** os mesmos caminhos, para que o controle falhe **fechado** — sem isso, um CIDR mal digitado faz o roteador do painel sumir e o do produto servir `/admin` sem allowlist.
- mTLS foi descartado por **escopo**, não por qualidade: exige `tls.options`, que é configuração estática do EasyPanel.

**Aceite:** as sondas da §5 do spec, incluindo as negativas por caixa e normalização, e a asserção de **zero linhas no log da API** — que é o critério literal desta condição.

**Ela não fecha a C-6, e não move a DP-32.** Ver abaixo.

#### C-6b · Hostname próprio e escopo de cookie distinto — **aberta, e continua bloqueante**

- Hostname separado (`admin.<domínio>`), com escopo de cookie próprio.
- **Depende do domínio próprio** — ver `docs/o-que-depende-de-voce.md` §1.
- **Item obrigatório de conferência:** a allowlist da C-6a só é válida enquanto o Traefik for o primeiro salto TCP. Um CDN à frente a faz **falhar aberta, sem mudar de cor** — e domínio e CDN chegam no mesmo dia.

É esta metade que responde ao XSS do parágrafo acima: o navegador do operador está num IP permitido por construção, e a allowlist é ortogonal a esse caminho.

### C-7 · Redis: `requirepass` implantado, e a ACL dos cinco prefixos

**Origem:** achado **S-14**, corrigido pelo arquiteto contra o próprio revisor.

O `requirepass` está no repositório e **o deploy está pendente de autorização do dono** — até lá o Redis de produção continua aberto para quem alcança a rede `dados`. A ACL proposta originalmente cobria três prefixos e **desligaria o limite de tentativas de login**. Os cinco em uso:

| Prefixo | Onde |
|---|---|
| `sess:` | `cofre-de-acesso.ts:47` |
| `acessos:` | `cofre-de-acesso.ts:48` |
| `oauth:` | `estado-do-oauth.ts:44` |
| `tentativas:` | `limite-de-tentativas.ts:65` |
| `bull:` | `agendador.ts:32,42` — prefixo padrão do BullMQ |

**Aceite:** a aplicação sobe com a ACL aplicada e um teste exercita os **cinco** caminhos — login, renovação, entrada pelo Google, contador de tentativas e materialização de recorrência. Um caminho que quebre em silêncio é exatamente o defeito que esta condição existe para não repetir.

Junto, duas ressalvas de higiene do mesmo achado: a senha vai em `command:` e aparece em `docker inspect` (preferível arquivo de config montado); e o usuário `default` do Redis mantém `CONFIG SET`, `FLUSHALL` e `KEYS`.

### C-8 · `RL-ADMIN-ABERTURA` com valor numérico, reconciliada com DP-33

**Origem:** achado **S3-5**, mais **S-9**.

Nenhuma classe de rate limit da matriz está implementada — não existe `RL-AUTH`, `RL-LEITURA` nem `RL-ESCRITA` no código. O que existe é o contador de tentativas de credencial. O teto de abertura de espaço precisa de substrato antes de existir, e a chave nova entra na lista do C-7 — passam a ser **seis** prefixos.

O valor numérico é do dono do produto, e conversa com a **DP-33** (por quanto tempo um motivo vale). Uma janela de 30 minutos que reaproveita a hipótese e um teto diário por operador são o mesmo controle puxado em direções opostas; escolher um sem o outro deixa um dos dois inútil.

**Aceite:** N+1 aberturas do mesmo operador na janela respondem 429 **e não gravam linha de abertura**; o contador é por operador, não por rota — abrir dois clientes diferentes soma no mesmo teto.

### C-9 · Papéis nascem `NOLOGIN`; credencial é provisionamento

**Origem:** achado **S3-11**.

O precedente escrito do repositório é perigoso: o único `CREATE ROLE … LOGIN … PASSWORD` versionado tem a senha em claro, e migration é forward-only. Um implementador que leia "LOGIN" na tabela de papéis e siga esse precedente põe uma senha fixa numa migration que roda em produção.

- Os quatro papéis do painel nascem **`NOLOGIN`** na migration, como `mavia_app` já nasce.
- `LOGIN` e senha são **provisionamento**, com dono nomeado, no mesmo lugar onde `mavia_app` recebe a dele.
- `ALTER ROLE … SET statement_timeout` para os quatro — `matriz-de-acesso.md` R-… é normativa nisso, e a rota que mais precisa é `admin.listar_clientes`, que varre a base com termo livre.
- A semente local e o harness de teste ganham as linhas equivalentes.

**Aceite:** `rolcanlogin = false` para os quatro na migration; `statement_timeout` não nulo nos quatro.

### C-10 · A emenda ao `sistema.md` §3.9 — ✅ **feita em 2026-09-04**

`sistema.md` §3.9 passou de duas para **três** exceções nomeadas, o veto 8 acompanha, e o veto 10 carrega a exceção de `/v1/admin/` com as três condições da ADR 0024 D1. A `matriz-de-acesso.md` R-3 idem — e, na mesma passagem, a afirmação falsa de que existia uma regra de lint foi corrigida e **registrada em vez de apagada**.

Fica aqui como item de conferência, não de trabalho: **verifique que continua verdadeiro no dia do deploy.**

### C-11 · `origem_da_ultima_escrita` e a reconciliação com a Stripe

**Origem:** achado **F-15** do validador financeiro, mais **O-8** da LGPD.

Duas metades:

1. **A coluna entra no ticket 08**, agora, e não aqui — porque depois exigiria adivinhar a origem das linhas já escritas.
2. **O comportamento do job depende da DP-39**, que é a única das cinco decisões comerciais **sem padrão vigente**. Sem ela, o painel e o job de reconciliação se desfazem mutuamente todo dia, e o cliente recebe e-mail dizendo que o acesso foi reduzido por uma mudança que a Mavia fez e desfez.

Junto, de **O-8**: duas concessões de admin ativas verificadas no ato do deploy, e a **DP-34** implementada com destino externo. O gatilho do ticket 04 impede *cair* para um; não impede *operar* com um.

**Aceite:** com `origem_da_ultima_escrita = 'painel'`, o job não reverte a linha nem notifica o cliente. E o deploy recusa seguir com menos de duas concessões ativas.

### As de LGPD que também bloqueiam o deploy

| # | O quê | Dono |
|---|---|---|
| **O-5** | Procedimento escrito do art. 18 I e II, com caminho manual auditável que produz a lista de acessos de um titular em até 15 dias | `especialista-lgpd-compliance` escreve; `engenheiro-backend` valida a consulta |
| **O-6** | Política de privacidade com a declaração do acesso de operador, e **o encarregado nomeado e publicado** (art. 41 §2º I) | **Nomear é do dono do produto**; a redação é da especialista |
| **O-7** | Registro nominal do acesso operacional por `psql` no runbook de incidente — é o que sustenta a decisão C-4 e a promessa do texto de consentimento v2 | `sre-devops-vps` |
| **O-9** | O gêmeo anonimizado (**R-31**), antes de o painel **ou** o `DELETE /tenants/:id` alcançarem produção | `engenheiro-backend` |

ROPA e RIPD **não** bloqueiam o deploy: 15 dias depois, com a especialista.

## O que este ticket não faz

Não implementa rota, tela nem migration de aplicação — tudo isso é dos tickets 01 a 12. E não decide **DP-32**, **DP-33**, **DP-34** nem **DP-39**: ele apenas recusa o deploy enquanto a DP-39 estiver aberta, e registra que a DP-32 no padrão vigente significa que **o painel não vê cliente real antes do MFA**.

## Comments

**2026-09-04** — Criado depois dos doze, porque o corte original deixava C-6 a C-11 sem dono e duas asserções da seção de Testes órfãs. Um bloqueio de deploy sem ticket é um bloqueio que alguém descobre no dia do deploy.
