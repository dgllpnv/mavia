# Design — Perfil de administrador

- **Data:** 2026-09-04
- **Status:** **v2 — reescrito após o gate de risco.** A v1 foi reprovada pelos dois revisores. Aguarda reabertura do gate.
- **Escopo:** o painel interno de operação da Mavia — quem são os clientes, qual o plano, o que foi pago, e o registro imutável do que o operador fez.
- **Fora de escopo:** MFA, cobrança automática pela Stripe (P-14), atendimento ao cliente dentro do produto.

---

## Problema

A Mavia está no ar e não tem como ser operada. Não há caminho para responder às perguntas que qualquer SaaS precisa responder no primeiro mês: quem são os clientes, quem pagou, quem está em atraso, e o que fizemos na conta de alguém quando ele reclamar.

Hoje isso só se resolve com `psql` na VPS. Um `UPDATE assinaturas` digitado à mão às onze da noite não tem revisão, não tem registro, e não tem como ser explicado depois.

O risco central não é construir as telas. É que **o painel atravessa o isolamento por RLS que é a espinha do produto** — pela primeira vez, alguém lê o espaço de um cliente sem pertencer a ele.

---

## O que a v1 errou

A v1 alegava: *"não é possível ler sem registrar, porque as duas coisas são a mesma transação"*. O gate mostrou que a frase era **falsa como escrita**, por três caminhos independentes — e que a salvaguarda que ela citava não existe.

| O que a v1 dizia | O que é verdade |
|---|---|
| "a regra de lint que hoje proíbe `withTenant(req.params.…)`" | **Ela não existe.** `eslint.config.js` tem quatro regras e nenhuma é essa. A função se chama `comTenant`, não `withTenant` |
| a nova cláusula de lint procuraria `SET LOCAL app.tenant_id` | O literal **não aparece no código**: `tenancy.ts:76-80` usa `set_config($1,$2,true)`. O lint casaria com zero linhas |
| "fora de `comTenantDeAdmin` não há como definir `app.tenant_id` de outro espaço" | `comTenant` aceita `tenantId: string` e **não verifica pertencimento** (`tenancy.ts:64-84`). Qualquer rota do painel podia lê-lo sem log |

**A matriz de acesso §R-3 afirma essa regra de lint desde que foi escrita.** É um controle de papel, e este épico é quem o descobre. A v1 o citou de boa-fé e o propagou; a v2 não cita controle que não tenha sido verificado no código.

> **Regra que passa a valer neste documento:** nenhuma salvaguarda é citada sem arquivo e linha. Onde a verificação foi feita, ela está anotada. Onde o controle não existe ainda, está marcado **a construir**.

---

## Decisões do dono do produto

| # | Pergunta | Decisão | Consequência registrada |
|---|---|---|---|
| **DA-1** | O admin enxerga os dados financeiros dos clientes? | **Sim, leitura completa** | Um painel comprometido entrega a vida financeira de toda a base |
| **DA-2** | O cliente é avisado quando um admin abre o espaço dele? | **Não.** Mantida em 2026-09-04, já sabendo o que segue | **Não é omissão: é código que oculta.** A matriz §3.12 dá ao `proprietario` *todas* as atividades do espaço, e as linhas do admin nascem com o `tenant_id` dele. Esconder exige um filtro deliberado, que é mais difícil de defender que a ausência de aviso |
| **DA-3** | Os bloqueantes do gate entram agora ou viram dívida? | **Agora, antes dos tickets** | É o que este documento executa |

**DA-2 continua reversível por configuração**, e a coluna `ator_tipo` (§3) é o que a torna reversível — não uma reescrita.

---

## O que restringe o desenho

| Restrição | Onde — verificado | Consequência |
|---|---|---|
| Tenant vem só da sessão; exceção **exige ADR** | matriz R-3 | O admin precisa de exceção nomeada |
| Nenhum papel de requisição tem `BYPASSRLS` | `sistema.md` §3.9, §983 | Cross-tenant não se resolve com privilégio |
| `mavia_app` tem **DML completo** em toda tabela de negócio | `0006_nucleo.sql:278` | "Só leitura" não acontece sozinho |
| `auditoria` especificada, nunca construída | `retencao-e-eliminacao.md` §3, §4, §8 | O log é ela |
| Não existe MFA | só colunas em `usuarios` | O admin fica a uma senha da base |
| Redis **sem senha**, sessão é JSON puro | `docker-compose.yml:94`, `cofre-de-acesso.ts:59-72` | Quem alcança o Redis **é** o admin |

---

## Arquitetura

### 1 · O acesso entre espaços

O admin assume o tenant alvo por uma transação. Quatro travas, e nenhuma delas é disciplina de quem escreve a rota.

**1.1 · A trava é de tipo, não de lint.** `ContextoDoTenant` passa a ser um *branded type* que **só** duas funções conseguem produzir: `resolverTenant` (que confere pertencimento) e `abrirEspacoComoAdmin`. `comTenant` deixa de aceitar `{ tenantId: string }` montado à mão — uma rota que tente compor o contexto não compila.

*A construir.* Verificado que hoje não há trava alguma: `tenancy.ts:64-84`.

**1.2 · Uma instrução liga o log ao alvo.** `SET LOCAL` não aceita parâmetro, então a v1 implicava interpolar um parâmetro de rota em SQL — e `node-pg` aceita múltiplas instruções numa consulta simples. A linha de auditoria podia dizer cliente A enquanto o `app.tenant_id` virava cliente B.

A v2 usa uma função SQL:

```sql
admin.abrir_espaco(p_alvo uuid, p_motivo motivo_de_acesso,
                   p_referencia text, p_acao text, p_rota text)
```

Ela faz o `INSERT INTO auditoria` **e** o `set_config('app.tenant_id', p_alvo, true)` com o **mesmo parâmetro vinculado, na mesma instrução**. Divergência entre o que foi auditado e o que foi efetivado deixa de ser expressável.

**1.3 · O papel dentro do espaço é somente-leitura.** `SET LOCAL ROLE mavia_admin`, um papel novo com `SELECT` nas tabelas de negócio e `INSERT` apenas em `auditoria`.

Dois avisos que o ticket carrega: um papel novo **não herda** policies escritas `TO mavia_app` — inclusive a `RESTRICTIVE usuario_escreve_so_a_propria_linha` (`0002_identidade.sql:173-176`) —, então ele nasce sem nenhum grant de escrita, e não com escrita "controlada por policy". E `tenancy.ts:48` interpola o papel na SQL (`SET LOCAL ROLE ${papel}`): aceitável **enquanto** o valor for constante de compilação, o que este é.

**1.4 · `app.usuario_id` é sempre o do operador.** Personificar o titular é **proibido**, e a proibição é normativa porque a correção "óbvia" vai na direção errada: as telas do cliente chaveadas por `usuario_id` (alertas, preferências, sessões — R-2) virão vazias no painel, e assumir o `usuario_id` do titular faria a policy restritiva de `0002:173` passar a autorizar `UPDATE usuarios SET senha_hash` **na linha do cliente**.

**Consequência aceita:** as telas `⊙` do cliente não são visíveis no painel. Está escrito aqui para não ser "descoberta" e revertida por conveniência.

**O que a atomicidade compra, exatamente.** Para **escrita**, "sem log não há efeito" é real: uma conexão, um `BEGIN`, um `COMMIT`. Para **leitura**, "a leitura desfaz" é retórica — as linhas já estão no processo quando o `COMMIT` roda. A janela residual é a falha de `COMMIT`, e fecha assim: **a resposta é montada estritamente depois de o `COMMIT` retornar**, e qualquer erro descarta o resultado.

E a afirmação é escopada: **nenhum caminho HTTP** lê entre tenants sem registrar. `mavia_jobs` lê entre tenants por desenho (`sistema.md:639-644`), e o agendador de recorrências já roda assim.

### 2 · A listagem, que a v1 não explicava

A v1 dizia que a listagem lê `tenants`, `usuarios` e `assinaturas` "por uma consulta própria", sem log. Isso é impossível com as policies atuais (`0001:118`, `0001:123`, `0025:136`) — e o caminho natural para viabilizá-la é o pior furo do documento.

> **Proibido:** qualquer policy em `tenants`, `usuarios` ou `tenant_usuarios` que conheça `administradores`. O precedente existe (`assinatura_lida_pelo_webhook … USING (true)`, `0025:163`) e é o que torna o erro fácil.
>
> **Por quê:** `resolverTenant` (`tenancy.ts:126-138`) consulta `tenant_usuarios` **sem predicado de `usuario_id`**, confiando inteiramente na policy. Uma policy que reconheça admin faria o operador mandar `X-Mavia-Tenant: <cliente>` no **app normal**, receber `papel`, e navegar o espaço pela interface do cliente — sem uma linha de auditoria, porque `abrirEspacoComoAdmin` nunca foi chamada.

**A v2:**

- a listagem sai de `admin.listar_clientes(busca, pagina)`, `SECURITY DEFINER`, com **projeção fixa** — espaço, titular, plano, estado, vence em, uso — e `EXECUTE` concedido só ao papel do painel;
- **a busca é evento**: uma linha por busca, com o termo hasheado e a contagem de resultados. Não uma linha por cliente listado, que era o argumento de ruído da v1;
- `resolverTenant` ganha `AND usuario_id = current_setting('app.usuario_id')::uuid`. É a segunda camada que a regra 16 exige e que `sistema.md:648` promete — *"todo repositório também filtra por `tenant_id` no `WHERE`"* — e que essa consulta não cumpre hoje.

### 3 · O log

A `auditoria` do `retencao-e-eliminacao.md`, com o que os dois gates acrescentaram.

```
auditoria (particionada por mês em ocorrido_em)
  id, ocorrido_em, tenant_id, usuario_id, ator_tipo,
  entidade, entidade_id, acao, classe, rota, registros,
  motivo, referencia, de, para, ip_hash, user_agent_hash
```

| Coluna nova | Por quê |
|---|---|
| `motivo` + `referencia` | O log respondia "quem leu", não "sob qual hipótese legítima". É o controle mais barato do épico e o único que muda o comportamento no momento do ato. Lista fechada: `chamado \| incidente \| defeito \| ordem_judicial`, com a referência obrigatória |
| `rota` + `registros` | "Abriu o espaço" não responde ao art. 48, que pede a natureza dos dados afetados. A matriz §6 já exige contagem de registros do ator programático |
| `ator_tipo` | Separa titular, membro e operador. É o que permite a projeção de `/atividades` e o que torna a **DA-2 reversível por configuração** |

**`tenant_id` é nulo** para eventos que não pertencem a espaço nenhum — conceder e revogar admin. A policy padrão os torna invisíveis a todos, o que é o desejado; fica declarado para que não seja acidente.

**De/para em claro para enum, id e dinheiro.** A v1 mandava hashear tudo, citando o §8.2 ao contrário: ele diz *"em claro apenas quando o valor é o objeto da mudança"*, e dar baixa em pagamento é exatamente esse caso. Hash e redação ficam para **texto livre e PII**. O §8.2 ganha os campos de `assinaturas` (`plano`, `intervalo`, `estado`, `periodo_fim`, `graca_ate`) na linha "estruturais — em claro"; sem isso o painel mostraria "alterou o plano" sem dizer de qual para qual.

#### 3.1 · A imutabilidade, com todos os furos fechados

`REVOKE UPDATE, DELETE ON auditoria FROM mavia_app` não basta, e o spec precisa dizer contra quem ela vale:

| Furo | Fechamento |
|---|---|
| **O dono ignora `REVOKE`.** As tabelas pertencem a `mavia_migrate`, que tem `BYPASSRLS` (`bootstrap-papeis.sql:45`) | Gatilho `BEFORE UPDATE OR DELETE … RAISE EXCEPTION`, que dispara **também para o dono** |
| **`TRUNCATE` é privilégio separado** e não está no `REVOKE` | Entra no `REVOKE`, e o gatilho `BEFORE TRUNCATE` o cobre |
| **Partição nova não é governada pelo `REVOKE` do pai**, e quem a cria vira dono dela | Partições dos próximos 24 meses criadas pela **própria migration**, com os grants e o gatilho aplicados a cada uma |
| **Sem partição do mês, o painel cai** — pela regra "falha de auditoria desfaz a transação" | Partição `DEFAULT` com alarme. A propriedade que protege o log é a mesma que o torna ponto único de falha, e isso fica escrito |

> **A imutabilidade vale contra `mavia_app` e contra o gatilho. Ela não vale contra quem tem acesso ao servidor.** Imutabilidade real exige o log sair da máquina, e isso não está neste épico.

#### 3.2 · O caminho de eliminação — que não dá para adiar

`DELETE /tenants/:id` promete apagar **todas** as tabelas com aquele `tenant_id`, e `auditoria` não está entre os sobreviventes da §5.3. Mas nenhum papel consegue: `mavia_app` não tem `DELETE`, e `mavia_retencao` só tem `UPDATE` de três colunas — `DROP PARTITION` derruba o mês de **todos** os tenants e nunca serve para um pedido individual.

Então **R-08 é insatisfazível a partir da primeira linha de auditoria escrita**, que é a primeira ação do painel. E migration é forward-only: os grants nascem aqui.

**Sexta trava da §4.3:** papel `mavia_eliminacao` com `DELETE ON auditoria` **exclusivamente** por procedimento `SECURITY DEFINER` que aceita apenas `tenant_id` presente em `eliminacoes_journal` com eliminação concluída, e que grava em `retencao_execucoes`. Sem `BYPASSRLS`, sem `SELECT` em tabela de negócio, e o texto da regra 18 intacto para `mavia_app` — a mesma manobra que a §4.2 fez com a regra 17.

**O job de retenção continua fora de escopo, agora com data.** A dimensão de prazo é dívida datável — a primeira obrigação vence 5 anos após o primeiro acesso de admin. A de eliminação não é adiável, porque o gatilho é o titular e o prazo é de 15 dias (art. 19 II). Por isso o **desenho dos grants sai deste épico**.

### 4 · Quem é admin

`administradores` com PK em `usuario_id` não representa conceder → revogar → conceder sem um `UPDATE` que apaga a história — o mesmo defeito que a v1 usou para recusar a flag booleana.

```
concessoes_de_admin   id, usuario_id, email_no_ato, concedida_em, concedida_por,
                      revogada_em, revogada_por
```

Append-only, estado efetivo derivado. `mavia_app` com `SELECT` apenas; conceder e revogar por função `SECURITY DEFINER` estreita ou pelo script de provisionamento — que **grava a própria linha de auditoria**, porque hoje ele seria, por construção, uma concessão sem registro.

`email_no_ato` é cópia própria e mínima do identificador, independente da FK: a §5.2 apaga fisicamente a linha de `usuarios`, e um ex-operador que peça eliminação da própria conta ou derruba a rota (`RESTRICT`) ou destrói a prova de quem teve acesso à base (`CASCADE`).

**A §5.2 ganha um segundo bloqueio**, irmão do "único proprietário": *quem é, ou foi nos últimos 5 anos, administrador não elimina a própria conta pela rota do titular.* Desligamento de operador é processo administrativo. O art. 18 VI não alcança: a base é independente (arts. 46 e 37) e o art. 16 II a preserva.

**O painel concede admin?** Não. Só o script. A v1 se contradizia — listava a classe de log "concedeu ou revogou" e não listava a ação. Se um dia a tela existir, ela é o `PATCH /membros/:usuarioId` deste épico e merece as quatro travas de R-4.

### 5 · A autorização das rotas

`pode()` mapeia rota → `Papel[]`, e `Papel` é `proprietario|membro|visualizador` (`politica-acesso.ts:17`). O admin não tem papel de tenant, e a saída fácil — colar `/admin/*` em `ROTAS_SEM_TENANT` — **desliga a autorização**, porque rota nessa lista não passa por guard nenhum (`politica-acesso.ts:258-266`).

**A v2:** marcador próprio na matriz (`papel: 'admin'`), guard próprio, e **asserção de boot** de que toda rota sob `/admin/` carrega o marcador — no mesmo espírito de `verificarCoberturaDaMatriz`, que já derruba a aplicação por rota sem regra.

**Rate limit:** a busca por nome ou e-mail sobre toda a base é a superfície de enumeração mais barata do produto. Classe própria, mais estrita que a do login.

### 6 · O que compensa a ausência de MFA

A v1 listava três compensações e o gate mostrou que nenhuma era isolamento. A v2 acrescenta as duas que valem mais que as outras somadas:

1. **Rede.** Hostname distinto para o painel — escopo de cookie distinto — e allowlist de IP ou mTLS no Traefik à frente de `/admin`. Hoje `/admin` seria grupo de rotas do mesmo Next, no mesmo host, com o mesmo cookie: **um XSS em qualquer tela do produto, no navegador de um admin, alcança o painel inteiro.**
2. **Redis autenticado.** `requirepass` e instância ou banco separado para sessões; e, para `/admin`, revalidação da sessão no Postgres a cada requisição — a linha de `sessoes` que o Redis afirma existir precisa existir, não estar revogada, e pertencer àquele usuário. Sem isso, quem alcança o Redis **é** o admin, e antes de DA-1 isso comprava um tenant; depois, a base inteira.
3. **Detecção.** Ler o log **é evento**, e toda abertura de espaço e leitura do registro **notifica os outros admins**, mais um resumo diário. Nada no desenho da v1 detectava: os três itens eram preventivos ou forenses, e um log que ninguém lê descobre o incidente quando o cliente reclama. DA-2 proíbe avisar o cliente; não proíbe avisar o segundo operador.
4. **Sessão curta e privilégio por requisição** — resolvido contra `concessoes_de_admin`, nunca carimbado no token. *Verificado como sólido pelo gate:* o cofre carrega só `{sessaoId, usuarioId}` (`cofre-de-acesso.ts:37-40`) e não há onde guardar claim de papel.
5. **Reautenticação nas escritas**, com o ticket carregando o **`tenant_alvo`** — sem isso, um ticket emitido para "dar baixa" autoriza a mesma escrita em outro cliente dentro da janela. O `exigeReautenticacao()` existe em `politica-acesso.ts:239` e **ninguém o consulta**: o lugar é o guard, e este épico o implementa.

> **O que a reautenticação compra, exatamente:** ela protege contra **sessão** roubada, não contra **senha** roubada — que é o risco que o §"ausência de MFA" declara. Vale a pena e não fecha o buraco. **MFA continua sendo a única mudança que altera a natureza do risco.**

### 7 · Endurecimento do §3.9 que este épico exige

O gate não conseguiu construir exploit confiável, mas a carga muda: hoje `app.tenant_id` só assume tenants do próprio usuário; depois do painel, assume **qualquer cliente**.

- `comUsuario` (`tenancy.ts:93-111`) passa a definir `app.tenant_id` como `''` explicitamente — hoje ele nunca o limpa;
- `resolverTenant` ganha o predicado de `usuario_id` (§2);
- `emTransacao` libera com `cliente.release(erro)` no caminho de erro, **destruindo** em vez de reaproveitar a conexão que falhou em desfazer.

### 8 · O que o admin faz

| Ação | Classe no log |
|---|---|
| Buscar clientes | leitura em massa — uma linha por busca, com termo hasheado e contagem |
| Ver o perfil de um cliente | leitura em massa |
| Abrir o espaço em leitura | leitura em massa, com rota e contagem |
| Trocar plano ou intervalo | escrita financeira |
| Adicionar tempo (`periodo_fim`) | escrita financeira |
| Dar baixa em pagamento | escrita financeira |
| Cadastrar cliente novo | escrita financeira |
| **Ler o registro** | **segurança** — e notifica os outros admins |

**O admin lê e não edita dado financeiro do cliente**, agora garantido pelo papel `mavia_admin` e não por disciplina.

### 9 · As telas

Hostname próprio (§6). Lista de clientes · perfil do cliente · registro. Seguem `docs/design.md`, com a auditoria da §5 rodada antes da entrega.

O motivo e a referência são pedidos **antes** de abrir o espaço, não depois.

---

## Modelo de dados

```
concessoes_de_admin    id, usuario_id, email_no_ato, concedida_em, concedida_por,
                       revogada_em, revogada_por
auditoria (particion.)  ver §3
pagamentos_manuais     id, tenant_id, registrado_por, registrado_em, valor_centavos,
                       moeda, competencia, meio, observacao
```

`pagamentos_manuais.meio` é enum (`pix | transferencia | boleto | dinheiro | cortesia | ajuste`), com `observacao` livre **opcional** — e a UI diz, ao lado do campo: *"esta observação pode ser lida pelo cliente se ele pedir os dados dele"*. Alinha o comportamento do operador ao que a exportação entrega, e mata a categoria "nota interna sobre o cliente que ninguém previa que sairia".

A tabela **não tem caminho de leitura voltado ao tenant**: `observacao` nunca entra em `GET /assinatura`. Valor em centavos inteiros com moeda ISO (regra 1).

---

## LGPD — o que muda fora do código

| # | Onde | O quê |
|---|---|---|
| 1 | `retencao-e-eliminacao.md` §10.5 e §10.6 → **v2** | Os textos dizem *"quem mais vê: todas as pessoas do espaço"*, o que passa a ser falso por omissão. Acrescentar: *"E a equipe da Mavia, quando precisa apurar um problema na sua conta. Todo acesso desses fica registrado."* **Tem prazo:** §10.4.2 exige reconsentimento em mudança material, e hoje não há conexão bancária em produção — corrigir custa zero agora e custa expirar todas as conexões depois do épico 12 |
| 2 | Nova §8.1.1 — **LIA do acesso de operador** | A LIA do §8.1 **não se estende**: ela lista como salvaguarda *"o log é exposto ao próprio titular"* e fecha com *"retirada qualquer uma delas, a LIA precisa ser refeita"*. DA-2 retira exatamente essa. A nova LIA traz hipóteses fechadas de acesso, a necessidade de DA-1, as salvaguardas compensatórias, e a ausência de MFA **como fato** |
| 3 | Nova §3.8 — **operação interna** | Primeira categoria do produto cujo titular não é cliente. `concessoes_de_admin`: 5 anos após revogação. `auditoria` — acesso de operador: **5 anos**, e não os 12 meses da classe "leitura em massa", que foi escrita para atos do próprio titular |
| 4 | §3.5 e §4.4 | Carve-out: a anonimização de `auditoria.usuario_id` aos 90 dias **não alcança** a classe de acesso de operador — senão a identidade de um operador desligado desaparece, apagando a evidência de quem acessou a base |
| 5 | §3.6 | `pagamentos_manuais`: **5 anos** de 1º de janeiro do ano seguinte (obrigação legal, CTN 173 I), sobrevive à eliminação do espaço; `observacao` 12 meses. §5.3 ganha a quinta linha em "sobrevive apenas", ou **R-08 reprova** |
| 6 | §8.2 | Campos de `assinaturas` na linha "estruturais — em claro" |
| 7 | Procedimento escrito | Resposta ao art. 18 I e II: pedido do titular respondido com a lista de acessos do período, em até 15 dias. Com dono e prazo. A justificativa de `auditoria` em `FORA_DA_EXPORTACAO` (`exportacao.controller.ts:213`) hoje aponta para um fluxo que não existe |
| 8 | Política de privacidade | Declaração genérica do acesso de operador, e o e-mail do encarregado (art. 41 §2º I) |
| 9 | ROPA + RIPD | Entrada para "acesso de operador a espaço de cliente". A §8.1.1 já é 80% do RIPD |

**Já feito:** o teste de completude da exportação passou a excluir partições (`relatorios.test.ts`) — sem isso ele falharia todo mês, quando a partição seguinte nascesse. Verificado contra um pai particionado real.

---

## Erros e bordas

| Situação | Resposta |
|---|---|
| Não-admin em rota `/admin` | 404. **Não é controle** — o tempo de resposta difere de um caminho inexistente, e o App Router entrega o manifesto de rotas. É grátis, e só |
| Admin revogado com sessão viva | Próxima requisição recusa |
| Escrita sem reautenticação, ou com ticket de outro cliente | 401 com marcador próprio |
| Falha ao gravar auditoria | A transação desfaz. Para escrita, nada sobrevive; para leitura, ver §1 |
| Mês sem partição | Partição `DEFAULT` recebe, e o alarme dispara |

---

## Testes

| Nível | O que prova |
|---|---|
| Integração | **Um não-admin não alcança nada** — rota a rota |
| Integração | Uma rota **não consegue compor `ContextoDoTenant` à mão** (a trava de tipo, §1.1) |
| Integração | Toda leitura por `abrirEspacoComoAdmin` deixa exatamente uma linha, com `motivo`, `rota` e contagem |
| Integração | `mavia_admin` leva `permission denied` em `UPDATE` e `INSERT` de tabela de negócio |
| Integração | `mavia_app` leva `permission denied` em `UPDATE`, `DELETE` **e `TRUNCATE`** de `auditoria` |
| Integração | O gatilho barra `UPDATE` **do dono da tabela**, e numa **partição criada depois** do `REVOKE` |
| Integração | Nenhuma policy de `tenants`, `usuarios` ou `tenant_usuarios` referencia `concessoes_de_admin` |
| Integração | Com admin logado, `X-Mavia-Tenant` de um cliente alheio no app normal continua sendo 403 |
| Integração | Admin revogado perde acesso na requisição seguinte |
| Integração | Sabotagem: auditoria que falha desfaz a escrita |
| Domínio | Adicionar tempo e trocar plano respeitam a máquina de estados |
| E2E | Entrar, achar cliente, informar motivo, mudar plano, ver a linha no registro |

---

## O que este épico deliberadamente não faz

- **MFA.** A única mudança que altera a natureza do risco.
- **O job de retenção da auditoria.** Prazo é dívida datável; o **desenho dos grants não é**, e sai daqui.
- **Log fora da máquina.** Imutabilidade contra quem tem o servidor não está neste escopo, e o §3.1 diz isso.
- **Atendimento dentro do produto.** DP-25 continua: não existe canal humano de recuperação. **Requisição de titular não é atendimento** — é obrigação com prazo, e tem procedimento (§LGPD 7).
- **Editar dado financeiro do cliente.**
- **Aviso ao titular** (DA-2) — agora sabendo que é filtro, e não omissão.
