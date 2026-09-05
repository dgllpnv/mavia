# O que depende de você

As pendências que o time não pode resolver sozinho.

> ### ✅ Resolvido em 2026-09-04, direto na VPS
>
> - **Endereço público:** `https://mavia.o9cmue.easypanel.host`, o que o EasyPanel gera. Serve até você bater o nome do domínio.
> - **E-mail:** Resend por SMTP, configurado e **verificado com handshake real** (STARTTLS + AUTH LOGIN + `250` no DATA). ⚠️ **Só entrega no seu próprio endereço** enquanto não houver domínio verificado — o remetente é o compartilhado `onboarding@resend.dev`, e o Resend restringe o destino ao dono da conta. Cadastro de cliente real não funciona até o item 1.
> - **Redis:** senha e ACL no ar. Ele estava **sem senha nenhuma** — o container tinha subido antes de a exigência existir.
> - **Stripe:** variáveis pré-configuradas. Vazias, o checkout responde 503 e o webhook recusa com 400. Basta colar as chaves quando a conta existir.
> - **Google OAuth:** cliente criado, credenciais na VPS, rota `/v1/auth/google` devolvendo `200` com os escopos certos (`openid email profile`), PKCE e nonce. App em **Testes** com `davilopesg@gmail.com` como usuário de teste — publicar exige domínio verificado.
> - **Encarregado de dados (art. 41):** **Davi Gonçalves Lopes**, `davilopesg@gmail.com`. Fecha metade da **O-6**; a outra metade é a política de privacidade em si, que ainda não existe.
> - ⚠️ **A chave do Resend e o secret do Google passaram pelo chat.** Gire os dois quando estiver tudo funcionando.
>
> **Atualizado em 2026-09-04.** As **oito decisões** do painel de administração (DP-32 a DP-40) foram **todas respondidas** e estão em `docs/decisoes-do-produto.md`. O que resta aqui são **ações**, não escolhas: coisas que exigem a sua mão num serviço de terceiro ou um dado que só você tem.

As quatro primeiras **bloqueiam** alguma coisa. A sexta e a sétima reúnem oito escolhas que quase todas **não** bloqueiam — têm um padrão que eu sigo se você não disser nada. Duas exceções, e são as que valem a sua atenção: a **DP-32** decide quando o painel de administração pode ver cliente real, e a **DP-39** não tem padrão nenhum.

> **O item 3 já está resolvido.** Ficou aqui como registro do que foi decidido e do que a decisão produziu.

Cada item abaixo diz **o que ele destrava**, **o que exatamente preciso de você**, **onde conseguir** e **o que eu faço depois**. Estão em ordem de dependência — o item 1 é pré-requisito de metade dos outros.

> **Segredo nenhum passa por conversa.** Nem por chat, nem por e-mail, nem por commit. Cada item abaixo tem um procedimento que coloca o valor direto no `.env` da VPS, sem ele aparecer em lugar nenhum. Onde eu preciso apenas *saber que existe*, eu verifico depois pelo comportamento do sistema, não pelo valor.

---

## 1 · Um domínio próprio

**Este é o bloqueador de verdade.** Ele não estava na lista como item separado, e devia estar: os itens 2, 3 e 5 dependem dele, e nenhum funciona no endereço atual.

A Mavia está em `https://mavia.o9cmue.easypanel.host`. Esse endereço é um subdomínio do EasyPanel, não seu. Consequências concretas:

| O que quebra | Por quê |
|---|---|
| **E-mail** | SPF, DKIM e DMARC são registros DNS no domínio do remetente. Você não controla o DNS de `o9cmue.easypanel.host`, logo não consegue autenticar e-mail nenhum. Sem isso, confirmação de cadastro e recuperação de senha vão para o spam do Gmail — quando não são recusadas |
| **Google** | O console exige que o domínio da tela de consentimento seja um domínio verificado seu |
| **Confiança** | Uma tela de login financeira num subdomínio de painel de hospedagem parece phishing, e a pessoa que hesita em digitar a senha está certa em hesitar |

**O que preciso de você:** registrar um domínio e apontar o DNS para a VPS. Você já usa Hostinger — registrar por lá deixa o DNS no mesmo painel.

Sugestões, na ordem em que eu tentaria: `mavia.com.br` · `mavia.app` · `usemavia.com.br`. O `.com.br` custa cerca de R$ 40/ano no registro.br e transmite "empresa brasileira", o que num produto financeiro pesa.

**Registro DNS necessário:** um `A` apontando o domínio (e o `www`) para `2.24.79.49`.

**O que eu faço depois:** troco `DOMINIO` e `URL_PUBLICA` no `.env`, subo de novo, e o Traefik emite o certificado TLS sozinho. É uma linha de configuração e um deploy — cerca de dez minutos. Também acrescento o hostname separado do painel de admin (`admin.<seu-domínio>`), que o gate de segurança exigiu.

---

## 2 · Provedor de e-mail

**O que destrava:** hoje **ninguém consegue criar conta em produção**. O cadastro e a recuperação de senha respondem `503` — de propósito, porque fingir que mandou um e-mail é pior que recusar. Esta é a pendência que separa "instalado" de "usável".

### A recomendação: Resend

Comparei quatro, contra o que a Mavia realmente precisa: volume baixo (confirmação de cadastro, recuperação de senha, avisos de renovação, alertas — algo entre 500 e 1.000 mensagens por mês com uma centena de clientes), entrega confiável no Gmail e nos provedores brasileiros, e SMTP comum, porque o cliente de e-mail da API é SMTP escrito à mão e não fala API proprietária.

| Provedor | Faixa gratuita | Depois | Veredito |
|---|---|---|---|
| **Resend** ✅ | ~3.000/mês | ~US$ 20/mês para 50 mil | **Recomendado.** Cobre o primeiro ano inteiro de graça, SMTP funciona sem tocar no código, e o assistente de DNS é o menos sujeito a erro dos quatro |
| Amazon SES | — | ~US$ 0,10 por mil | O mais barato em escala, de longe. Mas começa em *sandbox* (só destinatários verificados) e sair dela é um pedido em formulário que a Amazon analisa. Vale a troca quando o volume justificar |
| Postmark | 100/mês | ~US$ 15/mês para 10 mil | A melhor entrega de e-mail transacional do mercado. Se recuperação de senha caindo em spam virar problema real, é para cá que eu migraria |
| Brevo | ~300/dia | Escala por contato | Voltado a marketing. IPs compartilhados com quem dispara em massa, e a reputação é compartilhada junto |

**Confirme os preços no site antes de assinar** — eles mudam, e os números acima são referência de ordem de grandeza, não cotação.

**O que eu não recomendo, e por quê:** SMTP do Gmail ou do Google Workspace. Tem limite diário baixo, não é feito para e-mail automático, e a mensagem sai de um endereço pessoal — o que faz a recuperação de senha da sua plataforma financeira chegar parecendo golpe.

### O que preciso de você

1. Criar a conta no Resend (precisa do domínio do item 1).
2. Adicionar o domínio lá e copiar os registros DNS que ele mostrar (SPF, DKIM e o de rastreio) para o DNS do domínio. São três ou quatro registros `TXT`/`CNAME`, copiar e colar.
3. Gerar uma **API key**.
4. Colocá-la na VPS **sem passar por aqui**, com este procedimento — ele lê o valor sem exibir na tela e sem gravar no histórico do shell:

```bash
ssh root@2.24.79.49
cd /opt/mavia/repo/infra/producao
read -rsp 'Cole a API key e tecle Enter: ' K; echo
sed -i '/^SMTP_HOST=/d;/^SMTP_USUARIO=/d;/^SMTP_SENHA=/d;/^SMTP_REMETENTE=/d' .env
{
  echo "SMTP_HOST=smtp.resend.com"
  echo "SMTP_USUARIO=resend"
  echo "SMTP_SENHA=$K"
  echo "SMTP_REMETENTE=Mavia <ola@SEU-DOMINIO>"
} >> .env
unset K
docker compose up -d api
```

Troque `SEU-DOMINIO` pelo domínio do item 1. O remetente precisa ser do domínio verificado no Resend — se for outro, o Resend recusa o envio.

**O que eu faço depois:** verifico o cadastro ponta a ponta em produção — crio uma conta de teste, confirmo que o e-mail chega, que o link funciona, que a recuperação de senha funciona, e que a mensagem passa em SPF, DKIM e DMARC. Reporto o resultado com a saída dos comandos.

---

## 3 · ~~Estorno de compra no cartão — ADR 0023~~ ✅ **resolvido em 2026-09-04**

**Você decidiu:** *"o estorno entra na fatura vigente, como é padrão nos bancos"* — que é exatamente a D1 do ADR.

**Está implementado e provado.** `apps/api/test/estorno-no-cartao.test.ts`, 10 asserções contra Postgres real; suíte completa em 471. Nenhuma migration foi necessária — o modelo já comportava a decisão, o que faltava era ela. A pendência **P-6** está fechada.

Um segundo defeito estava escondido atrás do primeiro e saiu junto: `settled_at` era gravado incondicionalmente, o que poria o crédito de cartão no realizado **antes de a fatura ser paga**. Agora nasce nulo e recebe data pelo pagamento da fatura, como todo lançamento de cartão.

O botão passou a existir na tela, com a frase que explica onde o crédito cai — quem estorna uma compra de março e vê o crédito em maio precisa entender isso sem abrir um documento.

<details>
<summary>O texto original, de quando isto esperava você</summary>

**O que falta: só a sua palavra.** Este é o item mais barato da lista.

A decisão está escrita, argumentada e com as alternativas rejeitadas registradas, em `docs/adr/0023-estorno-de-compra-no-cartao.md`. Ela está em estado **proposto**, e proposto significa que eu não implemento.

### A pergunta, em uma frase

> Você comprou algo no cartão em **março**. O reembolso caiu em **maio**. O crédito aparece na fatura de março ou na de maio?

### O que o ADR propõe: maio — a fatura aberta

Três razões, na ordem em que pesam:

1. **É o que a administradora do cartão faz.** Ela credita a fatura corrente. Em maio você paga menos, e é isso que sai da sua conta.
2. **Fatura fechada não se reescreve.** Creditar março faria a fatura de março passar a ter `pago > total` — um pagamento a maior que nunca existiu. Pior: a projeção de caixa de maio continuaria mostrando você pagando a fatura cheia, enquanto o banco vai cobrar menos. Número errado no eixo caixa é o defeito que este produto mais tenta evitar.
3. **Não é regra nova.** A regra 10 já diz que um lançamento entra na fatura cuja janela contém sua data. O estorno de maio cai na fatura de maio porque é em maio que ele existe. Criar uma exceção seria criar um segundo caminho de colocação de lançamento em fatura — e dois caminhos divergem.

**O caso comum sai de graça:** reembolso na mesma semana da compra cai na mesma fatura, o total já sai líquido, e ninguém precisa saber que existe um ADR sobre isso.

### O que você perde escolhendo maio

O relatório por categoria de março continua mostrando a compra cheia. Se você quiser saber "quanto gastei líquido naquela compra", a resposta não está no relatório do mês — mas o vínculo entre o estorno e a compra original **fica gravado**, e a vista "líquido por compra" vira uma consulta no dia em que for pedida. Nada é perdido; é adiado com o dado preservado.

Escolher março teria o efeito oposto: o relatório ficaria mais fiel e a correspondência com o dinheiro seria destruída de forma irrecuperável.

**O que preciso de você:** "aceito" ou "prefiro março, e aqui está o porquê".

**O que eu faço depois:** mudo o estado do ADR para aceito e implemento. Não precisa de migration — o modelo já comporta a decisão, o que faltava era ela. É trabalho de algumas horas, com testes, e fecha a pendência P-6. O botão de estorno passa a existir na tela de compra de cartão, com uma frase explicando onde o crédito vai cair.

</details>

---

## 4 · Stripe

**O que destrava:** hoje ninguém consegue pagar. O lado do webhook está implementado e testado — o que falta é a conta e o catálogo de preços dentro dela.

### Os preços já estão decididos (DP-41) e escritos no código

`packages/domain/src/catalogo.ts` é a fonte da verdade, em centavos. **Valores alinhados ao Organizze em 2026-09-04**, um a um:

| Plano | Mensal | Anual | Equivale a | Pessoas | Espaços | Anexos | Conexões |
|---|---:|---:|---:|---:|---:|---:|---:|
| Mavia Pessoal | R$ 35,00 | R$ 199,90 | Manual | 2 | 1 | 5 GB | 0 |
| Mavia Família | R$ 45,00 | R$ 399,90 | Conectado | 5 | 1 | 20 GB | 3 |
| Mavia Negócio | R$ 69,00 | R$ 599,90 | Conectado Plus | 10 | 3 | 50 GB | 10 |

**Não há mais fórmula ligando o anual ao mensal.** Os descontos são 52,4%, 25,9% e 27,5% — três números diferentes, herdados do concorrente. Os seis valores são declarados um a um no catálogo, e é assim que precisa ser.

> **Duas consequências que você precisa saber, e nenhuma é impeditiva.**
>
> **1. O reembolso proporcional ficou mais curto.** A fórmula é `pago − meses_iniciados × mensal`, e com o desconto anual do concorrente ela chega a zero mais cedo: **6º mês** no Pessoal, **9º** nos outros dois (sob os preços antigos era o 10º nos três). Quem paga R$ 199,90 em janeiro e cancela em junho recebe zero. A regra não mudou, o preço mudou. Se quiser uma política mais generosa, é uma decisão sua e eu implemento.
>
> **2. Empatados no preço, dois dos três níveis hoje perdem item a item.** `Família` custa exatamente o que custa o Conectado, que entrega **3 conexões bancárias**; `Negócio` custa o que custa o Conectado Plus, com **10 conexões, PF e PJ**. O nosso épico 12 (conexão bancária) não existe ainda. O `Pessoal` está bem — o Manual do concorrente também não conecta banco, e ainda damos 2 pessoas contra 1 dele.
>
> A recomendação do time está na §2.6 da spec: **vender só o `Pessoal` no lançamento** e abrir `Família` e `Negócio` quando o épico 12 entrar. O catálogo tem um booleano (`disponivelParaCompra`) desenhado exatamente para isso, e fechar um nível não exige migração de dado nenhuma. **Os três seguem abertos até você decidir.**

Se você quiser mudar qualquer um desses seis valores, **fale antes de criar os preços na Stripe**: mudar antes é editar uma linha; mudar depois é criar preços novos, migrar as assinaturas vivas e manter os antigos por causa de quem contratou pelo preço velho. Ver também a §8, sobre trocar preço pelo painel.

### O que preciso de você

**a) Uma conta Stripe brasileira**, com a empresa cadastrada — CNPJ, dados bancários, o processo normal de abertura. É o passo mais demorado da lista, porque depende da análise deles. Comece por ele.

**b) Seis preços criados no painel da Stripe**, exatamente estes:

| Produto | Preço | Recorrência |
|---|---|---|
| Mavia Pessoal | R$ 35,00 BRL | mensal |
| Mavia Pessoal | R$ 199,90 BRL | anual |
| Mavia Família | R$ 45,00 BRL | mensal |
| Mavia Família | R$ 399,90 BRL | anual |
| Mavia Negócio | R$ 69,00 BRL | mensal |
| Mavia Negócio | R$ 599,90 BRL | anual |

Atenção aos centavos nos anuais: são `199.90`, `399.90` e `599.90`. A Stripe pede o valor em centavos ou com vírgula decimal conforme a tela; confira que o resumo mostre **R$ 199,90** e não **R$ 19.990,00**.

Cada um gera um identificador que começa com `price_`. Esses **não são segredo** — pode me mandar os seis por aqui, ou me dizer que estão criados e eu leio pela API.

**c) Três segredos**, que **não** vêm por aqui:

| Chave | Onde encontrar |
|---|---|
| `STRIPE_SECRET_KEY` | Painel → Desenvolvedores → Chaves de API. Começa com `sk_live_` |
| `STRIPE_WEBHOOK_SECRET` | Painel → Desenvolvedores → Webhooks → criar endpoint para `https://SEU-DOMINIO/v1/cobranca/webhook` → o segredo de assinatura, que começa com `whsec_` |
| `STRIPE_PUBLISHABLE_KEY` | Mesma tela das chaves. Começa com `pk_live_`. Este é público por natureza, mas guardo junto |

Mesmo procedimento do item 2 para colocá-los na VPS — eu escrevo o comando exato quando chegarmos aqui.

**Comece pelas chaves de teste** (`sk_test_`, `whsec_` do modo de teste). Dá para validar o fluxo inteiro com os cartões de teste da Stripe antes de qualquer dinheiro real trocar de mãos, e é assim que eu quero verificar.

**O que eu faço depois:** ligo os `price_id` ao catálogo, implemento a criação da sessão de checkout — que é a única metade que falta —, e verifico o ciclo completo em modo de teste: assinar, renovar, falhar o pagamento, entrar em graça, cancelar, reembolsar.

---

## 5 · Cliente OAuth do Google

**O que destrava:** o botão "Continuar com o Google" na tela de login. Ele existe e responde `503` hoje, com a tela dizendo para usar e-mail e senha. Não é urgente — o login por e-mail e senha funciona —, mas é o caminho que a maioria das pessoas prefere.

**Depende do item 1.** O Google exige domínio verificado na tela de consentimento.

### O passo a passo

1. **console.cloud.google.com** → criar um projeto chamado `Mavia`.
2. **APIs e serviços → Tela de permissão OAuth**:
   - Tipo: **Externo**
   - Nome do app: `Mavia`
   - E-mail de suporte e e-mail do desenvolvedor: o seu
   - **Domínio autorizado:** o domínio do item 1
   - **Escopos:** `openid`, `email`, `profile` — e **nada além disso**. Cada escopo a mais é um dado a mais que a Mavia passa a receber sem precisar
   - **Publicar o app.** Isto importa: em modo de teste, só 100 pessoas cadastradas à mão conseguem entrar

   > **Os três escopos acima são não-sensíveis, e por isso o app não passa por análise de verificação do Google.** É publicar e usar. Se um dia alguém propuser ler o Gmail ou o Drive do usuário, aí entra análise — e a resposta deve ser não.

3. **Credenciais → Criar credenciais → ID do cliente OAuth → Aplicativo da Web**:
   - **Origens JavaScript autorizadas:** `https://SEU-DOMINIO`
   - **URIs de redirecionamento autorizados:** `https://SEU-DOMINIO/entrar/google`

   Esse endereço de redirecionamento precisa bater **caractere por caractere** com o que a API manda. Uma barra a mais no fim e o Google recusa com `redirect_uri_mismatch`, que é o erro mais comum desta configuração.

4. Copiar o **ID do cliente** e o **secret**.

**O que preciso de você:** os dois valores na VPS, com o mesmo procedimento do item 2 — `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` no `.env`, seguido de `docker compose up -d api`. O `GOOGLE_REDIRECT_URI` o compose já monta sozinho a partir da `URL_PUBLICA`.

O ID do cliente aparece na URL do navegador durante o login — é público. O secret não.

**O que eu faço depois:** entro pelo Google em produção e confirmo os quatro pontos que o gate de segurança cobrou: a validação do `alg` antes de qualquer operação de cripto, o `iss` exato, o `aud` conferido, e o cookie de vínculo `__Host-mavia_oauth` que fecha o CSRF de login.

---

## 6 · Três escolhas do painel de admin

Vieram da revisão de LGPD do épico do painel. **Nenhuma bloqueia o trabalho** — todas têm um padrão vigente que eu sigo se você não disser nada. Estão aqui porque duas delas mudam o que o produto promete, e uma decide quando o painel pode ver cliente real.

### DP-32 · Até quando o painel fica sem MFA?

O produto tem as colunas de MFA no banco desde a fundação e **nenhuma rota que as use**. A LIA declara isso como fato, não como pendência escondida, e a frase que importa é: nenhum controle compensatório reduz a *consequência* de uma senha de operador vazada. Todos reduzem probabilidade ou ajudam a reconstituir depois.

Escolha um marco, não uma data vaga:

| | |
|---|---|
| **(a)** | antes do primeiro cliente pagante — **é o padrão vigente** |
| (b) | antes do décimo espaço em produção |
| (c) | antes do épico 12, quando entra conexão bancária |
| (d) | o painel entra sem MFA e o assunto volta em seis meses |

**Consequência do padrão (a), e ela é concreta:** enquanto você não escolher, o painel de administração **não vai a produção com clientes reais**. Ele é construído, testado e roda local. Não é bloqueio que eu inventei — é o que o balanceamento de legítimo interesse assume ao concluir que o acesso do operador prevalece sobre a expectativa do titular.

### DP-33 · Por quanto tempo um motivo vale?

Antes de abrir o espaço de um cliente, o operador informa o motivo (`chamado`, `incidente`, `defeito`, `ordem_judicial`) e a referência. A pergunta é se isso vale para uma requisição, para uma sessão de trabalho ou para o dia.

**Padrão vigente: 30 minutos.** Uma requisição por vez é o mais estrito e torna o painel inutilizável — cada clique pediria o número do chamado de novo. O dia inteiro faz a hipótese declarada virar carimbo de manhã. Cada abertura continua gerando **sua própria linha** de auditoria, com rota e contagem; o que a janela reaproveita é a hipótese, nunca o registro.

### DP-34 · Com um operador só, o aviso vai para onde?

O desenho compra detecção notificando *os outros* administradores a cada abertura de espaço. Hoje existe um: você. A salvaguarda é vazia até existir um segundo — e ela é justamente a que compensa você ter decidido que o log não é exposto ao cliente.

**Padrão vigente: sim, destino externo** — o aviso vai para um e-mail seu fora do domínio da aplicação. A razão é simples: uma notificação que só existe dentro do sistema que ela vigia não detecta o comprometimento desse sistema.

Se você responder **não**, o balanceamento perde a única salvaguarda de detecção e a LIA precisa ser refeita. Isso está escrito lá, não é ameaça retórica.

---

## 7 · Cinco decisões comerciais sobre o painel

Vieram do **validador financeiro**, que revisou o painel pela primeira vez e reprovou o épico para tickets. O veredito dele, na íntegra: *"Este é um dos melhores specs de banco de dados que já li neste repositório. A parte de dinheiro dele não existe."*

Ele achou catorze coisas que um operador **bem-intencionado**, atendendo um chamado, produziria sem má-fé nem erro de digitação. Estou consertando todas. Cinco dependem de uma escolha sua sobre como o negócio funciona — não sobre como o código funciona.

**Quatro têm padrão vigente e eu já sigo por ele.** Só a DP-39 não tem.

### DP-36 · Um pagamento por fora libera o cliente?

Cliente com cartão recusado entra em atraso, com 14 dias de graça. Ele liga, paga por Pix, o operador dá baixa. **Hoje isso não libera nada** — a tabela de pagamentos manuais não tem coluna que se ligue à assinatura. No 15º dia o cliente que pagou fica bloqueado, e o operador já tinha dito a ele que estava resolvido.

**Padrão vigente:** a baixa aplica a transição de pagamento recuperado na mesma transação e limpa a graça. É a única escrita em `estado` que o painel tem, e ela é nomeada.

Se você preferir que a baixa seja **só registro fiscal**, diga — mas então precisa existir outra ação que libere o cliente, senão o problema fica de pé.

### DP-37 · Qual competência a baixa registra?

Um Pix em 28 de setembro quitando o ciclo de outubro tem duas respostas legítimas: a competência do **dinheiro recebido** (setembro) ou a do **período coberto** (outubro). Elas divergem de um mês na escrituração.

**Padrão vigente:** competência do recebimento, uma linha por pagamento.

Há uma armadilha aritmética atrás disso, e é por ela que eu recomendo esse padrão: um pagamento anual cobre doze competências, e R$ 590,00 ÷ 12 e R$ 790,00 ÷ 12 **não são exatos**. Uma linha por competência reintroduziria uma divisão no caminho do dinheiro, que é justamente o que a fórmula de reembolso foi desenhada para não ter.

### DP-38 · Cortesia é receita?

O meio de pagamento é uma lista: Pix, transferência, boleto, dinheiro, **cortesia** e ajuste. Os quatro primeiros são dinheiro que entrou. Cortesia é dinheiro que **não** entrou — e hoje ela mora na mesma coluna de valor.

Uma cortesia de R$ 99,00 para compensar uma indisponibilidade faz a receita crescer R$ 99,00 sem um centavo ter se movido, e sai na exportação do cliente como um pagamento que ele nunca fez. Se a nota fiscal um dia existir, ela nasce sobre um valor inexistente.

**Padrão vigente:** cortesia tem valor zero, e o valor dispensado vai para um campo próprio. Aparece na listagem, não entra no total — que é exatamente o que a regra de transferência já faz no produto.

### DP-39 · **Esta não tem padrão. Preciso de você.**

Quando o operador troca o plano de um cliente, **o que acontece na Stripe?**

O problema é que existe um job diário comparando a nossa tabela de assinaturas com a Stripe, e a regra dele já está escrita: divergência é incidente, a correção segue a Stripe, e quando o acesso é reduzido o cliente recebe um e-mail.

Toda escrita legítima do painel é, por construção, uma divergência. Sem uma resposta aqui, no dia do deploy: cada atendimento gera um incidente; o job **desfaz** o que o operador fez; e o cliente recebe um e-mail dizendo que o acesso dele foi reduzido, por uma mudança que a Mavia fez e desfez sozinha.

As três saídas:

| | |
|---|---|
| **(a)** | O painel escreve na Stripe e espera o webhook voltar. Mais lento, mais correto, e a Stripe continua sendo a fonte única |
| **(b)** | A nossa linha ganha uma marca de origem que o job reconhece e respeita. Mais rápido, e cria uma segunda fonte de verdade |
| **(c)** | Trocar plano pelo painel fica **proibido** enquanto houver assinatura ativa na Stripe; o operador orienta o cliente a trocar sozinho |

Eu recomendo **(a)**. Ela é a única que não cria uma segunda verdade sobre quanto o cliente paga.

### DP-40 · O operador pode rebaixar o plano no meio de um ciclo pago?

> **Enquanto eu escrevia isto, a revisão encontrou um defeito vivo em produção** e a resposta a esta pergunta mudou de natureza. A rota que o cliente usa para descer de plano **confirma o agendamento e não guarda nada** — o comentário no código diz "registra a intenção para o fim do período", e o `return` acontece antes de qualquer escrita. Não existe tabela de troca agendada nem job que a aplicasse.
>
> Ou seja: hoje um cliente que pede downgrade é informado da data, e no dia seguinte continua no plano caro, sendo cobrado por ele. Está registrado como **P-17**, e é do épico de cobrança, não do painel.
>
> Por isso a troca de plano **saiu do escopo do painel**: o desenho mandava chamar o mesmo caminho da rota do cliente, e ao procurá-lo para reusar, ele não existia. Sua resposta abaixo continua valendo — ela decide o que construir —, mas ela agora governa as duas rotas, não só a do operador.

A rota do cliente **recusa** isso hoje, com um comentário no código dizendo o porquê: *"o cliente comprou aquele período inteiro"*. Um downgrade fica agendado para o fim do período.

O painel passaria por cima. Cliente Negócio que pagou R$ 99,00 no dia 1º e é rebaixado no dia 10 perde 21 dias de plano pago — **R$ 69,00 que já estão no caixa da Mavia**, sem crédito e sem devolução.

**Padrão vigente:** não pode. O painel agenda para o fim do período, chamando o mesmo caminho que a rota do cliente usa.

Se você quiser que o operador possa furar a regra — e há casos em que faz sentido, como um cliente insatisfeito que você quer acomodar —, diga como o cliente é compensado pelos dias que comprou e não vai usar.

---

## Ordem que eu sugiro

```
1. Domínio          ─┬─→ 2. E-mail  (destrava o cadastro — é o que faz o produto existir)
                     └─→ 5. Google  (conforto, não bloqueio)

3. ADR 0023          (independente de tudo; é uma frase sua)

4. Stripe            (comece a abertura da conta agora, em paralelo — é o que mais demora)

6. DP-32/33/34       (não bloqueiam; a DP-32 decide quando o painel vê cliente real)

7. DP-36 a DP-40     (quatro têm padrão e eu sigo; a **DP-39** não tem, e sem ela
                      o painel e o job da Stripe se desfazem todo dia)
```

Se você fizer só duas coisas desta lista, faça o **domínio** e o **provedor de e-mail**. Sem elas a Mavia está instalada, mas ninguém de fora consegue entrar nela.

---

## O que não está aqui

Duas coisas que são minhas e eu não vou empurrar para você:

- **MFA.** Vou trazer como proposta com desenho pronto, e vou insistir: enquanto o painel de admin não existia, uma senha vazada custava um espaço. Com ele, custa a base inteira.
- **A senha do Redis.** Está corrigida no repositório e o deploy em produção precisa da sua autorização para rodar — o ambiente bloqueou a execução automática. É um comando, e eu explico o que ele faz antes.
