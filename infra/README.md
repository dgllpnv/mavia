# Ambiente local

```
mavia            sobe e espera ficar saudável
mavia down       derruba, preservando os dados
mavia reset      derruba e apaga o banco (pede confirmação)
mavia status     estado dos serviços
mavia logs       logs em tempo real
mavia psql       shell psql no banco local
```

O script está em `mavia.bat`, na raiz. Ele não devolve o prompt antes de o Postgres aceitar conexão de verdade — esperar pelo healthcheck é o que evita o teste falhar porque o banco ainda estava subindo.

---

## Bloco de portas — 47xx

| Serviço | Porta local | Porta no container | Situação |
|---|---|---|---|
| Postgres | **4732** | 5432 | ativo |
| Redis | **4779** | 6379 | ativo |
| API | **4711** | — | reservada |
| Web | **4710** | — | reservada |
| Mailpit | **4725** | — | reservada |

Duas razões para não usar as portas padrão:

**80 e 8080 estão fora por decisão do dono do produto.** São as portas que mais colidem com outra coisa já rodando na máquina, e a colisão costuma aparecer como erro obscuro em vez de "porta ocupada".

**5432 e 6379 também ficaram de fora.** Se você já tem um Postgres instalado na máquina, subir outro na 5432 faz o cliente conectar no banco errado sem avisar — e descobrir isso depois de rodar uma migration é caro.

---

## Tudo publicado em 127.0.0.1

```yaml
ports:
  - '127.0.0.1:4732:5432'   # e não '4732:5432'
```

Sem o prefixo, o Docker publica em `0.0.0.0` e o banco fica visível para a rede local inteira. Numa cafeteria ou num escritório com Wi-Fi compartilhado, isso é um banco de dados aberto para quem estiver na mesma rede.

---

## Sobre a senha no `docker-compose.yml`

`mavia_local_dev` está em texto claro no arquivo, e isso é intencional: ela vale **só** para este container, que só escuta em `127.0.0.1`, com dados descartáveis que o `mavia reset` apaga.

Isso não abre exceção à regra 19 do `CLAUDE.md`. Credencial de agregador bancário, chave de API e a KEK **nunca** entram no repositório, nem em `.env`, nem em imagem — ver ADR 0018. A diferença é que aquilo protege dado de cliente e isto não protege nada.

Nunca reutilize esta senha fora daqui.

---

## Fuso

Os containers rodam em **UTC**, com `TZ` e `PGTZ` fixados. É deliberado: a conversão para `America/Sao_Paulo` é responsabilidade do domínio, e um banco em horário local mascararia todo bug de fuso durante o desenvolvimento — para reaparecer em produção.

```
$ docker exec mavia-postgres psql -U mavia -d mavia -tAc "select current_setting('TimeZone')"
UTC
```

---

## Testes de integração

Os testes contra banco usam **Testcontainers**, que sobe um Postgres próprio e efêmero por execução. Eles **não** dependem deste ambiente e não sujam o banco local.

Este ambiente é para desenvolvimento e para teste manual. O `mavia reset` existe justamente para você conseguir repetir um roteiro de teste do zero.

---

## O `parser` no deploy — a metade que é container

O parsing de arquivo de usuário roda **fora do processo da API** desde o
`apps/api/src/importacao/parser-isolado.ts`: um processo filho por arquivo, com
`env: {}`, prazo duro de 10 s, teto de saída e a resposta validada por Zod — o
pai não confia no filho.

O que aquele arquivo **não** entrega, e o `sistema.md` §2.6 já dizia que ele não
entregaria, é o que só o container dá:

```yaml
  parser:
    image: mavia/parser
    # Sem rede. Não é endurecimento: é a diferença entre um RCE de biblioteca
    # nativa que lê um extrato e um que exfiltra o banco inteiro.
    network_mode: none
    read_only: true
    tmpfs:
      - /tmp:size=64m,noexec,nosuid,nodev
    user: '10001:10001'
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
    mem_limit: 256m
    pids_limit: 64
    # **Nenhuma variável de ambiente.** Nem uma. Se um dia esta lista deixar de
    # estar vazia, a verificação abaixo falha — e é para falhar.
    environment: {}
```

**Verificações do deploy** (§2.6 — não são teste de código, e testá-las em
Vitest testaria o mock):

```bash
# 1. Nenhum segredo no ambiente do parser.
docker compose exec parser env | grep -Ei 'DATABASE|SECRET|KEK|TOKEN|STRIPE|GUARDIAO' && exit 1

# 2. O parser não resolve DNS nem alcança a rede.
docker compose exec parser getent hosts postgres && exit 1

# 3. O parser não alcança o banco.
docker compose exec parser sh -c 'timeout 2 </dev/tcp/postgres/5432' && exit 1

# 4. O filesystem é somente-leitura fora do tmpfs.
docker compose exec parser sh -c 'touch /nao-deve-escrever' && exit 1
```

As quatro precisam **falhar** ao rodar. Um `exit 1` numa delas é o deploy
recusado, e não um aviso.

## O `guardiao` no deploy

Processo separado, socket em volume compartilhado, **sem porta TCP**. Desselado à
mão a cada reboot — é a opção B do ADR 0018 §D3.3, e a consequência é assumida:
enquanto ele estiver selado, a sincronização bancária não funciona e o resto do
produto funciona normalmente. O runbook está em `apps/guardiao/README.md`.

```yaml
  guardiao:
    image: mavia/guardiao
    network_mode: none
    read_only: true
    user: '10002:10002'
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
    # `stdin_open` porque a KEK entra pela entrada padrão, uma vez, e não toca
    # o disco.
    stdin_open: true
    tty: false
    volumes:
      - guardiao-socket:/run/mavia
      - guardiao-diario:/var/log/mavia
```

**Verificação:** `docker compose exec guardiao env` não contém a KEK — ela nunca
foi variável de ambiente —, e `ss -ltn` dentro do container não lista porta
nenhuma.
