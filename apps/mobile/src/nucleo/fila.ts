/**
 * A fila durável de mutações — o coração do offline-first.
 *
 * Puro de propósito: sem SQLite, sem `fetch`, sem React. É o módulo que decide
 * **o que sobe, em que ordem, e o que fazer quando falha**, e é o único lugar
 * do app em que um erro custa dinheiro. Ele precisa ser testável sem
 * dispositivo, e é.
 *
 * ## As três regras
 *
 * 1. **A ordem é de chegada.** Uma transferência criada depois de uma conta
 *    depende dela; subir fora de ordem produziria erros que o usuário não
 *    causou. FIFO, sempre.
 * 2. **A identidade nasce com a intenção**, não com o envio. `id` é a
 *    `Idempotency-Key`, gerada quando a pessoa toca em "salvar" — se fosse
 *    gerada no envio, cada retentativa teria chave nova, que é o mesmo que não
 *    ter chave.
 * 3. **Falha permanente não some.** Um 4xx significa que o servidor recusou a
 *    intenção, e reenviar não vai mudar isso. Mas descartar em silêncio uma
 *    despesa que a pessoa registrou é a pior coisa que este app pode fazer: ela
 *    vai ao mercado, lança, e o dinheiro não aparece. A mutação sai da fila de
 *    envio e entra na fila de **atenção**, que a interface mostra.
 */

export type EstadoDaMutacao = 'pendente' | 'precisa_de_atencao'

export interface Mutacao {
  /** UUID. É também a `Idempotency-Key` da requisição. */
  readonly id: string
  readonly metodo: 'POST' | 'PATCH' | 'DELETE'
  readonly caminho: string
  readonly corpo: unknown
  /** Espaço ao qual a mutação pertence. Vai no `X-Mavia-Tenant`. */
  readonly tenantId: string
  /** Instante em que a pessoa confirmou. Define a ordem. */
  readonly criadaEm: number
  readonly tentativas: number
  readonly estado: EstadoDaMutacao
  /** Preenchido quando vira `precisa_de_atencao`. É o que a tela mostra. */
  readonly motivo?: string
  /** Antes deste instante, não tentar de novo. */
  readonly tentarApos: number
}

export interface RespostaDoEnvio {
  readonly status: number
  /** Falha de rede: sem resposta. Distinta de um 5xx, e tratada igual. */
  readonly semRede?: boolean
  readonly mensagem?: string
}

/** Teto do recuo. Dez minutos: além disso, o app já não está "tentando". */
const RECUO_MAXIMO_MS = 10 * 60 * 1000

/** Depois disto a mutação para de tentar sozinha e pede atenção. */
export const TENTATIVAS_ATE_DESISTIR = 8

/**
 * Recuo exponencial com base de um segundo.
 *
 * Sem jitter, e a ausência é escolhida: um app pessoal tem **um** dispositivo
 * por pessoa, não mil clientes sincronizados que precisem ser espalhados. O
 * jitter existiria para proteger o servidor de um efeito de manada que este
 * produto não produz.
 */
export function recuoEmMs(tentativas: number): number {
  return Math.min(RECUO_MAXIMO_MS, 1000 * 2 ** Math.max(0, tentativas - 1))
}

export function criarMutacao(
  dados: Pick<Mutacao, 'id' | 'metodo' | 'caminho' | 'corpo' | 'tenantId'>,
  agora: number,
): Mutacao {
  return {
    ...dados,
    criadaEm: agora,
    tentativas: 0,
    estado: 'pendente',
    tentarApos: 0,
  }
}

/**
 * A próxima a subir: a **mais antiga** que está pendente e já pode tentar.
 *
 * Uma mutação em recuo não bloqueia as de trás? **Bloqueia, e é de propósito.**
 * A ordem de chegada é a regra 1, e furá-la para "adiantar" a próxima produziria
 * exatamente o erro que a ordem existe para evitar — a transferência subindo
 * antes da conta que ela usa.
 */
export function proxima(fila: readonly Mutacao[], agora: number): Mutacao | null {
  const emOrdem = [...fila].sort((a, b) => a.criadaEm - b.criadaEm)

  for (const m of emOrdem) {
    if (m.estado !== 'pendente') continue
    // A primeira pendente da ordem manda: se ela ainda está em recuo, ninguém
    // passa na frente.
    return m.tentarApos <= agora ? m : null
  }
  return null
}

/**
 * O que fazer depois de uma tentativa.
 *
 * Devolve a mutação atualizada, ou `null` quando ela sai da fila — o que
 * acontece **só** no sucesso.
 *
 * **Sobre o 409.** Ele não sai da fila, e a distinção é sutil o bastante para
 * ser dita: a retentativa de uma mutação que já subiu não recebe 409, recebe a
 * resposta guardada, com o status original — é o que o interceptor de
 * idempotência faz. Um 409 significa a outra coisa: esta chave já foi usada
 * para **outra** operação, o que é defeito de cliente. Tratá-lo como "já
 * aconteceu" descartaria em silêncio uma intenção que nunca chegou a acontecer.
 */
export function aposTentativa(
  m: Mutacao,
  resposta: RespostaDoEnvio,
  agora: number,
): Mutacao | null {
  if (resposta.status >= 200 && resposta.status < 300) return null

  const tentativas = m.tentativas + 1

  // 408 e 429 são "tente de novo", não "não faça isso": o servidor está
  // ocupado, e a intenção continua válida.
  const vaiTentarDeNovo =
    resposta.semRede === true ||
    resposta.status >= 500 ||
    resposta.status === 408 ||
    resposta.status === 429

  if (vaiTentarDeNovo && tentativas < TENTATIVAS_ATE_DESISTIR) {
    return { ...m, tentativas, tentarApos: agora + recuoEmMs(tentativas) }
  }

  return {
    ...m,
    tentativas,
    estado: 'precisa_de_atencao',
    motivo:
      resposta.mensagem ??
      (vaiTentarDeNovo
        ? 'Não conseguimos enviar depois de várias tentativas.'
        : 'O servidor recusou este lançamento.'),
    tentarApos: 0,
  }
}

/**
 * Reenfileira uma mutação que pedia atenção, depois de a pessoa mandar tentar
 * de novo. O contador zera: ela tomou uma decisão nova.
 */
export function tentarDeNovo(m: Mutacao): Mutacao {
  // `motivo` é **removido**, não posto como `undefined`: com
  // `exactOptionalPropertyTypes`, ausente e "presente valendo undefined" são
  // coisas diferentes, e o depósito grava a segunda como a string "undefined".
  const { motivo: _, ...resto } = m
  return { ...resto, estado: 'pendente', tentativas: 0, tentarApos: 0 }
}

export function pendentes(fila: readonly Mutacao[]): number {
  return fila.filter((m) => m.estado === 'pendente').length
}

export function precisamDeAtencao(fila: readonly Mutacao[]): readonly Mutacao[] {
  return fila.filter((m) => m.estado === 'precisa_de_atencao')
}
