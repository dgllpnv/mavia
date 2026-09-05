# Allowlist de IP à frente do painel — a metade da C-6 que não espera o domínio

**Data:** 2026-09-05 · **Estado:** **aprovado no gate de risco**, aguardando o IP do dono e a autorização de deploy
**Ticket:** `.scratch/painel-de-admin/issues/13-condicoes-de-deploy.md` · **C-6a**
**Origem:** achado S-12 do gate de segurança; §6.1 do spec do painel; DP-32 revista
**Gate:** `especialista-seguranca-appsec` (vetou; veto derrubado) · `sre-devops-vps` (vetou; veto derrubado)

---

## 1 · Por que este documento existe, e os dois erros que ele corrigiu

A **DP-32** diz que a allowlist *"depende do domínio"*. A **C-6** repete isso.
O handoff §5b já registrou que a dependência é falsa — e acertou na conclusão e
**errou no caminho**:

> *"um `IPAllowList` sobre `PathPrefix('/v1/admin')` não precisa de domínio nenhum"*

**`/v1/admin` é um caminho que o Traefik nunca vê.** A API não é publicada: o
único container com `traefik.enable` é o `web`. O navegador chama `/api/v1/...`
na origem do web, e o servidor do Next repassa pela rede interna
(`apps/web/next.config.mjs:86-96`). Uma regra sobre `/v1/admin` casaria com
**zero requisições** — e uma allowlist que não casa com nada é pior do que
allowlist nenhuma, porque parece um controle.

**A primeira versão deste documento errou logo em seguida**, e o erro fica
registrado em vez de apagado: ela propunha
`PathPrefix('/admin') || PathPrefix('/api/v1/admin')`, que **também é
contornável**. A §4 D1 explica como, com medições. Corrigir o caminho do handoff
não bastava; era preciso corrigir o *mecanismo*.

A C-6 se parte em duas, e só uma está aqui:

| | O que é | Espera o domínio? |
|---|---|---|
| **C-6a** | Allowlist de IP à frente do painel | **Não.** É este documento |
| **C-6b** | Hostname próprio (`admin.<domínio>`) e escopo de cookie distinto | **Sim.** Continua aberta e continua bloqueante |

---

## 2 · Os fatos verificados na VPS, não deduzidos

Lidos da produção em 2026-09-05, em modo leitura:

| Fato | Valor | Por que decide alguma coisa |
|---|---|---|
| Versão do Traefik | `traefik:3.6.7` | Em v3 o middleware chama-se **`IPAllowList`**; `IPWhiteList` é v2 e aqui não existe. E o matcher **`PathRegexp`** existe, que é o que a D1 usa |
| Publicação das portas | serviço Swarm `easypanel-traefik`, **`PublishMode: host`** em 80 e 443 | **Era o veto condicional do SRE.** Em `ingress` haveria SNAT e todo cliente chegaria com o endereço da rede de ingresso — a allowlist não filtraria nada e passaria no aceite. Em `host` é DNAT: o IP do cliente é preservado. **Mecanismo viável** |
| Provider Docker | `PROVIDERS_DOCKER=true`, `EXPOSEDBYDEFAULT=false` | Middleware e roteador saem por **label no nosso compose**. Nada a escrever em `/data/config`, que é do EasyPanel e é sobrescrito por ele |
| Cabeçalhos encaminhados | `ENTRYPOINTS_HTTPS_FORWARDEDHEADERS_INSECURE=true` | Configuração **estática**, do EasyPanel: não podemos mudá-la, e ela **restringe** o desenho. É a razão da D2, e um achado próprio — §6 |

---

## 3 · Por que allowlist e não mTLS

A C-6 admite as duas. O escopo na VPS decide: *"não toque em Traefik, firewall,
pacotes do sistema"*.

- **mTLS exige `tls.options`** — configuração **estática**, do provider de
  arquivo do EasyPanel, que orquestra vinte e quatro containers de outros
  negócios. Fora do nosso escopo por decisão do dono.
- **`IPAllowList` é configuração dinâmica**, declarada por label no container que
  já é nosso. Não encosta em nada do EasyPanel.

Não é escolha de qualidade — mTLS é o controle mais forte e sobrevive à troca de
IP. É de escopo. Com domínio e C-6b, mTLS volta a ser opção.

---

## 4 · Decisão

### D1 · A regra casa **um segmento chamado `admin`** — e não um prefixo

```
Host(`${DOMINIO}`) && PathRegexp(`(?i)(^|/)admin(/|$)`)
```

**Por que não o prefixo óbvio.** `PathPrefix('/admin') || PathPrefix('/api/v1/admin')`
foi contornado **contra esta produção**, antes de existir allowlist, por duas
assimetrias que se somam. As medições, todas com `401` — que significa *a
requisição alcançou o controlador do painel*:

| Caminho | Código | Por quê |
|---|---:|---|
| `/api/v1/admin/eu` | 401 | o canônico |
| `/API/v1/admin/eu` | **401** | `PathPrefix` é sensível à caixa; o rewrite do Next **não é** — `"caseSensitive": false` em `.next/routes-manifest.json`, padrão de `experimental.caseSensitiveRoutes` |
| `/aPi/v1/admin/eu` | **401** | idem |
| `/api//v1/admin/eu` | **401** | o Traefik casa o caminho **cru**; quem normaliza `//` é o servidor do Next |
| `/api/./v1/admin/eu` | **401** | idem |
| `/api/x/../v1/admin/eu` | **401** | idem |
| `/api/V1/admin/eu` | 404 | o Fastify é sensível à caixa: só o segmento `/api` é insensível |
| `/api%2Fv1/admin/eu` | 404 | — |

A segunda assimetria não foi vista por nenhum dos dois pareceres do gate; saiu
das sondas de verificação. **Enumerar grafias num prefixo é jogo perdido** —
some sempre uma, e a que some é a que o atacante usa.

Casar **um segmento igual a `admin`** é imune às duas: qualquer grafia que o
Next normalize para uma rota de painel tem esse segmento, em qualquer caixa e
sob qualquer ruído de barra. Verificado contra as vinte sondas.

**O excesso é deliberado e é para o lado seguro.** A regra bloqueia também
`/_next/static/chunks/app/admin/*`, que hoje anuncia a forma do painel — rotas,
nomes de campo, a lógica de nível — a quem quiser ler. Nenhuma rota de produto
tem segmento `admin`: as de topo são `cartoes, categorias, contas, convite,
importar, lancamentos, membros, objetivos, plano, planejamento, relatorios`, e
os segmentos variáveis são UUID ou token. `/administrativo` **não** é
bloqueado — a regra é por segmento, não por prefixo, e é mais precisa que a
versão anterior.

### D1b · O roteador do produto **exclui** o painel, e é isto que faz o controle falhar fechado

```
Host(`${DOMINIO}`) && !PathRegexp(`(?i)(^|/)admin(/|$)`)
```

Emenda obrigatória do `sre-devops-vps`, e ela derruba o veto dele. O raciocínio:

Um `sourceRange` vazio ou malformado impede o Traefik de **construir** o
middleware. Um roteador cuja cadeia de middlewares falhou **não passa a
bloquear — ele deixa de existir**. Sem a negação, os dois roteadores se
sobrepõem, e nesse dia o roteador do produto casa `/admin` e **serve o painel
sem allowlist nenhuma**, com o único sinal sendo uma linha de log num Traefik
que não é nosso.

O modo de falha não seria fechado: seria **desaparecer**. E o gatilho mais
provável é o próprio procedimento de recuperação de lockout da D4 — uma pessoa
só, por SSH, sob pressão, editando um CIDR com `sed`.

Com as regras **disjuntas**, se o painel cai ninguém o serve: 404. Disjunção
também torna `priority` desnecessária — não há empate a desempatar, e uma label
a menos é um acoplamento a menos.

### D2 · `IPAllowList` com a estratégia padrão, e **nunca** `ipStrategy`

`sourceRange` e mais nada. Sem `ipStrategy`, `depth` ou `excludedIPs`.

Confirmado pelo appsec contra a documentação da v3: a estratégia padrão compara
contra o **endereço do socket**, e não olha `X-Forwarded-For`; o header só entra
em jogo se `depth` ou `excludedIPs` forem declarados. `rejectStatusCode` já é
**403** por padrão.

Qualquer `ipStrategy` faria o middleware ler o `X-Forwarded-For` — e a entrada
HTTPS roda com `forwardedHeaders.insecure=true`, o que significa que **o
cabeçalho vem do cliente**. Uma allowlist que lê um cabeçalho que o atacante
escreve atravessa-se com uma linha de `curl`.

> **⚠️ Invariante do primeiro salto.** Isto só vale enquanto o Traefik for o
> primeiro salto TCP. Hoje é — `PublishMode: host`, verificado. **Um CDN ou
> proxy à frente faz o `RemoteAddr` virar o do CDN e a allowlist falha aberta,
> sem mudar de cor.** Domínio próprio e CDN chegam no mesmo cartão de crédito,
> no mesmo dia: item obrigatório de conferência na **C-6b**.

### D3 · A lista vive no `.env`, e o padrão é fechado

`IPS_DO_PAINEL`, consumida pelo label, fora do repositório, em modo `600`. Duas
razões para não versionar: o endereço do dono é dado pessoal adjacente, e a
lista muda sem que o código mude.

**Padrão `127.0.0.1/32`**, com `${IPS_DO_PAINEL:-...}` e não `${IPS_DO_PAINEL-...}`:
com `:-`, variável **ausente e vazia** caem no padrão fechado; com `-`, a string
vazia sobrescreveria o padrão e cairíamos no modo de falha da D1b.

Contra `${IPS_DO_PAINEL:?}`: derrubar o compose inteiro do produto por causa de
uma configuração do painel seria trocar um risco pequeno por um grande.

> **A justificativa anterior desta decisão estava errada**, e o erro fica.
> Ela dizia que `127.0.0.1/32` *"é alcançável pelo próprio host, de onde o
> `implantar.sh` verifica com `--resolve`"*. Duas coisas: a verificação do
> script batia em `/entrar`, que é do produto e nunca esteve atrás da
> allowlist; e uma conexão do host para uma porta publicada **não** chega ao
> container como `127.0.0.1` — chega com o endereço do gateway da bridge.
> `127.0.0.1/32` não é alcançável por ninguém, e é exatamente por isso que
> serve de padrão fechado. A justificativa errada era o convite para o erro que
> o `implantar.sh` agora avisa: alargar a faixa até o teste passar.

**Guarda no `implantar.sh`**, antes do `up`: recusa valor vazio ou que não seja
lista de CIDRs, e **avisa alto** em faixa mais larga que `/24`. Não recusa faixa
larga — `0.0.0.0/0` é o desligamento deliberado do rollback R1, e um script que
impede o rollback é pior que o risco.

A chave nasce no `.env` com **valor fechado visível**, por `acrescentar_linha`, e
não vazia. `IPS_DO_PAINEL=` lê-se como "sem restrição" e é o contrário; e a
recuperação da D4 usa `sed`, que **sem linha não casa nada e falha em silêncio**,
deixando o operador convencido de que se liberou.

### D4 · Recuperação de lockout, porque há **um** operador

Se o IP do dono mudar, o painel fica inalcançável para a única pessoa que o usa.
A saída é o SSH — caminho independente, que ele controla:

```bash
ssh root@2.24.79.49
cd /opt/mavia/repo/infra/producao
sed -i 's|^IPS_DO_PAINEL=.*|IPS_DO_PAINEL=<novo IP>/32|' .env && chmod 600 .env
docker compose up -d web
```

O `chmod` não é zelo: `sed -i` reescreve o arquivo, e ali vivem as senhas de
`mavia_migrate` e `mavia_app`.

O risco é aceito **porque a saída não depende do controle que falhou**.

### D5 · O que esta allowlist **não** compra

| Fecha | Não fecha |
|---|---|
| Senha de operador vazada, usada **de qualquer outro lugar** — a consequência que a DP-32 admite não ter controle nenhum | **XSS no navegador do próprio operador.** Ele está num IP permitido por construção. É a **C-6b** e o **MFA** |
| Varredura e enumeração de `/admin` pela internet | Obter a sessão: `/entrar` é do produto e **não** está atrás da allowlist. Uma senha vazada continua produzindo cookie válido de qualquer lugar; o que a allowlist impede é **usá-lo no painel** |
| Os *chunks* JS do painel, que a regra por segmento alcança | Qualquer coisa vinda de dentro da VPS |

A §6.1 do spec do painel justifica a C-6 pelo XSS: *"um XSS em qualquer tela do
produto, no navegador de um admin, alcança o painel inteiro"*. **A allowlist é
ortogonal a esse caminho.** Escrever isso aqui é o ponto: entregar metade de um
controle sem nomear a metade que falta transforma controle parcial em conforto
falso — que é exatamente como a DP-32 chegou a produção sem MFA.

---

## 5 · Aceite — e o que ele fecha, que **não** é a C-6

> **Passar as verificações abaixo fecha a C-6a. Não fecha a C-6.**
> A **C-6b** — hostname próprio e escopo de cookie distinto — continua aberta e
> continua bloqueante de deploy com cliente real.
>
> **A DP-32 não se move.** O que torna o painel defensável hoje não é controle
> nenhum: é que *"o único usuário do sistema é o próprio dono — o operador e o
> titular são a mesma pessoa, e não há dado de terceiro a proteger"*. A
> allowlist não substitui essa condição porque nunca foi ela que segurava a
> porta. O gatilho continua sendo **o primeiro cliente cadastrado**, e o que o
> desarma é **MFA**, com a C-6b como acompanhante.

O critério da C-6 é literal: *"recusa **antes** de a aplicação ser alcançada — o
teste falha se a recusa vier do Nest, porque isso prova que a requisição
chegou."*

**Do host da VPS (fora da lista):**

| # | Requisição | Esperado |
|---|---|---|
| A-4 | `/entrar` | `200` — o produto não foi tocado. Falhou? R2 imediato |
| A-1 | `/admin` | `403` |
| A-2 | `/api/v1/admin/eu` | `403` |
| A-3 | log da API durante A-1 e A-2 | **zero linhas** |

**As sondas negativas (R-1 do appsec), todas de fora da lista, todas `403`:**

`/API/v1/admin/eu` · `/Api/v1/admin/eu` · `/aPi/v1/admin/eu` ·
`/api/v1/ADMIN/eu` · `/api//v1/admin/eu` · `/api/./v1/admin/eu` ·
`/api/x/../v1/admin/eu` · `/api/v1%2fadmin/eu` · `/ADMIN` · `/Admin`

**De fora, pela internet — o único teste que vale (R-4):** de um IP da lista,
`/admin` → `200` e `/api/v1/admin/eu` sem sessão → `401`. De um IP fora
(celular em rede móvel, Wi-Fi desligado), `/admin` → `403` e `/entrar` → `200`.

> Se `/admin` der `403` **das duas** origens, o IP do cliente não está chegando
> ao Traefik. **Não alargue a faixa.** Rollback R1, e o mecanismo volta a ser
> questão aberta.

A-3 é a única asserção que não se lê no código de status, e é a que distingue
este controle de um `if` no controlador.

---

## 6 · O achado que saiu do caminho — severidade **Alta**, e não é deste escopo

`forwardedHeaders.insecure=true` tem consequência **fora** do painel,
encontrada ao verificar a D2 e **confirmada pelo appsec** ponta a ponta:

1. o Traefik preserva o `X-Forwarded-For` que o cliente mandar;
2. o proxy do rewrite do Next repassa os headers de entrada verbatim;
3. `FastifyAdapter` é instanciado **sem `trustProxy`** (`apps/api/src/aplicacao.ts:37`);
4. `origem()` devolve `split(',')[0]` — o que o cliente escreveu
   (`sessoes.controller.ts:377-383`, `cadastro.controller.ts:343-349`,
   `google.controller.ts:351-357`).

O comentário *"`x-forwarded-for` é confiável atrás do nosso Traefik e mais
nada"* é **falso nesta implantação**. Os dois ramos estão quebrados: o header é
escolhido pelo atacante, e o fallback (`req.ip`) colapsa todos os clientes no IP
do container `web`.

Três consequências, e a segunda o spec original não viu:

- **O contador por origem é anulado** — teto de 100 falhas por 15 min, que é a
  defesa de *password spraying*. O contador por endereço continua de pé.
- **A entrada pelo Google fica sem limite nenhum**: `google.controller.ts:342`
  deriva **as duas** chaves de `origem`.
- **Negação de serviço direcionada**, barata: 101 falhas com o
  `X-Forwarded-For` do escritório de alguém trancam aquele NAT por 15 minutos.

**Não corrijo aqui.** É de outro épico (autenticação), e a correção exige uma
decisão que não é minha e nem é de código: **quantos saltos existem entre o
cliente e o Nest, e qual é o último confiável?** Enquanto isso não for
respondido, nenhuma variante de código conserta nada. Ticket próprio,
severidade Alta, bloqueante do primeiro cliente cadastrado — **não** deste spec.

---

## 7 · Residuais aceitos, nomeados

- **`IPS_DO_PAINEL` aparece em `docker inspect`** e é IP residencial do dono.
  Não bloqueia; passar ao `especialista-lgpd-compliance` para decidir se entra
  no registro de tratamento. *(R-7)*
- **Server Actions.** Hoje não há nenhum `'use server'` em `apps/web/src`, e
  isso deixou de ser acidente: `Next-Action` é despachado por id sobre
  **qualquer** caminho de página e não respeita regra de caminho nenhuma. No dia
  em que o painel ganhar um Server Action, um `POST /entrar` com o id certo
  executa função de painel de fora da allowlist. **A ausência virou controle e
  precisa de asserção que a mantenha.** *(R-5)*
- **Indisponibilidade do deploy:** `docker compose up -d web` recria o
  container. Estimativa de 5 a 15 segundos de 502 no produto — a medir e
  registrar no `README.md`, que hoje não tem número nenhum de indisponibilidade.
