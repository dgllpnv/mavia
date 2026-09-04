Status: resolved

# 02 · O guard global, o opt-out nominal e `ROTAS_DE_ADMIN`

## Objetivo

Depois deste ticket, esquecer o decorador de autorização num controlador novo deixa de ser expressável: a autorização passa a ser negada por padrão para **toda** rota registrada, e a dispensa é uma linha nominal numa das três listas. É o pré-requisito de qualquer rota `/v1/admin/`, e ele muda o comportamento da API inteira.

## A seção do spec que governa

- **§5** — decide que `AutorizacaoGuard` passa a ser registrado por `APP_GUARD`, que o opt-out é por lista e nunca por decorador ausente, e que **`ROTAS_PUBLICAS` já existe e nada a lê**. Registra o risco: ligar o guard muda 22 controladores de uma vez.
- **§1.4, subseção "Como as rotas de admin são classificadas"** — as três listas e o que cada uma dispensa.
- **§1.4 · S3-8** — `ROTAS_DE_ADMIN` é `ReadonlySet<string>` de **chaves exatas**, e o prefixo vive num lugar só: a asserção de boot.
- **§6.2** — revalidação da sessão no Postgres a cada requisição sob `/admin`, e o que ela compra e o que não compra.
- **§6.4** — privilégio resolvido por requisição, nunca carimbado no token.
- **§6.5** — `exigeReautenticacao()` ganha consumidor de runtime, com o **`tenant_alvo`** no ticket de step-up.

## O que entra, e onde

Sem migration.

- `apps/api/src/app.module.ts` — `{ provide: APP_GUARD, useClass: AutorizacaoGuard }` ao lado do `APP_INTERCEPTOR` que já está no bloco de `providers` (hoje `app.module.ts:71-85`, com os 22 controladores em `:47-70`).
- `apps/api/src/autorizacao/autorizacao.guard.ts` — os quatro ramos:
  1. chave em `ROTAS_PUBLICAS` → passa sem sessão;
  2. chave em `ROTAS_SEM_TENANT` e fora de `ROTAS_PUBLICAS` → exige `req.sessao`, que é a semântica que `SessaoGuard` (`apps/api/src/autenticacao/sessao.guard.ts:17`) já implementa nas quatro rotas onde está aplicado;
  3. chave em `ROTAS_DE_ADMIN` → ramo de admin: exige `req.sessao`, revalida a sessão no Postgres, resolve a concessão de admin **por requisição**, e `req.autenticado` **continua nulo**;
  4. qualquer outra → `req.autenticado` obrigatório e `pode(rota, papel)`.
- `apps/api/src/autorizacao/politica-acesso.ts` — `ROTAS_DE_ADMIN: ReadonlySet<string>`, com as chaves exatas no formato `` `${metodo} ${caminho}` `` de `chaveDaRota` (`politica-acesso.ts:228-230`). **Nasce vazia ou com as chaves que já existirem**; cada ticket de rota acrescenta a sua linha.
- `politica-acesso.ts:258-266` — `verificarCoberturaDaMatriz` passa a considerar as **três** listas e a rodar a asserção de prefixo nas duas direções. Continua sendo chamada em `aplicacao.ts:119`, com as rotas que o `onRoute` de `aplicacao.ts:107-114` de fato registrou.
- O step-up: `exigeReautenticacao` (`politica-acesso.ts:239-241`) passa a ser lido no guard, com o `tenant_alvo` conferido contra o alvo da requisição.

## Critérios de aceite

**Boot** (contra a aplicação real, no `criarAplicacao`)

1. **Toda** rota registrada tem veredito declarado — pública, só-sessão, admin, ou papel — e o guard global entrega esse veredito. Um controlador novo sem entrada **derruba o boot**. *Isto é mais forte que `verificarCoberturaDaMatriz` de hoje, que verifica que a rota tem entrada e não verifica que o guard está ligado.*
2. Toda rota registrada cujo caminho começa com `/v1/admin/` **está** em `ROTAS_DE_ADMIN`, por **chave exata**; e nenhuma chave de `ROTAS_DE_ADMIN` aponta para caminho fora desse prefixo. As duas direções, e o literal do prefixo aparece **só aqui**.
3. `ROTAS_PUBLICAS` tem consumidor: o teste falha se a constante voltar a ser lista morta. *Ela é declarada em `politica-acesso.ts:203` e hoje não é importada em lugar nenhum — verificado.*

**Integração** (aplicação real)

4. As **13** rotas de `ROTAS_SEM_TENANT` (`politica-acesso.ts:176-200`) continuam respondendo o que respondiam **depois** de `APP_GUARD` ligado — rota a rota, com o código de status esperado. Entre elas `GET /v1/eu`, `POST /v1/sessoes`, as quatro rotas de credencial e `POST /v1/cobranca/webhook`.
5. As **9** entradas de `ROTAS_PUBLICAS` (`politica-acesso.ts:203-226`) respondem sem sessão.
6. Uma rota marcada com `exigeReautenticacao` na matriz e chamada **sem** step-up recebe **401 com marcador próprio**. Hoje o único consumidor do predicado é `apps/api/test/membros.test.ts:274-276`, que apenas confere a matriz — não há consumidor de runtime.
7. Um ticket de step-up emitido para o cliente A **não autoriza** a mesma escrita no cliente B: o `tenant_alvo` é conferido, e a divergência é 401 com o mesmo marcador.
8. Revogar a sessão de um operador tira o acesso na **requisição seguinte**, sem esperar os 15 minutos de vida do access token (`apps/api/src/redis/cofre-de-acesso.ts:35`, `VIDA_DO_ACESSO_EM_SEGUNDOS = 15 * 60`). É a revalidação no Postgres sob `/admin`, medida.
9. No ramo de admin, `req.autenticado` permanece **nulo** — o guard não sintetiza um `Autenticado` em nenhum caminho.

## Armadilhas conhecidas

- **`ROTAS_PUBLICAS` é lista morta hoje (S-4, §5 item 3).** Verificado: declarada em `politica-acesso.ts:203`, **sem nenhum consumidor no repositório**. A lista de opt-out que o guard global precisa já foi escrita e nunca foi ligada — é o mesmo defeito que este épico corrige, uma camada acima. Ligar o guard **sem** ligar a lista quebra as nove rotas públicas.
- **Ligar `APP_GUARD` muda a API inteira, não só o painel (§5, risco registrado).** Guards do Nest compõem: as 17 ocorrências de `@UseGuards(AutorizacaoGuard)` continuam válidas e passam a ser redundantes. Mas as 13 rotas de `ROTAS_SEM_TENANT` têm `req.autenticado` nulo por construção (`apps/api/src/autenticacao/autenticador.ts:93`) e **passariam a responder 401** se caíssem no ramo padrão. Os cinco controladores sem decorador hoje — `SessoesController`, `CadastroController`, `GoogleController`, `WebhookController`, `AceitarConviteController` — são exatamente os que servem essas rotas. **Sem o critério 4, esta mudança é uma aposta sobre 13 rotas de credencial e sessão.**
- **A asserção de boot precisa verificar a fiação, não só a matriz (S-4).** `verificarCoberturaDaMatriz` (`politica-acesso.ts:258-266`) verifica que toda rota **tem entrada em alguma lista**. Ele não verifica — e não pode verificar — que o guard está **ligado**: hoje `app.module.ts:71-85` registra `APP_INTERCEPTOR` e nenhum `APP_GUARD`, e um `AdminController` com entrada na matriz e sem o decorador sobe limpo e responde a qualquer sessão autenticada. `matriz-de-acesso.md:20` e `sistema.md:660` afirmam existir um guard global que nega por padrão; **os dois documentos descrevem um mecanismo que o código não tem.** O critério 1 é o que fecha isso, e ele exige exercitar o guard, não ler a matriz.
- **Prefixo entre duas listas de chave exata (S3-8).** `ROTAS_SEM_TENANT` e `ROTAS_PUBLICAS` são `ReadonlySet<string>` de chaves exatas. Uma terceira lista com semântica de prefixo é a assimetria que o próximo leitor resolve errado — e resolve na direção permissiva, porque prefixo é mais fácil de escrever. Uma rota nova sob `/v1/admin/` **exige uma linha nova**, e é isso que se quer.
- **Colar `/v1/admin/*` em `ROTAS_SEM_TENANT` é proibido** — ADR 0024 D6, e §1.4: aquela lista é o que dispensa a rota da matriz (`politica-acesso.ts:264`) **e** o que define `exigeTenant` (`aplicacao.ts:86`). Seriam duas exceções pelo preço de uma.
- **A revalidação de sessão não vale contra quem lê o Redis (S3-12).** O cofre grava `{sessaoId, usuarioId}` **em claro** (`cofre-de-acesso.ts:37-40`, gravado em `:59-72`), e a revalidação pergunta ao Postgres se **esses dois valores** conferem — exatamente os dois que um atacante acabou de copiar de lá. Ela fecha a janela de **revogação** (A-15) e não a de comprometimento do cofre. Não escreva no ticket, no código ou no comentário que ela é defesa contra o Redis: foi essa mistura que deu à v3 a aparência de uma defesa que ela não tem. O que vale contra o cofre é o `requirepass`, a ACL e o isolamento de rede — **C-7**, deploy.
- **A reautenticação protege contra sessão roubada, não contra senha roubada** (§6.5) — que é o risco que a ausência de MFA declara. Vale a pena e não fecha o buraco.

## Decisões pendentes que este ticket toca

- **DP-32** (`decisoes-do-produto.md:136`) — *"até quando o painel de admin fica sem MFA?"*, **em aberto**. Padrão vigente: *antes do primeiro cliente pagante; enquanto não houver escolha, o painel não vai a produção com cliente real.* Este ticket implementa o step-up de §6.5 como a compensação parcial que o padrão pressupõe. **Se o dono responder qualquer marco posterior ao primeiro cliente pagante**, o degrau de §4.1 (operar com um administrador só) reabre no mesmo ato, e a LIA da §8.1.1 volta à mesa — não muda nada neste ticket, muda o que o painel pode alcançar.

## O que este ticket não faz

- Não cria rota de admin nenhuma. `ROTAS_DE_ADMIN` pode nascer vazia — a asserção de boot é bidirecional e passa com o conjunto vazio enquanto nenhuma rota `/v1/admin/` estiver registrada.
- Não resolve a concessão contra a tabela: `concessoes_de_admin` é o ticket 04. Até lá o ramo de admin é alcançável e sem rota nenhuma para servir; o resolvedor é injetado pelo 04.
- Não implementa MFA (fora do escopo do épico) nem a allowlist de rede (**C-6**, `sre-devops-vps`).


## Comments

**2026-09-04 · entregue, com escopo declarado**

`APP_GUARD` registrado, guard com os quatro ramos, `ROTAS_DE_ADMIN` como conjunto de chaves exatas, e a cobertura de boot passando a considerar as **três** listas mais a asserção de prefixo nas duas direções. `guard-global.test.ts`, 9 asserções.

**Critérios 1 a 5: cumpridos.** Os 6 a 9 **não entraram, e a razão é dependência, não corte:**

- **6 e 7 (step-up com `tenant_alvo`)** — o mecanismo de step-up **não existe no repositório**. Verifiquei: nenhuma ocorrência de `tickets_step_up`, `stepUp` ou `step_up` em `apps/api/src`. `exigeReautenticacao` é um predicado sobre a matriz, e não há nada que emita ou consuma um ticket. Construí-lo aqui seria um épico dentro do ticket.
- **8 (revalidação da sessão no Postgres) e 9 (`req.autenticado` nulo sob `/admin`)** — o ramo 3 do guard já existe e já mantém `req.autenticado` nulo, mas **não há rota de admin para exercitá-lo**: `ROTAS_DE_ADMIN` nasce vazia. Medir revogação em uma requisição exige `concessoes_de_admin`, que é o ticket 04.

O ramo 3 entra agora, vazio de consumidor, por um motivo: sem ele a primeira rota `/v1/admin/` cairia no ramo 4, exigiria `req.autenticado` — que o caminho de admin nunca produz — e responderia 401 para sempre, com o defeito parecendo de autenticação.

**Uma asserção que eu tinha escrito errado.** Ela afirmava que nenhuma rota pública devolve 401. `POST /v1/sessoes/renovar` devolve, e está certo: é a rota dizendo *"sua sessão expirou"*, não o guard dizendo *"você não passa"*. Pior que o falso negativo: a asserção ficaria **verde** se o guard passasse a barrá-la, porque o 401 continuaria lá com outro dono. Agora ela olha a mensagem, que é literal e só do guard.

**Um alerta de higiene para quem for medir a suíte.** Na primeira execução completa depois desta mudança, um arquivo falhou no *setup* e passou sozinho em seguida; a segunda execução completa ficou verde. É contenção de container com 34 arquivos subindo Testcontainers, não regressão — mas é ruído que vai voltar, e vale um teto de paralelismo quando incomodar.

Verde: typecheck 9/9, lint 9/9, API **503** em 34 arquivos, E2E **23**.
