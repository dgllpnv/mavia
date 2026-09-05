import type { Pool } from 'pg'
import { plano, preco, valorEmTexto, type Intervalo } from '@mavia/domain'
import { comTenant, contextoDoTenant } from '../tenancy/tenancy.js'
import type { Mensageiro } from '../mensageiro/mensageiro.js'
import { trocaDePlanoEmSeteDias } from '../mensageiro/mensagens.js'

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
 * Avisa quem tem uma troca a menos de sete dias. Devolve quantos foram avisados.
 *
 * ## Marca antes de enviar, e desmarca se o envio falhar
 *
 * Três desenhos possíveis, e os dois óbvios são piores:
 *
 * - **Enviar e depois marcar** repete o aviso a cada hora até a marca pegar.
 *   Um cliente que recebe cinco vezes "seu plano vai mudar" liga achando que
 *   pediu cinco trocas — e o aviso seguinte, o que importa, ele já ignora.
 * - **Marcar e não desmarcar** perde o aviso para sempre num SMTP fora do ar
 *   por dez minutos. A pessoa é rebaixada sem nunca ter sido avisada, que é
 *   metade do defeito P-17 de volta.
 *
 * O terceiro é estritamente melhor que os dois: marca, envia, e **desfaz a
 * marca se o envio levantar**. No caminho normal, uma vez só. Numa falha
 * transitória, a próxima execução tenta de novo. A única janela perdida é
 * cair entre o envio bem-sucedido e o retorno — e ali a marca fica, que é o
 * lado certo para errar.
 *
 * ## Sem SMTP, não marca nada
 *
 * A saída antecipada existe para que uma instalação sem e-mail configurado não
 * queime os avisos contra um mensageiro que sempre levanta. Ela também é o que
 * faz o desenvolvimento local não precisar de SMTP para exercitar o resto.
 */
export async function avisarTrocasProximas(pool: Pool, mensageiro: Mensageiro): Promise<number> {
  if (!mensageiro.configurado) return 0

  const proximas = await pool.query<LinhaDoJob>('SELECT * FROM jobs.trocas_a_avisar()')

  let avisados = 0
  for (const linha of proximas.rows) {
    const ctx = contextoDoTenant(linha.pedida_por, linha.tenant_id)

    const marcada = await comTenant(pool, ctx, (c) =>
      c.query<{ plano: string; plano_anterior: string; intervalo: Intervalo; aplicar_em: Date; email: string }>(
        `UPDATE trocas_agendadas t
            SET avisada_em = now()
          FROM usuarios u
          WHERE t.id = $1 AND u.id = t.pedida_por
            AND t.avisada_em IS NULL AND t.aplicada_em IS NULL AND t.cancelada_em IS NULL
        RETURNING t.plano, t.plano_anterior, t.intervalo, t.aplicar_em, u.email`,
        [linha.troca_id],
      ),
    )
    const l = marcada.rows[0]
    if (!l) continue

    const destino = plano(l.plano)
    const origem = plano(l.plano_anterior)
    if (!destino || !origem) continue

    try {
      await mensageiro.enviar(
        trocaDePlanoEmSeteDias(l.email, {
          deNome: origem.nome,
          paraNome: destino.nome,
          precoNovo: `${valorEmTexto(preco(destino.codigo, l.intervalo))} por ${l.intervalo === 'anual' ? 'ano' : 'mês'}`,
          quando: emSaoPaulo(l.aplicar_em),
        }),
      )
      avisados += 1
    } catch (erro) {
      // Desfaz a marca para que a próxima execução tente de novo. Sem `await`
      // dentro de outro `catch`: se **esta** escrita falhar, o aviso fica
      // marcado e perdido — e é o menor dos males, porque um banco que recusa
      // um `UPDATE` de uma coluna é um problema maior que um e-mail a menos.
      await comTenant(pool, ctx, (c) =>
        c.query('UPDATE trocas_agendadas SET avisada_em = NULL WHERE id = $1', [linha.troca_id]),
      )
      console.error(
        `[trocas] aviso da troca ${linha.troca_id} falhou, marca desfeita:`,
        (erro as Error).message,
      )
    }
  }
  return avisados
}

/**
 * A data como a pessoa a lê — **em `America/Sao_Paulo`**, nunca em UTC.
 *
 * `aplicar_em` é um instante UTC, e uma troca marcada para as 03:00Z de 01/12 é
 * 00:00 do dia 1º em São Paulo. Formatar em UTC diria "01/12" por sorte; para
 * uma troca das 02:00Z, diria o dia errado. Regra 7: UTC no banco, fuso do
 * usuário na tela — e o e-mail é tela.
 */
function emSaoPaulo(quando: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(quando)
}
