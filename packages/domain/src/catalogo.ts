import { dinheiro, type Money } from './money.js'

/**
 * O catálogo de planos — **em código, não em tabela**.
 *
 * `docs/produto/spec-planos-e-assinatura.md` §3: configuração versionada em
 * código não é alterável em produção sem deploy e sem teste. Uma tabela de
 * preços é uma tabela que alguém edita às pressas numa madrugada, e o preço
 * errado só aparece na fatura do cliente.
 *
 * A Stripe guarda os `price_id`; **o catálogo guarda o mapa**.
 *
 * ## O preço anual não é derivado, e desde a DP-41 não poderia ser
 *
 * Até a DP-27 valia `anual = 10 × mensal`, e o teste conferia a igualdade. A
 * **DP-41** alinhou os seis valores aos do Organizze, e a relação sumiu: o
 * anual do Pessoal é **5,7 mensalidades**, o do Família **8,9**, o do Negócio
 * **8,7**. Não há fórmula que produza os três.
 *
 * O que a DP-27 já fazia por disciplina virou necessidade: **cada preço é uma
 * `Money` própria, declarada em centavos**. Nenhuma multiplicação, nenhuma
 * divisão, nenhum percentual em tempo de execução. "≈ R$ 16,66/mês" é texto de
 * vitrine, arredondado só para exibir, e não entra em cálculo nenhum.
 *
 * ## O centavo quebrado entrou, e é um fato do mercado
 *
 * Os anuais terminam em `,90`. A DP-27 se orgulhava de preços redondos; o
 * concorrente não os pratica, e alinhar preço é alinhar a forma dele. Nenhuma
 * conta do domínio depende de redondeza — `Money` é inteiro em centavos e
 * `19990n` é tão exato quanto `59000n`. O que muda é só a vitrine.
 */

export type CodigoDoPlano = 'pessoal' | 'familia' | 'negocio'
export type Intervalo = 'mensal' | 'anual'

/**
 * As cotas. **`Cota`, nunca "limite"** — `Limite` é termo proibido no
 * `CONTEXT.md`, reservado ao que virou `Planejamento`. Uma cota de plano e um
 * teto de gasto são coisas diferentes e não podem dividir palavra.
 */
export interface Cotas {
  /** Membros ativos **mais** convites pendentes. Todos os papéis contam. */
  readonly pessoas: number
  /** Espaços em que a pessoa é proprietária. */
  readonly espacos: number
  readonly anexosBytes: number
  /** Épico 12. Fica no catálogo desde já para o cliente saber o que terá. */
  readonly conexoes: number
}

export interface Plano {
  readonly codigo: CodigoDoPlano
  readonly nome: string
  readonly mensal: Money
  readonly anual: Money
  readonly cotas: Cotas
  readonly disponivelParaCompra: boolean
}

const GB = 1024 * 1024 * 1024

/**
 * Os três planos.
 *
 * Nomes decididos em DP-18: dizem **para quem é**. "Básico" foi descartado por
 * ensinar o cliente a se sentir mal, e "Conectado/Conectado Plus" por prometer
 * o agregador no nome.
 *
 * **Preços da DP-41**, alinhados um a um aos do Organizze na posição
 * equivalente — Pessoal↔Manual, Família↔Conectado, Negócio↔Conectado Plus.
 * O anual é o preço **à vista** do concorrente, que é o que o nosso campo
 * significa: uma cobrança só, uma vez por ano.
 */
export const PLANOS: Readonly<Record<CodigoDoPlano, Plano>> = {
  pessoal: {
    codigo: 'pessoal',
    nome: 'Mavia Pessoal',
    mensal: dinheiro(3500n, 'BRL'),
    anual: dinheiro(19990n, 'BRL'),
    cotas: { pessoas: 2, espacos: 1, anexosBytes: 5 * GB, conexoes: 0 },
    disponivelParaCompra: true,
  },
  familia: {
    codigo: 'familia',
    nome: 'Mavia Família',
    mensal: dinheiro(4500n, 'BRL'),
    anual: dinheiro(39990n, 'BRL'),
    cotas: { pessoas: 5, espacos: 1, anexosBytes: 20 * GB, conexoes: 3 },
    disponivelParaCompra: true,
  },
  negocio: {
    codigo: 'negocio',
    nome: 'Mavia Negócio',
    mensal: dinheiro(6900n, 'BRL'),
    anual: dinheiro(59990n, 'BRL'),
    cotas: { pessoas: 10, espacos: 3, anexosBytes: 50 * GB, conexoes: 10 },
    disponivelParaCompra: true,
  },
}

/**
 * As cotas durante o teste: as do **Família**.
 *
 * Não as do Pessoal, e a escolha é do spec §6: quem testa precisa poder
 * convidar a família, senão o teste não exercita o produto que ele está
 * avaliando — e a pessoa decide sobre uma coisa que não experimentou.
 */
export const COTAS_DO_TESTE: Cotas = PLANOS.familia.cotas

/** Sete dias, contados da criação do espaço. Sem prorrogação automática. */
export const DIAS_DE_TESTE = 7

/** Catorze dias, alinhados à janela de retentativa da Stripe. */
export const DIAS_DE_GRACA = 14

export function plano(codigo: string): Plano | null {
  return codigo in PLANOS ? PLANOS[codigo as CodigoDoPlano] : null
}

/**
 * O preço de um plano num intervalo.
 *
 * Função, e não campo calculado: é o único ponto por onde o preço sai do
 * catálogo, e ter um só ponto é o que permite auditá-lo.
 */
export function preco(codigo: CodigoDoPlano, intervalo: Intervalo): Money {
  const p = PLANOS[codigo]
  return intervalo === 'anual' ? p.anual : p.mensal
}

/**
 * As cotas que valem agora, dado o estado.
 *
 * `expirada` não tem cotas de escrita — a escrita está bloqueada —, e devolver
 * as do plano ali faria a tela prometer o que a API vai recusar.
 */
export function cotasVigentes(estado: EstadoDaAssinatura, codigo: CodigoDoPlano): Cotas {
  if (estado === 'teste') return COTAS_DO_TESTE
  return PLANOS[codigo].cotas
}

// ---------------------------------------------------------------------------
// A máquina de estados
// ---------------------------------------------------------------------------

/**
 * Cinco estados, uma `Assinatura` por `Tenant` — spec §6.
 *
 * A propriedade que domina o desenho: **`em_atraso` não degrada nada**.
 * Bloquear o produto no instante em que um cartão falha é a forma mais comum de
 * perder um cliente que queria ficar, e a maioria das falhas é cartão vencido ou
 * limite momentâneo, não desistência.
 */
export type EstadoDaAssinatura = 'teste' | 'ativa' | 'em_atraso' | 'cancelada' | 'expirada'

export type EventoDaAssinatura =
  | 'assinou'
  | 'pagamento_falhou'
  | 'pagamento_recuperado'
  | 'cancelou'
  | 'desfez_cancelamento'
  | 'periodo_terminou'
  | 'prazo_de_teste_acabou'
  | 'graca_acabou'
  | 'reativou'

/**
 * A transição, ou `null` quando o evento não se aplica.
 *
 * Tabela explícita, e não `if`s: cinco estados por nove eventos são quarenta e
 * cinco combinações, e a maioria **não** deve acontecer. Uma tabela torna o
 * "não deve" visível; uma cadeia de `if`s o esconde no `else`.
 */
const TRANSICOES: Readonly<
  Record<EstadoDaAssinatura, Partial<Record<EventoDaAssinatura, EstadoDaAssinatura>>>
> = {
  teste: {
    assinou: 'ativa',
    prazo_de_teste_acabou: 'expirada',
  },
  ativa: {
    pagamento_falhou: 'em_atraso',
    cancelou: 'cancelada',
  },
  em_atraso: {
    pagamento_recuperado: 'ativa',
    graca_acabou: 'expirada',
    cancelou: 'cancelada',
  },
  cancelada: {
    // Desfazer o cancelamento é sem atrito, e só vale enquanto o período pago
    // não acabou: depois dele não há o que desfazer.
    desfez_cancelamento: 'ativa',
    periodo_terminou: 'expirada',
  },
  expirada: {
    reativou: 'ativa',
  },
}

export function transicao(
  atual: EstadoDaAssinatura,
  evento: EventoDaAssinatura,
): EstadoDaAssinatura | null {
  return TRANSICOES[atual][evento] ?? null
}

/**
 * A escrita está liberada?
 *
 * Quatro dos cinco estados escrevem. **Só `expirada` bloqueia**, e mesmo ela
 * mantém leitura e exportação completas: nunca apagamos nada (DP-5), e quem
 * parou de pagar continua dono do que registrou.
 */
export function podeEscrever(estado: EstadoDaAssinatura): boolean {
  return estado !== 'expirada'
}

/**
 * Os jobs rodam?
 *
 * `expirada` pausa a materialização de recorrência e a avaliação de alertas —
 * os dois **geram dado novo**, e gerar dado novo para quem não paga é continuar
 * prestando o serviço. Leitura, saldo e exportação continuam.
 *
 * Ao reativar, a materialização preenche as competências passadas: o job é
 * idempotente por `(tenant, recorrencia, competência)` e nada se perde.
 */
export function jobsAtivos(estado: EstadoDaAssinatura): boolean {
  return estado !== 'expirada'
}

/**
 * O fim **efetivo** do direito de uso.
 *
 * `periodo_fim` é do ciclo de cobrança e pertence ao provedor de pagamento: o
 * webhook o sobrescreve a cada fatura, com `coalesce(p_periodo_fim,
 * periodo_fim)`. `cortesia_ate` é o tempo que o operador concedeu, e ele vive
 * em coluna própria justamente para não ser apagado por esse caminho.
 *
 * **Toda leitura de "até quando este cliente pode usar" passa por aqui.** Ler
 * `periodo_fim` direto é o defeito F-12: o operador concede sessenta dias por
 * uma indisponibilidade, a fatura seguinte chega, e os sessenta dias somem sem
 * uma linha de auditoria — porque quem escreveu foi o webhook, e ninguém
 * compara. O cliente vê uma data encolher sozinha na tela dele.
 *
 * `greatest` e não soma: cortesia **estende**, não acumula sobre si mesma a
 * cada leitura. Se a fatura seguinte empurrar `periodo_fim` para além da
 * cortesia, o cliente não perde nada — ele simplesmente deixou de precisar
 * dela.
 */
export function fimEfetivo(periodoFim: Date, cortesiaAte: Date | null): Date {
  if (!cortesiaAte) return periodoFim
  return cortesiaAte.getTime() > periodoFim.getTime() ? cortesiaAte : periodoFim
}
