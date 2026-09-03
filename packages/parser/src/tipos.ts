/**
 * O que um arquivo de extrato produz.
 *
 * Deliberadamente **sem `Money`**: este pacote não conhece o domínio, e a
 * ausência é o que mantém a árvore de dependências honesta. Quem monta o valor
 * com moeda é o adapter, na borda.
 */

/** Um dia do calendário, como o banco o declarou. Não é instante. */
export interface DataCivil {
  readonly ano: number
  readonly mes: number
  readonly dia: number
}

export interface RegistroBruto {
  /** Identificador do registro **na origem**. Metade da chave de idempotência. */
  readonly externalId: string
  readonly data: DataCivil
  /** Com sinal, em centavos. Nunca passou por ponto flutuante. */
  readonly centavos: bigint
  readonly moeda: string
  readonly descricao: string
  /** `DEBIT`, `CREDIT`, `PIX`… quando a fonte informa. Nunca inferido. */
  readonly tipo: string | null
  /** O trecho original, preservado para auditoria e reprocessamento. */
  readonly bruto: string
}

/**
 * Uma linha que não entrou, e por quê.
 *
 * **Nada é descartado em silêncio.** Um parser que ignora a linha ilegível
 * produz uma importação que parece completa e não é — e a diferença só aparece
 * quando alguém confere o saldo à mão, meses depois.
 */
export interface LinhaComProblema {
  readonly linha: number
  readonly motivo: string
  readonly bruto: string
}

export interface Resultado {
  readonly registros: readonly RegistroBruto[]
  readonly problemas: readonly LinhaComProblema[]
}
