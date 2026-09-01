# Arquitetura de sistema — Mavia

- **Data:** 2026-09-01
- **Autor:** `arquiteto-solucao`
- **Status:** Normativo. Contradizer este documento exige ADR nova.
- **Insumos:** `CLAUDE.md` (1, 2, 6, 7) · `CONTEXT.md` · ADRs 0001–0006 · `docs/pesquisa/organizze-teardown.md` · `docs/pipeline.md`

Este documento fixa: as fronteiras de módulo, **onde os testes moram**, o modelo de dados, a superfície de API, os jobs e o mapa tela → endpoint. A seção 2 é o produto principal — as outras existem para sustentá-la.

Vocabulário usado com precisão: **módulo** (unidade com fronteira), **interface** (o que o resto do sistema pode nomear), **implementação** (o que está atrás), **profundidade** (razão comportamento/interface), **seam** (superfície observável onde o teste se prende), **adapter** (implementação concreta de um seam), **alavancagem** (quanto o módulo poupa aos chamadores), **localidade** (quantos arquivos uma mudança toca).

---

## 0. Fronteiras e regra de dependência

```
packages/domain      → não importa nada (nem Node, nem Zod, nem Date global)
packages/contracts   → importa domain
packages/ui          → importa domain          (ver 1.3 — decisão nova)
apps/api             → importa domain + contracts
apps/web             → importa domain + contracts + ui
apps/mobile          → importa domain + contracts + ui
infra/               → não é importado por ninguém
```

Nunca o inverso. Nunca app → app. Nunca `packages/*` → `apps/*`.

**Decisão desta arquitetura:** `packages/ui` importa **apenas** `packages/domain`, não `packages/contracts`. Um componente recebe props já modeladas (`{ valor: Money, rotulo: string }`), nunca um DTO de resposta. Motivo: o design system não pode versionar junto com a API. Se `ui` conhecesse `contracts`, cada mudança de rota arrastaria o design system para o diff. Ver 7 (ADR proposta).

**Onde a regra é imposta:** `eslint-plugin-boundaries` no CI, mais `pnpm why` no `turbo.json`. Violação reprova o build, não o code review.

---

## 1. Mapa de módulos

### 1.1 `packages/domain` — o coração puro

Zero I/O, zero framework, relógio injetado. Todo módulo retorna `Result<T, DomainError>`; exceção só na borda HTTP. Este pacote é o seam mais barato e mais alavancado do projeto — tudo que puder ser decidido aqui **deve** ser decidido aqui.

| Módulo | Propósito | Interface pública | Depende de | Profundidade |
|---|---|---|---|---|
| `resultado` | `Result<T,E>`, `DomainError` taxonomia | `ok`, `err`, `map`, `andThen`, `unwrapOr`, `DomainError` | — | Rasa por desenho (é vocabulário, não comportamento) |
| `relogio` | Porta do tempo | `Clock { agora(): Instant }`, `RelogioFixo` | — | Rasa, deliberada: existe para tornar tudo abaixo determinístico |
| `money` | Aritmética monetária exata | `Money.deCentavos(bigint, Moeda)`, `somar`, `subtrair`, `negar`, `abs`, `ratear(n \| pesos[])`, `comparar`, `ehZero`, `centavos`, `moeda`, `formatar(locale)` | `resultado` | **Profunda.** Interface de 11 nomes; atrás dela: distribuição de resto, recusa de moedas mistas, ausência total de fração de centavo |
| `periodo` | Granularidade, navegação e fuso | `Periodo.de(granularidade, ancora, tz)`, `anterior`, `proximo`, `contem(instant)`, `janela(): [Instant, Instant)`, `competenciaDe(instant)` | `relogio` | **Profunda.** Absorve todo o UTC ↔ `America/Sao_Paulo`, horário de verão histórico, semana começando no domingo, mês com 28/31 dias. É o módulo que impede data nua no resto do sistema |
| `lancamento` | O átomo: sinal, status, invariantes | `criarDespesa`, `criarReceita`, `efetivar`, `desefetivar`, `aplicarEdicao`, `Lancamento` (tipo opaco) | `money`, `periodo` | Média. Muito da profundidade está nas regras de sinal e transição de status |
| `transferencia` | Partida dobrada | `criarTransferencia(origem, destino, valor, quando, tipo): Result<[Lancamento, Lancamento]>`, `ehTransferencia(l)`, `somaDasPernas(pernas)` | `lancamento`, `money` | **Profunda.** O chamador nunca vê `transfer_group_id`, nem decide sinal, nem sabe que pagamento de fatura é transferência. Teste da deleção: apagar isto obriga ~8 lugares a saber da partida dobrada |
| `parcelamento` | Compra em N parcelas | `parcelar(total, n, compraEm, ciclo): Result<Parcela[]>`, `Parcela { numero, total, valor, competencia }` | `money`, `fatura`, `periodo` | **Profunda.** Rateio com resto na primeira, uma parcela por fatura futura, `purchase_date` preservada no grupo |
| `fatura` | Ciclo de cobrança do cartão | `janelaDaFatura(cartao, postedAt): CicloFatura`, `faturaAlvo(cartao, postedAt)`, `proximoCiclo(ciclo)`, `transicao(estado, evento): Result<EstadoFatura>` | `periodo`, `money` | **Profunda.** `closing_day = 31` em fevereiro, fechamento após vencimento, virada de ano, compra no próprio dia do fechamento. Interface de 4 funções escondendo a parte mais escorregadia do domínio |
| `saldo` | Derivação e projeção | `saldoDerivado(saldoInicial, lancamentos): Money`, `projetar(saldoAtual, previstos, ate): Money`, `resumoDoPeriodo(baldes: SomasPorBalde, saldoAnterior): ResumoPeriodo` | `money`, `lancamento`, `periodo` | **Profunda.** `resumoDoPeriodo` é o coração conceitual do produto (realizado × previsto) e vive aqui, não em SQL — ver 4.4 |
| `recorrencia` | Regra que gera ocorrências | `ocorrenciasEntre(regra, de, ate): Instant[]`, `proximaOcorrencia(regra, apos)`, `validarRegra` | `periodo` | Profunda. Guarda a regra, nunca as ocorrências |
| `planejamento` | Teto de despesa e piso de receita | `avaliar(planejamento, realizado, previsto): StatusPlanejamento`, `faixasDeAlerta(pct[])`, `copiarCompetencia(de, para)` | `money`, `periodo` | Média. Unifica Limite e Meta-de-receita (teardown 8.2) |
| `meta` | Objetivo de acúmulo | `progresso(meta, acumulado): ProgressoMeta`, `ritmoNecessario(meta, hoje)` | `money`, `periodo` | Rasa hoje; cresce no épico 8 |
| `ingestao` | Normalização e idempotência de dado externo | `chaveIdempotencia(bruto): ChaveIngestao`, `hashConteudo(bruto): Hash`, `normalizar(bruto): Result<LancamentoBrutoNormalizado>` | `money`, `periodo` | **Profunda.** A alavancagem do ADR 0003 nasce aqui: a idempotência é resolvida uma vez e vale para todos os adapters |
| `conciliacao` | Casamento importado × manual | `sugerir(brutos, candidatos, politica): Sugestao[]`, `pontuar(bruto, lancamento): Score` | `money`, `periodo` | **Profunda.** Puro e determinístico; nunca escreve, só sugere (regra 15) |
| `categorizacao` | Escolha de categoria por regra | `aplicarRegras(lancamento, regras): Result<CategoriaSugerida>`, `Regra`, `Motivo` | `lancamento` | Média. O modelo estatístico fica em `apps/api`; a **regra do usuário** e o motivo visível ficam aqui |
| `sincronizacao-offline` | Política de conflito do mobile | `planejarSincronizacao(mutacoesLocais, estadoServidor, clock): PlanoDeSync` | `lancamento`, `relogio` | **Profunda e decisiva:** existe para que o offline seja testado no seam de domínio e não exija seam novo no app. Ver 2.4 |
| `politica-acesso` | Papel → permissão | `pode(papel, acao, recurso): boolean` | — | Rasa, mas de localidade alta: uma tabela, um lugar |

**O que NÃO entra em `domain`:** nada que precise de rede, disco, relógio do sistema, Zod, Drizzle ou NestJS. Se um teste de domínio precisa subir banco, a regra está no módulo errado.

### 1.2 `packages/contracts` — a fonte única da API

Schemas Zod que geram tipos TypeScript **e** o documento OpenAPI. Importa `domain` para tipos de marca (`MoedaISO`, `CentavosString`).

| Módulo | Interface pública | Nota |
|---|---|---|
| `primitivos` | `zMoney` (string de centavos + moeda), `zInstant`, `zUuid`, `zCompetencia` | `bigint` viaja como **string** no JSON (ADR 0005) |
| `envelope` | `zPagina<T>`, `zCursor`, `zErro`, `zResumoValidacao` | Paginação keyset — ver 4.3 |
| `filtro-lancamentos` | `zFiltroLancamentos` — **um único objeto** consumido pela listagem *e* pelo resumo | Três eixos ortogonais; ver 4.4 |
| `contas`, `cartoes`, `faturas`, `categorias`, `etiquetas`, `lancamentos`, `transferencias`, `parcelamentos`, `recorrencias`, `planejamentos`, `objetivos`, `relatorios`, `importacoes`, `conexoes`, `conciliacoes`, `atividades`, `alertas`, `preferencias`, `auth`, `tenants` | Um arquivo por recurso: `zCriarX`, `zAtualizarX`, `zXResposta`, `zListarXQuery` | Nome do schema = nome da rota = nome da tela |

**Profundidade:** rasa por natureza — contrato é declaração. O valor está na **localidade**: mudar a forma de um recurso toca um arquivo e quebra o typecheck de `api`, `web` e `mobile` no mesmo commit.

### 1.3 `packages/ui` — o design system

Tokens da direção escolhida (ADR 0006) e primitivos. Importa apenas `domain`.

| Módulo | Interface pública | Nota |
|---|---|---|
| `tokens` | escalas de tipo, cor, espaço, raio, elevação; exportadas em formato neutro (JS) e consumidas por Tailwind (web) e StyleSheet (native) | Componente compõe token, nunca inventa valor |
| `valor` | `<ValorMonetario money align sinal />` | `font-variant-numeric: tabular-nums` obrigatório; formatação vem de `domain/money.formatar` |
| `lista` | `<Linha />`, `<GrupoPorDia />`, `<RodapeResumo />` | Densidade, divisória fina, sem card |
| `periodo` | `<NavegadorDePeriodo />` — alternador de granularidade + setas | Espelha `domain/periodo` |
| `entrada` | `<CampoValor />`, `<SeletorCategoria />`, `<ToggleSituacao />` | `CampoValor` emite centavos, nunca `number` |
| `grafico` | `<Rosca />`, `<Barras />`, `<Linha />` | Paleta de dados separada da cor de marca |
| `estado` | `<Vazio />`, `<Carregando />`, `<Erro />` | Estado vazio é compacto — corrige a fraqueza 3 do teardown |

**Fronteira dura:** nenhum componente de `ui` faz fetch, conhece rota, ou importa `contracts`.

### 1.4 `apps/api` — módulos NestJS

Um processo HTTP e um processo worker, mesmo código, `ROLE` diferente. Cada módulo expõe um `Module` NestJS, mas a fronteira que importa é a **função pública** que o controller e o processador de job chamam.

| Módulo | Propósito | Interface pública (o que outros módulos podem chamar) | Depende de |
|---|---|---|---|
| `tenancy` | Contexto de tenant e sessão RLS | `withTenant(tenantId, fn)`, `TenantContext.atual()`, `unidadeDeTrabalho(fn)` | Drizzle, `domain/politica-acesso` |
| `auth` | Identidade, sessão, papéis, OAuth | `autenticar`, `emitirTokens`, `revogar`, `exigirPapel(papel)` | `tenancy` |
| `contas` | CRUD de Conta | `criarConta`, `atualizarConta`, `arquivarConta`, `listarContas`, `saldoDeContas(em)` | `tenancy`, `saldos` |
| `cartoes` | CRUD de Cartao + Fatura | `criarCartao`, `listarFaturas`, `obterFatura`, `fecharFatura`, `reabrirFatura`, `registrarPagamentoDeFatura` | `tenancy`, `domain/fatura`, `lancamentos` |
| `categorias` | Árvore de dois níveis | `criarCategoria`, `arquivarCategoria`, `arvore()` | `tenancy` |
| `etiquetas` | Etiquetas transversais | `criarEtiqueta`, `aplicar`, `listar` | `tenancy` |
| `lancamentos` | Escrita do átomo — inclui transferência e parcelamento | `criarLancamento`, `criarTransferencia`, `criarParcelamento`, `editar`, `efetivar`, `excluir`, `editarEmLote`, `listar(filtro, cursor)`, `resumo(filtro)` | `tenancy`, `domain/{lancamento,transferencia,parcelamento,fatura}`, `auditoria`, `outbox` |
| `saldos` | Modelo de leitura de saldo | `saldoDerivado(contaId, em)`, `saldoGeral(em)`, `projetar(ate)`, `materializar(contaId, desdeDia)`, `reconciliar(contaId)` | `tenancy`, `domain/saldo` |
| `recorrencias` | Regra e materialização | `criarRecorrencia`, `editarRecorrencia`, `materializarAte(horizonte)` | `tenancy`, `domain/recorrencia`, `lancamentos` |
| `planejamento` | Teto e piso por categoria × competência | `definir`, `copiarDe(competencia)`, `avaliar(competencia)` | `tenancy`, `domain/planejamento`, `relatorios` |
| `objetivos` | Objetivo de acúmulo (ADR 0009) | `criarObjetivo`, `registrarAporte`, `progresso` | `tenancy`, `domain/objetivo` |
| `ingestao` | **O seam do ADR 0003** | `BankSyncProvider` (interface), `registrarAdapter`, `executarSincronizacao(conexaoId)`, `receberArquivo(arquivo, tipo)`, `promoverBrutos(sincronizacaoId)` | `tenancy`, `domain/ingestao`, `lancamentos` |
| `conciliacao` | Sugestão e decisão | `gerarSugestoes(sincronizacaoId)`, `aceitar(sugestaoId)`, `rejeitar(sugestaoId)` | `tenancy`, `domain/conciliacao` |
| `inteligencia` | Categorização automática, OCR | `sugerirCategoria(lancamento)`, `lerRecibo(anexoId)` | `tenancy`, `domain/categorizacao` |
| `relatorios` | Modelo de leitura agregado | `porCategoria(periodo, base)`, `entradasSaidas(periodo, agregacao, incluirPrevisto)`, `porConta`, `porEtiqueta`, `evolucao` | `tenancy`, `domain/{money,periodo}` |
| `alertas` | Avaliação e notificação | `avaliarAlertas(tenantId, dia)`, `enfileirarNotificacao(chaveDedup, ...)`, `marcarLido` | `tenancy`, `planejamento`, `lancamentos` |
| `auditoria` | Log append-only e tela Atividades | `registrar(entidade, id, acao, de, para)`, `listarAtividades(filtro, cursor)` | `tenancy` |
| `arquivos` | Anexos e exportações | `guardar`, `assinarUrl`, `gerarExportacao(formato, escopo)` | `tenancy` |
| `outbox` | Eventos de domínio transacionais | `publicar(tipo, payload)` — escreve na mesma transação | `tenancy` |
| `filas` | Infra BullMQ | `registrarProcessador(nome, fn)`, `enfileirar(fila, jobId, payload)` | Redis |
| `preferencias` | Preferências por usuário × tenant | `obter`, `salvar` | `tenancy` |
| `billing` | Planos e assinatura (épico 11) | `planoAtual`, `limitesDoPlano` | `tenancy` |
| `mcp` | Apps conectados via OAuth (pós-MVP) | `autorizarCliente`, `escoposDe(token)` | `auth` |

**Teste da deleção aplicado.** Apagar `tenancy`: **todo** módulo precisaria saber configurar `app.tenant_id` por transação — alavancagem máxima, mantenha-o profundo. Apagar `ingestao`: cada adapter reimplementaria idempotência e deduplicação — esse é exatamente o argumento do ADR 0003. Apagar `outbox`: cada escrita precisaria de lógica de "enfileirei mas o commit falhou" — alavancagem alta para um módulo de duas funções.

**Módulo raso identificado e aceito:** `filas` é fino de propósito — ele existe para que o processador de job seja uma função pura de módulo, e não uma classe acoplada ao BullMQ. Isso é o que permite testar job no seam HTTP (2.3).

### 1.5 `apps/web` e `apps/mobile`

Não são módulos de domínio. Contêm: rotas, composição de `ui`, camada de dados (TanStack Query no web; TanStack Query + SQLite no mobile) e nada mais. **Regra de negócio em `apps/` é defeito arquitetural — veto do arquiteto, não discussão de code review.**

O caso limítrofe recorrente: "em que fatura cai esta compra?" precisa aparecer no formulário antes de salvar. A resposta é `domain/fatura.faturaAlvo(cartao, postedAt)` chamada no cliente — a mesma função que o servidor usa. Isso é uso correto do monorepo (ADR 0001), não regra em `apps/`.

---

## 2. Os seams

**Este é o produto principal deste documento.** Um seam é a superfície observável onde o teste se prende. Fora dela, não se testa.

### 2.1 Regra de escolha

1. Preferir seam existente a novo.
2. Preferir o seam **mais alto** que ainda observa o comportamento.
3. O número ideal de seams novos numa feature é zero.
4. Se ninguém consegue testar sem alcançar o interior de um módulo, **mova o seam** — não relaxe o teste.

### 2.2 Os seis seams do projeto

| # | Seam | Superfície observável | Ferramenta | Onde os testes moram |
|---|---|---|---|---|
| **S1** | Interface pública de `packages/domain` | Funções exportadas de cada módulo de domínio | Vitest + fast-check | `packages/domain/src/<modulo>/*.spec.ts` |
| **S2** | HTTP de `apps/api` sobre Postgres real | Requisição → resposta, com banco de verdade e RLS ligada | Vitest + Testcontainers + `fastify.inject` | `apps/api/test/http/<recurso>.spec.ts` |
| **S3** | Contrato do `BankSyncProvider` | A interface do ADR 0003, executada contra **cada** adapter | Vitest (suíte de contrato parametrizada) | Suíte: `apps/api/src/ingestao/provider/contrato/bank-sync-provider.contrato.ts` · Execução: `apps/api/src/ingestao/adapters/<adapter>/<adapter>.spec.ts` |
| **S4** | Schemas de `packages/contracts` | Resposta real da API parseada pelo schema; tipos derivados usados por web e mobile | Vitest | `packages/contracts/test/*.spec.ts` + asserção de parse dentro de S2 |
| **S5** | E2E web | Navegador contra a stack completa | Playwright | `apps/web/e2e/*.spec.ts` |
| **S6** | E2E mobile | App em emulador | Maestro | `apps/mobile/.maestro/*.yaml` |

**Nenhum seam novo é introduzido por este documento.** S1, S2, S4, S5 e S6 vêm de `CLAUDE.md` §7; S3 vem do ADR 0003. As seções 2.3 e 2.4 explicam as duas decisões estruturais que tornaram isso possível.

### 2.3 Por subsistema — onde cada coisa é testada

| Subsistema | Seam | O que é observado ali | Por que este e não outro |
|---|---|---|---|
| `Money`, rateio, sinal | **S1** | Soma exata, resto na primeira parte, recusa de moedas mistas, ausência de fração de centavo | Property-based obrigatório (ADR 0005). Aritmética não precisa de banco; testar no HTTP seria mais lento e provaria menos |
| Transferência (partida dobrada) | **S1** para "soma das pernas é zero" · **S2** para "as duas linhas foram gravadas na mesma transação" | Invariante puro vs. atomicidade | O invariante é puro; a atomicidade só existe com banco |
| Parcelamento | **S1** | N parcelas somam exatamente o total; uma por fatura futura; `purchase_date` preservada | Puro |
| Ciclo de fatura | **S1** | `closing_day` 31 em fevereiro, compra no dia do fechamento, virada de ano | Puro. O caminho HTTP é plumbing |
| Fechamento de fatura (transição de estado + próxima fatura) | **S2** | Job rodado duas vezes não fecha duas vezes nem cria fatura duplicada | Requer unicidade de banco |
| Saldo derivado | **S1** (dobra) + **S2** (materialização e reconciliação) | S1: qualquer sequência de lançamentos → saldo. S2: snapshot == derivado | O invariante monetário é puro; o snapshot é um fato de banco |
| Período, granularidade, fuso | **S1** | Navegação por granularidade, UTC ↔ `America/Sao_Paulo`, horário de verão histórico | Puro, com relógio injetado |
| Recorrência | **S1** (ocorrências) + **S2** (materialização idempotente) | S1: a série. S2: rodar duas vezes não duplica | Idem |
| Planejamento (teto/piso) e alertas | **S1** (avaliação, faixas) + **S2** (dedup de notificação) | Puro vs. unicidade de `chave_dedup` | Idem |
| Ingestão: idempotência e dedup | **S1** (`chaveIdempotencia`, `hashConteudo`) + **S2** (mesmo OFX importado duas vezes) | A chave é pura; o "não duplicou" é do banco | Regra 13 exige a prova no banco |
| Parsers OFX/CSV | **S3** | Arquivo de fixture → `LancamentoBruto[]` normalizado; arquivo malformado → erro tipado | **Reusa S3**: a mesma suíte de contrato roda para `manual`, `ofx-import`, `csv-import` e, no épico 12, `pluggy`. Testar parser por upload HTTP seria lento e não provaria mais nada |
| Conciliação | **S1** (pontuação e sugestão) + **S2** (sugestão nunca sobrescreve o registro do usuário) | Regra 15 tem consequência de escrita — precisa de banco | — |
| Categorização automática | **S1** (regras do usuário e motivo) | O modelo estatístico não é testado por asserção de acerto; é medido por métrica offline | Testar acurácia de modelo em suíte de CI produz teste intermitente |
| Tenancy e RLS | **S2** | Dois tenants, um não enxerga o outro, em **toda** rota de recurso | ADR 0004: RLS não pode ser mockada |
| Autorização por papel | **S2** | `visualizador` não escreve; `membro` não muda billing | IDOR só é observável na borda |
| Paginação e filtro | **S2** | Cursor estável sob inserção concorrente; filtro dos três eixos produz o conjunto certo | SQL é a implementação; o comportamento é da rota |
| Rodapé realizado × previsto | **S1** (`resumoDoPeriodo`) + **S2** (agregação SQL e igualdade com a lista) | Ver 4.4 | — |
| Contratos API ↔ web ↔ mobile | **S4** | A resposta real parseia; o tipo derivado compila | — |
| Jobs e filas | **S2** | Ver 2.4 | **Sem seam novo** |
| Offline do mobile | **S1** (`planejarSincronizacao`) + **S6** (fumaça) | Ver 2.4 | **Sem seam novo** |
| `packages/ui` | **S5** (uma asserção representativa) | Coluna de valor usa algarismos tabulares; sinal tem rótulo além de cor | Ver 2.5 |
| Jornadas de usuário | **S5** / **S6** | Onboarding, lançar, parcelar, pagar fatura, importar OFX, filtrar | Poucas e caras: 6 no web, 3 no mobile |

### 2.4 As duas decisões que evitaram seams novos

**(a) Job é função pública de módulo, não classe acoplada à fila.**

Um job só pode ser testado em S2 se for possível executá-lo de dentro do teste. Portanto:

```ts
// apps/api/src/saldos/jobs/reconciliar.ts
export async function reconciliarSaldo(deps: Deps, payload: ReconciliarPayload): Promise<Result<Relatorio, JobError>>
```

O módulo `filas` apenas registra essa função num processador BullMQ. No teste de S2: cria dados por HTTP → chama `reconciliarSaldo` **duas vezes** → verifica por HTTP. A fila não participa do teste, e não precisa: o que se quer provar é reentrância, não que o BullMQ entrega.

*Seam novo evitado:* um "seam de fila" com Redis em Testcontainers, mais lento e que testaria a biblioteca de terceiros.

**(b) A política de conflito offline é pura e mora em `packages/domain`.**

A tentação é criar um seam em `apps/mobile/src/sync` com SQLite em memória e cliente de API falso. Isso seria superfície nova para manter para sempre, testando plumbing.

Em vez disso, `domain/sincronizacao-offline.planejarSincronizacao(mutacoesLocais, estadoServidor, clock)` devolve um `PlanoDeSync` — a lista de operações a aplicar e os conflitos a apresentar. Toda a combinatória (editei offline e o servidor também; apaguei offline e foi efetivado no servidor; criei duas vezes por retry) é testada em **S1**, com property-based. O executor no app vira plumbing coberto pela fumaça de **S6**.

Este é o princípio do agente aplicado literalmente: *mova o seam, não relaxe o teste*.

### 2.5 Onde os testes NÃO vão — anti-seams

Testar aqui é motivo de reprovação em `/code-review`:

- **Repositórios Drizzle** e qualquer classe `*Repository`. Se a query está errada, S2 acusa.
- **Serviços NestJS internos** com dependências mockadas. O mock vira o objeto sob teste.
- **Componentes de `packages/ui` isoladamente.** A formatação monetária é pura e vive em S1; o resto é aparência, coberta pela auditoria de `docs/design.md` §5 e por uma asserção em S5. Um seam de componente custaria manutenção permanente para reprovar mudanças de layout legítimas.
- **Hooks e queries do web/mobile.** Cobertos por S4 (tipos) e S5/S6 (jornada).
- **Adapter de `BankSyncProvider` mockado em teste de aplicação.** Se o teste precisa de um provider falso, ou ele pertence a S3, ou está no lugar errado.
- **Migrations isoladamente.** Aplicadas de verdade no `beforeAll` de S2. Migration que não sobe reprova a suíte inteira, que é o sinal certo.

### 2.6 Orçamento de seam por feature

Todo spec produzido por `/to-spec` declara, em uma linha por comportamento, **qual dos seis seams** o observa. Se a resposta for "nenhum", a feature volta para o desenho — não ganha seam novo sem ADR. Seam novo é superfície que alguém mantém para sempre.

---

## 3. Modelo de dados

PostgreSQL. Toda tabela de negócio: `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` (v4 — identificador exposto não sequencial, ADR 0004), `tenant_id UUID NOT NULL`, `criado_em TIMESTAMPTZ NOT NULL DEFAULT now()`, `atualizado_em TIMESTAMPTZ`, `deleted_at TIMESTAMPTZ`. Dinheiro é sempre `BIGINT` de centavos mais `moeda CHAR(3)`. Nunca `NUMERIC`, nunca `float`.

### 3.1 Identidade e tenancy

| Tabela | Colunas-chave | Notas |
|---|---|---|
| `tenants` | `nome`, `plano`, `timezone DEFAULT 'America/Sao_Paulo'` | Não tem `tenant_id` — **é** o tenant |
| `usuarios` | `email CITEXT UNIQUE`, `senha_hash`, `nome`, `mfa_segredo_cifrado`, `ultimo_acesso_em` | Global, não tenant-scoped |
| `tenant_usuarios` | PK `(tenant_id, usuario_id)`, `papel` ∈ `proprietario\|membro\|visualizador`, `convidado_por`, `aceito_em` | Base do compartilhamento familiar |
| `sessoes` | `usuario_id`, `refresh_hash`, `dispositivo`, `expira_em`, `revogada_em` | |
| `preferencias` | PK `(tenant_id, usuario_id)`, `ordenacao`, `periodo_padrao` ∈ `dia\|semana\|mes`, `saldo_diario BOOL`, `base_temporal_cartao` ∈ `data_fatura\|data_compra\|data_parcela` | Teardown §5 e §7 |

### 3.2 Contas, cartões, classificação

| Tabela | Colunas-chave | Notas |
|---|---|---|
| `contas` | `nome`, `tipo` ∈ `corrente\|poupanca\|dinheiro\|investimento\|digital\|outra`, `moeda`, `saldo_inicial_centavos BIGINT`, **`incluir_no_saldo_geral BOOL DEFAULT true`**, **`origem`** ∈ `manual\|conectado`, `conexao_id`, `icone`, `cor`, `arquivada_em` | `incluir_no_saldo_geral` e `origem` vêm do teardown 8.3. `tipo` **existe** — corrige a fraqueza 2 do Organizze |
| `cartoes` | `nome`, `limite_centavos BIGINT`, `closing_day SMALLINT CHECK 1..31`, `due_day SMALLINT CHECK 1..31`, `conta_pagamento_id FK contas`, `moeda`, **`origem`**, `conexao_id`, `arquivada_em` | Não é Conta |
| `categorias` | `parent_id FK categorias`, `nivel SMALLINT CHECK IN (1,2)`, `nome`, `natureza` ∈ `receita\|despesa`, `cor`, `icone`, `sistema BOOL`, **`arquivada_em`** | `CHECK (nivel = 1) = (parent_id IS NULL)`; trigger garante que o pai tem `nivel = 1`. Categoria de sistema: `arquivada_em` sim, `deleted_at` nunca |
| `etiquetas` | `nome`, `cor`; `UNIQUE (tenant_id, lower(nome)) WHERE deleted_at IS NULL` | Nome único no glossário: **Etiqueta**, nunca "marcador" (corrige a fraqueza 7) |
| `lancamento_etiquetas` | PK `(tenant_id, lancamento_id, etiqueta_id)` | `tenant_id` na PK para que a RLS e o índice sirvam a junção |

### 3.3 O núcleo: `lancamentos`

```sql
CREATE TABLE lancamentos (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id),
  conta_id                  UUID REFERENCES contas(id),
  cartao_id                 UUID REFERENCES cartoes(id),
  categoria_id              UUID REFERENCES categorias(id),
  valor_centavos            BIGINT NOT NULL,
  moeda                     CHAR(3) NOT NULL,
  posted_at                 TIMESTAMPTZ NOT NULL,        -- competência
  effective_at              TIMESTAMPTZ,                 -- efetivação; NULL enquanto previsto
  status                    lancamento_status NOT NULL,  -- previsto | pendente | efetivado
  descricao                 TEXT NOT NULL,
  observacao                TEXT,
  transfer_group_id         UUID REFERENCES transferencias(id),
  installment_group_id      UUID REFERENCES parcelamentos(id),
  installment_number        SMALLINT,
  installment_total         SMALLINT,
  recorrencia_id            UUID REFERENCES recorrencias(id),
  recorrencia_ocorrencia_em DATE,
  fatura_id                 UUID REFERENCES faturas(id),
  lancamento_bruto_id       UUID REFERENCES lancamentos_brutos(id),
  origem                    lancamento_origem NOT NULL,  -- manual | importado | recorrencia | parcelamento
  editado_manualmente       BOOLEAN NOT NULL DEFAULT false,
  criado_por                UUID NOT NULL REFERENCES usuarios(id),
  criado_em                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em             TIMESTAMPTZ,
  deleted_at                TIMESTAMPTZ,

  CONSTRAINT uma_origem_de_dinheiro CHECK (num_nonnulls(conta_id, cartao_id) = 1),
  CONSTRAINT valor_nao_zero        CHECK (valor_centavos <> 0),
  CONSTRAINT transferencia_sem_categoria
    CHECK (transfer_group_id IS NULL OR categoria_id IS NULL),
  CONSTRAINT parcela_coerente
    CHECK ((installment_group_id IS NULL) = (installment_number IS NULL)
           AND (installment_number IS NULL OR installment_number BETWEEN 1 AND installment_total)),
  CONSTRAINT efetivado_tem_data
    CHECK ((status = 'efetivado') = (effective_at IS NOT NULL)),
  CONSTRAINT cartao_tem_fatura
    CHECK (cartao_id IS NULL OR fatura_id IS NOT NULL)
);
```

`editado_manualmente` existe para que a rematerialização de recorrência não sobrescreva o que o usuário tocou.

### 3.4 Estruturas compostas

| Tabela | Colunas-chave | Notas |
|---|---|---|
| `transferencias` | `id` (= `transfer_group_id`), `tipo` ∈ `entre_contas\|pagamento_fatura`, `fatura_id` (quando pagamento), `descricao`, `criado_por` | Constraint **deferida**: `SUM(valor_centavos)` das pernas = 0 e exatamente 2 pernas vivas. Pagamento de fatura é **daqui**, nunca uma despesa (regra 12) |
| `parcelamentos` | `id` (= `installment_group_id`), `cartao_id`, **`purchase_date DATE NOT NULL`**, `valor_total_centavos`, `moeda`, `total_parcelas`, `descricao`, `categoria_id` | **`purchase_date` é a lacuna do teardown 8.1.** Sem ela é impossível separar "quanto comprei em julho" de "quanto vou pagar em julho" |
| `faturas` | `cartao_id`, `periodo_inicio DATE`, `periodo_fim DATE`, `data_fechamento DATE`, `data_vencimento DATE`, `estado` ∈ `aberta\|fechada\|paga\|parcialmente_paga\|vencida`, `total_centavos BIGINT`, `pago_centavos BIGINT`, `fechada_em` | `UNIQUE (tenant_id, cartao_id, periodo_inicio)`. Ver 3.7 sobre derivado vs. congelado |
| `recorrencias` | `conta_id`/`cartao_id`, `categoria_id`, `descricao`, `valor_centavos`, `moeda`, `frequencia` ∈ `diaria\|semanal\|mensal\|anual`, `intervalo`, `dia_do_mes`, `dia_da_semana`, `inicio_em`, `fim_em`, `ocorrencias_max`, `materializado_ate DATE`, `ativa` | Guarda a regra, não as ocorrências |
| `planejamentos` | `categoria_id`, `competencia DATE` (dia 1 do mês), `valor_centavos` (**com sinal**: negativo = teto de despesa, positivo = piso de receita), `moeda`, `alertas_pct SMALLINT[]` | `UNIQUE (tenant_id, categoria_id, competencia)`. **Sem coluna `natureza`** — o ADR 0008 a veta: enum e sinal podem se contradizer, e a comparação `realizado >= valor` serve teto e piso sem ramificar. Teto global do mês (`categoria_id` nulo) está **pendente de decisão** — não implemente até o ADR sair |
| `objetivos` | `nome`, `valor_alvo_centavos` (**sempre positivo** — é estoque-alvo, não fluxo), `moeda`, `conta_id` (NULL = por aportes), `saldo_base_centavos` (congelado na criação, só no modo ancorado), `prazo_em DATE` (**opcional**), `concluido_em`, `arquivada_em` | Objetivo de **acúmulo** plurimensal, sem `competencia` — é isso que o separa de `planejamentos`. Dois modos de apuração derivados de `conta_id`, mutuamente exclusivos: ancorado ou por `aportes`. Ver ADR 0009 |

### 3.5 Ingestão

| Tabela | Colunas-chave | Notas |
|---|---|---|
| `conexoes` | `provider TEXT`, `instituicao`, `status` ∈ `ativa\|expirada\|revogada\|erro`, `credenciais_cifradas BYTEA`, `dek_cifrada BYTEA`, `escopo JSONB`, `valida_ate`, `ultima_sync_em` | Envelope encryption: DEK por conexão, KEK fora do banco. Nunca em log, nunca em resposta (regra 19) |
| `consentimentos` | `conexao_id`, `usuario_id`, `versao_texto`, `escopo JSONB`, `concedido_em`, `expira_em`, `revogado_em`, `ip_hash`, `user_agent_hash` | Append-only. Revogação dispara `retencao.aplicar` |
| `sincronizacoes` | `conexao_id`, `provider`, `iniciada_em`, `terminada_em`, `resultado` ∈ `sucesso\|parcial\|erro`, `criados`, `atualizados`, `ignorados`, `erro_codigo` | O que a tela de importação mostra |
| `lancamentos_brutos` | `provider`, `external_id`, `conteudo_hash BYTEA`, `payload JSONB`, `conta_id`/`cartao_id`, `sincronizacao_id`, `valor_centavos`, `moeda`, `posted_at`, `descricao_origem`, `status` ∈ `novo\|promovido\|ignorado_duplicado\|conciliado`, `lancamento_id` | **`UNIQUE (tenant_id, provider, external_id)`** e **`UNIQUE (tenant_id, provider, conteudo_hash)`** — a chave da regra 13. Preservado para auditoria e reprocessamento |
| `conciliacao_sugestoes` | `lancamento_bruto_id`, `lancamento_id`, `score`, `motivo JSONB`, `estado` ∈ `sugerida\|aceita\|rejeitada`, `decidida_por`, `decidida_em` | `UNIQUE (tenant_id, lancamento_bruto_id, lancamento_id)`. **Nunca escreve em `lancamentos`** |
| `regras_categorizacao` | `prioridade INT`, `condicoes JSONB`, `categoria_id`, `etiquetas UUID[]`, `ativa` | Motivo sempre visível, sempre reversível |

### 3.6 Transversais

| Tabela | Colunas-chave | Notas |
|---|---|---|
| `saldo_snapshots` | PK `(tenant_id, conta_id, dia DATE)`, `saldo_centavos BIGINT`, `ultimo_lancamento_em`, `calculado_em` | **Materializado.** Ver 3.7 |
| `auditoria` | `id BIGSERIAL`, `usuario_id`, `entidade`, `entidade_id`, `acao`, `de JSONB`, `para JSONB`, `ocorrido_em`, `request_id`, `ip_hash` | **Append-only:** `REVOKE UPDATE, DELETE ON auditoria FROM mavia_app`. Alimenta a tela Atividades (90 dias visíveis, retenção maior por compliance) |
| `notificacoes` | `usuario_id`, `tipo`, `payload JSONB`, `canal` ∈ `push\|email\|inapp`, `chave_dedup TEXT`, `agendado_para`, `enviado_em`, `lido_em` | `UNIQUE (tenant_id, chave_dedup)` — a idempotência dos alertas |
| `anexos` | `lancamento_id`, `storage_key`, `mime`, `bytes`, `hash` | Limite de tamanho validado na borda |
| `exportacoes` | `formato`, `escopo JSONB`, `storage_key`, `estado`, `expira_em` | Portabilidade LGPD e "Exportar para arquivo" |
| `outbox` | `id BIGSERIAL`, `tipo`, `payload JSONB`, `criado_em`, `publicado_em` | Escrita na mesma transação da mudança. Ver 5.1 |

### 3.7 Derivado × materializado — a distinção que não pode escorregar

| Grandeza | Natureza | Regra |
|---|---|---|
| Saldo de conta, saldo geral | **Derivado** | Verdade = `saldo_inicial + SUM(valor_centavos)` dos lançamentos `efetivado` não excluídos. Nunca uma coluna mutável |
| Projeção | **Derivado, nunca persistido** | Saldo atual + `previsto` até a data |
| Resumo do período (realizado × previsto) | **Derivado a cada consulta** | Agregado em SQL, interpretado no domínio (4.4) |
| Totais de relatório | **Derivado** | — |
| "Saldo no dia" na lista | **Derivado** | Soma acumulada dentro da página |
| `saldo_snapshots.saldo_centavos` | **Materializado (cache)** | Reconciliado por job. Divergência é **incidente**, não warning (regra 5) |
| `lancamentos.fatura_id` | **Materializado (denormalização)** | Derivável de `domain/fatura.faturaAlvo`. Gravado na escrita para tornar a consulta de fatura um índice, não um cálculo |
| `faturas.total_centavos` enquanto `aberta` | **Materializado (cache)** | Não é fonte de verdade; recalculado a cada leitura ou por job |
| `faturas.total_centavos` após `fechada` | **Fato congelado** | Deixa de ser cache. A fatura fechada é imutável; alterá-la exige reabertura explícita e auditada (ADR proposta, seção 7) |
| `faturas.pago_centavos` | **Materializado** | Soma das transferências de pagamento associadas |
| `recorrencias.materializado_ate` | **Materializado (marca d'água)** | Só avança |

### 3.8 Índices que importam

Regra sem exceção: **todo índice de tabela de negócio começa por `tenant_id`** (ADR 0004 — a RLS injeta `tenant_id = ...` em toda consulta; um índice que não lidere por ele não é usado).

```sql
-- lancamentos
CREATE INDEX ON lancamentos (tenant_id, conta_id, effective_at)
  WHERE deleted_at IS NULL AND status = 'efetivado';          -- saldo derivado e snapshot
CREATE INDEX ON lancamentos (tenant_id, posted_at DESC, id DESC)
  WHERE deleted_at IS NULL;                                    -- extrato + paginação keyset
CREATE INDEX ON lancamentos (tenant_id, categoria_id, posted_at)
  WHERE deleted_at IS NULL;                                    -- relatório por categoria
CREATE INDEX ON lancamentos (tenant_id, fatura_id) WHERE deleted_at IS NULL;
CREATE INDEX ON lancamentos (tenant_id, status, posted_at)
  WHERE deleted_at IS NULL AND status <> 'efetivado';          -- contas a pagar / a receber
CREATE INDEX ON lancamentos (tenant_id, transfer_group_id) WHERE transfer_group_id IS NOT NULL;
CREATE INDEX ON lancamentos (tenant_id, installment_group_id, installment_number)
  WHERE installment_group_id IS NOT NULL;

-- idempotência (índices únicos que são regra de negócio, não otimização)
CREATE UNIQUE INDEX ON lancamentos (tenant_id, recorrencia_id, recorrencia_ocorrencia_em)
  WHERE recorrencia_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX ON lancamentos (tenant_id, lancamento_bruto_id)
  WHERE lancamento_bruto_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX ON lancamentos_brutos (tenant_id, provider, external_id);
CREATE UNIQUE INDEX ON lancamentos_brutos (tenant_id, provider, conteudo_hash);

-- demais
CREATE UNIQUE INDEX ON faturas (tenant_id, cartao_id, periodo_inicio);
CREATE INDEX        ON faturas (tenant_id, cartao_id, estado, data_vencimento);
CREATE UNIQUE INDEX ON planejamentos (tenant_id, categoria_id, competencia)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX ON notificacoes (tenant_id, chave_dedup);
CREATE INDEX        ON auditoria (tenant_id, ocorrido_em DESC);
CREATE INDEX        ON auditoria (tenant_id, entidade, entidade_id);
CREATE INDEX        ON outbox (publicado_em) WHERE publicado_em IS NULL;   -- fila, não negócio
```

Os índices únicos parciais acima **são** a idempotência dos jobs da seção 5. Não são otimização; removê-los quebra correção.

### 3.9 Row-Level Security

Padrão aplicado a **toda** tabela de negócio:

```sql
ALTER TABLE lancamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE lancamentos FORCE  ROW LEVEL SECURITY;   -- vale inclusive para o dono da tabela

CREATE POLICY tenant_isolation ON lancamentos
  USING       (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK  (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

- `WITH CHECK` é obrigatório: sem ele, um `INSERT` grava para outro tenant.
- `SET LOCAL app.tenant_id` **por transação**, nunca `SET SESSION` — o pool reaproveita conexões e uma variável de sessão vazada é vazamento entre clientes.
- **Papéis de banco:**

| Papel | `BYPASSRLS` | Usa | Restrições |
|---|---|---|---|
| `mavia_app` | não | Processo HTTP | Sem `UPDATE`/`DELETE` em `auditoria` e `consentimentos` |
| `mavia_jobs` | não | Worker | Lê `tenants` para enumerar; define `app.tenant_id` a cada tenant |
| `mavia_migrate` | sim | Só migrations, em janela de deploy | Nunca serve requisição; uso registrado em `auditoria` |

Nenhum papel que atende requisição ou executa job tem `BYPASSRLS`. **Veto explícito.**

- `usuarios` e `tenants` não são tenant-scoped: policy por `app.usuario_id` e checagem em `tenant_usuarios`.
- **Segunda camada:** todo repositório também filtra por `tenant_id` na cláusula `WHERE` (regra 16 — a primeira camada pode falhar em silêncio).
- **Prova:** todo teste de recurso em S2 cria dois tenants e verifica que um não enxerga o outro. É o teste mais importante do produto.

---

## 4. Superfície de API

Base `/v1`. JSON. Autenticação por bearer; `tenant_id` vem do token, e quando o usuário pertence a mais de um tenant, do header `X-Mavia-Tenant`, sempre validado contra `tenant_usuarios`. Toda resposta de erro segue `zErro` de `contracts`. `bigint` viaja como string.

### 4.1 Grupos de endpoints

| Grupo | Rotas | Retorna | Tela que consome |
|---|---|---|---|
| `auth` | `POST /auth/registrar` · `POST /auth/entrar` · `POST /auth/refresh` · `POST /auth/sair` · `POST /auth/senha/recuperar` · `GET /auth/eu` | Tokens; identidade + tenants + papel | Login, Cadastro, Onboarding |
| `tenants` | `GET /tenants` · `POST /tenants` · `GET /tenants/:id/membros` · `POST /tenants/:id/convites` · `PATCH /tenants/:id/membros/:usuarioId` · `DELETE /tenants/:id/membros/:usuarioId` | Espaços e papéis | Config › Membros (épico 10) |
| `contas` | `GET /contas` · `POST /contas` · `GET /contas/:id` · `PATCH /contas/:id` · `POST /contas/:id/arquivar` · `GET /contas/saldos?em=` | Conta + saldo derivado; `saldo_geral` respeitando `incluir_no_saldo_geral` | Config › Contas, Visão geral |
| `cartoes` | `GET /cartoes` · `POST /cartoes` · `PATCH /cartoes/:id` · `POST /cartoes/:id/arquivar` · `GET /cartoes/:id/faturas` · `GET /faturas/:id` · `GET /faturas/:id/lancamentos` · `POST /faturas/:id/fechar` · `POST /faturas/:id/reabrir` · `POST /faturas/:id/pagamentos` | Cartão com fatura aberta e próxima; fatura como **objeto** com ciclo, estado e total | Cartões, Fatura, Visão geral |
| `categorias` | `GET /categorias` (árvore) · `POST /categorias` · `PATCH /categorias/:id` · `POST /categorias/:id/arquivar` | Árvore de dois níveis com `arquivada_em` | Config › Categorias, Modal de lançamento |
| `etiquetas` | `GET /etiquetas` · `POST /etiquetas` · `PATCH /etiquetas/:id` · `DELETE /etiquetas/:id` | — | Config › Etiquetas, filtros |
| `lancamentos` | `GET /lancamentos` · **`GET /lancamentos/resumo`** · `GET /lancamentos/agenda` · `POST /lancamentos` · `GET /lancamentos/:id` · `PATCH /lancamentos/:id` · `DELETE /lancamentos/:id` · `POST /lancamentos/:id/efetivar` · `POST /lancamentos/:id/desefetivar` · `POST /lancamentos/lote` | Página keyset; resumo do período; agenda (atrasados + próximos) | Lançamentos, Modal, Visão geral, Extrato mobile |
| `transferencias` | `POST /transferencias` · `GET /transferencias/:id` · `DELETE /transferencias/:id` | As duas pernas, sempre juntas | Modal › Transferência, Pagamento de fatura |
| `parcelamentos` | `POST /parcelamentos` · `GET /parcelamentos/:id` · `PATCH /parcelamentos/:id` (só parcelas futuras) · `DELETE /parcelamentos/:id` | Grupo + parcelas + `purchase_date` | Modal › Parcelado |
| `recorrencias` | `GET /recorrencias` · `POST /recorrencias` · `PATCH /recorrencias/:id` · `DELETE /recorrencias/:id` · `GET /recorrencias/:id/ocorrencias?ate=` | Regra + prévia das ocorrências | Modal › Fixo, Planejamento |
| `planejamentos` | `GET /planejamentos?competencia=` · `PUT /planejamentos` (upsert) · `POST /planejamentos/copiar?de=&para=` · `DELETE /planejamentos/:id` | Teto/piso com realizado, previsto e faixa de alerta | Planejamento |
| `objetivos` | `GET /objetivos` · `POST /objetivos` · `PATCH /objetivos/:id` · `POST /objetivos/:id/aportes` · `POST /objetivos/:id/arquivar` | Objetivo + progresso apurado | Objetivos |
| `relatorios` | `GET /relatorios/categorias` · `GET /relatorios/entradas-saidas` · `GET /relatorios/contas` · `GET /relatorios/etiquetas` · `GET /relatorios/evolucao` | Séries agregadas em centavos | Relatórios (4 abas) |
| `importacoes` | `POST /importacoes` (upload) · `GET /importacoes/:id` · `GET /importacoes/:id/brutos` · `POST /importacoes/:id/promover` | Progresso, contagens `criados/atualizados/ignorados`, prévia dos brutos | Importar |
| `conexoes` | `GET /conexoes` · `POST /conexoes` · `POST /conexoes/:id/sincronizar` · `DELETE /conexoes/:id` (revoga consentimento) · `GET /conexoes/:id/sincronizacoes` | Conexão, consentimento e histórico | Conexão bancária (épico 12) |
| `conciliacoes` | `GET /conciliacoes` · `POST /conciliacoes/:id/aceitar` · `POST /conciliacoes/:id/rejeitar` | Sugestões pendentes com motivo | Conciliação |
| `atividades` | `GET /atividades` | Audit log paginado, 90 dias, filtro por conta/categoria/usuário | Config › Atividades |
| `alertas` | `GET /alertas` · `POST /alertas/:id/lido` · `GET /alertas/preferencias` · `PUT /alertas/preferencias` | Notificações e canais | Sino, Config › Alertas |
| `preferencias` | `GET /preferencias` · `PUT /preferencias` | Ordenação, período padrão, saldo diário, **base temporal do cartão** | Config › Preferências |
| `exportacoes` | `POST /exportacoes` · `GET /exportacoes/:id` | Arquivo assinado | Config › Preferências, LGPD |
| `saude` | `GET /saude` · `GET /metricas` | Liveness e Prometheus | Observabilidade |

### 4.2 Onde mora a paginação

**No banco, por keyset (cursor), na chave `(posted_at DESC, id DESC)`.** O cursor é opaco (base64 do par), gerado e validado no módulo `lancamentos`; a forma do envelope (`{ dados, proximo_cursor }`) vive em `contracts/envelope`.

Justificativa: o extrato é profundo e cresce indefinidamente; `OFFSET` degrada linearmente e, pior, **pula ou repete linhas** quando o usuário lança algo enquanto rola — num produto financeiro, "sumiu um lançamento ao rolar" é indistinguível de perda de dado. Keyset é estável sob inserção concorrente e usa exatamente o índice `(tenant_id, posted_at DESC, id DESC)`.

Exceção declarada: listas pequenas e limitadas (contas, cartões, categorias, etiquetas, planejamentos de uma competência) não paginam. `atividades` e `lancamentos_brutos` paginam por keyset. Relatórios não paginam — agregam.

### 4.3 Onde mora o filtro

**No banco, sempre.** Nunca filtrar em JavaScript depois de buscar: com paginação keyset a aplicação nunca tem o conjunto completo, então filtro em memória produziria resultado errado, não apenas lento.

A **gramática** do filtro vive em `packages/contracts/filtro-lancamentos` como um único schema Zod, e corrige a fraqueza 4 do teardown — o Organizze colapsa três eixos ortogonais numa lista linear de 13 opções. Nós separamos:

```ts
zFiltroLancamentos = {
  periodo:    { granularidade: 'dia'|'semana'|'mes'|'personalizado', de, ate },
  natureza:   ('receita' | 'despesa' | 'transferencia')[],      // eixo 1
  situacao:   ('realizado' | 'previsto')[],                     // eixo 2
  estrutura:  ('fixo' | 'parcelado' | 'com_etiqueta')[],        // eixo 3
  contas: uuid[], cartoes: uuid[], categorias: uuid[], etiquetas: uuid[],
  busca: string?, valor_min: centavos?, valor_max: centavos?
}
```

A tradução schema → SQL é uma função só, em `apps/api/src/lancamentos/filtro.ts`. **Localidade:** adicionar uma dimensão de filtro toca dois arquivos (o schema e o tradutor) e ganha tipagem em web e mobile de graça.

### 4.4 Onde mora o rodapé de resumo (realizado × previsto) — decisão

O rodapé do teardown §3 é o coração conceitual do produto:

```
saldo anterior
receita realizada · receita prevista
despesa realizada · despesa prevista
saldo (realizado)
previsto
```

**Decisão: agregação no banco, interpretação no domínio.**

1. **A soma é do banco.** `GET /v1/lancamentos/resumo` executa **uma** consulta com `SUM(valor_centavos)` agrupado por `(natureza × situacao)`, sobre exatamente a mesma cláusula `WHERE` da listagem, mais um `SUM` separado para `saldo_anterior`. Retorna seis a oito `BIGINT`.

```sql
SELECT
  SUM(valor_centavos) FILTER (WHERE valor_centavos > 0 AND status = 'efetivado') AS receita_realizada,
  SUM(valor_centavos) FILTER (WHERE valor_centavos > 0 AND status <> 'efetivado') AS receita_prevista,
  SUM(valor_centavos) FILTER (WHERE valor_centavos < 0 AND status = 'efetivado') AS despesa_realizada,
  SUM(valor_centavos) FILTER (WHERE valor_centavos < 0 AND status <> 'efetivado') AS despesa_prevista
FROM lancamentos
WHERE tenant_id = current_setting('app.tenant_id')::uuid
  AND deleted_at IS NULL
  AND transfer_group_id IS NULL     -- transferência não é receita nem despesa
  AND /* … mesmo predicado da listagem … */;
```

2. **A interpretação é do domínio.** As somas cruas viram `Money` e entram em `domain/saldo.resumoDoPeriodo(baldes, saldoAnterior)`, que decide o que é `saldo` (anterior + realizadas) e o que é `previsto` (saldo + previstas), e devolve um `ResumoPeriodo`. Nenhuma regra de negócio no SQL além do `FILTER`.

3. **`saldo_anterior`** lê `saldo_snapshots` do dia anterior ao início do período quando o snapshot está fresco; cai para a soma derivada quando não está. A escolha é registrada na resposta (`fonte: 'snapshot' | 'derivado'`) para diagnóstico.

**Por que não somar na aplicação.** O rodapé é sobre o **período inteiro**, não sobre a página. Com paginação keyset a aplicação tem 50 linhas de 4 000 — somar em JS daria um número errado. Trazer o período inteiro para memória só para somar é inaceitável num extrato de milhares de linhas numa VPS.

**Por que somar no banco não viola o ADR 0005.** Os valores são `BIGINT` de centavos; `SUM` sobre `BIGINT` é aritmética inteira exata. Não há `NUMERIC` implícito, não há float, não há casting. O que é proibido — e continua proibido — é o SQL **decidir** o que conta como realizado ou aplicar sinal: isso é o `FILTER` explícito acima somado à regra de sinal do domínio, e nada mais.

**A garantia contra divergência.** `GET /lancamentos` e `GET /lancamentos/resumo` aceitam o **mesmo objeto Zod** de filtro e chamam o **mesmo tradutor** `filtro.ts`. Um teste de S2 fixa isso: para um conjunto gerado de lançamentos, somar todas as páginas da listagem tem de dar exatamente o resumo. Se alguém adicionar um filtro só num dos dois lados, esse teste quebra.

---

## 5. Jobs e filas

BullMQ sobre Redis. Um processo worker (`ROLE=worker`) separado do HTTP, ambos do mesmo código. Três filas, porque a VPS é uma só:

| Fila | Concorrência | Conteúdo |
|---|---|---|
| `interativa` | 4 | Usuário esperando: promover brutos, conciliar, OCR |
| `manutencao` | 2 | Saldo, recorrência, fatura, retenção |
| `externa` | 1 | Sincronização e envio de notificação — com rate limit e backoff |

**Regra geral:** todo processador é uma função pública do módulo dono (2.4), recebe `deps` explícitas e retorna `Result`. Todo job roda sob `mavia_jobs`, com `SET LOCAL app.tenant_id` por tenant. Nenhum job usa `BYPASSRLS`.

### 5.1 `outbox.publicar` — o job que sustenta os outros

Redis não participa do commit do Postgres. Enfileirar dentro da transação é impossível; enfileirar depois perde eventos se o processo cair no intervalo.

- **Gatilho:** poller a cada 1 s sobre `outbox WHERE publicado_em IS NULL`.
- **Idempotência:** `jobId = outbox:${id}` — o BullMQ recusa o duplicado; `UPDATE outbox SET publicado_em = now() WHERE id = $1 AND publicado_em IS NULL RETURNING id` reivindica a linha.
- **Duas vezes:** a segunda execução não reivindica nada. E como todos os consumidores abaixo já são idempotentes, uma entrega dupla também seria inofensiva — defesa em profundidade.

### 5.2 Os jobs

| Job | Gatilho | Idempotência | Se rodar duas vezes |
|---|---|---|---|
| `saldo.materializar` | Evento de outbox `lancamento.*`, com debounce por `(tenant, conta)` | `INSERT … ON CONFLICT (tenant_id, conta_id, dia) DO UPDATE`; recalcula do dia afetado em diante a partir dos lançamentos | Mesmo valor gravado. Função do estado, não do delta — por isso é seguro |
| `saldo.reconciliar` | Cron 03:10 `America/Sao_Paulo`; e após cada `importacao.concluida` | Recalcula o derivado e compara com o snapshot; a escrita é o mesmo upsert de cima | Idêntico. **Divergência é incidente:** grava em `auditoria` com o delta, emite `mavia_saldo_divergencia_centavos`, alerta o operador, e só então corrige o cache. Nunca corrige em silêncio (regra 5) |
| `recorrencia.materializar` | Cron 02:00; e ao criar/editar recorrência | `UNIQUE (tenant_id, recorrencia_id, recorrencia_ocorrencia_em)` + `ON CONFLICT DO NOTHING`; `materializado_ate` só avança | Zero linhas novas. Horizonte de 12 meses. **Nunca** toca ocorrência já `efetivado` nem com `editado_manualmente = true` — editar a regra não reescreve o passado |
| `fatura.fechar` | Cron horária | Transição condicional `UPDATE faturas SET estado='fechada' … WHERE estado='aberta' AND data_fechamento <= $hoje`; a próxima fatura entra por `UNIQUE (tenant_id, cartao_id, periodo_inicio)` | A segunda execução não encontra fatura `aberta` naquele ciclo: no-op. Congela `total_centavos` (3.7) e abre o ciclo seguinte |
| `fatura.marcar_vencida` | Cron diária 00:30 | Transição condicional a partir de `fechada`/`parcialmente_paga` | No-op |
| `sync.executar` | Cron por conexão (até 6×/dia) · `POST /conexoes/:id/sincronizar` · upload de arquivo | Dupla: (a) `jobId = sync:${conexao_id}:${janela}` impede enfileirar duas; (b) `UNIQUE (tenant_id, provider, external_id)` e `(tenant_id, provider, conteudo_hash)` em `lancamentos_brutos` com `ON CONFLICT DO NOTHING` | `ignorados` sobe, `criados` fica zero. **Reimportar o mesmo OFX não duplica nada** (regra 13). O contador vai para `sincronizacoes` e aparece na tela |
| `ingestao.promover` | Outbox `sincronizacao.concluida`; ou `POST /importacoes/:id/promover` | `UNIQUE (tenant_id, lancamento_bruto_id)` em `lancamentos`; o bruto vai a `promovido` na mesma transação | Nenhum `Lancamento` novo |
| `conciliacao.sugerir` | Outbox `bruto.promovido` | `UNIQUE (tenant_id, lancamento_bruto_id, lancamento_id)`; o job **nunca escreve em `lancamentos`** | Mesma sugestão, nenhuma sobrescrita. Conciliação é sugestão, não sobrescrita (regra 15) |
| `categorizacao.aplicar` | Outbox `lancamento.criado` sem categoria | Guarda: só age se `categoria_id IS NULL AND origem <> 'manual' AND editado_manualmente = false`; grava o `motivo` | A segunda execução não encontra candidato. Sempre reversível, motivo sempre visível |
| `alertas.avaliar` | Cron 07:00; e outbox `lancamento.*` para vencimento imediato | `chave_dedup = hash(tipo, entidade_id, competencia_ou_dia, faixa_pct)` com `UNIQUE (tenant_id, chave_dedup)` | Nenhuma notificação duplicada. Avalia: faixas de `planejamentos`, contas a pagar (D-3, D-0, atrasadas), fatura fechando e vencendo, saldo projetado negativo |
| `notificacao.enviar` | Consome `notificacoes` com `agendado_para <= now() AND enviado_em IS NULL` | Reivindicação por `UPDATE … SET enviado_em = now() WHERE id = $1 AND enviado_em IS NULL RETURNING` | A segunda não reivindica. Transporte é at-least-once; a dedup está na tabela. Falha externa → backoff exponencial, 5 tentativas, depois `dead-letter` visível em métrica |
| `exportacao.gerar` | `POST /exportacoes` | Chave = `exportacao_id`; sobrescreve o mesmo objeto no storage | Mesmo arquivo. Idempotente por construção |
| `retencao.aplicar` | Cron diária 04:00; e outbox `consentimento.revogado` | Declarativo: converge para o estado alvo (sync interrompida, brutos além do prazo purgados, conexão marcada `revogada`) | Já convergido: no-op |
| `anexo.ocr` | Outbox `anexo.criado` | Chave = `anexo_id`; resultado gravado uma vez | Mesmo resultado. Sugere, nunca preenche sozinho um valor monetário sem confirmação |

### 5.3 Onde os jobs são testados

Em **S2**, sem seam novo: o teste cria estado por HTTP, chama a função do processador **duas vezes** com o Postgres real, e verifica por HTTP. A fila não participa. É o seam mais alto que ainda observa o comportamento "rodar duas vezes não muda nada".

---

## 6. Mapa tela → endpoint

Serve para achar chamada faltando e endpoint órfão. Cada linha da coluna "Endpoints" é o conjunto **completo** que a tela consome.

### 6.1 Web

| Tela | Endpoints |
|---|---|
| Login / Cadastro | `POST /auth/entrar` · `POST /auth/registrar` · `POST /auth/senha/recuperar` |
| Onboarding | `GET /auth/eu` · `POST /contas` · `GET /categorias` · `PUT /preferencias` |
| **Visão geral** (dashboard) | `GET /contas/saldos?em=hoje` · `GET /lancamentos/resumo?periodo=mes` · `GET /lancamentos/agenda` · `GET /cartoes` · `GET /relatorios/categorias?periodo=mes&limite=5` · `GET /planejamentos?competencia=` · `GET /alertas` |
| **Lançamentos** (extrato) | `GET /lancamentos` (keyset) · **`GET /lancamentos/resumo`** (rodapé) · `GET /contas` · `GET /cartoes` · `GET /categorias` · `GET /etiquetas` · `POST /lancamentos/lote` (seleção em massa) · `POST /lancamentos/:id/efetivar` |
| Modal de lançamento | `POST /lancamentos` · `PATCH /lancamentos/:id` · `POST /transferencias` · `POST /parcelamentos` · `POST /recorrencias` · `GET /categorias` · `GET /etiquetas` · `POST /anexos` · `GET /inteligencia/sugerir-categoria` (selo IA) |
| Cartões | `GET /cartoes` · `GET /cartoes/:id/faturas` |
| **Fatura** | `GET /faturas/:id` · `GET /faturas/:id/lancamentos` · `POST /faturas/:id/pagamentos` · `POST /faturas/:id/fechar` · `POST /faturas/:id/reabrir` |
| Relatórios › Categorias | `GET /relatorios/categorias?base=` · `GET /preferencias` (base temporal padrão) |
| Relatórios › Entradas × Saídas | `GET /relatorios/entradas-saidas?agregacao=&incluir_previsto=` |
| Relatórios › Contas | `GET /relatorios/contas` |
| Relatórios › Etiquetas | `GET /relatorios/etiquetas` |
| **Planejamento** (teto + piso) | `GET /planejamentos?competencia=` · `PUT /planejamentos` · `POST /planejamentos/copiar` · `GET /categorias` |
| Objetivos | `GET /objetivos` · `POST /objetivos` · `PATCH /objetivos/:id` · `POST /objetivos/:id/aportes` |
| Importar | `POST /importacoes` · `GET /importacoes/:id` · `GET /importacoes/:id/brutos` · `POST /importacoes/:id/promover` |
| Conciliação | `GET /conciliacoes` · `POST /conciliacoes/:id/aceitar` · `POST /conciliacoes/:id/rejeitar` |
| Conexão bancária | `GET /conexoes` · `POST /conexoes` · `POST /conexoes/:id/sincronizar` · `DELETE /conexoes/:id` · `GET /conexoes/:id/sincronizacoes` |
| Config › Categorias | `GET /categorias` · `POST /categorias` · `PATCH /categorias/:id` · `POST /categorias/:id/arquivar` |
| Config › Contas | `GET /contas` · `POST /contas` · `PATCH /contas/:id` · `POST /contas/:id/arquivar` |
| Config › Cartões | `GET /cartoes` · `POST /cartoes` · `PATCH /cartoes/:id` |
| Config › Etiquetas | `GET /etiquetas` · `POST /etiquetas` · `PATCH /etiquetas/:id` |
| Config › Preferências | `GET /preferencias` · `PUT /preferencias` · `POST /exportacoes` |
| Config › Alertas | `GET /alertas/preferencias` · `PUT /alertas/preferencias` |
| Config › Atividades | `GET /atividades` · `GET /contas` · `GET /categorias` (filtros) |
| Config › Membros | `GET /tenants/:id/membros` · `POST /tenants/:id/convites` · `PATCH /tenants/:id/membros/:usuarioId` |
| Sino (notificações) | `GET /alertas` · `POST /alertas/:id/lido` |

### 6.2 Mobile

| Tela | Endpoints |
|---|---|
| Login + biometria | `POST /auth/entrar` · `POST /auth/refresh` |
| Lançamento rápido | `POST /lancamentos` (com fila offline) · `GET /categorias` (cache local) · `GET /contas` (cache local) |
| Extrato | `GET /lancamentos` · `GET /lancamentos/resumo` |
| Visão geral | `GET /contas/saldos` · `GET /lancamentos/agenda` |
| Fatura | `GET /cartoes/:id/faturas` · `GET /faturas/:id` |
| Sincronização | `POST /sync/mutacoes` (lote da fila local) · `GET /sync/mudancas?desde=` |

### 6.3 Achados do mapa

- **`POST /sync/mutacoes` e `GET /sync/mudancas` são endpoints exclusivos do mobile** e não aparecem em 4.1 — são o transporte do `PlanoDeSync` de `domain/sincronizacao-offline`. Precisam entrar em `contracts` no épico 5.
- **`GET /inteligencia/sugerir-categoria`** é consumido pelo modal (selo IA do teardown §4) e ainda não tem grupo em 4.1. Entra no épico 7.
- **Endpoints sem tela no MVP:** `objetivos`, `tenants/:id/membros`, `conexoes`, `exportacoes`. São dos épicos 8, 10, 12 e da LGPD — declarados aqui para que não sejam confundidos com órfãos.
- **Sem endpoint órfão de negócio.** Todo endpoint de 4.1 tem consumidor identificado ou épico declarado.

---

## 7. Decisões que exigem ADR

Cada uma é durável e cara de reverter. As marcadas com ✅ **já foram escritas** pelo `arquiteto-dominio-financeiro` — a numeração desta tabela foi ajustada para não colidir com elas. O 0009 está reservado para o objetivo de acúmulo. As demais continuam listadas, não escritas.

| # sugerido | Decisão | Por que merece ADR |
|---|---|---|
| **0008** ✅ | `Planejamento` unifica Limite de gastos e meta de receita mensal. **Sem coluna `natureza`** — o sinal do `valor` carrega a direção (negativo = teto, positivo = piso), conforme decidido no ADR 0008 escrito. `Meta` foi aposentada; o acúmulo virou `Objetivo` (ADR 0009) | Muda o glossário: `CONTEXT.md` hoje define `Limite (Budget)` e `Meta` de forma que colide com o achado do teardown 8.2. Nome no código = nome no glossário — a colisão precisa ser resolvida antes de virar tabela |
| **0007** ✅ | Base temporal do cartão (`data_fatura` / `data_compra` / `data_parcela`) é parâmetro de primeira classe de todo relatório, e `parcelamentos.purchase_date` é obrigatória | É a decisão que mais muda o número na tela; o Organizze a esconde num link de canto. Adicionar `purchase_date` depois de existirem parcelamentos de clientes é uma migration com dado impossível de reconstituir |
| 0010 | O resumo do período é agregado em `BIGINT` no banco e interpretado em `packages/domain`; listagem e resumo compartilham o mesmo schema de filtro | Toca diretamente o ADR 0005 (aritmética monetária) e é a fonte mais provável de divergência silenciosa entre o que a lista mostra e o que o rodapé soma |
| 0011 | Paginação keyset por `(posted_at, id)` no extrato e nas atividades | Escolha que amarra índice, contrato e UI; trocar depois quebra clientes e o índice principal |
| 0012 | Transactional outbox entre Postgres e BullMQ | Sem ela, todo evento de domínio tem uma janela de perda entre commit e enfileiramento. Afeta a forma de **toda** escrita financeira |
| 0013 | Fatura `fechada` é imutável; reabertura é operação explícita, restrita a `proprietario` e auditada | Define o que acontece com lançamento retroativo — a pergunta que aparece na primeira semana de uso real e cuja resposta ad hoc corrompe histórico |
| 0014 | Processador de job é função pública do módulo; a fila só registra | É a decisão que evita um seam novo (2.4a). Precisa estar escrita, ou a primeira sessão que usa `@Processor()` do NestJS a desfaz |
| 0015 | Política de conflito offline é pura e mora em `packages/domain`; o executor do app é plumbing | Evita o segundo seam novo (2.4b) e impede regra de negócio em `apps/mobile` |
| 0016 | Papéis de banco `mavia_app` / `mavia_jobs` / `mavia_migrate`, nenhum com `BYPASSRLS` fora de migration; `SET LOCAL` por transação | Complementa o ADR 0004 com o **como**. Errar aqui é vazamento entre clientes, e falha em silêncio |
| 0017 | `packages/ui` importa apenas `packages/domain`, nunca `packages/contracts` | Fronteira de pacote; sem registro, a primeira sessão que precisa de um tipo de resposta acopla o design system à versão da API |
| 0018 | Envelope encryption de credenciais de `Conexao`: DEK por conexão, KEK fora do banco, rotação declarada | Regra 19 diz *o quê*; falta o *como*, incluindo o que acontece na rotação e no backup |
| 0019 | Identificadores de tabela de negócio são UUID v4 (não sequenciais, não v7) | ADR 0004 exige "não sequencial"; v7 é ordenado por tempo e vaza ordem de criação. A escolha tem custo de localidade de escrita que precisa estar registrado como aceito |

---

## 8. Vetos declarados

Exercidos agora, para não serem re-litigados em code review:

1. ~~**Não codificar `Limite`/`Meta` como estão em `CONTEXT.md`.**~~ **RESOLVIDO em 2026-09-01.** `Planejamento` (ADR 0008) absorve o teto de despesa e o piso de receita mensais; `Objetivo` (ADR 0009) é o acúmulo plurimensal. `Meta` está na tabela de termos proibidos do `CONTEXT.md`. Nenhuma tabela ou rota deve usar o nome.
2. **Nenhuma soma monetária em `NUMERIC`, `float` ou casting implícito no SQL.** `SUM` sobre `BIGINT` de centavos, ou nada.
3. **Nenhum cálculo de rodapé sobre a página corrente em JavaScript.** O resumo é do período, a página não é o período.
4. **Nenhum seam novo em repositório Drizzle, serviço NestJS interno ou componente isolado de `packages/ui`.** Lista fechada de seis seams (2.2); ampliar exige ADR.
5. **Nenhum papel de banco que atende requisição ou job com `BYPASSRLS`.**
6. **`Conta` tem `tipo`.** Não copiar a fraqueza 2 do Organizze — sem tipo, investimento e dinheiro em espécie não se separam em relatório, e a migration para adicioná-lo depois exige adivinhar o tipo de contas existentes.
7. **`packages/ui` não importa `packages/contracts`, e nenhum `packages/*` importa `apps/*`.** Imposto por lint no CI, não por revisão.
8. **Regra de ciclo de fatura, sinal, rateio ou fuso em `apps/`.** Chamar `domain` do cliente é correto; reimplementar não é.
