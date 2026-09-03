import { dinheiro, somarLista, type Moeda, type Money } from './money.js'
import type { DataCivil } from './tempo.js'

/**
 * Objetivo — acúmulo de um valor até uma data: *"juntar R$ 12.000 até
 * dezembro"*.
 *
 * É **plurimensal e com prazo**, e por isso não é um `Planejamento`, que é
 * mensal e por competência. Ver ADR 0009 e o verbete **Objetivo** no
 * `CONTEXT.md`.
 *
 * **Objetivo nunca move dinheiro.** Ele observa dinheiro que se moveu. Um
 * objetivo que criasse lançamento para "completar" o alvo inventaria
 * patrimônio — a violação mais grave possível neste domínio. Este módulo não
 * tem nenhuma função que produza um lançamento, e isso é a interface dizendo a
 * regra.
 *
 * ## Onde mora a conclusão
 *
 * `concluido_em` **não é gravado aqui**. A travessia precisa ser avaliada na
 * transação que altera o progresso, e o progresso muda por caminhos que não
 * conhecem Objetivo nenhum — lançamento manual, perna de transferência,
 * parcela, estorno, ingestão em lote. Quem grava é o gatilho do banco
 * (migration 0017), que é o único lugar por onde todos esses caminhos passam.
 *
 * O que este módulo dá é o predicado que o gatilho espelha (`atingiuOAlvo`, um
 * `>=`) e as derivações de leitura. Apurar a travessia na leitura da tela
 * transformaria "primeira travessia" em "primeira vez que alguém abriu a
 * tela".
 */

/** Derivado, nunca persistido como coluna. */
export type EstadoDoObjetivo = 'ativo' | 'concluido' | 'vencido'

export interface FatosDoObjetivo {
  readonly concluidoEm: Date | null
  readonly prazo: DataCivil | null
}

function mesmaMoeda(a: Money, b: Money): void {
  if (a.moeda !== b.moeda) {
    throw new Error(`Moedas divergentes num mesmo Objetivo: ${a.moeda} e ${b.moeda}.`)
  }
}

/**
 * Modo **ancorado**: `progresso = saldo(conta) − saldo_base`.
 *
 * `saldo_base` é um marco histórico **armazenado**, não uma data a partir da
 * qual se recalcula o saldo. Se fosse derivado, um lançamento retroativo
 * mudaria o saldo do passado e o progresso subiria sozinho, sem que ninguém
 * tivesse aportado um centavo.
 */
export function progressoAncorado(saldo: Money, saldoBase: Money): Money {
  mesmaMoeda(saldo, saldoBase)
  return dinheiro(saldo.centavos - saldoBase.centavos, saldo.moeda)
}

/**
 * Modo **por aportes**: a soma dos lançamentos vinculados, com o sinal do
 * domínio.
 *
 * A perna positiva de uma transferência para a poupança soma; a negativa, um
 * resgate, subtrai. **Sem `if` e sem campo de tipo** — é o mesmo dividendo que
 * o `Planejamento` colhe.
 *
 * A moeda é parâmetro, e não inferida do primeiro aporte: um objetivo sem
 * nenhum aporte precisa de resposta, e uma lista inteira em moeda errada tem
 * de falhar em vez de adotar a de quem veio primeiro.
 */
export function progressoPorAportes(aportes: readonly Money[], moeda: Moeda): Money {
  const total = somarLista(aportes, moeda)
  if (!total.ok) {
    throw new Error(
      `Aporte em ${total.erro.direita} num Objetivo em ${total.erro.esquerda}. ` +
        'Não há conversão silenciosa.',
    )
  }
  return total.valor
}

/**
 * `progresso >= valor_alvo`. É o predicado que o gatilho do banco espelha, e a
 * razão de ele caber numa linha é `valor_alvo > 0` ser invariante.
 */
export function atingiuOAlvo(progresso: Money, valorAlvo: Money): boolean {
  mesmaMoeda(progresso, valorAlvo)
  return progresso.centavos >= valorAlvo.centavos
}

/**
 * O progresso em pontos-base do alvo (1% = 100 bp), truncado em direção a zero.
 *
 * **Não é limitado a 10000.** R$ 15.000 de um alvo de R$ 12.000 devolve 12500,
 * e um objetivo por aportes com resgate maior que os aportes devolve negativo.
 * Travar a barra é decisão de UI; o domínio devolve o número real (invariante
 * 7 do ADR 0009).
 *
 * Ao contrário do `Planejamento`, aqui a equivalência entre "atingiu" e
 * "consumo >= 100%" vale sempre — porque o alvo é sempre positivo e a divisão
 * nunca inverte a desigualdade.
 */
export function consumoDoObjetivoEmBp(progresso: Money, valorAlvo: Money): number {
  mesmaMoeda(progresso, valorAlvo)
  if (valorAlvo.centavos <= 0n) {
    throw new Error('Objetivo com alvo não positivo: o banco não deveria ter deixado passar.')
  }
  return Number((progresso.centavos * 10_000n) / valorAlvo.centavos)
}

function antesDe(a: DataCivil, b: DataCivil): boolean {
  if (a.ano !== b.ano) return a.ano < b.ano
  if (a.mes !== b.mes) return a.mes < b.mes
  return a.dia < b.dia
}

/**
 * `concluido` → `vencido` → `ativo`, nesta precedência.
 *
 * Concluído vem primeiro porque atingir o alvo é um **fato histórico**: um
 * objetivo alcançado em julho cujo prazo era agosto continua concluído em
 * setembro.
 *
 * `prazo < hoje`, e não `<=`: o último dia conta. E `hoje` é data civil em
 * `America/Sao_Paulo`, não instante — às 21h de 2/set em UTC já é dia 3, e o
 * objetivo venceria um dia antes para quem está em São Paulo.
 */
export function estadoDoObjetivo(objetivo: FatosDoObjetivo, hoje: DataCivil): EstadoDoObjetivo {
  if (objetivo.concluidoEm !== null) return 'concluido'
  if (objetivo.prazo !== null && antesDe(objetivo.prazo, hoje)) return 'vencido'
  return 'ativo'
}

/**
 * Validação de **escrita**: o prazo informado não pode já ter passado.
 *
 * Um objetivo cujo prazo passou pela passagem do tempo é `vencido`, não
 * inválido. Confundir as duas coisas tornaria impossível abrir a tela de um
 * objetivo antigo.
 */
export function prazoValido(prazo: DataCivil, hoje: DataCivil): boolean {
  return !antesDe(prazo, hoje)
}
