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

## ~~P-3 · Cadastro por e-mail e recuperação de senha~~ ✅ **fechada**

**Fechada em:** 2026-09-03. `apps/api/src/mensageiro/`,
`apps/api/src/autenticacao/cadastro.controller.ts`, e as telas `/cadastrar`,
`/confirmar`, `/recuperar` e `/redefinir` no web.

Quatro rotas, e uma propriedade que domina as quatro: **a resposta é a mesma
tenha o endereço uma conta ou não**. O que muda é qual e-mail sai, e isso só quem
tem a caixa postal observa.

O mensageiro fala **SMTP**, escrito à mão. SMTP porque nenhum provedor foi
escolhido e todos oferecem SMTP — amarrar o código à API REST de um deles seria
tomar a decisão do dono por acidente de implementação. À mão porque as três
mensagens do produto são texto puro e curtas, e uma dependência de árvore grande
num processo que tem a `DATABASE_URL` custa mais do que entrega.

**STARTTLS é obrigatório quando a conexão sai da máquina**, e a exceção para o
servidor local é derivada do endereço, não de uma variável: um `SMTP_TLS=false`
seria a linha que alguém copia para produção para fazer um provedor difícil
funcionar.

O cliente é exercitado contra um **Mailpit de verdade**: protocolo escrito à mão
que nunca falou com um servidor real é código que ainda não existe. Foi essa
suíte que encontrou o descarte das linhas de continuação da resposta multilinha
— sem elas o anúncio de STARTTLS era invisível.

O E2E vai do formulário à conta **pela caixa de entrada**. Ele encontrou dois
defeitos que nenhum teste de unidade encontraria: a tela de confirmação guardava
o access em memória sem avisar o provedor, e a aplicação redirecionava para a
entrada logo depois de autenticar; e o formulário perguntava o nome do espaço
para descartá-lo — a migration 0027 conserta o segundo.

**O que ainda depende do dono:** escolher o provedor e configurar `SMTP_HOST`,
`SMTP_PORTA` e `SMTP_REMETENTE`. Sem eles as rotas respondem **503** em vez de
202 — um 202 que não manda e-mail deixaria a pessoa esperando para sempre com o
log dizendo que deu certo. E o provedor será **operador** de dados pessoais:
precisa entrar em `docs/compliance/subprocessadores.md` antes do primeiro envio.

### O texto original

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

## P-12 · O parser roda isolado — falta a metade do container

**Onde:** `apps/api/src/importacao/parser-isolado.ts`, `packages/parser/src/cli.ts`
**Spec:** `docs/arquitetura/sistema.md` §2.6
**Atualizado em:** 2026-09-03

**A metade que é código está feita.** O parsing acontece num processo filho
descartável, um por arquivo:

| Controle | Onde |
|---|---|
| sem segredo no ambiente do parsing | código — `env: {}`, com teste de comportamento |
| contenção de queda | código — o filho morre, o pai responde |
| prazo duro (`SIGKILL` aos 10 s) | código |
| teto de saída | código |
| saída não confiável, validada por Zod | código |
| sem rede, fs somente-leitura, cgroup, `seccomp` | **container** |

O `centavos` atravessa o fio como **string decimal**, e não como `number`: JSON
não tem inteiro de precisão arbitrária, e um `number` faria o valor passar por
ponto flutuante na fronteira mais hostil do sistema. Há um teste com R$
92.233.720.368.547,75 — acima de `Number.MAX_SAFE_INTEGER` em centavos — que
falharia com qualquer outra escolha.

`DataCivil` atravessa como `{ano, mes, dia}` pela mesma razão de forma
diferente: uma string de data acabaria em `new Date()` do outro lado, que a lê
em UTC e desloca o dia para quem está em São Paulo.

**O que falta é o container**, e o `sistema.md` §2.6 já dizia que seria assim:
"é propriedade do container, não do código; testar isso em Vitest testaria o
mock". O serviço e as quatro verificações de deploy — que precisam **falhar** ao
rodar — estão escritos em `infra/README.md`.

**Condição de saída:** o serviço `parser` no compose de produção, com as quatro
verificações no pipeline de deploy. Item do 1D.

### O texto original

O `sistema.md` exige que o parsing de arquivo enviado por usuário execute num
**processo filho descartável** por arquivo: usuário sem privilégio, sem
variáveis de ambiente de segredo, sem rede, filesystem somente-leitura exceto um
`tmpfs`, cgroup de memória e CPU, `seccomp` restritivo e timeout duro.

O que **já está pronto**: o pacote foi escrito para caber nesse processo. Ele
não tem `dependencies` nenhuma, não faz I/O, não lê ambiente e não conhece o
domínio — a ausência de dependências no `package.json` é o que força qualquer
`import` novo a ser defendido. Uma propriedade cobre a parte que mais importa
para um processo isolado: **nenhuma entrada faz o parser lançar**, porque uma
exceção derrubaria o processo que o hospeda.

O que falta é o container. O próprio `sistema.md` já diz que o isolamento é
"propriedade do container, não do código", e hoje o parsing roda dentro do
processo da API.

**Condição de saída:** o serviço `parser` no `docker-compose`, com
`--network none`, e a API passando a chamá-lo por arquivo de entrada e JSON de
saída validado por Zod — o pai **não confia** na saída do filho.

---

## P-13 · OCR de recibo

**Onde:** não existe
**Spec:** roadmap, épico 7
**Depende de:** motor de OCR dentro do processo `parser` isolado (P-12)

O épico 7 prevê "OCR de recibo com confirmação". Não foi feito, e a razão é a
mesma que torna o item caro: um motor de OCR é uma dependência nativa pesada, e
ela precisa viver **dentro** do processo isolado do P-12 — junto do parsing de
arquivo hostil, sem rede e sem segredo. Fazer o OCR antes do isolamento
significaria rodar decodificação de imagem no processo que tem a `DATABASE_URL`.

A parte do épico que **está** de pé é a que decide categoria: regra do usuário,
histórico do próprio espaço, motivo visível e reversão em um toque. O OCR
acrescentaria uma **fonte** de lançamento; a inteligência sobre ele já existe.

**Condição de saída:** o processo `parser` isolado (P-12), e então Tesseract
dentro dele.

---

## P-14 · A cobrança não cobra

**Onde:** `apps/api/src/cobranca/cobranca.controller.ts`
**Depende de:** conta na Stripe, com `price_id` dos seis produtos e o segredo do webhook

O que **está** pronto e testado sem a Stripe: a máquina de cinco estados, o
catálogo de planos em código, a contagem de cotas no servidor e o webhook
idempotente com verificação de assinatura em tempo constante. São 17 testes de
integração, e a verificação da assinatura tem teste que morde — sem a captura do
corpo cru, seis deles caem.

O que falta é a chamada de saída: criar a sessão de checkout e o portal do
cliente. Quando a chave existir, é uma requisição HTTP — **o estado já sabe
reagir ao que a Stripe responde**.

Sem `STRIPE_WEBHOOK_SECRET` configurado, a rota de webhook recusa **tudo**. É o
padrão certo: um webhook aberto porque a variável não foi definida é uma rota
que qualquer um usa para mudar o estado de cobrança de um cliente.

**Condição de saída:** conta na Stripe do dono do produto.

---

## P-15 · Nota fiscal

**Onde:** não existe
**Decisão do dono:** **não emitir automaticamente**

Registrado aqui para que a ausência seja escolha visível, e não esquecimento. A
coleta do documento fiscal do cliente e a emissão ficam fora do produto por
decisão do dono; a Stripe guarda o recibo de pagamento, que é o que o cliente
recebe.

Se um dia a obrigação mudar, o que falta é o campo de documento no cadastro e a
integração com o emissor — nada no modelo atual impede.

---

## P-16 · O que falta antes do primeiro adapter de agregador

**Onde:** `apps/api/src/conexoes/revogacao.ts`, `test/contrato-do-adapter.test.ts`
**Condição de saída:** o gatilho de receita do ADR 0003 ser atingido

A revogação em três fases existe e é exercitada de ponta a ponta — mas contra
adapters que declaram `revogacaoRemota: 'nao-aplicavel'`. Os três de hoje
(`ofx-import`, `csv-import`, `manual`) nunca ficam `pendente`, porque não há
acesso continuado a encerrar: o titular entregou um arquivo, uma vez.

Um adapter cuja revogação **pode** ficar pendente exige três peças que ainda não
existem, e as três pela mesma razão — o estado `pendente` só é honesto se
alguém, mais tarde, o resolver:

1. **O `outbox`.** Hoje a intenção de revogar lá fora vive no request. Se o
   processo cair entre o commit da Fase 1 e a chamada da Fase 2, a intenção se
   perde: a credencial foi destruída aqui, e ninguém nunca pedirá ao agregador
   que encerre a sessão dele. O ADR 0019 §D2 é explícito — o job é enfileirado
   **pelo outbox, antes de qualquer tentativa**.

2. **O job `conexao.revogar-no-provedor`.** Sem ele, `pendente` é para sempre. E
   `pendente` para sempre é pior do que um erro: o titular lê a palavra na tela e
   conclui, corretamente, que o banco ainda pode ter acesso — e nada nunca muda
   isso.

3. **A Fase 3 assíncrona.** Ela roda hoje dentro da transação da Fase 1, e é
   correto que rode: são **zero linhas**, porque nenhum adapter registrado
   escreve `lancamentos_brutos.payload`. No dia em que um escrever, a limpeza
   passa a ser dezenas de milhares de linhas dentro de uma transação — e o ADR
   manda ela para fora justamente por isso.

**Isto não depende de ninguém lembrar.** A suíte de contrato tem um teste que
afirma que nenhum adapter registrado tem revogação remota. Ele falha no primeiro
`registrarAdapter` de um agregador, com o motivo escrito ao lado — e falhar ali
custa uma tarde, contra descobrir a ausência com credencial bancária de gente de
verdade no banco.

---
