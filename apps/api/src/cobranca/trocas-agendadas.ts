import type { Pool } from 'pg'
import { comTenant, contextoDoTenant } from '../tenancy/tenancy.js'

/**
 * A metade do P-17 que cumpre a promessa.
 *
 * A rota grava a intenção; este módulo a executa. Enquanto ele não existiu, a
 * tela dizia "seu plano muda em 01/12" e 01/12 chegava sem que nada
 * acontecesse — o cliente seguia pagando o plano caro, para sempre.
 *
 * ## Duas funções, e não uma com um parâmetro
 *
 * Avisar e aplicar são disparados por condições diferentes — sete dias antes e
 * no dia — e falham de formas diferentes: um aviso que não sai é ruim, uma
 * troca que não aplica é o defeito original de volta. Uma função só, com um
 * modo, faria a falha de um esconder a do outro no mesmo `catch`.
 *
 * ## Por que o trabalho volta para dentro do espaço
 *
 * `jobs.trocas_a_aplicar()` atravessa espaços porque precisa — é `SECURITY
 * DEFINER` e devolve **só identificação**, nada que descreva dinheiro. A
 * escrita acontece sob RLS, dentro do espaço certo, pelo `comTenant`. É a mesma
 * forma da materialização de recorrência (migration 0020), e a razão é a
 * mesma: a exceção à RLS fica confinada a uma função auditável de três
 * colunas, em vez de virar um pool sem RLS que qualquer código futuro reusa.
 */

interface LinhaDoJob {
  tenant_id: string
  troca_id: string
  pedida_por: string
}

/**
 * Aplica as trocas cuja data chegou. Devolve quantas foram aplicadas.
 *
 * **Idempotente por `aplicada_em IS NULL`**, e a trava está no `UPDATE`, não
 * numa checagem antes dele: duas execuções concorrentes disputam a mesma linha
 * e a segunda atualiza zero linhas. Conferir antes e escrever depois deixaria a
 * janela entre as duas coisas aberta, e nela cabem duas aplicações do mesmo
 * rebaixamento — que sobre `assinaturas` seria inofensivo e sobre a auditoria
 * seria uma segunda linha afirmando um fato que aconteceu uma vez.
 */
export async function aplicarTrocasAgendadas(pool: Pool): Promise<number> {
  const pendentes = await pool.query<LinhaDoJob>('SELECT * FROM jobs.trocas_a_aplicar()')

  let aplicadas = 0
  for (const linha of pendentes.rows) {
    const ctx = contextoDoTenant(linha.pedida_por, linha.tenant_id)
    aplicadas += await comTenant(pool, ctx, async (c) => {
      // A troca é fechada primeiro, e é ela que decide se o resto acontece.
      // Fechar depois de mexer no plano deixaria a falha entre os dois passos
      // com o plano trocado e a linha aberta — e a próxima execução trocaria
      // de novo, sobre um plano que já não é o de origem.
      const fechada = await c.query<{ plano: string; intervalo: string }>(
        `UPDATE trocas_agendadas
            SET aplicada_em = now()
          WHERE id = $1 AND aplicada_em IS NULL AND cancelada_em IS NULL
        RETURNING plano, intervalo`,
        [linha.troca_id],
      )
      const troca = fechada.rows[0]
      if (!troca) return 0

      await c.query(
        // `'sistema'` e não `'cliente'`: quem escreve aqui é o job. O
        // reconciliador com a Stripe usa esta marca para decidir o que é
        // divergência — e uma troca que o cliente pediu há um mês, aplicada
        // hoje por nós, não é divergência nenhuma. Achado F-15.
        `UPDATE assinaturas
            SET plano = $2, intervalo = $3::intervalo_de_cobranca,
                origem_da_ultima_escrita = 'sistema',
                atualizado_em = now()
          WHERE tenant_id = $1`,
        [linha.tenant_id, troca.plano, troca.intervalo],
      )
      return 1
    })
  }
  return aplicadas
}

/**
 * Marca como avisadas as trocas a menos de sete dias, devolvendo quem avisar.
 *
 * **Marca antes de o e-mail sair, e é deliberado.** O contrário — enviar e
 * depois marcar — repete o aviso a cada execução até a marca pegar, e um
 * cliente que recebe o mesmo "seu plano vai mudar" cinco vezes liga achando que
 * pediu cinco trocas. Avisar de menos é recuperável por suporte; avisar demais
 * destrói a confiança no próprio aviso.
 */
export async function marcarTrocasAvisadas(
  pool: Pool,
): Promise<{ tenantId: string; trocaId: string; plano: string; aplicarEm: Date }[]> {
  const proximas = await pool.query<LinhaDoJob>('SELECT * FROM jobs.trocas_a_avisar()')

  const avisos: { tenantId: string; trocaId: string; plano: string; aplicarEm: Date }[] = []
  for (const linha of proximas.rows) {
    const ctx = contextoDoTenant(linha.pedida_por, linha.tenant_id)
    const marcada = await comTenant(pool, ctx, (c) =>
      c.query<{ plano: string; aplicar_em: Date }>(
        `UPDATE trocas_agendadas
            SET avisada_em = now()
          WHERE id = $1 AND avisada_em IS NULL AND aplicada_em IS NULL AND cancelada_em IS NULL
        RETURNING plano, aplicar_em`,
        [linha.troca_id],
      ),
    )
    const l = marcada.rows[0]
    if (l) {
      avisos.push({
        tenantId: linha.tenant_id,
        trocaId: linha.troca_id,
        plano: l.plano,
        aplicarEm: l.aplicar_em,
      })
    }
  }
  return avisos
}
