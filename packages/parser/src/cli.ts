import { lerCsv, lerOfx } from './index.js'
import type { Resultado } from './tipos.js'

/**
 * O processo descartável — `sistema.md` §2.6 e ADR 0016.
 *
 * Um arquivo por execução. Entra um pedido JSON pela entrada padrão, sai um
 * resultado JSON pela saída padrão, e o processo morre. **Nada persiste entre
 * arquivos**, o que significa que um payload hostil não tem onde se instalar
 * para esperar o próximo.
 *
 * ## Por que isto é um processo, e não uma função
 *
 * O processo que desembrulha DEKs e usa credencial bancária e o processo que lê
 * arquivo hostil **não podem ser o mesmo**. OFX, CSV e PDF são as entradas mais
 * hostis do produto; um XXE ou um RCE de biblioteca aqui não pode alcançar a
 * KEK nem o banco. É o vetor A-32/33/34, que compromete todos os tenants de uma
 * vez.
 *
 * O código deste pacote foi escrito para caber aqui desde o início: **zero
 * dependências**, nenhum I/O, nenhuma leitura de ambiente, nenhum conhecimento
 * do domínio. A ausência de `dependencies` no `package.json` não é acidente —
 * é o que obriga qualquer `import` novo a ser defendido.
 *
 * ## O que este arquivo nunca faz
 *
 * Não lê variável de ambiente, não abre socket, não toca no disco e **não
 * lança**. Uma exceção que escapasse derrubaria o processo sem resposta, e o
 * pai não saberia distinguir "arquivo ilegível" de "o parser morreu" — que são
 * incidentes diferentes.
 */

/** Acima disto não é extrato, é ataque. O pai também impõe o seu. */
const ENTRADA_MAXIMA = 12 * 1024 * 1024

interface Pedido {
  readonly formato?: unknown
  readonly conteudo?: unknown
  readonly mapa?: unknown
}

async function lerEntrada(): Promise<string> {
  const pedacos: Buffer[] = []
  let total = 0

  for await (const pedaco of process.stdin) {
    const bytes = pedaco as Buffer
    total += bytes.length
    if (total > ENTRADA_MAXIMA) throw new Error('entrada acima do teto')
    pedacos.push(bytes)
  }

  return Buffer.concat(pedacos).toString('utf8')
}

/**
 * O resultado, na forma do fio.
 *
 * `centavos` é `bigint` no domínio e vira **string decimal** aqui: JSON não tem
 * inteiro de precisão arbitrária, e `JSON.stringify` de um `bigint` lança. Se
 * fosse `number`, R$ 92.233.720.368.547,76 viraria outro número em silêncio —
 * e a regra 1 do `CLAUDE.md` existe exatamente para que essa conversão nunca
 * aconteça perto de dinheiro.
 */
function noFio(r: Resultado) {
  return {
    registros: r.registros.map((reg) => ({
      externalId: reg.externalId,
      // Os três campos, e não uma string: `DataCivil` é um dia do calendário,
      // não um instante, e serializá-la como texto convidaria alguém do outro
      // lado a passá-la por `new Date()` — que a interpretaria em UTC e
      // deslocaria o dia para quem está em São Paulo.
      data: { ano: reg.data.ano, mes: reg.data.mes, dia: reg.data.dia },
      centavos: reg.centavos.toString(),
      moeda: reg.moeda,
      descricao: reg.descricao,
      tipo: reg.tipo,
      bruto: reg.bruto,
    })),
    problemas: r.problemas.map((p) => ({ linha: p.linha, motivo: p.motivo, bruto: p.bruto })),
  }
}

async function principal(): Promise<void> {
  try {
    const bruto = await lerEntrada()
    const pedido = JSON.parse(bruto) as Pedido

    if (typeof pedido.conteudo !== 'string') throw new Error('pedido sem conteúdo')

    const resultado =
      pedido.formato === 'ofx'
        ? lerOfx(pedido.conteudo)
        : lerCsv(
            pedido.conteudo,
            (pedido.mapa ?? undefined) as Parameters<typeof lerCsv>[1],
          )

    process.stdout.write(JSON.stringify({ ok: true, ...noFio(resultado) }))
  } catch (erro) {
    // **A mensagem é nossa, nunca a do arquivo.** Ecoar o conteúdo aqui o
    // levaria para o log do pai, e o que está sendo processado é um extrato
    // bancário: agência, conta e chave Pix de terceiros.
    process.stdout.write(
      JSON.stringify({
        ok: false,
        erro: erro instanceof SyntaxError ? 'pedido ilegível' : 'não consegui interpretar o arquivo',
      }),
    )
    process.exitCode = 1
  }
}

void principal()
