# ADR 0020 — Billing: fonte de verdade, teste fora do provedor, catálogo em código e documento fiscal

- **Status:** Aceita
- **Data:** 2026-09-01
- **Autores:** `product-financeiro` + `especialista-lgpd-compliance`
- **Decisões do dono que ela materializa:** DP-13 (três níveis), DP-14 (Stripe), DP-15 (teste de 7 dias sem cartão), DP-16 (sem emissão automática de nota), DP-17 (vender os três), DP-18 (nomes), DP-19 (mensal e anual)
- **Spec de origem:** `docs/produto/spec-planos-e-assinatura.md`
- **Emenda:** `docs/compliance/retencao-e-eliminacao.md` §2.2 — ver **D4**

> **Por que uma ADR só para quatro decisões.** Elas não são independentes: a fonte de verdade única (D1) é o que permite o teste viver fora do provedor (D2); o catálogo em código (D3) é o que torna as cotas testáveis sem consultar ninguém; e o documento fiscal (D4) só existe porque há cobrança. Separá-las produziria quatro ADRs que só se leem juntas.

---

## Contexto

O épico 11 introduz a primeira integração em que **um sistema externo decide algo sobre o nosso produto**. Até aqui, todo terceiro era fonte de dado que revisávamos (`BankSyncProvider`, ADR 0003) ou destino de dado que enviávamos. Um provedor de pagamento é diferente: o estado dele muda sozinho — por retentativa, por falha de cartão, por ação do titular no portal dele — e chega até nós por webhook, **fora de ordem e mais de uma vez**.

Três perguntas precisavam de resposta antes da primeira linha de código, e a quarta apareceu como consequência:

1. Quem é dono do estado da assinatura, nós ou a Stripe?
2. O teste de 7 dias sem cartão (DP-15) existe onde?
3. Onde vivem os preços e as cotas?
4. A cobrança exige documento fiscal, e `retencao-e-eliminacao.md` §2.2 declarava que documento nenhum é coletado — e que criar a coluna **exige ADR**. Esta é a ADR.

---

## D1 — A fonte de verdade do estado da assinatura fica de um lado só

> **A Stripe é a fonte de verdade do pagamento. A Mavia é a fonte de verdade do direito de uso.**
>
> `assinaturas.estado` **nunca** é consultado na Stripe em tempo de requisição, e **nunca** é escrito por nada além do processador de eventos e do job de expiração do teste. Toda decisão de permissão lê a nossa linha; toda mudança de dinheiro nasce lá e chega por webhook.

**Por quê.** Se os dois lados puderem escrever, um webhook fora de ordem somado a uma ação de tela produz um estado que nenhum dos dois explica, e o cliente vê *"paguei e continuo bloqueado"* — a pior frase que um produto de cobrança pode produzir. Com a divisão acima, cada pergunta tem exatamente um dono, e a discordância entre eles vira **detectável** em vez de misteriosa.

**Mecânica que decorre da decisão:**

- **Idempotência de entrada:** `INSERT INTO eventos_cobranca (id) … ON CONFLICT DO NOTHING RETURNING id`, com `id` = `event.id` da Stripe. Só processa quem reivindicou a linha. É **o mesmo padrão do `outbox`** (`sistema.md` §5.1) — nenhum mecanismo novo entra no sistema.
- **Ordem irrelevante por construção:** o processador **não aplica o payload do evento**; ele relê a assinatura na API da Stripe e projeta o estado corrente. Um evento atrasado busca o objeto atual e escreve a mesma coisa. `ultimo_evento_em` é a segunda camada, para que um evento mais velho não regrida o estado.
- **Idempotência de saída:** `Idempotency-Key` **determinística e derivada do domínio** (`assinatura:${tenant_id}:${acao}:${plano_codigo}:${intervalo}:${plano_versao}`), nunca um UUID novo por tentativa — chave aleatória por tentativa não impede nada, e é o defeito clássico da cobrança duplicada. Vale igualmente para reembolso: reembolsar duas vezes é tão grave quanto cobrar duas vezes.
- **Reconciliação diária**, e **divergência é incidente**, não warning — mesma linguagem de `saldo.reconciliar`. A correção segue a Stripe, grava em `auditoria`, e avisa antes de reduzir acesso.

**Exceção de tenancy, nominada.** `eventos_cobranca` **não tem `tenant_id`** e vive fora da RLS: o evento chega antes de sabermos o tenant. Para que a exceção seja segura, a tabela **não contém dado pessoal** — só id, tipo, horários e resultado, nunca payload, nunca e-mail, nunca valor. O efeito é aplicado numa segunda transação, com `SET LOCAL app.tenant_id`. É a terceira exceção declarada do sistema, ao lado de `outbox_pendencias` e da view `tenants_ativos`, e existe pela mesma razão: *uma exceção escrita é auditável; uma exceção implícita não é.*

---

## D2 — O teste de 7 dias não existe na Stripe

Sem cartão não há `Customer`, não há `Subscription`, não há o que criar. O teste é inteiramente nosso: `estado = 'teste'` mais `teste_termina_em`, expirado por job. A assinatura na Stripe nasce **no clique de assinar**, nunca antes.

**Por quê.** Modelar o teste como `trial` da Stripe exigiria criar o cliente lá antes de existir pagamento — o que significa enviar e-mail do titular a um terceiro no exterior para uma finalidade que ainda não se concretizou. Mantendo o teste do nosso lado, **durante os sete dias nenhum dado pessoal sai da Mavia por causa de cobrança**, e isso é afirmável ao cliente porque é verdade verificável no código.

**Consequências:** não usamos `customer.subscription.trial_will_end`; os avisos de D-3, D-1 e D0 são nossos; e a invariante `estado = 'teste' ⟹ stripe_subscription_id IS NULL` é testável em S2.

---

## D3 — O catálogo de planos vive em código, não em tabela

`packages/domain/billing/catalogo.ts`, chaveado por `(codigo, intervalo)`: três planos × dois intervalos = seis entradas. Cada uma declara nome, preço (`Money` em centavos), `stripe_price_id`, cotas, disponibilidade e versão.

**Por quê.** É o mesmo argumento que a política de retenção já usa para a política de descarte (`retencao-e-eliminacao.md` §1): **configuração versionada em código não é alterável em produção sem deploy e sem teste.** Uma tabela de planos permite que alguém mude uma cota — ou um preço — sem revisão, sem migração e sem que nenhum teste perceba. E `limitesDoPlano(codigo)` sendo função pura a torna testável em S1, sem banco.

**Regras de dinheiro que a decisão fixa:**

- O preço anual é uma `Money` **declarada**, nunca obtida multiplicando o mensal em tempo de execução. Preço derivado por aritmética é preço que diverge entre a vitrine, a Stripe e o reembolso.
- As **cotas dependem só do `codigo`**; o `intervalo` muda preço e duração, jamais o que o plano libera. Um plano anual com cotas diferentes seria um quarto plano com outro nome.
- Mudança de preço cria **versão nova**. `Assinatura` guarda `plano_versao` e mantém o preço contratado até migração explícita e comunicada.
- A fórmula de reembolso — `max(0, valor_pago − meses_iniciados × preco_mensal)` — foi escolhida para **não conter divisão**: uma subtração e uma multiplicação em centavos, nenhum arredondamento a declarar, a regra 3 do `CLAUDE.md` não é acionada e `ratear` não entra no caminho do dinheiro.

---

## D4 — Coletar CPF ou CNPJ no checkout, como exceção nominada à minimização

`retencao-e-eliminacao.md` §2.2 declarava que documento nenhum é coletado, *"e criar uma [coluna] exige ADR"*. Esta é a ADR, e a §2.2 já foi corrigida para não seguir se contradizendo.

**Decisão.** Um campo, **obrigatório**, no checkout: CPF ou CNPJ, em tabela própria `dados_fiscais`, com base legal **obrigação legal** (art. 7º II) e finalidade única de emissão fiscal.

**Por quê, apesar de DP-16 ter decidido não emitir nota agora.** O argumento não é sobre qual lado é mais nobre — é sobre **qual erro tem volta**. Coletar e não precisar custa apagar uma tabela e gravar a execução: reversível em um deploy. Não coletar e precisar custa pedir documento a quem já é cliente, com resposta parcial, contato constrangedor, e **quem cancelou antes do pedido inalcançável para sempre**. Coletar agora custa um campo; coletar depois custa a base inteira, e nunca fecha em 100%.

**Obrigatório, e não opcional**, porque um campo opcional entrega o custo de LGPD por inteiro e metade do benefício — e a metade não preenchida é exatamente a campanha retroativa que se queria evitar.

**Os quatro vetos que tornam a coleta defensável.** O que se ataca não é CPF coletado para obrigação fiscal; é CPF virando identificador de uso geral. Portanto, normativamente:

1. **Nunca é identificador** — não serve para login, não é chave, não aparece em URL, não indexa nada.
2. **Nunca é antifraude** — não detecta teste repetido nem conta duplicada. A guarda de abuso continua sendo "um teste por usuário".
3. **Nunca é enriquecido nem consultado** em base externa, pública ou paga. A validação é dígito verificador, aritmética local, e um teste roda sem rede para provar.
4. **Nunca sai** — log, métrica, notificação, e-mail, resposta a quem não é `proprietario`, exportação de outro membro. Entra na lista de campos proibidos em resposta da regra R-5 da matriz de acesso.

**Escopo mínimo:** só de quem assina, só no checkout, **nunca durante o teste**. `nome_fiscal` só quando o documento é CNPJ. **Endereço continua não coletado** — se a emissão futura o exigir, é decisão nova, não coleta antecipada por precaução.

**Retenção:** enquanto houver `Cobranca` do tenant dentro de 5 anos contados de 1º de janeiro do ano seguinte à cobrança (CTN art. 173 I). Sobrevive à eliminação do espaço, junto de `cobrancas` — e é o **único** lugar onde o documento do titular sobrevive, o que precisa estar em português comum na tela "Dados e privacidade".

**A saída, escrita para que a coleta não vire permanente por inércia:** se o dono decidir definitivamente não emitir nota, a base legal desaparece e `dados_fiscais` é apagada por inteiro sob `mavia_retencao`, com entrada em `retencao_execucoes`.

---

## Consequências

**Positivas.**

- Nenhum seam novo, nenhum padrão novo: a idempotência de webhook reusa o mecanismo do `outbox`, as cotas são função pura em S1, a exceção de RLS segue o molde já existente.
- O produto continua fora do escopo PCI-DSS por desenho — o dado de cartão nunca transita pelo nosso servidor.
- Sete dias de uso sem que qualquer dado saia para o provedor de pagamento (D2), o que é diferencial real e barato de afirmar quando é verdade.
- A dívida fiscal retroativa não se acumula (D4).
- Preço e cota mudam por deploy revisado, nunca por `UPDATE` em produção (D3).

**Negativas.**

- Um campo a mais no checkout, no ponto em que todo campo custa conversão. A queda na etapa precisa ser medida; se for material, é decisão nova e não ajuste silencioso.
- Passamos a guardar um identificador nacional único, que é o dado de correlação por excelência. O perfil de risco de um vazamento nosso muda, e é o que os quatro vetos existem para conter.
- A releitura na Stripe a cada evento custa uma chamada de API por webhook. Volume trivial hoje; se um dia não for, a otimização é cache com invalidação por evento, nunca voltar a aplicar payload.
- Mensal e anual dobram a matriz de preços (seis `price_id`) e trazem proração, reembolso parcial e renovação anual — complexidade aceita por DP-19, com as mitigações no spec (§6.2 a §6.4).

---

## Alternativas rejeitadas

**Ler o estado da assinatura na Stripe a cada requisição.** Elimina a cópia e a divergência, ao preço de uma chamada de rede síncrona no caminho de toda requisição autenticada, e de o produto inteiro cair quando a Stripe oscilar. Trocaria um problema raro e detectável por um acoplamento permanente.

**Deixar os dois lados escreverem, com "última escrita vence".** É o desenho que produz o estado inexplicável descrito em D1. "Última escrita" não é definível quando os eventos chegam fora de ordem.

**Modelar o teste como `trial` da Stripe.** Uniformidade aparente, ao custo de criar cliente no exterior antes de existir pagamento, e de perder a afirmação verdadeira de D2.

**Catálogo de planos em tabela, editável por painel administrativo.** Flexibilidade que ninguém pediu, em troca da possibilidade de alterar preço e cota de clientes pagantes sem revisão e sem teste. Se um dia houver painel, ele abre um pull request — não um `UPDATE`.

**Não coletar documento agora e pedir depois.** Rejeitada pela assimetria de D4: o erro sem volta é o de não coletar.

**Coletar documento de forma opcional.** O pior dos dois mundos — custo integral de conformidade, benefício pela metade.

---

## Revisão

- **A cada revisão trimestral do ADR 0003** (custo do agregador × receita), conferir também: taxa de conversão do checkout desde a introdução do campo de documento, volume de reembolso proporcional pedido no anual, e **as cotas de conexão bancária** — `0/3/10` foi espelhado de um concorrente cujo preço a DP-27 deixou de espelhar, e o número novo depende da cotação do agregador (spec §3.2).
- **A DP-27 não altera nenhuma das quatro decisões acima**, e essa é a propriedade que se queria: o catálogo em código (D3) absorveu a mudança de preço em seis constantes, e a fórmula de reembolso, por não dividir, saiu ilesa. O que a DP-27 muda é **produto**, e está no §2.6 do spec — inclusive a condição de que o épico 11 não preceda os épicos 6 a 10.
- **Se DP-16 mudar** — emissão de nota passando a existir, por conta própria em Salvador ou por terceiro —, esta ADR não muda; o que muda é `subprocessadores.md`, se houver terceiro, e o preenchimento de `cobrancas.documento_fiscal_id`, hoje reservado e nulo.
- **Se o dono decidir nunca emitir**, executar a saída escrita em D4 e reverter a §2.2 ao texto original. A reversão é parte da decisão, não um esquecimento a corrigir depois.
