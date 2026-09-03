import { centavosDe, ValorIlegivel } from './dinheiro.js'
import type { DataCivil, LinhaComProblema, RegistroBruto, Resultado } from './tipos.js'

/**
 * O leitor de CSV de extrato.
 *
 * CSV não tem formato: tem convenções, e cada banco tem a sua. Separador que é
 * ponto e vírgula porque a vírgula é decimal, cabeçalho em português com
 * acento, colunas de crédito e débito separadas, data em `DD/MM/AAAA`.
 *
 * A escolha aqui é **detectar e declarar**, nunca adivinhar em silêncio: o
 * resultado diz qual mapeamento foi usado, e quem chama pode recusá-lo. Um
 * parser que adivinha errado produz um extrato plausível — com sinal invertido,
 * ou com dia e mês trocados — e essa é a pior falha possível, porque não parece
 * falha.
 *
 * ## O identificador que o CSV não tem
 *
 * OFX traz `FITID`; CSV não traz nada. Sem identificador de origem não há
 * idempotência, e importar o mesmo arquivo duas vezes duplicaria tudo. A saída é
 * derivar um: hash do conteúdo normalizado da linha mais a sua **posição** no
 * arquivo — a posição entra porque duas compras iguais no mesmo dia, no mesmo
 * valor, são duas compras, e um identificador só de conteúdo as fundiria numa.
 */

export interface MapaDeColunas {
  readonly data: number
  readonly descricao: number
  /** Coluna única com sinal. Exclusiva com `credito`/`debito`. */
  readonly valor?: number
  readonly credito?: number
  readonly debito?: number
}

const CABECALHOS = {
  data: ['data', 'data lancamento', 'data lançamento', 'data mov', 'date'],
  descricao: ['descricao', 'descrição', 'historico', 'histórico', 'lancamento', 'memo', 'description'],
  valor: ['valor', 'valor (r$)', 'amount', 'montante'],
  credito: ['credito', 'crédito', 'entrada', 'receita'],
  debito: ['debito', 'débito', 'saida', 'saída', 'despesa'],
} as const

export function lerCsv(conteudo: string, mapa?: MapaDeColunas): Resultado {
  const linhas = conteudo
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')

  if (linhas.length === 0) return { registros: [], problemas: [] }

  const separador = detectarSeparador(linhas[0]!)
  const celulas = linhas.map((l) => dividir(l, separador))

  const mapeamento = mapa ?? detectarColunas(celulas[0] ?? [])
  if (!mapeamento) {
    return {
      registros: [],
      problemas: [
        {
          linha: 1,
          motivo:
            'Não reconhecemos as colunas deste arquivo. Escolha manualmente qual é a data, a descrição e o valor.',
          bruto: linhas[0]!.slice(0, 200),
        },
      ],
    }
  }

  // Se o cabeçalho foi reconhecido, a primeira linha é cabeçalho. Com mapa
  // informado à mão, quem chama já sabe o que está mandando.
  const primeira = mapa ? 0 : 1

  const registros: RegistroBruto[] = []
  const problemas: LinhaComProblema[] = []

  for (let i = primeira; i < celulas.length; i++) {
    const linha = celulas[i]!
    const numero = i + 1

    const dataBruta = linha[mapeamento.data]?.trim() ?? ''
    const data = dataCivilDe(dataBruta)
    if (!data) {
      problemas.push({ linha: numero, motivo: 'Data ilegível.', bruto: dataBruta })
      continue
    }

    let centavos: bigint
    try {
      centavos = valorDaLinha(linha, mapeamento)
    } catch (erro) {
      problemas.push({
        linha: numero,
        motivo: erro instanceof ValorIlegivel ? erro.message : 'Valor ilegível.',
        bruto: linhas[i]!.slice(0, 200),
      })
      continue
    }

    // Valor zero não é lançamento: é linha de saldo ou separador que alguns
    // bancos põem no meio do arquivo.
    if (centavos === 0n) continue

    const descricao = linha[mapeamento.descricao]?.trim() ?? 'Lançamento importado'
    const bruto = linhas[i]!

    registros.push({
      externalId: identificadorDe(bruto, numero),
      data,
      centavos,
      moeda: 'BRL',
      descricao: descricao.slice(0, 140) || 'Lançamento importado',
      tipo: null,
      bruto,
    })
  }

  return { registros, problemas }
}

function valorDaLinha(linha: readonly string[], mapa: MapaDeColunas): bigint {
  if (mapa.valor !== undefined) return centavosDe(linha[mapa.valor] ?? '')

  // Colunas separadas: crédito é positivo, débito é negativo — **sempre**,
  // mesmo quando o arquivo já traz o débito com sinal. Um banco que exporta
  // `-150,00` na coluna de débito e outro que exporta `150,00` são o mesmo
  // fato, e o sinal tem de vir da coluna, não do texto.
  const credito = texto(linha[mapa.credito ?? -1])
  const debito = texto(linha[mapa.debito ?? -1])

  if (credito) return abs(centavosDe(credito))
  if (debito) return -abs(centavosDe(debito))

  throw new ValorIlegivel(linha.join(' | '))
}

const abs = (n: bigint): bigint => (n < 0n ? -n : n)
const texto = (c: string | undefined): string | null => {
  const t = c?.trim()
  return t && t !== '0' && t !== '0,00' && t !== '0.00' ? t : null
}

/**
 * Separador: o que mais aparece no cabeçalho entre `;`, `,` e tabulação.
 *
 * `;` vem antes de `,` no desempate porque, no Brasil, a vírgula é decimal — um
 * arquivo com `1.234,56` e vírgula como separador de coluna é raro; com ponto e
 * vírgula é o normal.
 */
function detectarSeparador(cabecalho: string): string {
  const candidatos = [';', '\t', ','] as const
  let melhor: string = ';'
  let maior = -1

  for (const c of candidatos) {
    const n = cabecalho.split(c).length - 1
    if (n > maior) {
      maior = n
      melhor = c
    }
  }
  return melhor
}

/** Divisão com aspas: `"Pagamento, parcelado";150,00` tem duas colunas. */
function dividir(linha: string, separador: string): string[] {
  const saida: string[] = []
  let atual = ''
  let dentroDeAspas = false

  for (let i = 0; i < linha.length; i++) {
    const c = linha[i]!
    if (c === '"') {
      // `""` dentro de aspas é uma aspa literal.
      if (dentroDeAspas && linha[i + 1] === '"') {
        atual += '"'
        i++
      } else {
        dentroDeAspas = !dentroDeAspas
      }
      continue
    }
    if (c === separador && !dentroDeAspas) {
      saida.push(atual)
      atual = ''
      continue
    }
    atual += c
  }
  saida.push(atual)
  return saida
}

function detectarColunas(cabecalho: readonly string[]): MapaDeColunas | null {
  const normalizado = cabecalho.map((c) =>
    c
      .trim()
      .toLowerCase()
      .replace(/^"|"$/g, ''),
  )

  const acharColuna = (nomes: readonly string[]): number =>
    normalizado.findIndex((c) => nomes.includes(c))

  const data = acharColuna(CABECALHOS.data)
  const descricao = acharColuna(CABECALHOS.descricao)
  if (data < 0 || descricao < 0) return null

  const valor = acharColuna(CABECALHOS.valor)
  if (valor >= 0) return { data, descricao, valor }

  const credito = acharColuna(CABECALHOS.credito)
  const debito = acharColuna(CABECALHOS.debito)
  if (credito >= 0 || debito >= 0) {
    return {
      data,
      descricao,
      ...(credito >= 0 ? { credito } : {}),
      ...(debito >= 0 ? { debito } : {}),
    }
  }

  return null
}

/**
 * `03/09/2026`, `2026-09-03`, `03-09-2026`.
 *
 * **`DD/MM` e nunca `MM/DD`.** O produto é brasileiro e o arquivo vem de banco
 * brasileiro; aceitar as duas leituras faria `03/09` virar março ou setembro
 * conforme o dia, e o erro só apareceria nos doze dias do ano em que os dois são
 * válidos — que é precisamente quando ninguém suspeita do parser.
 */
function dataCivilDe(bruto: string): DataCivil | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(bruto)
  if (iso) return validar(Number(iso[1]), Number(iso[2]), Number(iso[3]))

  const br = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/.exec(bruto)
  if (br) {
    const anoBruto = Number(br[3])
    // `26` é 2026, não 1926: extrato de banco não vem do século passado.
    const ano = anoBruto < 100 ? 2000 + anoBruto : anoBruto
    return validar(ano, Number(br[2]), Number(br[1]))
  }

  return null
}

function validar(ano: number, mes: number, dia: number): DataCivil | null {
  if (!Number.isInteger(ano) || ano < 1970 || ano > 2200) return null
  if (mes < 1 || mes > 12 || dia < 1) return null
  const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate()
  if (dia > ultimoDia) return null
  return { ano, mes, dia }
}

/**
 * O identificador que o CSV não traz.
 *
 * Hash do conteúdo da linha **mais a posição**. A posição entra porque duas
 * compras iguais no mesmo dia e no mesmo valor são duas compras — um
 * identificador só de conteúdo as fundiria numa, e o extrato importado ficaria
 * com metade do almoço.
 *
 * FNV-1a de 64 bits, escrito à mão: o pacote não tem dependências, e não teria
 * como usar `node:crypto` dentro do processo isolado sem abrir a porta para o
 * resto do runtime.
 */
function identificadorDe(linha: string, posicao: number): string {
  const texto = `${posicao} ${linha.replace(/\s+/g, ' ').trim().toLowerCase()}`

  let hash = 0xcbf29ce484222325n
  const primo = 0x100000001b3n
  const mascara = 0xffffffffffffffffn

  for (let i = 0; i < texto.length; i++) {
    hash = (hash ^ BigInt(texto.charCodeAt(i))) & mascara
    hash = (hash * primo) & mascara
  }

  return `csv:${hash.toString(16).padStart(16, '0')}`
}
