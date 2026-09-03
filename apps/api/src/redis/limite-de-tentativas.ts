import { createHash } from 'node:crypto'
import type Redis from 'ioredis'

/**
 * Limite de tentativas de login — a pendência P-2.
 *
 * Duas janelas independentes, e as duas precisam existir:
 *
 * - **por endereço**, que contém o ataque de senha contra uma conta conhecida;
 * - **por origem**, que contém o *password spraying* — uma senha comum contra
 *   milhares de endereços, em que o contador por endereço nunca chega a dois.
 *
 * Um contador em memória do processo foi descartado de propósito quando esta
 * pendência foi escrita: ele dá a sensação de proteção, evapora no primeiro
 * reinício e conta errado atrás de qualquer balanceador. Redis é o estado
 * compartilhado que faz o número significar alguma coisa.
 *
 * ## O que este limite não é
 *
 * Não é a defesa principal. A verificação fantasma dá tempo constante entre
 * "endereço não existe" e "senha errada", e o Argon2id impõe ~20 ms por
 * tentativa. O limite é a terceira camada — a que transforma "caro" em
 * "impossível dentro da janela".
 *
 * ## Privacidade
 *
 * Nem o endereço nem o IP entram na chave em claro: um dump do Redis não pode
 * virar uma lista de quem tentou entrar. O `pepper` vem do ambiente, e sem ele
 * o processo recusa a subir — uma chave sem pepper é reversível por força bruta
 * sobre o espaço de endereços conhecidos.
 */

/** Janela deslizante. Curta o bastante para não punir quem errou a senha. */
const JANELA_EM_SEGUNDOS = 15 * 60

/** Tentativas por endereço dentro da janela. */
const TETO_POR_ENDERECO = 10

/**
 * **Falhas** por origem. Não tentativas: falhas.
 *
 * A assimetria é deliberada, e é o que faz o número significar alguma coisa.
 * O contador por endereço protege **uma conta**, e por isso conta tudo —
 * inclusive os acertos, senão um atacante com uma credencial válida entre mil
 * inválidas passaria sem nunca acionar o limite.
 *
 * O contador por origem protege contra *password spraying*, e spraying é feito
 * de **erro**: uma senha comum contra milhares de endereços acerta pouco por
 * construção. Contar acertos aqui não acrescenta sinal e cria um falso
 * positivo caro — uma família atrás do mesmo NAT, um escritório, ou a própria
 * suíte E2E entrando dezoito vezes seguidas ficariam trancados por estarem
 * usando o produto corretamente.
 */
const TETO_DE_FALHAS_POR_ORIGEM = 100

export class LimiteExcedido extends Error {
  constructor(readonly segundosAteLiberar: number) {
    super('Muitas tentativas. Espere alguns minutos antes de tentar de novo.')
    this.name = 'LimiteExcedido'
  }
}

function marca(pepper: string, tipo: string, valor: string): string {
  const h = createHash('sha256').update(`${pepper}:${tipo}:${valor}`, 'utf8').digest('hex')
  return `tentativas:${tipo}:${h.slice(0, 32)}`
}

export class LimiteDeTentativas {
  constructor(
    private readonly redis: Redis,
    private readonly pepper: string,
  ) {
    if (pepper.length < 16) {
      throw new Error(
        'MAVIA_PEPPER_TENTATIVAS ausente ou curto demais. Sem pepper, a chave do ' +
          'contador é reversível por força bruta sobre endereços conhecidos.',
      )
    }
  }

  /**
   * Conta a tentativa contra o endereço e confere as duas janelas.
   *
   * O incremento do endereço acontece **antes** da verificação da credencial, e
   * acontece mesmo para endereço inexistente: não contar o inexistente seria um
   * oráculo de existência com outro nome — o atacante saberia que travou porque
   * a conta existe.
   *
   * A janela por origem é apenas **lida** aqui. Quem a incrementa é
   * `registrarFalha`, e só quando a credencial não confere.
   */
  async registrar(endereco: string, origem: string): Promise<void> {
    const doEndereco = marca(this.pepper, 'endereco', endereco.toLowerCase())
    const daOrigem = marca(this.pepper, 'origem', origem)

    const resultado = await this.redis
      .multi()
      .incr(doEndereco)
      .expire(doEndereco, JANELA_EM_SEGUNDOS, 'NX')
      .get(daOrigem)
      .exec()

    const tentativas = Number(resultado?.[0]?.[1] ?? 0)
    if (tentativas > TETO_POR_ENDERECO) throw await this.excedido(doEndereco)

    const falhas = Number(resultado?.[2]?.[1] ?? 0)
    if (falhas > TETO_DE_FALHAS_POR_ORIGEM) throw await this.excedido(daOrigem)
  }

  /** Chamada **só** quando a credencial não confere. */
  async registrarFalha(origem: string): Promise<void> {
    const chave = marca(this.pepper, 'origem', origem)
    await this.redis.multi().incr(chave).expire(chave, JANELA_EM_SEGUNDOS, 'NX').exec()
  }

  /**
   * Zera o contador do endereço depois de um login bem-sucedido.
   *
   * O contador por **origem** não é zerado: ele conta falhas, e um acerto no
   * meio de cinquenta erros é exatamente o padrão que ele existe para conter.
   */
  async limpar(endereco: string): Promise<void> {
    await this.redis.del(marca(this.pepper, 'endereco', endereco.toLowerCase()))
  }

  private async excedido(chave: string): Promise<LimiteExcedido> {
    const ttl = await this.redis.ttl(chave)
    return new LimiteExcedido(ttl > 0 ? ttl : JANELA_EM_SEGUNDOS)
  }
}
