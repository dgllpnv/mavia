import { enviar } from './api.js'
import { enfileirar, lerFila, retirar } from './deposito.js'
import { aposTentativa, proxima, type Mutacao, type RespostaDoEnvio } from './fila.js'

/**
 * O laço que esvazia a fila.
 *
 * Fina de propósito: toda decisão — o que sobe, em que ordem, o que fazer com a
 * falha — mora em `fila.ts`, que é puro e testado. Aqui só há I/O, e o que se
 * ganha com essa divisão é poder provar o comportamento sem dispositivo.
 *
 * **Um envio por vez.** Paralelizar quebraria a ordem de chegada, e a ordem é o
 * que garante que uma transferência não suba antes da conta que ela usa.
 */

let rodando = false

export interface ResultadoDaSincronizacao {
  readonly enviadas: number
  readonly restantes: number
}

/**
 * Tenta esvaziar a fila até o fim, ou até esbarrar num recuo.
 *
 * Reentrante por guarda simples: uma segunda chamada enquanto a primeira roda
 * não faz nada. Sem isso, o app voltando do segundo plano ao mesmo tempo que a
 * rede volta dispararia dois laços sobre a mesma fila — e dois envios da mesma
 * mutação, que a idempotência do servidor absorveria, mas ao custo de uma
 * requisição inútil e de um estado local disputado.
 */
export async function sincronizar(): Promise<ResultadoDaSincronizacao> {
  if (rodando) return { enviadas: 0, restantes: (await lerFila()).length }
  rodando = true

  let enviadas = 0
  try {
    for (;;) {
      const fila = await lerFila()
      const m = proxima(fila, Date.now())
      if (!m) return { enviadas, restantes: fila.length }

      const resposta = await tentar(m)
      const depois = aposTentativa(m, resposta, Date.now())

      if (depois === null) {
        await retirar(m.id)
        enviadas++
      } else {
        await enfileirar(depois)
        // Parou de progredir: ou entrou em recuo, ou pediu atenção. Continuar o
        // laço aqui viraria giro em falso consumindo bateria.
        if (depois.estado !== 'pendente' || depois.tentarApos > Date.now()) {
          return { enviadas, restantes: (await lerFila()).length }
        }
      }
    }
  } finally {
    rodando = false
  }
}

async function tentar(m: Mutacao): Promise<RespostaDoEnvio> {
  try {
    const r = await enviar(m.caminho, {
      metodo: m.metodo,
      corpo: m.corpo,
      tenantId: m.tenantId,
      // A chave é o **id da mutação**, criado quando a pessoa confirmou. É o
      // que faz a retentativa ser reconhecida como a mesma intenção.
      chave: m.id,
    })

    if (r.ok) return { status: r.status }

    const texto = await r.text().catch(() => '')
    const dados = texto ? (JSON.parse(texto) as { message?: unknown }) : null
    const mensagem = typeof dados?.message === 'string' ? dados.message : undefined

    return { status: r.status, ...(mensagem === undefined ? {} : { mensagem }) }
  } catch {
    // Qualquer coisa que impeça a resposta de chegar é "sem rede": o servidor
    // pode ter recebido e processado. Por isso a retentativa **precisa** levar a
    // mesma chave, e por isso este caso nunca é tratado como recusa.
    return { status: 0, semRede: true }
  }
}
