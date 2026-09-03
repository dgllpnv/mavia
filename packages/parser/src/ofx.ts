import { centavosDe, ValorIlegivel } from './dinheiro.js'
import type { LinhaComProblema, RegistroBruto, Resultado } from './tipos.js'

/**
 * O leitor de OFX.
 *
 * OFX é SGML, não XML: tags sem fechamento são a norma, não a exceção, e o
 * arquivo que o banco entrega raramente valida contra qualquer coisa. Um parser
 * de XML de prateleira recusa metade dos extratos reais do Brasil, e insistir
 * nele produziria um produto que não importa o extrato do cliente.
 *
 * Por isso a leitura é por **varredura de tags**, tolerante à ausência de
 * fechamento e à ordem — e intolerante ao que importa: valor, data e
 * identificador. Sem os três, a linha não entra.
 *
 * ## O que ele não faz
 *
 * Não interpreta `<BALAMT>`, não confere totais e não valida assinatura. Saldo é
 * derivado neste sistema (regra 5), e importar o saldo que o banco declara
 * criaria um segundo número com autoridade para discordar do nosso.
 */

/** Uma transação do extrato. É a única coisa que nos interessa no arquivo. */
const BLOCO = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi

export function lerOfx(conteudo: string): Resultado {
  const registros: RegistroBruto[] = []
  const problemas: LinhaComProblema[] = []

  // A moeda do arquivo, quando declarada. Não convertemos nada: se o extrato
  // vier em moeda diferente da conta, quem recusa é a borda — aqui só se
  // registra o fato.
  const moeda = valorDaTag(conteudo, 'CURDEF') ?? 'BRL'

  let indice = 0
  for (const bloco of conteudo.matchAll(BLOCO)) {
    indice++
    const corpo = bloco[1] ?? ''

    const externalId = valorDaTag(corpo, 'FITID')
    const dataBruta = valorDaTag(corpo, 'DTPOSTED')
    const valorBruto = valorDaTag(corpo, 'TRNAMT')

    if (!externalId || !dataBruta || !valorBruto) {
      problemas.push({
        linha: indice,
        motivo: 'Transação sem FITID, DTPOSTED ou TRNAMT.',
        bruto: corpo.trim().slice(0, 200),
      })
      continue
    }

    let centavos: bigint
    try {
      centavos = centavosDe(valorBruto)
    } catch (erro) {
      problemas.push({
        linha: indice,
        motivo: erro instanceof ValorIlegivel ? erro.message : 'Valor ilegível.',
        bruto: valorBruto,
      })
      continue
    }

    const data = dataCivilDe(dataBruta)
    if (!data) {
      problemas.push({ linha: indice, motivo: 'Data ilegível.', bruto: dataBruta })
      continue
    }

    // `MEMO` costuma ser mais descritivo que `NAME`, mas nem todo banco manda os
    // dois. O primeiro que existir vale; ficar sem descrição é aceitável, ficar
    // sem valor não é.
    const descricao =
      valorDaTag(corpo, 'MEMO') ?? valorDaTag(corpo, 'NAME') ?? 'Lançamento importado'

    registros.push({
      externalId,
      data,
      centavos,
      moeda,
      descricao: descricao.slice(0, 140),
      tipo: valorDaTag(corpo, 'TRNTYPE') ?? null,
      bruto: corpo.trim(),
    })
  }

  return { registros, problemas }
}

/**
 * O valor de uma tag SGML, com ou sem fechamento.
 *
 * Sem fechamento — o caso comum — o valor vai até a próxima tag ou o fim da
 * linha. Exigir fechamento seria recusar a maioria dos arquivos reais.
 */
function valorDaTag(texto: string, tag: string): string | null {
  const comFechamento = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(texto)
  if (comFechamento?.[1] !== undefined) return limpar(comFechamento[1])

  const semFechamento = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(texto)
  if (semFechamento?.[1] !== undefined) return limpar(semFechamento[1])

  return null
}

function limpar(bruto: string): string | null {
  const texto = bruto
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .trim()
  return texto === '' ? null : texto
}

/**
 * `20260903`, `20260903120000` e `20260903120000[-3:BRT]` → data civil.
 *
 * **O fuso do arquivo é ignorado de propósito.** O que o banco informa é o dia
 * em que a transação foi lançada no extrato dele, e esse dia é o fato — não um
 * instante a ser reinterpretado. Converter `20260903000000[-3:BRT]` para UTC e
 * de volta produziria 02/09 em metade dos casos, e o lançamento apareceria no
 * mês errado na virada.
 */
function dataCivilDe(bruto: string): { ano: number; mes: number; dia: number } | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(bruto.trim())
  if (!m) return null

  const ano = Number(m[1])
  const mes = Number(m[2])
  const dia = Number(m[3])

  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null
  // Dia que não existe no mês — 31 de fevereiro sai de exportação com defeito.
  const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate()
  if (dia > ultimoDia) return null

  return { ano, mes, dia }
}
