import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  aadDe,
  desembrulhar,
  embrulhar,
  EnvelopeInvalido,
  gerarDek,
  kekVersaoDe,
  SEM_TENANT,
  VERSAO_DO_FORMATO,
  zerar,
  type Contexto,
} from './envelope.js'

/**
 * O envelope — ADR 0018.
 *
 * O ativo aqui é o único do sistema cujo comprometimento **não é proporcional
 * ao acesso obtido**: todo o resto vaza um tenant por vez. Por isso os testes
 * abaixo não são sobre "cifra e decifra" — são sobre o que acontece quando
 * alguém com escrita no banco tenta usar o material fora do lugar dele.
 */

const KEK = Buffer.alloc(32, 7)
const OUTRA_KEK = Buffer.alloc(32, 9)

const contexto = (over: Partial<Contexto> = {}): Contexto => ({
  proposito: 'conexao.credenciais',
  tenantId: 'dbdbdbdb-0000-4000-8000-000000000001',
  recursoId: 'cccccccc-0000-4000-8000-000000000001',
  kekVersao: 1,
  ...over,
})

describe('ida e volta', () => {
  it('o que entra sai', () => {
    const claro = Buffer.from('a senha do banco', 'utf8')
    const blob = embrulhar(KEK, contexto(), claro)

    expect(desembrulhar(KEK, contexto(), blob)).toEqual(claro)
  })

  it('o blob não contém o texto claro', () => {
    const blob = embrulhar(KEK, contexto(), Buffer.from('SENHA-SECRETA', 'utf8'))

    expect(blob.toString('utf8')).not.toContain('SENHA-SECRETA')
    expect(blob.toString('hex')).not.toContain(Buffer.from('SENHA-SECRETA').toString('hex'))
  })

  it('**dois embrulhos do mesmo texto são diferentes**', () => {
    // O nonce é aleatório por operação. Dois blobs idênticos revelariam que os
    // textos são iguais — e num campo de credencial isso já é informação.
    const claro = Buffer.from('mesma coisa', 'utf8')

    expect(embrulhar(KEK, contexto(), claro)).not.toEqual(embrulhar(KEK, contexto(), claro))
  })

  it('o cabeçalho é autodescritivo', () => {
    const blob = embrulhar(KEK, contexto({ kekVersao: 42 }), Buffer.from('x'))

    expect(blob.readUInt8(0)).toBe(VERSAO_DO_FORMATO)
    expect(kekVersaoDe(blob)).toBe(42)
  })
})

describe('o transplante de blob — o que o AAD existe para impedir', () => {
  const claro = Buffer.from('credencial da Ana', 'utf8')

  it('**um blob de outro tenant não abre**', () => {
    // O cenário: quem tem escrita no banco copia `credenciais_cifradas` e
    // `dek_cifrada` de uma conexão para outra, de um tenant para outro. Sem
    // AAD, o desembrulho funcionaria normalmente.
    const blob = embrulhar(KEK, contexto(), claro)

    expect(() =>
      desembrulhar(KEK, contexto({ tenantId: 'dbdbdbdb-0000-4000-8000-000000000002' }), blob),
    ).toThrow(EnvelopeInvalido)
  })

  it('**um blob de outro recurso do mesmo tenant não abre**', () => {
    const blob = embrulhar(KEK, contexto(), claro)

    expect(() =>
      desembrulhar(KEK, contexto({ recursoId: 'cccccccc-0000-4000-8000-000000000002' }), blob),
    ).toThrow(EnvelopeInvalido)
  })

  it('**um blob de outro propósito não abre**', () => {
    // Um segredo de MFA apresentado como credencial de conexão, ou o inverso.
    const blob = embrulhar(KEK, contexto(), claro)

    expect(() =>
      desembrulhar(KEK, contexto({ proposito: 'usuario.mfa', tenantId: SEM_TENANT }), blob),
    ).toThrow(EnvelopeInvalido)
  })

  it('a KEK errada não abre', () => {
    const blob = embrulhar(KEK, contexto(), claro)

    expect(() => desembrulhar(OUTRA_KEK, contexto(), blob)).toThrow(EnvelopeInvalido)
  })

  it('**a mensagem de erro não distingue os casos**', () => {
    // Distinguir "chave errada" de "AAD errado" seria um oráculo: um atacante
    // com escrita no banco descobriria, por tentativa, a que tenant um blob
    // pertence.
    const blob = embrulhar(KEK, contexto(), claro)

    const porChave = capturar(() => desembrulhar(OUTRA_KEK, contexto(), blob))
    const porAad = capturar(() =>
      desembrulhar(KEK, contexto({ tenantId: 'dbdbdbdb-0000-4000-8000-000000000002' }), blob),
    )

    expect(porChave).toBe(porAad)
  })
})

describe('adulteração', () => {
  it('mexer num byte do ciphertext derruba a autenticação', () => {
    const blob = embrulhar(KEK, contexto(), Buffer.from('doze reais', 'utf8'))
    const adulterado = Buffer.from(blob)
    adulterado[20] = adulterado[20]! ^ 0xff

    expect(() => desembrulhar(KEK, contexto(), adulterado)).toThrow(EnvelopeInvalido)
  })

  it('mexer na tag derruba', () => {
    const blob = embrulhar(KEK, contexto(), Buffer.from('x', 'utf8'))
    const adulterado = Buffer.from(blob)
    adulterado[adulterado.length - 1] = adulterado[adulterado.length - 1]! ^ 0x01

    expect(() => desembrulhar(KEK, contexto(), adulterado)).toThrow(EnvelopeInvalido)
  })

  it('**mexer na versão de KEK do cabeçalho é detectado**', () => {
    // O cabeçalho entra no AAD, então adulterá-lo produz falha de autenticação
    // — e não decifragem silenciosa com a versão errada.
    const blob = embrulhar(KEK, contexto({ kekVersao: 1 }), Buffer.from('x'))
    const adulterado = Buffer.from(blob)
    adulterado.writeUInt16BE(2, 1)

    expect(() => desembrulhar(KEK, contexto({ kekVersao: 2 }), adulterado)).toThrow(
      EnvelopeInvalido,
    )
  })

  it('blob truncado é recusado sem estourar', () => {
    const blob = embrulhar(KEK, contexto(), Buffer.from('x'))

    for (const tamanho of [0, 1, 5, 20]) {
      expect(() => desembrulhar(KEK, contexto(), blob.subarray(0, tamanho))).toThrow(
        EnvelopeInvalido,
      )
    }
  })
})

describe('recusas de entrada', () => {
  it('chave de tamanho errado é recusada', () => {
    expect(() => embrulhar(Buffer.alloc(16), contexto(), Buffer.from('x'))).toThrow(
      EnvelopeInvalido,
    )
  })

  it('versão de KEK fora da faixa é recusada', () => {
    expect(() => embrulhar(KEK, contexto({ kekVersao: 0 }), Buffer.from('x'))).toThrow(
      EnvelopeInvalido,
    )
    expect(() => embrulhar(KEK, contexto({ kekVersao: 70_000 }), Buffer.from('x'))).toThrow(
      EnvelopeInvalido,
    )
  })
})

describe('o AAD', () => {
  it('**os separadores impedem a ambiguidade de concatenação**', () => {
    // Sem os `0x00`, `("ab","c")` e `("a","bc")` produziriam o mesmo AAD, e dois
    // recursos distintos passariam a aceitar o blob um do outro.
    const a = aadDe(contexto({ tenantId: 'ab', recursoId: 'c' }))
    const b = aadDe(contexto({ tenantId: 'a', recursoId: 'bc' }))

    expect(a).not.toEqual(b)
  })
})

describe('higiene', () => {
  it('zerar apaga a chave', () => {
    const dek = gerarDek()
    expect(dek.some((b) => b !== 0)).toBe(true)

    zerar(dek)
    expect(dek.every((b) => b === 0)).toBe(true)
  })

  it('cada DEK é diferente', () => {
    const chaves = new Set(Array.from({ length: 50 }, () => gerarDek().toString('hex')))
    expect(chaves.size).toBe(50)
  })
})

describe('propriedades', () => {
  it('**a ida e a volta fecham para qualquer conteúdo**', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
        const claro = Buffer.from(bytes)
        const blob = embrulhar(KEK, contexto(), claro)
        expect(desembrulhar(KEK, contexto(), blob)).toEqual(claro)
      }),
    )
  })

  it('**nenhum contexto diferente abre um blob**', () => {
    // A propriedade que sustenta o AAD inteiro, sobre o espaço de contextos.
    const uuid = fc.uuid()

    fc.assert(
      fc.property(uuid, uuid, uuid, uuid, (t1, r1, t2, r2) => {
        fc.pre(t1 !== t2 || r1 !== r2)

        const blob = embrulhar(KEK, contexto({ tenantId: t1, recursoId: r1 }), Buffer.from('s'))

        expect(() =>
          desembrulhar(KEK, contexto({ tenantId: t2, recursoId: r2 }), blob),
        ).toThrow(EnvelopeInvalido)
      }),
    )
  })

  it('nenhuma entrada faz o desembrulho estourar fora do erro tipado', () => {
    // O blob vem do banco, e o banco pode ter sido escrito por outra pessoa.
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        try {
          desembrulhar(KEK, contexto(), Buffer.from(bytes))
        } catch (erro) {
          expect(erro).toBeInstanceOf(EnvelopeInvalido)
        }
      }),
    )
  })
})

function capturar(f: () => unknown): string {
  try {
    f()
    return 'sem erro'
  } catch (erro) {
    return (erro as Error).message
  }
}
