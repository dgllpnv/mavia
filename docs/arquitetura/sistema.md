# Arquitetura de sistema — Mavia

- **Data:** 2026-09-01
- **Revisão:** 3 — absorve os conceitos introduzidos pelo `arquiteto-dominio-financeiro` em `CONTEXT.md` e nos ADRs 0007–0009 (revisão 2 corrigiu os bloqueios do gate de risco)
- **Autor:** `arquiteto-solucao`
- **Status:** Normativo. Contradizer este documento exige ADR nova.
- **Insumos:** `CLAUDE.md` (1, 2, 6, 7) · `CONTEXT.md` · ADRs 0001–0009 · `docs/pesquisa/organizze-teardown.md` · `docs/produto/arquitetura-informacao.md` · `docs/pipeline.md`

Este documento fixa: as fronteiras de módulo, **onde os testes moram**, o modelo de dados, a superfície de API, os jobs e o mapa tela → endpoint. A seção 2 é o produto principal — as outras existem para sustentá-la.

Vocabulário usado com precisão: **módulo** (unidade com fronteira), **interface** (o que o resto do sistema pode nomear), **implementação** (o que está atrás), **profundidade** (razão comportamento/interface), **seam** (superfície observável onde o teste se prende), **adapter** (implementação concreta de um seam), **alavancagem** (quanto o módulo poupa aos chamadores), **localidade** (quantos arquivos uma mudança toca).

---

## 0. Rastreabilidade da revisão 2

Onde cada bloqueio do gate foi respondido **neste** documento. Bloqueios cuja correção mora em `CLAUDE.md`, `CONTEXT.md` ou nos ADRs 0005/0007/0008/0009 não estão aqui — estão listados em §9 como dependência externa.

| ID | Bloqueio | Respondido em |
|---|---|---|
| **B1** | Rodapé sem balde de transferência | §4.4, §1.1 (`domain/agregacao`) |
| **B2** | Coluna temporal do filtro não declarada | §3.7 (eixo), §4.3, §4.4 |
| **B3** | Fuso de `saldo_snapshots.dia` não declarado | §3.6, §3.7 |
| **B4** | Compra de cartão nasce `efetivado` | §3.3 (`settled_at`) |
| **B5** | `faturas.periodo_inicio/fim` como `DATE` | §3.4 |
| **B8** | Perna de crédito do pagamento zera a fatura | §3.3 (`CHECK`), §3.4, §3.7 |
| **B11** | `R$ 0,01 em 3x` viola `CHECK (valor_centavos <> 0)` | §3.4 (recusa na borda) |
| **B12** | Sinal de `parcelamentos.valor_total_centavos` | §3.4 |
| **B15** | `copiar` planejamento com global (`NULL = NULL`) | §3.4, §3.8, §4.1 |
| **B17** | Exclusão de transferência ausente em 5 relatórios | §1.4 (`agregacao`), §4.3, §4.4, §2.3 |
| **B18** | Excluir uma perna de `Transferencia` | §3.4, §4.1 |
| **B19** | Multi-moeda sem câmbio | §3.2 (`CHECK` de moeda única) |
| **B20** | Nenhum job avalia `Objetivo` | §5.2 (`objetivo.avaliar`) |
| **B22** | Fronteira do período não declarada | §3.7 |
| **R1, R2** | `incluir_no_saldo_geral` e caixa × dívida no rodapé | §4.4 (escopo do rodapé) |
| **R13** | Soma-zero das pernas exige `CONSTRAINT TRIGGER` | §3.4 |
| **A-01** | Poller do `outbox` contradiz o veto de `BYPASSRLS` | §3.6, §3.8, §3.9, §5.1 |
| **A-02** | `sessoes`, `usuarios`, `outbox` sem policy | §3.9 |
| **A-03** | Resolução de `X-Mavia-Tenant` | §3.9 (as quatro etapas) |
| **A-05** | Worker enumera todos os tenants | §3.9 (view `tenants_ativos`) |
| **A-06** | Unicidade de idempotência sob soft delete | §3.8 |
| **A-07** | `/metricas` público com centavos | §4.1, §5.2 |
| **A-08, A-09, A-10** | Cursor forjável e oráculo de existência | §4.2 |
| **A-12** | Matriz de autorização inexistente | §4.0 (referência normativa + guard) |
| **A-19** | IDOR de tenant em `/tenants/:id/*` | §4.1 (o `:id` sai da rota) |
| **A-21** | `POST /lancamentos/lote` sem teto | §4.1 |
| **A-22** | Endpoints caros sem teto de janela | §4.1, §4.3 |
| **A-23** | `DELETE` sobre uma perna | §4.1, §3.4 |
| **A-25** | `payload` cru em resposta de API | §4.1 (allowlist) — com objeção em §10 |
| **A-27** | IDOR intra-tenant (`notificacoes`, `preferencias`) | §3.9, §4.0 |
| **A-28** | `POST /exportacoes` como exfiltração | §4.1, §5.2 |
| **A-29, A-30, A-31, A-40** | Endpoints sem contrato | §4.1 (grupos novos), §6.3 |
| **A-32, A-33, A-34** | Upload hostil, XXE, parser junto da KEK | §1.4 (papel `parser`), §4.1, §5.3 |
| **A-35** | CSV injection | §1.4 (`arquivos/csv.ts`) |
| **A-37** | Colunas de envelope encryption | §3.5 (colunas) — ADR 0018 é de terceiro |

### 0.1 Absorção da revisão 3

Conceitos que vieram do glossário e dos ADRs 0007–0009 depois da revisão 2, e o que cada um mudou aqui.

| Conceito | Fonte | Mudou |
|---|---|---|
| `Estorno` | `CONTEXT.md` | §3.3 (coluna real, não mais reservada), §3.8 (índice), §3.7 e §4.4 (par original+estorno soma zero e não infla realizado nem fatura), §5.2 |
| `razaoEmBp` / `consumo_bp` | `CONTEXT.md`, ADR 0008 | §1.1 (o value object `Razao` vira a função `razaoEmBp`), §4.1 (contrato de `planejamentos`), §2.3 |
| `Categoria.analitica` | `CONTEXT.md`, ADR 0008 | §3.2 (substitui o meu `excluir_de_totais`), §4.3, §4.4 |
| `categoria_id` obrigatório | ADR 0008 | §3.3 (`CHECK`), §4.4 (a partição por natureza passa a ser total) |
| Partição por `Categoria.natureza`, não por sinal | ADR 0008 | §4.4 — muda os predicados dos baldes |
| `Realizado` = `efetivado` + `pendente`; `Saldo` = só `efetivado` | `CONTEXT.md` | §4.4 (identidades separadas por eixo), §3.7 |
| `Janela` semiaberta `[inicio, fim)` **sem exceção** | `CONTEXT.md` | §3.4 e §3.7 — **revoga** a convenção dupla da revisão 2 |
| `Data civil` sempre em `America/Sao_Paulo` | `CONTEXT.md` | §3.1, §3.6 (`dia` → `data_civil`), §3.7 |
| Identidade de ocorrência de `Recorrencia` pela **competência** | `CONTEXT.md` | §3.4 e §3.8 — **remove** o `regra_versao` que eu havia inventado |
| Identidade de `Planejamento` e índices parciais | ADR 0008 | §3.4 (`natureza` deixa de ser coluna), §3.8 |
| `Tag` no código, "Etiqueta" na UI | `CONTEXT.md` | §3.2, §3.8, §4.1, §6.1 |
| **B4 resolvido:** `settled_at` adotado, `effective_at` aposentado, previsão **não** persistida | Decisão do `arquiteto-dominio-financeiro` | §3.3 (uma coluna temporal só, `status` derivado), §3.7 (o eixo caixa muda de fonte), §3.8 (índices), §1.1 e §4.4 (`agregacao` compõe duas fontes) |

**Sobre o B4.** Eu havia proposto `effective_at NOT NULL` como previsão persistida ao lado de `settled_at`, argumentando que derivar a previsão faria todo cálculo do eixo caixa pagar um join com `faturas`. O argumento foi enfrentado e desmontado: **lançamento de cartão não pertence ao eixo caixa.** Uma compra não tira dinheiro de conta nenhuma — quem tira é a `Fatura`. A coluna existia para ordenar cartão num eixo em que ele não deve estar, e ali ela estaria *errada* além de cara: o lançamento não tem `conta_id`, precisaria de um segundo join pelo cartão para chegar a uma conta, e daria a conta errada sempre que a fatura fosse paga por outra. O eixo caixa passa a agregar `Fatura` — **uma linha por ciclo em vez de N, sem join em `lancamentos`**. O join não foi assumido: desapareceu. A distinção fato × previsão que eu defendia continua de pé; a previsão mudou de casa.

---

## 1. Fronteiras e regra de dependência

```
packages/domain      → não importa nada (nem Node, nem Zod, nem Date global)
packages/contracts   → importa domain
packages/ui          → importa domain          (ver 1.3)
apps/api             → importa domain + contracts
apps/web             → importa domain + contracts + ui
apps/mobile          → importa domain + contracts + ui
infra/               → não é importado por ninguém
```

Nunca o inverso. Nunca app → app. Nunca `packages/*` → `apps/*`.

`packages/ui` importa **apenas** `packages/domain`, não `packages/contracts`. Um componente recebe props já modeladas (`{ valor: Money, rotulo: string }`), nunca um DTO de resposta. Motivo: o design system não pode versionar junto com a API.

**Onde a regra é imposta:** `eslint-plugin-boundaries` no CI. Violação reprova o build, não o code review.

### 1.1 `packages/domain` — o coração puro

Zero I/O, zero framework, relógio injetado. Todo módulo retorna `Result<T, DomainError>`; exceção só na borda HTTP.

| Módulo | Propósito | Interface pública | Depende de | Profundidade |
|---|---|---|---|---|
| `resultado` | `Result<T,E>`, `DomainError` | `ok`, `err`, `map`, `andThen`, `unwrapOr` | — | Rasa por desenho (é vocabulário) |
| `relogio` | Porta do tempo | `Clock { agora(): Instant }`, `RelogioFixo` | — | Rasa, deliberada |
| `money` | Aritmética monetária exata | `Money.deCentavos(bigint, Moeda)`, `somar`, `subtrair`, `negar`, `abs`, `ratear(n \| pesos[])`, `comparar`, `ehZero`, `centavos`, `moeda`, `formatar(locale)` | `resultado` | **Profunda** |
| `razao` | A **única** grandeza fracionária do domínio, e ela é inteira | `razaoEmBp(a: Money, b: Money): Result<bigint>` · `atingiu(consumoBp, pct): boolean` · `formatarPercentual(consumoBp): string` | `money` | Rasa de propósito — três funções, nenhum estado. A revisão 2 tinha um value object `Razao`; o glossário define `razaoEmBp` como função e **está certo**: o wrapper era interface maior que a implementação, exatamente o módulo raso que o `/codebase-design` proíbe. `Money` não ganha divisão que devolva `Money` |
| `periodo` | Granularidade, navegação, fuso, `Janela` e `Data civil` | `Periodo.de(granularidade, ancora)`, `anterior`, `proximo`, `janela(): [Instant, Instant)`, `dataCivil(instant): DataCivil`, `inicioDoDiaCivil(data): Instant`, `competenciaDe(instant): Competencia` | `relogio` | **Profunda.** Absorve UTC ↔ `America/Sao_Paulo`, horário de verão, mês com 28/31 dias. **Uma convenção de janela só, `[inicio, fim)`, sem exceção** — inclusive a da fatura (§3.7) |
| `lancamento` | O átomo: sinal, status, invariantes | `criarDespesa`, `criarReceita`, `agendar`, `compensar`, `aplicarEdicao`, `Lancamento` | `money`, `periodo` | Média |
| `transferencia` | Partida dobrada | `criarTransferencia(origem, destino, valor, quando, tipo): Result<[Lancamento, Lancamento]>`, `ehPerna(l)`, `somaDasPernas(pernas)` | `lancamento`, `money` | **Profunda** |
| `parcelamento` | Compra em N parcelas | `parcelar(total, n, compraEm, ciclo): Result<Parcela[]>` | `money`, `fatura`, `periodo` | **Profunda** |
| `fatura` | Ciclo de cobrança do cartão | `janelaDaFatura(cartao, postedAt, tz): CicloFatura`, `faturaAlvo`, `proximoCiclo`, `transicao(estado, evento)` | `periodo`, `money` | **Profunda** |
| `agregacao` | **Os baldes monetários e o que entra em cada um** | `Balde` (enum fechado), `resumoDoPeriodo(baldes, saldoAnterior, eixo, escopo): ResumoPeriodo`, `composicaoDaFatura(baldes): ComposicaoFatura`, `identidadeDoResumo(r): boolean` | `money` | **Profunda.** Ver §4.4. Sabe três coisas que ninguém mais precisa saber: perna de `Transferencia` e `Categoria` não analítica ficam fora de todo total; a partição é por `Categoria.natureza`, nunca pelo sinal; e um `Estorno` é uma linha comum na natureza da categoria do original, que reduz o total por soma, não por regra especial |
| `estorno` | Desfazer sem editar o original | `estornar(original, valor, quando): Result<Lancamento>`, `estornadoAcumulado(original, estornos): Money`, `competenciaDoEstorno(estorno, grupo, base): Competencia` | `lancamento`, `money`, `fatura` | **Profunda.** Guarda três regras não óbvias: sinal oposto e mesma categoria; `\|estorno\| <= \|original\|` somado aos anteriores; e, sob a base `data_compra`, o estorno de parcelada é atribuído à `data_compra` do **grupo estornado**, não à sua própria (ADR 0007) |
| `saldo` | Derivação e projeção | `saldoDerivado(saldoInicial, lancamentos, eixo): Money` · `projetar(saldoAtual, lancamentosNaoCompensados, faturasEmAberto, ate): Money` | `money`, `lancamento`, `fatura`, `periodo` | **Profunda.** `projetar` recebe **duas** listas e as compõe sem dupla contagem: uma `Fatura` contribui com o **saldo devedor** até estar `paga`; a partir daí quem representa a saída é a perna de débito, que já está na primeira lista |
| `recorrencia` | Regra que gera ocorrências | `ocorrenciasEntre(regra, de, ate)`, `proximaOcorrencia`, `validarRegra` | `periodo` | Profunda |
| `planejamento` | Teto de despesa e piso de receita | `avaliar(planejamento, realizado, projetado): StatusPlanejamento` — devolve `consumo_bp: bigint`, `dentro_do_plano`, e o estado `dentro \| no_limite \| estourado` · `faixasCruzadas(consumoBp, pcts)` · `naturezaDe(valor)` | `money`, `razao`, `periodo` | Média. `natureza` é **derivada** do sinal de `valor`, nunca persistida |
| `objetivo` | Acúmulo plurimensal (ADR 0009) | `progresso(objetivo, saldoAtual): ProgressoObjetivo`, `travessiaDeConclusao(antes, depois): boolean` | `money`, `periodo` | Média |
| `ingestao` | Normalização e idempotência de dado externo | `chaveIdempotencia(bruto)`, `hashConteudo(bruto)`, `normalizar(bruto)` | `money`, `periodo` | **Profunda** |
| `conciliacao` | Casamento importado × manual | `sugerir(brutos, candidatos, politica)`, `pontuar` | `money`, `periodo` | **Profunda** |
| `categorizacao` | Escolha de categoria por regra | `aplicarRegras(lancamento, regras)`, `Regra`, `Motivo` | `lancamento` | Média |
| `sincronizacao-offline` | Política de conflito do mobile | `planejarSincronizacao(mutacoesLocais, estadoServidor, clock): PlanoDeSync` | `lancamento`, `relogio` | **Profunda.** Ver §2.4 |
| `politica-acesso` | Papel → permissão | `pode(papel, acao, recurso): boolean` | — | Rasa, localidade alta. A **tabela** vem de `docs/arquitetura/autorizacao.md` |

**Módulos novos nesta revisão:** `razao` (auditoria §4.3, B13) e `agregacao` (B1, B17). Ambos existem para retirar aritmética de fora do domínio, não para adicionar camada.

### 1.2 `packages/contracts` — a fonte única da API

Schemas Zod que geram tipos TypeScript **e** o OpenAPI. Importa `domain` para tipos de marca.

| Módulo | Interface pública | Nota |
|---|---|---|
| `primitivos` | `zMoney` (string de centavos + moeda), `zInstant`, `zDataCivil`, `zUuid`, `zCompetencia` | `bigint` viaja como **string** (ADR 0005) |
| `envelope` | `zPagina<T>`, `zCursor`, `zErro` | `zCursor` valida MAC e payload antes do SQL — §4.2 |
| `filtro-lancamentos` | `zFiltroBase`, `zFiltroListagem`, **`zFiltroAgregacao`** | Ver §4.3. `zFiltroAgregacao` **não possui** opção de incluir perna de transferência em balde de receita ou despesa |
| Um arquivo por recurso | `zCriarX`, `zAtualizarX`, `zXResposta`, `zListarXQuery` | Nome do schema = nome da rota = nome da tela |

**Regra de resposta (A-25, A-38):** todo `zXResposta` é **allowlist**. Campo de credencial e campo de payload bruto não existem no schema de resposta; um teste de S4 falha se aparecerem.

### 1.3 `packages/ui` — o design system

Tokens (ADR 0006) e primitivos. Importa apenas `domain`.

| Módulo | Interface pública |
|---|---|
| `tokens` | Escalas de tipo, cor, espaço, raio, elevação, em formato neutro |
| `valor` | `<ValorMonetario money align sinal />` — `tabular-nums` obrigatório |
| `lista` | `<Linha />`, `<GrupoPorDia />`, `<RodapeResumo />` |
| `periodo` | `<NavegadorDePeriodo />` |
| `entrada` | `<CampoValor />` (emite centavos), `<SeletorCategoria />`, `<ToggleSituacao />` |
| `grafico` | `<Rosca />`, `<Barras />`, `<Linha />` — paleta de dados separada da cor de marca |
| `estado` | `<Vazio />`, `<Carregando />`, `<Erro />` |

Nenhum componente faz fetch, conhece rota ou importa `contracts`.

### 1.4 `apps/api` — módulos e papéis de processo

**Três papéis de processo, mesmo código, `ROLE` diferente** — mudança desta revisão, exigida por A-34:

| Papel | Executa | Tem acesso a |
|---|---|---|
| `http` | Fastify, requisições | Banco (`mavia_app`), Redis |
| `worker` | Jobs das filas `interativa`, `manutencao`, `externa` | Banco (`mavia_jobs`), Redis, **serviço de KEK** |
| `parser` | **Só** o parsing de arquivo enviado por usuário | Nada. Sem rede, sem segredo, sem `DATABASE_URL` |

O papel `parser` existe porque o `worker` desembrulha DEKs e usa credenciais bancárias, e OFX/PDF/imagem são as entradas mais hostis do produto. **Nenhum processo que manipula DEK executa parsing de arquivo de usuário.** Ver §5.3.

| Módulo | Propósito | Interface pública | Depende de |
|---|---|---|---|
| `tenancy` | Contexto de tenant e sessão RLS | `resolverContexto(token, header)`, `withTenant(tenantId, usuarioId, fn)`, `TenantContext.atual()`, `unidadeDeTrabalho(fn)` | Drizzle, `domain/politica-acesso` |
| `auth` | Identidade, sessão, MFA, papéis | `autenticar`, `emitirTokens`, `rotacionarRefresh`, `revogarFamilia`, `exigirPapel`, `exigirReautenticacao` | `tenancy` |
| `agregacao` | **O tradutor único de toda soma monetária** | `agregar(filtro: FiltroAgregacao, baldes: Balde[]): SomasPorBalde` · `sqlDoFiltro(filtro): SQL` · `fontesDoEixoCaixa(filtro): { lancamentosDeConta, faturasEmAberto }` | `tenancy`, `domain/agregacao`, `domain/saldo` |
| `contas` | CRUD de Conta | `criarConta`, `atualizarConta`, `arquivarConta`, `listarContas`, `saldoDeContas(em, eixo)` | `tenancy`, `saldos` |
| `cartoes` | CRUD de Cartao + Fatura | `criarCartao`, `listarFaturas`, `obterFatura`, `fecharFatura`, `reabrirFatura`, `registrarPagamentoDeFatura` | `tenancy`, `domain/fatura`, `lancamentos` |
| `categorias` | Árvore de dois níveis | `criarCategoria`, `arquivarCategoria`, `arvore()` | `tenancy` |
| `tags` | Classificação transversal ("Etiqueta" na UI) | `criarTag`, `aplicar`, `listar` | `tenancy` |
| `lancamentos` | Escrita do átomo — inclui transferência e parcelamento | `criarLancamento`, `criarTransferencia`, `criarParcelamento`, `editar`, `compensar`, `excluir`, `editarEmLote`, `listar(filtro, cursor)`, `resumo(filtro)` | `tenancy`, `agregacao`, `domain/*`, `auditoria`, `outbox` |
| `saldos` | Modelo de leitura de saldo | `saldoDerivado(contaId, em, eixo)`, `saldoGeral(em)`, `projetar(ate)`, `materializar(contaId, eixo, desdeDataCivil)`, `reconciliar(contaId)` | `tenancy`, `agregacao`, `domain/saldo` |
| `recorrencias` | Regra e materialização | `criarRecorrencia`, `editarRecorrencia`, `materializarAte(horizonte)` | `tenancy`, `domain/recorrencia`, `lancamentos` |
| `planejamento` | Teto e piso por categoria × competência | `definir`, `copiarDe(competencia)`, `avaliar(competencia)` | `tenancy`, `agregacao`, `domain/{planejamento,razao}` |
| `objetivos` | Acúmulo plurimensal | `criarObjetivo`, `progresso`, `registrarAporte`, `avaliarTravessia` | `tenancy`, `domain/objetivo` |
| `ingestao` | **O seam do ADR 0003** | `BankSyncProvider`, `registrarAdapter`, `executarSincronizacao(conexaoId)`, `receberArquivo(arquivo, tipo)`, `promoverBrutos(sincronizacaoId)`, **`revogarConexao(conexaoId, motivo)`** | `tenancy`, `parsing`, `domain/ingestao`, `lancamentos` |
| `parsing` | **Fronteira de processo** para entrada hostil | `parsearEmSandbox(caminho, tipo, limites): Promise<Result<Normalizado, ParseError>>` | Nada além de `child_process` e Zod. **Não** importa `tenancy` nem Drizzle |
| `conciliacao` | Sugestão e decisão | `gerarSugestoes(sincronizacaoId)`, `aceitar`, `rejeitar` | `tenancy`, `domain/conciliacao` |
| `inteligencia` | Categorização automática, OCR | `sugerirCategoria(descricao)`, `lerRecibo(anexoId)` | `tenancy`, `parsing`, `domain/categorizacao` |
| `relatorios` | Modelo de leitura agregado | `porCategoria`, `entradasSaidas`, `porConta`, `porTag`, `evolucao` | `tenancy`, **`agregacao`** |
| `alertas` | Avaliação e notificação | `avaliarAlertas(tenantId, dia)`, `enfileirarNotificacao(chaveDedup, …)`, `marcarLido` | `tenancy`, `planejamento`, `objetivos`, `lancamentos` |
| `auditoria` | Log append-only e tela Atividades | `registrar(entidade, id, acao, de, para)`, `listarAtividades(filtro, cursor, papel)` | `tenancy` |
| `arquivos` | Anexos, storage, CSV | `guardar`, `assinarUrl(ttl)`, `csv.celulaSegura(valor)` | `tenancy` |
| `exportacoes` | Portabilidade e exportação | `solicitar(escopo, reautenticacao)`, `gerar(exportacaoId)`, `purgar()` | `tenancy`, `arquivos`, `agregacao` |
| `outbox` | Eventos de domínio transacionais | `publicar(tenantId, tipo, payload)` — mesma transação | `tenancy` |
| `filas` | Infra BullMQ | `registrarProcessador(nome, fn)`, `enfileirar(fila, jobId, payload)` | Redis |
| `preferencias` | Preferências por usuário × tenant | `obter`, `salvar` | `tenancy` |
| `integracoes` | MCP e chaves de API (pós-MVP) | `autorizarCliente`, `escoposDe(token)`, `revogar` | `auth` |
| `billing` | Planos e assinatura (épico 11) | `planoAtual`, `limitesDoPlano` | `tenancy` |

**Teste da deleção.** Apagar `tenancy`: todo módulo precisaria configurar `app.tenant_id` — alavancagem máxima. Apagar `agregacao`: **oito** superfícies (o rodapé, cinco relatórios, `faturas.total_centavos`, o realizado do Planejamento) precisariam lembrar de excluir transferência — que é exatamente o bloqueio B17. Apagar `parsing`: o parser volta para o processo que tem a KEK. Apagar `outbox`: cada escrita ganha lógica de "enfileirei mas o commit falhou".

**Módulo raso e aceito:** `filas` é fino de propósito — existe para que o processador de job seja função pública de módulo (§2.4a).

**A interface `BankSyncProvider`** — o seam do ADR 0003, **emendado pelo ADR 0019**, que lhe acrescentou a revogação. Todo adapter (`manual`, `ofx-import`, `csv-import`, `pluggy`) implementa **todas** as operações; nenhuma é opcional e nenhuma lança por "não se aplica".

```ts
interface BankSyncProvider {
  // Entrada — ADR 0003, inalterado
  conectar(…)  ·  sincronizar(…)  ·  receberArquivo(…)   // devolvem LancamentoBruto

  // Saída — ADR 0019
  revogar(alvo: AlvoRevogacao, opcoes: { sinal: AbortSignal; prazoMs: number })
    : Promise<ResultadoRevogacao>
}

type ResultadoRevogacao =
  | { estado: 'revogado'; em: Date; referencia?: string }   // o acesso deixou de existir agora
  | { estado: 'ja_revogado'; em?: Date }                    // não há acesso a encerrar — sucesso
  | { estado: 'nao_aplicavel'; motivo: string }             // manual, ofx-import, csv-import: zero I/O
  | { estado: 'falha_temporaria'; codigo: CodigoRevogacao; tentarApos?: Date }
  | { estado: 'falha_permanente'; codigo: CodigoRevogacao; detalhe: string }
```

`AlvoRevogacao` é um **descritor sem material cifrado** (`tenantId`, `conexaoId`, `provider`, `externalId`, `motivo`, `chaveIdempotencia`, `tentativa`) — não a linha de `conexoes`, que a esta altura já teve `dek_cifrada` e `credenciais_cifradas` zeradas na transação da revogação. É o que permite a **retentativa persistente** depois do crypto-shredding. `revogar` não escreve no banco, não conhece `tenancy` e não devolve segredo; persistir estado é do orquestrador, `revogarConexao`. `registrarAdapter` **recusa** adapter que não declare `modeloDeCredencial` (ADR 0018 §D0) e `revogacaoRemota`.

`conexoes` ganha o eixo `revogacao_remota` (`nao_aplicavel | confirmada | pendente | falhou`) ao lado de `status`: o primeiro diz o que sabemos do agregador, o segundo o que a Mavia fez. Os dez casos que a suíte de contrato **S3** precisa provar estão no ADR 0019 §D8.

### 1.5 `apps/web` e `apps/mobile`

Rotas, composição de `ui`, camada de dados (TanStack Query; no mobile também SQLite) e nada mais. **Regra de negócio em `apps/` é defeito arquitetural — veto do arquiteto.**

Caso limítrofe legítimo: `domain/fatura.faturaAlvo(cartao, postedAt, tz)` chamada no cliente para a prévia do formulário. É a mesma função do servidor (ADR 0001). **Mas o `postedAt` do cliente é sugestão, não autoridade:** o servidor valida a data recebida contra o seu relógio e recusa desvio acima de tolerância declarada (regra 9 do `CLAUDE.md`, ressalva R11).

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
| **S3** | Contrato do `BankSyncProvider` | A interface do ADR 0003, executada contra **cada** adapter | Vitest (suíte parametrizada) | Suíte: `apps/api/src/ingestao/provider/contrato/bank-sync-provider.contrato.ts` · Execução: `…/adapters/<adapter>/<adapter>.spec.ts` |
| **S4** | Schemas de `packages/contracts` | Resposta real parseada pelo schema; tipos derivados usados por web e mobile | Vitest | `packages/contracts/test/*.spec.ts` + parse dentro de S2 |
| **S5** | E2E web | Navegador contra a stack completa | Playwright | `apps/web/e2e/*.spec.ts` |
| **S6** | E2E mobile | App em emulador | Maestro | `apps/mobile/.maestro/*.yaml` |

**A revisão 2 não introduz seam novo.** Todos os controles do gate de risco couberam em S1, S2 e S3 — ver §2.5 e §2.6.

### 2.3 Por subsistema — onde cada coisa é testada

| Subsistema | Seam | O que é observado ali | Por que este e não outro |
|---|---|---|---|
| `Money`, rateio, sinal | **S1** | Soma exata; `max(partes) − min(partes) <= 1`; partes não-crescentes; `ratear(−v,n) = map(negar, ratear(v,n))`; recusa de moedas mistas; nenhuma fração de centavo | Property-based obrigatório (ADR 0005). **É a invariante de dispersão, não a da soma, que distingue "nas primeiras partes" de "tudo na primeira"** — as duas somam certo e divergem em R$ 0,03 já em R$ 100,00 / 7 |
| Transferência (partida dobrada) | **S1** (soma zero) + **S2** (as duas linhas na mesma transação; excluir uma perna é recusado) | Invariante puro vs. atomicidade e recusa | B18/A-23 só é observável na borda |
| Parcelamento | **S1** | N parcelas somam exatamente `valor_total`, **com sinal**; `purchase_date` no grupo; recusa quando `abs(total) < n` | B11/B12 são puros |
| Ciclo de fatura | **S1** | `closing_day` 31 em fevereiro; compra às 23h30 do dia do fechamento; virada de ano; nenhum instante em duas faturas nem em nenhuma | Contraexemplos I e J. Puro, com fuso injetado |
| Fechamento de fatura | **S2** | Job duas vezes não fecha duas vezes; `total_centavos` congela; a próxima fatura nasce uma vez | Requer unicidade de banco |
| **Pagamento de fatura não vira despesa** | **S2, parametrizado sobre todas as superfícies de agregação** | Uma fixture (compra de R$ 1.000 + pagamento integral) percorre `/lancamentos/resumo`, os cinco `/relatorios/*`, `planejamento.avaliar` e `faturas.total_centavos`. Nenhum total de gasto sobe; a fatura paga continua valendo R$ 1.000 | **É o teste que o produto declara existencial (C2).** Parametrizado, não copiado: adicionar superfície de agregação sem passar por `agregacao` faz o teste faltar, e a regra de lint de §2.5 reprova o build |
| Eixo temporal e fronteira | **S1** (`periodo`) + **S2** (rodapé × snapshot) | Contraexemplos C, D e AJ: lançamento em 31/ago 22h; último dia do mês; `saldo_anterior` no mesmo eixo do recorte | A conversão é pura; a coerência entre snapshot e rodapé é do banco |
| Saldo derivado | **S1** (fold) + **S2** (materialização e reconciliação por eixo) | S1: qualquer sequência → saldo. S2: snapshot == derivado, para cada eixo | — |
| **Composição do eixo caixa** (lançamentos de Conta + `Fatura`s não pagas) | **S1** (a composição é pura: duas listas → projeção) + **S2** (o ciclo completo) | Property: projetar até uma data além do vencimento dá **o mesmo número** antes do pagamento, depois de pagamento parcial e depois do integral. E: nenhum lançamento de Cartao aparece no eixo caixa | É a invariante que impede a dupla contagem entre a fatura e a perna de débito que a paga. Pura na composição, mas o ciclo `fechar → pagar parcial → pagar` só existe com banco |
| `Estorno` | **S1** | `original + estorno = 0` na natureza da categoria; `\|acumulado\| <= \|original\|`; sob `data_compra`, o estorno de parcelada cai na competência da compra, não na sua | Puro. O contraexemplo N vira propriedade |
| `consumo_bp` e limiar de alerta | **S1** | Os quatro quadrantes de sinal; `−R$ 399,99` sob teto de R$ 500 dá 7999 bp e **não** dispara 80%; `10000 bp` exatamente ⟹ `no_limite`; consumo negativo não cruza limiar positivo | Contraexemplos Q, R e S viram propriedade. Aritmética inteira, sem banco |
| Recorrência | **S1** (série, inclusive dia 31 em fevereiro) + **S2** (materialização idempotente) | Contraexemplo AI | — |
| Planejamento e alertas | **S1** (avaliação, precedência, faixas) + **S2** (dedup de notificação; `copiar` duas vezes) | Contraexemplo W: `copiar` idempotente com global | B15 exige o índice do banco |
| Ingestão: idempotência e dedup | **S1** (chave e hash) + **S2** (mesmo OFX duas vezes; e depois de soft delete) | A-06: a unicidade de `lancamentos_brutos` **não** filtra `deleted_at` | Regra 13 exige a prova no banco |
| Parsers OFX/CSV, **inclusive XXE e billion-laughs** | **S3** | Fixture com `<!ENTITY xxe SYSTEM "file:///etc/passwd">` → erro tipado, nunca conteúdo no resultado; profundidade > 20 → erro; razão de descompressão > 100:1 → erro | **Reusa S3.** A suíte de contrato já roda para todo adapter; os payloads hostis são mais fixtures, não seam novo |
| Conciliação | **S1** (pontuação) + **S2** (nunca sobrescreve o registro do usuário) | Regra 15 | — |
| Tenancy e RLS | **S2** | Dois tenants em **toda** rota; transação sem `SET LOCAL` lança erro; duas requisições na mesma conexão de pool não vazam | ADR 0004: RLS não pode ser mockada |
| Autorização | **S2** | Teste parametrizado sobre o manifesto OpenAPI: **toda** rota tem entrada em `autorizacao.md`, e o papel negado recebe 403 | A-12. Amostragem não serve — a prova tem de ser por rota |
| Propriedade intra-tenant | **S2** | Membro não marca notificação de outro nem sobrescreve preferência de outro | A-27: a RLS não vê isso por construção |
| Paginação e filtro | **S2** | Cursor com MAC inválido → 400; cursor de outro tenant → 400; cursor de outro filtro → 400; página vazia e cursor inválido são indistinguíveis | A-09, A-10 |
| Rodapé realizado × previsto | **S1** (`agregacao.resumoDoPeriodo`, `identidadeDoResumo`) + **S2** (soma das páginas = resumo, **com o balde de transferência**) | Contraexemplos A e B | §4.4 |
| Contratos | **S4** | A resposta real parseia; nenhum `zXResposta` contém credencial ou `payload` bruto | A-25, A-38 |
| Jobs e filas | **S2** | Ver §2.4a | **Sem seam novo** |
| Offline do mobile | **S1** (`planejarSincronizacao`) + **S6** (fumaça) | Ver §2.4b | **Sem seam novo** |
| Isolamento do processo `parser` | **Nenhum seam** — verificação de infraestrutura | O `parser` não enxerga `DATABASE_URL` nem a KEK, e não resolve DNS | Ver §2.6: é propriedade do container, não do código. Testar isso em Vitest testaria o mock |
| `packages/ui` | **S5** (uma asserção representativa) | Coluna de valor com algarismos tabulares; sinal com rótulo além de cor | §2.5 |
| Jornadas | **S5** / **S6** | Onboarding, lançar, parcelar, pagar fatura, importar OFX, filtrar | 6 no web, 3 no mobile |

### 2.4 As duas decisões que evitaram seams novos

**(a) Job é função pública de módulo, não classe acoplada à fila.**

```ts
// apps/api/src/saldos/jobs/reconciliar.ts
export async function reconciliarSaldo(deps: Deps, payload: ReconciliarPayload): Promise<Result<Relatorio, JobError>>
```

O módulo `filas` apenas registra a função num processador BullMQ. No teste de S2: cria estado por HTTP → chama a função **duas vezes** → verifica por HTTP. A fila não participa, e não precisa: prova-se reentrância, não que o BullMQ entrega.

**(b) A política de conflito offline é pura e mora em `packages/domain`.**

`domain/sincronizacao-offline.planejarSincronizacao(...)` devolve um `PlanoDeSync`. Toda a combinatória é testada em **S1** com property-based; o executor no app é plumbing coberto pela fumaça de **S6**. *Mova o seam, não relaxe o teste.*

**Nota de segurança (A-29):** o `PlanoDeSync` **não** é autoridade de autorização. O servidor revalida cada mutação com o mesmo guard da rota equivalente.

### 2.5 Onde os testes NÃO vão — anti-seams

Testar aqui é motivo de reprovação em `/code-review`:

- **Repositórios Drizzle** e classes `*Repository`. Se a query está errada, S2 acusa.
- **Serviços NestJS internos** com dependências mockadas.
- **Componentes de `packages/ui` isoladamente.** A formatação monetária é pura (S1); o resto é aparência, coberta pela auditoria de `docs/design.md` §5 e uma asserção em S5.
- **Hooks e queries do web/mobile.** Cobertos por S4 e S5/S6.
- **Adapter de `BankSyncProvider` mockado em teste de aplicação.**
- **Migrations isoladamente.** Aplicadas de verdade no `beforeAll` de S2.

**Regra de arquitetura verificada por lint, não por teste** (B17): `SUM(` sobre **qualquer coluna monetária** — `valor_centavos`, `total_centavos`, `pago_centavos`, `saldo_centavos`, `valor_total_centavos`, `valor_alvo_centavos` — só pode aparecer em `apps/api/src/agregacao/`. Qualquer outro arquivo que a contenha reprova o build. Falha no momento de escrever, que é mais barato e mais confiável do que um teste.

> A lista de colunas cresceu na revisão 3 e o motivo importa: com o eixo caixa passando a somar `faturas`, existe agora uma **segunda tabela monetária**. Se a regra continuasse restrita a `valor_centavos`, alguém abriria um caminho de agregação fora do módulo somando `total_centavos` direto — e a garantia do B17 vale exatamente o quanto essa lista é completa. Coluna monetária nova entra na lista **na mesma migration** que a cria.

### 2.6 O que é verificado fora dos seams

Nem todo controle do gate de risco é comportamento de código. Declarado aqui para que ninguém invente seam para cobrir:

| Controle | Onde é verificado |
|---|---|
| `parser` sem `DATABASE_URL`, sem KEK, sem rede | Verificação do pipeline de deploy: `docker compose exec parser env` não contém segredo; resolução de DNS falha |
| `mavia_migrate` inacessível do container da API (A-04) | `pg_hba.conf` + verificação de deploy |
| `/metricas` fora do Traefik (A-07) | Configuração de roteamento, conferida no deploy |
| Restauração de backup sem a KEK não recupera credencial (A-37) | Teste de restauração anual, com relatório |
| Limites de upload no Traefik (A-33) | Configuração + um teste de fumaça de 200 MB → 413 |

### 2.7 Orçamento de seam por feature

Todo spec produzido por `/to-spec` declara, em uma linha por comportamento, **qual dos seis seams** o observa. Se a resposta for "nenhum", a feature volta ao desenho — não ganha seam novo sem ADR.

---

## 3. Modelo de dados

PostgreSQL 16. Toda tabela de negócio: `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` (v4, ADR 0004), `tenant_id UUID NOT NULL`, `criado_em TIMESTAMPTZ NOT NULL DEFAULT now()`, `atualizado_em TIMESTAMPTZ`, `deleted_at TIMESTAMPTZ`. Dinheiro é sempre `BIGINT` de centavos mais `moeda CHAR(3)`. Nunca `NUMERIC`, nunca `float`.

### 3.1 Identidade e tenancy

| Tabela | Colunas-chave | Notas |
|---|---|---|
| `tenants` | `nome`, `plano`, `timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo' CHECK (timezone = 'America/Sao_Paulo')`, **`moeda_base CHAR(3) NOT NULL`** | Não tem `tenant_id` — **é** o tenant. O `CHECK` é a absorção de `Data civil`: o glossário fixa `America/Sao_Paulo`, então o valor é único hoje; a **coluna** permanece para que nenhum caminho de código escreva a zona literal. Ampliar o `CHECK` no futuro é mudança de dado, não de código — e exige ADR, porque `Competencia` e toda janela dependem dela |
| `usuarios` | `email CITEXT UNIQUE`, `senha_hash`, `nome`, `mfa_segredo_cifrado`, `mfa_kek_versao`, `ultimo_acesso_em` | Global. Cifra sob a mesma KEK do envelope (A-17) |
| `tenant_usuarios` | PK `(tenant_id, usuario_id)`, `papel` ∈ `proprietario\|membro\|visualizador`, `convidado_por`, `aceito_em`, `saiu_em` | |
| `sessoes` | `usuario_id`, `familia_id UUID NOT NULL`, `refresh_hash`, `dispositivo`, `ip_hash`, `ultimo_uso_em`, `expira_em`, `revogada_em` | `familia_id` é a rotação com detecção de reuso (A-14) |
| `convites` | `tenant_id`, `email_convidado CITEXT`, `papel`, `token_hash`, `expira_em`, `aceito_em`, `revogado_em` | Token de uso único, ≥128 bits, 7 dias (A-19) |
| `preferencias` | PK `(tenant_id, usuario_id)`, `ordenacao`, `periodo_padrao`, `saldo_diario BOOL`, `base_temporal_cartao` | Teardown §5 e §7 |

**`CHECK` de moeda única (B19).** No MVP não há câmbio: `contas.moeda` e `cartoes.moeda` são iguais a `tenants.moeda_base`, imposto por trigger de validação. Sem isso, `GET /contas/saldos` não tem resultado correto possível (contraexemplo AC). Remover o `CHECK` exige a entidade de câmbio e ADR própria.

### 3.2 Contas, cartões, classificação

| Tabela | Colunas-chave | Notas |
|---|---|---|
| `contas` | `nome`, `tipo` ∈ `corrente\|poupanca\|dinheiro\|investimento\|digital\|outra`, `moeda`, `saldo_inicial_centavos`, `incluir_no_saldo_geral BOOL DEFAULT true`, `origem` ∈ `manual\|conectado`, `conexao_id`, `icone`, `cor`, `arquivada_em` | `tipo` **existe** — corrige a fraqueza 2 do Organizze |
| `cartoes` | `nome`, `limite_centavos`, `closing_day SMALLINT CHECK 1..31`, `due_day SMALLINT CHECK 1..31`, `conta_pagamento_id`, `moeda`, `origem`, `conexao_id`, `arquivada_em` | Não é Conta |
| `categorias` | `parent_id`, `nivel SMALLINT CHECK IN (1,2)`, `nome`, `natureza` ∈ `receita\|despesa`, **`analitica BOOL NOT NULL DEFAULT true`**, `cor`, `icone`, `sistema BOOL`, `arquivada_em`, `deleted_at` | `CHECK ((nivel = 1) = (parent_id IS NULL))`; trigger garante que o pai tem `nivel = 1` e que a subcategoria herda a `natureza` do pai. **`analitica` substitui o `excluir_de_totais` que eu havia inventado na revisão 2** — mesmo comportamento, nome do glossário. Categoria não analítica (hoje só `Ajuste de saldo`) **recebe lançamento normalmente** e fica fora de todo total de gasto e de todo `Planejamento`, como a `Transferencia`. Categorias de sistema (`Sem categoria` por natureza, `Ajuste de saldo`) nunca são excluídas. `arquivada_em` e `deleted_at` coexistem e significam coisas diferentes |
| `tags` | `nome`, `cor`; `UNIQUE (tenant_id, lower(nome)) WHERE deleted_at IS NULL` | **`Tag` no código, "Etiqueta" na UI, nunca "marcador"** — renomeado de `etiquetas` para obedecer ao glossário |
| `lancamento_tags` | PK `(tenant_id, lancamento_id, tag_id)` | `tenant_id` na PK para RLS e índice |

### 3.3 O núcleo: `lancamentos`

Mudanças da revisão 3: **uma única coluna temporal de compensação** (`settled_at`), `status` derivado, `categoria_id` obrigatório, `estorno_de_lancamento_id` real, e a chave de recorrência pela competência.

```sql
CREATE TABLE lancamentos (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id),
  conta_id                  UUID REFERENCES contas(id),
  cartao_id                 UUID REFERENCES cartoes(id),
  categoria_id              UUID REFERENCES categorias(id),
  valor_centavos            BIGINT NOT NULL,
  moeda                     CHAR(3) NOT NULL,

  posted_at                 TIMESTAMPTZ NOT NULL,   -- competência. Imutável. Eixo do extrato e dos relatórios
  settled_at                TIMESTAMPTZ,            -- FATO da compensação. NULL enquanto o dinheiro não se moveu
  -- NÃO existe coluna de previsão de caixa, e NÃO existe coluna `status` — ver as duas notas abaixo

  descricao                 TEXT NOT NULL,
  observacao                TEXT,
  transfer_group_id         UUID REFERENCES transferencias(id),
  installment_group_id      UUID REFERENCES parcelamentos(id),
  installment_number        SMALLINT,
  installment_total         SMALLINT,
  recorrencia_id            UUID REFERENCES recorrencias(id),
  recorrencia_competencia   DATE,                   -- competência da ocorrência, NÃO a data exata
  fatura_id                 UUID REFERENCES faturas(id),
  estorno_de_lancamento_id  UUID REFERENCES lancamentos(id),
  lancamento_bruto_id       UUID REFERENCES lancamentos_brutos(id),
  origem                    lancamento_origem NOT NULL,
  editado_manualmente       BOOLEAN NOT NULL DEFAULT false,
  criado_por                UUID NOT NULL REFERENCES usuarios(id),
  criado_em                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em             TIMESTAMPTZ,
  deleted_at                TIMESTAMPTZ,

  CONSTRAINT uma_origem_de_dinheiro CHECK (num_nonnulls(conta_id, cartao_id) = 1),
  CONSTRAINT valor_nao_zero         CHECK (valor_centavos <> 0),

  -- ADR 0008: categoria é obrigatória FORA da perna de transferência, e proibida DENTRO dela.
  -- Sem isso, despesa sem categoria não consome teto nenhum e some de todo Planejamento, em silêncio.
  CONSTRAINT categoria_obrigatoria_fora_de_transferencia
    CHECK ((transfer_group_id IS NULL) = (categoria_id IS NOT NULL)),

  -- Estorno: sinal oposto ao original. |acumulado| <= |original| é regra de domínio (não é expressável
  -- em CHECK entre linhas) e vive em `domain/estorno` + CONSTRAINT TRIGGER.
  CONSTRAINT estorno_nao_e_o_proprio CHECK (estorno_de_lancamento_id <> id),

  CONSTRAINT parcela_coerente
    CHECK ((installment_group_id IS NULL) = (installment_number IS NULL)
           AND (installment_number IS NULL OR installment_number BETWEEN 1 AND installment_total)),

  CONSTRAINT compensacao_nao_antecede_competencia CHECK (settled_at IS NULL OR settled_at >= posted_at),

  -- B8: lançamento de cartão pertence a uma fatura SE E SOMENTE SE não for perna de transferência
  CONSTRAINT cartao_tem_fatura
    CHECK (cartao_id IS NULL OR ((transfer_group_id IS NULL) = (fatura_id IS NOT NULL)))
);
```

**`status` é derivado, nunca coluna (B4).** `efetivado` se `settled_at != null`; senão `previsto` se `posted_at` está no futuro; senão `pendente`. Derivar elimina a classe de bug em que um job esquece de virar o status e o número congela — e, como a derivação depende do instante da consulta, uma coluna seria *necessariamente* obsoleta entre duas execuções do job. Consequências operacionais: `domain/lancamento.statusDe(l, agora)` para a aplicação; um `CASE` sobre `settled_at` e `posted_at` dentro de `apps/api/src/agregacao/` para o SQL. **Nenhum índice pode ser sobre `status`** — os índices de §3.8 são sobre `settled_at IS NULL` e `posted_at`, que é o que de fato particiona.

**Não existe coluna de previsão de caixa (B4).** Uma compra de cartão não sai de conta nenhuma; quem sai é a `Fatura`. Persistir uma previsão em `lancamentos` seria ordenar o cartão num eixo a que ele não pertence — e daria a conta errada sempre que a fatura fosse paga por outra. A previsão de desembolso vive na `Fatura` (§3.7).

**`Estorno` (absorção).** Um estorno é um `Lancamento` comum com `estorno_de_lancamento_id` preenchido: sinal oposto, **mesma Conta ou Cartao, mesma Categoria e mesma moeda** do original. Consequências que o esquema já carrega:

- Ele **nunca** altera o `valor` do original nem o `valor_total` de um `parcelamentos` — não há `UPDATE` envolvido, e é por isso que `Σ filhos = valor_total` continua valendo depois de um estorno.
- Como a Categoria é a mesma do original, o par original + estorno **soma zero dentro da natureza daquela categoria**. Nenhum balde novo, nenhuma regra especial de agregação: ele reduz o realizado e o total da fatura por soma (§4.4). Era isso que faltava para o balde `estornos` da composição da fatura fechar.
- É a razão pela qual o `Lancamento` permite que o sinal do valor discorde da `natureza` da Categoria — e por que a partição dos baldes é por **natureza**, nunca por sinal (§4.4).
- `|estorno acumulado| <= |original|` é regra entre linhas: vive em `domain/estorno.estornadoAcumulado` e é imposta por `CONSTRAINT TRIGGER`, não por `CHECK`.

**Recorrência pela competência (absorção).** `recorrencia_ocorrencia_em DATE` virou `recorrencia_competencia DATE`. A identidade de uma ocorrência é `(tenant_id, recorrencia_id, competencia)`, e não a data exata. **Isso remove o `regra_versao` que eu havia inventado na revisão 2:** eu tinha adicionado uma coluna de versão para que mudar `dia_do_mes` não fizesse o job rematerializar tudo; com a competência na chave, alterar a regra reposiciona a ocorrência futura sem duplicá-la, e a coluna deixa de ter função. Menos esquema, mesma garantia.

### 3.4 Estruturas compostas

| Tabela | Colunas-chave | Notas |
|---|---|---|
| `transferencias` | `id` (= `transfer_group_id`), `tipo` ∈ `entre_contas\|pagamento_fatura`, **`fatura_id`** (quando pagamento), `descricao`, `criado_por` | **`transferencias.fatura_id` é o único vínculo entre pagamento e fatura** (B8). `lancamentos.fatura_id` nunca aponta para a fatura paga. Soma-zero e "exatamente 2 pernas vivas" por `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`, considerando `deleted_at IS NULL` — Postgres não tem constraint de agregação entre linhas (R13) |
| `parcelamentos` | `id`, `cartao_id`, **`purchase_date DATE NOT NULL`**, **`valor_total_centavos BIGINT` (com sinal do domínio)**, `moeda`, `total_parcelas`, `descricao`, `categoria_id` | `CHECK (valor_total_centavos <> 0)` e **`CHECK (abs(valor_total_centavos) >= total_parcelas)`**. O segundo resolve B11 recusando na borda `R$ 0,01 em 3x` em vez de gerar parcela zero — a alternativa exigiria relaxar `valor_nao_zero` para todo o sistema. O sinal em `valor_total_centavos` resolve B12: `Σ filhos = valor_total` passa a valer literalmente |
| `faturas` | `cartao_id`, **`conta_pagamento_id UUID NOT NULL`**, **`periodo_inicio TIMESTAMPTZ`**, **`periodo_fim TIMESTAMPTZ`**, **`fecha_em TIMESTAMPTZ`**, **`vencimento_em TIMESTAMPTZ`**, `timezone TEXT NOT NULL`, `data_fechamento DATE`, `data_vencimento DATE`, `estado`, `total_centavos`, `pago_centavos`, `fechada_em` | **`conta_pagamento_id` é novo e é o que faz o eixo caixa não precisar de join**: copiado de `cartoes.conta_pagamento_id` na criação da fatura e **congelado ali**, como `timezone`. Trocar a conta padrão do cartão não pode reescrever a projeção de ciclos já abertos. | **B5/B6 + absorção da `Janela`.** A janela é **`[periodo_inicio, periodo_fim)`**, semiaberta como todas as outras — a revisão 2 usava `(inicio, fim]` e o glossário revogou a exceção. A semântica não muda: `periodo_fim` é o instante que **encerra** o dia de fechamento, então a compra às 23h30 do dia do fechamento continua entrando na fatura que fecha. O ganho é `periodo_fim(k) = periodo_inicio(k+1)` **por igualdade**, e não por "o instante seguinte" — contiguidade e disjunção viram asserção trivial (contraexemplo J). Comparação contra `posted_at TIMESTAMPTZ` sem coerção. As colunas `DATE` são `Data civil` de **exibição**, geradas de `(vencimento_em AT TIME ZONE timezone)::date`. `timezone` congela na criação — mudar o fuso não reescreve fatura passada. `UNIQUE (tenant_id, cartao_id, periodo_inicio)`; `CHECK (periodo_fim > periodo_inicio)`; `EXCLUDE USING gist (tenant_id WITH =, cartao_id WITH =, tstzrange(periodo_inicio, periodo_fim, '[)') WITH &&)` |
| `recorrencias` | `conta_id`/`cartao_id`, `categoria_id`, `descricao`, `valor_centavos`, `moeda`, `frequencia`, `intervalo`, `dia_do_mes`, `dia_da_semana`, `inicio_em`, `fim_em`, `ocorrencias_max`, `materializado_ate DATE`, `ativa` | **`regra_versao` removido** — a identidade da ocorrência é a competência (§3.3). `dia_do_mes` em mês que não o tem é fixado em `min(dia_do_mes, ultimo_dia_do_mes)`, sempre a partir da regra, nunca do mês anterior: nunca pula, nunca transborda (contraexemplo AI) |
| `planejamentos` | `categoria_id` (NULL = global), `competencia DATE` (dia 1), `valor_centavos` **com sinal — negativo é teto, positivo é piso**, `moeda`, `alertas_percentuais SMALLINT[] DEFAULT '{80,100}'` | **`natureza` deixa de ser coluna:** o glossário a declara derivada do sinal de `valor`. Identidade `(tenant_id, competencia, natureza, categoria_id)` com `categoria_id` nulo sendo valor legítimo — realizada por **três índices únicos parciais** em §3.8, não por uma constraint natural. `CHECK (valor_centavos <> 0)` também garante que `razaoEmBp` nunca divide por zero |
| `objetivos` | `nome`, `modo` ∈ `ancorado\|aportes`, `valor_alvo_centavos`, `moeda`, `conta_id`, `saldo_base_centavos`, **`prazo DATE`**, `concluido_em`, `arquivada_em` | ADR 0009. Nunca cria `Lancamento`. `prazo` segue a convenção de nome de `Data civil` (era `prazo_em`) |
| `objetivo_aportes` | PK `(tenant_id, objetivo_id, lancamento_id)`, `UNIQUE (tenant_id, lancamento_id)` | Um lançamento não serve a dois objetivos (A-24) |

### 3.5 Ingestão

| Tabela | Colunas-chave | Notas |
|---|---|---|
| `conexoes` | `provider`, `instituicao`, `status`, `credenciais_cifradas BYTEA`, `dek_cifrada BYTEA`, **`kek_versao SMALLINT NOT NULL`**, **`dek_criada_em TIMESTAMPTZ NOT NULL`**, `escopo JSONB`, `valida_ate`, `ultima_sync_em` | As duas colunas novas são o que torna a rotação de KEK incremental (A-37). O **como** da cifra é a ADR 0018, de outro autor |
| `consentimentos` | `conexao_id`, `usuario_id`, `versao_texto`, `escopo JSONB`, `concedido_em`, `expira_em`, `revogado_em`, `ip_hash`, `user_agent_hash` | Append-only. Revogação dispara `retencao.aplicar` **e** o crypto-shredding síncrono de §5.2 |
| `sincronizacoes` | `conexao_id`, `provider`, `iniciada_em`, `terminada_em`, `resultado`, `criados`, `atualizados`, `ignorados`, `erro_codigo` | O que a tela de importação mostra |
| `lancamentos_brutos` | `provider`, `external_id`, `conteudo_hash BYTEA`, `payload JSONB`, `conta_id`/`cartao_id`, `sincronizacao_id`, `valor_centavos`, `moeda`, `posted_at`, `descricao_origem`, `status`, `lancamento_id` | `payload` **nunca** sai em resposta interativa (A-25) — ver a objeção em §10 |
| `conciliacao_sugestoes` | `lancamento_bruto_id`, `lancamento_id`, `score`, `motivo JSONB`, `estado`, `decidida_por`, `decidida_em` | Nunca escreve em `lancamentos` |
| `regras_categorizacao` | `prioridade`, `condicoes JSONB`, `categoria_id`, `tags UUID[]`, `ativa` | Motivo sempre visível, sempre reversível |

### 3.6 Transversais

| Tabela | Colunas-chave | Notas |
|---|---|---|
| `saldo_snapshots` | PK **`(tenant_id, conta_id, eixo, data_civil)`**, `saldo_centavos`, `ultimo_lancamento_em`, `calculado_em` | **B2/B3.** `eixo ∈ ('competencia','caixa')` faz parte da chave: é impossível ler um snapshot sem nomear o eixo. A coluna `dia` virou **`data_civil`** para obedecer à convenção de nome do glossário — campo que nomeia um dia, nunca um instante, apurado por `(<coluna do eixo> AT TIME ZONE tenants.timezone)::date`, nunca em UTC nu (contraexemplo D) |
| `auditoria` | `id BIGSERIAL`, `usuario_id`, `entidade`, `entidade_id`, `acao`, `de JSONB`, `para JSONB`, `ocorrido_em`, `request_id`, `ip_hash`, **`classe` ∈ `financeira\|seguranca`** | Append-only: `REVOKE UPDATE, DELETE`. `classe` sustenta a regra de visibilidade de A-26. `ip_hash` nunca sai em resposta de API |
| `notificacoes` | `usuario_id`, `tipo`, `payload JSONB`, `canal`, `chave_dedup`, `agendado_para`, `enviado_em`, `lido_em` | `UNIQUE (tenant_id, chave_dedup)` |
| `anexos` | `lancamento_id`, `storage_key` (gerado pelo servidor), `mime` (por magic bytes), `nome_original`, `bytes`, `hash` | A-36 |
| `exportacoes` | `escopo JSONB`, `formato`, `storage_key`, `estado`, `solicitada_por`, `reautenticada_em`, `expira_em` | A-28 |
| **`outbox`** | `id BIGSERIAL`, **`tenant_id UUID NOT NULL`**, `tipo`, `payload JSONB`, `criado_em`, `publicado_em` | **A-01.** Ganha `tenant_id`, RLS com `FORCE`, e índice liderado por tenant |
| **`outbox_pendencias`** | PK `tenant_id`, `tem_pendencia BOOL`, `atualizado_em` | **Tabela-agulha** mantida por trigger em `outbox`. Não contém dado financeiro. É a **única** tabela que `mavia_jobs` lê sem contexto de tenant — exceção declarada em §3.9 |

### 3.7 Eixo temporal, fronteira e o que é derivado

**Os dois eixos (B2).** Um lançamento tem duas datas legítimas e o produto precisa das duas. A ambiguidade some quando o eixo vira parte da chave e do contrato:

| Eixo | Fonte | Responde | Quem usa |
|---|---|---|---|
| `competencia` | `lancamentos.posted_at` — de Conta **e** de Cartao | "o que aconteceu neste mês" | Extrato, rodapé, relatórios, `Planejamento` |
| `caixa` | **duas fontes, compostas:** (a) `lancamentos` **de Conta** — realizados em `settled_at`, futuros em `posted_at`; (b) **`Fatura`s não pagas**, pelo saldo devedor no `vencimento_em`, debitadas de `cartoes.conta_pagamento_id` | "quanto há e quanto haverá na conta" | `GET /contas/saldos`, Saldo geral, `Objetivo`, projeção |

**Lançamento de Cartao não pertence ao eixo caixa.** Uma compra não movimenta conta; quem movimenta é a fatura. No eixo caixa o cartão entra **uma vez por ciclo**, como `Fatura`, não N vezes como lançamento.

**A composição do eixo caixa, sem dupla contagem.** A fatura representa a saída futura **enquanto não está paga**; depois de paga, quem representa a saída é a perna de débito da `Transferencia` de pagamento, que é um lançamento de Conta e já está na fonte (a). Nunca as duas.

A regra que fecha isso para o **pagamento parcial** — e que é a única correção que faço à instrução recebida: a fatura contribui com o **saldo devedor**, `total_centavos + pago_centavos`, e não com `total_centavos`. Com `estado <> 'paga'` e o total cheio, uma fatura de R$ 1.000,00 com R$ 400,00 já pagos contaria R$ 400,00 duas vezes — uma na perna de débito já compensada, outra dentro do total da fatura. Como o sinal vive no valor (`total_centavos` negativo, `pago_centavos` positivo), a soma é a expressão direta do que falta sair, sem nenhum `if`.

> **Invariante para S2:** projetar até uma data posterior ao vencimento dá **o mesmo número** antes do pagamento, depois de um pagamento parcial, e depois do pagamento integral.
> `X − 1000` · `(X − 400) − 600` · `(X − 1000) − 0`.

**Regra sem exceção:** dentro de uma mesma resposta, todas as grandezas usam **um** eixo, e o eixo aparece no payload. `saldo_anterior` é lido do snapshot **do mesmo eixo** do recorte. Isso mata o contraexemplo C.

**Fuso (B3).** Todo dia civil — `saldo_snapshots.data_civil`, a fronteira do período, a `Competencia` — é apurado em `tenants.timezone` (hoje `America/Sao_Paulo` por `CHECK`), por `domain/periodo`. Nenhum `::date` sobre `TIMESTAMPTZ` sem `AT TIME ZONE` explícito. Regra de lint: `::date` só é permitido em `apps/api/src/agregacao/` e sempre precedido de `AT TIME ZONE`. Nunca offset fixo `-03:00` — sempre a zona IANA, porque o Brasil já teve horário de verão e pode voltar a ter.

**Fronteira (B22) — uma convenção só (absorção).** A revisão 2 declarava duas convenções, e o glossário revogou a exceção: **toda janela é `[inicio, fim)`, inclusive a da fatura.**

| Superfície | Fronteira |
|---|---|
| `domain/periodo.janela()`, filtro, relatórios, comparação de períodos | `[inicio, fim)` |
| Janela da `Fatura` | `[inicio, fim)` |

Aceito a revogação porque ela é estritamente melhor do que a minha: com `(inicio, fim]` a contiguidade entre faturas se verificava por "o instante seguinte", que não existe em `TIMESTAMPTZ` e produziu o contraexemplo J (uma compra em nenhuma fatura, ou em duas). Com uma convenção só, `periodo_fim(k) = periodo_inicio(k+1)` é igualdade, e contiguidade e disjunção viram asserção trivial em S1. A regra de produto "a compra no dia do fechamento entra na fatura que fecha" é preservada pelo **valor** de `periodo_fim` (o instante que encerra o dia de fechamento), não pela fronteira.

Nenhuma comparação de janela usa `DATE`. Comparação entre períodos usa **a mesma fronteira e a mesma base temporal nos dois lados**, imposto no schema: `zComparacaoQuery` recebe um objeto de base e fronteira, não dois independentes.

**Derivado × materializado:**

| Grandeza | Natureza | Regra |
|---|---|---|
| Saldo de conta, saldo geral | **Derivado** | `saldo_inicial + SUM(valor_centavos)` no eixo pedido. Nunca coluna mutável |
| Projeção, resumo do período, totais de relatório, "saldo no dia" | **Derivado a cada consulta** | Sempre por `agregacao` |
| `saldo_snapshots.saldo_centavos` | **Materializado (cache), por eixo** | Divergência é **incidente** (regra 5) |
| `lancamentos.fatura_id` | **Materializado (denormalização)** | Derivável de `domain/fatura.faturaAlvo` |
| `faturas.total_centavos` enquanto `aberta` | **Materializado (cache)** | `SUM` dos lançamentos da fatura **com `transfer_group_id IS NULL`** (B8), via `agregacao`. **Agora este cache alimenta a projeção de caixa**, então entra no escopo de `saldo.reconciliar`: um total obsoleto passou a ser saldo futuro errado, não só uma tela desatualizada |
| `faturas.total_centavos` após `fechada` | **Fato congelado** | Imutável; alterar exige reabertura explícita e auditada |
| `faturas.pago_centavos` | **Materializado** | `SUM` das pernas de crédito das `transferencias` com `fatura_id = f.id`. **Nunca** de `lancamentos.fatura_id` |
| Saldo devedor da fatura (`total + pago`) | **Derivado** | A parcela da `Fatura` que entra na projeção de caixa. Zero quando `paga` |
| `status` de `Lancamento` | **Derivado, nunca coluna** | `settled_at` e `posted_at` contra o instante da consulta |
| `recorrencias.materializado_ate` | **Marca d'água** | Só avança |

### 3.8 Índices que importam

Regra sem exceção: **todo índice de tabela de negócio começa por `tenant_id`** — inclusive `outbox` (A-01).

```sql
-- lancamentos
-- eixo caixa, fonte (a): lançamentos DE CONTA já compensados
CREATE INDEX ON lancamentos (tenant_id, conta_id, settled_at)
  WHERE deleted_at IS NULL AND settled_at IS NOT NULL;
-- eixo caixa, fonte (a) futura, e "contas a pagar / a receber": não compensados, pela data prevista
CREATE INDEX ON lancamentos (tenant_id, conta_id, posted_at)
  WHERE deleted_at IS NULL AND settled_at IS NULL;
-- eixo competência
CREATE INDEX ON lancamentos (tenant_id, posted_at DESC, id DESC)
  WHERE deleted_at IS NULL;                                    -- extrato + keyset
CREATE INDEX ON lancamentos (tenant_id, categoria_id, posted_at) WHERE deleted_at IS NULL;
CREATE INDEX ON lancamentos (tenant_id, fatura_id) WHERE deleted_at IS NULL;
CREATE INDEX ON lancamentos (tenant_id, transfer_group_id)    WHERE transfer_group_id IS NOT NULL;
CREATE INDEX ON lancamentos (tenant_id, installment_group_id, installment_number)
  WHERE installment_group_id IS NOT NULL;
CREATE INDEX ON lancamentos (tenant_id, estorno_de_lancamento_id)
  WHERE estorno_de_lancamento_id IS NOT NULL AND deleted_at IS NULL;   -- estornado acumulado

-- eixo caixa, fonte (b): faturas em aberto, pela conta que as paga
CREATE INDEX ON faturas (tenant_id, conta_pagamento_id, vencimento_em)
  WHERE estado <> 'paga' AND deleted_at IS NULL;

-- idempotência: regra de negócio, não otimização
CREATE UNIQUE INDEX ON lancamentos (tenant_id, recorrencia_id, recorrencia_competencia)
  WHERE recorrencia_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX ON lancamentos (tenant_id, lancamento_bruto_id)
  WHERE lancamento_bruto_id IS NOT NULL AND deleted_at IS NULL;

-- A-06: a unicidade do bruto NÃO filtra deleted_at — reimportar é sempre no-op
CREATE UNIQUE INDEX ON lancamentos_brutos (tenant_id, provider, external_id);
CREATE UNIQUE INDEX ON lancamentos_brutos (tenant_id, provider, conteudo_hash);

-- B15: a identidade é (tenant, competencia, natureza, categoria_id), e `natureza` é derivada do
-- sinal de `valor`. NULL não colide em índice único no Postgres, então são TRÊS índices parciais.
CREATE UNIQUE INDEX ON planejamentos (tenant_id, competencia, categoria_id)
  WHERE categoria_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX ON planejamentos (tenant_id, competencia)
  WHERE categoria_id IS NULL AND valor_centavos < 0 AND deleted_at IS NULL;   -- teto global
CREATE UNIQUE INDEX ON planejamentos (tenant_id, competencia)
  WHERE categoria_id IS NULL AND valor_centavos > 0 AND deleted_at IS NULL;   -- piso global

-- demais
CREATE UNIQUE INDEX ON faturas (tenant_id, cartao_id, periodo_inicio);
CREATE INDEX        ON faturas (tenant_id, cartao_id, estado, vencimento_em);
CREATE UNIQUE INDEX ON notificacoes (tenant_id, chave_dedup);
CREATE INDEX        ON auditoria (tenant_id, ocorrido_em DESC, id DESC);
CREATE INDEX        ON auditoria (tenant_id, entidade, entidade_id);
CREATE INDEX        ON outbox (tenant_id, publicado_em) WHERE publicado_em IS NULL;
```

Sobre os três índices de `planejamentos` (B15): a revisão 2 usava `NULLS NOT DISTINCT`, que é PG15+; o ADR 0008 prescreve índices parciais, e **adoto os dele** — resolvem o mesmo problema sem depender de versão, e discriminam teto de piso, que `NULLS NOT DISTINCT` sozinho não faz (um mês pode ter um teto global **e** um piso global). A cópia é `INSERT … ON CONFLICT DO NOTHING`, de modo que a idempotência é do banco; onde houver verificação de existência em SQL, ela é `IS NOT DISTINCT FROM` sobre a identidade inteira, nunca `=`, que avalia `NULL` e nunca casa (contraexemplo W).

### 3.9 Row-Level Security, papéis e resolução de tenant

Padrão aplicado a **toda** tabela de negócio, **incluindo `outbox`**:

```sql
ALTER TABLE lancamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE lancamentos FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lancamentos
  USING       (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK  (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

**Policies das tabelas que não são tenant-scoped (A-02):**

```sql
-- sessoes: o material que permite personificar qualquer usuário da plataforma
ALTER TABLE sessoes ENABLE ROW LEVEL SECURITY;  ALTER TABLE sessoes FORCE ROW LEVEL SECURITY;
CREATE POLICY sessao_do_usuario ON sessoes
  USING      (usuario_id = current_setting('app.usuario_id', true)::uuid)
  WITH CHECK (usuario_id = current_setting('app.usuario_id', true)::uuid);

-- usuarios: o próprio, e os membros dos tenants a que pertence
CREATE POLICY usuario_proprio ON usuarios
  USING (id = current_setting('app.usuario_id', true)::uuid
         OR EXISTS (SELECT 1 FROM tenant_usuarios tu
                    WHERE tu.usuario_id = usuarios.id
                      AND tu.tenant_id = current_setting('app.tenant_id', true)::uuid));

-- tenant_usuarios e tenants: pertencimento
CREATE POLICY pertencimento ON tenant_usuarios
  USING (usuario_id = current_setting('app.usuario_id', true)::uuid
         OR tenant_id = current_setting('app.tenant_id', true)::uuid);
```

`app.usuario_id` e `app.tenant_id` são definidos **juntos**, por `SET LOCAL`, no único ponto de entrada `tenancy.withTenant`. A unidade de trabalho **falha** se algum dos dois estiver ausente. Critério de aceite (S2): uma transação sem `SET LOCAL` lança erro, não retorna linhas.

**A resolução de tenant em quatro etapas (A-03).** É o ponto cego canônico de um SaaS multi-tenant; por isso é uma etapa nomeada, não um middleware genérico:

1. Autentica e obtém `usuario_id` do token.
2. Abre transação com `SET LOCAL app.usuario_id`, **sem** `app.tenant_id`.
3. Consulta `tenant_usuarios` sob a policy de `app.usuario_id` para obter papel e pertencimento do tenant pedido.
4. **Se e somente se** houver linha, define `app.tenant_id` e o papel no `TenantContext`.

Ausência de `X-Mavia-Tenant` com múltiplos tenants é **400**, nunca escolha implícita do primeiro. Header com tenant não pertencente é **403**, sem troca de contexto.

**Papéis de banco:**

| Papel | `BYPASSRLS` | Usa | Restrições |
|---|---|---|---|
| `mavia_app` | não | Processo `http` | Sem `UPDATE`/`DELETE` em `auditoria` e `consentimentos`. `statement_timeout = 5s` |
| `mavia_jobs` | não | Processo `worker` | `SELECT` apenas na **view `tenants_ativos (id, timezone, plano, moeda_base)`** com `security_invoker`, nunca na tabela `tenants` (A-05). `statement_timeout = 60s` |
| `mavia_migrate` | sim | Só o job de migration do deploy | Credencial ausente do ambiente de `http` e `worker`; `pg_hba.conf` restringe o papel ao host do runner (A-04) |

O processo `parser` **não tem papel de banco** — não abre conexão.

**A única exceção de leitura sem contexto de tenant** é `outbox_pendencias` (`tenant_id`, booleano, sem dado financeiro) e a view `tenants_ativos`. Está declarada aqui porque uma exceção escrita é auditável e uma exceção implícita não é. Critério de aceite (A-01): com `mavia_jobs` conectado e `app.tenant_id` não definido, `SELECT count(*) FROM outbox` retorna **0**.

**RLS isola tenants; propriedade dentro do tenant é responsabilidade explícita da rota (A-27).** Toda rota sobre recurso cuja chave inclui `usuario_id` — `notificacoes`, `preferencias`, `sessoes` — verifica `usuario_id = TenantContext.usuarioAtual()` no servidor, além da RLS. A RLS não vê esse caso por construção.

**Segunda camada:** todo repositório também filtra por `tenant_id` no `WHERE` (regra 16). **Prova:** todo teste de recurso em S2 cria dois tenants e verifica que um não enxerga o outro.

---

## 4. Superfície de API

Base `/v1`. JSON. `bigint` como string. Toda resposta de erro segue `zErro`.

### 4.0 Autorização — negar por padrão

A tabela normativa papel × ação × recurso mora em **`docs/arquitetura/autorizacao.md`** e é a fonte de `domain/politica-acesso.pode()`. Este documento não a duplica.

O que este documento fixa é o **mecanismo**: um guard global do Nest **nega por padrão**. Rota sem declaração explícita de autorização **não sobe** — falha no boot, não em runtime. Teste de S2: percorre o manifesto de rotas do OpenAPI gerado por `contracts` e falha se alguma rota não tiver entrada na tabela (A-12).

Ações que exigem **reautenticação** (senha ou MFA), além do papel: promover a `proprietario`, remover membro, `POST /exportacoes` de escopo total, revogar conexão, criar chave de API.

### 4.1 Grupos de endpoints

| Grupo | Rotas | Retorna | Tela |
|---|---|---|---|
| `auth` | `POST /auth/registrar` · `/entrar` · `/refresh` · `/sair` · `/senha/recuperar` · `GET /auth/eu` · **`GET /auth/sessoes`** · **`DELETE /auth/sessoes/:id`** · **`POST /auth/sessoes/revogar-todas`** · **`POST /auth/mfa/inscrever`** · **`POST /auth/mfa/verificar`** · **`POST /auth/mfa/recuperacao`** | Tokens; identidade; sessões com dispositivo e IP mascarado | Login, Config › Segurança |
| `tenants` | `GET /tenants` · `POST /tenants` · **`GET /membros`** · **`POST /convites`** · **`PATCH /membros/:usuarioId`** · **`DELETE /membros/:usuarioId`** | Espaços e papéis | Config › Membros |
| `contas` | `GET /contas` · `POST` · `GET /contas/:id` · `PATCH` · `POST /contas/:id/arquivar` · `GET /contas/saldos?em=&eixo=` | Conta + saldo derivado no eixo pedido | Config › Contas, Visão geral |
| `cartoes` | `GET /cartoes` · `POST` · `PATCH` · `/arquivar` · `GET /cartoes/:id/faturas` · `GET /faturas/:id` · `/lancamentos` · `POST /faturas/:id/fechar` · `POST /faturas/:id/reabrir` · `POST /faturas/:id/pagamentos` | Fatura como objeto de ciclo, com composição | Cartões, Fatura |
| `categorias` | `GET /categorias` · `POST` · `PATCH` · `/arquivar` | Árvore de dois níveis | Config › Categorias |
| `tags` | `GET /tags` · `POST` · `PATCH` · `DELETE` | — | Config › Etiquetas |
| `lancamentos` | `GET /lancamentos` · **`GET /lancamentos/resumo`** · `GET /lancamentos/agenda` · `POST` · `GET /:id` · `PATCH` · `DELETE` · `POST /:id/compensar` · `POST /:id/descompensar` · `POST /lancamentos/lote` | Página keyset; resumo com **sete** baldes; agenda | Lançamentos, Modal |
| `transferencias` | `POST` · `GET /:id` · `DELETE /:id` | As duas pernas, sempre juntas | Modal › Transferência |
| `parcelamentos` | `POST` · `GET /:id` · `PATCH /:id` · `DELETE /:id` | Grupo + parcelas + `purchase_date` | Modal › Parcelado |
| `recorrencias` | `GET` · `POST` · `PATCH` · `DELETE` · `GET /:id/ocorrencias?ate=` | Regra + prévia | Recorrências |
| `planejamentos` | `GET ?competencia=` · `PUT` · `POST /planejamentos/copiar?de=&para=` · `DELETE /:id` | Realizado, projetado, **`consumo_bp` inteiro**, `dentro_do_plano` e estado `dentro\|no_limite\|estourado`. `natureza` é derivada do sinal, nunca campo de entrada | Planejamento |
| `objetivos` | `GET` · `POST` · `PATCH` · `POST /objetivos/:id/aportes` · `/arquivar` | Objetivo + progresso | Objetivos |
| `relatorios` | `GET /relatorios/categorias` · `/entradas-saidas` · `/contas` · `/tags` · `/evolucao` | Séries agregadas em centavos, **todas por `agregacao`** | Relatórios |
| `importacoes` | `POST /importacoes` · `GET /:id` · `GET /:id/brutos` · `POST /:id/promover` | Progresso e prévia **em allowlist** | Importar |
| `conexoes` | `GET` · `POST` · `POST /:id/sincronizar` · `DELETE /:id` · `GET /:id/sincronizacoes` | Conexão e consentimento | Conexões |
| `conciliacoes` | `GET` · `POST /:id/aceitar` · `/rejeitar` | Sugestões com motivo | Conciliação |
| `atividades` | `GET /atividades` | Audit log, filtrado por `classe` e papel | Config › Atividades |
| `alertas` | `GET /alertas` · `POST /:id/lido` · `GET/PUT /alertas/preferencias` | Notificações e canais | Sino, Config › Alertas |
| `preferencias` | `GET` · `PUT` | Ordenação, período, base temporal | Config › Preferências |
| `exportacoes` | `POST /exportacoes` · `GET /exportacoes/:id` | Solicitação e estado | Config › Preferências, LGPD |
| **`anexos`** | **`POST /anexos`** · **`GET /anexos/:id`** · **`DELETE /anexos/:id`** | Metadado; conteúdo por URL assinada | Modal de lançamento |
| **`inteligencia`** | **`POST /inteligencia/sugerir-categoria`** · **`POST /inteligencia/ler-recibo`** | Sugestão com motivo | Modal (selo IA) |
| **`sync`** | **`POST /sync/mutacoes`** · **`GET /sync/mudancas?desde=`** | Aplicação em lote e changefeed | Mobile |
| **`integracoes`** | **`GET/POST/DELETE /integracoes/chaves`** · **`GET/DELETE /integracoes/mcp`** | Chaves e clientes MCP | Config › Apps conectados |
| `saude` | `GET /saude` | `{status}` apenas | Observabilidade |

**Rotas removidas nesta revisão.** `/tenants/:id/membros`, `/tenants/:id/convites`, `/tenants/:id/membros/:usuarioId` (A-19): o `:id` de tenant **sai da rota**. O tenant já vem do contexto de sessão; duas fontes de verdade para a mesma coisa é a receita de IDOR. Corrigir validando `:id` contra o contexto seria remendar; removê-lo torna a classe de bug inexistente. Regras que continuam necessárias: `PATCH`/`DELETE` de membro exigem `proprietario` e reautenticação, ninguém altera o próprio papel, e a remoção que deixaria o tenant sem `proprietario` ativo é rejeitada por **constraint**, não por `if`.

**Controles por rota, fixados no contrato:**

| Controle | Onde |
|---|---|
| Teto de janela de 5 anos, `de <= ate` | `zFiltroBase`, todos os schemas de relatório (A-22) |
| `ocorrencias?ate=` horizonte máximo 24 meses | `zRecorrenciaOcorrenciasQuery` (A-22) |
| `POST /lancamentos/lote`: teto de 500 ids, autorização **por item**, uma transação, **uma** entrada de auditoria com os ids; acima de 50 exclusões, notifica o titular | `zLoteRequest` (A-21) |
| `DELETE /lancamentos/:id` recusa (409, `LANCAMENTO_PERTENCE_A_TRANSFERENCIA` / `…_A_PARCELAMENTO`) qualquer lançamento com grupo | `lancamentos` (A-23, B18) |
| `GET /importacoes/:id/brutos` devolve allowlist: `id, posted_at, descricao_origem, valor, moeda, status, marca`. **`payload` não aparece** | `zBrutoResposta` (A-25) |
| `POST /exportacoes`: papel ≠ `visualizador`, reautenticação no escopo total, 3/h e 10/dia por tenant, entrada em `auditoria` **e** notificação a todos os proprietários, URL de TTL ≤ 15 min de uso único em domínio distinto, `expira_em ≤ 7 dias` | `exportacoes` (A-28) |
| `POST /sync/mutacoes`: teto de 200 mutações, `UNIQUE (tenant_id, mutacao_id)`, mesmo guard da rota equivalente. `GET /sync/mudancas`: `desde` ≤ 90 dias, ≤ 1.000 registros, cursor assinado | `zSyncMutacoes`, `zSyncMudancas` (A-29) |
| `inteligencia` é `POST`, nunca `GET` — descrição em query string vai para log de acesso | `inteligencia` (A-30) |
| Rate limit por `(usuario_id, rota)`: 60/min leitura simples, 10/min agregada, 3/h em `POST /exportacoes` e `/importacoes` | Guard global (A-22) |
| `GET /metricas` **não existe em `/v1`** | Porta e interface separadas, fora do Traefik, com credencial. Nenhuma métrica recebe `tenant_id`, `conta_id`, `usuario_id` ou e-mail como label (A-07) |

**Limites de upload (A-33), como constantes nomeadas:**

| Controle | Valor |
|---|---|
| Corte no Traefik, antes do Node | 25 MB |
| OFX/CSV — tamanho / transações | 10 MB / 20.000 |
| Anexo (imagem/PDF) | 20 MB, 1 por lançamento no MVP |
| Timeout de parsing por arquivo | 30 s, `SIGKILL` no processo filho |
| Memória do processo `parser` | 256 MB |
| Razão de descompressão | 100:1, teto de 100 MB, verificada **durante** o stream |
| Parses simultâneos por tenant | 1 (fila; o upload aceita enfileirar — ver objeção em §10) |

Corpo lido em **streaming** para disco temporário com contagem de bytes; ultrapassar aborta a conexão sem bufferizar. Rejeição por tamanho retorna 413 com o limite em texto.

### 4.2 Onde mora a paginação

**No banco, por keyset**, na chave `(posted_at DESC, id DESC)`. `OFFSET` degrada e, pior, pula ou repete linhas sob inserção concorrente — "sumiu um lançamento ao rolar" é indistinguível de perda de dado.

**O cursor é assinado, não apenas codificado (A-09).** Base64 é codificação, não opacidade.

```
cursor = base64url(payload) || '.' || HMAC-SHA256(payload, chave_de_servico)
payload = { posted_at, id, tenant_id, hash_do_filtro }
```

O servidor recusa com **400** cursor com MAC inválido, com `tenant_id` diferente do contexto, ou com `hash_do_filtro` diferente do filtro corrente. `zCursor` valida o payload **antes** de tocar o SQL.

**A resolução é puramente aritmética (A-10).** Os valores do payload assinado entram direto na comparação de tupla. **É proibido consultar a tabela pelo `id` do cursor** — fazê-lo transforma a paginação num oráculo de existência para UUIDs obtidos por outro canal. As respostas de erro são indistinguíveis: 200 com lista vazia para cursor válido sem resultados, 400 genérico para cursor malformado, sem revelar qual verificação falhou.

Vale para `lancamentos`, `atividades` e `importacoes/:id/brutos`. Em `atividades`, o `BIGSERIAL` de `auditoria` fica dentro do payload assinado e nunca em claro (A-08).

Exceção declarada: listas pequenas e limitadas (contas, cartões, categorias, tags, planejamentos de uma competência) não paginam. Relatórios agregam, não paginam.

### 4.3 Onde mora o filtro

**No banco, sempre.** Com keyset a aplicação nunca tem o conjunto completo; filtrar em memória produziria resultado errado, não apenas lento.

A gramática vive em `packages/contracts/filtro-lancamentos`, e desde esta revisão em **duas formas derivadas de uma base**:

```ts
zFiltroBase = {
  periodo:   { granularidade, de, ate },   // fronteira [de, ate), janela ≤ 5 anos
  eixo:      'competencia' | 'caixa',      // B2 — obrigatório, sem default implícito
  escopo:    'contas' | 'cartoes' | 'ambos',
  natureza:  ('receita' | 'despesa' | 'transferencia')[],   // eixo 1 — Categoria.natureza, nunca o sinal
  situacao:  ('realizado' | 'previsto')[],                  // eixo 2 — realizado = efetivado + pendente
  estrutura: ('fixo' | 'parcelado' | 'estornado' | 'com_tag')[],  // eixo 3
  contas, cartoes, categorias, tags: uuid[],
  busca?, valor_min?, valor_max?
}

zFiltroListagem  = zFiltroBase                       // transferência PODE aparecer como linha
zFiltroAgregacao = zFiltroBase + { baldes: Balde[] } // transferência NUNCA entra em receita/despesa
```

A distinção entre **exibir transferência como linha** e **somá-la num total** está no tipo, não num `AND` (B17). Os três eixos ortogonais corrigem a fraqueza 4 do teardown — o Organizze colapsa 13 opções lineares onde há três dimensões.

**A tradução para SQL acontece num lugar só:** `apps/api/src/agregacao/`. Os cinco relatórios, o rodapé, `faturas.total_centavos` e o realizado do Planejamento chamam a mesma função. Nenhum módulo monta agregação monetária própria — imposto pela regra de lint de §2.5.

### 4.4 O rodapé realizado × previsto — decisão revisada

**Decisão mantida: agregação no banco, interpretação no domínio.** O validador homologou a tese — `SUM` sobre `BIGINT` é exata, associativa e independente de ordem. O que estava errado era **o que entrava na soma**.

**Sete baldes, não quatro (B1).** A versão anterior excluía transferência e não a repunha em lugar nenhum: no extrato de uma conta, a perna que sai do recorte simplesmente sumia do rodapé, e R$ 300,00 desapareciam com a linha visível na tela acima (contraexemplo B).

```sql
SELECT
  SUM(valor_centavos) FILTER (WHERE eh_receita AND realizado)     AS receita_realizada,
  SUM(valor_centavos) FILTER (WHERE eh_receita AND NOT realizado) AS receita_prevista,
  SUM(valor_centavos) FILTER (WHERE eh_despesa AND realizado)     AS despesa_realizada,
  SUM(valor_centavos) FILTER (WHERE eh_despesa AND NOT realizado) AS despesa_prevista,
  SUM(valor_centavos) FILTER (WHERE eh_perna   AND realizado)     AS transferencia_liquida_realizada,
  SUM(valor_centavos) FILTER (WHERE eh_perna   AND NOT realizado) AS transferencia_liquida_prevista
FROM lancamentos l JOIN categorias c ON c.id = l.categoria_id
WHERE l.tenant_id = current_setting('app.tenant_id')::uuid
  AND l.deleted_at IS NULL
  AND /* … mesmo predicado da listagem, mesmo eixo … */;

-- realizado  := settled_at IS NOT NULL OR posted_at <= :agora   -- efetivado + pendente
-- eh_perna   := transfer_group_id IS NOT NULL
-- eh_receita := transfer_group_id IS NULL AND c.analitica AND c.natureza = 'receita'
-- eh_despesa := transfer_group_id IS NULL AND c.analitica AND c.natureza = 'despesa'
```

Três absorções estão nesses quatro predicados, e cada uma corrigiu um erro da revisão 2:

1. **A partição é por `Categoria.natureza`, não pelo sinal do valor.** Um `Estorno` de salário é negativo numa categoria de receita: pelo sinal ele consumiria teto de despesa; pela natureza ele reduz a receita realizada, que é o correto. O `JOIN` com `categorias` é possível porque `categoria_id` passou a ser obrigatório fora das pernas — sem isso a partição teria um buraco silencioso.
2. **`Categoria.analitica` filtra fora do total.** `Ajuste de saldo` é correção de registro, não fato econômico, e sai de todo total de gasto e de todo `Planejamento`, exatamente como a `Transferencia` (ressalva R9).
3. **`realizado` = `efetivado` + `pendente`**, não só `efetivado`. Uma compra de cartão na fatura aberta já aconteceu, e o glossário é explícito: *Saldo não é Realizado*. A revisão 2 usava "compensado", que jogava toda a fatura aberta para o previsto.

O `Estorno` **não ganha balde**: ele é uma linha comum na natureza da categoria do original, com sinal oposto, e reduz o total por soma. É o que faz `original + estorno = 0` sem nenhuma regra especial de agregação.

A perna de transferência nunca entra em receita ou despesa, mas agora tem casa. Com as duas pernas no recorte, `transferencia_liquida` é zero por construção; com só uma, o número aparece e o rodapé para de mentir.

**As identidades, uma por eixo.** Não há uma identidade só, porque `Saldo` e `Realizado` respondem a perguntas diferentes — e somá-los na mesma linha é o que o glossário proíbe:

```
eixo = competencia                          (o rodapé de Lançamentos e os relatórios)
  realizado = receita_realizada + despesa_realizada + transferencia_liquida_realizada
  projetado = realizado + receita_prevista + despesa_prevista + transferencia_liquida_prevista
  -- não existe linha "saldo" neste eixo

eixo = caixa, escopo = contas               (Saldo geral, projeção, Objetivo)
  saldo     = saldo_anterior + Σ (lançamentos de Conta com settled_at no período)
  projetado = saldo
            + Σ (lançamentos de Conta não compensados, por posted_at, até a data)
            + Σ (saldo devedor das Faturas não pagas com vencimento até a data)
```

Sinal vive no valor, então tudo é soma. `domain/agregacao.identidadeDoResumo(r)` verifica ambas e é chamada em S1 com property-based e afirmada em S2.

**Escopo e eixo qualificam a identidade (R1, R2).** A identidade vale para **um** eixo e **um** escopo:

- `eixo = caixa` **e** `escopo = contas` — as linhas `saldo anterior` e `saldo` aparecem, porque saldo de conta é uma grandeza definida.
- `eixo = competencia`, ou `escopo` incluindo cartões — as linhas de saldo **não** aparecem; o rodapé mostra `realizado` e `projetado`. Somar caixa de conta com dívida de cartão produziria um segundo número para "quanto eu tenho" (contraexemplo G), e chamar Realizado de Saldo é o erro que o glossário nomeia. O rótulo muda, não o cálculo.
- `saldo_anterior` respeita **todas** as contas do recorte, inclusive as com `incluir_no_saldo_geral = false`, porque a lista as exibe. O `Saldo geral` da Visão geral honra a flag. São dois números diferentes, cada um rotulado com o seu escopo — a divergência do contraexemplo F passa a ser explicada na tela, não descoberta pelo usuário.

**`saldo_anterior`** vem de `saldo_snapshots` do **mesmo eixo** do recorte, no dia civil anterior ao início do período, no fuso do tenant; cai para a soma derivada quando o snapshot está ausente ou stale. A fonte usada aparece na resposta (`fonte: 'snapshot' | 'derivado'`).

**Por que não somar na aplicação.** O rodapé é do **período inteiro**, não da página. Com keyset a aplicação tem 50 de 4.000 linhas.

**A garantia contra divergência.** `GET /lancamentos` e `GET /lancamentos/resumo` derivam do **mesmo `zFiltroBase`** e chamam o **mesmo tradutor**. O teste de S2, agora corretamente enunciado: *somar todas as páginas da listagem, distribuindo cada linha no seu balde, dá exatamente o resumo* — incluindo as pernas de transferência, que a listagem exibe e o resumo agora contabiliza em balde próprio.

---

## 5. Jobs e filas

BullMQ sobre Redis. Quatro filas:

| Fila | Onde roda | Concorrência | Conteúdo |
|---|---|---|---|
| `interativa` | `worker` | 4 | Promover brutos, conciliar |
| `manutencao` | `worker` | 2 | Saldo, recorrência, fatura, objetivo, retenção |
| `externa` | `worker` | 1 | Sincronização e notificação — rate limit e backoff |
| **`parsing`** | **`parser`** | 1 por tenant | **Só** parsing de arquivo enviado por usuário |

Todo processador é função pública do módulo dono (§2.4a), recebe `deps` explícitas e retorna `Result`. Todo job roda sob `mavia_jobs`, com `SET LOCAL app.tenant_id` por tenant. **Nenhum job usa `BYPASSRLS`.**

### 5.1 `outbox.publicar` — corrigido (A-01)

Redis não participa do commit do Postgres: enfileirar dentro da transação é impossível, enfileirar depois perde eventos.

A versão anterior varria `outbox WHERE publicado_em IS NULL` globalmente — uma leitura cross-tenant sobre uma tabela com `payload JSONB` contendo descrição e valor de lançamentos de todos os clientes, contradizendo o próprio veto de `BYPASSRLS`. Corrigido:

- **Gatilho:** o poller lê `outbox_pendencias WHERE tem_pendencia` — tabela-agulha de duas colunas, sem dado financeiro, mantida por trigger em `outbox`. Enumera os tenants com trabalho, e então abre **uma transação por tenant** com `SET LOCAL app.tenant_id`, sob RLS.
- **Idempotência:** `jobId = outbox:${id}`; `UPDATE outbox SET publicado_em = now() WHERE id = $1 AND publicado_em IS NULL RETURNING id` reivindica a linha.
- **Duas vezes:** a segunda não reivindica. Todos os consumidores abaixo já são idempotentes — defesa em profundidade.
- **Critério de aceite:** `mavia_jobs` sem `app.tenant_id` definido lê **zero** linhas de `outbox`.

### 5.2 Os jobs

| Job | Gatilho | Idempotência | Se rodar duas vezes |
|---|---|---|---|
| `saldo.materializar` | Outbox `lancamento.*` **e `fatura.*`**, debounce por `(tenant, conta, eixo)` | Upsert em `(tenant_id, conta_id, eixo, data_civil)`; recalcula do dia afetado em diante | Mesmo valor. Função do estado, não do delta. **Materializa os dois eixos**, cada um com sua `Data civil`. No eixo caixa compõe as duas fontes: lançamentos de Conta e saldo devedor das `Fatura`s não pagas — o gatilho por `fatura.*` existe porque fechar ou pagar uma fatura muda o saldo projetado sem tocar em `lancamentos` de conta nenhuma |
| `saldo.reconciliar` | Cron 03:10 no fuso do tenant; após cada importação | Mesmo upsert | Idêntico. **Divergência é incidente:** grava em `auditoria` com o delta, alerta o operador, e só então corrige o cache. A métrica publicada é **contador de ocorrências + histograma de faixa de grandeza**, nunca o valor em centavos, e sem label de tenant (A-07); o valor vive em `auditoria`, que é autenticada |
| `recorrencia.materializar` | Cron 02:00; ao criar/editar recorrência | `UNIQUE (tenant_id, recorrencia_id, recorrencia_competencia)` + `ON CONFLICT DO NOTHING` | Zero linhas novas. Horizonte de 12 meses. Nunca toca ocorrência compensada nem com `editado_manualmente` |
| `fatura.fechar` | Cron horária | `UPDATE … WHERE estado='aberta' AND fecha_em <= now()`; a próxima entra por `UNIQUE (tenant_id, cartao_id, periodo_inicio)` e pelo `EXCLUDE` de intervalo | Segunda execução não encontra fatura `aberta`: no-op. Congela `total_centavos` **calculado por `agregacao`, com as pernas de transferência excluídas** (B8) |
| `fatura.marcar_vencida` | Cron diária 00:30 | Transição condicional | No-op |
| `sync.executar` | Cron por conexão (≤ 6×/dia) · rota manual · upload | (a) `jobId = sync:${conexao_id}:${janela}`; (b) `UNIQUE (tenant_id, provider, external_id)` e `(…, conteudo_hash)`, **sem filtro de `deleted_at`** (A-06) | `ignorados` sobe, `criados` fica zero. Reimportar o mesmo OFX é sempre no-op no nível do bruto, inclusive depois de o lançamento ter sido excluído |
| `ingestao.promover` | Outbox `sincronizacao.concluida`; rota manual | `UNIQUE (tenant_id, lancamento_bruto_id)` | Nenhum lançamento novo. Repromover um bruto cujo lançamento foi excluído exige ação explícita do usuário e gera entrada em `auditoria` |
| `conciliacao.sugerir` | Outbox `bruto.promovido` | `UNIQUE (tenant_id, lancamento_bruto_id, lancamento_id)`; **nunca escreve em `lancamentos`** | Mesma sugestão, nenhuma sobrescrita (regra 15) |
| `categorizacao.aplicar` | Outbox `lancamento.criado` sem categoria | Só age se `categoria_id IS NULL AND origem <> 'manual' AND NOT editado_manualmente`; grava o `motivo` | Segunda não encontra candidato |
| **`objetivo.avaliar`** | **Outbox `lancamento.*` da conta ancorada + cron diária 06:00** | Grava `concluido_em` só na transição `progresso < alvo → progresso >= alvo`, com `UPDATE … WHERE concluido_em IS NULL` | **B20.** Sem este job, "primeira travessia" significava "primeira leitura da tela" e a conclusão nunca era gravada (contraexemplo AB). Rodar duas vezes: a guarda `concluido_em IS NULL` impede regravar; resgate posterior não desfaz |
| `alertas.avaliar` | Cron 07:00; outbox `lancamento.*` | `chave_dedup = hash(tipo, entidade_id, competencia_ou_dia, faixa_pct)` com `UNIQUE (tenant_id, chave_dedup)` | Nenhuma duplicata. Avalia planejamentos (com `domain/razao`, comparação de limiar respeitando o sinal do denominador), contas a pagar, fatura fechando e vencendo, objetivo, saldo projetado negativo. **Suprime o alerta do filho quando o pai já alertou no mesmo ciclo** (ressalva R12) |
| `notificacao.enviar` | `notificacoes` agendadas | `UPDATE … SET enviado_em = now() WHERE id = $1 AND enviado_em IS NULL RETURNING` | Segunda não reivindica. Backoff exponencial, 5 tentativas, `dead-letter` com métrica. **Corpo de push e e-mail não contém valor monetário** (A-43) |
| `exportacao.gerar` | `POST /exportacoes` já reautenticado | Chave = `exportacao_id` | Mesmo arquivo. Toda célula CSV passa por `arquivos/csv.celulaSegura` (A-35) |
| **`exportacao.purgar`** | Cron horária | Declarativo: `expira_em < now()` | **Apaga o objeto do storage**, não só a linha (A-28) |
| `retencao.aplicar` | Cron 04:00; outbox `consentimento.revogado` | Converge para o estado alvo | No-op quando já convergido. **A revogação de conexão zera `dek_cifrada` e `credenciais_cifradas` na mesma transação da revogação** — crypto-shredding síncrono, não job (o job trata só o que sobra) |
| `anexo.ocr` | Outbox `anexo.criado` | Chave = `anexo_id` | Mesmo resultado. **Roda na fila `parsing`, no processo `parser`.** Sugere; nunca preenche valor monetário sem confirmação |

### 5.3 Parsing como fronteira de processo (A-32, A-33, A-34)

Todo arquivo enviado por usuário — OFX, CSV, PDF, imagem — é parseado no processo `parser`, descartável por arquivo, com:

- usuário sem privilégio; **sem variáveis de ambiente de segredo** (a KEK e a `DATABASE_URL` não existem nesse ambiente); **sem acesso de rede**; filesystem somente-leitura exceto um `tmpfs` do tamanho do arquivo; cgroup de memória e CPU; `seccomp` restritivo; timeout duro com `SIGKILL`.
- **DTD desabilitada e resolução de entidades externas desabilitada**, por configuração explícita, nunca pelo padrão da biblioteca. Profundidade máxima 20, máximo 100.000 nós.
- Comunicação por arquivo de entrada e JSON de saída **validado por Zod**: o processo pai não confia na saída do filho.
- O conteúdo parseado nunca é ecoado sem escape na tela de revisão.

O ganho arquitetural: o processo que desembrulha DEKs e usa credenciais bancárias (`worker`) e o processo que lê arquivo hostil (`parser`) **deixam de ser o mesmo**. Um XXE ou um RCE de biblioteca nativa no `parser` não alcança a KEK nem o banco.

### 5.4 Onde os jobs são testados

Em **S2**, sem seam novo: o teste cria estado por HTTP, chama a função do processador **duas vezes** com Postgres real, e verifica por HTTP. Os payloads hostis do parser são fixtures de **S3**. O isolamento do processo é verificação de deploy (§2.6).

---

## 6. Mapa tela → endpoint

Alinhado a `docs/produto/arquitetura-informacao.md` §2. Cada linha é o conjunto **completo** que a tela consome.

### 6.1 Web

| Tela | Endpoints |
|---|---|
| Login / Cadastro | `POST /auth/entrar` · `/registrar` · `/senha/recuperar` · `POST /auth/mfa/verificar` |
| Onboarding (§2.15) | `GET /auth/eu` · `POST /contas` · `GET /categorias` · `PUT /preferencias` |
| **Visão geral** (§2.1) | `GET /contas/saldos?eixo=caixa` · `GET /lancamentos/resumo?eixo=competencia&escopo=contas` · `GET /lancamentos/agenda` · `GET /cartoes` · `GET /relatorios/categorias?limite=5` · `GET /planejamentos` · `GET /objetivos` · `GET /alertas` |
| **Lançamentos** (§2.2) | `GET /lancamentos` · **`GET /lancamentos/resumo`** · `GET /contas` · `GET /cartoes` · `GET /categorias` · `GET /tags` · `POST /lancamentos/lote` · `POST /lancamentos/:id/compensar` |
| Formulário (§2.3) | `POST /lancamentos` · `PATCH /lancamentos/:id` · `POST /transferencias` · `POST /parcelamentos` · `POST /recorrencias` · `GET /categorias` · `GET /tags` · `POST /anexos` · `POST /inteligencia/sugerir-categoria` |
| Cartões (§2.4) | `GET /cartoes` · `GET /cartoes/:id/faturas` |
| **Fatura** (§2.5) | `GET /faturas/:id` · `/lancamentos` · `POST /faturas/:id/pagamentos` · `/fechar` · `/reabrir` |
| Planejamento (§2.6) | `GET /planejamentos?competencia=` · `PUT /planejamentos` · `POST /planejamentos/copiar` · `GET /categorias` |
| Relatórios (§2.7) | `GET /relatorios/categorias` · `/entradas-saidas` · `/contas` · `/tags` · `/evolucao` · `GET /preferencias` |
| Contas (§2.8) | `GET /contas` · `POST` · `PATCH` · `/arquivar` |
| Categorias (§2.9) | `GET /categorias` · `POST` · `PATCH` · `/arquivar` |
| Importação (§2.10) | `POST /importacoes` · `GET /:id` · `GET /:id/brutos` · `POST /:id/promover` · `GET /conciliacoes` · `POST /conciliacoes/:id/aceitar` |
| Conexões (§2.11) | `GET /conexoes` · `POST` · `/sincronizar` · `DELETE` · `/sincronizacoes` |
| Objetivos | `GET /objetivos` · `POST` · `PATCH` · `POST /objetivos/:id/aportes` |
| Recorrências (§2.14) | `GET /recorrencias` · `POST` · `PATCH` · `DELETE` · `GET /:id/ocorrencias?ate=` |
| Config › Preferências (§2.12) | `GET /preferencias` · `PUT` · `POST /exportacoes` · `GET /exportacoes/:id` |
| Config › Segurança | `GET /auth/sessoes` · `DELETE /auth/sessoes/:id` · `POST /auth/sessoes/revogar-todas` · `POST /auth/mfa/inscrever` · `/recuperacao` |
| Config › Membros | `GET /membros` · `POST /convites` · `PATCH /membros/:usuarioId` · `DELETE /membros/:usuarioId` |
| Config › Apps conectados | `GET/POST/DELETE /integracoes/chaves` · `GET/DELETE /integracoes/mcp` |
| Config › Etiquetas / Alertas | `GET/POST/PATCH /tags` · `GET/PUT /alertas/preferencias` |
| Atividades (§2.13) | `GET /atividades` · `GET /contas` · `GET /categorias` |
| Sino | `GET /alertas` · `POST /alertas/:id/lido` |

### 6.2 Mobile

| Tela | Endpoints |
|---|---|
| Login + biometria | `POST /auth/entrar` · `/refresh` · `/mfa/verificar` |
| Lançamento rápido | `POST /lancamentos` (fila offline) · caches locais de `/categorias` e `/contas` |
| Extrato | `GET /lancamentos` · `GET /lancamentos/resumo` |
| Visão geral | `GET /contas/saldos` · `GET /lancamentos/agenda` |
| Fatura | `GET /cartoes/:id/faturas` · `GET /faturas/:id` |
| Sincronização | `POST /sync/mutacoes` · `GET /sync/mudancas?desde=` |

### 6.3 Achados do mapa

- **Todos os endpoints antes órfãos entraram em §4.1** e portanto em `contracts`: `/sync/*` (A-29), `/anexos` (A-31), `/inteligencia` (A-30), `/integracoes` (A-40), `/auth/sessoes` e `/auth/mfa` (A-15, A-17). Não resta nenhuma rota no mapa de telas sem contrato declarado.
- **Sem endpoint órfão de negócio.** Toda rota de §4.1 tem consumidor identificado.
- **Endpoints sem tela no MVP:** `objetivos` (épico 8), `membros` (10), `conexoes` (12), `integracoes` (pós-MVP). Declarados para não serem confundidos com órfãos.
- **`GET /metricas` saiu do mapa e de `/v1`** (A-07).

---

## 7. Decisões que exigem ADR

Renumeradas: **0001–0009, 0018 e 0019 já estão escritas** — 0018 é o envelope encryption e 0019 é a revogação no `BankSyncProvider`, ambas de outros autores. As desta tabela seguem propostas, não escritas.

| # | Decisão | Por que merece ADR |
|---|---|---|
| **0010** | Dois eixos temporais explícitos (`competencia`/`posted_at` × `caixa`/`settled_at`), com o eixo na chave de `saldo_snapshots` e no contrato de filtro; dia civil sempre no fuso do tenant | Resolve B2 e B3. Declarar uma coluna só quebraria uma das duas leituras que o produto precisa; o eixo na chave torna a ambiguidade inexprimível |
| **0011** | `settled_at` é a única coluna temporal de compensação; `status` é derivado; a previsão de desembolso do cartão vive na `Fatura`, e o eixo caixa compõe lançamentos de Conta com `Fatura`s não pagas | Resolve B4. Sem a separação, toda compra de cartão nasce realizada; com uma previsão persistida em `lancamentos`, o cartão entraria num eixo a que não pertence e pela conta errada. Registra também a regra que impede a dupla contagem fatura × perna de pagamento |
| **0012** | Toda agregação monetária passa por um tradutor único; transferência tem balde próprio e nunca entra em receita ou despesa | Resolve B1 e B17, o bloqueio isolado mais grave. A exclusão deixa de ser um `AND` que alguém repete e passa a ser tipo mais lint |
| **0013** | Fatura `fechada` é imutável; reabertura é explícita, restrita a `proprietario` e auditada | Define o destino do lançamento retroativo — a pergunta da primeira semana de uso real |
| **0014** | Transactional outbox com `tenant_id`, RLS e poller por tabela-agulha; nenhum papel com `BYPASSRLS` | Resolve A-01. A resolução ingênua (dar `BYPASSRLS` ao worker) derrubaria o isolamento de sync, OCR e exportação |
| **0015** | Cursor keyset assinado por HMAC, vinculado a tenant e filtro, resolvido aritmeticamente | Resolve A-09 e A-10. Um cursor resolvido por lookup vira oráculo de existência cross-tenant |
| **0016** | Parsing de arquivo de usuário em processo `parser` descartável, sem segredo e sem rede | Resolve A-32/33/34, o vetor que compromete todos os tenants de uma vez. É decisão de topologia de processo, não de biblioteca |
| **0017** | Processador de job é função pública do módulo; a fila só registra | Evita um seam novo (§2.4a). Sem registro, a primeira sessão que usa `@Processor()` o desfaz |
| **0020** | Papéis de banco, resolução de tenant em quatro etapas, e as duas exceções declaradas de leitura sem contexto | Resolve A-02, A-03, A-05. Complementa o ADR 0004 com o *como*; errar aqui falha em silêncio |
| **0021** | `packages/ui` importa apenas `packages/domain` | Fronteira de pacote; sem registro, a primeira sessão que precisa de um tipo de resposta acopla o design system à API |
| **0022** | Moeda única por tenant no MVP, imposta no banco | Resolve B19: hoje o modelo permite criar o estado (duas moedas) para o qual a tela principal não tem número correto possível |
| **0023** | Exportação é operação privilegiada: reautenticação, teto, auditoria, notificação ao titular e TTL curto de uso único | Resolve A-28. É a rota mais valiosa do produto para uma sessão roubada, e mais barata que paginar 4.000 lançamentos |
| **0024** | Identificadores de tabela de negócio são UUID v4 (não v7) | ADR 0004 exige "não sequencial"; v7 vaza ordem de criação. O custo de localidade de escrita precisa estar registrado como aceito |
| **0025** | Política de conflito offline é pura e mora em `packages/domain` | Evita o segundo seam novo (§2.4b) e impede regra de negócio em `apps/mobile` |

---

## 8. Vetos declarados

Exercidos agora, para não serem re-litigados em code review:

1. **Nenhuma soma monetária fora de `apps/api/src/agregacao/`.** Imposto por lint, sobre **todas** as colunas monetárias, não só `valor_centavos` (§2.5). É a defesa estrutural contra o erro que mata a categoria, e ela vale o quanto a lista de colunas for completa.
2. **Nenhuma soma monetária em `NUMERIC`, `float` ou casting implícito.** `SUM` sobre `BIGINT` de centavos, ou nada.
3. **Nenhum cálculo de rodapé sobre a página corrente.** O resumo é do período; a página não é o período.
4. **Nenhuma resposta de rodapé, relatório ou saldo sem `eixo` declarado.** Grandeza sem eixo é grandeza de dois valores.
5. **Nenhum `::date` sobre `TIMESTAMPTZ` sem `AT TIME ZONE` explícito.** É como o contraexemplo D faz R$ 500,00 sumirem do ano.
6. **`lancamentos.fatura_id` nunca aponta para a fatura que uma transferência paga.** O vínculo é `transferencias.fatura_id`, e só ele.
7. **Nenhum seam novo** em repositório Drizzle, serviço NestJS interno ou componente isolado de `packages/ui`. Lista fechada de seis seams; ampliar exige ADR.
8. **Nenhum papel de banco que atende requisição ou job com `BYPASSRLS`**, e nenhuma leitura sem contexto de tenant além das duas exceções nomeadas em §3.9.
9. **Nenhum processo que manipula DEK executa parsing de arquivo de usuário.**
10. **Nenhum `id` de tenant em path de rota.** O tenant vem do contexto; duas fontes de verdade é IDOR.
11. **Nenhum cursor resolvido por lookup de `id`.**
12. **`Conta` tem `tipo`.** Não copiar a fraqueza 2 do Organizze.
13. **`packages/ui` não importa `packages/contracts`; nenhum `packages/*` importa `apps/*`.**
14. **Regra de ciclo de fatura, sinal, rateio, razão ou fuso em `apps/`.** Chamar `domain` do cliente é correto; reimplementar não é. E data vinda do cliente é sugestão validada pelo servidor, nunca autoridade.

---

## 9. Dependências externas desta revisão

O que este documento assume e **não** pode corrigir sozinho. Enquanto não estiver resolvido, o épico não sai de §4 da pipeline.

| Preciso de | De quem | Bloqueio |
|---|---|---|
**Resolvidos na revisão 3** e removidos desta lista: B4 (`settled_at` adotado, previsão na `Fatura`), B9 (`Estorno` cunhado), B10 (regra única de rateio, com a invariante de dispersão `max − min <= 1` que a distingue), B14 (realizado particionado por `Categoria.natureza`, com `categoria_id` obrigatório), B21 e B23.

| Preciso de | De quem | Bloqueio |
|---|---|---|
| Retroativo: definição de `Fatura` compatível com "anexado à fatura aberta mais antiga", e o quarto balde da composição | `arquiteto-dominio-financeiro` | B7 — muda a composição da fatura e o critério C5. §4.4 já compõe quatro baldes; falta a regra de atribuição |
| `docs/arquitetura/autorizacao.md` — a matriz papel × ação × recurso | terceiro agente | A-12 — §4.0 declara o mecanismo e depende da tabela |
| Política de retenção e o fluxo de eliminação | terceiro agente | B-01, B-03 |
| **ADR 0018** — envelope encryption | terceiro agente | A-37 — as colunas `kek_versao` e `dek_criada_em` já estão em §3.5 |

---

## 10. Objeções aos achados do gate

Dois achados aceitos com ressalva, e o porquê. Nenhum deles é rejeitado; ambos são cumpridos numa forma diferente da prescrita.

### 10.1 A-25 — "o `payload` bruto nunca sai da API, em nenhuma rota, para nenhum papel"

**Cumpro o achado, contesto o absoluto.** A allowlist em `zBrutoResposta` está em §4.1 e resolve o risco real, que é a tela de revisão da importação devolver agência, conta e chave Pix de terceiro a cada passo do fluxo.

Mas "nenhuma rota, nenhum papel" colide com **B-02**, do mesmo gate, que exige que a exportação enumere todas as entidades do titular. O `LancamentoBruto` é, em parte, dado do próprio titular, e o `CONTEXT.md` o preserva justamente para auditoria e reprocessamento. Negá-lo em absoluto significa que o titular não consegue exportar um dado que a Mavia guarda sobre ele — o que é o problema oposto.

**Resolução proposta:** allowlist em toda resposta **interativa** (A-25 satisfeito integralmente); inclusão no artefato de **exportação** — que já é reautenticado, limitado a 3/h, auditado e notificado por A-28/0023 — com redação declarada dos identificadores de **terceiros** (chave Pix, conta e documento da contraparte), que não são dado do titular. Se o `especialista-lgpd-compliance` preferir excluir o bruto também da exportação, aceito sem discussão: é decisão de base legal, não de arquitetura. O que não pode ficar é a contradição não nomeada entre A-25 e B-02.

### 10.2 A-33 — "uploads simultâneos por tenant: 1"

**Contesto o número, aceito o controle.** O limite serial no *upload* quebra o caminho de onboarding que o próprio produto define: quem chega traz o histórico, e isso são doze arquivos OFX mensais. Com o limite literal, o usuário recebe rejeição em onze deles e conclui que a importação está quebrada — exatamente o que `arquitetura-informacao.md` §2.10 proíbe ("nunca 'erro ao processar'").

**Contraexemplo:** cliente novo arrasta 12 OFX de 2026 na tela de importação. Comportamento com A-33 literal: 1 aceito, 11 rejeitados por concorrência. Comportamento pretendido: 12 aceitos, 1 processado por vez.

**Resolução proposta:** o limite de concorrência 1 por tenant vive na **fila `parsing`** (§5), não no aceite do upload. `POST /importacoes` aceita e enfileira até 12 arquivos por requisição, dentro do rate limit de 3/h e do teto de 10 MB por arquivo. A proteção de recurso é idêntica — nunca há mais de um parse por tenant em execução, e o cgroup do `parser` continua sendo o teto real —, e o produto funciona. O risco que A-33 mira é exaustão de memória e CPU, e ele é controlado pela concorrência de execução, não pela contagem de arquivos aceitos.

### 10.3 O eixo caixa com duas fontes — o que registro

A decisão do B4 é melhor que a minha e a adoto sem ressalva: o join desapareceu em vez de ser assumido, e a previsão foi para onde o fato mora. Mas compor um eixo a partir de **duas tabelas** cria quatro efeitos no `agregacao` que não existiam quando a fonte era uma só. Registro os quatro; os dois primeiros já estão resolvidos no documento, os dois últimos são dívida com dono.

1. **Pagamento parcial exigia corrigir a instrução.** "Fatura pelo total no vencimento" conta duas vezes a parte já paga: uma na perna de débito compensada, outra dentro do total. A fatura contribui com o **saldo devedor** (`total_centavos + pago_centavos`). Está em §3.7, com a invariante de S2 nos três estados.

2. **A superfície da regra de lint dobrou.** Toda a garantia do B17 é "existe um caminho só para somar dinheiro". Com `faturas` virando fonte monetária, `total_centavos` e `pago_centavos` entram na lista da regra de §2.5 — senão abre-se um segundo caminho de agregação legítimo e fora do módulo, que é precisamente como o erro clássico da categoria voltaria.

3. **A projeção por conta pode estar certa no total e errada na linha.** `faturas.conta_pagamento_id` é congelado na criação do ciclo. Se o usuário pagar a fatura de outra conta, a projeção atribuiu a saída à conta errada até o pagamento acontecer — o `Saldo geral` fica correto, o saldo projetado *daquela conta* não. Ele se autocorrige no pagamento. É aceitável e precisa estar rotulado na tela; não é aceitável descobrir isso pelo suporte.

4. **`incluir_no_saldo_geral = false` na conta de pagamento esconde dívida real.** Uma fatura cuja conta de pagamento está fora do Saldo geral tem seu saldo devedor excluído da projeção agregada, embora o gasto no cartão seja real. As duas flags são ortogonais por desenho, e o cruzamento delas produz um número defensável e surpreendente. Precisa de decisão de produto — proibir a combinação, ou exibi-la com rótulo. Vai para `product-financeiro` como ressalva, não bloqueia.

Nenhum dos quatro põe em dúvida a decisão. O terceiro e o quarto existem porque cartão e conta são entidades diferentes com um vínculo mutável, e isso é do domínio, não da arquitetura.
