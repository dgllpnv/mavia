Status: resolved
Blocked by: 06, 07, 08, 09, 10

# 12 · As telas do painel

## Objetivo

Depois deste ticket o painel existe como produto: lista de clientes, perfil, registro, e as quatro telas de leitura do espaço do cliente. Em hostname próprio, com escopo de cookie distinto, e com a tela de baixa dizendo por escrito o que a baixa faz e o que ela não faz.

## A seção do spec que governa

- **§9** — as telas, as **três exigências que vêm do parecer financeiro e não são decoração**, e a tipografia de valor.
- **§1.4** — as **quatro** telas de cliente do primeiro corte: perfil, contas e saldos, lançamentos do período e baixas anteriores. **Uma quinta é ticket próprio.**
- **§6.1** — hostname distinto e escopo de cookie distinto. *Hoje `/admin` seria grupo de rotas do mesmo Next, no mesmo host, com o mesmo cookie — **um XSS em qualquer tela do produto, no navegador de um admin, alcança o painel inteiro**.*
- **§1.7** — as telas `⊙` do cliente (alertas, preferências, sessões) **não são visíveis** no painel. Consequência aceita, escrita para não ser revertida por conveniência.
- **`docs/design.md`** — obrigatório antes de qualquer tela, com a **auditoria da §5** rodada antes da entrega.

## O que entra, e onde

`apps/web`, sob hostname próprio (não um grupo de rotas do host do produto).

| Tela | Fonte |
|---|---|
| Lista de clientes | `GET /v1/admin/clientes` |
| Perfil do cliente | `GET /v1/admin/clientes/:tenantId` |
| Contas e saldos | rota própria (ticket 06) |
| Lançamentos do período | rota própria (ticket 06) |
| Baixas anteriores + formulário de baixa | `GET`/`POST /v1/admin/clientes/:tenantId/pagamentos` |
| Cortesia e prorrogação | rotas do ticket 08 |
| Cadastrar cliente | `POST /v1/admin/clientes` |
| Registro | `GET /v1/admin/registro` |

**O motivo e a referência são pedidos antes de abrir o espaço, não depois.**

**As três exigências de tela do parecer financeiro:**

1. **As baixas anteriores ficam acima do formulário**, não numa aba. Sem isso o cenário F-3 — dois operadores, o mesmo Pix, horas diferentes — não tem como ser percebido por gente.
2. **A tela de baixa diz o que a baixa faz.** Se o cliente está `em_atraso`, por escrito: *"esta baixa reativa o acesso deste espaço."* Uma escrita que muda o direito de uso não pode parecer um registro contábil.
3. **A tela de baixa diz o que ela não faz**, literalmente: *"este pagamento não entra no cálculo automático de reembolso; se este cliente pedir cancelamento com devolução, o valor é conferido à mão."*

Mais duas frases que vêm de outros lugares do spec e valem como texto de interface:

- ao lado de `observacao`: *"esta observação pode ser lida pelo cliente se ele pedir os dados dele"* (Modelo de dados);
- na tela de cadastro: *"este espaço vai ficar em teste até o cliente assinar"* (§8.4).

## Critérios de aceite

**E2E** (Playwright)

1. Entrar, achar cliente **em atraso**, informar motivo e referência, **dar baixa**, ver o **acesso restabelecido** e as **duas** linhas no registro.
2. Entrar, achar cliente, informar motivo e referência, **ver as baixas anteriores**, **conceder cortesia**, ver as duas linhas no registro.
3. Uma baixa com a mesma `referencia_externa` de uma existente mostra a linha existente e a data em que foi registrada — nunca "erro ao salvar".
4. Uma baixa **semelhante** mostra a linha existente e só prossegue com a confirmação explícita.
5. As telas `⊙` do cliente não são alcançáveis pelo painel — não há link, e a URL direta não existe.

**Design** (auditoria da §5 de `docs/design.md`, rodada **antes** da entrega)

6. Nem toda informação está dentro de um card.
7. Contraste de escala tipográfica evidente — pelo menos 3:1 entre o maior e o corpo de texto.
8. **Toda coluna de valor usa algarismos tabulares e alinhamento à direita** (`font-variant-numeric: tabular-nums`, `docs/design.md:50`).
9. **Nenhuma coluna de dinheiro sem a moeda ao lado**, e **competência como mês por extenso**.
10. Modo escuro projetado, não invertido.
11. Nenhuma animação puramente decorativa; `prefers-reduced-motion` respeitado.
12. Contraste WCAG AA verificado, e nenhum significado depende só de cor.
13. Sem roxo/índigo, sem gradiente decorativo, sem glassmorphism, **sem emoji na interface**.

**Prototipagem**

14. As telas nasceram de **três direções radicalmente diferentes** via `/prototype`, e o humano escolheu. `CLAUDE.md` §6 e `docs/design.md` §4.

## Armadilhas conhecidas

- **Mesmo host, mesmo cookie, um XSS alcança tudo (§6.1).** O hostname distinto e o escopo de cookie distinto **não são refinamento visual**: eles são metade da **C-6**, que bloqueia o deploy. Construir o painel como grupo de rotas do Next do produto é a decisão que custa a subida.
- **A tela de baixa que parece um registro contábil é a armadilha do F-1.** O operador que dá baixa num cliente `em_atraso` está **reativando o acesso**. Se a tela não disser isso, ele não sabe o que fez — e o gate registrou esse cenário como o que reprovou a parte de dinheiro do spec.
- **A metade do F-10 que este épico consegue fechar é a exigência 3, e ela é texto.** A fórmula `reembolso = max(0, valor_pago − meses_iniciados × preco_mensal_do_plano)` (`spec-planos:305`) lê um `valor_pago` que **não existe persistido**: a tabela `cobrancas` não foi criada por migration nenhuma. Quem pagou por Pix tem `valor_pago` zero, e `max(0, 0 − …)` é **zero** — reembolso nulo sobre R$ 990,00 recebidos. **Registrar isso na tela é o mínimo honesto** enquanto o épico 11 não decidir se pagamento fora da Stripe é reembolsável.
- **As baixas anteriores acima do formulário, e não numa aba.** Uma aba é uma decisão de layout que apaga um controle: F-3 depende de o operador **ver** antes de clicar.
- **Não existe tela de trocar plano.** DP-40: *"a rota não existe. Não é 403 nem 404 de controle: é ação que este épico não tem."* O operador **orienta o cliente a trocar pela própria tela**, que é onde a regra já está implementada.
- **Não existe tela de editar preço ou cota.** *"Preço, cota e desconto vivem no catálogo em código, nunca em tabela"* (`spec-planos:177`; `packages/domain/src/catalogo.ts:60-85`). Ela não existe e **não entra por dívida**.
- **404 para não-admin não é controle** (Erros e bordas): o tempo de resposta difere de um caminho inexistente e o App Router entrega o manifesto de rotas. É grátis, e só. **Não conte como salvaguarda em nenhum documento.**
- **`docs/design.md` é obrigatório antes de desenhar, e a auditoria da §5 é antes de entregar** — não depois do code review.

## Decisões pendentes que este ticket toca

- **DP-39** (**C-11**) e **DP-32** (MFA) continuam abertas. **Enquanto o padrão vigente de DP-32 valer, o painel não vai a produção com cliente real** — este ticket entrega as telas; ele não autoriza a subida.
- **DA-2** — o cliente **não** é avisado. As telas não sugerem o contrário, e não há texto prometendo aviso.

## O que este ticket não faz

- **Não implementa a allowlist de IP ou mTLS no Traefik (C-6).** O hostname e o escopo de cookie são deste ticket; a camada de rede é do `sre-devops-vps` e **bloqueia o deploy**: *sem allowlist ou mTLS em produção, o painel não sobe.*
- Não implementa a ACL do Redis (**C-7**).
- Não cria a quinta tela de cliente — é ticket próprio, e a §1.4 diz isso por escrito.
- Não implementa MFA.

## Asserções do spec que este ticket **não** cobre, e a quem pertencem

Duas linhas da seção Testes do spec não têm ticket nesta fatia, e é honesto dizer onde elas moram:

- **`E2E · Requisição a /admin de origem fora da allowlist é recusada antes da aplicação`** — é **C-6**, do `sre-devops-vps`. Sem um ticket de infraestrutura, ela fica órfã.
- **`Integração · A ACL do Redis permite os cinco prefixos em uso e recusa CONFIG SET, FLUSHALL e KEYS`** — é **C-7**, do mesmo. Os cinco prefixos são `sess:` e `acessos:` (`cofre-de-acesso.ts:47-48`), `oauth:` (`estado-do-oauth.ts:44`), `tentativas:` (`limite-de-tentativas.ts:65`) e o `bull:` do BullMQ (fila `recorrencias`, `agendador.ts:32`, `:42`). **Uma ACL que esqueça `tentativas:` desliga o limite de tentativas de login**, que é a defesa das rotas públicas.

Ver `README.md`, seção *O que ficou fora das doze fatias*.
