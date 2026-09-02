import { dinheiro, valorEmTexto, type Moeda } from '@mavia/domain'
import { geometriaDoTrilho } from '@mavia/ui'

/**
 * O trilho — o elemento-assinatura da Mavia.
 *
 * Uma régua de 2px sob todo número que representa algo em curso, com três
 * partes e uma gramática só: **quanto disto já é fato, e onde estava previsto
 * terminar.** O denominador muda de tela para tela e é sempre nomeado em texto
 * ao lado; a forma, nunca.
 *
 * Ele existe porque a pergunta que um produto de finanças pessoais responde não
 * é "quanto eu tenho" — é "quanto disto já aconteceu e quanto ainda vai
 * acontecer". No Organizze essa resposta está no rodapé colapsado do extrato,
 * em seis linhas atrás de um chevron. Aqui ela é forma, e custa 2 pixels.
 *
 * A geometria vem de `@mavia/ui`, testada com propriedades. Este arquivo pinta.
 */

export interface TrilhoProps {
  readonly realizadoCentavos: string
  readonly previstoCentavos: string
  readonly moeda?: Moeda
  readonly tamanho?: 'linha' | 'heroi' | 'ciclo'
  /** O que o denominador significa nesta tela. Sem isto o trilho é enfeite. */
  readonly denominador?: string
}

export function Trilho({
  realizadoCentavos,
  previstoCentavos,
  moeda = 'BRL',
  tamanho = 'linha',
  denominador,
}: TrilhoProps) {
  const g = geometriaDoTrilho({
    realizado: dinheiro(BigInt(realizadoCentavos), moeda),
    previsto: dinheiro(BigInt(previstoCentavos), moeda),
  })

  const largura = (fracao: number) => `${(fracao * 100).toFixed(4)}%`
  const modificador = tamanho === 'linha' ? '' : ` trilho--${tamanho}`

  return (
    <div>
      <div
        className={`trilho${modificador}`}
        role="img"
        aria-label={
          g.excedente
            ? `${denominador ?? 'Realizado'}: passou ${valorEmTexto(g.excedente)} do previsto.`
            : `${denominador ?? 'Realizado'}: ${(g.carga * 100).toFixed(0)}% do previsto.`
        }
      >
        <div
          className={`trilho__carga trilho__carga--${g.direcao}`}
          style={{ width: largura(g.carga) }}
        />
        {/* Estouro é textura, não cor: quem não distingue vermelho continua
            vendo a hachura, e o rótulo abaixo diz o valor. */}
        {g.estouro > 0 && (
          <div
            className="trilho__estouro"
            style={{
              width: largura(g.estouro),
              ...(g.direcao === 'direita' ? { left: 0 } : { right: 0 }),
            }}
          />
        )}
        {g.marca > 0 && g.marca < 1 && (
          <div
            className="trilho__marca"
            style={g.direcao === 'direita' ? { right: largura(g.marca) } : { left: largura(g.marca) }}
          />
        )}
      </div>

      {(denominador || g.excedente) && (
        <p className="mt-6 text-sm text-ink-3">
          {g.excedente ? (
            <>
              <span className="text-despesa">{valorEmTexto(g.excedente)} acima</span>
              {denominador ? ` de ${denominador}` : null}
            </>
          ) : (
            denominador
          )}
        </p>
      )}
    </div>
  )
}
