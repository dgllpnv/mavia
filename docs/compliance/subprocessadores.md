# Terceiros que tratam dado pessoal da Mavia

- **Data:** 2026-09-01
- **Autor:** `especialista-lgpd-compliance`
- **Status:** Normativo. Este arquivo é prometido em `docs/compliance/retencao-e-eliminacao.md` §9.3 e exigido por `docs/produto/spec-planos-e-assinatura.md` §11.3.
- **Insumos:** LGPD arts. 5º VII e VIII, 6º III, 7º, 9º, 26, 33, 39, 48 · `docs/produto/spec-planos-e-assinatura.md` §11 · `docs/produto/spec-autenticacao.md` §9 · `docs/compliance/retencao-e-eliminacao.md` §2.2, §3.6, §9

> **Regra de manutenção.** Nenhum terceiro recebe ou fornece dado pessoal sem uma linha aqui. Acrescentar um fornecedor é acrescentar uma seção **antes** da primeira chamada em produção — não depois, não "quando der". Se este arquivo estiver desatualizado, a política de privacidade está mentindo, e a resposta a um incidente (art. 48) fica impossível de fazer direito.

---

## 1. Por que este arquivo não se chama "subprocessadores"

Porque nem todo terceiro é operador, e tratar os dois casos com a mesma palavra produz um registro de base legal que não se sustenta.

| Categoria | O que é | Contrato | Quem está aqui |
|---|---|---|---|
| **Operador** (art. 5º VII) | Trata dado pessoal **em nome da** Mavia, sob as nossas instruções | **Contrato de operador obrigatório** (art. 39) | Stripe, para o processamento do pagamento |
| **Controlador independente** | Decide o próprio tratamento, por obrigação ou interesse dele | Não há contrato de operador a firmar; há o que **declarar** | Stripe, para as obrigações regulatórias dela |
| **Fonte** | O titular autoriza um terceiro a **nos divulgar** dado dele | Não há contrato de operador. Há transparência a prestar | Google, na entrada por OIDC |

Chamar o Google de "subprocessador" seria conveniente e errado: ele não trata nada em nome da Mavia. Chamar a Stripe apenas de operadora seria igualmente errado: ela tem obrigações regulatórias próprias sobre os mesmos dados.

---

## 2. Stripe — cobrança e assinatura

- **Decisão de origem:** DP-14 (`docs/decisoes-do-produto.md`)
- **Épico:** 11
- **Situação:** **ainda não em produção.** As três exigências do §2.5 são bloqueantes para a primeira cobrança real.

### 2.1 Papel

**Duplo, e declarado como tal.**

- **Operadora** para a finalidade que contratamos: processar a cobrança da assinatura sob as nossas instruções.
- **Controladora independente** para as obrigações regulatórias dela — prevenção a fraude, conformidade de instituição de pagamento, retenção contábil e fiscal na jurisdição em que opera. Sobre esse tratamento a Mavia não dá instrução e não pode prometer eliminação.

A distinção não é acadêmica: ela determina o que podemos afirmar ao titular. Podemos dizer que **paramos** de usar os dados dele na Stripe; não podemos dizer que a Stripe os apaga.

### 2.2 O que sai daqui para lá

| Dado | Por quê | Base legal |
|---|---|---|
| E-mail do `proprietario` | Emitir recibo e permitir que ele gerencie o próprio meio de pagamento no portal | Execução de contrato (7º V) |
| Nome (opcional) | Identificar o pagador no recibo | Execução de contrato |
| `tenant_id` como referência opaca | Ligar o pagamento ao espaço, sem revelar nada sobre ele | Execução de contrato |
| `price_id` do plano e intervalo | É o que está sendo comprado | Execução de contrato |
| Dado do cartão | **Digitado pelo titular direto na Stripe.** Não transita pelo nosso servidor | Execução de contrato |

**O que nunca sai, e é veto:** saldo, `Lancamento`, descrição, nome de conta ou de cartão, categoria, anexo, documento fiscal — nada do espaço financeiro, nem como campo, nem como metadado, nem como "contexto". `spec-planos-e-assinatura.md` §11.2.

### 2.3 O que entra de lá para cá

Eventos de assinatura e cobrança (`event.id`, tipo, estado, período, valor), últimos 4 dígitos, marca e mês/ano de validade do cartão. **Nunca** PAN, **nunca** CVV, **nunca** validade completa — não existe coluna para eles em nenhuma tabela, em nenhum épico.

Consequência de desenho: o dado de cartão nunca transita pelo nosso servidor, e por isso a Mavia **não entra no escopo PCI-DSS**. Isso é propriedade da arquitetura, não promessa operacional.

### 2.4 Transferência internacional (art. 33)

O processamento ocorre fora do Brasil. Isso é fato, não hipótese, e o mecanismo de adequação precisa estar arquivado **antes** da primeira cobrança: DPA da Stripe assinado, com as cláusulas-padrão contratuais, e o registro de onde o processamento acontece.

### 2.5 Exigências bloqueantes antes da primeira cobrança real

1. DPA assinado e arquivado, com as cláusulas do §2.4.
2. Esta seção citada, em português comum, na política de privacidade e na tela **Configurações → Dados e privacidade** — não enterrada nos termos.
3. Retenção declarada: os registros de pagamento na Stripe seguem a retenção **dela**, e o titular precisa saber disso antes de assinar, porque é a exceção que a nossa promessa de eliminação não alcança.

### 2.6 O que acontece na eliminação do espaço

`DELETE /tenants/:id` cancela a assinatura e apaga o `Customer` na Stripe **antes** de apagar qualquer linha nossa (`retencao-e-eliminacao.md` §5.3). A Stripe retém o que a legislação dela exige — limite conhecido, declarado, e fora do nosso alcance.

---

## 3. Google — entrada por OIDC

- **Decisão de origem:** DP-12 (`docs/decisoes-do-produto.md`)
- **Épico:** 1
- **Detalhe completo:** `docs/produto/spec-autenticacao.md` §1 e §9

### 3.1 Papel

**O Google não é operador da Mavia.** Ele não trata dado em nosso nome e não recebe instrução nossa. Ele é **fonte**: divulga à Mavia, por autorização do próprio titular na tela de consentimento dele, um conjunto fixo de atributos. A Mavia é **controladora** do que recebe, e a base do nosso tratamento é execução de contrato — não o consentimento exibido na tela do Google, que é autorização de **divulgação** dada a ele, não base de tratamento nossa.

Confundir as duas coisas é o erro mais comum deste tipo de integração, e produz um registro que não sobrevive a uma pergunta da ANPD.

### 3.2 O que entra de lá para cá

| Dado | Guardamos | Finalidade | Base legal |
|---|---|---|---|
| `iss` + `sub` | Sim, literal | É a chave de identidade — estável, não reutilizada, indiferente à troca de e-mail | Execução de contrato (7º V) |
| `email` | Sim, como **dica**, nunca como chave | Mostrar "você entrou como…" e sustentar a decisão de vinculação | Execução de contrato |
| `email_verified` | Sim | Sem ele, o `email` é texto digitado noutro produto | Execução de contrato |
| `name` | Sim, **uma vez**, na criação | Não pedir o nome duas vezes. Editável depois; login posterior não sobrescreve | Execução de contrato |
| `picture`, `hd` | **Não** | — | — |
| `access_token`, `refresh_token` do Google | **Não** — descartados na mesma função que validou o `id_token` | Não usamos API do Google. Guardá-los criaria um ativo cifrado sem finalidade | — |

**Minimização:** escopos `openid email profile` e nada mais. Ampliar escopo é decisão nova, com finalidade declarada — nunca "já que estamos aqui".

### 3.3 O que sai daqui para lá, e a direção do art. 33

O fluxo é predominantemente de entrada, mas não é de mão única: ao iniciar a autorização, o Google fica sabendo — porque a requisição carrega o nosso `client_id` — **que aquela pessoa está entrando na Mavia, e quando**. Isso é divulgação de dado pessoal a um destinatário no exterior.

Registro a precisão, porque um documento de conformidade que erra a direção da regra é pior que nenhum: **o art. 33 governa a transferência *para* fora do país.** O recebimento de atributos vindos do Google não é, por si, transferência internacional na acepção do art. 5º XV. O que exige declaração é a parcela de saída acima — mínima em conteúdo e real em existência —, e ela é declarada aqui e na política de privacidade pelo mesmo padrão aplicado à Stripe: quem é, o que atravessa, para quê, e sob que base.

### 3.4 Transparência no ponto de uso

Frase obrigatória na tela **Dados e privacidade**, e não nos termos:

> *"Ao entrar com o Google, recebemos seu identificador de conta, seu e-mail e seu nome. Não recebemos sua senha, e não temos acesso ao seu Gmail, à sua Agenda nem ao seu Drive."*

### 3.5 O que acontece na eliminação

`identidades_federadas` é apagada fisicamente em `DELETE /auth/eu` (`retencao-e-eliminacao.md` §5.2, com o acréscimo de `spec-autenticacao.md` §9.4). Não é zelo: se a linha sobrevivesse, o mesmo `sub` reencontraria o `usuario_id` eliminado e **ressuscitaria a conta no login seguinte** — a eliminação seria desfeita pelo próprio produto.

---

## 4. Quem **não** está aqui, e por quê

Declarar a ausência vale tanto quanto declarar a presença — é o que impede alguém de acrescentar um fornecedor "porque é rápido".

| Não usamos | Por quê |
|---|---|
| **Provedor fiscal / emissor de NFS-e** | DP-16: não emitimos nota automaticamente. Nenhuma integração fiscal existe, e nenhum dado sai para emissor nenhum. Se a emissão futura (Salvador/BA) for feita por terceiro, ele entra aqui **antes** da primeira nota |
| **Fornecedor de IA, LLM ou OCR externo** | DP-11: a categorização é **local**, por regra do usuário e histórico do próprio espaço. Nenhuma descrição de lançamento sai da VPS. Um teste de CI roda o módulo `inteligencia` **sem rede** e prova isso (R-16) |
| **Agregador bancário** (Pluggy, Belvo ou equivalente) | Épico 12, e ainda não existe (ADR 0003). Quando existir, entra aqui como **operador**, com contrato, escopo e a mecânica de revogação do ADR 0019 |
| **Analytics de terceiro, pixel, mapa de calor, SDK de sessão** | Não usamos. Um produto que mostra saldo bancário não carrega script de terceiro na página em que o saldo aparece |
| **Provedor de push e de e-mail transacional** | ⚠️ **Lacuna conhecida.** As notificações do produto exigirão um desses, e ele será operador. Precisa entrar aqui, com o mesmo detalhamento, antes do primeiro envio. Regra que já vale: o corpo de push e de e-mail **nunca contém valor monetário nem descrição** (A-43) |
| **Serviço de consulta de CPF/CNPJ** | Veto. A validação do documento é dígito verificador, aritmética local. Consultar Receita, Serpro ou base paga seria transferência a terceiro e coleta do que não pedimos (`spec-planos-e-assinatura.md` §11.4.4) |

---

## 5. O que o titular precisa poder ler

A política de privacidade nomeia cada terceiro do §2 e do §3 **pelo nome**, com uma frase sobre o que ele recebe e para quê. Aviso prévio a toda mudança desta lista — inclusão de fornecedor é informação, não detalhe de implementação.

E as duas exceções que a promessa de eliminação não alcança, escritas em português comum (`retencao-e-eliminacao.md` §4.6 tem as suas; estas são as de terceiros):

1. **Stripe** retém os registros de pagamento pelo prazo da legislação dela, mesmo depois de o espaço ser eliminado.
2. **Google** mantém o registro de que a autorização foi concedida, na conta do próprio titular, e é lá que ele a revoga.
