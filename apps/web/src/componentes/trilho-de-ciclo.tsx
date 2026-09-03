'use client'

/**
 * O trilho do ciclo da fatura — a assinatura no seu uso mais literal.
 *
 * É o único lugar do produto em que o trilho tem **duas marcas**, porque aqui o
 * denominador é **tempo** e não dinheiro: a janela vai da abertura ao
 * vencimento, com o fechamento no meio. O segmento entre as duas marcas é o
 * período de graça — os dias em que a fatura já está fechada e ainda não venceu.
 *
 * ```
 *  ███████████████████████████████████│░░░░░░░░░░░│
 *  1 set                          fecha 25    vence 5 out
 * ```
 *
 * A fatura como objeto físico com ciclo é o que o teardown apontou como
 * ausente no Organizze: lá o cartão é uma linha de saldo, e um cartão não tem
 * saldo — tem uma janela que abre, fecha e vence.
 */

export interface TrilhoDeCicloProps {
  /** Data civil `AAAA-MM-DD`. */
  readonly fechamento: string
  readonly vencimento: string
  /** O "hoje" do servidor. Nunca o relógio do cliente para decisão de negócio. */
  readonly hoje?: Date
}

export function TrilhoDeCiclo({ fechamento, vencimento, hoje = new Date() }: TrilhoDeCicloProps) {
  const fecha = diaEmUtc(fechamento)
  const vence = diaEmUtc(vencimento)

  // O ciclo começa um mês antes do fechamento: é a duração da janela de
  // compras, e é o que dá escala ao avanço dos dias.
  const inicio = new Date(fecha)
  inicio.setUTCMonth(inicio.getUTCMonth() - 1)

  const total = vence.getTime() - inicio.getTime()
  const decorrido = Math.min(Math.max(hoje.getTime() - inicio.getTime(), 0), total)

  const fracao = (instante: number) => `${((instante / total) * 100).toFixed(3)}%`
  const posicaoDoFechamento = fecha.getTime() - inicio.getTime()

  const jaFechou = hoje.getTime() >= fecha.getTime()
  const diasAteVencer = Math.ceil((vence.getTime() - hoje.getTime()) / 86_400_000)

  return (
    <div>
      <div
        className="trilho trilho--ciclo"
        role="img"
        aria-label={
          jaFechou
            ? `Fatura fechada, vence em ${diasAteVencer} dia(s).`
            : `Fatura aberta, fecha em ${fechamento} e vence em ${vencimento}.`
        }
      >
        <div className="trilho__carga trilho__carga--esquerda" style={{ width: fracao(decorrido) }} />
        {/* O período de graça é vazado, não preenchido: são dias em que nada
            mais entra na fatura e o dinheiro ainda não saiu. */}
        <div
          className="absolute inset-y-0 border-x border-line-forte"
          style={{
            left: fracao(posicaoDoFechamento),
            right: 0,
            background:
              'repeating-linear-gradient(90deg, var(--line-forte) 0 1px, transparent 1px 5px)',
          }}
        />
        <div className="trilho__marca" style={{ left: fracao(posicaoDoFechamento) }} />
      </div>

      <div className="mt-6 flex justify-between text-sm text-ink-3">
        <span>{formatarCurto(inicio)}</span>
        <span>fecha {formatarCurto(fecha)}</span>
        <span className={diasAteVencer <= 3 && diasAteVencer >= 0 ? 'text-atencao' : undefined}>
          vence {formatarCurto(vence)}
        </span>
      </div>
    </div>
  )
}

/**
 * `AAAA-MM-DD` é data **civil**: nomeia um dia, não um instante. Lê-la com
 * `new Date('2026-09-25')` dá meia-noite UTC, que em São Paulo é 21h do dia 24
 * — e o rótulo sairia um dia antes.
 */
function diaEmUtc(civil: string): Date {
  const [ano, mes, dia] = civil.split('-').map(Number)
  return new Date(Date.UTC(ano!, mes! - 1, dia))
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

function formatarCurto(d: Date): string {
  return `${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`
}
