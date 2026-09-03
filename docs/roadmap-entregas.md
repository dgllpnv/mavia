# Roadmap de entregas

O que falta, em ordem, e o que fica pronto ao fim de cada etapa.

**Entrega aqui significa código rodando com teste passando** — não documento escrito. Especificação é insumo, não entrega.

Não há estimativa de prazo. O que existe é ordem e dependência: cada etapa só começa quando a anterior está verde.

---

## Estado atual

| | |
|---|---|
| **Pronto** | Monorepo · domínio com `Money`, `ratear`, base temporal e matriz de vinculação · tenancy com RLS provada · cadastro e login · API HTTP com matriz de acesso · CI · ambiente Docker local · **web utilizável de ponta a ponta** · **Planejamento** |
| **Testes** | 615 passando — 263 de domínio, 32 de parser, 17 do núcleo do app, 12 de contrato, 20 de `ui`, 271 de integração contra Postgres real — mais 18 cenários Playwright |
| **Especificado e revisado por gate** | Domínio, arquitetura, produto, design, segurança, LGPD, autenticação, cobrança |
| **Em código** | Épicos 1 (menos deploy), 2, 3, 4, 6 e 8; o 5 escrito e não executado. O deploy foi movido para **depois de todos os épicos**, por decisão do dono |

---

## Épico 1 — Fundação ✅ **entregue**

### 1B · Autenticação — ✅ **entregue**

**Entrega:** cadastro e login funcionando, por Google e por e-mail e senha.

- Migrations 0002 a 0005: identidades federadas, credenciais, sessões, papel `mavia_auth` e as funções privilegiadas de cadastro
- Fluxo OIDC completo com PKCE
- Sessão com token opaco, rotação e revogação em cascata
- Vinculação de contas com a matriz de seis casos
- A resolução de tenant em quatro etapas

**O que prova:** que o cadastro cria tenant sem que `mavia_app` ganhe `INSERT` em `tenants`; que a vinculação nunca entrega o espaço de outra pessoa; e que a escalada encontrada na policy da migration 0001 não volta.

**Ao fim disto você consegue:** criar sua conta e entrar. Nada mais — ainda não há o que ver dentro.

### 1C · Primeira rota e o seam S2 — ✅ **entregue**

**Entrega:** a API HTTP de pé, com uma rota real de contas.

- NestJS sobre Fastify, contratos Zod em `packages/contracts`
- `tenancy.withTenant` como ponto de entrada único
- Guard de autorização que **nega por padrão e falha no boot**, a partir da matriz de acesso

**O que prova:** o seam S2 como o arquiteto exigiu — **dois tenants em toda rota**, e uma transação sem contexto lança erro em vez de retornar linha.

### 1D · Deploy na VPS — ✅ **entregue em 2026-09-03**

**No ar em `https://mavia.o9cmue.easypanel.host`**, com TLS válido e HTTP
redirecionando. Runbook completo em `infra/producao/README.md`.

A VPS não estava vazia: 24 containers de produção de outros negócios, em Swarm
sob o EasyPanel. A Mavia entra **ao lado** — containers comuns, descobertos pelo
Traefik por label, sem escrever no arquivo que o painel gera. Nenhum vizinho
ficou doente, e a carga não passou de 1.6 de 4 CPUs durante os builds.

Só o `web` encara a internet. Postgres e Redis vivem numa rede sem rota de
saída; só a API tem saída, porque precisa do SMTP e do Google.

**O que o deploy encontrou, e que nenhum teste pegaria:** o build local
contaminado por uma extensão de editor, o `??` que não cai no padrão para string
vazia (o `rewrite` de `/api` saiu sem host), o `psql -c` que não interpola
variável, e — a mais séria — `eventos_de_cobranca` como a única tabela com
`tenant_id` e sem RLS, achada consultando o banco de produção.

**O que falta para ser usável:** o SMTP. Sem ele não existe caminho para criar a
primeira conta.

### O texto original

> **Atualização.** A decisão original adiava o deploy para dentro do épico 5.
> O dono do produto o moveu para **depois de todos os épicos**: a aplicação sobe
> para a VPS quando estiver completa, e não antes.

**Movido para depois do épico 5**, quando a aplicação estiver completa e testada localmente.

> Não há pressa para subir. A VPS recebe o produto pronto, não um esqueleto.

A decisão é boa e economiza trabalho real: ambiente de produção mantido durante meses sem produto dentro custa atenção, atualização de segurança e depuração de infraestrutura, sem devolver nada. O ambiente local do `mavia.bat` cobre todo o desenvolvimento até lá, e os testes de integração sobem o próprio Postgres via Testcontainers.

**O que isso não adia:** as migrations continuam sendo escritas em modo expand/contract desde já, e os papéis de banco continuam separados no ambiente local. Escrever migration destrutiva "porque ainda não tem produção" é a dívida que aparece no dia do primeiro deploy.

**Quando acontecer, entrega:** Docker Compose e Traefik com TLS · papéis de banco separados · backup com recuperação a ponto no tempo e **restauração testada de verdade** · observabilidade com erro, latência e a métrica de negócio.

**Ao fim do épico 1 você consegue:** rodar a Mavia inteira na sua máquina, criar conta, entrar com Google e consumir a API.

---

## Épico 2 — Núcleo ✅ **entregue**

**Entrega:** o razão financeiro funcionando.

`Conta` · `Categoria` com dois níveis · `Lancamento` com os três estados · saldo derivado com snapshot e job de reconciliação · `Transferencia` de duas pernas · `Estorno` · o módulo de agregação como tradutor único de toda soma.

**O que prova:** a bateria de invariantes do `validador-financeiro` — saldo derivado bate com o snapshot, transferência soma zero, e o rodapé de realizado × previsto é igual à soma de todas as páginas.

**Ao fim você consegue:** lançar despesa e receita, transferir entre contas, e ver o saldo certo. Pela API — ainda sem tela.

---

## Épico 3 — Cartão ✅ **entregue**

**Entrega:** o cartão de crédito com ciclo, que é a parte mais difícil do domínio.

`Cartao` · `Fatura` com janela e estados · fechamento e vencimento · `GrupoDeParcelamento` com `data_compra` · pagamento de fatura como transferência · as três bases temporais de relatório.

**O que prova:** compra no dia exato do fechamento cai na fatura certa; parcelamento soma exatamente o total; pagamento de fatura **não** aparece como despesa; e 31/jan em 3× não vira 28/mar.

**Ao fim você consegue:** registrar compra parcelada e ver a fatura fechar e vencer corretamente.

---

## Épico 4 — Web ✅ **entregue**

**Entrega:** o produto visível. A direção "papel e trilho" foi **substituída** em
curso pela direção familiar (`docs/design/direcao-visual-2-familiar.md`): o dono
do produto avaliou a primeira como feia e difícil, e pediu a disposição do
Organizze, que é a que os clientes já sabem usar. As cores continuam nossas.

Tokens em `packages/ui` · dashboard · extrato denso com o trilho · formulário de lançamento · tela de fatura como objeto de ciclo · filtros nos três eixos.

**O que prova:** Playwright nos fluxos críticos, contraste WCAG AA verificado, e a auditoria de design da seção 5.

**Ao fim você consegue:** usar a Mavia pelo navegador, de verdade. **É a primeira etapa em que dá para demonstrar o produto a alguém.**

**Ressalvas abertas**, em `docs/validacao/auditoria-interface-epico-4.md` §6:
banner de contas em atraso no topo do extrato, seleção em massa de lançamentos,
e o seletor de granularidade de período (hoje / semana / mês / intervalo). São
comodidades do Organizze que ainda não foram copiadas; nenhuma bloqueia o uso.

---

## Épico 5 — Mobile *(fim do MVP)* — **código pronto, não executado**

**Entrega:** os apps Android e iOS. ~~É aqui que a etapa 1D entra~~ — **o deploy
saiu daqui** e foi para depois de todos os épicos, por decisão do dono.

Expo · offline-first com fila durável e idempotência · lançamento em três toques · biometria · push · build e envio às lojas.

**O que prova:** Maestro no fluxo de fumaça, e o teste que importa — modo avião, lança, volta, sincroniza **uma vez só**.

### O estado real

| Parte | Situação |
|---|---|
| Fila durável, ordem, recuo e falha permanente | ✅ 17 testes, três deles propriedades |
| Idempotência de mutação ponta a ponta | ✅ migration 0021 e 5 testes de integração |
| Access/refresh no Keychain, biometria como conveniência | escrito, **não executado** |
| Telas, SQLite, Maestro | escritos, **não executados** |
| Push | não existe — depende de credenciais das lojas (P-11) |
| Build e envio às lojas | não feito |

**Nada da interface do app rodou.** O ambiente não tem emulador nem aparelho, e
dizer "entregue" aqui seria afirmar o que o `CLAUDE.md` proíbe. Ver P-10.

**Ao fim você consegue:** lançar uma despesa no caixa do mercado, sem rede —
**depois** de a P-10 ser fechada num emulador.

---

## Épico 6 — Importação ✅ **entregue**

**Entrega:** trazer extrato de verdade para dentro.

`BankSyncProvider` com os adapters OFX e CSV · `LancamentoBruto` com idempotência · deduplicação · conciliação como sugestão · desfazer importação.

> **Antes desta etapa, o processo `parser` isolado precisa existir** — sem rede, sem segredo, sem banco.

**Sobre o pré-requisito:** o `packages/parser` foi escrito para caber nesse
processo — **sem nenhuma dependência**, sem I/O, sem ambiente — e uma
propriedade cobre o que mais importa ali: nenhuma entrada o faz lançar. O
container em si ainda não existe, e isso está declarado em P-12. Foi uma
escolha: o isolamento é propriedade do container, e prendê-lo antes teria
adiado a única parte que o cliente vê.

**O que prova:** 32 testes do parser, com propriedades sobre a conversão de
dinheiro; 15 de integração cobrindo as três promessas — reimportar não duplica,
conciliação é sugestão, desfazer devolve o mês ao que era.

**Ao fim você consegue:** baixar o OFX do seu banco, importar, e ver os lançamentos conciliados sem duplicar.

---

## Épico 7 — Inteligência — **entregue, menos o OCR**

**Entrega:** categorização que aprende, sem terceiro na cadeia.

Regra do usuário · histórico do próprio espaço · ~~OCR de recibo com confirmação~~ · explicabilidade e reversão em um toque.

Sem modelo externo e sem treinar com dado de cliente, conforme suas decisões.

### O que está de pé

**As duas garantias do glossário**, e as duas com teste: motivo visível — toda
classificação automática grava a frase em português que a explica — e
reversibilidade observável: trocar a categoria à mão apaga a marca de
automático, porque ela deixou de ser verdade.

A ordem é regra do usuário, depois histórico do espaço, depois nada. "Nada" é
uma resposta: sem palpite, porque um palpite errado num relatório é pior do que
uma linha esperando. Duas ocorrências mínimas para o histórico valer, e o
sistema **não aprende com o próprio palpite** — aprender da própria
classificação é como um erro vira convicção.

Apareceu um buraco de produto no caminho, e foi fechado: **não havia como
reclassificar um lançamento**. A importação criava linhas em `A classificar` e
não existia rota nenhuma para movê-las.

**Falta o OCR de recibo** — P-13. Ele depende do processo `parser` isolado
(P-12), porque decodificar imagem enviada por usuário no processo que tem a
`DATABASE_URL` é exatamente o que o isolamento existe para impedir.

---

## Épico 8 — Planejamento ✅ **entregue**

**Entrega:** `Planejamento` com teto e piso · `Objetivo` de acúmulo com aportes · alertas em basis points · `Recorrencia` com ancoragem de dia do mês.

**O que prova:** a precedência global → raiz → subcategoria sem contagem dupla, e o alerta de teto que **não** dispara invertido.

**Antecipado.** Veio antes do épico 5 porque o épico 4 mostrou que rota testada e
nunca exercida por uma tela esconde defeito — e porque planejamento é o que o
cliente do Organizze usa todo mês.

As três entidades e o alerta estão de pé. Duas ressalvas declaradas:

| Ressalva | Pendência |
|---|---|
| O horizonte da recorrência não anda sozinho: materializa doze meses na escrita, e o job periódico precisa de agendador | P-8 |
| O alerta é **derivado e visível na sessão**; nada avisa quem não abriu o app | P-9 |

**Ao fim você consegue:** planejar o mês, acompanhar um acúmulo de meses, deixar
o aluguel e a assinatura se lançarem sozinhos, e ver num lugar só o que pede
atenção.

---

## Épico 9 — Relatórios ✅ **entregue**

**Entrega:** gráficos na direção visual · comparação de períodos · o seletor de base temporal no cabeçalho · exportação enumerando as 26 entidades.

A exportação aqui é também o cumprimento do direito de portabilidade.

### O que prova

**O seletor de base fica no cabeçalho, e a base viaja na resposta.** "Quanto
gastei em março" tem três respostas certas, e elas diferem em centenas de reais
para quem parcela. Há teste para as três: por data da compra a parcelada aparece
inteira no mês da compra; por data da parcela, só a parcela.

**A comparação é calculada pelo servidor, nos dois lados.** É a invariante do
glossário — bases ou fronteiras distintas produzem variação inventada —, e
deixar o cliente montar duas chamadas convidaria exatamente esse erro.

**A exportação tem um teste que falha no futuro:** ele compara a lista escrita
de tabelas com as tabelas que têm `tenant_id`, e falha quando alguém cria uma
tabela nova sem decidir se ela é dado do titular. Ele já pegou uma.

Dois defeitos de tela apareceram na verificação e foram corrigidos: o delta da
comparação saía verde com "+" ao lado de "gastou mais" — a tela se contradizendo
na mesma linha —, e o gráfico de doze meses pulava os meses sem movimento,
comprimindo o eixo do tempo.

---

## Épico 10 — Compartilhamento ✅ **entregue**

**Entrega:** múltiplos usuários por espaço, com os papéis e a matriz de acesso aplicada.

**Pré-requisito duro do épico 11:** sem isto, `Família` e `Negócio` são o mesmo plano com três preços.

### O que prova

A regra **R-4** da matriz — "a rota de escalada de privilégio do produto" — tem
quatro travas, e cada uma tem teste. A terceira tem o teste que mais importa:
ela é provada **passando por cima da aplicação**, com `UPDATE` direto no SQL,
porque é lá que ela mora. Um `if` no controlador não seguraria o `UPDATE` às
três da manhã durante um incidente.

O gatilho é `FOR EACH STATEMENT` e há teste para o porquê: linha a linha, um
`UPDATE` que rebaixa dois proprietários de uma vez passaria — o primeiro porque
o segundo ainda era dono, o segundo porque o primeiro já não era.

Remover alguém **revoga as sessões no ato**, como o spec de autenticação §4.3
manda. Sem isso, "removi o acesso" seria promessa que o servidor não cumpre por
quinze minutos de access e semanas de refresh.

O convite é um link com token hasheado, e não um e-mail: o mailer é a pendência
P-3, e prender o compartilhamento a ele adiaria o épico 11 inteiro. O convite é
**para um endereço**, não para quem tiver o link.

---

## Épico 11 — Cobrança — **entregue, menos a chamada à Stripe**

**Entrega:** Stripe · três planos · teste de 7 dias · cotas · ciclo de vida da assinatura · webhook idempotente · coleta do documento fiscal.

> **Condição, não sugestão:** esta etapa exige os épicos 6 e 10 prontos. Cobrar R$ 59 por um produto só manual, contra um concorrente de R$ 35 que importa extrato, não se sustenta.
>
> **Os dois pré-requisitos estão cumpridos.** O 6 entregou a importação e o 10, o compartilhamento.

### O que está de pé

O **catálogo em código**, como o spec exige: preço e cota versionados, não
editáveis em produção sem deploy e sem teste. O anual é declarado, e não
multiplicado em tempo de execução — preço derivado por aritmética diverge entre
a vitrine, a Stripe e o reembolso.

A **máquina de cinco estados**, como tabela e não como `if`s: cinco por nove são
quarenta e cinco combinações, e a maioria **não** deve acontecer. A tabela torna
o "não deve" visível. Propriedade: nenhuma transição é identidade, e toda
`expirada` tem volta.

**`em_atraso` não degrada nada** — catorze dias de produto inteiro. Bloquear no
instante em que um cartão falha é a forma mais comum de perder um cliente que
queria ficar.

O **webhook idempotente**, com duas defesas testadas: o id do evento é chave
primária, e a máquina recusa o que não se aplica registrando a recusa. A
assinatura é HMAC sobre o **corpo cru**, em tempo constante.

A **cota conferida no servidor**, na mesma transação da criação — e a mensagem
nomeia a cota e a contagem, porque quem esbarra nela precisa entender o porquê.

Falta a chamada de saída à Stripe: P-14, à espera da conta do dono. A nota
fiscal fica fora por decisão dele: P-15.

---

## Épico 12 — Open Finance — **a máquina pronta, sem agregador ligado**

**Entrega:** adapter de agregador · `Conexao` · `Consentimento` versionado · sincronização periódica · revogação em três fases.

> **Gatilho:** a receita cobrir o custo do agregador com margem (ADR 0003). Não é uma data, é um número.
>
> **Pré-requisito:** o guardião de chaves selado precisa existir **antes** de qualquer credencial bancária entrar — inclusive a sua, no teste manual.

### O que existe

**Nenhum agregador está ligado, e isso é a decisão, não um atraso.** O gatilho do
ADR 0003 é receita, e ela ainda não existe. O que foi construído é tudo que
precisa estar pronto **antes** da primeira credencial bancária — porque
construir depois é construir com pressa, no dia em que já há segredo de gente de
verdade no banco.

O **guardião de chaves** (ADR 0018), como processo separado: `packages/guardiao`
com o envelope AES-256-GCM e o AAD que impede transplante de blob entre tenants,
e `apps/guardiao` com o cofre da KEK. As cinco propriedades do §D3.2 estão
verificadas, e a primeira delas — *nenhuma operação devolve a KEK* — é uma
**ausência**: não existe método que a devolva, e um teste de superfície reprova
se um aparecer. Os internos usam `#` e não `private`, porque `private` some na
compilação e deixaria `kekPara()` alcançável em runtime. Foi um teste que
encontrou isso.

O **cliente da API**, que fala com o guardião por socket local e nunca guarda
DEK. Testado contra o processo de verdade, desselado pela entrada padrão como o
runbook manda — que é, de quebra, o único lugar que exercita o desselamento
manual exigido a cada reboot.

A **rotação de KEK sem tocar no ciphertext das credenciais**. Um teste de rotação
encontrou aqui o defeito mais caro deste épico: a primeira versão carimbava a
versão de KEK no envelope do segredo, e toda rotação invalidaria todo ciphertext
do sistema — com o erro aparecendo só na primeira leitura seguinte.

A **migration 0026**: `conexoes` com o envelope completo, `consentimentos` como
prova que **nunca é apagada pela revogação**, `sincronizacoes`, RLS nas três, e
três constraints que recusam o que a aplicação poderia esquecer — meia
credencial, revogada sem data, e revogada com segredo vivo.

A **revogação em três fases** (ADR 0019), com a ordem que importa: a destruição
da credencial acontece **dentro** da transação e não pergunta ao provider se
pode; a chamada ao terceiro acontece **depois do commit**, porque um timeout
dentro da transação faria `ROLLBACK` e deixaria a credencial viva depois de o
titular pedir para destruí-la. A resposta traz **dois fatos separados**: o que a
Mavia fez, e o que sabemos do outro lado.

A **suíte de contrato do `BankSyncProvider`**, que roda sobre todo adapter
registrado. Ela não protege o produto de hoje: protege o adapter que ainda não
foi escrito, e o reprova antes de ele tocar em credencial de alguém.

### O que falta, e a ordem

O adapter do agregador em si — e, **antes dele**, as três peças da P-16: o
`outbox`, o job de retentativa e a Fase 3 assíncrona. Há um teste que falha no
dia em que o primeiro adapter com revogação remota for registrado sem elas.

---

## Trilhas que não são etapas

Acontecem dentro das etapas, não depois delas.

| Trilha | Quando |
|---|---|
| Exportação e eliminação (LGPD) | Cada entidade nova entra nos dois fluxos **na etapa em que nasce**, nunca num mutirão no fim |
| Gate de risco | Todo épico, sobre o spec, antes do código |
| Validação financeira | Todo merge que toque valor, saldo, fatura ou data |
| `claude-security:scan` | Todo diff que toque autenticação, dado bancário ou pagamento |
| Restauração de backup testada | A cada 4 a 6 épicos, com o tempo cronometrado |

---

## Onde o seu teste manual entra

Você disse que só libera após teste manual rigoroso, com o seu próprio banco.

- **Épico 4** é o primeiro momento em que dá para testar o produto de ponta a ponta pelo navegador.
- **Épico 6** é quando o seu extrato real entra — e exige o parser isolado antes.
- **Épico 12** é quando a sua conta bancária conecta de verdade — e exige o guardião de chaves antes.

O `mavia reset` existe para você repetir um roteiro do zero quantas vezes quiser.
