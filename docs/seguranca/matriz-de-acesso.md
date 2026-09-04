# Matriz de acesso — papel × ação × recurso

- **Data:** 2026-09-01
- **Autor:** `especialista-seguranca-appsec`
- **Status:** Normativo. É a fonte da tabela de `domain/politica-acesso.pode()`. Contradizer este documento exige ADR.
- **Destrava:** A-12, A-16, A-19, A-20, A-21, A-24, A-26, A-27, A-28, A-29, A-30, A-31, A-40 do `docs/validacao/gate-risco-spec.md`
- **Insumos:** `docs/arquitetura/sistema.md` §4.1 e §6.3 · `CONTEXT.md` (Papel) · `CLAUDE.md` §2 (regras 16–20) · `docs/produto/arquitetura-informacao.md` §2.11–2.13 · ADR 0004
- **Documentos irmãos:** `docs/compliance/retencao-e-eliminacao.md` · `docs/adr/0018-envelope-encryption.md`

> Este documento existe porque `pode(papel, acao, recurso)` estava declarado em `sistema.md` §1.1 e a tabela que ele consulta não existia em lugar nenhum. Uma função de autorização sem tabela é uma função vazia, e uma superfície de ~115 rotas sem matriz é ~115 decisões de autorização tomadas por quem estiver escrevendo o controller naquele dia.

---

## 0. Como este documento vira código

Três artefatos derivam daqui, nesta ordem:

1. **`packages/domain/politica-acesso/tabela.ts`** — transcrição literal da §2 (matriz papel × ação × recurso). Puro, sem I/O, testado em S1. Uma linha por `(acao, recurso)`; o valor é o conjunto de papéis.
2. **`packages/contracts/autorizacao.ts`** — cada rota declara `{ acao, recurso, condicoes[], reautenticacao, rateLimit }`. O OpenAPI gerado carrega essa declaração como extensão `x-mavia-autorizacao`.
3. **`apps/api/src/autorizacao/autorizacao.guard.ts`**, registrado como `APP_GUARD` em `app.module.ts` — um `Guard` global que **nega por padrão**. Rota sem declaração não sobe: a verificação é feita no *boot*, percorrendo o manifesto de rotas do Nest contra o manifesto de `contracts`, e o processo falha ao subir com a lista das rotas não declaradas. Falhar no boot, nunca em runtime.

> **Correção de 2026-09-04.** Esta linha descrevia o mecanismo certo com o nome de um arquivo que nunca existiu, e **o guard não era global** — vinha por decorador, controlador a controlador, e `app.module.ts` registrava um interceptor e nenhum `APP_GUARD`. Um controlador novo **com** entrada nesta matriz e **sem** o decorador subia limpo, passava na asserção de boot e respondia a qualquer sessão autenticada; a asserção verificava que a rota tinha *entrada*, não que o guard estava *ligado*.
>
> Não havia buraco vivo — os cinco controladores sem decorador eram os de autenticação, públicos por desenho. O risco era prospectivo, e o alvo mais valioso teria sido o painel de administração. Fechado no ticket 02 daquele épico, com `guard-global.test.ts` medindo o comportamento das 22 rotas de sessão e credencial que a mudança poderia ter quebrado.
>
> É o segundo controle desta matriz que se descobriu inexistente ao ser citado — o primeiro foi a regra de lint da R-3. **Os dois erros têm a mesma forma: uma frase plausível que ninguém executou.** Daí a regra que este documento passa a seguir: controle citado aponta para arquivo e linha, ou não é controle.

**Critério de aceite estrutural (S4 + S2, obrigatório antes do primeiro épico com rota):**

> Um teste parametrizado percorre todas as rotas do OpenAPI gerado e falha se alguma não tiver entrada nesta matriz. Um segundo teste percorre esta matriz e falha se alguma linha não corresponder a uma rota existente — a tabela não pode envelhecer em nenhuma das duas direções.

---

## 1. As sete regras que a matriz pressupõe

Estas regras valem para **toda** rota e não se repetem célula a célula. Uma célula da matriz só menciona o que foge delas.

### R-1 · Negar por padrão

Ausência de declaração é negação, verificada no boot. Não existe rota "pública por esquecimento". As três únicas rotas sem sessão são `POST /auth/registrar`, `POST /auth/entrar` e `POST /auth/senha/recuperar` — declaradas explicitamente como `anonimo` na matriz, com rate limit obrigatório.

### R-2 · A RLS isola tenants; a propriedade **dentro** do tenant é responsabilidade explícita da rota

Esta frase resolve A-27 e precisa estar escrita porque o time vai supor o contrário. O ADR 0004 protege *linhas de outros tenants*. Ele não sabe nada sobre `notificacoes`, `preferencias` e `sessoes`, cuja chave inclui `usuario_id`: dois membros do mesmo tenant passam pela mesma policy. Toda rota sobre recurso cuja chave inclui `usuario_id` compara `usuario_id = TenantContext.usuarioAtual()` no servidor, além da RLS. Marcado na coluna de condição como `dono-usuario`.

### R-3 · O tenant vem do contexto de sessão, nunca do caminho da URL — **regra que fecha A-19**

> **O `tenant_id` efetivo de qualquer requisição é exclusivamente aquele resolvido pelo pipeline de sessão (token + `X-Mavia-Tenant` validado contra `tenant_usuarios`). Um `:id` de tenant presente no path é tratado como uma *asserção redundante do cliente*, jamais como fonte. O servidor compara `params.id` com `TenantContext.tenantId()` por igualdade; divergência responde **403** e a requisição termina ali, antes de qualquer consulta. Em nenhum ponto do código o valor de `params.id` é atribuído a `app.tenant_id`, passado para `withTenant()`, ou usado numa cláusula `WHERE`.**

Consequências operacionais, todas verificáveis:

- `comTenant(pool, ctx, fn)` recebe **um único** argumento de origem possível, o `ContextoDoTenant`.

  > **Correção de 2026-09-04.** Esta linha dizia: *"`withTenant(tenantId, fn)` … Uma regra de lint proíbe `withTenant(req.params.…)` literalmente; a violação reprova o build."* **As duas metades eram falsas.** A função se chama `comTenant` (`apps/api/src/tenancy/tenancy.ts:64`), não `withTenant`, e recebe o contexto inteiro em vez do id solto; e `eslint.config.js` não tem nenhuma regra sobre ela — o lint descrito casaria com zero linhas do repositório. O erro sobreviveu meses porque a frase é plausível e ninguém a executou. Foi ele que reprovou a v1 do spec do painel de administração, que o citou como salvaguarda existente. Fica registrado em vez de apagado: **a lição é que controle afirmado em documento normativo precisa apontar para arquivo e linha, ou não é controle.**

  A garantia real hoje é estrutural, não de lint: `comTenant` usa `set_config($1, $2, true)` com parâmetro vinculado (`tenancy.ts:76-80`), e o `ContextoDoTenant` só é produzido pelo pipeline de sessão.
- A comparação acontece num interceptor nomeado (`AsserirTenantDoPath`) declarado uma vez, não num `if` por controller.
- Divergência é 403 com corpo genérico — **não** 404 e **não** "tenant não encontrado": as duas variantes revelam existência de tenant alheio.
- O mesmo tratamento vale para qualquer rota futura que carregue `:tenantId`, com **uma** exceção, nomeada e delimitada pelo [ADR 0024](../adr/0024-acesso-administrativo-entre-espacos.md) (aceito em 2026-09-04): as rotas sob `/v1/admin/`. Ali o identificador do caminho é a fonte, porque o painel de administração precisa **escolher** o espaço — e a exceção só existe sob as três condições da D1, sendo a decisiva que a requisição de admin **não carrega um `Autenticado`**, o que impede os controladores do cliente de servi-la. Uma segunda exceção exige ADR nova.

Isso resolve o IDOR de tenant. A **autopromoção a `proprietario`** é fechada separadamente, por R-4.

### R-4 · Mudança de papel: quatro travas independentes

`PATCH /tenants/:id/membros/:usuarioId` é a rota de escalada de privilégio do produto. Quatro condições, todas no servidor, todas testadas:

1. **Papel exigido:** `proprietario`. Verificado contra `TenantContext.papel()`, que vem de `tenant_usuarios` lido sob a policy de `app.usuario_id` — nunca do token, nunca do corpo.
2. **Autoalteração proibida:** `params.usuarioId !== TenantContext.usuarioAtual()`. Um `proprietario` não muda o próprio papel, e portanto um `membro` também não — a checagem existe para tornar a regra independente da checagem de papel, e não uma consequência dela.
3. **Último proprietário protegido por constraint, não por `if`:** a transição que deixaria o tenant com zero `proprietario` ativo é rejeitada pelo banco. Trigger `AFTER … FOR EACH STATEMENT` sobre `tenant_usuarios` que verifica `COUNT(*) FILTER (WHERE papel = 'proprietario' AND removido_em IS NULL) >= 1` por tenant. Vale igualmente para `DELETE`.
4. **Reautenticação e notificação:** promover a `proprietario` e remover membro exigem senha ou MFA no ato (§4), gravam em `auditoria` e notificam **todos** os proprietários, inclusive o autor.

### R-5 · O que a resposta pode conter é parte da autorização

Autorizar a rota não autoriza o campo. Sete campos **nunca** aparecem em resposta de API, para nenhum papel, em nenhuma rota:

`senha_hash` · `refresh_hash` · `mfa_segredo_cifrado` · `credenciais_cifradas` · `dek_cifrada` · `ip_hash` / `user_agent_hash` · `lancamentos_brutos.payload`

Imposto por allowlist nos schemas de `contracts` e por varredura sobre o OpenAPI gerado (`AB-07`). Onde a visibilidade de um campo depende do papel — e-mail de outro membro, atividades de segurança — isso está dito na célula da rota.

### R-6 · Autorização de lote é por item

Nenhuma rota que aceita uma lista verifica autorização "do lote". `POST /lancamentos/lote` e `POST /sync/mutacoes` verificam papel e propriedade **por item**, dentro de uma transação única: um item negado reverte a operação inteira. Teto de itens validado por Zod antes de qualquer consulta.

### R-7 · Ator programático é mais restrito que ator humano

Token OAuth/MCP e chave de API nunca alcançam a rota mais permissiva que o papel do usuário alcança. A interseção é `papel ∩ escopo`, e a lista de escopos proibidos da §6 é absoluta — nem o `proprietario` pode conceder o que ela veta.

---

## 2. A matriz — papel × ação × recurso

Esta é a tabela que `pode(papel, acao, recurso)` implementa. Ela é **pura**: não conhece rota, não conhece propriedade de linha, não conhece reautenticação. Tudo isso é condição adicional, verificada na borda (§3).

Legenda: `✓` permitido · `✗` negado · `⊙` permitido apenas sobre o próprio registro do usuário (R-2).

### 2.1 Recursos de dinheiro (o espaço é compartilhado)

| Recurso | Ação | `proprietario` | `membro` | `visualizador` |
|---|---|:--:|:--:|:--:|
| `conta` | `ler` | ✓ | ✓ | ✓ |
| `conta` | `criar` · `editar` · `arquivar` | ✓ | ✓ | ✗ |
| `conta` | `excluir` | ✓ | ✗ | ✗ |
| `cartao` | `ler` | ✓ | ✓ | ✓ |
| `cartao` | `criar` · `editar` · `arquivar` | ✓ | ✓ | ✗ |
| `cartao` | `excluir` | ✓ | ✗ | ✗ |
| `fatura` | `ler` | ✓ | ✓ | ✓ |
| `fatura` | `fechar` · `pagar` | ✓ | ✓ | ✗ |
| `fatura` | `reabrir` | ✓ | ✗ | ✗ |
| `categoria` · `etiqueta` | `ler` | ✓ | ✓ | ✓ |
| `categoria` · `etiqueta` | `criar` · `editar` · `arquivar` · `excluir` | ✓ | ✓ | ✗ |
| `lancamento` | `ler` | ✓ | ✓ | ✓ |
| `lancamento` | `criar` · `editar` · `efetivar` · `desefetivar` | ✓ | ✓ | ✗ |
| `lancamento` | `excluir` | ✓ | ✓ | ✗ |
| `transferencia` · `parcelamento` · `recorrencia` | `ler` | ✓ | ✓ | ✓ |
| `transferencia` · `parcelamento` · `recorrencia` | `criar` · `editar` · `excluir` | ✓ | ✓ | ✗ |
| `planejamento` · `objetivo` · `aporte` | `ler` | ✓ | ✓ | ✓ |
| `planejamento` · `objetivo` · `aporte` | `criar` · `editar` · `excluir` · `arquivar` | ✓ | ✓ | ✗ |
| `relatorio` | `ler` | ✓ | ✓ | ✓ |
| `conciliacao` | `ler` | ✓ | ✓ | ✓ |
| `conciliacao` | `decidir` (aceitar/rejeitar) | ✓ | ✓ | ✗ |
| `anexo` | `ler` · `criar` · `excluir` | ✓ | ✓ | ✗ (`ler`: ✓) |

**`visualizador` não escreve nada de dinheiro. Sem exceção.** É a única leitura possível do papel descrito em `CONTEXT.md` ("só leitura"), e é o primeiro dos dois exemplos que `sistema.md` §2.3 já prometia testar em S2.

### 2.2 Ingestão e origem dos dados

| Recurso | Ação | `proprietario` | `membro` | `visualizador` |
|---|---|:--:|:--:|:--:|
| `importacao` | `ler` | ✓ | ✓ | ✓ |
| `importacao` | `criar` (upload) · `promover` · `desfazer` | ✓ | ✓ | ✗ |
| `conexao` | `ler` (metadados: instituição, escopo, validade, estado) | ✓ | ✓ | ✓ |
| `conexao` | `criar` (conectar banco) | ✓ | ✓ | ✗ |
| `conexao` | `sincronizar` | ✓ | ✓ | ✗ |
| `conexao` | `revogar` | ✓ | ⊙ (só a conexão que o próprio autorizou) | ✗ |
| `consentimento` | `ler` | ✓ | ⊙ | ✗ |
| `regra_categorizacao` | `ler` | ✓ | ✓ | ✓ |
| `regra_categorizacao` | `criar` · `editar` · `excluir` | ✓ | ✓ | ✗ |
| `sugestao_ia` | `solicitar` | ✓ | ✓ | ✗ |

`conexao.revogar` é a única ação de escrita em que um `membro` tem alcance **maior** sobre o próprio registro do que sobre os dos outros: quem deu o consentimento pode retirá-lo em um toque, sem reautenticação e sem depender do `proprietario`. Isso é exigência de LGPD (art. 8º §5º), não conveniência — ver `docs/compliance/retencao-e-eliminacao.md` §10. Um `proprietario` também pode revogar qualquer conexão do espaço, porque ela alimenta contas do espaço; a revogação por terceiro notifica o titular do consentimento.

### 2.3 Espaço, membros e identidade

| Recurso | Ação | `proprietario` | `membro` | `visualizador` |
|---|---|:--:|:--:|:--:|
| `tenant` | `ler` (nome, plano, timezone) | ✓ | ✓ | ✓ |
| `tenant` | `criar` | qualquer usuário autenticado (com teto — A-18) | | |
| `tenant` | `editar` (nome, timezone) | ✓ | ✗ | ✗ |
| `tenant` | `eliminar` | ✓ | ✗ | ✗ |
| `tenant` | `comecar_do_zero` | ✓ | ✗ | ✗ |
| `membro` | `ler` (nome, papel, avatar) | ✓ | ✓ | ✓ |
| `membro` | `ler_contato` (e-mail) | ✓ | ✗ | ✗ |
| `membro` | `convidar` | ✓ | ✗ | ✗ |
| `membro` | `alterar_papel` | ✓ (nunca o próprio — R-4) | ✗ | ✗ |
| `membro` | `remover` | ✓ | ⊙ (só a si mesmo: "sair do espaço") | ⊙ |
| `preferencia` | `ler` · `editar` | ⊙ | ⊙ | ⊙ |
| `notificacao` | `ler` · `marcar_lida` | ⊙ | ⊙ | ⊙ |
| `preferencia_alerta` | `ler` · `editar` | ⊙ | ⊙ | ⊙ |
| `sessao` | `ler` · `revogar` | ⊙ | ⊙ | ⊙ |
| `billing` | `ler` · `editar` | ✓ | ✗ | ✗ |

`billing` é o segundo exemplo que `sistema.md` §2.3 promete testar ("`membro` não muda billing"). As rotas do épico 11 nascem já cobertas por esta linha, detalhadas em §3.17.

**O plano e as cotas, porém, são visíveis a todos** — já pela linha `tenant · ler (nome, plano, timezone)` acima. É deliberado: um `membro` que esbarra numa cota precisa entender **por que** o botão recusou, e a mensagem nomeia a cota e a contagem (§5 do spec de planos). O que ele nunca vê é preço pago, meio de pagamento e documento fiscal.

### 2.4 Registro, exportação e observabilidade

| Recurso | Ação | `proprietario` | `membro` | `visualizador` |
|---|---|:--:|:--:|:--:|
| `atividade` | `ler_financeira` (lançamento, conta, cartão, planejamento…) | ✓ | ✓ | ✓ |
| `atividade` | `ler_seguranca` (login, senha, sessão, MFA, membros, billing, chaves) | ✓ | ⊙ (só as próprias) | ⊙ |
| `exportacao` | `criar` (escopo parcial) | ✓ | ✓ | ✗ |
| `exportacao` | `criar` (escopo "tudo") | ✓ | ✓ | ✗ |
| `exportacao` | `baixar` | ⊙ (só a que o próprio pediu) | ⊙ | ✗ |
| `chave_api` · `app_conectado` | `ler` · `criar` · `revogar` | ✓ | ✗ | ✗ |
| `saude` · `metricas` | `ler` | — (nenhum papel de produto; ver §7) | | |

`ip_hash` e `user_agent_hash` **nunca** saem em resposta de `atividade`, para nenhum papel. Existem para investigação de incidente, não para exibição — A-26.

### 2.5 Decisões marcadas como do dono do produto

Os valores acima são o **padrão seguro proposto**, escolhido para que a matriz seja implementável hoje. Os três abaixo não são decisão de segurança e precisam de confirmação de `product-financeiro` antes do épico correspondente. Enquanto não houver decisão, vale o padrão.

| # | Pergunta | Padrão proposto | O que muda se a decisão for outra |
|---|---|---|---|
| **DP-1** ✅ | Um `membro` pode conectar o próprio banco ao espaço da família? | **SIM — decidido pelo dono do produto em 2026-09-01.** `conexao.criar` é permitida a `proprietario` e `membro`; `visualizador` continua fora. |
| **DP-2** ✅ | Um `membro` pode convidar outras pessoas? | **NÃO.** **Decidido pelo dono do produto em 2026-09-01.** Convidar é exclusivo de `proprietario`: quem paga a assinatura controla quem entra, e sem isso o espaço cresce sem o titular do contrato saber. |
| **DP-3** ✅ | Um `membro` pode criar chave de API ou autorizar app de IA? | **NÃO.** **Decidido pelo dono do produto em 2026-09-01.** Chave de API é acesso programático persistente a todas as finanças do espaço; concentrá-la no `proprietario` evita ter de construir uma tela de auditoria de chaves de terceiros só para ampliar a superfície de risco. |
| **DP-4** ✅ | Um `membro` pode excluir lançamento criado por outro membro? | **SIM.** **Decidido pelo dono do produto em 2026-09-01.** O dado é do espaço, não do autor. A exclusão é soft delete e fica no log de atividades com autor e horário — reversível e rastreável, não destrutiva. Nenhuma rota de `lancamento` ganha condição de autoria. |

**DP-4 é o mais consequente.** O padrão proposto — dado financeiro pertence ao `Tenant`, não ao `Usuario` que digitou — é o que sustenta o saldo compartilhado e é o que o texto de aceite de `docs/compliance/retencao-e-eliminacao.md` §10.6 comunica ao convidado. Trocá-lo depois de existirem espaços com histórico é caro.

---

## 3. Percurso rota a rota

Colunas:

- **Papéis** — `P` `proprietario` · `M` `membro` · `V` `visualizador` · `anon` sem sessão. Deriva da §2; repetida aqui para que a tabela seja utilizável sozinha.
- **Verificação além de sessão + tenant** — o que a rota checa que a RLS **não** checa. `—` significa "a RLS e o papel bastam", e essa afirmação é ela própria uma declaração normativa, não uma omissão.
- **Reaut.** — exige senha ou MFA no ato (§4).
- **RL** — classe de rate limit (§5).

### 3.1 `auth` — identidade, sessão, MFA

| Rota | Papéis | Verificação além de sessão + tenant | Reaut. | RL | Achado |
|---|---|---|:--:|---|---|
| `POST /auth/registrar` | anon | Resposta e tempo idênticos para e-mail existente e inexistente (±50 ms) | — | `RL-AUTH` | A-13 |
| `POST /auth/entrar` | anon | Contador por hash do e-mail e por IP; atraso progressivo 0/1/2/4/8 s; bloqueio 15 min | — | `RL-AUTH` | A-13 |
| `POST /auth/senha/recuperar` | anon | Idem registrar: mensagem e tempo constantes | — | `RL-AUTH` | A-13 |
| `POST /auth/refresh` | sessão | Refresh apresentado é invalidado e rotacionado; reuso revoga a **família** (`sessoes.familia_id`), audita e notifica | — | `RL-AUTH` | A-14 |
| `POST /auth/sair` | sessão | Revoga apenas a sessão corrente | — | `RL-ESCRITA` | — |
| `GET /auth/eu` | sessão | Retorna identidade própria + lista de tenants + papel em cada um. **Não** retorna e-mail, `ultimo_acesso_em` nem contagem de sessões de outros membros | — | `RL-LEITURA` | A-16 |
| `GET /auth/sessoes` | sessão | `dono-usuario`. Dispositivo, IP **mascarado** (`/24` v4, `/48` v6), último uso, "esta é a corrente" | — | `RL-LEITURA` | A-15 |
| `DELETE /auth/sessoes/:id` | sessão | `dono-usuario` sobre a sessão alvo; 404 genérico para sessão de outro usuário | — | `RL-ESCRITA` | A-15 |
| `POST /auth/sessoes/revogar-todas` | sessão | Revoga todas menos a corrente. Efeito ≤ 60 s mesmo com access token válido em circulação | — | `RL-ESCRITA` | A-15 |
| `POST /auth/senha/alterar` | sessão | Exige senha atual; ao concluir revoga todas as sessões exceto a corrente, **obrigatoriamente** | sim | `RL-AUTH` | A-15 |
| `POST /auth/mfa/inscrever` | sessão | `dono-usuario`. Gera segredo TOTP cifrado sob o envelope (ADR 0018, propósito `usuario.mfa`) | sim | `RL-AUTH` | A-17 |
| `POST /auth/mfa/confirmar` | sessão | Só ativa após um código válido; emite 10 códigos de recuperação de uso único, exibidos **uma vez** | sim | `RL-AUTH` | A-17 |
| `POST /auth/mfa/verificar` | sessão parcial | Consome o desafio; teto de tentativas por desafio (5) | — | `RL-AUTH` | A-17 |
| `DELETE /auth/mfa` | sessão | `dono-usuario`; notifica o titular e todos os proprietários dos tenants onde MFA é exigido | sim | `RL-AUTH` | A-17 |
| `POST /auth/reautenticar` | sessão | Emite um *ticket de step-up* de 5 min, escopado à ação pedida, consumido uma vez | — | `RL-AUTH` | A-19, A-28 |
| `DELETE /auth/eu` | sessão | Confirmação por digitação; abre janela de arrependimento de 7 dias; recusa se o usuário for o **único** `proprietario` de algum tenant com outros membros | sim | `RL-CARA` | B-03 |

**Rotas de `auth` não têm papel de tenant.** Elas operam sobre `usuarios` e `sessoes`, que são globais (`sistema.md` §3.1). A verificação é sempre `dono-usuario` sob a policy de `app.usuario_id` — nunca `app.tenant_id`. Esta é a fronteira que A-02 apontou como não escrita, e ela precisa estar aqui porque é a única página onde alguém vai procurar.

### 3.2 `tenants` — espaço e membros (superfície de A-19)

Todas as rotas abaixo estão sob **R-3**. A coluna de condição diz o que se soma a isso.

| Rota | Papéis | Verificação além de sessão + tenant | Reaut. | RL | Achado |
|---|---|---|:--:|---|---|
| `GET /tenants` | sessão | Lista os tenants **do usuário**, lidos de `tenant_usuarios` sob `app.usuario_id`. Nunca uma varredura de `tenants` | — | `RL-LEITURA` | A-02 |
| `POST /tenants` | sessão | Teto: 3 por usuário por dia, 10 ativos por usuário. Cria `tenant_usuarios` com `papel = proprietario` na mesma transação | — | `RL-CARA` | A-18 |
| `PATCH /tenants/:id` | P | R-3 | — | `RL-ESCRITA` | A-19 |
| `GET /tenants/:id/membros` | P M V | R-3. **E-mail só para `P`**; `M` e `V` recebem nome, papel, avatar e `aceito_em` | — | `RL-LEITURA` | A-16, A-19 |
| `POST /tenants/:id/convites` | P | R-3. Token de uso único ≥ 128 bits, validade 7 dias, vinculado ao e-mail convidado, revogável. Teto de convites pendentes por tenant | — | `RL-CONVITE` | A-19, B-10 |
| `DELETE /tenants/:id/convites/:conviteId` | P | R-3. Apaga fisicamente o registro e o e-mail do convidado | — | `RL-ESCRITA` | B-10 |
| `POST /convites/:token/aceitar` | sessão | O e-mail autenticado **é** o e-mail convidado — comparação estrita, não normalização frouxa. Exige aceite do termo versionado (`tenant_usuarios.termo_versao`). Token consumido na transação | — | `RL-AUTH` | A-19, B-08 |
| `PATCH /tenants/:id/membros/:usuarioId` | P | R-3 **e as quatro travas de R-4** | sim | `RL-ESCRITA` | **A-19** |
| `DELETE /tenants/:id/membros/:usuarioId` | P, ou ⊙ o próprio | R-3. Trava 3 de R-4 (último proprietário). Efeitos obrigatórios na mesma transação: revoga sessões, tokens OAuth e chaves de API **daquele tenant** para aquele usuário (≤ 60 s), e enfileira a exportação de saída | sim (quando `P` remove outro) | `RL-ESCRITA` | A-19, B-09 |
| `DELETE /tenants/:id` | P | R-3. Confirmação por digitação do nome. Janela de arrependimento de 7 dias. Notifica todos os membros | sim | `RL-CARA` | B-03 |
| `POST /tenants/:id/comecar-do-zero` | P | R-3. Confirmação por digitação. Escopo exato definido em `retencao-e-eliminacao.md` §5.4 | sim | `RL-CARA` | B-03 |

### 3.3 `contas`

| Rota | Papéis | Verificação além de sessão + tenant | Reaut. | RL | Achado |
|---|---|---|:--:|---|---|
| `GET /contas` | P M V | — | — | `RL-LEITURA` | — |
| `POST /contas` | P M | — | — | `RL-ESCRITA` | — |
| `GET /contas/:id` | P M V | — (RLS cobre; o teste de dois tenants é por rota, não por amostragem) | — | `RL-LEITURA` | — |
| `PATCH /contas/:id` | P M | — | — | `RL-ESCRITA` | — |
| `POST /contas/:id/arquivar` | P M | — | — | `RL-ESCRITA` | — |
| `GET /contas/saldos?em=` | P M V | `em` validado por Zod: instante parseável, ≤ hoje + 5 anos, ≥ hoje − 20 anos | — | `RL-AGREGADA` | A-22 |

### 3.4 `cartoes` e `faturas`

| Rota | Papéis | Verificação além de sessão + tenant | Reaut. | RL | Achado |
|---|---|---|:--:|---|---|
| `GET /cartoes` | P M V | — | — | `RL-LEITURA` | — |
| `POST /cartoes` | P M | — | — | `RL-ESCRITA` | — |
| `PATCH /cartoes/:id` | P M | — | — | `RL-ESCRITA` | — |
| `POST /cartoes/:id/arquivar` | P M | — | — | `RL-ESCRITA` | — |
| `GET /cartoes/:id/faturas` | P M V | Janela máxima de 5 anos de faturas por página | — | `RL-LEITURA` | A-22 |
| `GET /faturas/:id` | P M V | — | — | `RL-LEITURA` | — |
| `GET /faturas/:id/lancamentos` | P M V | Cursor assinado (§5.4) | — | `RL-LEITURA` | A-09 |
| `POST /faturas/:id/fechar` | P M | Fatura precisa estar `aberta` — transição condicional no `UPDATE`, não `if` na aplicação | — | `RL-ESCRITA` | — |
| `POST /faturas/:id/reabrir` | **P** | Grava motivo obrigatório em `auditoria`; notifica todos os proprietários | — | `RL-ESCRITA` | **A-20** |
| `POST /faturas/:id/pagamentos` | P M | Cria `Transferencia` (duas pernas). A conta de origem é do mesmo tenant e da mesma moeda — verificado no servidor, nunca inferido do corpo | — | `RL-ESCRITA` | — |

`POST /faturas/:id/reabrir` restrita a `proprietario` fecha A-20: a regra existia em `sistema.md` §7 (ADR 0013 proposta) e não existia em §4.1. Agora existe em um lugar só, e é este.

### 3.5 `categorias` e `etiquetas`

| Rota | Papéis | Verificação além de sessão + tenant | Reaut. | RL | Achado |
|---|---|---|:--:|---|---|
| `GET /categorias` | P M V | — | — | `RL-LEITURA` | — |
| `POST /categorias` | P M | — | — | `RL-ESCRITA` | — |
| `PATCH /categorias/:id` | P M | Categoria de sistema: renomear e arquivar sim, excluir nunca (`CONTEXT.md`) | — | `RL-ESCRITA` | — |
| `POST /categorias/:id/arquivar` | P M | — | — | `RL-ESCRITA` | — |
| `GET /etiquetas` | P M V | — | — | `RL-LEITURA` | — |
| `POST /etiquetas` | P M | — | — | `RL-ESCRITA` | — |
| `PATCH /etiquetas/:id` | P M | — | — | `RL-ESCRITA` | — |
| `DELETE /etiquetas/:id` | P M | Soft delete; não apaga o vínculo histórico em `lancamento_etiquetas` | — | `RL-ESCRITA` | — |

### 3.6 `lancamentos` — o núcleo

| Rota | Papéis | Verificação além de sessão + tenant | Reaut. | RL | Achado |
|---|---|---|:--:|---|---|
| `GET /lancamentos` | P M V | Cursor assinado e vinculado a tenant + filtro (§5.4). Janela do filtro ≤ 5 anos | — | `RL-LEITURA` | A-09, A-10, A-22 |
| `GET /lancamentos/resumo` | P M V | Mesmo `zFiltroLancamentos` da listagem; janela ≤ 5 anos validada **antes** de tocar o SQL | — | `RL-AGREGADA` | A-11, A-22 |
| `GET /lancamentos/agenda` | P M V | Horizonte fixo: 90 dias para trás, 180 para frente. Não aceita janela livre | — | `RL-LEITURA` | A-22 |
| `POST /lancamentos` | P M | `conta_id`/`cartao_id`/`categoria_id` do corpo existem **no tenant** (RLS cobre); resposta a id inexistente e a id de outro tenant é idêntica (404) | — | `RL-ESCRITA` | A-24 |
| `GET /lancamentos/:id` | P M V | — | — | `RL-LEITURA` | — |
| `PATCH /lancamentos/:id` | P M | Recusa (409) se o lançamento pertence a `transfer_group_id` ou a `installment_group_id` e o campo editado é estrutural (valor, conta, data) | — | `RL-ESCRITA` | A-23 |
| `DELETE /lancamentos/:id` | P M | **Recusa (409, `LANCAMENTO_PERTENCE_A_TRANSFERENCIA`) qualquer lançamento com `transfer_group_id` não nulo, e (409, `PARCELA_NAO_EXCLUIVEL_ISOLADAMENTE`) qualquer parcela isolada** | — | `RL-ESCRITA` | **A-23** |
| `POST /lancamentos/:id/efetivar` | P M | — | — | `RL-ESCRITA` | — |
| `POST /lancamentos/:id/desefetivar` | P M | Recusa se o lançamento pertence a fatura `fechada` ou `paga` | — | `RL-ESCRITA` | — |
| `POST /lancamentos/lote` | P M | Teto de **500** ids (Zod). Autorização e as recusas de A-23 verificadas **por item**. Transação única. Uma entrada em `auditoria` com a lista de ids. Lote que exclui > 50 notifica o titular | — | `RL-ESCRITA` | **A-21** |

### 3.7 `transferencias`, `parcelamentos`, `recorrencias`

| Rota | Papéis | Verificação além de sessão + tenant | Reaut. | RL | Achado |
|---|---|---|:--:|---|---|
| `POST /transferencias` | P M | Origem e destino no mesmo tenant e mesma moeda; origem ≠ destino | — | `RL-ESCRITA` | — |
| `GET /transferencias/:id` | P M V | — | — | `RL-LEITURA` | — |
| `DELETE /transferencias/:id` | P M | Exclui as duas pernas na mesma transação; a constraint de soma zero considera `deleted_at IS NULL` | — | `RL-ESCRITA` | A-23 |
| `POST /parcelamentos` | P M | Teto de `total_parcelas` (120) validado por Zod — sem teto, uma chamada materializa série ilimitada | — | `RL-ESCRITA` | A-22 |
| `GET /parcelamentos/:id` | P M V | — | — | `RL-LEITURA` | — |
| `PATCH /parcelamentos/:id` | P M | Só parcelas futuras; recusa se alguma parcela alvo está em fatura `fechada` | — | `RL-ESCRITA` | — |
| `DELETE /parcelamentos/:id` | P M | Exclui o grupo e as N parcelas (soft delete) | — | `RL-ESCRITA` | — |
| `GET /recorrencias` | P M V | — | — | `RL-LEITURA` | — |
| `POST /recorrencias` | P M | — | — | `RL-ESCRITA` | — |
| `PATCH /recorrencias/:id` | P M | — | — | `RL-ESCRITA` | — |
| `DELETE /recorrencias/:id` | P M | — | — | `RL-ESCRITA` | — |
| `GET /recorrencias/:id/ocorrencias?ate=` | P M V | **`ate` com horizonte máximo de 24 meses**, validado antes de materializar qualquer série | — | `RL-AGREGADA` | **A-22** |

### 3.8 `planejamentos` e `objetivos`

| Rota | Papéis | Verificação além de sessão + tenant | Reaut. | RL | Achado |
|---|---|---|:--:|---|---|
| `GET /planejamentos?competencia=` | P M V | `competencia` é uma única competência, nunca um intervalo | — | `RL-LEITURA` | — |
| `PUT /planejamentos` | P M | Upsert; `categoria_id` do tenant | — | `RL-ESCRITA` | — |
| `POST /planejamentos/copiar?de=&para=` | P M | `de` e `para` são competências únicas e distintas; operação idempotente e não destrutiva | — | `RL-ESCRITA` | — |
| `DELETE /planejamentos/:id` | P M | — | — | `RL-ESCRITA` | — |
| `GET /objetivos` | P M V | — | — | `RL-LEITURA` | — |
| `POST /objetivos` | P M | `conta_id`, quando informado, é do tenant | — | `RL-ESCRITA` | — |
| `PATCH /objetivos/:id` | P M | — | — | `RL-ESCRITA` | — |
| `POST /objetivos/:id/aportes` | P M | **O `lancamento_id` vem do corpo.** Servidor valida: existe no tenant, não está vinculado a outro `Objetivo`, o objetivo é do modo "por aportes", moedas coincidem. Resposta a id inexistente e a id de outro tenant é **idêntica** (404) | — | `RL-ESCRITA` | **A-24** |
| `DELETE /objetivos/:id/aportes/:lancamentoId` | P M | Idem | — | `RL-ESCRITA` | A-24 |
| `POST /objetivos/:id/arquivar` | P M | — | — | `RL-ESCRITA` | — |

### 3.9 `relatorios`

Cinco rotas, uma linha — as condições são idênticas e devem ser implementadas por um schema comum, não copiadas cinco vezes.

| Rota | Papéis | Verificação além de sessão + tenant | Reaut. | RL | Achado |
|---|---|---|:--:|---|---|
| `GET /relatorios/categorias` · `/entradas-saidas` · `/contas` · `/etiquetas` · `/evolucao` | P M V | `zPeriodoRelatorio`: `de <= ate`, janela ≤ **5 anos**, ambos parseáveis como data. Rejeição é **400 sem consultar o banco**. Agregação sempre no banco, nunca em memória | — | `RL-AGREGADA` | **A-22** |

### 3.10 `importacoes` e `anexos` — entrada hostil

| Rota | Papéis | Verificação além de sessão + tenant | Reaut. | RL | Achado |
|---|---|---|:--:|---|---|
| `POST /importacoes` (upload) | P M | Corte de 25 MB no Traefik; 10 MB de OFX/CSV; 20.000 linhas; leitura em **streaming** com contagem de bytes; 1 upload simultâneo por tenant; parsing em processo filho sem segredo e sem rede (A-34); DTD e entidades externas desabilitadas (A-32) | — | `RL-CARA` | A-32, A-33, A-34 |
| `GET /importacoes/:id` | P M V | — | — | `RL-LEITURA` | — |
| `GET /importacoes/:id/brutos` | P M V | **`zBrutoResposta` é allowlist:** `id, posted_at, descricao_origem, valor, moeda, status, marca`. O campo `payload` não sai por esta nem por nenhuma outra rota, para nenhum papel | — | `RL-LEITURA` | **A-25** |
| `POST /importacoes/:id/promover` | P M | Autorização por item quando o corpo traz seleção; teto de 20.000 | — | `RL-ESCRITA` | A-21 |
| `POST /importacoes/:id/desfazer` | P M | Janela de 7 dias; reverte o lote inteiro; uma entrada em `auditoria` | — | `RL-ESCRITA` | A-06 |
| `POST /anexos` | P M | Aceitação por **magic bytes**, não por extensão nem `Content-Type`. Allowlist: PDF, JPEG, PNG, HEIC, CSV, OFX. **SVG proibido.** 20 MB. `storage_key` gerado pelo servidor (UUID), nunca derivado do nome enviado. 1 anexo por lançamento no MVP | — | `RL-CARA` | **A-31**, A-36 |
| `GET /anexos/:id` | P M V | A rota de download **revalida sessão, tenant e vínculo do anexo ao lançamento** — o `storage_key` não é segredo. URL assinada TTL ≤ 15 min, uso único, domínio distinto do da sessão, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`. Cada download é registrado (B-13) | — | `RL-LEITURA` | A-36 |
| `DELETE /anexos/:id` | P M | Apaga a linha **e** o objeto do storage | — | `RL-ESCRITA` | B-12 |

`POST /anexos`, `GET /anexos/:id` e `DELETE /anexos/:id` não existem em `sistema.md` §4.1 — aparecem só no mapa tela→endpoint. Estão declarados aqui e **precisam entrar em `packages/contracts` antes de qualquer implementação** (A-31).

### 3.11 `conexoes` e `conciliacoes`

| Rota | Papéis | Verificação além de sessão + tenant | Reaut. | RL | Achado |
|---|---|---|:--:|---|---|
| `GET /conexoes` | P M V | Metadados apenas. `credenciais_cifradas`, `dek_cifrada`, `escopo` bruto e qualquer token **nunca** aparecem (R-5) | — | `RL-LEITURA` | A-38 |
| `POST /conexoes` | P M | Credenciais são *write-only* no schema: `zConexaoResposta` não possui os campos. Nenhum handler de erro serializa `request.body`. Grava `conexoes.criado_por` e o `Consentimento` versionado na mesma transação | sim | `RL-CARA` | **A-38** |
| `POST /conexoes/:id/sincronizar` | P M | Teto de 6 sincronizações por conexão por dia, visível na tela | — | `RL-EXTERNA` | — |
| `GET /conexoes/:id/sincronizacoes` | P M V | — | — | `RL-LEITURA` | — |
| `DELETE /conexoes/:id` (revoga) | P, ou ⊙ o autor do consentimento | **Sem reautenticação, por desenho** — revogar precisa ser de um toque (art. 8º §5º). Executa sincronamente, antes de responder 200: zera credenciais, remove jobs da fila, chama `BankSyncProvider.revogar()`. Ver `retencao-e-eliminacao.md` §10 | — | `RL-ESCRITA` | **B-14, B-15** |
| `GET /conciliacoes` | P M V | Cursor assinado | — | `RL-LEITURA` | A-09 |
| `POST /conciliacoes/:id/aceitar` | P M | Nunca sobrescreve o registro do usuário (regra 15) | — | `RL-ESCRITA` | — |
| `POST /conciliacoes/:id/rejeitar` | P M | — | — | `RL-ESCRITA` | — |

### 3.12 `atividades`, `alertas`, `preferencias`

| Rota | Papéis | Verificação além de sessão + tenant | Reaut. | RL | Achado |
|---|---|---|:--:|---|---|
| `GET /atividades` | P M V | **`P` vê todas as atividades do espaço. `M` e `V` veem todas as financeiras, e das de segurança/conta apenas as próprias** (login, senha, sessões, MFA, membros, billing, chaves de API). `ip_hash` e `user_agent_hash` nunca saem. Cursor assinado, sem `auditoria.id` em claro | — | `RL-LEITURA` | **A-26**, A-08, A-09 |
| `GET /alertas` | ⊙ | `usuario_id = TenantContext.usuarioAtual()` além da RLS | — | `RL-LEITURA` | **A-27** |
| `POST /alertas/:id/lido` | ⊙ | Idem. Marcar como lida a notificação de outro membro do mesmo tenant é **403** | — | `RL-ESCRITA` | **A-27** |
| `GET /alertas/preferencias` | ⊙ | PK `(tenant_id, usuario_id)` — a RLS sozinha não basta | — | `RL-LEITURA` | A-27 |
| `PUT /alertas/preferencias` | ⊙ | Idem | — | `RL-ESCRITA` | A-27 |
| `GET /preferencias` | ⊙ | Idem | — | `RL-LEITURA` | A-27 |
| `PUT /preferencias` | ⊙ | Idem. `PUT /preferencias` **não** aceita `usuario_id` no corpo — o campo é ignorado se enviado, e a presença dele é registrada como tentativa | — | `RL-ESCRITA` | A-27 |

### 3.13 `exportacoes` — a rota mais valiosa do produto para um atacante

| Rota | Papéis | Verificação além de sessão + tenant | Reaut. | RL | Achado |
|---|---|---|:--:|---|---|
| `POST /exportacoes` | P M | (1) `visualizador` nunca. (2) Reautenticação obrigatória quando o escopo é "tudo". (3) `zEscopoExportacao` enumera entidades — escopo livre é rejeitado. (4) **A exportação nunca contém mais do que o solicitante já pode ler pela API** — o gerador aplica a mesma matriz, e para `M`/`V` filtra as atividades de segurança de outros membros. (5) Gera entrada em `auditoria` **e** notificação imediata por e-mail e push a todos os proprietários, com IP mascarado e horário | **sim** (escopo "tudo") | `RL-CARA` (3/h, 10/dia por tenant) | **A-28**, B-02 |
| `GET /exportacoes/:id` | ⊙ (só quem pediu) | URL assinada com TTL ≤ **15 min**, **uso único**, domínio distinto do da sessão, `Content-Disposition: attachment`, `Content-Type: application/octet-stream`. `exportacoes.expira_em` ≤ 7 dias, com job que apaga **o objeto do storage**, não só a linha. Cada download é registrado (B-13) | — | `RL-LEITURA` | **A-28** |

Escopo OAuth `exportacoes:*` **não existe** e não pode ser criado (§6).

### 3.14 `sync` — endpoints do mobile (hoje sem contrato)

**Nenhuma linha de `apps/mobile` começa antes de `zSyncMutacoes` e `zSyncMudancas` existirem em `packages/contracts`.** Endpoint sem contrato é endpoint sem validação de entrada e sem autorização — A-29.

| Rota | Papéis | Verificação além de sessão + tenant | Reaut. | RL | Achado |
|---|---|---|:--:|---|---|
| `POST /sync/mutacoes` | conforme a rota equivalente, **por item** | Teto de **200** mutações por lote. `mutacao_id` gerado no cliente com `UNIQUE (tenant_id, mutacao_id)` no servidor. Cada mutação passa pelo **mesmo guard** da rota de §4.1 correspondente — uma mutação de lançamento é autorizada como `POST /lancamentos`, uma de exclusão como `DELETE /lancamentos/:id`, inclusive as recusas de A-23. **O `PlanoDeSync` de `domain/sincronizacao-offline` não é autoridade de autorização**; o servidor revalida tudo | — | soma na cota da rota equivalente | **A-29** |
| `GET /sync/mudancas?desde=` | P M V | `desde` limitado a **90 dias**; teto de 1.000 registros por resposta; cursor assinado. É um changefeed do tenant inteiro: **conta como leitura em massa** e é registrado em `auditoria` (B-13), com alerta quando um cliente lê acima do seu padrão | — | `RL-AGREGADA` | **A-29**, B-13 |

### 3.15 `inteligencia`

| Rota | Papéis | Verificação além de sessão + tenant | Reaut. | RL | Achado |
|---|---|---|:--:|---|---|
| `POST /inteligencia/sugerir-categoria` | P M | **Método `POST`, nunca `GET`** — descrição de lançamento em query string vai para o log de acesso do Traefik, para o histórico do navegador e para o referer. Corpo mínimo: só a descrição, nunca valor, nunca `payload` bruto, nunca o lançamento inteiro. **Bloqueada enquanto B-11 não estiver decidido**: se o destino for terceiro, exige contrato de operador, aviso no ponto de uso e opt-out por tenant | — | `RL-IA` (60/min) | **A-30**, B-11 |
| `POST /inteligencia/ler-recibo` | P M | Idem, mais: OCR em processo filho sem segredo e sem rede (A-34); consentimento separado do de categorização se o OCR for de terceiro (B-12); o resultado **sugere**, nunca preenche valor sozinho | — | `RL-IA` | A-34, B-12 |

### 3.16 MCP e chaves de API (pós-MVP, especificado agora)

Estas rotas não existem em `sistema.md` §4.1 e a superfície inteira estava desenhada por três frases de prosa (A-40). Elas entram aqui para que nasçam com autorização, e não para que sejam implementadas antes do épico 12.

| Rota | Papéis | Verificação além de sessão + tenant | Reaut. | RL | Achado |
|---|---|---|:--:|---|---|
| `GET /oauth/autorizar` | P | OAuth 2.1: `authorization_code` + **PKCE S256 obrigatório**; sem grant implícito, sem `password` grant; `redirect_uri` registrada e comparada por **igualdade exata**; `state` obrigatório. Autorização é **por tenant**, escolhido pelo usuário — nunca por usuário através de todos os seus tenants | sim | `RL-AUTH` | A-40 |
| `POST /oauth/token` | cliente registrado | Cliente registrado manualmente e revisado; sem *dynamic client registration* | — | `RL-AUTH` | A-40 |
| `GET /apps-conectados` | P | Lista autorizações do tenant: cliente, escopos, concedido em, expira em, último uso | — | `RL-LEITURA` | A-40 |
| `DELETE /apps-conectados/:id` | P | Revogação com efeito **≤ 60 s** — tokens são opacos e verificados contra o banco/Redis a cada requisição, nunca JWT auto-contido de longa duração | — | `RL-ESCRITA` | A-40 |
| `GET /chaves-api` | P | Só `ultimos_4`, escopo, criada em, expira em, `ultimo_uso_em`. Nunca o segredo | — | `RL-LEITURA` | A-40 |
| `POST /chaves-api` | P | Formato `mavia_sk_<32 bytes base62>` com prefixo varrível em repositórios públicos; exibida **uma única vez**; armazenada como SHA-256. Escopo e **expiração obrigatórios** (máx. 365 dias, padrão 90) — chave sem prazo não é criável | sim | `RL-CARA` | A-40 |
| `DELETE /chaves-api/:id` | P | Efeito ≤ 60 s | — | `RL-ESCRITA` | A-40 |

### 3.17 `billing` — assinatura, cobrança e o webhook (épico 11)

A linha `billing` da §2.3 (`ler` · `editar` — só `proprietario`) já cobre as rotas de produto. O que faltava era a rota que **não tem sessão**.

| Rota | Papéis | Verificação além de sessão + tenant | Reaut. | RL | Achado |
|---|---|---|:--:|---|---|
| `GET /assinatura` | P | Nunca devolve `documento` nem dado de outro membro. `metodo_ultimos4` e `metodo_marca` só para `P` | — | `RL-LEITURA` | ADR 0020 |
| `GET /planos` | P M V **anon** | Catálogo público, em código (ADR 0020 D3). Nenhum dado de tenant na resposta | — | `RL-LEITURA` | — |
| `POST /assinatura/checkout` | P | Cria a sessão na Stripe com `Idempotency-Key` determinística. **Recusa se houver excesso de cota** no plano pedido (§8.1 do spec) | — | `RL-CARA` | ADR 0020 D1 |
| `POST /assinatura/portal` | P | Devolve URL de sessão do portal da Stripe, de uso único e curta | — | `RL-CARA` | — |
| `POST /assinatura/reembolso` | P | Aplica a fórmula do §6.3 do spec; `Idempotency-Key` por `stripe_invoice_id` | **✓** | `RL-CARA` | ADR 0020 D1 |
| `POST /assinatura/reconferir` | P | O botão "já paguei": força releitura na Stripe. Existe porque webhook cai | — | `RL-CARA` | — |
| `PUT /dados-fiscais` | P | Um campo, validação por dígito verificador, **sem nenhuma chamada de rede**. Nunca aceito durante o estado `teste` | — | `RL-ESCRITA` | ADR 0020 D4 |
| **`POST /webhooks/stripe`** | **`publica-assinada`** | **Nenhuma sessão, nenhum tenant no contexto.** Verificação HMAC sobre o **corpo cru**, antes de qualquer parse, tolerância ≤ 5 min. Corpo inválido → `400`, zero escritas. A resposta **nunca revela** se um `Customer` existe, e é idêntica em conteúdo e tempo nos dois casos. Grava o evento e devolve `2xx`; o trabalho vai para job | — | `RL-WEBHOOK` | ADR 0020 D1 |

**`publica-assinada` é uma declaração, não uma ausência.** O guard global nega por padrão e uma rota sem declaração **não sobe** (`sistema.md` §4.0). O webhook não pode declarar papel — quem chama é a Stripe, sem sessão —, mas também não pode ficar fora do manifesto: sem entrada, o teste de S2 que percorre as rotas do OpenAPI a acusaria, e a correção preguiçosa seria isentá-la da verificação. Por isso o valor existe, e ele carrega uma obrigação própria: **toda rota `publica-assinada` declara qual assinatura criptográfica a autoriza e onde o segredo dela vive.** Hoje há exatamente uma.

**Duas armadilhas de implementação, nomeadas para não serem redescobertas:**

1. **O corpo cru precisa chegar intacto ao verificador.** O Fastify não pode consumir e reserializar o JSON desta rota — a assinatura é sobre os bytes originais. Um `body parser` global aplicado sem exceção quebra a verificação de um jeito que parece problema de chave.
2. **Nada de trabalho lento dentro do handler.** Estourar o tempo da Stripe faz **ela retentar**, e retentativa somada a trabalho parcial é exatamente como se cobra duas vezes. Grava o evento, responde, processa em job.

**`dados_fiscais.documento` entra na regra R-5** (§1): junto de `senha_hash`, `refresh_hash`, `mfa_segredo_cifrado`, `credenciais_cifradas`, `dek_cifrada`, `ip_hash`, `user_agent_hash` e `lancamentos_brutos.payload`, ele **nunca** sai em resposta de API para quem não é `proprietario`, nem na exportação de outro membro, nem em log, métrica ou notificação.

### 3.18 `saude` e `metricas` — fora da superfície de produto

| Rota | Papéis | Verificação | Reaut. | RL | Achado |
|---|---|---|:--:|---|---|
| `GET /saude` | — | Escuta na porta e interface interna. Responde **apenas** `{status}`: sem versão, sem nome de host, sem estado de dependências | — | — | **A-07** |
| `GET /metricas` | — | Porta e interface separadas (`127.0.0.1` ou rede interna do compose), **nunca roteada pelo Traefik para a internet**, e exige credencial. Nenhuma métrica recebe `tenant_id`, `conta_id`, `usuario_id` ou e-mail como *label*. `mavia_saldo_divergencia_centavos` vira contador de **ocorrências** e histograma de faixas — nunca o valor | — | — | **A-07** |

Estas duas rotas não têm papel porque não pertencem ao modelo de papéis: elas não são acessíveis por nenhum caminho que atenda um usuário. Declarar `papel: nenhum` é diferente de esquecer de declarar, e o guard global distingue as duas coisas.

---

## 4. Reautenticação (step-up)

**Doze operações** exigem senha ou MFA no ato, mesmo com sessão válida. O critério: a operação amplia acesso, destrói dado, tira dado do sistema — ou tira dinheiro. A décima segunda entrou com o épico 11 (ADR 0020).

> `spec-autenticacao.md` §8 reescreve “senha ou MFA” em termos de **fator**, para contas que entram só pelo Google. A linha nova segue a mesma reescrita, sem exceção.

| Categoria | Operações |
|---|---|
| **Exportação de dados** | `POST /exportacoes` com escopo "tudo" |
| **Exclusão** | `DELETE /auth/eu` · `DELETE /tenants/:id` · `POST /tenants/:id/comecar-do-zero` |
| **Rotação/entrada de credencial** | `POST /auth/senha/alterar` · `POST /auth/mfa/inscrever` · `POST /auth/mfa/confirmar` · `DELETE /auth/mfa` · `POST /conexoes` · `POST /chaves-api` |
| **Dinheiro saindo** | `POST /assinatura/reembolso` — move dinheiro para fora e não tem desfazer |
| **Escalada de privilégio** | `PATCH /tenants/:id/membros/:usuarioId` · `DELETE /tenants/:id/membros/:usuarioId` (quando `P` remove outro) · `GET /oauth/autorizar` |

**Mecanismo.** `POST /auth/reautenticar` emite um *ticket de step-up*: opaco, 5 min de validade, escopado à `(acao, recurso)` pedida, de uso único, guardado no Redis com o `sessao_id`. A rota protegida exige o header `X-Mavia-StepUp` e consome o ticket na mesma transação. Um ticket emitido para exportar não serve para promover membro — o escopo é comparado, não apenas a existência.

**O que não exige reautenticação, por decisão explícita:** `DELETE /conexoes/:id` (revogar consentimento é direito do titular e precisa ser de um toque) e `POST /auth/sessoes/revogar-todas` (é a ação que alguém executa exatamente quando suspeita de comprometimento — exigir a senha ali é exigir a senha de quem talvez já a tenha perdido).

---

## 5. Rate limit e tetos

### 5.1 As classes

Contador em Redis, chave por `(usuario_id, classe)` — e por `(hash do e-mail)` e `(IP)` nas rotas anônimas. Nunca o e-mail em claro na chave.

| Classe | Teto | Rotas |
|---|---|---|
| `RL-AUTH` | 5/15 min por e-mail, 20/15 min por IP, atraso progressivo 0/1/2/4/8 s, bloqueio 15 min | `auth/*`, `oauth/*`, aceite de convite |
| `RL-LEITURA` | 60/min por `(usuario_id, rota)` | listagens e leituras simples |
| `RL-AGREGADA` | 10/min por `(usuario_id, rota)` | `resumo`, `relatorios/*`, `contas/saldos`, `ocorrencias`, `sync/mudancas` |
| `RL-ESCRITA` | 120/min por `usuario_id` | escritas comuns |
| `RL-CARA` | 3/h e 10/dia por tenant | `POST /exportacoes`, `POST /importacoes`, `POST /anexos`, `POST /tenants`, `POST /chaves-api`, exclusões de espaço |
| `RL-EXTERNA` | 6/dia por conexão | `POST /conexoes/:id/sincronizar` |
| `RL-IA` | 60/min por `usuario_id` | `inteligencia/*` |
| `RL-CONVITE` | 20/dia por tenant, 10 convites pendentes simultâneos | `POST /tenants/:id/convites` |
| `RL-PROGRAMATICO` | 1/3 do teto da classe correspondente, por token/chave | qualquer requisição autenticada por OAuth ou chave de API |
| `RL-WEBHOOK` | 600/min por IP de origem, **sem bloqueio por e-mail ou usuário** — não há nenhum dos dois. Excesso responde `429`, que a Stripe trata como retentativa | `POST /webhooks/stripe` |

### 5.2 Tetos de janela e de tamanho

Validados por Zod **antes** de qualquer consulta; a rejeição é 400 sem tocar o banco.

| Parâmetro | Teto |
|---|---|
| Janela de filtro de lançamentos e de relatório | 5 anos, `de <= ate` |
| `recorrencias/:id/ocorrencias?ate=` | 24 meses |
| `sync/mudancas?desde=` | 90 dias, 1.000 registros por resposta |
| `POST /lancamentos/lote` | 500 ids |
| `POST /sync/mutacoes` | 200 mutações |
| `total_parcelas` | 120 |
| Página de listagem | 100 itens, padrão 50 |

### 5.3 Tetos de banco

`statement_timeout` definido **no papel de banco**, não por chamada: 5 s para `mavia_app`, 60 s para `mavia_jobs`. Uma consulta que passa disso é um defeito, não uma consulta lenta.

### 5.4 Cursor assinado

Toda rota paginada usa `base64url(payload) || '.' || HMAC-SHA256(payload, chave_de_cursor)`, com `payload = { posted_at, id, hash_do_filtro, tenant_id }`. O servidor recusa (400 genérico) MAC inválido, `tenant_id` diferente do contexto, ou `hash_do_filtro` diferente do filtro corrente. **É proibido consultar a tabela pelo `id` do cursor** — a resolução é puramente aritmética, ou a paginação vira oráculo de existência (A-10). Vale para `lancamentos`, `atividades`, `lancamentos_brutos`, `faturas/:id/lancamentos`, `conciliacoes` e `sync/mudancas`.

A chave de cursor é um segredo de aplicação comum, não da hierarquia do ADR 0018: seu comprometimento não atravessa a fronteira de tenant, porque o servidor compara o `tenant_id` do payload com o do contexto de sessão. Já o *pepper* de `ip_hash` (A-39) vive no guardião de chaves, porque comprometê-lo despseudonimiza — a distinção está registrada no ADR 0018 §D9.

---

## 6. Escopos de OAuth/MCP e chaves de API

**Escopos existentes**, apresentados em português na tela de autorização, com **somente leitura como padrão** e escrita por caixa desmarcada:

`lancamentos:ler` · `lancamentos:escrever` · `contas:ler` · `cartoes:ler` · `faturas:ler` · `categorias:ler` · `etiquetas:ler` · `relatorios:ler` · `planejamento:ler` · `planejamento:escrever` · `objetivos:ler` · `objetivos:escrever`

**Escopos proibidos para qualquer cliente externo, sem exceção e sem possibilidade de concessão:**

| Escopo vetado | Por quê |
|---|---|
| `exportacoes:*` | Um agente com "leitura" chamaria `POST /exportacoes` e levaria tudo em uma requisição — a ausência desta linha era o achado mais perigoso de A.6 |
| `conexoes:*` | Credenciais bancárias e revogação de consentimento |
| `tenants:*` | Gestão de membros é escalada de privilégio |
| `auth:*` | Sessões, senha, MFA |
| `atividades:*` | O log de acesso não é legível por quem ele existe para vigiar |
| `anexos:*` | Comprovantes contêm dado sensível por inferência (B-06, B-12) |
| `chaves-api:*` · `apps-conectados:*` | Um token que emite tokens é acesso perpétuo |

**Prazos.** Access token ≤ 15 min. Refresh rotativo com detecção de reuso (A-14). A **autorização** expira em 90 dias e exige reconsentimento — não existe acesso perpétuo. Chave de API sem uso por 90 dias é desativada por job, com aviso prévio.

**Log.** Toda requisição autenticada por token OAuth ou chave de API registra em `auditoria`: cliente, escopo exercido, rota, **contagem de registros retornados** e horário. A tela Atividades distingue visualmente ator humano de ator programático: "quem mexeu nisso" precisa poder responder *"o app X, via MCP, às 03:12"*.

---

## 7. O que este documento **não** decide

- **A ordem de implementação.** Isto é a matriz, não o cronograma. As rotas de §3.16 são do épico 12.
- ~~**DP-1**~~ — **resolvida em 2026-09-01:** `membro` pode conectar banco.
- ~~**DP-2 a DP-4**~~ — **resolvidas em 2026-09-01.** Convidar e criar chave: só `proprietario`. Excluir lançamento de outro membro: permitido.
- **Se o destino de `inteligencia/*` é local ou terceiro** — de `engenheiro-dados-ia` + `especialista-lgpd-compliance`, via ADR (B-11). Enquanto não houver ADR, a rota fica bloqueada, não permissiva.
- **A credencial de `/metricas`** e a topologia de rede que a isola — de `sre-devops-vps` (A-04, A-07).
- **O destino dos dados já sincronizados após revogação** — ADR conjunta com `especialista-open-finance` (B-16). A matriz declara quem pode revogar; não declara o que acontece com o histórico.

---

## 8. Casos de abuso que provam esta matriz

Entregues ao `engenheiro-qa-automacao` junto com os tickets, não depois deles. Todos cabem em S2, nenhum seam novo.

| ID | Caso | Regra que prova |
|---|---|---|
| `AB-04` | `membro` chama `PATCH /tenants/:id/membros/<ele mesmo>` promovendo-se a `proprietario` → 403 | R-4.1 e R-4.2 |
| `AB-05` | `:id` de tenant no path diferente do da sessão, nas **oito** rotas de `/tenants` → 403 e zero linhas lidas | **R-3** |
| `AB-08` | Membro A marca como lida a notificação de B e escreve a preferência de B, mesmo tenant → 403 nos dois | R-2 |
| `AB-09` | 5 chamadas seguidas a `POST /exportacoes` → a 4ª é 429; cada sucesso notificou os proprietários | §3.13 |
| `AB-18` | Token MCP com `lancamentos:ler` tenta `POST /exportacoes`, `GET /conexoes` e `POST /lancamentos` → 403 nos três; revogar corta em ≤ 60 s | §6 |
| `AB-23` | Último `proprietario` de um tenant com outros membros tenta se rebaixar e ser removido → rejeitado pelo **banco**, não pela aplicação | R-4.3 |
| `AB-24` | `visualizador` percorre **todas** as rotas de escrita da matriz → 403 em todas, sem exceção | §2.1 |
| `AB-25` | Uma rota é adicionada ao Nest sem entrada nesta matriz → o processo **não sobe** | R-1 |
| `AB-26` | `M` e `V` chamam `GET /tenants/:id/membros` → resposta sem e-mail; `P` chama → com e-mail | §3.2 |
| `AB-27` | `M` chama `GET /atividades` → nenhuma atividade de segurança de outro usuário, nenhum `ip_hash` em nenhuma resposta | §3.12, R-5 |
| `AB-28` | Ticket de step-up emitido para `exportacao` é apresentado em `PATCH /tenants/:id/membros/:usuarioId` → 403 | §4 |
