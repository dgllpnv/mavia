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

export const zOrigem = z.enum(['manual', 'conectado'])

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
  origem: zOrigem,
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
  natureza: zNatureza,
  parentId: zUuid.optional(),
  cor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
})

export const zCategoria = z.object({
  id: zUuid,
  nome: z.string(),
  natureza: zNatureza,
  nivel: z.union([z.literal(1), z.literal(2)]),
  parentId: zUuid.nullable(),
  analitica: z.boolean(),
  arquivada: z.boolean(),
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
  saldo: zCentavos,
  projetado: zCentavos,
})

export type Natureza = z.infer<typeof zNatureza>
export type CriarCategoria = z.infer<typeof zCriarCategoria>
export type Categoria = z.infer<typeof zCategoria>
export type StatusDoLancamento = z.infer<typeof zStatus>
export type CriarLancamento = z.infer<typeof zCriarLancamento>
export type Lancamento = z.infer<typeof zLancamento>
export type CriarTransferencia = z.infer<typeof zCriarTransferencia>
export type CriarEstorno = z.infer<typeof zCriarEstorno>
export type Resumo = z.infer<typeof zResumo>
