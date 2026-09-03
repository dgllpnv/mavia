import { createServer, type Server, type Socket } from 'node:net'
import { unlinkSync } from 'node:fs'
import type { Pedido, Resposta } from '@mavia/guardiao'
import { zerar } from '@mavia/guardiao'
import { Cofre, CofreSelado } from './cofre.js'

/**
 * O transporte — propriedade 2 do ADR 0018 D3.2: **sem porta TCP**.
 *
 * Socket Unix, montado read-write apenas nos containers de API e worker. O
 * guardião não escuta rede, e portanto não é alcançável por SSRF a partir do
 * parser — que, de todo modo, não tem rede (D6).
 *
 * No Windows não existe socket Unix, e o Node usa *named pipe* com a mesma API.
 * A propriedade que importa se mantém: não há endereço IP a alcançar.
 *
 * ## Linha a linha, e não HTTP
 *
 * HTTP traria servidor, roteador e middleware — três coisas com histórico denso
 * de bug de parsing — para dentro do processo que guarda o ativo mais grave do
 * sistema. Aqui há um `split('\n')` e um `JSON.parse` com limite de tamanho.
 */

/** Um pedido acima disto é defeito ou ataque, e não um envelope. */
const TAMANHO_MAXIMO = 64 * 1024

export function servir(cofre: Cofre, caminho: string): Server {
  const servidor = createServer((socket) => atender(cofre, socket))

  // Um socket órfão de um processo morto impede o bind. Remover é seguro
  // porque só um guardião roda por host.
  try {
    unlinkSync(caminho)
  } catch {
    // Não existia. É o caso normal.
  }

  servidor.listen(caminho)
  return servidor
}

function atender(cofre: Cofre, socket: Socket): void {
  let acumulado = ''

  socket.on('data', (pedaco) => {
    acumulado += pedaco.toString('utf8')

    if (acumulado.length > TAMANHO_MAXIMO) {
      // Fecha sem responder: um cliente que manda 64 KB numa linha não está
      // pedindo um envelope.
      socket.destroy()
      return
    }

    let quebra = acumulado.indexOf('\n')
    while (quebra >= 0) {
      const linha = acumulado.slice(0, quebra)
      acumulado = acumulado.slice(quebra + 1)
      if (linha.trim() !== '') socket.write(`${JSON.stringify(responder(cofre, linha))}\n`)
      quebra = acumulado.indexOf('\n')
    }
  })

  // Um erro de socket não pode derrubar o guardião: se ele cair, a
  // sincronização para até alguém desselar de novo à mão.
  socket.on('error', () => socket.destroy())
}

function responder(cofre: Cofre, linha: string): Resposta {
  let pedido: Pedido
  try {
    pedido = JSON.parse(linha) as Pedido
  } catch {
    return { id: '?', ok: false, erro: 'pedido ilegível' }
  }

  const id = typeof pedido.id === 'string' ? pedido.id : '?'

  try {
    switch (pedido.operacao) {
      case 'estado':
        return {
          id,
          ok: true,
          selado: cofre.selado,
          ...(cofre.kekVersaoAtual === null ? {} : { kekVersaoAtual: cofre.kekVersaoAtual }),
        }

      case 'gerarDek': {
        const r = cofre.gerarDek(exigirContexto(pedido))
        const resposta: Resposta = {
          id,
          ok: true,
          dek: r.dek.toString('base64'),
          material: r.dekCifrada.toString('base64'),
          kekVersao: r.kekVersao,
        }
        // A DEK saiu na resposta; a cópia daqui morre agora.
        zerar(r.dek)
        return resposta
      }

      case 'envelopar': {
        const dek = material(pedido)
        try {
          const r = cofre.envelopar(exigirContexto(pedido), dek)
          return { id, ok: true, material: r.dekCifrada.toString('base64'), kekVersao: r.kekVersao }
        } finally {
          zerar(dek)
        }
      }

      case 'desenvelopar': {
        const dek = cofre.desenvelopar(exigirContexto(pedido), material(pedido))
        const resposta: Resposta = { id, ok: true, dek: dek.toString('base64') }
        zerar(dek)
        return resposta
      }

      case 'reenvelopar': {
        const destino = pedido.kekVersaoDestino
        if (typeof destino !== 'number') throw new Error('informe a versão de destino')
        const novo = cofre.reenvelopar(exigirContexto(pedido), material(pedido), destino)
        return { id, ok: true, material: novo.toString('base64'), kekVersao: destino }
      }

      case 'hmac': {
        const proposito = pedido.proposito
        if (typeof proposito !== 'string') throw new Error('informe o propósito')
        const saida = cofre.hmac(proposito, material(pedido))
        return { id, ok: true, material: saida.toString('base64') }
      }

      default:
        return { id, ok: false, erro: 'operação desconhecida' }
    }
  } catch (erro) {
    // A mensagem sai como está para `CofreSelado` — o operador precisa saber
    // que falta desselar. Para o resto, uma frase fixa: distinguir "chave
    // errada" de "AAD errado" seria um oráculo, e o cofre já não distingue.
    if (erro instanceof CofreSelado) return { id, ok: false, erro: erro.message }
    return { id, ok: false, erro: 'operação recusada' }
  }
}

function exigirContexto(pedido: Pedido) {
  const c = pedido.contexto
  if (
    !c ||
    typeof c.proposito !== 'string' ||
    typeof c.tenantId !== 'string' ||
    typeof c.recursoId !== 'string' ||
    typeof c.kekVersao !== 'number'
  ) {
    throw new Error('contexto incompleto')
  }
  return c
}

function material(pedido: Pedido): Buffer {
  if (typeof pedido.material !== 'string') throw new Error('material ausente')
  return Buffer.from(pedido.material, 'base64')
}
