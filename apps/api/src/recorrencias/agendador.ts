import { Queue, Worker, type Job } from 'bullmq'
import type Redis from 'ioredis'
import type { Pool } from 'pg'
import { comTenant, contextoDoTenant } from '../tenancy/tenancy.js'
import { materializarRecorrencia } from './materializar.js'
import { aplicarTrocasAgendadas } from '../cobranca/trocas-agendadas.js'

/**
 * O job que faz o horizonte da recorrência andar sozinho — pendência P-8.
 *
 * Sem ele, uma regra criada hoje tem ocorrências até o mesmo mês do ano que vem
 * e para ali, até que alguém a edite. Com ele, todo dia o horizonte avança um
 * dia.
 *
 * ## Por que uma hora, e não um dia
 *
 * O job é **idempotente pela identidade da ocorrência** — `(tenant,
 * recorrencia, competência)` é única no banco —, então rodar de hora em hora
 * não cria nada a mais do que rodar uma vez por dia. O que a frequência compra
 * é resiliência: uma janela de manutenção de duas horas não custa um dia de
 * horizonte, e a virada de mês acontece dentro de sessenta minutos em vez de
 * "em algum momento amanhã".
 *
 * ## Worker no mesmo processo
 *
 * É um único VPS com um único processo de API. Um worker separado seria mais
 * um container para operar e mais um lugar para uma credencial vazar, em troca
 * de isolamento que não temos razão para pagar hoje. Quando houver razão — um
 * job pesado que compita com a requisição do usuário —, o worker sai daqui sem
 * mudar nada além do arquivo de processo: a fila já é externa.
 */

const FILA = 'recorrencias'
const TAREFA = 'materializar-horizonte'

/**
 * A troca de plano agendada — **P-17**.
 *
 * Mora nesta fila, e não numa própria, porque uma fila a mais é um worker a
 * mais, uma conexão a mais e um lugar a mais onde uma falha passa em silêncio.
 * As duas tarefas são do sistema, idempotentes, e disputam nada.
 *
 * **De hora em hora, como a outra.** A troca aplica no fim do período pago; um
 * atraso de até sessenta minutos entrega ao cliente uma hora a mais do plano
 * que ele pagou, e nunca uma hora a menos. O erro cai para o lado certo.
 */
const TAREFA_TROCAS = 'aplicar-trocas-agendadas'

export interface Agendador {
  encerrar(): Promise<void>
}

export async function agendarMaterializacao(pool: Pool, redis: Redis): Promise<Agendador> {
  // A conexão da fila é a mesma do cofre: BullMQ exige
  // `maxRetriesPerRequest: null`, que é como o processo já a abre.
  const fila = new Queue(FILA, { connection: redis })

  await fila.upsertJobScheduler(
    TAREFA,
    { pattern: '7 * * * *' },
    {
      name: TAREFA,
      // Histórico curto: o job não produz relatório, e uma fila cheia de
      // execuções concluídas é memória gasta para nada.
      opts: { removeOnComplete: 24, removeOnFail: 48 },
    },
  )

  // Minuto 23 e não 7: as duas escrevem em espaços diferentes e não se
  // atrapalhariam, mas separá-las faz o log de uma hora ruim dizer qual das
  // duas demorou, sem precisar cruzar horário.
  await fila.upsertJobScheduler(
    TAREFA_TROCAS,
    { pattern: '23 * * * *' },
    { name: TAREFA_TROCAS, opts: { removeOnComplete: 24, removeOnFail: 48 } },
  )

  const worker = new Worker(
    FILA,
    async (job: Job) => {
      if (job.name === TAREFA_TROCAS) {
        return { trocasAplicadas: await aplicarTrocasAgendadas(pool) }
      }
      if (job.name !== TAREFA) return { criadas: 0 }

      // O job atravessa **todos** os espaços: ele é do sistema, não de um
      // usuário. A RLS bloqueia isso corretamente, e a saída é a exceção
      // **declarada** da migration 0020 — uma função estreita que devolve três
      // colunas de identificação e nada que descreva dinheiro.
      const regras = await pool.query<{
        tenant_id: string
        recorrencia_id: string
        criado_por: string
      }>('SELECT * FROM jobs.recorrencias_a_materializar()')

      let criadas = 0
      for (const regra of regras.rows) {
        // Cada regra é materializada **no contexto do seu próprio espaço**: a
        // função só disse quais existem; o trabalho continua sob RLS.
        const ctx = contextoDoTenant(regra.criado_por, regra.tenant_id)
        criadas += await comTenant(pool, ctx, (c) =>
          materializarRecorrencia(c, ctx, regra.recorrencia_id),
        )
      }

      return { criadas }
    },
    { connection: redis, concurrency: 1 },
  )

  // Falha de job não pode derrubar o processo, e também não pode passar em
  // silêncio: um horizonte que parou de andar é um extrato que some.
  worker.on('failed', (job, erro) => {
    console.error(
      `[recorrencias] job ${job?.name ?? '?'} #${job?.id ?? '?'} falhou:`,
      erro.message,
    )
  })

  return {
    async encerrar() {
      await worker.close()
      await fila.close()
    },
  }
}
