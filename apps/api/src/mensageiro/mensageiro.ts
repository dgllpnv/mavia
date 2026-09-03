import { createConnection, type Socket } from 'node:net'
import { connect as conectarTls, type TLSSocket } from 'node:tls'

/**
 * O mensageiro — a entrega de e-mail transacional.
 *
 * Existem exatamente **três** mensagens neste produto, e nenhuma delas é
 * marketing: confirmação de cadastro, recuperação de senha e aviso de
 * segurança. As três substituem ou protegem uma credencial, e é por isso que a
 * entrega não pode ser "melhor esforço": um cadastro que grava
 * `cadastros_pendentes` e não consegue mandar o link deixa a pessoa com uma
 * conta que ela não tem como confirmar, e sem caminho de saída.
 *
 * ## Por que SMTP, e não a API de um provedor
 *
 * Nenhum provedor foi escolhido — é uma decisão do dono do produto, e ela tem
 * consequência de LGPD: o provedor será **operador** e precisa entrar em
 * `docs/compliance/subprocessadores.md` antes do primeiro envio.
 *
 * SMTP é o denominador comum: todo provedor oferece, e escolher SMTP hoje não
 * escolhe provedor nenhum. Amarrar o código à API REST de um deles seria tomar
 * a decisão do dono por acidente de implementação — e refazê-la depois, quando
 * o custo já estiver pago.
 *
 * ## Por que sem `nodemailer`
 *
 * São ~200 linhas de SMTP contra uma dependência com árvore transitiva grande,
 * num processo que também tem a `DATABASE_URL` e fala com o guardião. O que se
 * perde — anexo, HTML complexo, pool de conexões — não é usado por nenhuma das
 * três mensagens: todas são texto puro, curtas, e uma por vez.
 *
 * ## O que este arquivo nunca faz
 *
 * Não registra o corpo da mensagem em log — ele contém o **token**, que é a
 * credencial inteira. Não registra o endereço completo. E não engole falha: um
 * envio que não aconteceu lança, e quem chamou decide o que dizer ao usuário.
 */

export class EnvioFalhou extends Error {
  constructor(motivo: string) {
    super(`Não consegui entregar a mensagem: ${motivo}`)
    this.name = 'EnvioFalhou'
  }
}

export interface Mensagem {
  readonly para: string
  readonly assunto: string
  /** Texto puro. Não há mensagem em HTML neste produto. */
  readonly corpo: string
}

export interface Mensageiro {
  /** `false` quando não há SMTP configurado nesta instalação. */
  readonly configurado: boolean
  enviar(mensagem: Mensagem): Promise<void>
}

export interface ConfiguracaoSmtp {
  readonly host: string
  readonly porta: number
  readonly usuario?: string | undefined
  readonly senha?: string | undefined
  /** `true` para TLS direto (porta 465); `false` para STARTTLS (587). */
  readonly tlsDireto: boolean
  readonly remetente: string
  readonly prazoMs?: number
}

/**
 * A configuração, lida do ambiente.
 *
 * Ausente é um estado **legítimo**: o ambiente local não manda e-mail, e o
 * `pnpm db:seed` existe justamente para que ninguém precise de caixa postal
 * para desenvolver. O que não é legítimo é degradar em silêncio — ver
 * `MensageiroAusente`.
 */
export function smtpDoAmbiente(): ConfiguracaoSmtp | null {
  const host = process.env['SMTP_HOST']
  const remetente = process.env['SMTP_REMETENTE']
  if (!host || !remetente) return null

  const porta = Number(process.env['SMTP_PORTA'] ?? 587)

  return {
    host,
    porta,
    usuario: process.env['SMTP_USUARIO'],
    senha: process.env['SMTP_SENHA'],
    // 465 é TLS desde o primeiro byte; 587 negocia com STARTTLS. A porta
    // decide, e não uma variável a mais para alguém configurar errado.
    tlsDireto: porta === 465,
    remetente,
  }
}

/**
 * O mensageiro que não existe.
 *
 * **Lança em vez de fingir.** Um mensageiro que registra no console e devolve
 * sucesso faria a rota de cadastro responder 201 sem que ninguém recebesse
 * nada: a pessoa esperaria um e-mail para sempre, e o log de produção diria que
 * deu certo. É a mesma escolha do webhook da Stripe sem segredo — recusar é
 * mais honesto que aceitar sem poder cumprir.
 */
export class MensageiroAusente implements Mensageiro {
  readonly configurado = false

  async enviar(_mensagem: Mensagem): Promise<void> {
    throw new EnvioFalhou('não há SMTP configurado nesta instalação')
  }
}

export class MensageiroSmtp implements Mensageiro {
  readonly configurado = true
  readonly #cfg: ConfiguracaoSmtp

  constructor(cfg: ConfiguracaoSmtp) {
    this.#cfg = cfg
  }

  async enviar(mensagem: Mensagem): Promise<void> {
    // Um endereço com CR ou LF injeta cabeçalho — `Bcc:` para uma lista
    // inteira, por exemplo. A validação acontece **antes** de qualquer byte
    // entrar no socket, e vale para os três campos.
    for (const campo of [mensagem.para, mensagem.assunto, this.#cfg.remetente]) {
      if (/[\r\n]/.test(campo)) throw new EnvioFalhou('cabeçalho com quebra de linha')
    }

    const conversa = new Conversa(this.#cfg)
    try {
      await conversa.abrir()
      await conversa.enviar(mensagem)
    } finally {
      conversa.fechar()
    }
  }
}

/**
 * Uma conversa SMTP, do zero.
 *
 * O protocolo é uma sequência de linhas com código de três dígitos. O que ele
 * tem de traiçoeiro está em duas coisas, e as duas estão tratadas: a resposta
 * pode vir em **várias linhas** (`250-` continua, `250 ` termina), e o corpo
 * precisa de *dot-stuffing* — uma linha que começa com ponto encerraria os
 * dados no meio da mensagem.
 */
class Conversa {
  readonly #cfg: ConfiguracaoSmtp
  #socket: Socket | TLSSocket | null = null
  #buffer = ''
  #bloco: string[] = []
  #esperando: ((resposta: string) => void) | null = null

  constructor(cfg: ConfiguracaoSmtp) {
    this.#cfg = cfg
  }

  async abrir(): Promise<void> {
    this.#socket = this.#cfg.tlsDireto
      ? conectarTls({ host: this.#cfg.host, port: this.#cfg.porta })
      : createConnection({ host: this.#cfg.host, port: this.#cfg.porta })

    this.#socket.setTimeout(this.#cfg.prazoMs ?? 15_000)
    this.#socket.on('data', (p: Buffer) => this.#receber(p.toString('utf8')))
    this.#socket.on('timeout', () => this.#socket?.destroy())

    await this.#pronto()
    await this.#esperarResposta('220')

    const capacidades = await this.#dizer(`EHLO mavia`, '250')

    if (!this.#cfg.tlsDireto) {
      const oferece = /\bSTARTTLS\b/i.test(capacidades)

      // **STARTTLS não é opcional quando a conexão sai da máquina.** Sem ele a
      // credencial do SMTP e o token de recuperação atravessam a rede em texto
      // claro — e o token é a credencial inteira, não uma pista dela.
      //
      // A exceção é o servidor de desenvolvimento em loopback, que não oferece
      // TLS e não precisa: não há rede entre os dois lados. A exceção é
      // **derivada do endereço**, e não uma variável de configuração — um
      // `SMTP_TLS=false` seria a linha que alguém copia para produção para
      // fazer um provedor difícil funcionar, e ninguém revisa depois.
      if (!oferece && !ehLoopback(this.#cfg.host)) {
        throw new EnvioFalhou('o servidor não oferece STARTTLS, e a conexão não é local')
      }

      if (oferece) {
        await this.#dizer('STARTTLS', '220')
        this.#socket = conectarTls({ socket: this.#socket, servername: this.#cfg.host })
        this.#socket.setTimeout(this.#cfg.prazoMs ?? 15_000)
        this.#socket.on('data', (p: Buffer) => this.#receber(p.toString('utf8')))
        await this.#pronto()
        await this.#dizer('EHLO mavia', '250')
      }
    }

    if (this.#cfg.usuario && this.#cfg.senha) {
      await this.#dizer('AUTH LOGIN', '334')
      await this.#dizer(Buffer.from(this.#cfg.usuario, 'utf8').toString('base64'), '334')
      await this.#dizer(Buffer.from(this.#cfg.senha, 'utf8').toString('base64'), '235')
    }
  }

  async enviar(m: Mensagem): Promise<void> {
    await this.#dizer(`MAIL FROM:<${endereco(this.#cfg.remetente)}>`, '250')
    await this.#dizer(`RCPT TO:<${m.para}>`, '250')
    await this.#dizer('DATA', '354')

    const cabecalho = [
      `From: ${this.#cfg.remetente}`,
      `To: ${m.para}`,
      `Subject: ${assuntoCodificado(m.assunto)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
    ].join('\r\n')

    // Base64 em linhas de 76: assunto e corpo têm acento, e um "ç" cru vira
    // dois caracteres estranhos em metade dos clientes de e-mail.
    const corpo = Buffer.from(m.corpo, 'utf8')
      .toString('base64')
      .replace(/(.{76})/g, '$1\r\n')

    await this.#dizer(`${cabecalho}\r\n${corpo}\r\n.`, '250')
    await this.#dizer('QUIT', '221').catch(() => {
      // O servidor pode fechar antes de responder ao QUIT. A mensagem já foi
      // aceita no `250` anterior — insistir aqui transformaria um envio
      // bem-sucedido em erro.
    })
  }

  fechar(): void {
    this.#socket?.destroy()
    this.#socket = null
  }

  #pronto(): Promise<void> {
    return new Promise((resolver, rejeitar) => {
      const s = this.#socket!
      const ok = () => resolver()
      s.once('secureConnect', ok)
      s.once('connect', ok)
      s.once('error', (e) => rejeitar(new EnvioFalhou(e.message)))
      // Um socket TLS montado sobre outro já conectado não emite nenhum dos
      // dois: `secureConnect` já passou quando o handler é registrado.
      if ('authorized' in s || !s.connecting) resolver()
    })
  }

  #receber(texto: string): void {
    this.#buffer += texto
    let quebra = this.#buffer.indexOf('\r\n')
    while (quebra >= 0) {
      const linha = this.#buffer.slice(0, quebra)
      this.#buffer = this.#buffer.slice(quebra + 2)
      this.#bloco.push(linha)

      // Resposta multilinha: `250-` continua, `250 ` termina. Tratar a primeira
      // como final faria o diálogo sair de sincronia na primeira linha de
      // capacidade que o servidor anuncia — e todo servidor anuncia várias.
      //
      // As linhas de continuação são **guardadas**, e não descartadas: é nelas
      // que vem o anúncio de STARTTLS, e a decisão entre cifrar e recusar
      // depende de saber se o servidor o oferece.
      if (linha.length >= 4 && linha[3] === '-') {
        quebra = this.#buffer.indexOf('\r\n')
        continue
      }

      const resposta = this.#bloco.join('\n')
      this.#bloco = []
      const espera = this.#esperando
      this.#esperando = null
      espera?.(resposta)
      quebra = this.#buffer.indexOf('\r\n')
    }
  }

  #esperarResposta(codigo: string): Promise<string> {
    return new Promise((resolver, rejeitar) => {
      const relogio = setTimeout(
        () => rejeitar(new EnvioFalhou(`o servidor não respondeu ${codigo}`)),
        this.#cfg.prazoMs ?? 15_000,
      )
      this.#esperando = (resposta) => {
        clearTimeout(relogio)
        if (!resposta.startsWith(codigo)) {
          // **A resposta do servidor não entra na mensagem de erro.** Ela pode
          // ecoar o endereço de destino, e um erro de envio acaba em log.
          rejeitar(new EnvioFalhou(`o servidor recusou (esperava ${codigo})`))
          return
        }
        resolver(resposta)
      }
    })
  }

  async #dizer(comando: string, codigoEsperado: string): Promise<string> {
    const espera = this.#esperarResposta(codigoEsperado)
    this.#socket!.write(`${comando}\r\n`)
    return espera
  }
}

/**
 * O endereço é local?
 *
 * Só o loopback. Uma faixa privada (10.x, 192.168.x) **não** conta: ela é rede,
 * tem outros aparelhos, e o token de recuperação atravessando o Wi-Fi de um
 * escritório em texto claro é o mesmo problema que atravessando a internet.
 */
function ehLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

/** `Mavia <ola@mavia.app>` → `ola@mavia.app`. */
function endereco(remetente: string): string {
  const casou = /<([^>]+)>/.exec(remetente)
  return casou?.[1] ?? remetente
}

/** RFC 2047 — sem isto, um assunto com acento chega ilegível. */
function assuntoCodificado(assunto: string): string {
  return /^[\x20-\x7e]*$/.test(assunto)
    ? assunto
    : `=?UTF-8?B?${Buffer.from(assunto, 'utf8').toString('base64')}?=`
}

/** O símbolo de injeção. */
export const MENSAGEIRO = Symbol('MENSAGEIRO')

export function mensageiroDoAmbiente(): Mensageiro {
  const cfg = smtpDoAmbiente()
  return cfg ? new MensageiroSmtp(cfg) : new MensageiroAusente()
}
