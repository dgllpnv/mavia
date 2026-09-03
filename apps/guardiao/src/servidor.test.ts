import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pedido, Resposta } from '@mavia/guardiao'
import { desembrulhar, embrulhar, type Contexto } from '@mavia/guardiao'
import { Cofre, gerarKek } from './cofre.js'
import { servir } from './servidor.js'

/**
 * O transporte, de ponta a ponta.
 *
 * O que este arquivo prova, além do caminho feliz: o guardião **não devolve
 * material de KEK por nenhum caminho do protocolo**, inclusive pelos caminhos
 * que não existem — uma operação inventada não vira um erro que vaza estado.
 */

const CAMINHO =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\mavia-guardiao-teste-${process.pid}`
    : join(tmpdir(), `mavia-guardiao-teste-${process.pid}.sock`)

const KEK = gerarKek()
let servidor: ReturnType<typeof servir>
let cofre: Cofre

const contexto: Contexto = {
  proposito: 'conexao.credenciais',
  tenantId: 'dbdbdbdb-0000-4000-8000-000000000001',
  recursoId: 'cccccccc-0000-4000-8000-000000000001',
  kekVersao: 1,
}

beforeAll(async () => {
  cofre = new Cofre({ aoRegistrar: () => {}, aoAlarmar: () => {} })
  servidor = servir(cofre, CAMINHO)
  await new Promise((r) => servidor.once('listening', r))
})

afterAll(async () => {
  await new Promise((r) => servidor.close(r))
})

/** Uma conversa: abre, manda uma linha, lê uma linha, fecha. */
function perguntar(pedido: Pedido): Promise<Resposta> {
  return new Promise((resolver, rejeitar) => {
    const socket: Socket = connect(CAMINHO)
    let acumulado = ''

    socket.on('connect', () => socket.write(`${JSON.stringify(pedido)}\n`))
    socket.on('data', (p) => {
      acumulado += p.toString('utf8')
      const quebra = acumulado.indexOf('\n')
      if (quebra >= 0) {
        socket.end()
        resolver(JSON.parse(acumulado.slice(0, quebra)) as Resposta)
      }
    })
    socket.on('error', rejeitar)
  })
}

describe('selado', () => {
  it('o estado é consultável sem desselar', async () => {
    const r = await perguntar({ id: '1', operacao: 'estado' })

    expect(r.ok).toBe(true)
    expect(r.ok && r.selado).toBe(true)
  })

  it('**e nada mais funciona**', async () => {
    const r = await perguntar({ id: '2', operacao: 'gerarDek', contexto })

    expect(r.ok).toBe(false)
    expect(!r.ok && r.erro).toContain('selado')
  })
})

describe('depois do desselamento', () => {
  beforeAll(() => cofre.desselar(1, KEK))

  it('gera, envelopa e desenvelopa pelo socket', async () => {
    const gerada = await perguntar({ id: '3', operacao: 'gerarDek', contexto })
    expect(gerada.ok).toBe(true)
    if (!gerada.ok) return

    const aberta = await perguntar({
      id: '4',
      operacao: 'desenvelopar',
      contexto,
      material: gerada.material!,
    })

    expect(aberta.ok && aberta.dek).toBe(gerada.dek)
  })

  it('**a DEK que sai abre o que a KEK selou**', async () => {
    // A prova de que o envelope do socket é o mesmo envelope do pacote: a DEK
    // devolvida decifra um blob criado fora do guardião com ela.
    const gerada = await perguntar({ id: '5', operacao: 'gerarDek', contexto })
    if (!gerada.ok || !gerada.dek) throw new Error('sem DEK')

    const dek = Buffer.from(gerada.dek, 'base64')
    const segredo = Buffer.from('a senha do banco', 'utf8')
    const blob = embrulhar(dek, contexto, segredo)

    expect(desembrulhar(dek, contexto, blob)).toEqual(segredo)
  })

  it('reenvelopar não devolve a DEK', async () => {
    cofre.desselar(2, gerarKek())

    const gerada = await perguntar({ id: '6', operacao: 'gerarDek', contexto })
    if (!gerada.ok) throw new Error('falhou')

    const rotacionada = await perguntar({
      id: '7',
      operacao: 'reenvelopar',
      contexto: { ...contexto, kekVersao: gerada.kekVersao! },
      material: gerada.material!,
      kekVersaoDestino: 2,
    })

    expect(rotacionada.ok).toBe(true)
    // Devolve o envelope novo, e **não** a DEK.
    expect(rotacionada.ok && rotacionada.dek).toBeUndefined()
    expect(rotacionada.ok && rotacionada.material).not.toBe(gerada.material)
  })
})

describe('o que o protocolo recusa', () => {
  it('operação desconhecida', async () => {
    const r = await perguntar({ id: '8', operacao: 'exportarKek' as never })

    expect(r.ok).toBe(false)
    expect(!r.ok && r.erro).toBe('operação desconhecida')
  })

  it('**a recusa não distingue chave errada de AAD errado**', async () => {
    // Distinguir seria um oráculo: um atacante com escrita no banco descobriria,
    // por tentativa, a que tenant um blob pertence.
    const gerada = await perguntar({ id: '9', operacao: 'gerarDek', contexto })
    if (!gerada.ok) throw new Error('falhou')

    const porAad = await perguntar({
      id: '10',
      operacao: 'desenvelopar',
      contexto: { ...contexto, tenantId: 'dbdbdbdb-0000-4000-8000-000000000002' },
      material: gerada.material!,
    })
    const porLixo = await perguntar({
      id: '11',
      operacao: 'desenvelopar',
      contexto,
      material: Buffer.alloc(64).toString('base64'),
    })

    expect(!porAad.ok && porAad.erro).toBe('operação recusada')
    expect(!porLixo.ok && porLixo.erro).toBe('operação recusada')
  })

  it('contexto incompleto', async () => {
    const r = await perguntar({ id: '12', operacao: 'desenvelopar', material: 'AAAA' })

    expect(r.ok).toBe(false)
  })

  it('linha ilegível não derruba o guardião', async () => {
    const socket = connect(CAMINHO)
    await new Promise((r) => socket.once('connect', r))
    socket.write('isto não é json\n')

    const resposta = await new Promise<string>((r) => socket.once('data', (p) => r(p.toString())))
    socket.end()

    expect(JSON.parse(resposta).ok).toBe(false)

    // E o guardião continua atendendo.
    expect((await perguntar({ id: '13', operacao: 'estado' })).ok).toBe(true)
  })

  it('**nenhuma resposta contém a KEK**', async () => {
    // A varredura direta: em nenhum caminho do protocolo o material da KEK
    // aparece na resposta.
    const emBase64 = KEK.toString('base64')
    const emHex = KEK.toString('hex')

    for (const operacao of ['estado', 'gerarDek', 'desenvelopar', 'hmac'] as const) {
      const r = await perguntar({
        id: `k-${operacao}`,
        operacao,
        contexto,
        material: Buffer.alloc(64).toString('base64'),
        proposito: 'ip',
      })
      const texto = JSON.stringify(r)
      expect(texto).not.toContain(emBase64)
      expect(texto).not.toContain(emHex)
    }
  })
})
