import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { dinheiro } from './money.js'
import {
  atingiu,
  consumoEmBp,
  dentroDoPlanejado,
  estadoDoPlanejamento,
  naturezaDoValor,
  totalPlanejado,
} from './planejamento.js'

/**
 * Planejamento — `CONTEXT.md` e ADR 0008.
 *
 * O sinal do valor **é** a natureza: negativo é teto de despesa, positivo é
 * piso de receita. Não há enum, e é isso que permite uma expressão só onde
 * antes havia um `if` por natureza — e o `if` era onde os defeitos moravam.
 *
 * A spec nomeia dois erros da versão anterior, e os dois têm teste próprio
 * aqui, com o contraexemplo literal:
 *
 * 1. Multiplicar os dois lados por `valor` para evitar a divisão **inverte a
 *    desigualdade** quando o valor é negativo.
 * 2. Formatar o percentual por arredondamento, a partir de outro número que não
 *    o `consumo_bp`, faz a tela e o alerta discordarem.
 */

const brl = (c: bigint) => dinheiro(c, 'BRL')

/** Teto de R$ 500,00 — negativo, porque despesa é negativa. */
const TETO = brl(-50000n)
/** Piso de R$ 3.000,00 de receita. */
const PISO = brl(300000n)

describe('naturezaDoValor', () => {
  it('o sinal é a natureza, e não um enum ao lado', () => {
    expect(naturezaDoValor(TETO)).toBe('teto')
    expect(naturezaDoValor(PISO)).toBe('piso')
  })
})

describe('dentroDoPlanejado', () => {
  it('vale para teto e para piso com a mesma expressão', () => {
    // `realizado >= valor`, com o sinal do domínio. Um `if` sobre natureza aqui
    // é o defeito que a ausência de enum existe para impedir.
    expect(dentroDoPlanejado(brl(-30000n), TETO)).toBe(true)
    expect(dentroDoPlanejado(brl(-60000n), TETO)).toBe(false)
    expect(dentroDoPlanejado(brl(350000n), PISO)).toBe(true)
    expect(dentroDoPlanejado(brl(250000n), PISO)).toBe(false)
  })

  it('gastar exatamente o teto ainda está dentro', () => {
    expect(dentroDoPlanejado(brl(-50000n), TETO)).toBe(true)
  })
})

describe('consumoEmBp', () => {
  it('mede o consumo do teto sem inverter o sinal', () => {
    // R$ 300 de R$ 500 = 60%.
    expect(consumoEmBp(brl(-30000n), TETO)).toBe(6000)
  })

  it('mede o piso da mesma forma', () => {
    // R$ 1.500 de R$ 3.000 = 50%.
    expect(consumoEmBp(brl(150000n), PISO)).toBe(5000)
  })

  it('trunca em direção a zero, e não arredonda', () => {
    // R$ 399,99 de R$ 500 = 79,998%. Truncado, 7999 bp — e o alerta de 80% não
    // dispara. Arredondar aqui faria a tela anunciar 80,00% sem alerta.
    expect(consumoEmBp(brl(-39999n), TETO)).toBe(7999)
  })

  it('é negativo quando o realizado tem sinal oposto ao planejado', () => {
    // Um mês cuja única linha na categoria é um estorno: entrou dinheiro numa
    // categoria de despesa. Não é 0%, e não é 100% — é negativo.
    expect(consumoEmBp(brl(10000n), TETO)).toBe(-2000)
  })

  it('estouro passa de 10000', () => {
    expect(consumoEmBp(brl(-75000n), TETO)).toBe(15000)
  })
})

describe('atingiu — o defeito da multiplicação', () => {
  it('não dispara o alerta de 80% aos 60% de consumo', () => {
    // **O contraexemplo literal da spec.** Multiplicar os dois lados por `valor`
    // para evitar a divisão dá `−30000 × 100 >= 80 × −50000`, que é verdadeiro:
    // o alerta de 80% dispararia com 60% gastos, porque a desigualdade inverte
    // quando `valor` é negativo.
    const consumo = consumoEmBp(brl(-30000n), TETO)

    expect(consumo).toBe(6000)
    expect(atingiu(consumo, 80)).toBe(false)
  })

  it('dispara exatamente no limiar, e não um centavo antes', () => {
    expect(atingiu(consumoEmBp(brl(-39999n), TETO), 80)).toBe(false)
    expect(atingiu(consumoEmBp(brl(-40000n), TETO), 80)).toBe(true)
  })

  it('consumo negativo não cruza limiar positivo nenhum', () => {
    const consumo = consumoEmBp(brl(10000n), TETO)

    for (const pct of [1, 50, 80, 100]) expect(atingiu(consumo, pct)).toBe(false)
  })

  it('vale igual para o piso', () => {
    expect(atingiu(consumoEmBp(brl(240000n), PISO), 80)).toBe(true)
    expect(atingiu(consumoEmBp(brl(239999n), PISO), 80)).toBe(false)
  })
})

describe('estadoDoPlanejamento', () => {
  it('gastar exatamente o teto é `no_planejado`, nem verde nem estourado', () => {
    // Sem esse terceiro rótulo, a tela mostra verde e o sino mostra alerta para
    // o mesmo objeto no mesmo instante.
    expect(estadoDoPlanejamento(brl(-50000n), TETO)).toBe('no_planejado')
    expect(estadoDoPlanejamento(brl(-49999n), TETO)).toBe('dentro_do_planejado')
    expect(estadoDoPlanejamento(brl(-50001n), TETO)).toBe('fora_do_planejado')
  })

  it('o piso tem os mesmos três estados, e o terceiro não se chama "estourado"', () => {
    // Num piso não se estoura nada: fica-se aquém. O estado é o mesmo —
    // `fora_do_planejado` —, e a palavra que a tela escolhe é apresentação.
    expect(estadoDoPlanejamento(brl(300000n), PISO)).toBe('no_planejado')
    expect(estadoDoPlanejamento(brl(300001n), PISO)).toBe('dentro_do_planejado')
    expect(estadoDoPlanejamento(brl(299999n), PISO)).toBe('fora_do_planejado')
  })
})

describe('totalPlanejado — precedência global → raiz → subcategoria', () => {
  const raiz = 'r1'
  const filha = 'f1'
  const outraRaiz = 'r2'
  const arvore = new Map([
    [filha, raiz],
    [raiz, null],
    [outraRaiz, null],
  ])

  it('soma só o nível mais alto de cada caminho', () => {
    // Teto global de R$ 3.000 e sub-teto de R$ 500 em Alimentação: o sub-teto é
    // legítimo, mas somar os dois daria R$ 3.500 de teto — contando o mesmo
    // dinheiro duas vezes.
    const total = totalPlanejado(
      [
        { categoriaId: null, valor: brl(-300000n) },
        { categoriaId: raiz, valor: brl(-50000n) },
      ],
      arvore,
    )

    expect(total.teto.centavos).toBe(-300000n)
  })

  it('sem global, soma as raízes', () => {
    const total = totalPlanejado(
      [
        { categoriaId: raiz, valor: brl(-50000n) },
        { categoriaId: outraRaiz, valor: brl(-80000n) },
      ],
      arvore,
    )

    expect(total.teto.centavos).toBe(-130000n)
  })

  it('a subcategoria só entra quando a raiz dela não tem planejamento', () => {
    const comRaiz = totalPlanejado(
      [
        { categoriaId: raiz, valor: brl(-50000n) },
        { categoriaId: filha, valor: brl(-20000n) },
      ],
      arvore,
    )
    expect(comRaiz.teto.centavos).toBe(-50000n)

    const semRaiz = totalPlanejado([{ categoriaId: filha, valor: brl(-20000n) }], arvore)
    expect(semRaiz.teto.centavos).toBe(-20000n)
  })

  it('teto e piso nunca se somam', () => {
    // A regra é enunciada duas vezes, uma por natureza. Somá-las daria um
    // "planejado líquido" que não significa nada.
    const total = totalPlanejado(
      [
        { categoriaId: null, valor: brl(-300000n) },
        { categoriaId: null, valor: brl(500000n) },
      ],
      arvore,
    )

    expect(total.teto.centavos).toBe(-300000n)
    expect(total.piso.centavos).toBe(500000n)
  })

  it('o global de uma natureza não esconde a raiz da outra', () => {
    // Teto global e piso por categoria convivem: a precedência é por caminho
    // **dentro** de cada natureza.
    const total = totalPlanejado(
      [
        { categoriaId: null, valor: brl(-300000n) },
        { categoriaId: raiz, valor: brl(400000n) },
      ],
      arvore,
    )

    expect(total.teto.centavos).toBe(-300000n)
    expect(total.piso.centavos).toBe(400000n)
  })
})

describe('propriedades', () => {
  const centavos = fc.bigInt({ min: -(10n ** 10n), max: 10n ** 10n })
  const naoZero = centavos.filter((c) => c !== 0n)

  it('consumo e `dentroDoPlanejado` concordam — com a ressalva da borda', () => {
    // A propriedade que amarra as duas funções, calculadas por caminhos
    // diferentes: uma por comparação direta, outra por razão.
    //
    // Ela achou **duas** coisas que eu tinha ignorado.
    //
    // **A relação inverte por natureza.** Num teto, estar dentro é consumo
    // ≤ 100%; num piso, é consumo ≥ 100% — receber além da meta é bom. A
    // primeira versão afirmava a relação do teto para os dois.
    //
    // **E a truncagem não distingue a borda.** Com teto de R$ 500 e R$ 500,01
    // gastos, a razão é 100,002% e o truncamento devolve 10000 bp — o mesmo
    // número de quem gastou exatamente o teto. O consumo **não consegue** dizer
    // se passou por um centavo, e é por isso que o estado vem da comparação
    // direta, e não do percentual. As duas contas são deliberadamente
    // independentes.
    //
    // O teste ramifica por natureza; a **implementação** não. É essa a
    // diferença que importa.
    fc.assert(
      fc.property(centavos, naoZero, (r, v) => {
        const realizado = brl(r)
        const valor = brl(v)
        const consumo = consumoEmBp(realizado, valor)
        const dentro = dentroDoPlanejado(realizado, valor)

        if (naturezaDoValor(valor) === 'teto') {
          if (consumo < 10000) expect(dentro).toBe(true)
          if (consumo > 10000) expect(dentro).toBe(false)
          // Em 10000 os dois são possíveis: exatamente no teto, ou um centavo
          // além que a truncagem não enxerga.
        } else {
          // No piso não há colisão: a truncagem só puxa para baixo, e ficar
          // aquém do piso nunca chega a 10000.
          expect(dentro).toBe(consumo >= 10000)
        }
      }),
      { numRuns: 3000 },
    )
  })

  it('o consumo nunca depende do sinal do planejamento', () => {
    // Espelhar teto e piso — inverter o sinal dos dois lados — não muda o
    // consumo. É a forma mais direta de dizer "não há `if` sobre natureza".
    fc.assert(
      fc.property(centavos, naoZero, (r, v) => {
        expect(consumoEmBp(brl(-r), brl(-v))).toBe(consumoEmBp(brl(r), brl(v)))
      }),
      { numRuns: 2000 },
    )
  })

  it('o estado concorda com o consumo, sempre', () => {
    fc.assert(
      fc.property(centavos, naoZero, (r, v) => {
        const estado = estadoDoPlanejamento(brl(r), brl(v))
        const consumo = consumoEmBp(brl(r), brl(v))
        const teto = naturezaDoValor(brl(v)) === 'teto'

        if (estado === 'no_planejado') expect(consumo).toBe(10000)
        if (estado === 'fora_do_planejado') {
          // Fora do planejado é **acima** de 100% no teto e **abaixo** no piso.
          // No teto vale `>=` e não `>`: um centavo além do teto trunca para
          // 10000, e o percentual exibido não distingue esse caso do empate.
          expect(teto ? consumo >= 10000 : consumo < 10000).toBe(true)
        }
      }),
      { numRuns: 2000 },
    )
  })
})
