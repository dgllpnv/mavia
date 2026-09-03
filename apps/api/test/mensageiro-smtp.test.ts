import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EnvioFalhou, MensageiroSmtp } from '../src/mensageiro/mensageiro.js'

/**
 * O mensageiro contra um servidor SMTP **de verdade**.
 *
 * O cliente é ~200 linhas de protocolo escritas à mão, e protocolo escrito à
 * mão que nunca falou com um servidor real é código que ainda não existe: as
 * armadilhas do SMTP não são de lógica, são de formato. Resposta multilinha,
 * quebra de linha `\r\n`, base64 do assunto, negociação de STARTTLS — cada uma
 * dessas passa em qualquer duplo e falha na primeira conversa real.
 *
 * Mailpit, e não um fake: ele aceita tudo, não entrega nada para fora, e
 * devolve a caixa por HTTP — o que permite conferir o que **chegou**, e não só
 * o que foi escrito no socket.
 */

let servidor: StartedTestContainer
let porta: number
let tela: string

const mensageiro = () =>
  new MensageiroSmtp({
    host: servidor.getHost(),
    porta,
    tlsDireto: false,
    remetente: 'Mavia <ola@mavia.test>',
    prazoMs: 10_000,
  })

interface Recebida {
  readonly ID: string
  readonly Subject: string
  readonly To: readonly { readonly Address: string }[]
}

async function caixa(): Promise<readonly Recebida[]> {
  const r = await fetch(`${tela}/api/v1/messages`)
  return ((await r.json()) as { messages: Recebida[] }).messages
}

async function corpoDe(id: string): Promise<string> {
  const r = await fetch(`${tela}/api/v1/message/${id}`)
  return ((await r.json()) as { Text: string }).Text
}

beforeAll(async () => {
  servidor = await new GenericContainer('axllent/mailpit:latest')
    .withExposedPorts(1025, 8025)
    .withEnvironment({ MP_SMTP_AUTH_ACCEPT_ANY: '1', MP_SMTP_AUTH_ALLOW_INSECURE: '1' })
    .start()

  porta = servidor.getMappedPort(1025)
  tela = `http://${servidor.getHost()}:${servidor.getMappedPort(8025)}`
}, 180_000)

afterAll(async () => {
  await servidor?.stop()
})

describe('a conversa', () => {
  it('a mensagem chega, e chega inteira', async () => {
    await mensageiro().enviar({
      para: 'ana@exemplo.test',
      assunto: 'Confirme seu cadastro na Mavia',
      corpo: 'Uma linha.\nOutra linha.\n\nhttp://127.0.0.1:4710/confirmar?t=abc',
    })

    const recebidas = await caixa()
    const nossa = recebidas.find((m) => m.To.some((t) => t.Address === 'ana@exemplo.test'))

    expect(nossa).toBeTruthy()
    expect(nossa!.Subject).toBe('Confirme seu cadastro na Mavia')

    const texto = await corpoDe(nossa!.ID)
    expect(texto).toContain('Outra linha.')
    // O link precisa atravessar inteiro: é a credencial da pessoa.
    expect(texto).toContain('/confirmar?t=abc')
  })

  it('**o acento sobrevive no assunto e no corpo**', async () => {
    // Sem a codificação RFC 2047 no assunto e base64 no corpo, "confirmação"
    // chega "confirmaÃ§Ã£o" em metade dos clientes de e-mail — e o primeiro
    // contato do produto com a pessoa é um texto quebrado.
    await mensageiro().enviar({
      para: 'acento@exemplo.test',
      assunto: 'Confirmação de cadastro — ação necessária',
      corpo: 'Você não precisa fazer nada além de abrir o endereço. Até já.',
    })

    const nossa = (await caixa()).find((m) =>
      m.To.some((t) => t.Address === 'acento@exemplo.test'),
    )

    expect(nossa!.Subject).toBe('Confirmação de cadastro — ação necessária')
    expect(await corpoDe(nossa!.ID)).toContain('Você não precisa')
  })

  it('**uma linha que começa com ponto não encerra a mensagem**', async () => {
    // O ponto sozinho no início da linha é o terminador dos dados no SMTP. Sem
    // tratamento, a mensagem chegaria cortada ali — e o link, que vem depois,
    // sumiria.
    await mensageiro().enviar({
      para: 'ponto@exemplo.test',
      assunto: 'Ponto',
      corpo: 'antes\n.\ndepois\nhttp://127.0.0.1:4710/confirmar?t=dep',
    })

    const nossa = (await caixa()).find((m) => m.To.some((t) => t.Address === 'ponto@exemplo.test'))
    const texto = await corpoDe(nossa!.ID)

    expect(texto).toContain('depois')
    expect(texto).toContain('t=dep')
  })

  it('autentica quando há usuário e senha', async () => {
    const comAuth = new MensageiroSmtp({
      host: servidor.getHost(),
      porta,
      usuario: 'mavia',
      senha: 'qualquer',
      tlsDireto: false,
      remetente: 'ola@mavia.test',
      prazoMs: 10_000,
    })

    await expect(
      comAuth.enviar({ para: 'auth@exemplo.test', assunto: 'Auth', corpo: 'ok' }),
    ).resolves.toBeUndefined()
  })
})

describe('o que o mensageiro recusa', () => {
  it('**quebra de linha no destinatário é injeção de cabeçalho**', async () => {
    // `para: "ana@x\nBcc: todo-mundo@y"` mandaria a mensagem para uma lista
    // inteira. A recusa acontece antes de qualquer byte entrar no socket.
    await expect(
      mensageiro().enviar({
        para: 'ana@exemplo.test\r\nBcc: todos@exemplo.test',
        assunto: 'Injeção',
        corpo: 'x',
      }),
    ).rejects.toThrow(EnvioFalhou)
  })

  it('quebra de linha no assunto também', async () => {
    await expect(
      mensageiro().enviar({ para: 'a@b.test', assunto: 'Um\nDois', corpo: 'x' }),
    ).rejects.toThrow(EnvioFalhou)
  })

  it('**servidor inalcançável lança, e não engole**', async () => {
    // Um envio que não aconteceu não pode virar 202: a pessoa esperaria o
    // e-mail para sempre, e o log diria que deu certo.
    const morto = new MensageiroSmtp({
      host: '127.0.0.1',
      // Uma porta do bloco 47xx que ninguém escuta.
      porta: 4799,
      tlsDireto: false,
      remetente: 'ola@mavia.test',
      prazoMs: 2_000,
    })

    await expect(
      morto.enviar({ para: 'a@b.test', assunto: 'x', corpo: 'y' }),
    ).rejects.toThrow(EnvioFalhou)
  })
})

describe('STARTTLS', () => {
  it('**um servidor remoto sem STARTTLS é recusado**', async () => {
    // Mailpit não oferece STARTTLS. Contra ele em loopback isso é aceitável —
    // não há rede entre os dois lados. Contra qualquer outro endereço, mandar o
    // token de recuperação em texto claro seria entregar a credencial a quem
    // estiver no caminho.
    //
    // A regra é **derivada do endereço**, e não de uma variável: um
    // `SMTP_TLS=false` seria a linha que alguém copia para produção para fazer
    // um provedor difícil funcionar, e ninguém revisa depois.
    const host = servidor.getHost()

    // O container é alcançável por um endereço que não é loopback quando o
    // Docker não está na própria máquina; quando está, este caso é o de baixo.
    if (host === 'localhost' || host === '127.0.0.1') {
      const { MensageiroSmtp: M } = await import('../src/mensageiro/mensageiro.js')
      // O mesmo servidor, alcançado pelo nome do host da máquina — que não é
      // loopback e portanto exige TLS.
      const remoto = new M({
        host: '0.0.0.0',
        porta,
        tlsDireto: false,
        remetente: 'ola@mavia.test',
        prazoMs: 5_000,
      })

      // A recusa precisa ser **pela regra**, e não por qualquer falha de rede:
      // um `toThrow(EnvioFalhou)` aqui passaria também se o socket nem tivesse
      // aberto, e o teste deixaria de provar o que existe para provar.
      await expect(
        remoto.enviar({ para: 'a@b.test', assunto: 'x', corpo: 'y' }),
      ).rejects.toThrow(/não oferece STARTTLS/)
      return
    }

    await expect(
      mensageiro().enviar({ para: 'a@b.test', assunto: 'x', corpo: 'y' }),
    ).rejects.toThrow(/STARTTLS/)
  })

  it('em loopback, sem STARTTLS, entrega', async () => {
    // O outro lado da mesma regra: o ambiente de desenvolvimento funciona.
    await expect(
      mensageiro().enviar({ para: 'local@exemplo.test', assunto: 'Local', corpo: 'ok' }),
    ).resolves.toBeUndefined()
  })
})
