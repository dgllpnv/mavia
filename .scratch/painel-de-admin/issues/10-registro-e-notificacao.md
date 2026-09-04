Status: resolved
Blocked by: 03, 05

# 10 · `GET /v1/admin/registro`, a notificação entre pares e `RL-ADMIN-ABERTURA`

## Objetivo

Depois deste ticket o log deixa de ser um arquivo que ninguém lê: o operador consulta o registro por uma projeção fixa que **não tem como** devolver `ip_hash`, ler o registro é evento que notifica os outros operadores por um destino fora do painel, e uma varredura da base um espaço por vez vira alarme em vez de trilha impecável.

## A seção do spec que governa

- **§3.3, último bloco** — a leitura do registro é por **projeção própria**, e não por policy de `SELECT`: `admin.ler_registro`, `SECURITY DEFINER` de `mavia_admin_definer`, com as três razões escritas.
- **§1.3** — a decisão sobre `ip_hash`/`user_agent_hash`, escrita como decisão, com os três argumentos e o que aconteceria se ela invertesse.
- **§8.5 (F-14)** — o par intenção/efeito e a `correlacao` que o torna verificável.
- **§6.3** — a detecção, e por que o destino é **fora** do produto.
- **§5** — as duas classes de rate limit, e a reconciliação em quatro pontos entre `RL-ADMIN-ABERTURA` e DP-33.

## O que entra, e onde

**Migration `0036_admin_ler_registro.sql`.**

1. `admin.ler_registro(…)` — dono `mavia_admin_definer`, `SET search_path`, checagem de concessão por dentro, e **uma linha em `FUNCOES_DE_ADMIN`** (a quarta da família de leitura, completando as oito de §8.0).
2. Policy própria `TO mavia_admin_definer` em `auditoria`, com o predicado de concessão ativa da saída A do S3-4.
3. A **projeção fixa**, exatamente estas quinze colunas: `ocorrido_em`, `tenant_id`, `usuario_id`, `ator_tipo`, `entidade`, `entidade_id`, `acao`, `classe`, `rota`, `registros`, `motivo`, `referencia`, `correlacao`, `de`, `para`. **Não `ip_hash`, não `user_agent_hash`.**

**Código:**

- `GET /v1/admin/registro`, com a sua chave em `ROTAS_DE_ADMIN` e na matriz. Classe no log: **segurança** — e ela **notifica os outros operadores**.
- A notificação entre pares: e-mail para endereço **fora do domínio da aplicação**, entregue por caminho que o painel comprometido não silencia. Mais um resumo diário.
- `RL-ADMIN-ABERTURA`: teto **por hora e por dia, por operador**, contando `admin.abrir_espaco` **e** `admin.abrir_espaco_para_escrita` **somadas**.

## Critérios de aceite

**Esquema**

1. `auditoria.ip_hash` e `auditoria.user_agent_hash` **não** estão no `GRANT` de `mavia_admin` — que só tem `INSERT` na tabela — e **não aparecem na projeção** de `admin.ler_registro` (`pg_get_functiondef`, e o tipo de retorno declarado).
2. Continua **não existindo** policy `FOR SELECT TO mavia_admin` em `auditoria`.
3. `FUNCOES_DE_ADMIN` fica com as **oito** funções de §8.0, com o dono certo em cada família. **Uma nona derruba o teste até a ADR 0024 ser emendada de novo.**
4. Toda função em `admin` tem `SET search_path` em `proconfig` — reafirmado com a oitava.

**Integração** (Postgres real / aplicação real)

5. `GET /v1/admin/registro` devolve as quinze colunas e **nenhuma outra**. Um teste tenta pedir `ip_hash` por parâmetro e não há caminho: a coluna não sai porque **não há `GRANT` dela** para o papel que atende a requisição.
6. `admin.ler_registro` chamada por um `app.usuario_id` **sem concessão ativa** devolve **erro**, não linhas.
7. Ler o registro **é evento**: deixa a sua própria linha de `auditoria` com classe de **segurança**, e dispara a notificação.
8. A notificação vai para um destino **fora** do painel: o teste afirma que o transporte configurado não é uma tabela do próprio banco nem um canal que o operador administra. *Uma notificação que só existe dentro do sistema que ela vigia não detecta o comprometimento desse sistema.*
9. Toda abertura de espaço notifica os outros operadores, e o conjunto "os outros operadores" **não pode ser vazio** — garantido pela invariante do ticket 04.
10. O registro devolve o **par** de uma escrita de contrato: duas linhas com a mesma `correlacao`, a de intenção sem `de`/`para` e a de efeito com os dois. Uma linha de intenção **sem** linha de efeito é uma escrita que falhou ou foi desfeita, e o registro deixa isso legível.
11. `RL-ADMIN-ABERTURA` recusa acima do teto por **hora** e acima do teto por **dia**, **por operador**.
12. As aberturas de **escrita** contam no **mesmo** teto: um operador que esgotou o teto com `abrir_espaco` não consegue uma `abrir_espaco_para_escrita`. *Um teto separado para escrita seria um segundo orçamento de varredura, e o operador comprometido usaria o mais folgado.*
13. Reaproveitar a hipótese dentro da janela de DP-33 **não** poupa o contador: N aberturas sob o mesmo `motivo` + `referencia` consomem N do teto. *Se poupasse, o teto deixaria de existir no exato cenário para o qual foi criado.*
14. Quando a janela e o teto discordam, **vence o teto**.

## Armadilhas conhecidas

- **A lista errada de campos vetados fazia o teste passar sobre o campo vetado (S3-6).** A §3 põe `ip_hash` e `user_agent_hash` como colunas de `auditoria`, e esta rota é servida por `mavia_admin`. O teste previsto — *"nenhum dos sete campos da R-5 está em nenhum `GRANT`"* —, escrito contra a lista errada, **passa** com `auditoria.ip_hash` concedido ao painel. São **nove** colunas: a R-5 (`matriz-de-acesso.md:66-72`) conta `ip_hash`/`user_agent_hash` como um item de sete, e a §3.17 (`:436`) acrescenta `dados_fiscais.documento`.
- **A decisão sobre `ip_hash` é decisão, e o argumento do outro lado é bom (§1.3).** O operador que abre um espaço com `motivo = incidente` é plausivelmente o leitor previsto da **A-26** (`matriz-de-acesso.md:172`), que declara *investigação de incidente* como a finalidade desses campos. Ele perde por três razões escritas, e a terceira é a que importa aqui: **deixá-los fora não custa nada à operação normal.** Se um dia a decisão inverter, ela entra como **emenda escrita à R-5** na `matriz-de-acesso.md`, **não como um `GRANT` a mais numa migration**.
- **A leitura é por projeção, e não por policy de `SELECT`, por três razões (§3.3).** (1) É o que mantém a decisão de §1.3 **no banco** e não só no código da rota. (2) Ler o registro **é evento** e notifica — o que exige que a leitura passe por uma função que grava, e não por um `SELECT` livre. (3) A forma dessa policy é o risco registrado em S3-4, e está nomeado lá, não escondido aqui.
- **A policy do definer numa listagem não tem `app.tenant_id` para se estreitar (S3-4).** É a razão estrutural, a mesma de `mavia_auth`. O predicado de concessão ativa entra (saída A), **e continua sendo verdade que ele não estreita a projeção** — ele qualifica *quem chama*, não *quais linhas*. Escreva isso no comentário da policy.
- **`auditoria` não aceita `UPDATE` de ninguém (§3.1), então a linha de intenção nunca é completada depois (F-14).** O `de → para` **precisa** de uma segunda linha, e a segunda precisa dizer de qual primeira ela é. Se o registro exibir o par como se fosse uma linha, alguém vai tentar "consertar" a primeira.
- **Um log que ninguém lê descobre o incidente quando o cliente reclama (§6.3).** Os itens da v1 eram preventivos ou forenses; **nenhum detectava**. DA-2 proíbe avisar o cliente; **não proíbe avisar o segundo operador**.
- **`RL-ADMIN-ABERTURA` existe contra a trilha impecável (§5).** Um admin comprometido percorre a base inteira **um espaço por vez**, cada abertura com motivo e referência válidos, deixando um rastro perfeito que ninguém lê. **A v2 só limitava a busca.** A classe é **por operador**, não por rota — e isso é o que este documento fixa; **o teto numérico é decisão do dono no ticket (C-8)**.
- **`GRANT` de dono (`bootstrap-papeis.sql:36-44`)**: o `GRANT EXECUTE` e a policy nova rodam como `mavia_migrate`. Os critérios 1 e 2 são quem pegam a omissão.

## Decisões pendentes que este ticket toca

- **DP-34** (`decisoes-do-produto.md:138`), **em aberto**. Padrão vigente: **destino externo ao painel**. Este ticket o implementa como tal. **Se o dono responder "não"**, o próprio texto de `decisoes-do-produto.md:138` carrega a consequência: *"a LIA da §8.1.1 precisa ser refeita"* — e a §8.1.1 é a LIA que sustenta a **DA-1 inteira**, leitura completa dos dados financeiros dos clientes. Uma resposta negativa **não ajusta a §6.3: ela reabre o balanceamento que autoriza o épico.** Está registrada como risco do épico, não como detalhe de implementação.
- **DP-33** (`decisoes-do-produto.md:137`), **em aberto**, padrão vigente **30 minutos**. A reconciliação de §5 é normativa e **não depende da resposta**; os critérios 13 e 14 a implementam. Se o dono responder 5 minutos ou nenhuma janela, muda o atrito do operador e **não muda o controle**.
- **C-8** (deploy) — o **valor** do teto de `RL-ADMIN-ABERTURA` é decisão do dono. O ticket entrega a classe, o contador por operador e a reconciliação; o número entra por configuração e o deploy não sobe sem ele.

## O que este ticket não faz

- Não concede `SELECT` em `auditoria` a `mavia_admin`, e não cria policy de `SELECT` para ele. Se alguém precisar de uma coluna nova no registro, ela entra na projeção da função e no `GRANT` do definer — em nenhum outro lugar.
- Não entrega `ip_hash` nem `user_agent_hash` a ninguém. Quem investiga incidente tem `psql` no runner de deploy, com a credencial de `mavia_migrate` sob custódia (§3.1.2) e `pg_hba.conf` restringindo ao host. **É um caminho mais caro, e ele deve ser mais caro.**
- Não desenha a tela do registro (ticket 12).
- Não implementa a allowlist de rede (**C-6**) nem a ACL do Redis (**C-7**) — as duas são do `sre-devops-vps` e bloqueiam o deploy.
