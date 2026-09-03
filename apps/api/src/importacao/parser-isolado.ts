import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { z } from 'zod'
import type { MapaDeColunas, Resultado } from '@mavia/parser'

/**
 * O parser, num processo à parte — ADR 0016 e `sistema.md` §2.6.
 *
 * **Nenhum processo que manipula DEK executa parsing de arquivo de usuário.**
 * OFX, CSV e PDF são as entradas mais hostis do produto, e o processo da API
 * tem a `DATABASE_URL` e falava com o guardião. Um XXE ou um RCE de biblioteca
 * ali alcançaria todos os tenants de uma vez — é o vetor A-32/33/34.
 *
 * ## O que este arquivo entrega, e o que continua sendo do container
 *
 * | Controle | Onde |
 * |---|---|
 * | sem segredo no ambiente do parsing | **aqui** — `env: {}`, e não `process.env` |
 * | contenção de queda | **aqui** — o filho morre, o pai responde 422 |
 * | prazo duro | **aqui** — `SIGKILL` aos 10 s |
 * | teto de saída | **aqui** — o filho não enche a memória do pai |
 * | saída não confiável | **aqui** — Zod sobre o que o filho devolve |
 * | sem rede, fs somente-leitura, cgroup, `seccomp` | **container** (§2.6) |
 *
 * A última linha não é uma lacuna deste arquivo: o `sistema.md` já diz que o
 * isolamento é "propriedade do container, não do código", e testá-lo em Vitest
 * testaria o mock. O que **é** código está aqui, e é verificável.
 *
 * ## O pai não confia no filho
 *
 * A saída é validada com Zod antes de virar `Resultado`. Parece paranoia — é o
 * nosso próprio código do outro lado. Mas o ponto do isolamento é precisamente
 * supor que aquele processo pode ter sido subvertido pelo arquivo que leu; um
 * pai que faz `JSON.parse` e confia desfaz metade do que o container comprou.
 */

/** Acima disto o filho é morto. Extrato não demora dez segundos. */
const PRAZO_MS = 10_000

/** Teto da saída do filho. Um extrato de 10 MB não produz 64 MB de JSON. */
const SAIDA_MAXIMA = 64 * 1024 * 1024

export class ParserFalhou extends Error {
  constructor(motivo: string) {
    super(motivo)
    this.name = 'ParserFalhou'
  }
}

/**
 * O contrato do fio.
 *
 * `centavos` é **string decimal**, e a coerção para `bigint` acontece aqui.
 * JSON não tem inteiro de precisão arbitrária: aceitar `number` faria o valor
 * atravessar ponto flutuante na fronteira mais hostil do sistema, que é
 * exatamente o que a regra 1 do `CLAUDE.md` proíbe. `z.coerce.bigint()` não
 * serve — ela aceitaria `1.5` e truncaria.
 */
const zCentavosNoFio = z
  .string()
  .regex(/^-?\d{1,19}$/, 'centavos vem como inteiro decimal em string')
  .transform((s) => BigInt(s))

const zSaida = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    registros: z.array(
      z.object({
        externalId: z.string().min(1).max(256),
        // `DataCivil`, e não string: um dia do calendário não é instante, e
        // uma string aqui acabaria em `new Date()` do outro lado — que a lê em
        // UTC e desloca o dia para quem está em São Paulo.
        data: z.object({
          ano: z.number().int().min(1900).max(2200),
          mes: z.number().int().min(1).max(12),
          dia: z.number().int().min(1).max(31),
        }),
        centavos: zCentavosNoFio,
        moeda: z.string().length(3),
        descricao: z.string().max(2_000),
        tipo: z.string().max(64).nullable(),
        bruto: z.string().max(10_000),
      }),
    ),
    problemas: z.array(
      z.object({
        linha: z.number().int().nonnegative(),
        motivo: z.string().max(500),
        bruto: z.string().max(10_000),
      }),
    ),
  }),
  z.object({ ok: z.literal(false), erro: z.string().max(500) }),
])

/** Onde mora o filho. Em produção é o `dist` do pacote; em dev, o fonte. */
const CLI = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', 'packages', 'parser', 'src', 'cli.ts')

/**
 * O ambiente do filho. Vazio, e exportado para que o teste use **este** valor.
 *
 * É a linha que tira a `DATABASE_URL`, o segredo da Stripe e o caminho do
 * socket do guardião do alcance do processo que lê o arquivo. Herdar
 * `process.env` "porque é mais simples" devolveria o vetor A-32/33/34 inteiro.
 *
 * Exportado porque um teste que afirmasse isso lendo o próprio fonte estaria
 * verificando texto, e não comportamento — e o comportamento de `env: {}` é
 * coisa do sistema operacional, não nossa.
 */
export const AMBIENTE_DO_FILHO: NodeJS.ProcessEnv = {}

export interface PedidoDeParsing {
  readonly formato: 'ofx' | 'csv'
  readonly conteudo: string
  readonly mapa?: MapaDeColunas | undefined
}

export async function parsearIsolado(pedido: PedidoDeParsing): Promise<Resultado> {
  const bruta = await executar(JSON.stringify(pedido))

  const analise = zSaida.safeParse(bruta)
  if (!analise.success) {
    // O filho respondeu algo que não é o contrato. Não é "arquivo ruim": é o
    // parser comprometido ou quebrado, e os dois merecem a mesma recusa.
    throw new ParserFalhou('o parser devolveu uma resposta fora do contrato')
  }
  if (!analise.data.ok) throw new ParserFalhou(analise.data.erro)

  return { registros: analise.data.registros, problemas: analise.data.problemas }
}

function executar(entrada: string): Promise<unknown> {
  return new Promise((resolver, rejeitar) => {
    const filho = spawn(
      process.execPath,
      [...(CLI.endsWith('.ts') ? ['--import', 'tsx'] : []), CLI],
      {
        env: AMBIENTE_DO_FILHO,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )

    let saida = ''
    let excedeu = false
    let encerrado = false

    const fim = (erro: Error | null, valor?: unknown) => {
      if (encerrado) return
      encerrado = true
      clearTimeout(relogio)
      if (erro) rejeitar(erro)
      else resolver(valor)
    }

    const relogio = setTimeout(() => {
      // `SIGKILL`, e não `SIGTERM`: um filho travado num laço de parsing pode
      // não chegar a atender o sinal educado, e o prazo duro precisa ser duro.
      filho.kill('SIGKILL')
      fim(new ParserFalhou('o parser não terminou dentro do prazo'))
    }, PRAZO_MS)

    filho.stdout.on('data', (pedaco: Buffer) => {
      if (excedeu) return
      saida += pedaco.toString('utf8')
      if (saida.length > SAIDA_MAXIMA) {
        excedeu = true
        filho.kill('SIGKILL')
        fim(new ParserFalhou('o parser devolveu saída acima do teto'))
      }
    })

    // O `stderr` do filho é **descartado**, e de propósito: ele pode conter
    // trecho do arquivo, e o arquivo é um extrato bancário com dados de
    // terceiros. Regra 20.
    filho.stderr.resume()

    filho.on('error', (e) => fim(new ParserFalhou(`o parser não subiu: ${e.message}`)))

    filho.on('close', () => {
      if (encerrado) return
      try {
        fim(null, JSON.parse(saida))
      } catch {
        fim(new ParserFalhou('o parser devolveu uma resposta ilegível'))
      }
    })

    filho.stdin.on('error', () => fim(new ParserFalhou('o parser fechou a entrada')))
    filho.stdin.end(entrada)
  })
}
