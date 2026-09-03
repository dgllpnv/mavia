import { describe, expect, it } from 'vitest'
import {
  AdapterInvalido,
  adaptersRegistrados,
  provider,
  registrarAdapter,
  type AlvoRevogacao,
  type BankSyncProvider,
  type ResultadoRevogacao,
} from '../src/conexoes/provider.js'

/**
 * A suíte de contrato do `BankSyncProvider` — ADR 0019 §D8.
 *
 * **Ela roda contra todo adapter registrado, e é assim que continua valendo.**
 * O agregador não existe hoje: a porta de receita do ADR 0003 não foi atingida
 * e nenhum adapter de Pluggy ou Belvo está neste repositório. O valor desta
 * suíte é justamente esse — no dia em que um for escrito, ele entra no registro
 * e é reprovado aqui antes de tocar em credencial de alguém.
 *
 * Os casos que exigem um provider remoto de verdade (C4 a C6 do ADR: 404 vira
 * `ja_revogado`, taxonomia de falha, prazo duro) são exercitados contra um
 * adapter falso construído aqui. Um adapter real precisará passar pelos mesmos.
 */

const alvo = (over: Partial<AlvoRevogacao> = {}): AlvoRevogacao => ({
  tenantId: 'dbdbdbdb-0000-4000-8000-000000000001',
  conexaoId: 'cccccccc-0000-4000-8000-000000000001',
  provider: 'teste',
  externalId: 'item_123',
  motivo: 'titular',
  chaveIdempotencia: 'revogacao:cccccccc-0000-4000-8000-000000000001',
  tentativa: 1,
  ...over,
})

const opcoes = () => ({ sinal: AbortSignal.timeout(5_000), prazoMs: 3_000 })

describe('C1 · todo adapter registrado revoga, e nenhum lança', () => {
  it.each(adaptersRegistrados().map((a) => [a.nome, a] as const))(
    '%s',
    async (_nome, adapter: BankSyncProvider) => {
      // O `NotImplementedError` que o §D5 recusa. Um adapter de arquivo que
      // lançasse aqui derrubaria a Fase 2 e deixaria o titular sem resposta
      // depois de a credencial já ter sido destruída.
      const r = await adapter.revogar(alvo({ provider: adapter.nome }), opcoes())

      expect(r.estado).toBeTruthy()
    },
  )

  it('o registro não está vazio', () => {
    // Sem isto, um `registrarAdapter` quebrado deixaria `it.each` sem casos e a
    // suíte inteira passaria verde sem exercitar adapter nenhum.
    expect(adaptersRegistrados().length).toBeGreaterThanOrEqual(3)
  })

  it('todos declaram a ficha completa', () => {
    for (const a of adaptersRegistrados()) {
      expect(a.modeloDeCredencial).toBeTruthy()
      expect(a.revogacaoRemota).toBeTruthy()
    }
  })
})

describe('C2 · adapter `nao-aplicavel` não toca em rede', () => {
  it.each(
    adaptersRegistrados()
      .filter((a) => a.revogacaoRemota === 'nao-aplicavel')
      .map((a) => [a.nome, a] as const),
  )('%s devolve nao_aplicavel sem abrir socket', async (_nome, adapter: BankSyncProvider) => {
    // O fake que reprova se for tocado: qualquer `fetch` durante a revogação
    // falha o teste. É o adapter de arquivo "revogando" alguma coisa por
    // engano — que produziria um job retentando contra ninguém.
    const original = globalThis.fetch
    globalThis.fetch = (() => {
      throw new Error('o adapter abriu rede numa revogação que não tem lado de lá')
    })

    try {
      const r = await adapter.revogar(alvo({ provider: adapter.nome }), opcoes())

      expect(r.estado).toBe('nao_aplicavel')
      expect(r.estado === 'nao_aplicavel' && r.motivo).toBeTruthy()
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('C3 · idempotência', () => {
  it('a segunda revogação nunca é falha', async () => {
    // A segunda revogação virando erro na tela do titular é o modo de falha
    // mais provável desta rota: o botão recebe dois cliques.
    for (const adapter of adaptersRegistrados()) {
      const a = alvo({ provider: adapter.nome })
      const primeira = await adapter.revogar(a, opcoes())
      const segunda = await adapter.revogar({ ...a, tentativa: 2 }, opcoes())

      expect(primeira.estado).toBe(segunda.estado)
      expect(['revogado', 'ja_revogado', 'nao_aplicavel']).toContain(segunda.estado)
    }
  })
})

describe('C7 · nenhum segredo vaza pelo resultado', () => {
  it('o resultado não carrega credencial nem corpo do provider', async () => {
    const segredo = Buffer.from('senha-do-banco-em-claro')

    for (const adapter of adaptersRegistrados()) {
      const r = await adapter.revogar(alvo({ provider: adapter.nome, segredo }), opcoes())

      expect(JSON.stringify(r)).not.toContain('senha-do-banco')
    }
  })
})

describe('C8 · o adapter não escreve no banco', () => {
  it('nenhum adapter recebe pool, cliente ou tenancy', () => {
    // A tentação é o adapter "marcar a conexão" ele mesmo, e ela dissolve o
    // seam: persistir estado é do orquestrador, que é um só. A verificação é
    // sobre a superfície — o adapter não tem por onde.
    for (const a of adaptersRegistrados()) {
      const campos = Object.keys(a)
      expect(campos.filter((c) => /pool|client|db|drizzle|tenant/i.test(c))).toEqual([])
    }
  })
})

describe('C9 · registrarAdapter recusa adapter sem ficha', () => {
  const base = {
    nome: 'inventado',
    modeloDeCredencial: 'sem-credencial',
    revogacaoRemota: 'nao-aplicavel',
    buscar: () => ({ registros: [], problemas: [] }),
    revogar: async () => ({ estado: 'nao_aplicavel', motivo: 'x' }) as ResultadoRevegacaoLike,
  }

  it('sem modeloDeCredencial', () => {
    // É como o §D0 do ADR 0018 é esquecido: um adapter novo nasce sem dizer se
    // guarda segredo, e a decisão de cifrar passa a depender de alguém lembrar.
    const { modeloDeCredencial: _, ...sem } = base
    expect(() => registrarAdapter(sem as unknown as BankSyncProvider)).toThrow(AdapterInvalido)
  })

  it('sem revogacaoRemota', () => {
    const { revogacaoRemota: _, ...sem } = base
    expect(() => registrarAdapter(sem as unknown as BankSyncProvider)).toThrow(AdapterInvalido)
  })

  it('sem revogar', () => {
    const { revogar: _, ...sem } = base
    expect(() => registrarAdapter(sem as unknown as BankSyncProvider)).toThrow(AdapterInvalido)
  })

  it('**com ficha incoerente**', () => {
    // Exige segredo do titular e declara não guardar nenhum. A combinação não
    // descreve nada real, e produziria uma Fase 2 pedindo ao guardião uma
    // credencial que a Fase 1 não guardou.
    expect(() =>
      registrarAdapter({
        ...base,
        revogacaoRemota: 'exige-segredo-do-titular',
      } as unknown as BankSyncProvider),
    ).toThrow(AdapterInvalido)
  })

  it('e o adapter recusado não fica no registro', () => {
    expect(provider('inventado')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// C4, C5 e C6 contra um adapter remoto falso
// ---------------------------------------------------------------------------
// Nenhum adapter real existe hoje. Estes três casos definem o que um vai
// precisar cumprir, e a definição em forma de teste é mais dura que em prosa.

type ResultadoRevegacaoLike = ResultadoRevogacao

/** Um adapter que fala com um "agregador" cuja resposta o teste escolhe. */
function adapterRemoto(responder: () => Promise<number> | number): BankSyncProvider {
  return {
    nome: 'agregador-falso',
    modeloDeCredencial: 'sem-credencial',
    revogacaoRemota: 'sem-segredo',
    buscar: () => ({ registros: [], problemas: [] }),
    async revogar(_a, o): Promise<ResultadoRevogacao> {
      try {
        const status = await Promise.race([
          Promise.resolve(responder()),
          new Promise<never>((_, rejeitar) =>
            setTimeout(() => rejeitar(new Error('timeout')), o.prazoMs),
          ),
        ])
        return classificar(status)
      } catch (erro) {
        return { estado: 'falha_temporaria', codigo: (erro as Error).message === 'timeout' ? 'timeout' : 'rede' }
      }
    },
  }
}

/** A taxonomia do §D5, que é a parte que os adapters erram. */
function classificar(status: number): ResultadoRevogacao {
  if (status === 200 || status === 204) return { estado: 'revogado', em: new Date() }
  if (status === 404 || status === 410) return { estado: 'ja_revogado' }
  if (status === 401 || status === 403) {
    return { estado: 'falha_permanente', codigo: 'nao_autorizado', detalhe: 'a chave da Mavia foi recusada' }
  }
  if (status === 429) return { estado: 'falha_temporaria', codigo: 'limite' }
  if (status >= 500) return { estado: 'falha_temporaria', codigo: 'indisponivel' }
  return { estado: 'falha_permanente', codigo: 'contrato_encerrado', detalhe: `resposta ${status}` }
}

describe('C4 · consentimento já expirado é sucesso, não pendência', () => {
  it.each([404, 410])('%i → ja_revogado', async (status) => {
    // Ficar `pendente` para sempre por algo que já está resolvido é o modo de
    // falha silencioso: o titular vê "pendente" e conclui que o banco ainda
    // tem acesso.
    const r = await adapterRemoto(() => status).revogar(alvo(), opcoes())

    expect(r.estado).toBe('ja_revogado')
  })
})

describe('C5 · a taxonomia de falha', () => {
  it.each([
    [429, 'falha_temporaria'],
    [500, 'falha_temporaria'],
    [503, 'falha_temporaria'],
    [401, 'falha_permanente'],
    [403, 'falha_permanente'],
  ] as const)('%i → %s', async (status, esperado) => {
    // O adapter que classifica tudo como permanente perde o retry; o que
    // classifica tudo como temporário retenta 72 h contra um 401 que nunca vai
    // mudar. As duas metades importam.
    const r = await adapterRemoto(() => status).revogar(alvo(), opcoes())

    expect(r.estado).toBe(esperado)
  })

  it('**a falha permanente não carrega o corpo do provider**', async () => {
    const r = await adapterRemoto(() => 401).revogar(alvo(), opcoes())

    expect(r.estado === 'falha_permanente' && r.detalhe).toBe('a chave da Mavia foi recusada')
  })
})

describe('C6 · o prazo duro', () => {
  it('**o agregador travado não trava a resposta ao titular**', async () => {
    // A Fase 2 acontece depois do commit e antes do 200. Sem prazo, o `DELETE`
    // fica pendurado no tempo do terceiro — e a credencial já foi destruída,
    // então não há nada a esperar.
    const pendurado = adapterRemoto(() => new Promise<number>(() => {}))
    const comecou = Date.now()

    const r = await pendurado.revogar(alvo(), { sinal: AbortSignal.timeout(10_000), prazoMs: 300 })

    expect(r.estado).toBe('falha_temporaria')
    expect(r.estado === 'falha_temporaria' && r.codigo).toBe('timeout')
    expect(Date.now() - comecou).toBeLessThan(2_000)
  })
})

// ---------------------------------------------------------------------------
// O alarme
// ---------------------------------------------------------------------------
describe('o que falta antes do primeiro agregador', () => {
  it('**nenhum adapter com revogação remota está registrado — e há razão**', () => {
    // Este teste é um alarme, não uma asserção sobre o produto.
    //
    // Um adapter cuja revogação pode ficar `pendente` exige três coisas que
    // ainda não existem (pendência P-16):
    //
    //  1. o `outbox`, para que a intenção de revogar lá fora não se perca se o
    //     processo cair entre o commit e a chamada;
    //  2. o job `conexao.revogar-no-provedor`, que retenta — sem ele,
    //     `pendente` é para sempre, e o titular lê "pendente" e conclui que o
    //     banco ainda tem acesso;
    //  3. a Fase 3 assíncrona, que hoje roda dentro da transação porque é zero
    //     linhas: nenhum adapter escreve `payload`.
    //
    // No dia em que o primeiro adapter de agregador for registrado, este teste
    // falha — e falhar aqui é infinitamente mais barato que descobrir a
    // ausência com credencial de gente de verdade no banco.
    const comRemota = adaptersRegistrados().filter((a) => a.revogacaoRemota !== 'nao-aplicavel')

    expect(comRemota.map((a) => a.nome)).toEqual([])
  })
})
