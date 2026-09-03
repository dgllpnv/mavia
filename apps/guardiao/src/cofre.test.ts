import { describe, expect, it, vi } from 'vitest'
import { embrulhar, gerarDek, type Contexto } from '@mavia/guardiao'
import { Cofre, CofreSelado, gerarKek, type Registro } from './cofre.js'

/**
 * O cofre — as cinco propriedades do ADR 0018 D3.2.
 *
 * A primeira delas não tem teste, e a ausência é o ponto: **não existe método
 * que devolva a KEK**. Um `exportarKek()` que existisse "só para o teste" seria
 * a porta que o incidente usa. As outras quatro estão abaixo.
 */

const contexto = (over: Partial<Contexto> = {}): Contexto => ({
  proposito: 'conexao.credenciais',
  tenantId: 'dbdbdbdb-0000-4000-8000-000000000001',
  recursoId: 'cccccccc-0000-4000-8000-000000000001',
  kekVersao: 1,
  ...over,
})

function cofre(tetoPorHora?: number) {
  const registros: Registro[] = []
  const alarmes: string[] = []

  const c = new Cofre({
    aoRegistrar: (r) => registros.push(r),
    aoAlarmar: (m) => alarmes.push(m),
    ...(tetoPorHora === undefined ? {} : { tetoPorHora }),
  })

  return { c, registros, alarmes }
}

describe('selado até desselar', () => {
  it('**nasce selado, e nada funciona antes do desselamento**', () => {
    // Opção B do D3.3: a KEK vive em memória e entra no boot. Enquanto não
    // entrar, a sincronização bancária não funciona — e o resto do produto sim.
    const { c } = cofre()

    expect(c.selado).toBe(true)
    expect(() => c.gerarDek(contexto())).toThrow(CofreSelado)
    expect(() => c.desenvelopar(contexto(), Buffer.alloc(64))).toThrow(CofreSelado)
    expect(() => c.hmac('ip', Buffer.from('x'))).toThrow(CofreSelado)
  })

  it('depois de desselar, gera e desenvelopa', () => {
    const { c } = cofre()
    c.desselar(1, gerarKek())

    const { dek, dekCifrada, kekVersao } = c.gerarDek(contexto())

    expect(kekVersao).toBe(1)
    expect(dek).toHaveLength(32)
    expect(c.desenvelopar(contexto(), dekCifrada)).toEqual(dek)
  })

  it('selar de volta devolve o cofre ao estado inicial', () => {
    const { c } = cofre()
    c.desselar(1, gerarKek())
    c.selar()

    expect(c.selado).toBe(true)
    expect(() => c.gerarDek(contexto())).toThrow(CofreSelado)
  })

  it('recusa KEK de tamanho errado', () => {
    const { c } = cofre()
    expect(() => c.desselar(1, Buffer.alloc(16))).toThrow()
  })
})

describe('o AAD chega até aqui', () => {
  it('**um envelope de outro tenant não abre no cofre**', () => {
    const { c } = cofre()
    c.desselar(1, gerarKek())

    const { dekCifrada } = c.gerarDek(contexto())

    expect(() =>
      c.desenvelopar(contexto({ tenantId: 'dbdbdbdb-0000-4000-8000-000000000002' }), dekCifrada),
    ).toThrow()
  })

  it('um envelope selado por outra KEK não abre', () => {
    const { c } = cofre()
    c.desselar(1, gerarKek())

    const alheio = embrulhar(gerarKek(), contexto(), gerarDek())

    expect(() => c.desenvelopar(contexto(), alheio)).toThrow()
  })
})

describe('propriedade 5 — a rotação, sem a DEK transitar', () => {
  it('**reenvelopar troca o envelope e preserva a DEK**', () => {
    const { c } = cofre()
    c.desselar(1, gerarKek())
    const { dek, dekCifrada } = c.gerarDek(contexto())

    // A janela de rotação: as duas versões carregadas.
    c.desselar(2, gerarKek())

    const novo = c.reenvelopar(contexto({ kekVersao: 1 }), dekCifrada, 2)

    // A mesma DEK, noutro envelope. O ciphertext das credenciais não é tocado.
    expect(c.desenvelopar(contexto({ kekVersao: 2 }), novo)).toEqual(dek)
    expect(novo).not.toEqual(dekCifrada)
  })

  it('depois da rotação, a versão de escrita é a mais nova', () => {
    const { c } = cofre()
    c.desselar(1, gerarKek())
    c.desselar(2, gerarKek())

    expect(c.kekVersaoAtual).toBe(2)
    expect(c.gerarDek(contexto()).kekVersao).toBe(2)
  })

  it('**a versão antiga não carregada é recusada com o motivo certo**', () => {
    // A mensagem diz que é janela de rotação, e não "erro de criptografia": o
    // operador precisa saber que falta desselar, não investigar corrupção.
    const { c } = cofre()
    c.desselar(2, gerarKek())

    expect(() => c.desenvelopar(contexto({ kekVersao: 1 }), Buffer.alloc(64))).toThrow(
      /rotação/,
    )
  })
})

describe('propriedade 3 — o teto sela, e não só recusa', () => {
  it('**estourar o teto sela o cofre e alarma**', () => {
    // Um pedido de desembrulho em massa já significa que alguém está dentro.
    // Continuar atendendo os seguintes seria entregar o resto enquanto o alarme
    // toca.
    const { c, alarmes } = cofre(3)
    c.desselar(1, gerarKek())
    const { dekCifrada } = c.gerarDek(contexto())

    for (let i = 0; i < 3; i++) c.desenvelopar(contexto(), dekCifrada)

    expect(() => c.desenvelopar(contexto(), dekCifrada)).toThrow(CofreSelado)
    expect(c.selado).toBe(true)
    expect(alarmes).toHaveLength(1)
    expect(alarmes[0]).toContain('comprometeu a API')
  })

  it('**depois de selado por abuso, desselar de novo não reabre**', () => {
    // Quem tem a KEK pode desselar; o cofre continua recusando desembrulho até
    // o processo ser reiniciado, para que a investigação aconteça.
    const { c } = cofre(1)
    c.desselar(1, gerarKek())
    const { dekCifrada } = c.gerarDek(contexto())

    c.desenvelopar(contexto(), dekCifrada)
    expect(() => c.desenvelopar(contexto(), dekCifrada)).toThrow(CofreSelado)

    c.desselar(1, gerarKek())
    expect(() => c.desenvelopar(contexto(), dekCifrada)).toThrow(CofreSelado)
  })

  it('**embrulhar não tem teto**', () => {
    // Quem escreve credencial já tem a credencial: embrulhar em massa não é
    // sinal de nada. O teto vale só onde o padrão significa alguma coisa.
    const { c, alarmes } = cofre(2)
    c.desselar(1, gerarKek())

    for (let i = 0; i < 20; i++) c.gerarDek(contexto())

    expect(c.selado).toBe(false)
    expect(alarmes).toEqual([])
  })
})

describe('propriedade 4 — o registro, fora do Postgres', () => {
  it('registra quem foi tocado', () => {
    const { c, registros } = cofre()
    c.desselar(1, gerarKek())
    const { dekCifrada } = c.gerarDek(contexto())
    c.desenvelopar(contexto(), dekCifrada)

    const desembrulho = registros.find((r) => r.operacao === 'desenvelopar')
    expect(desembrulho).toMatchObject({
      proposito: 'conexao.credenciais',
      tenantId: 'dbdbdbdb-0000-4000-8000-000000000001',
      kekVersao: 1,
      desfecho: 'ok',
    })
  })

  it('**o registro nunca contém material**', () => {
    // Nem DEK, nem ciphertext, nem chave. Um log de auditoria que carrega o
    // segredo é uma segunda cópia do segredo, num lugar com menos proteção.
    const { c, registros } = cofre()
    c.desselar(1, gerarKek())
    const { dek, dekCifrada } = c.gerarDek(contexto())
    c.desenvelopar(contexto(), dekCifrada)

    const texto = JSON.stringify(registros)
    expect(texto).not.toContain(dek.toString('hex'))
    expect(texto).not.toContain(dekCifrada.toString('hex'))
    expect(texto).not.toContain(dek.toString('base64'))
  })

  it('a recusa também é registrada', () => {
    const { c, registros } = cofre()
    c.desselar(1, gerarKek())

    expect(() => c.desenvelopar(contexto(), Buffer.alloc(64))).toThrow()
    expect(registros.some((r) => r.desfecho === 'recusado')).toBe(true)
  })
})

describe('o pepper do ip_hash', () => {
  it('é estável para a mesma KEK e muda com ela', () => {
    const { c } = cofre()
    const kek = gerarKek()

    c.desselar(1, kek)
    const a = c.hmac('ip', Buffer.from('192.0.2.1'))
    const b = c.hmac('ip', Buffer.from('192.0.2.1'))
    expect(a).toEqual(b)

    c.selar()
    c.desselar(1, gerarKek())
    expect(c.hmac('ip', Buffer.from('192.0.2.1'))).not.toEqual(a)
  })

  it('**o propósito separa os espaços de hash**', () => {
    const { c } = cofre()
    c.desselar(1, gerarKek())

    expect(c.hmac('ip', Buffer.from('x'))).not.toEqual(c.hmac('user-agent', Buffer.from('x')))
  })
})

describe('a superfície', () => {
  it('**não existe nada que devolva a KEK**', () => {
    // A propriedade 1 do ADR, verificada como se verifica uma ausência: nenhum
    // método público tem nome que a prometa, e o campo é privado.
    const { c } = cofre()
    c.desselar(1, gerarKek())

    // O `private` do TypeScript é apagado na compilação: os métodos ficariam no
    // protótipo, e `(cofre as any).kekPara(1)` devolveria a KEK. Por isso os
    // internos usam `#`, que o motor de fato esconde.
    const metodos = Object.getOwnPropertyNames(Object.getPrototypeOf(c))
    expect(metodos.filter((m) => /kek/i.test(m) && m !== 'kekVersaoAtual')).toEqual([])

    // E o acesso por qualquer nome não alcança nada.
    const porFora = c as unknown as Record<string, unknown>
    expect(porFora['keks']).toBeUndefined()
    expect(porFora['kekPara']).toBeUndefined()

    // E a serialização do objeto não a vaza.
    expect(JSON.stringify(c)).not.toContain('keks')
  })

  it('desselar não devolve nada', () => {
    const { c } = cofre()
    const espiao = vi.fn()
    espiao(c.desselar(1, gerarKek()))

    expect(espiao).toHaveBeenCalledWith(undefined)
  })
})
