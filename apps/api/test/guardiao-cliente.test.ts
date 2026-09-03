import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SEM_TENANT, type Contexto } from '@mavia/guardiao'
import { ClienteDoGuardiao, GuardiaoIndisponivel } from '../src/guardiao/cliente.js'

/**
 * O cliente contra o guardião **de verdade** — o processo, não um duplo.
 *
 * Um fake do socket provaria que o cliente fala consigo mesmo. O que precisa ser
 * provado é outra coisa: que o que a API grava no banco só volta a abrir com o
 * guardião, com aquela KEK e naquele contexto — as três promessas do ADR 0018,
 * e nenhuma delas é testável contra um duplo.
 *
 * Por isso o teste **sobe `apps/guardiao` como processo separado** e desselou
 * pela entrada padrão, como o runbook manda. De quebra é o único lugar que
 * exercita o desselamento manual, que é o passo que todo reboot da VPS exige.
 *
 * A API não importa nada de `apps/guardiao` — nem aqui. A fronteira do ADR é
 * que a KEK vive noutro processo; um `import` de teste atravessando essa linha
 * seria a primeira rachadura nela.
 */

const RAIZ = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'guardiao')
const PASTA = mkdtempSync(join(tmpdir(), 'mavia-guardiao-'))

const socketDe = (nome: string) =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\mavia-${nome}-${process.pid}`
    : join(PASTA, `${nome}.sock`)

const KEK_1 = randomBytes(32).toString('base64')
const KEK_2 = randomBytes(32).toString('base64')

const DIARIO = join(PASTA, 'guardiao.jsonl')

let processo: ChildProcessWithoutNullStreams
let cliente: ClienteDoGuardiao

const contexto = (over: Partial<Omit<Contexto, 'kekVersao'>> = {}) => ({
  proposito: 'conexao.credenciais' as const,
  tenantId: 'dbdbdbdb-0000-4000-8000-000000000001',
  recursoId: 'cccccccc-0000-4000-8000-000000000001',
  ...over,
})

/** Sobe o guardião e espera a linha que diz que ele está escutando. */
function subir(socket: string, diario: string): Promise<ChildProcessWithoutNullStreams> {
  const filho = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: RAIZ,
    env: { ...process.env, MAVIA_GUARDIAO_SOCKET: socket, MAVIA_GUARDIAO_DIARIO: diario },
  })

  return esperar(filho, /escutando/).then(() => filho)
}

/** Espera uma linha do `stderr` do guardião. É por lá que ele fala. */
function esperar(filho: ChildProcessWithoutNullStreams, padrao: RegExp): Promise<string> {
  return new Promise((resolver, rejeitar) => {
    let acumulado = ''
    const relogio = setTimeout(
      () => rejeitar(new Error(`o guardião não disse ${padrao}. Disse: ${acumulado}`)),
      30_000,
    )
    const ouvir = (pedaco: Buffer) => {
      acumulado += pedaco.toString('utf8')
      if (padrao.test(acumulado)) {
        clearTimeout(relogio)
        filho.stderr.off('data', ouvir)
        resolver(acumulado)
      }
    }
    filho.stderr.on('data', ouvir)
  })
}

beforeAll(async () => {
  processo = await subir(socketDe('cliente'), DIARIO)
  processo.stdin.write(`1 ${KEK_1}\n`)
  await esperar(processo, /DESSELADO na versão 1/)
  cliente = new ClienteDoGuardiao({ caminho: socketDe('cliente') })
}, 60_000)

afterAll(() => {
  processo?.kill()
})

describe('ida e volta', () => {
  it('cifra e devolve o segredo pelo callback', async () => {
    const segredo = 'item_id: 0f3c-abcd'
    const c = contexto()

    const { cifrado, dekCifrada, kekVersao } = await cliente.cifrar(c, Buffer.from(segredo, 'utf8'))

    expect(kekVersao).toBe(1)
    expect(cifrado.toString('utf8')).not.toContain('0f3c')

    const lido = await cliente.usarSegredo({ ...c, kekVersao }, dekCifrada, cifrado, (claro) =>
      claro.toString('utf8'),
    )

    expect(lido).toBe(segredo)
  })

  it('**o segredo é zerado ao sair do callback**', async () => {
    // Devolver um Buffer deixaria a decisão de zerá-lo com o chamador, e o
    // chamador esquece.
    const c = contexto()
    const { cifrado, dekCifrada, kekVersao } = await cliente.cifrar(c, Buffer.from('senha'))

    let espiado: Buffer | null = null
    await cliente.usarSegredo({ ...c, kekVersao }, dekCifrada, cifrado, (claro) => {
      espiado = claro
      expect(claro.toString('utf8')).toBe('senha')
    })

    expect(espiado!).toEqual(Buffer.alloc(5))
  })

  it('zera o segredo mesmo quando o callback lança', async () => {
    const c = contexto()
    const { cifrado, dekCifrada, kekVersao } = await cliente.cifrar(c, Buffer.from('senha'))

    let espiado: Buffer | null = null
    await expect(
      cliente.usarSegredo({ ...c, kekVersao }, dekCifrada, cifrado, (claro) => {
        espiado = claro
        throw new Error('o adapter falhou no meio')
      }),
    ).rejects.toThrow('o adapter falhou')

    expect(espiado!).toEqual(Buffer.alloc(5))
  })
})

describe('o transplante de linha', () => {
  it('**as colunas de outra conexão não abrem**', async () => {
    // O cenário do ADR 0018: quem tem escrita no banco copia
    // `credenciais_cifradas` e `dek_cifrada` de uma linha para outra. Sem AAD, o
    // desembrulho funcionaria normalmente.
    const { cifrado, dekCifrada, kekVersao } = await cliente.cifrar(
      contexto(),
      Buffer.from('credencial da Ana'),
    )

    const alheio = { ...contexto({ recursoId: 'cccccccc-0000-4000-8000-000000000002' }), kekVersao }

    await expect(cliente.usarSegredo(alheio, dekCifrada, cifrado, (c) => c)).rejects.toThrow()
  })

  it('**as colunas de outro tenant não abrem**', async () => {
    const { cifrado, dekCifrada, kekVersao } = await cliente.cifrar(contexto(), Buffer.from('x'))

    const alheio = { ...contexto({ tenantId: 'dbdbdbdb-0000-4000-8000-000000000002' }), kekVersao }

    await expect(cliente.usarSegredo(alheio, dekCifrada, cifrado, (c) => c)).rejects.toThrow()
  })

  it('**o segredo de MFA não abre como credencial de conexão**', async () => {
    const mfa = { proposito: 'usuario.mfa' as const, tenantId: SEM_TENANT, recursoId: 'u-1' }
    const { cifrado, dekCifrada, kekVersao } = await cliente.cifrar(mfa, Buffer.from('JBSWY3DP'))

    const comoConexao = { ...contexto({ recursoId: 'u-1' }), kekVersao }

    await expect(cliente.usarSegredo(comoConexao, dekCifrada, cifrado, (c) => c)).rejects.toThrow()
  })
})

describe('a rotação', () => {
  it('**o ciphertext da credencial não é tocado**', async () => {
    // O que torna a rotação de KEK rotina em vez de evento de risco: só a DEK
    // troca de envelope. Se a rotação precisasse decifrar as credenciais, todo
    // segredo do sistema passaria pela memória da API no mesmo minuto.
    const c = contexto()
    const { cifrado, dekCifrada } = await cliente.cifrar(c, Buffer.from('senha do banco'))

    // A janela de rotação, como no runbook: a versão nova entra pela entrada
    // padrão e as duas ficam carregadas.
    processo.stdin.write(`2 ${KEK_2}\n`)
    await esperar(processo, /DESSELADO na versão 2/)

    const novoEnvelope = await cliente.reenvelopar({ ...c, kekVersao: 1 }, dekCifrada, 2)
    expect(novoEnvelope).not.toEqual(dekCifrada)

    const lido = await cliente.usarSegredo(
      { ...c, kekVersao: 2 },
      novoEnvelope,
      cifrado, // o mesmo ciphertext de antes
      (claro) => claro.toString('utf8'),
    )
    expect(lido).toBe('senha do banco')
  })
})

describe('o pepper do ip_hash', () => {
  it('é estável e separado por propósito', async () => {
    const ip = Buffer.from('192.0.2.7')

    expect(await cliente.hash('ip', ip)).toEqual(await cliente.hash('ip', ip))
    expect(await cliente.hash('ip', ip)).not.toEqual(await cliente.hash('user-agent', ip))
  })
})

describe('quando o guardião não responde', () => {
  it('**sem socket configurado, nada degrada em silêncio**', async () => {
    // O estado é legítimo: hoje não há agregador ligado, e o resto da API
    // funciona sem guardião. O que não pode existir é uma chave de
    // desenvolvimento que dê a aparência de cifrado.
    const sem = new ClienteDoGuardiao({ caminho: '' })

    expect(sem.configurado).toBe(false)
    await expect(sem.cifrar(contexto(), Buffer.from('x'))).rejects.toThrow(GuardiaoIndisponivel)
    expect(await sem.estado()).toEqual({ configurado: false, selado: true, kekVersao: null })
  })

  it('socket inexistente vira erro tipado, e não trava', async () => {
    const morto = new ClienteDoGuardiao({ caminho: socketDe('inexistente'), prazoMs: 500 })

    await expect(morto.cifrar(contexto(), Buffer.from('x'))).rejects.toThrow(GuardiaoIndisponivel)
    expect(await morto.estado()).toMatchObject({ configurado: true, selado: true })
  })

  it('**guardião selado não vira "cifrou" — vira erro**', async () => {
    // O estado depois de todo reboot da VPS, até alguém desselar.
    const socket = socketDe('selado')
    const filho = await subir(socket, join(PASTA, 'selado.jsonl'))

    try {
      const c = new ClienteDoGuardiao({ caminho: socket })
      await expect(c.cifrar(contexto(), Buffer.from('x'))).rejects.toThrow(/selado/)
      expect(await c.estado()).toMatchObject({ configurado: true, selado: true })
    } finally {
      filho.kill()
    }
  }, 60_000)
})

describe('a superfície do cliente', () => {
  it('**não existe método que devolva a DEK**', () => {
    // A tentação é um `obterDek()` "para o caso de precisar". Ele viraria cache,
    // e o cache desfaz as propriedades 3 e 4 do ADR sozinho: o teto de
    // desembrulho e o registro fora do Postgres só valem se todo uso passar pelo
    // guardião, todas as vezes.
    const metodos = Object.getOwnPropertyNames(Object.getPrototypeOf(cliente))

    expect(metodos.filter((m) => /dek/i.test(m))).toEqual([])
  })

  it('**o diário fora do Postgres registrou os desembrulhos**', async () => {
    const c = contexto({ recursoId: 'cccccccc-0000-4000-8000-00000000000d' })
    const { cifrado, dekCifrada, kekVersao } = await cliente.cifrar(c, Buffer.from('x'))
    await cliente.usarSegredo({ ...c, kekVersao }, dekCifrada, cifrado, () => null)

    const linhas = readFileSync(DIARIO, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)

    expect(
      linhas.some(
        (l) => l['operacao'] === 'desenvelopar' && l['recursoId'] === c.recursoId,
      ),
    ).toBe(true)

    // E o diário não é uma segunda cópia do segredo.
    expect(readFileSync(DIARIO, 'utf8')).not.toContain(KEK_1)
  })
})
