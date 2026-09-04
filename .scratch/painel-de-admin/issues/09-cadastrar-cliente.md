Status: resolved
Blocked by: 05, 07

# 09 · `POST /v1/admin/clientes` — cadastrar o espaço de um cliente novo

## Objetivo

Depois deste ticket o operador prepara o espaço de quem vai assinar: cria o espaço, vincula um titular **que já tem conta**, e para. Nenhum estado é forçado à mão, e o painel **não vira bypass** do teto de criação de espaços que a rota do cliente cumpre.

## A seção do spec que governa

- **§8.4, "F-13, o adjacente"** — `admin.cadastrar_cliente` **não inventa um caminho para `ativa`**. O cliente sai de `teste` pelo caminho de todo mundo: assinando (`assinou`, `catalogo.ts:164`), o que hoje depende da P-14.
- **§8.4, as três amarras** — não cria identidade; roda o mesmo teto de `auth.criar_tenant`; o `GRANT` é nominal e conferido na primeira execução.
- **§8.0** — a escrita mora numa função `SECURITY DEFINER` de `mavia_admin_contrato`, com os seis passos.
- **§8.5** — as duas linhas de auditoria com a mesma `correlacao`.

## O que entra, e onde

**Migration `0035_admin_cadastrar_cliente.sql`.**

1. `admin.cadastrar_cliente(p_usuario_id uuid, p_nome text, …)` — dono `mavia_admin_contrato`, `SET search_path = pg_catalog, public`, `EXECUTE` só a `mavia_admin_escrita`, e uma linha nova em `FUNCOES_DE_ADMIN`.
2. A verificação do teto **copiada por dentro**, com a mesma consulta e as **mesmas duas exceções** de `auth.criar_tenant` (`0004_cadastro.sql:287-310`; os tetos em `:302-303`): `TETO_DIARIO_DE_TENANTS` acima de **3 por dia**, `TETO_DE_TENANTS_ATIVOS` acima de **10 ativos** por usuário, ambos `ERRCODE = 'P0001'`.

Os `GRANT` de que ela depende — `INSERT ON tenants`, `INSERT, SELECT ON tenant_usuarios` para `mavia_admin_contrato` — nascem no ticket 01. **O ticket confere a lista contra as migrations antes de escrever a migration**, e o critério 7 é quem pega a omissão.

**Código:** `POST /v1/admin/clientes`, com a sua chave em `ROTAS_DE_ADMIN` e na matriz, por `mavia_admin_escrita` → `admin.abrir_espaco_para_escrita` → `admin.cadastrar_cliente`. A resposta carrega o texto que a tela mostra ao operador: *"este espaço vai ficar em teste até o cliente assinar."*

## Critérios de aceite

**Esquema**

1. `FUNCOES_DE_ADMIN` continua exato, com `cadastrar_cliente` na família `contrato` e dona `mavia_admin_contrato`.
2. A função não contém `UPDATE … SET estado`, `SET plano` nem `SET intervalo` no corpo (`pg_get_functiondef`).

**Integração** (Postgres real)

3. `admin.cadastrar_cliente` deixa o espaço em **`teste`** com as **cotas do Família** (`catalogo.ts:94`, `COTAS_DO_TESTE = PLANOS.familia.cotas`), **e não força nenhum estado**. A resposta da rota carrega o texto que a tela mostra ao operador.
4. Ela **recusa o 4º espaço do dia** e o **11º ativo** do mesmo titular, com as mesmas exceções nomeadas de `auth.criar_tenant`. *O painel não é bypass do teto A-18/DP-26.*
5. Chamada com um `p_usuario_id` que **não existe** em `usuarios`, levanta erro. **A função não cria identidade** — ela recebe um usuário existente e vincula.
6. A assinatura é criada **pelo gatilho** `assinatura_de_teste_trg` (`0025_assinatura.sql:87-89`), como `mavia_auth`, com `now() + interval '7 days'` (`:78-79`). O painel não a insere e não precisa de privilégio sobre `assinaturas` para este caminho.
7. A função roda **na primeira execução** contra o esquema recém-migrado, pelo pool de escrita — sem `permission denied` de esquema, de `tenants`, de `tenant_usuarios`, de `concessoes_de_admin` ou de `auditoria`. *Uma função de `admin` que falha na primeira execução por falta de `GRANT` é o defeito que já reprovou este documento uma vez.*
8. Chamá-la **sem** `admin.abrir_espaco_para_escrita` levanta erro; com `p_alvo` diferente do `app.tenant_id` aberto, levanta erro também.
9. O cadastro deixa **duas** linhas de `auditoria` com a mesma `correlacao`. Um cadastro que falha deixa **zero**.
10. **Nenhuma escrita do painel cria `Lancamento`:** contagem de `lancamentos`, `transferencias`, `contas`, `faturas` e `saldo_snapshots` idêntica antes e depois de **uma baixa, uma cortesia e um cadastro**. *Este é o ponto da sequência em que os três existem — a asserção coletiva de §8.7 fecha aqui.*
11. **As quatro funções de contrato** — `registrar_pagamento`, `prorrogar_teste`, `conceder_cortesia`, `cadastrar_cliente` — rodam na primeira execução contra o esquema recém-migrado, pelo pool de escrita. *O teste de S3-3 aplicado à família inteira, e este é o ponto em que "as quatro" existe.*

## Armadilhas conhecidas

- **O cliente cadastrado pelo painel nasce em `teste` e nunca sai (F-13, o adjacente).** O gatilho `assinatura_de_teste_trg` dispara em **todo** `INSERT` em `tenants`, e **não existe job de expiração**. A v3.1 criava a ação sem dizer como ela termina. **A função não inventa um caminho para `ativa`** — a alternativa seria o painel virando o terceiro escritor de `estado`, que é o que a §8.1 acabou de fechar. Enquanto a P-14 não existir, a ação serve para **preparar** o espaço, e a tela diz isso ao operador com todas as letras.
- **Criar `usuarios` pelo painel seria fabricar uma identidade para outra pessoa.** Atravessa `spec-autenticacao.md` e a DP-25, e **não é deste épico por nenhum caminho**. O titular precisa já ter conta.
- **O teto vive no banco, e não só no guard.** `0004_cadastro.sql:285-286` diz por extenso: *"o teto vive AQUI, e não só na aplicação: um teto que existe só na aplicação é um teto que a próxima rota esquece"*. **Este épico é a próxima rota.** É a guarda A-18/DP-26 que a segurança impôs, e que `spec-planos:398` cita como parte da defesa contra o abuso do teste sem cartão. **Um caminho de criação que não a roda é o bypass dela, e ele nasceria no painel sem ninguém notar.**
- **Copiar o teto por dentro, e não chamar `auth.criar_tenant`.** Chamar a função de `auth` significaria `EXECUTE` de `mavia_admin_contrato` numa função de `mavia_auth` — o papel que já lê cinco tabelas cross-tenant com `USING (true)`, e o motivo de a ADR 0024 D4 existir. A cópia é a **mesma consulta e as mesmas duas exceções**, e o critério 4 é quem garante que ela não divergiu.
- **A lista de `GRANT` é conferida contra as migrations antes de escrever a migration.** O mecanismo que pega a omissão é o mesmo do achado S3-3: o teste de integração que roda a função contra o esquema **recém-migrado**, não contra um banco de desenvolvimento onde alguém concedeu à mão.
- **`GRANT` de dono (`bootstrap-papeis.sql:36-44`)** — se este ticket precisar de qualquer `GRANT` que o 01 não deu, ele roda como `mavia_migrate` e o critério 7 é quem transforma o `WARNING` em falha.

## Decisões pendentes que este ticket toca

- **P-14** (a chave de API da Stripe) não é DP e não é deste épico, mas é ela que decide quando um espaço cadastrado aqui consegue sair de `teste`. O ticket não a espera e não a contorna.
- **DP-39** — o `origem_da_ultima_escrita` do cadastro é `'painel'` como qualquer escrita de contrato (ticket 08). Sem resposta a DP-39, **C-11** segue aberta e o painel não alcança cliente real.

## O que este ticket não faz

- **Não força estado nenhum.** Nem `ativa`, nem prorrogação, nem cortesia no ato do cadastro.
- Não cria `usuarios`, não envia convite, não emite credencial.
- Não troca plano nem intervalo (DP-40).
- Não desenha a tela (ticket 12).
