# 01 · A origem da requisição tem fonte única e confiança de proxy declarada

Status: ready-for-spec
Severidade: **Alta**
Dono sugerido: `sre-devops-vps` (a pergunta de infra) → `engenheiro-backend` (o código)
Bloqueia: **o primeiro cliente cadastrado.** Não bloqueia a C-6a.

## O achado

Encontrado ao verificar a D2 da allowlist do painel
(`docs/superpowers/specs/2026-09-05-allowlist-de-ip-do-painel.md` §6) e
confirmado ponta a ponta pelo `especialista-seguranca-appsec`.

A entrada HTTPS do Traefik do EasyPanel roda com
`TRAEFIK_ENTRYPOINTS_HTTPS_FORWARDEDHEADERS_INSECURE=true` — **verificado na
VPS**. Isso significa que ele **preserva** o `X-Forwarded-For` que o cliente
mandar, em vez de sobrescrevê-lo.

A cadeia inteira, e ela fecha:

1. Traefik preserva o header do cliente e o repassa.
2. O proxy do rewrite do Next repassa os headers de entrada verbatim.
3. `FastifyAdapter` é instanciado **sem `trustProxy`** — `apps/api/src/aplicacao.ts:37`.
   `trustProxy` não aparece em lugar nenhum do repositório.
4. `origem()` devolve `split(',')[0]` do header — o que o cliente escreveu.
   Três cópias da mesma função privada, com o mesmo comentário:
   `sessoes.controller.ts:377-383` · `cadastro.controller.ts:343-349` ·
   `google.controller.ts:351-357`.

**Os dois ramos estão quebrados.** O header é escolhido pelo atacante; e o
fallback, `req.ip`, colapsa todos os clientes no IP do container `web`.

O comentário acima da função diz *"`x-forwarded-for` é confiável **atrás do
nosso Traefik** e mais nada"*. **A premissa é falsa nesta implantação** — e
apagá-la sem registrar o porquê faria a próxima pessoa reintroduzi-la.

## O que isso alcança

| Controle | Chave | Afetado |
|---|---|---|
| Tentativas por endereço (10 / 15 min) | `marca(pepper,'endereco',email)` | **Não.** Força bruta contra conta conhecida segue contida |
| Tentativas por origem (100 falhas / 15 min) | `marca(pepper,'origem',origem)` | **Sim, anulado.** É a defesa de *password spraying*, e é a razão declarada de o contador existir |

E duas consequências que a leitura inicial não viu:

- **A entrada pelo Google fica sem limite nenhum.** `google.controller.ts:342`
  faz `registrar(\`google:${origem}\`, origem)` — **as duas** chaves derivam de
  `origem`. Atacante que rotaciona o header não tem contador algum ali.
- **Negação de serviço direcionada, barata e sem autenticação.** 101 falhas com
  `X-Forwarded-For: <IP do escritório da vítima>` trancam por 15 minutos todo
  mundo que sai daquele NAT.

Sem MFA, isto é a remoção completa de uma das camadas declaradas contra
credencial. ASVS V2.2.1 / V11.2.

## A decisão que a correção exige — e é **uma**, não três

Não é *"confiar no header ou usar `req.ip`"*. É **onde mora a noção de origem do
cliente**, hoje copiada em três controladores.

- **(a)** Declarar a confiança de proxy **uma vez**, na construção do adapter
  Fastify, e deixar `req.ip` ser a única fonte em todo o código.
- **(b)** Manter a derivação na aplicação, num **único** módulo, com a lista de
  saltos confiáveis vinda de configuração.

As duas exigem responder a mesma pergunta, e ela é de infra, não de código:

> **Quantos saltos existem entre o cliente e o Nest, e qual é o último confiável?**

Em produção são **dois** — o Traefik e o proxy do Next —, e o `insecure=true`
significa que o primeiro **não sanitiza**. Enquanto isso não estiver respondido,
nenhuma variante de código conserta nada.

## Aceite

- Uma única fonte de origem no repositório; as três cópias privadas somem.
- Um teste que prove que header forjado **não** escolhe a chave do contador.
- Os casos de abuso 6, 7 e 8 do parecer do appsec, hoje vermelhos:
  1. 300 tentativas contra 300 e-mails distintos, `X-Forwarded-For` novo a cada
     requisição → alguma é barrada;
  2. N chamadas ao retorno do Google com header rotativo → 429 aparece;
  3. 101 falhas com o `X-Forwarded-For` de um terceiro → um cliente legítimo
     daquele IP **não** é trancado.

## Comments

**2026-09-05** — Criado a partir do gate de risco da C-6a. Nomeado e **não
corrigido** de propósito: o revisor que conserta o que deveria reprovar produz
um achado que ninguém mais viu, e a correção aqui depende de uma resposta de
infra que ainda não existe.
