import type { PrecoVigente } from '@mavia/contracts'
import { preco } from '@mavia/domain'
import { describe, expect, it } from 'vitest'
import {
  avaliarTroca,
  codigoDoPlano,
  historicoDoPar,
  motivoValido,
  O_QUE_A_TROCA_FAZ,
  O_QUE_A_TROCA_NAO_FAZ,
  PARES,
  precoEmVigor,
  precosEmVigor,
} from './precos'

/**
 * O que se perde se estas regras sumirem: a tela mostra um traço no lugar do
 * preço que o cliente vê na vitrine, ou deixa o operador gravar uma linha
 * achando que trocou algo. As duas terminam no mesmo lugar — alguém conferindo
 * uma cobrança contra um número que a tela inventou.
 */

const AGORA = new Date('2026-09-10T12:00:00.000Z')

function linha(campos: Partial<PrecoVigente> = {}): PrecoVigente {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    plano: 'pessoal',
    intervalo: 'mensal',
    valor_centavos: '3900',
    moeda: 'BRL',
    stripe_price_id: null,
    vigente_desde: '2026-09-01T00:00:00.000Z',
    criado_por: '22222222-2222-4222-8222-222222222222',
    motivo: 'reajuste anual combinado com o dono',
    ...campos,
  }
}

describe('o preço que vale agora', () => {
  it('**com a tabela vazia, é o do catálogo em código** — e não um traço', () => {
    // A `0043` nasce vazia de propósito, e a leitura cai no catálogo. Mostrar
    // `—` aqui faria o operador concluir que o plano não tem preço, e ele tem:
    // é o que a vitrine anuncia e o que a primeira venda vai cobrar.
    const v = precoEmVigor([], 'pessoal', 'mensal', AGORA)
    expect(v.centavos).toBe(String(preco('pessoal', 'mensal').centavos))
    expect(v.origem).toBe('catalogo')
    expect(v.linha).toBeNull()
  })

  it('com linha na tabela, é a linha — e a origem muda de nome', () => {
    const v = precoEmVigor([linha()], 'pessoal', 'mensal', AGORA)
    expect(v.centavos).toBe('3900')
    expect(v.origem).toBe('tabela')
    expect(v.linha?.motivo).toContain('reajuste')
  })

  it('**é a mais recente, e não a primeira que a rota devolveu**', () => {
    // A tabela é append-only: as linhas antigas ficam, e são elas que as
    // assinaturas contratadas apontam. Ler a errada aqui mostraria ao operador
    // o preço de março como se fosse o de hoje.
    const v = precoEmVigor(
      [
        linha({ valor_centavos: '3500', vigente_desde: '2026-03-01T00:00:00.000Z' }),
        linha({ valor_centavos: '3900', vigente_desde: '2026-09-01T00:00:00.000Z' }),
      ],
      'pessoal',
      'mensal',
      AGORA,
    )
    expect(v.centavos).toBe('3900')
  })

  it('**ignora linha com `vigente_desde` no futuro**, como `preco_vigente` faz', () => {
    // Hoje o `INSERT` usa `DEFAULT now()` e uma linha futura não nasce. Repetir
    // o recorte do banco é o que impede a tela de divergir do servidor no dia
    // em que um preço agendado existir — divergência que apareceria como a
    // vitrine anunciando um valor e a cobrança sendo outro.
    const v = precoEmVigor(
      [linha({ valor_centavos: '9900', vigente_desde: '2026-12-01T00:00:00.000Z' })],
      'pessoal',
      'mensal',
      AGORA,
    )
    expect(v.origem).toBe('catalogo')
  })

  it('não mistura os pares', () => {
    const v = precoEmVigor([linha({ intervalo: 'anual', valor_centavos: '19990' })], 'pessoal', 'mensal', AGORA)
    expect(v.origem).toBe('catalogo')
    expect(precosEmVigor([], AGORA)).toHaveLength(PARES.length)
  })

  it('o histórico do par vem do mais recente para o mais antigo', () => {
    const h = historicoDoPar(
      [
        linha({ id: 'a', vigente_desde: '2026-03-01T00:00:00.000Z' }),
        linha({ id: 'b', vigente_desde: '2026-09-01T00:00:00.000Z' }),
        linha({ id: 'c', intervalo: 'anual' }),
      ],
      'pessoal',
      'mensal',
    )
    expect(h.map((l) => l.id)).toEqual(['b', 'a'])
  })
})

describe('o código do plano, vindo de uma coluna de texto', () => {
  it('**um plano fora do catálogo não vira código**', () => {
    // `assinaturas.plano` é `TEXT`: um plano retirado do catálogo continuaria
    // escrito lá, e tratá-lo como código faria `preco()` procurar um plano que
    // não existe — e a tela mostrar um preço que não é de ninguém.
    expect(codigoDoPlano('lendario')).toBeNull()
    expect(codigoDoPlano(null)).toBeNull()
    expect(codigoDoPlano('familia')).toBe('familia')
  })

  it('**e `constructor` também não**', () => {
    // `'constructor' in {}` é verdadeiro: o `in` percorre a cadeia de
    // protótipos. Com ele, uma string vinda de coluna de texto passaria por
    // código de plano e a tela procuraria o preço de um plano inexistente.
    expect(codigoDoPlano('constructor')).toBeNull()
    expect(codigoDoPlano('toString')).toBeNull()
  })
})

describe('a troca digitada, antes de ser enviada', () => {
  it('**o valor igual ao vigente não é enviado** — o banco recusaria', () => {
    // `PRECO_INALTERADO`. Mandar para levar 400 trocaria um fato conhecido por
    // uma mensagem de restrição violada, e a linha de auditoria que ela evita
    // diria que o preço mudou quando não mudou.
    const a = avaliarTroca([linha({ valor_centavos: '3900' })], 'pessoal', 'mensal', '3900', AGORA)
    expect(a.classe).toBe('igual-ao-vigente')
    expect(a.podeEnviar).toBe(false)
  })

  it('**o valor igual ao do catálogo passa, e a tela avisa**', () => {
    // A armadilha: `admin.criar_preco` compara com `preco_vigente()`, que é
    // `NULL` quando o par não tem linha — então gravar o valor do catálogo é
    // aceito, cria uma linha e não muda preço nenhum. Bloquear seria a tela
    // recusando o que o servidor aceita; calar deixaria o operador achar que
    // mudou algo.
    const catalogo = String(preco('pessoal', 'mensal').centavos)
    const a = avaliarTroca([], 'pessoal', 'mensal', catalogo, AGORA)
    expect(a.classe).toBe('igual-a-origem')
    expect(a.podeEnviar).toBe(true)
  })

  it('um valor diferente muda o preço, e pode ir', () => {
    const a = avaliarTroca([linha({ valor_centavos: '3900' })], 'pessoal', 'mensal', '4200', AGORA)
    expect(a.classe).toBe('muda')
    expect(a.atual.centavos).toBe('3900')
    expect(a.podeEnviar).toBe(true)
  })

  it('campo vazio ou zero não é troca', () => {
    expect(avaliarTroca([], 'pessoal', 'mensal', '', AGORA).classe).toBe('sem-valor')
    expect(avaliarTroca([], 'pessoal', 'mensal', '0', AGORA).podeEnviar).toBe(false)
  })

  it('**compara centavos como inteiro, não como texto**', () => {
    // `'03900'` e `'3900'` são o mesmo preço. Comparar texto deixaria passar
    // uma troca que o banco recusa, e o operador leria a mensagem de uma
    // restrição violada em vez de "este já é o preço vigente".
    const a = avaliarTroca([linha({ valor_centavos: '03900' })], 'pessoal', 'mensal', '3900', AGORA)
    expect(a.classe).toBe('igual-ao-vigente')
  })

  it('lixo no campo não vira preço', () => {
    expect(avaliarTroca([], 'pessoal', 'mensal', 'abc', AGORA).classe).toBe('sem-valor')
  })
})

describe('o motivo, e o que a tela promete', () => {
  it('oito caracteres é o mínimo do `CHECK` e do Zod', () => {
    expect(motivoValido('pq sim')).toBe(false)
    expect(motivoValido('  reajuste  ')).toBe(true)
    expect(motivoValido('x'.repeat(281))).toBe(false)
  })

  it('**a tela diz que a troca cria e nunca altera**', () => {
    // A propriedade central da D2. Uma tela que dissesse "editar preço"
    // descreveria uma operação que nenhum papel do painel tem privilégio de
    // executar — e ensinaria o operador a esperar retroatividade.
    expect(O_QUE_A_TROCA_FAZ).toContain('cria uma linha nova')
    expect(O_QUE_A_TROCA_FAZ).toContain('mantém a anterior')
  })

  it('**e diz que ninguém que já paga é tocado**', () => {
    expect(O_QUE_A_TROCA_NAO_FAZ).toContain('Nenhum cliente que já paga')
  })
})
