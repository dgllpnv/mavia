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
