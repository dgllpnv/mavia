# A Mavia em produção

Escrito **depois** do primeiro deploy, e descrevendo o que de fato aconteceu.

```
https://mavia.o9cmue.easypanel.host
```

---

## Onde ela mora

Uma VPS Hostinger (`2.24.79.49`, Ubuntu 24.04, 4 vCPU, 15 GiB) que **não é só
dela**: rodam ali 24 containers de produção de outros negócios, em Docker Swarm,
orquestrados pelo EasyPanel — Chatwoot, Evolution API, n8n e três bancos de
clientes entre eles.

**A Mavia entra ao lado, e não dentro daquela orquestração.** Containers Docker
comuns, descobertos pelo Traefik do EasyPanel por *label*, sem escrever no
arquivo de configuração que o painel gera e sobrescreve. Um
`docker compose down` desfaz tudo, e nada que a Mavia faça alcança o que já
estava lá.

| | |
|---|---|
| Código | `/opt/mavia/repo` (clone de `github.com/dgllpnv/mavia`) |
| Compose e segredos | `/opt/mavia/repo/infra/producao` |
| Serviços | `mavia-postgres-1`, `mavia-redis-1`, `mavia-api-1`, `mavia-web-1` |

### O que encara a internet

**Só o `web`.** A API não é publicada: o navegador chama `/api/...` na origem do
web, e o servidor do Next repassa pela rede interna. É a mesma topologia do
ambiente local, e é o que faz o cookie de sessão funcionar sem CORS.

Nenhum serviço publica porta no host. Postgres e Redis vivem numa rede
`internal`, **sem rota de saída** — um banco comprometido não tem por onde
exfiltrar. Só a API tem saída, porque precisa alcançar o SMTP e o Google.

---

## O deploy

```bash
ssh root@2.24.79.49
cd /opt/mavia/repo && git fetch origin && git reset --hard origin/main

# `nice` porque o build compete com o Chatwoot e o WhatsApp de clientes.
nice -n 19 docker build -f apps/api/Dockerfile -t mavia/api:mais-recente .
nice -n 19 docker build -f apps/web/Dockerfile -t mavia/web:mais-recente .

cd infra/producao && bash implantar.sh
```

`implantar.sh` é idempotente: rodar duas vezes não recria segredo, não reaplica
migration e não perde dado. Ele termina com três verificações, e **um deploy que
não é verificado não é um deploy**:

1. a API responde 401 em `/v1/eu` — sem sessão, como deve;
2. o web alcança a API pela rede interna;
3. o Traefik serve `https://.../entrar`.

### Os segredos

Gerados **na máquina**, uma vez, em `infra/producao/.env` (modo 600, no
`.gitignore`). Nunca passaram por commit nem por conversa.

> **Perder esse arquivo com o volume do Postgres vivo torna o banco
> inacessível.** As senhas de `mavia_migrate` e `mavia_app` estão dentro dele, e
> só dentro dele. Copie-o para onde você guarda senhas antes de qualquer coisa.

---

## O domínio, e por que TLS não é opcional

`mavia.o9cmue.easypanel.host` é o curinga de teste do EasyPanel — o DNS já
apontava para a VPS e o certificado já cobria o subdomínio, então não houve
espera de emissão.

**O produto não funciona sem HTTPS.** O cookie de sessão usa o prefixo
`__Host-`, que obriga `Secure`, e navegador nenhum aceita cookie `Secure` sobre
`http://` fora de `localhost`. Servida em HTTP, a Mavia deixaria cair o refresh
em silêncio e ninguém conseguiria ficar logado. Não é degradação — é o login não
existir.

Para trocar por um domínio seu: aponte `A → 2.24.79.49`, e rode
`DOMINIO=seu.dominio bash implantar.sh`. O Traefik do EasyPanel emite o
certificado.

---

## O que está desligado, e o que acontece quando se liga

Três coisas dependem de credencial que o dono do produto precisa criar. Todas
**recusam** em vez de fingir — a alternativa seria responder 202 sem mandar
nada, deixando a pessoa esperando para sempre com o log dizendo que deu certo.

| O quê | Sem a credencial | Para ligar |
|---|---|---|
| **Cadastro e recuperação** (P-3) | 503, com frase para o usuário | `SMTP_HOST`, `SMTP_PORTA`, `SMTP_REMETENTE` (e usuário/senha) no `.env` |
| **Entrar com o Google** (P-4) | 503, e a tela diz para usar e-mail e senha | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| **Cobrança** (P-14) | o webhook recusa tudo | chaves da Stripe |

**Enquanto o SMTP estiver desligado, não existe caminho para criar a primeira
conta.** É a única coisa que separa esta instalação de um produto usável.

O **guardião de chaves** também está desligado, e isso é decisão e não pendência:
não há agregador bancário ligado (ADR 0003 — a porta de receita não foi
atingida), e sem ele o guardião não tem o que guardar. Toda operação sobre
segredo de conexão lança `GuardiaoIndisponivel`, que é a verdade.

---

## O que ainda é do container, e não do código

O `parser` roda em processo filho descartável, com `env: {}`, prazo duro de 10 s
e saída validada por Zod — a metade que **é** código está feita (P-12). O que
falta é a metade do container: `network_mode: none`, filesystem somente-leitura,
cgroup e `seccomp`.

Hoje o filho herda o namespace de rede da API. Ele não tem segredo no ambiente e
não abre socket, mas um RCE de biblioteca dentro dele alcançaria a rede interna.
As quatro verificações de deploy que fecham isso estão em `infra/README.md`, e
elas precisam **falhar** ao rodar.

---

## As três armadilhas que este deploy encontrou

Ficam registradas porque cada uma custou uma execução, e nenhuma apareceria em
teste.

**O build local estava contaminado pela máquina.** Uma extensão de editor
entrava no grafo do esbuild: ele subia a árvore de diretórios procurando
`@fastify/view`, saía do repositório e encontrava uma cópia embutida de
`consolidate` em `~/.vscode/extensions`. O Dockerfile agora **reprova o deploy**
se qualquer marcador de instrumentação de editor aparecer no bundle.

**`??` não cai no padrão para string vazia.** Um `ARG` do Docker que não é
passado vira `ENV` vazia, e o destino do `rewrite` de `/api` saiu sem host: todas
as telas serviam 200 e `/api/*` devolvia 404. O teste de fumaça não pegou porque
ali eu passava o `--build-arg`.

**`psql -c` não interpola variável.** O passo que concede credencial a
`mavia_app` falhava com `syntax error at or near ":"`, e a mensagem não menciona
interpolação.

---

## Operação

```bash
cd /opt/mavia/repo/infra/producao

docker compose ps                      # estado
docker compose logs -f api             # logs da API
docker compose logs -f web

# Backup do banco. Faça antes de qualquer migration.
docker compose exec -T postgres pg_dump -U mavia -d mavia -Fc \
  > ~/mavia-$(date +%F-%H%M).dump

# Restaurar. **Teste isto antes de precisar** — backup não testado não é backup.
docker compose exec -T postgres pg_restore -U mavia -d mavia --clean < arquivo.dump
```

**Restauração testada é pendência aberta.** O `roadmap` pede o tempo
cronometrado a cada quatro a seis épicos, e ninguém cronometrou nenhuma vez.
