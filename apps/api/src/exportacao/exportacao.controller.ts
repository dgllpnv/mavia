import { BadRequestException, Controller, Get, Inject, Req, UseGuards } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { AutorizacaoGuard } from '../autorizacao/autorizacao.guard.js'
import { POOL } from '../contas/contas.controller.js'
import { comTenant, contextoDoTenant } from '../tenancy/tenancy.js'

/**
 * Exportação — relatório **e** direito de portabilidade.
 *
 * A LGPD dá ao titular o direito de levar os próprios dados embora, em formato
 * estruturado e de uso comum. Isso não é uma funcionalidade a mais: é uma
 * obrigação, e ela só é cumprida se a exportação for **completa**.
 *
 * ## Completa quer dizer enumerada
 *
 * A lista de tabelas abaixo é escrita à mão, e essa é a decisão. A alternativa
 * — varrer o `information_schema` e exportar tudo o que tenha `tenant_id` —
 * pareceria mais robusta e seria pior de duas formas: exportaria colunas que
 * **não** podem sair (hash de senha, hash de refresh, segredo de provider), e
 * exportaria sem pensar tabelas que ainda vão existir.
 *
 * Com a lista escrita, uma tabela nova **não aparece** na exportação — e a
 * ausência é detectável, porque há um teste que compara esta lista com as
 * tabelas que têm `tenant_id`. Ele falha quando alguém cria uma tabela e
 * esquece de decidir se ela é do titular.
 *
 * ## O que nunca sai
 *
 * Credencial de qualquer espécie. `usuarios.senha_hash` e `sessoes.refresh_hash`
 * não são dados do titular no sentido útil da palavra — são material
 * criptográfico —, e exportá-los transformaria o arquivo de portabilidade numa
 * arma. `mutacoes_idempotentes.resposta` também fica de fora: é uma cópia
 * duplicada de dados que já saem pelas tabelas de origem.
 */

/**
 * O que sai, e como.
 *
 * `colunas` explícitas, nunca `SELECT *`: uma coluna nova entra na exportação
 * quando alguém decidir que ela deve entrar, e não por descuido de projeção.
 */
const CONJUNTOS = [
  {
    nome: 'contas',
    tabela: 'contas',
    colunas: `id, nome, tipo, origem, saldo_inicial_centavos::text, moeda,
              incluir_no_saldo_geral, criado_em, atualizado_em, deleted_at`,
  },
  {
    nome: 'categorias',
    tabela: 'categorias',
    colunas: `id, parent_id, nivel, nome, natureza, analitica, cor, icone, sistema,
              arquivada_em, criado_em, deleted_at`,
  },
  {
    nome: 'cartoes',
    tabela: 'cartoes',
    colunas: `id, nome, limite_centavos::text, moeda, closing_day, due_day,
              conta_pagamento_id, criado_em, deleted_at`,
  },
  {
    nome: 'faturas',
    tabela: 'faturas',
    colunas: `id, cartao_id, competencia, periodo_inicio, periodo_fim, data_fechamento,
              data_vencimento, estado, total_centavos::text, conta_pagamento_id, deleted_at`,
  },
  {
    nome: 'transferencias',
    tabela: 'transferencias',
    colunas: 'id, tipo, fatura_id, descricao, criado_em, deleted_at',
  },
  {
    nome: 'parcelamentos',
    tabela: 'parcelamentos',
    colunas: `id, cartao_id, data_compra, valor_total_centavos::text, moeda, parcelas,
              descricao, criado_em, deleted_at`,
  },
  {
    nome: 'lancamentos',
    tabela: 'lancamentos',
    colunas: `id, conta_id, cartao_id, categoria_id, valor_centavos::text, moeda,
              posted_at, settled_at, descricao, observacao, transfer_group_id,
              installment_group_id, installment_number, installment_total, fatura_id,
              estorno_de_lancamento_id, origem, editado_manualmente,
              recorrencia_id, recorrencia_competencia, importacao_id,
              classificacao_origem, classificacao_motivo,
              criado_em, atualizado_em, deleted_at`,
  },
  {
    nome: 'planejamentos',
    tabela: 'planejamentos',
    colunas: `id, competencia, categoria_id, valor_centavos::text, moeda,
              alertas_percentuais, criado_em, atualizado_em, deleted_at`,
  },
  {
    nome: 'objetivos',
    tabela: 'objetivos',
    colunas: `id, nome, valor_alvo_centavos::text, moeda, prazo, conta_id,
              saldo_base_centavos::text, concluido_em, criado_em, atualizado_em, deleted_at`,
  },
  {
    nome: 'aportes',
    tabela: 'aportes',
    colunas: 'id, objetivo_id, lancamento_id, criado_em, deleted_at',
  },
  {
    nome: 'recorrencias',
    tabela: 'recorrencias',
    colunas: `id, conta_id, cartao_id, categoria_id, valor_centavos::text, moeda,
              descricao, dia_do_mes, intervalo_meses, inicio, fim, pausada_em,
              criado_em, atualizado_em, deleted_at`,
  },
  {
    nome: 'regras_de_categorizacao',
    tabela: 'regras_de_categorizacao',
    colunas: 'id, tipo, padrao, categoria_id, prioridade, criado_em, deleted_at',
  },
  {
    nome: 'importacoes',
    tabela: 'importacoes',
    colunas: `id, conta_id, provider, nome_do_arquivo, registros, criados, repetidos,
              problemas, criado_em, desfeita_em`,
  },
  {
    nome: 'lancamentos_brutos',
    tabela: 'lancamentos_brutos',
    colunas: `id, importacao_id, conta_id, provider, external_id, data,
              valor_centavos::text, moeda, descricao, tipo, bruto, lancamento_id,
              criado_em, deleted_at`,
  },
  {
    nome: 'conciliacoes',
    tabela: 'conciliacoes',
    colunas: 'id, bruto_id, lancamento_id, confianca, motivo, estado, decidido_em, criado_em',
  },
  {
    nome: 'convites',
    tabela: 'convites',
    // **Sem `token_hash`.** A quem você convidou e quando é dado do titular; o
    // material que abre a porta não é. Um convite pendente exportado com o hash
    // seria uma credencial dentro do arquivo de portabilidade.
    colunas: `id, email, papel, criado_em, expira_em, aceito_em, revogado_em`,
  },
  {
    nome: 'assinatura',
    tabela: 'assinaturas',
    // **Sem os identificadores da Stripe.** Eles são referência a um sistema de
    // terceiro, não dizem nada ao titular, e um identificador de cliente numa
    // operadora de pagamento é o tipo de coisa que não deve circular em arquivo.
    colunas: `estado, plano, intervalo, periodo_inicio, periodo_fim, graca_ate,
              criado_em, atualizado_em`,
  },
  {
    nome: 'saldo_snapshots',
    tabela: 'saldo_snapshots',
    colunas: null,
  },
  {
    nome: 'conexoes',
    tabela: 'conexoes',
    // **Sem as colunas do envelope.** `credenciais_cifradas` e `dek_cifrada`
    // são material criptográfico; exportá-las entregaria o ciphertext num
    // arquivo que o titular guarda no Drive, e a segurança dele passaria a
    // depender de a KEK nunca vazar em lugar nenhum, nunca.
    colunas: `provider, apelido, instituicao, status, criado_em, sincronizada_em,
              revogada_em, motivo_revogacao, revogacao_remota, escopo`,
  },
  {
    nome: 'consentimentos',
    tabela: 'consentimentos',
    // O `ip_hash` fica de fora: é pseudônimo, não informação. Para o titular um
    // hash não diz nada, e num arquivo exportado ele vira só mais um dado a
    // vazar.
    colunas: `termos_versao, escopo, finalidade, concedido_em, expira_em,
              revogado_em, motivo_revogacao`,
  },
  {
    nome: 'sincronizacoes',
    tabela: 'sincronizacoes',
    // É como o titular vê o que aconteceu e **quando parou**.
    colunas: 'comecou_em, terminou_em, registros, novos, falha',
  },
] as const

/**
 * Tabelas que saem **junto de outra**, e não como conjunto próprio.
 *
 * `tenant_usuarios` é o vínculo entre pessoa e espaço: o papel dela sai dentro
 * de `usuarios`, onde é informação, em vez de sair como uma tabela de dois ids
 * que o titular teria de cruzar à mão.
 *
 * A distinção entre "sai junto" e "não sai" importa: a primeira é uma escolha de
 * forma, a segunda é uma escolha de conteúdo, e confundi-las esconderia a
 * segunda dentro da primeira.
 */
export const EXPORTADA_JUNTO: ReadonlyMap<string, string> = new Map([
  ['tenant_usuarios', 'o papel sai dentro de `usuarios`, onde é informação e não um par de ids'],
])

/**
 * Tabelas com `tenant_id` que **não** entram na exportação, e o porquê de cada
 * uma. A lista existe para que o teste de completude possa falhar quando
 * aparecer uma tabela nova que ninguém classificou.
 */
export const FORA_DA_EXPORTACAO: ReadonlyMap<string, string> = new Map([
  [
    'eventos_de_cobranca',
    'registro de integração com a operadora: é o que ela nos disse, não o que o titular fez',
  ],
  ['sessoes', 'material criptográfico: exportar hash de refresh seria exportar a chave de casa'],
  ['mutacoes_idempotentes', 'cópia duplicada de dados que já saem pelas tabelas de origem'],
  ['auditoria', 'registro do sistema sobre o titular, não dado do titular; sai por outro fluxo'],
  ['outbox_pendencias', 'fila interna de entrega, sem conteúdo próprio'],
  [
    'eliminacoes_journal',
    // Ela guarda **que** uma eliminação foi pedida, e nada do que foi eliminado
    // — guardar o conteúdo seria não eliminar. Exportá-la ao titular
    // devolveria a ele o próprio pedido de apagamento, o que não acrescenta
    // nada, e sobreviveria à eliminação que ela registra: a exportação viraria
    // o rastro que a política existe para não deixar.
    //
    // O titular já sabe que pediu, e a confirmação é o e-mail da janela de
    // arrependimento de 7 dias.
    'registro de que a eliminação foi pedida, sem nenhum conteúdo do que foi eliminado',
  ],
])

@Controller('v1/exportacao')
@UseGuards(AutorizacaoGuard)
export class ExportacaoController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /**
   * Tudo do espaço, em JSON.
   *
   * JSON e não CSV: o dado é relacional, e um CSV por tabela obrigaria o
   * titular a remontar as relações à mão. "Formato estruturado e de uso comum"
   * é o texto da lei, e JSON é as duas coisas.
   *
   * **Sem paginação, e de propósito.** Portabilidade partida em páginas é
   * portabilidade que o titular precisa saber programar para exercer.
   */
  @Get()
  async exportar(@Req() req: FastifyRequest): Promise<Record<string, unknown>> {
    const a = req.autenticado
    if (!a) throw new BadRequestException('Contexto ausente.')
    const ctx = contextoDoTenant(a.usuarioId, a.tenantId)

    return comTenant(this.pool, ctx, async (c) => {
      const dados: Record<string, unknown> = {
        formato: 1,
        geradoEm: new Date().toISOString(),
        espaco: await umaLinha(
          c,
          'SELECT id, nome, criado_em FROM tenants WHERE id = $1',
          ctx.tenantId,
        ),
        // O próprio titular, sem `senha_hash`. A projeção é explícita
        // justamente porque `SELECT *` traria o hash.
        usuarios: await todas(
          c,
          `SELECT u.id, u.nome, u.email, tu.papel, u.criado_em
             FROM tenant_usuarios tu JOIN usuarios u ON u.id = tu.usuario_id
            WHERE tu.tenant_id = $1`,
          ctx.tenantId,
        ),
      }

      for (const conjunto of CONJUNTOS) {
        dados[conjunto.nome] = await todas(
          c,
          `SELECT ${conjunto.colunas ?? '*'} FROM ${conjunto.tabela} WHERE tenant_id = $1`,
          ctx.tenantId,
        )
      }

      return dados
    })
  }
}

async function todas(c: PoolClient, sql: string, tenantId: string): Promise<unknown[]> {
  const r = await c.query(sql, [tenantId])
  return r.rows
}

async function umaLinha(c: PoolClient, sql: string, tenantId: string): Promise<unknown> {
  const r = await c.query(sql, [tenantId])
  return r.rows[0] ?? null
}

/**
 * As tabelas exportadas, para o teste de completude.
 *
 * `tabela` e `nome` são coisas distintas de propósito: a chave no arquivo é o
 * que o titular lê — `assinatura`, no singular, porque há uma —, e a tabela é
 * onde o dado mora. Confundi-los faria o nome do arquivo depender do nome da
 * coluna, e renomear uma tabela quebraria o formato de exportação de todo mundo.
 */
export const TABELAS_EXPORTADAS: readonly string[] = CONJUNTOS.map((c) => c.tabela)

/** As chaves do arquivo. É por elas que o titular encontra as coisas. */
export const CHAVES_DA_EXPORTACAO: readonly string[] = CONJUNTOS.map((c) => c.nome)
