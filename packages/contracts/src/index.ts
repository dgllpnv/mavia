import { z } from 'zod'

/**
 * @mavia/contracts — a fonte única de verdade da API.
 *
 * Nada entra no domínio sem passar por um schema daqui (`CLAUDE.md` §6). Web e
 * mobile importam estes mesmos tipos, de modo que uma mudança de contrato
 * quebra o typecheck dos clientes em vez de virar defeito em produção.
 */

/**
 * Dinheiro viaja como **string de centavos**, nunca como número.
 *
 * `bigint` não sobrevive a `JSON.stringify`, e `number` perde precisão a partir
 * de 2^53 centavos. String é a única forma que atravessa a rede sem perder
 * nada, e obriga o cliente a fazer a conversão de propósito em vez de por
 * acidente (ADR 0005).
 */
export const zCentavos = z
  .string()
  .regex(/^-?\d+$/, 'centavos deve ser um inteiro em string, sem separador decimal')

export const zMoeda = z.enum(['BRL', 'USD', 'EUR'])
export const zUuid = z.string().uuid()

export const zTipoDeConta = z.enum([
  'corrente',
  'poupanca',
  'dinheiro',
  'investimento',
  'digital',
  'outra',
])

/**
 * De onde veio uma **conta** (`origem_do_dado`): digitada, ou trazida por uma
 * conexão bancária.
 */
export const zOrigemDaConta = z.enum(['manual', 'conectado'])

/**
 * De onde veio um **lançamento** (`lancamento_origem`). São cinco valores, e
 * eles **não** são os mesmos da conta.
 *
 * Os dois campos se chamam `origem` e respondem a perguntas diferentes; reusar
 * um tipo para ambos fez o contrato prometer `conectado` num campo onde esse
 * valor não existe, e esconder `parcelamento`, que é o que o filtro do extrato
 * precisa para separar compromisso futuro de gasto do mês.
 */
export const zOrigemDoLancamento = z.enum([
  'manual',
  'importado',
  'recorrencia',
  'parcelamento',
  'ajuste',
])

export const zCriarConta = z.object({
  nome: z.string().trim().min(1, 'informe um nome').max(80),
  tipo: zTipoDeConta.default('corrente'),
  saldoInicialCentavos: zCentavos.default('0'),
  moeda: zMoeda.default('BRL'),
  // Ausente significa "usa o padrão do tipo": investimento nasce fora do saldo
  // geral, o resto nasce dentro. Quem decide depois é o usuário.
  incluirNoSaldoGeral: z.boolean().optional(),
})

export const zConta = z.object({
  id: zUuid,
  nome: z.string(),
  tipo: zTipoDeConta,
  origem: zOrigemDaConta,
  saldoInicialCentavos: zCentavos,
  moeda: zMoeda,
  incluirNoSaldoGeral: z.boolean(),
  criadoEm: z.string().datetime(),
})

export const zListaDeContas = z.object({
  itens: z.array(zConta),
})

export type Centavos = z.infer<typeof zCentavos>
export type Moeda = z.infer<typeof zMoeda>
export type TipoDeConta = z.infer<typeof zTipoDeConta>
export type CriarConta = z.infer<typeof zCriarConta>
export type Conta = z.infer<typeof zConta>
export type ListaDeContas = z.infer<typeof zListaDeContas>

/** O padrão de `incluir_no_saldo_geral` derivado do tipo (`CONTEXT.md`, Conta). */
export function incluiNoSaldoGeralPorPadrao(tipo: TipoDeConta): boolean {
  return tipo !== 'investimento'
}

// ---------------------------------------------------------------------------
// Categorias
// ---------------------------------------------------------------------------
export const zNatureza = z.enum(['receita', 'despesa'])

export const zCriarCategoria = z.object({
  nome: z.string().trim().min(1).max(60),
  /**
   * Ignorada quando há `parentId`: a filha **herda** a natureza da mãe.
   *
   * Uma filha de despesa que fosse receita faria a soma da árvore misturar os
   * dois sinais no mesmo galho, e o relatório de categoria deixaria de fechar
   * com o rodapé do extrato.
   */
  natureza: zNatureza,
  /** Ausente cria uma raiz. Presente cria a filha dela — e só isso: a árvore
   *  tem dois níveis, e uma neta não existe. */
  parentId: zUuid.optional(),
})

export const zAlterarCategoria = z
  .object({
    nome: z.string().trim().min(1).max(60).optional(),
    natureza: zNatureza.optional(),
  })
  .refine((c) => c.nome !== undefined || c.natureza !== undefined, {
    message: 'informe o que mudar',
  })

export const zCategoria = z.object({
  id: zUuid,
  nome: z.string(),
  natureza: zNatureza,
  nivel: z.union([z.literal(1), z.literal(2)]),
  parentId: zUuid.nullable(),
  analitica: z.boolean(),
  /**
   * Arquivada continua sendo devolvida, e é por isso que o campo existe.
   * Lançamento antigo aponta para categoria arquivada; omiti-la da resposta
   * deixaria a linha do extrato sem nome. O cliente a esconde do seletor, não
   * do dicionário.
   */
  arquivada: z.boolean(),
  /** Categoria que o espaço não criou e não pode apagar. */
  sistema: z.boolean(),
  cor: z.string().nullable(),
})

// ---------------------------------------------------------------------------
// Lançamentos
// ---------------------------------------------------------------------------
export const zStatus = z.enum(['previsto', 'pendente', 'efetivado'])

export const zCriarLancamento = z.object({
  contaId: zUuid,
  categoriaId: zUuid,
  // Com sinal: despesa é negativa, receita é positiva. O servidor confere
  // contra a natureza da categoria e recusa a discordância.
  valorCentavos: zCentavos,
  postedAt: z.string().datetime(),
  /** Marcar como já compensado no ato — o "lançamento pago" do formulário. */
  compensado: z.boolean().default(false),
  descricao: z.string().trim().min(1).max(140),
  observacao: z.string().trim().max(1000).optional(),
})

export const zLancamento = z.object({
  id: zUuid,
  contaId: zUuid.nullable(),
  categoriaId: zUuid.nullable(),
  valorCentavos: zCentavos,
  moeda: zMoeda,
  postedAt: z.string().datetime(),
  settledAt: z.string().datetime().nullable(),
  status: zStatus,
  descricao: z.string(),
  transferGroupId: zUuid.nullable(),
  estornoDeLancamentoId: zUuid.nullable(),

  /**
   * Conta **ou** cartão, nunca os dois: `uma_origem_de_dinheiro` é `CHECK` no
   * banco, e o contrato reflete a restrição em vez de inventar um dos dois.
   */
  cartaoId: zUuid.nullable(),
  /** A fatura à qual o lançamento pertence. Nulo fora do cartão. */
  faturaId: zUuid.nullable(),

  /**
   * Numeração da parcela — nula quando não há parcelamento.
   *
   * Nula, e não `1/1`: um "1/1" no extrato afirma um parcelamento que não
   * existe, e o usuário sairia procurando as outras parcelas.
   */
  installmentGroupId: zUuid.nullable(),
  installmentNumero: z.number().int().nullable(),
  installmentTotal: z.number().int().nullable(),

  /**
   * De onde veio a categoria, quando ela não veio de uma pessoa.
   *
   * Nulo é **decisão humana** — e é o que torna a reversão observável: trocar a
   * categoria à mão limpa os dois campos, e o lançamento deixa de constar como
   * automático porque deixou de ser.
   */
  classificacaoOrigem: z.enum(['regra', 'historico']).nullable(),
  /**
   * A frase em português que explica a classificação, para a tela.
   *
   * A frase, e não o identificador da regra: guardar o identificador faria a
   * explicação mudar quando a regra mudasse, e o lançamento passaria a dizer
   * que foi classificado por um motivo que não existia quando ele foi
   * classificado.
   */
  classificacaoMotivo: z.string().nullable(),

  /** Terceiro eixo de filtro do extrato: o que o usuário digitou e o que veio. */
  origem: zOrigemDoLancamento,
})

// ---------------------------------------------------------------------------
// Transferência — sempre as duas pernas juntas
// ---------------------------------------------------------------------------
export const zCriarTransferencia = z
  .object({
    deContaId: zUuid,
    paraContaId: zUuid,
    /** Magnitude, sempre positiva. O sinal de cada perna é derivado. */
    valorCentavos: zCentavos.regex(/^\d+$/, 'o valor da transferência é positivo'),
    postedAt: z.string().datetime(),
    compensado: z.boolean().default(false),
    descricao: z.string().trim().min(1).max(140),
  })
  .refine((t) => t.deContaId !== t.paraContaId, {
    message: 'origem e destino precisam ser contas diferentes',
  })

// ---------------------------------------------------------------------------
// Estorno
// ---------------------------------------------------------------------------
export const zCriarEstorno = z.object({
  /** Magnitude do que se desfaz. O sinal vem do original. */
  valorCentavos: zCentavos.regex(/^\d+$/, 'a magnitude do estorno é positiva'),
  postedAt: z.string().datetime(),
  descricao: z.string().trim().min(1).max(140).optional(),
})

// ---------------------------------------------------------------------------
// Resumo do período — os sete baldes mais os dois totais
// ---------------------------------------------------------------------------
export const zResumo = z.object({
  saldoAnterior: zCentavos,
  receitaRealizada: zCentavos,
  receitaPrevista: zCentavos,
  despesaRealizada: zCentavos,
  despesaPrevista: zCentavos,
  transferenciaLiquidaRealizada: zCentavos,
  transferenciaLiquidaPrevista: zCentavos,
  // Lançamento que altera o saldo sem ser gasto nem ganho — "Ajuste de saldo".
  // Tem linha própria porque sem ela a identidade do rodapé não fecha.
  naoAnaliticaRealizada: zCentavos,
  naoAnaliticaPrevista: zCentavos,
  saldo: zCentavos,
  projetado: zCentavos,
})

export type Natureza = z.infer<typeof zNatureza>
export type CriarCategoria = z.infer<typeof zCriarCategoria>
export type AlterarCategoria = z.infer<typeof zAlterarCategoria>
export type Categoria = z.infer<typeof zCategoria>
export type StatusDoLancamento = z.infer<typeof zStatus>
export type CriarLancamento = z.infer<typeof zCriarLancamento>
export type Lancamento = z.infer<typeof zLancamento>
export type CriarTransferencia = z.infer<typeof zCriarTransferencia>
export type CriarEstorno = z.infer<typeof zCriarEstorno>
export type Resumo = z.infer<typeof zResumo>

// ---------------------------------------------------------------------------
// Cartão e fatura
// ---------------------------------------------------------------------------
const zDiaDoMes = z.number().int().min(1).max(31)

export const zCriarCartao = z.object({
  nome: z.string().trim().min(1).max(60),
  limiteCentavos: zCentavos.regex(/^\d+$/, 'o limite é positivo').default('0'),
  closingDay: zDiaDoMes,
  dueDay: zDiaDoMes,
  contaPagamentoId: zUuid.optional(),
})

export const zCartao = z.object({
  id: zUuid,
  nome: z.string(),
  limiteCentavos: zCentavos,
  closingDay: zDiaDoMes,
  dueDay: zDiaDoMes,
  contaPagamentoId: zUuid.nullable(),
  moeda: zMoeda,
})

export const zEstadoDeFatura = z.enum([
  'aberta',
  'fechada',
  'parcialmente_paga',
  'paga',
  'vencida',
])

export const zFatura = z.object({
  id: zUuid,
  cartaoId: zUuid,
  /** Data civil: nomeia um dia, não um instante. */
  competencia: z.string(),
  dataFechamento: z.string(),
  dataVencimento: z.string(),
  estado: zEstadoDeFatura,
  totalCentavos: zCentavos,
  pagoCentavos: zCentavos,
})

export const zPagarFatura = z.object({
  /** Magnitude, sempre positiva. A dívida é negativa; o pagamento a reduz. */
  valorCentavos: zCentavos.regex(/^\d+$/, 'o pagamento tem magnitude positiva'),
  pagoEm: z.string().datetime(),
  /** Ausente usa a conta de pagamento congelada na fatura. */
  contaId: zUuid.optional(),
})

// ---------------------------------------------------------------------------
// Compra no cartão
// ---------------------------------------------------------------------------
/**
 * O que o formulário envia. **Uma compra**, não N lançamentos: quem gera as
 * parcelas é o servidor, a partir do ciclo do cartão. Deixar o cliente montar
 * as N linhas seria a segunda implementação do rateio, e ela divergiria.
 */
export const zCriarCompraNoCartao = z.object({
  categoriaId: zUuid,
  /**
   * Com sinal, como todo lançamento: despesa é negativa. O servidor confere
   * contra a natureza da categoria e recusa a discordância — inferir o sinal
   * de um enum `tipo` é exatamente o que a regra 6 proíbe.
   */
  valorCentavos: zCentavos,
  postedAt: z.string().datetime(),
  /**
   * Teto de 72 porque existe: o que não existe é limite implícito. Sem ele,
   * "1000x" gera mil lançamentos e mil faturas numa requisição só.
   */
  parcelas: z.number().int().min(1).max(72).default(1),
  descricao: z.string().trim().min(1).max(140),
  observacao: z.string().trim().max(1000).optional(),
})

export const zParcelaCriada = z.object({
  id: zUuid,
  numero: z.number().int(),
  total: z.number().int(),
  valorCentavos: zCentavos,
  postedAt: z.string().datetime(),
  faturaId: zUuid,
  /** `AAAA-MM`. Nomeia a fatura, não um instante. */
  competenciaDaFatura: z.string().regex(/^\d{4}-\d{2}$/),
})

export const zCompraNoCartao = z.object({
  /** Nulo à vista: um grupo de uma parcela não parcela nada. */
  parcelamentoId: zUuid.nullable(),
  itens: z.array(zParcelaCriada),
})

export type CriarCompraNoCartao = z.infer<typeof zCriarCompraNoCartao>
export type ParcelaCriada = z.infer<typeof zParcelaCriada>
export type CompraNoCartao = z.infer<typeof zCompraNoCartao>

export type CriarCartao = z.infer<typeof zCriarCartao>
export type Cartao = z.infer<typeof zCartao>
export type EstadoDeFatura = z.infer<typeof zEstadoDeFatura>
export type Fatura = z.infer<typeof zFatura>
export type PagarFatura = z.infer<typeof zPagarFatura>

// ---------------------------------------------------------------------------
// Planejamento — teto de despesa e piso de receita
// ---------------------------------------------------------------------------
/**
 * O sinal do valor **é** a natureza: negativo é teto, positivo é piso. Não há
 * campo `natureza` na entrada, e a ausência é o ponto — com ele, o cliente
 * poderia mandar um "piso" com valor negativo, e a contradição precisaria ser
 * resolvida por alguém.
 */
export const zCriarPlanejamento = z.object({
  /** `AAAA-MM`. Planejamento é mensal, e a competência é o mês. */
  competencia: z.string().regex(/^\d{4}-\d{2}$/, 'a competência é `AAAA-MM`'),
  /** Ausente cria o planejamento **global** daquela natureza. */
  categoriaId: zUuid.optional(),
  valorCentavos: zCentavos,
  /** Padrão `[80, 100]`. Percentuais em que o domínio emite evento. */
  alertasPercentuais: z.array(z.number().int().min(1).max(1000)).min(1).optional(),
})

export const zAlterarPlanejamento = z
  .object({
    valorCentavos: zCentavos.optional(),
    alertasPercentuais: z.array(z.number().int().min(1).max(1000)).min(1).optional(),
  })
  .refine((p) => p.valorCentavos !== undefined || p.alertasPercentuais !== undefined, {
    message: 'informe o que mudar',
  })

export const zCopiarPlanejamentos = z.object({
  de: z.string().regex(/^\d{4}-\d{2}$/),
  para: z.string().regex(/^\d{4}-\d{2}$/),
})

export const zPlanejamento = z.object({
  id: zUuid,
  competencia: z.string().regex(/^\d{4}-\d{2}$/),
  /** Nulo é o planejamento global. */
  categoriaId: zUuid.nullable(),
  valorCentavos: zCentavos,
  /**
   * Apurado pelo servidor, e não pelo cliente: a regra de escopo e de natureza
   * é sutil o bastante para que web e mobile divergissem ao reimplementá-la.
   */
  realizadoCentavos: zCentavos,
  natureza: z.enum(['teto', 'piso']),
  /**
   * Consumo em pontos-base, inteiro com sinal, truncado. A tela mostra
   * `consumoBp / 100`; derivar o alerta do texto formatado faria os dois
   * divergirem no arredondamento.
   */
  consumoBp: z.number().int(),
  /**
   * `no_planejado` é o empate — gastar exatamente o teto. Sem o terceiro
   * rótulo, a tela mostra verde e o alerta dispara para o mesmo objeto.
   *
   * `fora_do_planejado`, e não "estourado": num piso não se estoura nada,
   * fica-se aquém. A palavra é da tela; o estado, não.
   */
  estado: z.enum(['dentro_do_planejado', 'no_planejado', 'fora_do_planejado']),
  alertasPercentuais: z.array(z.number().int()),
})

export const zPlanejamentosDoMes = z.object({
  itens: z.array(zPlanejamento),
  /**
   * Um total por natureza, e eles **nunca se somam** — um "planejado líquido"
   * não significa nada. Cada um soma, em cada caminho, apenas o planejamento de
   * nível mais alto que existir.
   */
  totalPlanejado: z.object({ teto: zCentavos, piso: zCentavos }),
})

export type CriarPlanejamento = z.infer<typeof zCriarPlanejamento>
export type AlterarPlanejamento = z.infer<typeof zAlterarPlanejamento>
export type CopiarPlanejamentos = z.infer<typeof zCopiarPlanejamentos>
export type Planejamento = z.infer<typeof zPlanejamento>
export type PlanejamentosDoMes = z.infer<typeof zPlanejamentosDoMes>

// ---------------------------------------------------------------------------
// Objetivo — acúmulo plurimensal com prazo
// ---------------------------------------------------------------------------
/**
 * Não tem `competencia`, e é isso que o separa de `Planejamento`. Ver ADR 0009.
 *
 * Também não tem campo de **modo**: `contaId` preenchido é ancorado, ausente é
 * por aportes. Um enum ao lado do dado pode contradizê-lo.
 */
export const zCriarObjetivo = z.object({
  nome: z.string().trim().min(1, 'o objetivo precisa de nome').max(80),
  /**
   * **Sempre positivo.** Objetivo é estoque-alvo, não movimento: a convenção de
   * sinal do ADR 0005 governa fluxos, e um alvo de acúmulo não tem direção a
   * codificar.
   */
  valorAlvoCentavos: zCentavos,
  /** `AAAA-MM-DD`, opcional. Sem prazo, o objetivo nunca vence. */
  prazo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'o prazo é `AAAA-MM-DD`')
    .nullish(),
  /** Preenchida = ancorado numa conta. Ausente = por aportes. */
  contaId: zUuid.nullish(),
  /**
   * Só no modo ancorado. Ausente captura o saldo atual da conta; zero conta o
   * que já estava lá como progresso. É marco histórico, e por isso é
   * **armazenado** — nunca recalculado a partir de uma data.
   */
  saldoBaseCentavos: zCentavos.nullish(),
})

export const zAlterarObjetivo = z
  .object({
    nome: z.string().trim().min(1).max(80).optional(),
    valorAlvoCentavos: zCentavos.optional(),
    /** `null` remove o prazo. */
    prazo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullish(),
  })
  .refine(
    (o) => o.nome !== undefined || o.valorAlvoCentavos !== undefined || o.prazo !== undefined,
    { message: 'informe o que mudar' },
  )

export const zObjetivo = z.object({
  id: zUuid,
  nome: z.string(),
  valorAlvoCentavos: zCentavos,
  prazo: z.string().nullable(),
  contaId: zUuid.nullable(),
  saldoBaseCentavos: zCentavos.nullable(),
  /**
   * Apurado pelo servidor. **Não é limitado ao alvo** e pode ser negativo: 125%
   * é uma resposta legítima, e um resgate maior que os aportes também. Travar a
   * barra em 100% é decisão de tela.
   */
  progressoCentavos: zCentavos,
  /** Pontos-base do alvo. `progresso / alvo`, truncado, com sinal. */
  consumoBp: z.number().int(),
  /**
   * `concluido` tem precedência sobre `vencido`: atingir o alvo é fato
   * histórico, e um objetivo alcançado em julho com prazo em agosto continua
   * concluído.
   */
  estado: z.enum(['ativo', 'concluido', 'vencido']),
  concluidoEm: z.string().nullable(),
  /** Quantos lançamentos estão vinculados. Zero no modo ancorado. */
  aportes: z.number().int(),
})

export const zVincularAporte = z.object({ lancamentoId: zUuid })

export type CriarObjetivo = z.infer<typeof zCriarObjetivo>
export type AlterarObjetivo = z.infer<typeof zAlterarObjetivo>
export type Objetivo = z.infer<typeof zObjetivo>
export type VincularAporte = z.infer<typeof zVincularAporte>

// ---------------------------------------------------------------------------
// Recorrencia — a regra que gera lançamentos repetidos
// ---------------------------------------------------------------------------
/**
 * A regra, nunca as ocorrências. O que a API devolve inclui a **próxima**
 * ocorrência, que é o que a tela precisa dizer, e a contagem do que já foi
 * materializado — mas as ocorrências em si são `Lancamento`, e vivem no extrato
 * como qualquer outro.
 */
export const zCriarRecorrencia = z
  .object({
    contaId: zUuid.nullish(),
    cartaoId: zUuid.nullish(),
    categoriaId: zUuid,
    /** Com sinal, como o lançamento que ela gera. */
    valorCentavos: zCentavos,
    descricao: z.string().trim().min(1).max(140),
    /** 1 a 31. Dia 31 em fevereiro é ancorado no último dia, nunca transborda. */
    diaDoMes: z.number().int().min(1).max(31),
    /** 1 é mensal, 12 é anual. */
    intervaloMeses: z.number().int().min(1).max(12).default(1),
    inicio: z.string().regex(/^\d{4}-\d{2}$/, 'o início é `AAAA-MM`'),
    /** `AAAA-MM`, **inclusive**. Ausente é perpétua. */
    fim: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .nullish(),
  })
  .refine((r) => (r.contaId == null) !== (r.cartaoId == null), {
    message: 'informe uma conta ou um cartão, nunca os dois',
  })

export const zAlterarRecorrencia = z
  .object({
    valorCentavos: zCentavos.optional(),
    descricao: z.string().trim().min(1).max(140).optional(),
    diaDoMes: z.number().int().min(1).max(31).optional(),
    intervaloMeses: z.number().int().min(1).max(12).optional(),
    fim: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .nullish(),
    /** Pausar não é excluir: para de produzir, e o que já existe fica. */
    pausada: z.boolean().optional(),
  })
  .refine((r) => Object.keys(r).length > 0, { message: 'informe o que mudar' })

export const zRecorrencia = z.object({
  id: zUuid,
  contaId: zUuid.nullable(),
  cartaoId: zUuid.nullable(),
  categoriaId: zUuid,
  valorCentavos: zCentavos,
  descricao: z.string(),
  diaDoMes: z.number().int(),
  intervaloMeses: z.number().int(),
  inicio: z.string(),
  fim: z.string().nullable(),
  pausada: z.boolean(),
  /** `AAAA-MM-DD` da próxima ocorrência a partir de hoje, ou nulo se encerrou. */
  proximaOcorrencia: z.string().nullable(),
  /** Quantas ocorrências já viraram lançamento. */
  materializadas: z.number().int(),
})

export type CriarRecorrencia = z.infer<typeof zCriarRecorrencia>
export type AlterarRecorrencia = z.infer<typeof zAlterarRecorrencia>
export type Recorrencia = z.infer<typeof zRecorrencia>

// ---------------------------------------------------------------------------
// Alertas — derivados do estado, nunca armazenados
// ---------------------------------------------------------------------------
/**
 * Não há tabela de notificações, e a ausência é escolha: uma tabela precisaria
 * ser mantida em sincronia com o estado que descreve, e um alerta de "teto
 * estourado" que sobrevive ao estorno que desestourou o teto é pior do que
 * alerta nenhum.
 */
export const zAlerta = z.object({
  tipo: z.enum([
    'teto',
    'piso',
    'objetivo_vencido',
    'objetivo_concluido',
    'lancamento_em_atraso',
    'fatura_vencida',
  ]),
  /** Ordena a lista. Urgente é o que custa dinheiro se ficar mais um dia. */
  severidade: z.enum(['urgente', 'atencao', 'informacao']),
  titulo: z.string(),
  detalhe: z.string(),
  /** Rota da web para onde o alerta leva. Aviso sem destino é aviso inútil. */
  destino: z.string(),
  /** Identidade estável do alerta, para o dia em que houver "marcar como visto". */
  chave: z.string(),
})

export type Alerta = z.infer<typeof zAlerta>

// ---------------------------------------------------------------------------
// Conexao — a origem do dado bancário, e o fim dela
// ---------------------------------------------------------------------------
/**
 * Épico 12. **Nenhum agregador está ligado** — a porta de receita do ADR 0003
 * não foi atingida —, e por isso as conexões que existem hoje são as de
 * arquivo e a manual. O contrato vale para as três e para as que vierem: quem
 * decide o comportamento é a ficha do adapter, nunca o nome do provider.
 */
export const zConexao = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  apelido: z.string(),
  instituicao: z.string().nullable(),
  status: z.enum(['ativa', 'requer_atencao', 'revogada']),
  criadaEm: z.string(),
  sincronizadaEm: z.string().nullable(),
  revogadaEm: z.string().nullable(),
  /**
   * O segundo fato. "Revogada" descreve o que a Mavia fez com a credencial —
   * sempre verdade e imediata. Isto descreve o que sabemos do outro lado, e o
   * produto não tem o direito de fundir os dois numa palavra só.
   */
  revogacaoNoProvedor: z
    .enum(['pendente', 'confirmada', 'falhou', 'nao_aplicavel'])
    .nullable(),
  /** Quantos lançamentos vieram desta conexão e **permanecem**. */
  lancamentos: z.number().int().nonnegative(),
})

export const zCriarConexao = z.object({
  provider: z.string().min(1),
  apelido: z.string().trim().min(1, 'a conexão precisa de um apelido').max(80),
  instituicao: z.string().trim().max(120).nullish(),
  /** A versão do texto de consentimento que o titular viu. Vira prova. */
  termosVersao: z.string().min(1),
  finalidade: z.string().min(1),
  escopo: z.array(z.string()).default([]),
})

/**
 * A resposta da revogação — os dois fatos, separados.
 *
 * `credencialDestruida` é sempre `true` quando a rota devolve 200: a Fase 1 é
 * incondicional e transacional. `revogacaoNoProvedor` pode ser `pendente`, e
 * dizer isso é a diferença entre informar e mentir.
 */
export const zRevogacao = z.object({
  status: z.literal('revogada'),
  credencialDestruida: z.literal(true),
  revogacaoNoProvedor: z.enum(['pendente', 'confirmada', 'falhou', 'nao_aplicavel']),
  lancamentosMantidos: z.number().int().nonnegative(),
})

export type Conexao = z.infer<typeof zConexao>
export type CriarConexao = z.infer<typeof zCriarConexao>
export type Revogacao = z.infer<typeof zRevogacao>

// ---------------------------------------------------------------------------
// Painel de administração — épico 13
// ---------------------------------------------------------------------------
/**
 * **Estes schemas são `snake_case`, e sozinhos no arquivo.**
 *
 * Todo o resto do contrato é `camelCase` porque cada controlador do produto
 * mapeia a linha do Postgres para o nome de domínio antes de responder. O
 * controlador do painel **não mapeia**: ele devolve `r.rows` cru
 * (`admin.controller.ts`), de propósito — a projeção fixa das funções de
 * `admin` é o que impede `ip_hash` e `user_agent_hash` de vazarem, e reescrever
 * cada linha na camada HTTP reintroduziria uma lista que alguém precisa lembrar
 * de manter.
 *
 * A consequência é esta: o nome da coluna **é** o nome do campo na rede. Fingir
 * o contrário aqui, com um mapeamento escrito à mão no cliente, criaria a
 * segunda fonte de verdade que este pacote existe para não ter.
 *
 * ## Por que os instantes são `z.string()` e não `z.coerce.date()`
 *
 * Eles atravessam JSON. `TIMESTAMPTZ` vira ISO em UTC, e quem decide o fuso da
 * exibição é a tela — `America/Sao_Paulo`, regra 7. Coagir para `Date` aqui
 * esconderia a conversão num lugar onde ninguém a procura.
 *
 * `competencia` é `DATE` — **data civil, não instante** — e por isso é lida
 * como texto e nunca convertida de fuso. Ver `competenciaPorExtenso`.
 */

export const zEstadoDaAssinatura = z.enum([
  'teste',
  'ativa',
  'em_atraso',
  'cancelada',
  'expirada',
])

export const zMotivoDeAcesso = z.enum(['chamado', 'incidente', 'defeito', 'ordem_judicial'])

export const zMeioDePagamento = z.enum(['pix', 'transferencia', 'boleto', 'dinheiro'])

export const zClienteNaLista = z.object({
  tenant_id: zUuid,
  nome: z.string(),
  /** O e-mail do proprietário. Nulo quando o espaço ficou sem titular ativo. */
  titular: z.string().nullable(),
  plano: z.string().nullable(),
  estado: zEstadoDaAssinatura.nullable(),
  criado_em: z.string(),
})

/**
 * O perfil, e o par que ele existe para mostrar.
 *
 * `fim_efetivo = greatest(periodo_fim, coalesce(cortesia_ate, periodo_fim))` é
 * **derivado no `SELECT`**, nunca coluna. Ele e `periodo_fim` aparecem lado a
 * lado na tela porque sem os dois o operador que acabou de conceder trinta dias
 * não vê que concedeu, e concede de novo (achados FC-2 e FC-3).
 */
export const zPerfilDoCliente = z.object({
  id: zUuid,
  nome: z.string(),
  criado_em: z.string(),
  plano: z.string().nullable(),
  estado: zEstadoDaAssinatura.nullable(),
  periodo_fim: z.string().nullable(),
  cortesia_ate: z.string().nullable(),
  graca_ate: z.string().nullable(),
  fim_efetivo: z.string().nullable(),
})

export const zContaDoCliente = z.object({
  id: zUuid,
  nome: z.string(),
  tipo: z.string(),
  saldo_inicial_centavos: zCentavos,
  moeda: zMoeda,
  incluir_no_saldo_geral: z.boolean(),
})

export const zLancamentoDoCliente = z.object({
  id: zUuid,
  valor_centavos: zCentavos,
  moeda: zMoeda,
  posted_at: z.string(),
  settled_at: z.string().nullable(),
  descricao: z.string().nullable(),
  origem: z.string().nullable(),
})

export const zBaixaAnterior = z.object({
  id: zUuid,
  valor_centavos: zCentavos,
  moeda: zMoeda,
  /** `DATE` no dia 1. Data civil: nunca convertida de fuso. */
  competencia: z.string(),
  recebido_em: z.string(),
  meio: zMeioDePagamento,
  referencia_externa: z.string(),
  observacao: z.string().nullable(),
  registrado_em: z.string(),
})

/**
 * Uma linha do registro de auditoria.
 *
 * `registros` é `BIGINT` no banco e o driver o devolve como **string**; um
 * `z.number()` aqui reprovaria toda linha de leitura. `de` e `para` são `JSONB`
 * e só existem na linha de **efeito** de uma escrita — a de intenção os tem
 * nulos, por construção (§8.5).
 */
export const zLinhaDoRegistro = z.object({
  ocorrido_em: z.string(),
  tenant_id: zUuid.nullable(),
  usuario_id: zUuid.nullable(),
  ator_tipo: z.string().nullable(),
  entidade: z.string().nullable(),
  entidade_id: zUuid.nullable(),
  acao: z.string(),
  classe: z.string().nullable(),
  rota: z.string().nullable(),
  registros: z.union([z.string(), z.number()]).nullable(),
  motivo: zMotivoDeAcesso.nullable(),
  referencia: z.string().nullable(),
  correlacao: zUuid.nullable(),
  de: z.unknown().nullable(),
  para: z.unknown().nullable(),
})

/** A resposta do cadastro. O `aviso` é texto de interface, não decoração. */
export const zClienteCadastrado = z.object({
  id: zUuid,
  aviso: z.string(),
})

export const zBaixaRegistrada = z.object({
  id: zUuid,
  estado: zEstadoDaAssinatura,
})

export const zTempoConcedido = z.object({ cortesiaAte: z.string() })

// ---------------------------------------------------------------------------
// Preço e desconto — ADR 0025
// ---------------------------------------------------------------------------

/**
 * Uma linha do histórico de preço.
 *
 * `valor_centavos` como **string**, como todo dinheiro que atravessa o fio:
 * `JSON.parse` de um número vira `double`, e um preço que passa por ponto
 * flutuante no caminho até a tela é o que a regra 1 proíbe.
 *
 * `stripe_price_id` é anulável, e é o caso normal hoje — ver a D3 emendada da
 * ADR 0025. Uma linha sem ele não é meio-preço: é o preço, porque não existe
 * outro.
 */
export const zPrecoVigente = z.object({
  id: zUuid,
  plano: z.string(),
  intervalo: z.enum(['mensal', 'anual']),
  valor_centavos: z.string(),
  moeda: z.string(),
  stripe_price_id: z.string().nullable(),
  vigente_desde: z.string(),
  criado_por: zUuid,
  motivo: z.string(),
})

export const zPrecoCriado = z.object({
  id: zUuid,
  valorAnterior: z.string().nullable(),
  /** Sempre zero. A tela é obrigada a mostrá-lo — ADR 0025 D2. */
  assinaturasAfetadas: z.number(),
})

export const zDescontoDoCliente = z.object({
  id: zUuid,
  especie: z.enum(['percentual', 'valor']),
  pontos_base: z.number().nullable(),
  valor_centavos: z.string().nullable(),
  moeda: z.string(),
  duracao: z.enum(['uma_vez', 'meses', 'sempre']),
  meses: z.number().nullable(),
  stripe_coupon_id: z.string().nullable(),
  motivo: z.string(),
  concedido_em: z.string(),
  revogado_em: z.string().nullable(),
})

export const zDescontoConcedido = z.object({ id: zUuid })

/** O que **eu** sou no painel. Nunca sobre outra pessoa — ver a policy da 0031. */
export const zEuNoPainel = z.object({ nivel: z.enum(['operador', 'super']) })

export const zOperadorConcedido = z.object({
  id: zUuid,
  usuarioId: zUuid,
  operadoresAtivos: z.number(),
})

export type EstadoDaAssinatura = z.infer<typeof zEstadoDaAssinatura>
export type MotivoDeAcesso = z.infer<typeof zMotivoDeAcesso>
export type MeioDePagamento = z.infer<typeof zMeioDePagamento>
export type ClienteNaLista = z.infer<typeof zClienteNaLista>
export type PerfilDoCliente = z.infer<typeof zPerfilDoCliente>
export type ContaDoCliente = z.infer<typeof zContaDoCliente>
export type LancamentoDoCliente = z.infer<typeof zLancamentoDoCliente>
export type BaixaAnterior = z.infer<typeof zBaixaAnterior>
export type LinhaDoRegistro = z.infer<typeof zLinhaDoRegistro>
export type ClienteCadastrado = z.infer<typeof zClienteCadastrado>
export type BaixaRegistrada = z.infer<typeof zBaixaRegistrada>
export type TempoConcedido = z.infer<typeof zTempoConcedido>
export type PrecoVigente = z.infer<typeof zPrecoVigente>
export type PrecoCriado = z.infer<typeof zPrecoCriado>
export type DescontoDoCliente = z.infer<typeof zDescontoDoCliente>
export type EuNoPainel = z.infer<typeof zEuNoPainel>
export type OperadorConcedido = z.infer<typeof zOperadorConcedido>
export type NivelDeAdmin = EuNoPainel['nivel']

/**
 * As respostas de lista do painel, embrulhadas.
 *
 * O envelope `{ itens: [...] }` é o formato de toda leitura de `/v1/admin`, e
 * ele vive aqui e não no cliente web: `apps/web` **não depende de `zod`** — de
 * propósito, para que nenhuma tela invente validação por conta própria. Quem
 * quiser analisar uma resposta do painel usa um destes.
 */
export const zListaDeClientes = z.object({ itens: z.array(zClienteNaLista) })
export const zListaDePerfis = z.object({ itens: z.array(zPerfilDoCliente) })
export const zListaDeContasDoCliente = z.object({ itens: z.array(zContaDoCliente) })
export const zListaDeLancamentosDoCliente = z.object({ itens: z.array(zLancamentoDoCliente) })
export const zListaDeBaixas = z.object({ itens: z.array(zBaixaAnterior) })
export const zListaDoRegistro = z.object({ itens: z.array(zLinhaDoRegistro) })
export const zListaDePrecos = z.object({ itens: z.array(zPrecoVigente) })
export const zListaDeDescontos = z.object({ itens: z.array(zDescontoDoCliente) })
