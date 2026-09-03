# Pendências declaradas

Dívida que existe **de propósito**, cada uma com o motivo e a condição de saída.
Este arquivo não é lista de desejos: entra aqui o que já foi decidido em spec ou
ADR e ainda não foi construído, e nada mais. Se algo aqui não tem data nem
gatilho, ou vira ticket, ou sai.

> Quem for implementar qualquer item: leia o spec citado antes. O que está
> escrito aqui é o resumo do buraco, não o desenho da solução.

---

## ~~P-1 · Token de acesso curto e refresh rotacionado (D6)~~ ✅ **fechada**

**Fechada em:** 2026-09-03, migration 0019 e `apps/api/src/redis/`.

O access token passou a ser **opaco de 15 minutos resolvido no Redis**, e o
refresh a ser **rotacionado a cada uso**, com detecção de reuso que revoga a
família inteira. `sessoes` já modelava família, geração e `substituida_por`
desde a 0003 — a rotação não precisou de coluna nova, só da função.

O que a mudança comprou, além do que estava escrito: revogação **imediata**.
"Desconectar os outros dispositivos" apaga os access tokens no mesmo instante,
porque o cofre mantém um índice reverso por sessão. O requisito da matriz era
60 segundos; o resultado é zero.

---

## ~~P-2 · Limite de tentativas de login~~ ✅ **fechada**

**Fechada em:** 2026-09-03, `apps/api/src/redis/limite-de-tentativas.ts`.

Duas janelas, e a assimetria entre elas é a parte que importa: **por endereço
conta tudo**, inclusive os acertos, senão um atacante com uma credencial válida
entre mil inválidas passaria sem acionar nada; **por origem conta só falhas**,
porque spraying é feito de erro e contar acertos trancaria um escritório
inteiro atrás do mesmo NAT.

A segunda metade dessa regra foi descoberta do jeito difícil: a versão que
contava tudo por origem começou a derrubar a própria suíte E2E depois da
sexagésima entrada bem-sucedida, com falhas diferentes a cada execução.

Nem o endereço nem o IP entram na chave em claro — um dump do Redis não vira
uma lista de quem tentou entrar.

---

## P-3 · Cadastro por e-mail e recuperação de senha

**Onde:** não existe rota
**Spec:** `docs/produto/spec-autenticacao.md` §2.6 e §3.4
**Depende de:** entrega de e-mail transacional

As funções de banco estão todas prontas e testadas — `auth.registrar_pendente`,
`auth.confirmar_cadastro`, `auth.emitir_recuperacao`, `auth.concluir_recuperacao`
(migration 0004). Falta a superfície HTTP, e ela **não deve nascer antes do
mailer**: um cadastro que grava `cadastros_pendentes` e não consegue mandar o
link deixa o usuário numa conta que ele não tem como confirmar.

Enquanto isso, o ambiente local nasce semeado (`pnpm db:seed`).

**Condição de saída:** provedor de e-mail transacional escolhido e configurado.

---

## P-4 · Login pelo Google

**Onde:** não existe rota
**Spec:** `docs/produto/spec-autenticacao.md` §1 e §2
**Depende de:** Redis (`state` e `nonce`, TTL 10 min) e credencial de cliente OAuth

A decisão de **qual** dos seis casos da matriz de identidade se aplica já é
código puro e testado: `decidirEntradaFederada`, em `packages/domain`, com as
32 combinações enumeradas. As funções de banco (`auth.resolver_identidade_federada`,
`auth.registrar_login_federado`, `auth.cadastrar_federado`) também existem.

Falta o fluxo OAuth em si — PKCE, validação do `id_token` contra a JWKS,
`state` e `nonce` de uso único. O `state` exige armazenamento fora do processo,
o que amarra este item ao P-1.

**Condição de saída:** Redis, mais `client_id`/`client_secret` do Google.

---

## P-5 · Métricas de fallback das fontes

**Onde:** `packages/ui/src/fontes.css`
**Spec:** `docs/design/direcao-visual.md` §3.1

O §3.1 pedia `size-adjust` calibrado para que a troca da fonte não mexesse na
altura das linhas do extrato. A altura da linha é fixa em `--altura-linha` e não
depende da métrica intrínseca da fonte, o que resolve o mesmo problema de forma
estrutural — e não envelhece na próxima versão da fonte.

Fica registrado como desvio consciente do texto do documento, não como
esquecimento. Se algum dia uma tela passar a depender de métrica intrínseca, o
`size-adjust` volta a ser necessário e este item vira ticket.

---

## P-6 · Estorno de compra no cartão

**Onde:** `apps/api/src/lancamentos/lancamentos.repositorio.ts`, `estornar`
**Bloqueia:** o botão de estorno na tela de detalhe, para lançamento de cartão

`estornar` junta com `contas` para descobrir a moeda, então só funciona para
lançamento que tem `conta_id`. Compra de cartão tem `cartao_id`, e a função
devolve zero linhas.

O que falta **não é código**: é a decisão de **em qual fatura o crédito entra**.
O reembolso de uma compra de março chega em maio; ele pertence à fatura de
março, que já foi paga, ou à fatura aberta, que é onde o dinheiro de fato volta?
As duas respostas são defensáveis e produzem números diferentes no mês.

A restrição `cartao_tem_fatura` obriga a escolher: lançamento de cartão fora de
transferência **precisa** de `fatura_id`.

A interface hoje não oferece o botão e diz o porquê, em vez de oferecer um erro.

**Condição de saída:** decisão do `arquiteto-dominio-financeiro` sobre a fatura
de destino, em ADR — é regra de negócio, e uma escolha silenciosa aqui vira
divergência de saldo três meses depois.

---

## P-7 · `pnpm lint` não existe

**Onde:** raiz do monorepo
**Citado em:** `CLAUDE.md` §8, entre os comandos

O comando está documentado e não está ligado: `pnpm -w lint` falha com
`Command "lint" not found`. Não há ESLint configurado em nenhum pacote.

O que segura a qualidade hoje é o `pnpm typecheck`, com `strict` e
`noUncheckedIndexedAccess`, que pega a maior parte do que o lint pegaria neste
código. O que se perde é a camada de estilo e as regras que o compilador não
tem: import ciclíco, `await` esquecido em promessa flutuante, dependência de
hook incompleta no React — esta última é a que mais dói no `apps/web`.

**Condição de saída:** ESLint com `typescript-eslint` e o plugin de hooks, um
config na raiz herdado pelos pacotes, ligado no CI junto do typecheck.

---

## ~~P-8 · O horizonte da recorrência não anda sozinho~~ ✅ **fechada**

**Fechada em:** 2026-09-03, `apps/api/src/recorrencias/agendador.ts`.

Job BullMQ de hora em hora, worker no mesmo processo. A frequência não compra
ocorrência nenhuma a mais — a materialização é idempotente pela identidade —,
compra resiliência: uma janela de manutenção de duas horas não custa um dia de
horizonte.

O job atravessa todos os espaços, e a RLS bloqueia isso corretamente. A saída é
a exceção **declarada** da migration 0020: uma função `SECURITY DEFINER`
estreita que devolve três colunas de identificação e nada que descreva
dinheiro. Cada regra continua sendo materializada sob o contexto do seu espaço.

### O texto original

**Onde:** `apps/api/src/recorrencias/recorrencias.controller.ts`
**Dependia de:** agendador (BullMQ sobre Redis, épico 5)

O `CONTEXT.md` diz que "um job materializa as ocorrências dentro de um
horizonte". O job precisa de agendador, o agendador precisa de Redis, e o Redis
é do épico 5.

Enquanto isso a materialização acontece **na escrita**: criar ou alterar uma
regra materializa doze meses à frente. A consequência é que o horizonte não
avança sozinho — uma regra criada hoje tem ocorrências até o mesmo mês do ano
que vem e para ali, até que alguém a edite.

O que **já está pronto** e só espera o agendador: `POST /v1/recorrencias/materializar`,
idempotente pela identidade `(tenant, recorrencia, competência)`. O job é uma
chamada periódica a ela, e nada mais.

**Condição de saída:** a mesma do P-1.

---

## P-9 · O alerta não tem para onde ir

**Onde:** `packages/domain/src/planejamento.ts`, `atingiu`
**Depende de:** e-mail (P-3) ou push (épico 5)

O cálculo do alerta existe e é testado — `consumoBp` e `atingiu`, com os
percentuais configuráveis por planejamento. A tela mostra o estado e o
percentual, e a central de alertas os reúne num lugar só.

O que não existe é **entrega fora da sessão**: nada avisa quem não abriu o app.
Um teto estourado no dia 20 é notícia no dia 20, não no dia em que a pessoa
lembrar de olhar.

**Condição de saída:** um canal — mailer (P-3) ou push (épico 5).

---

## P-10 · O app móvel não foi executado em dispositivo

**Onde:** `apps/mobile/`
**Depende de:** um emulador ou aparelho

O que **está** verificado: a fila durável, com 17 casos e três propriedades. É
onde mora toda decisão que custa dinheiro — o que sobe, em que ordem, e o que
acontece quando falha —, e ela é pura de propósito para poder ser provada sem
dispositivo. O typecheck do app inteiro passa com `strict`.

O que **não** está: telas, SQLite, Keychain, biometria e o fluxo Maestro. O
ambiente em que o app foi escrito não tem emulador nem aparelho, e nenhuma
linha de interface foi executada.

Isto é diferente das outras pendências: não falta código, falta **execução**.
Escrever "épico 5 entregue" sem essa distinção seria a afirmação que o
`CLAUDE.md` proíbe — teste que não foi rodado não passou.

**Condição de saída:** rodar `maestro test maestro/fumaca.yaml` num emulador
Android, com o cenário de modo avião, e corrigir o que aparecer.

---

## P-11 · Push não entrega

**Onde:** não existe rota de registro de dispositivo
**Depende de:** credenciais de FCM (Android) e APNs (iOS)

O alerta já é calculado e visível dentro do app e do web. O que não existe é
**entrega fora da sessão** — a mesma lacuna do P-9, agora com o canal
identificado: notificação push.

Falta de dois lados: o registro do token do dispositivo, que é código, e as
credenciais das lojas, que são do dono do produto. Fazer o primeiro sem o
segundo produziria uma tabela de tokens que nunca é usada, e uma permissão
pedida ao usuário sem contrapartida — que é o pedido de permissão que faz a
pessoa negar todos os seguintes.

**Condição de saída:** conta de desenvolvedor nas duas lojas, com as chaves.

---
