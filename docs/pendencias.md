# Pendências declaradas

Dívida que existe **de propósito**, cada uma com o motivo e a condição de saída.
Este arquivo não é lista de desejos: entra aqui o que já foi decidido em spec ou
ADR e ainda não foi construído, e nada mais. Se algo aqui não tem data nem
gatilho, ou vira ticket, ou sai.

> Quem for implementar qualquer item: leia o spec citado antes. O que está
> escrito aqui é o resumo do buraco, não o desenho da solução.

---

## P-1 · Token de acesso curto e refresh rotacionado (D6)

**Onde:** `apps/api/src/autenticacao/sessoes.controller.ts`
**Spec:** `docs/produto/spec-autenticacao.md` §4, decisão D6
**Depende de:** Redis (épico 5)

O spec fixa token de acesso **opaco de 15 minutos** resolvido no Redis, com
refresh opaco rotacionado a cada uso e detecção de reuso por família. O que
existe hoje é o token de sessão opaco com validade deslizante de 14 dias e teto
absoluto de 30, resolvido direto em `sessoes`.

O que **já está pronto** e só espera o Redis: a tabela `sessoes` (migration
0003) modela família, geração e `substituida_por` desde o primeiro dia. A
rotação não precisa de migration.

O que se perde enquanto isso: um token roubado vale até 14 dias em vez de 15
minutos, e a detecção de reuso — que é o que transforma roubo de refresh em
revogação automática da família — não tem o que detectar, porque não há rotação.

**Condição de saída:** Redis no `docker-compose` (porta 4779, já reservada).

---

## P-2 · Limite de tentativas de login

**Onde:** `POST /v1/sessoes`
**Spec:** `docs/seguranca/matriz-de-acesso.md` §3.1
**Depende de:** Redis (épico 5)

Não há limite por endereço nem por IP. As defesas que **existem** hoje são a
verificação fantasma (tempo constante entre endereço inexistente e senha
errada) e o Argon2id, que impõe ~20 ms por tentativa — o que torna a força
bruta cara, mas não impossível numa lista de senhas comuns contra muitos
endereços.

Contador em memória do processo foi **descartado de propósito**: ele dá a
sensação de proteção e evapora no primeiro segundo processo, além de contar
errado atrás de qualquer balanceador.

**Condição de saída:** a mesma do P-1.

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
