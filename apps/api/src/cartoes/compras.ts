import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import type { CompraNoCartao, CriarCompraNoCartao, Moeda } from '@mavia/contracts'
import {
  dataCivilDe,
  dinheiro,
  formatarDataCivil,
  gerarParcelas,
  janelaDaFatura,
  vencimentoDaFatura,
  type CicloDeFaturamento,
  type Competencia,
} from '@mavia/domain'
import type { PoolClient } from 'pg'

/**
 * Compra no cartão — de uma requisição para N lançamentos e N faturas.
 *
 * Este módulo é a **única** porta pela qual uma compra de cartão entra no
 * sistema. A divisão do valor, a data de cada parcela e a fatura de cada uma
 * vêm todas de `gerarParcelas`, no domínio: reescrever qualquer uma delas aqui
 * criaria uma segunda regra, e duas regras divergem no mês em que ninguém está
 * olhando.
 *
 * Roda inteiro dentro da transação de `comTenant`. Uma compra parcial — seis
 * parcelas de doze, seis faturas novas cobrando metade — é pior do que uma
 * compra recusada.
 *
 * **Vocabulário.** Uma fatura tem dois meses, e eles não são o mesmo: o
 * `mesDeFechamento`, que identifica o ciclo, e a `competencia`, que é o mês do
 * vencimento (`CONTEXT.md`). Num ciclo 25/5 eles sempre diferem.
 */

export interface CartaoDaCompra extends CicloDeFaturamento {
  readonly id: string
  readonly moeda: Moeda
  readonly contaPagamentoId: string | null
}

/** Quantos meses à frente procurar uma fatura que ainda receba lançamento. */
const HORIZONTE_DE_BUSCA = 24

export async function registrarCompra(
  c: PoolClient,
  ctx: { tenantId: string; usuarioId: string },
  cartao: CartaoDaCompra,
  dados: CriarCompraNoCartao,
): Promise<CompraNoCartao> {
  const postedAt = new Date(dados.postedAt)
  const valor = dinheiro(BigInt(dados.valorCentavos), cartao.moeda)

  const parcelas = gerarParcelas(valor, dados.parcelas, postedAt, cartao)
  if (!parcelas.ok) {
    throw new BadRequestException(
      parcelas.erro.tipo === 'parcelamento-indivisivel'
        ? `Este valor não divide em ${dados.parcelas} parcelas sem gerar parcela de R$ 0,00.`
        : 'Número de parcelas inválido.',
    )
  }

  // Erro de chave estrangeira vira 500 com nome de restrição. Conferir antes
  // devolve 404 e uma frase que o formulário sabe mostrar.
  const cat = await c.query(
    `SELECT 1 FROM categorias WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [ctx.tenantId, dados.categoriaId],
  )
  if (cat.rowCount === 0) throw new NotFoundException('Categoria não encontrada.')

  // Grupo só quando há o que agrupar. Um parcelamento de uma parcela é uma
  // linha que não parcela nada e um "1/1" no extrato que ninguém pediu.
  const parcelamentoId =
    dados.parcelas > 1 ? await criarParcelamento(c, ctx, cartao, dados, postedAt) : null

  const itens: CompraNoCartao['itens'] = []
  for (const p of parcelas.valor) {
    const fatura = await faturaQueRecebe(c, ctx.tenantId, cartao, p.mesDeFechamentoDaFatura)

    const r = await c.query<{ id: string }>(
      `INSERT INTO lancamentos (tenant_id, cartao_id, categoria_id, valor_centavos, moeda,
                                posted_at, descricao, observacao, fatura_id,
                                installment_group_id, installment_number, installment_total,
                                origem, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        ctx.tenantId,
        cartao.id,
        dados.categoriaId,
        p.valor.centavos.toString(),
        cartao.moeda,
        p.postedAt,
        descricaoDaParcela(dados.descricao, p.numero, p.total),
        dados.observacao ?? null,
        fatura.id,
        parcelamentoId,
        // `parcela_coerente` exige que grupo e número existam juntos ou faltem
        // juntos. À vista não há grupo, e portanto não há numeração.
        parcelamentoId ? p.numero : null,
        parcelamentoId ? p.total : null,
        // A origem é o terceiro eixo de filtro do extrato. Compra à vista é
        // `manual`: "1/1" não é parcelamento, e marcá-la como tal a poria no
        // filtro de parceladas, onde a pessoa procura compromisso futuro.
        parcelamentoId ? 'parcelamento' : 'manual',
        ctx.usuarioId,
      ],
    )
    const l = r.rows[0]
    if (!l) throw new ConflictException('Não foi possível registrar a compra.')

    itens.push({
      id: l.id,
      numero: p.numero,
      total: p.total,
      valorCentavos: p.valor.centavos.toString(),
      postedAt: p.postedAt.toISOString(),
      faturaId: fatura.id,
      competenciaDaFatura: fatura.competencia,
    })
  }

  return { parcelamentoId, itens }
}

/**
 * "Notebook" em 12x vira "Notebook 3/12" no extrato.
 *
 * A numeração fica na descrição porque é o que a pessoa lê na linha. As colunas
 * `installment_*` continuam existindo — elas é que servem às consultas.
 */
function descricaoDaParcela(descricao: string, numero: number, total: number): string {
  return total > 1 ? `${descricao} ${numero}/${total}` : descricao
}

async function criarParcelamento(
  c: PoolClient,
  ctx: { tenantId: string; usuarioId: string },
  cartao: CartaoDaCompra,
  dados: CriarCompraNoCartao,
  postedAt: Date,
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO parcelamentos (tenant_id, cartao_id, data_compra, valor_total_centavos,
                                moeda, parcelas, descricao, criado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      ctx.tenantId,
      cartao.id,
      postedAt,
      // Com sinal. Guardar magnitude aqui faria a invariante `Σ filhos =
      // valor_total` falhar invertida, num teste que ninguém suspeitaria.
      dados.valorCentavos,
      cartao.moeda,
      dados.parcelas,
      dados.descricao,
      ctx.usuarioId,
    ],
  )
  const l = r.rows[0]
  if (!l) throw new ConflictException('Não foi possível registrar o parcelamento.')
  return l.id
}

interface FaturaDestino {
  readonly id: string
  /** `AAAA-MM` do vencimento — a competência do glossário, não o fechamento. */
  readonly competencia: string
}

/**
 * A fatura que recebe a parcela: a do seu mês de fechamento, aberta se preciso.
 *
 * Se essa fatura já fechou — compra lançada com atraso, e isso acontece —, a
 * parcela **anda para a frente** até a primeira que ainda recebe, como manda a
 * regra de atribuição do `CONTEXT.md`. Não some e não reabre nada: reabrir
 * mudaria um total que o usuário já viu, e possivelmente já pagou.
 *
 * A busca é limitada. Sem limite, um estado esquisito no banco viraria um laço
 * abrindo faturas até o fim do calendário.
 */
async function faturaQueRecebe(
  c: PoolClient,
  tenantId: string,
  cartao: CartaoDaCompra,
  mesDeFechamentoAlvo: Competencia,
): Promise<FaturaDestino> {
  let mes = mesDeFechamentoAlvo

  for (let salto = 0; salto < HORIZONTE_DE_BUSCA; salto++) {
    const janela = janelaDaFatura(cartao, mes)

    // A chave do ciclo é `periodo_inicio`, não `competencia`: a competência é o
    // mês do vencimento e, num ciclo 1/25, duas janelas podem cair no mesmo mês
    // de vencimento. `periodo_inicio` é o que a restrição de exclusão protege.
    const existente = await c.query<{ id: string; estado: string }>(
      `SELECT id, estado FROM faturas
        WHERE tenant_id = $1 AND cartao_id = $2 AND periodo_inicio = $3 AND deleted_at IS NULL`,
      [tenantId, cartao.id, janela.inicio],
    )
    const f = existente.rows[0]
    const competencia = rotuloDaCompetencia(cartao, mes)

    if (!f) return { id: await abrirFatura(c, tenantId, cartao, mes), competencia }
    if (f.estado === 'aberta') return { id: f.id, competencia }

    mes = seguinte(mes)
  }

  throw new ConflictException(
    `Nenhuma fatura deste cartão aceita lançamento nos próximos ${HORIZONTE_DE_BUSCA} meses.`,
  )
}

/**
 * Abre a fatura de um mês de fechamento.
 *
 * A janela vem do domínio. Reescrevê-la aqui criaria compra que some ou é
 * cobrada duas vezes, e a divergência só apareceria no mês seguinte.
 */
export async function abrirFatura(
  c: PoolClient,
  tenantId: string,
  cartao: CartaoDaCompra,
  mesDeFechamento: Competencia,
): Promise<string> {
  const janela = janelaDaFatura(cartao, mesDeFechamento)
  const venc = vencimentoDaFatura(cartao, mesDeFechamento)
  // O fim da janela é exclusivo: o último instante que ainda lhe pertence é um
  // milissegundo antes, e o dia dele é lido no fuso do tenant, nunca em UTC.
  const fecha = formatarDataCivil(dataCivilDe(new Date(janela.fim.getTime() - 1)))

  const r = await c.query<{ id: string }>(
    `INSERT INTO faturas (tenant_id, cartao_id, periodo_inicio, periodo_fim,
                          data_fechamento, data_vencimento, competencia, conta_pagamento_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      tenantId,
      cartao.id,
      janela.inicio,
      janela.fim,
      fecha,
      diaCivilDe(venc),
      // Competência é o mês do vencimento (`CONTEXT.md`), guardado no dia 1.
      `${venc.ano}-${doisDigitos(venc.mes)}-01`,
      cartao.contaPagamentoId,
    ],
  )
  const l = r.rows[0]
  if (l) return l.id

  // `ON CONFLICT DO NOTHING` e nenhuma linha: outra requisição abriu a mesma
  // fatura entre a consulta e a inserção. Ler de novo é o desfecho certo —
  // duas faturas para o mesmo ciclo cobrariam a compra duas vezes.
  const jaExiste = await c.query<{ id: string }>(
    `SELECT id FROM faturas
      WHERE tenant_id = $1 AND cartao_id = $2 AND periodo_inicio = $3 AND deleted_at IS NULL`,
    [tenantId, cartao.id, janela.inicio],
  )
  const f = jaExiste.rows[0]
  if (!f) throw new ConflictException('Não foi possível abrir a fatura deste ciclo.')
  return f.id
}

const doisDigitos = (n: number): string => String(n).padStart(2, '0')

const diaCivilDe = (d: { ano: number; mes: number; dia: number }): string =>
  `${d.ano}-${doisDigitos(d.mes)}-${doisDigitos(d.dia)}`

const rotuloDaCompetencia = (ciclo: CicloDeFaturamento, mesDeFechamento: Competencia): string => {
  const venc = vencimentoDaFatura(ciclo, mesDeFechamento)
  return `${venc.ano}-${doisDigitos(venc.mes)}`
}

const seguinte = (c: Competencia): Competencia =>
  c.mes === 12 ? { ano: c.ano + 1, mes: 1 } : { ano: c.ano, mes: c.mes + 1 }
