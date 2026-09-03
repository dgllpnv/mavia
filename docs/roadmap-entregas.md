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

## Épico 1 — Fundação *(em andamento)*

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

### 1D · Deploy na VPS — **movido para o fim de tudo, por decisão do dono do produto**

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

## Épico 2 — Núcleo

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

## Épico 10 — Compartilhamento

**Entrega:** múltiplos usuários por espaço, com os papéis e a matriz de acesso aplicada.

**Pré-requisito duro do épico 11:** sem isto, `Família` e `Negócio` são o mesmo plano com três preços.

---

## Épico 11 — Cobrança

**Entrega:** Stripe · três planos · teste de 7 dias · cotas · ciclo de vida da assinatura · webhook idempotente · coleta do documento fiscal.

> **Condição, não sugestão:** esta etapa exige os épicos 6 e 10 prontos. Cobrar R$ 59 por um produto só manual, contra um concorrente de R$ 35 que importa extrato, não se sustenta.

**Ao fim você consegue:** vender.

---

## Épico 12 — Open Finance

**Entrega:** adapter de agregador · `Conexao` · `Consentimento` versionado · sincronização periódica · revogação em três fases.

> **Gatilho:** a receita cobrir o custo do agregador com margem (ADR 0003). Não é uma data, é um número.
>
> **Pré-requisito:** o guardião de chaves selado precisa existir **antes** de qualquer credencial bancária entrar — inclusive a sua, no teste manual.

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
