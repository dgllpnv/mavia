import {
  dinheiro,
  partesDoValor,
  rotuloAcessivel,
  valorEmTexto,
  type Moeda,
} from '@mavia/domain'

/**
 * Um valor monetário na tela — `docs/design/direcao-visual.md` §3.4 e §3.5.
 *
 * Recebe **centavos como string**, que é a forma em que o dinheiro viaja na
 * API: `bigint` não sobrevive a JSON e `number` perde precisão. A conversão
 * acontece aqui, uma vez, e o componente é o único lugar da interface que a faz.
 *
 * O sinal aparece em **quatro canais**, dos quais três funcionam em escala de
 * cinza — glifo, peso e (no trilho ao lado) direção. A cor é o quarto, e é
 * reforço: nunca carrega significado sozinha.
 */

export interface ValorProps {
  readonly centavos: string
  readonly moeda?: Moeda
  /** Isolado usa figuras proporcionais e centavos menores; em coluna, não. */
  readonly isolado?: boolean
  /** Realizado é peso 600; previsto é 400. Peso separa certeza sem gastar cor. */
  readonly previsto?: boolean
  /** Transferência não é receita nem despesa: recebe tinta neutra. */
  readonly transferencia?: boolean
  /**
   * **Saldo, e não lançamento.**
   *
   * Um saldo positivo não é uma receita: é o que sobrou. Pintá-lo de verde diz
   * "entrou dinheiro" sobre um número que é um estoque, e mostrar `+` na
   * frente dele afirma uma direção que ele não tem. Saldo é tinta; só o
   * negativo ganha cor, porque conta no vermelho é fato que merece alarme.
   */
  readonly saldo?: boolean
  readonly status?: 'previsto' | 'pendente' | 'efetivado'
  readonly className?: string
}

export function Valor({
  centavos,
  moeda = 'BRL',
  isolado = false,
  previsto = false,
  transferencia = false,
  saldo = false,
  status,
  className = '',
}: ValorProps) {
  const valor = dinheiro(BigInt(centavos), moeda)
  const p = partesDoValor(valor)

  const cor = transferencia
    ? 'valor--transferencia'
    : valor.centavos < 0n
      ? 'valor--despesa'
      : !saldo && valor.centavos > 0n
        ? 'valor--receita'
        : ''

  const classes = [
    'valor',
    isolado ? 'valor--isolado' : '',
    previsto ? 'valor--previsto' : 'valor--realizado',
    cor,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    // O rótulo acessível troca o glifo por palavra: sem ele, o leitor de tela
    // anuncia "menos" solto na frente do valor, que é ruído e não informação.
    <span
      className={classes}
      aria-label={
        saldo
          ? `saldo de ${valorEmTexto(valor).replace('+', '').replace('−', 'menos ')}`
          : rotuloAcessivel(valor, {
              ...(status ? { status } : {}),
              ...(transferencia ? { transferencia: true } : {}),
            })
      }
    >
      <span aria-hidden="true">
        {/* A coluna do sinal continua reservada mesmo vazia: é ela que faz
            positivos e negativos alinharem pelo `R$`. */}
        <span className="valor__sinal">{saldo && p.sinal === '+' ? '' : p.sinal}</span>
        <span className="valor__simbolo">{p.simbolo}</span>
        {p.inteiro}
        <span className="valor__decimais">
          {p.separador}
          {p.decimais}
        </span>
      </span>
    </span>
  )
}
