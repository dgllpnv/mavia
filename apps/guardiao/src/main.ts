import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { Cofre, gerarKek, type Registro } from './cofre.js'
import { servir } from './servidor.js'

/**
 * `mavia-guardiao` — o processo que guarda a KEK.
 *
 * ## O desselamento é manual, e a consequência é assumida
 *
 * Opção B do ADR 0018 D3.3, decidida pelo dono do produto: a KEK vive em
 * memória e entra no boot. **Todo reboot da VPS exige desselamento**, e enquanto
 * o guardião estiver selado a sincronização bancária não funciona — o resto do
 * produto sim.
 *
 * Isso precisa estar no runbook e num alerta, porque a falha é **silenciosa do
 * ponto de vista do usuário**: os lançamentos simplesmente param de chegar.
 *
 * ## O que este processo nunca faz
 *
 * Não lê `.env`, não abre porta TCP, não fala com o Postgres e não interpreta
 * arquivo de usuário. A KEK entra pela entrada padrão, uma vez, e não toca o
 * disco.
 */

const CAMINHO = process.env['MAVIA_GUARDIAO_SOCKET'] ?? '/run/mavia/guardiao.sock'

/**
 * O registro vive **fora do Postgres** — propriedade 4 do D3.2.
 *
 * Se o incidente for no banco, um log dentro dele é um log que o atacante
 * edita. É o insumo do art. 48 da LGPD quando o incidente for neste ativo.
 */
const DIARIO = process.env['MAVIA_GUARDIAO_DIARIO'] ?? '/var/log/mavia/guardiao.jsonl'

function registrar(r: Registro): void {
  try {
    appendFileSync(DIARIO, `${JSON.stringify(r)}\n`, 'utf8')
  } catch {
    // Um diário que não escreve não pode derrubar o guardião — mas também não
    // pode passar em silêncio.
    console.error('[guardiao] não consegui escrever no diário:', DIARIO)
  }
}

function alarmar(mensagem: string): void {
  // Duas saídas de propósito: o `stderr` vai para o journal do host, e a linha
  // marcada vai para o diário, que é onde a investigação começa.
  console.error(`[guardiao] ALARME: ${mensagem}`)
  registrar({
    em: new Date().toISOString(),
    operacao: 'alarme',
    proposito: mensagem,
    tenantId: '-',
    recursoId: '-',
    kekVersao: 0,
    desfecho: 'selado',
  })
}

async function principal(): Promise<void> {
  if (process.argv.includes('--gerar-kek')) {
    // Provisionamento. Sai na saída padrão **uma vez**, para o operador guardar
    // fora deste host — e não é escrita em lugar nenhum.
    process.stdout.write(`${gerarKek().toString('base64')}\n`)
    return
  }

  const cofre = new Cofre({ aoRegistrar: registrar, aoAlarmar: alarmar })
  servir(cofre, CAMINHO)

  console.error(`[guardiao] escutando em ${CAMINHO}`)
  console.error('[guardiao] SELADO. A sincronização bancária não funciona até o desselamento.')
  console.error('[guardiao] cole "<versao> <kek em base64>" e pressione Enter.')

  const entrada = createInterface({ input: process.stdin })
  for await (const linha of entrada) {
    const [versao, kek] = linha.trim().split(/\s+/)
    if (!versao || !kek) {
      console.error('[guardiao] formato: <versao> <kek em base64>')
      continue
    }
    try {
      cofre.desselar(Number(versao), Buffer.from(kek, 'base64'))
      console.error(`[guardiao] DESSELADO na versão ${cofre.kekVersaoAtual}.`)
    } catch (erro) {
      console.error(`[guardiao] recusado: ${(erro as Error).message}`)
    }
  }
}

void principal()
