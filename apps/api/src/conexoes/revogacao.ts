import type { Pool, PoolClient } from 'pg'
import { zerar } from '@mavia/guardiao'
import type { ClienteDoGuardiao } from '../guardiao/cliente.js'
import { comTenant, type ContextoDoTenant } from '../tenancy/tenancy.js'
import type { BankSyncProvider, MotivoDaRevogacao, ResultadoRevogacao } from './provider.js'

/**
 * A revogação em três fases — ADR 0019 §D2.
 *
 * A ordem é a decisão inteira, e a ordem intuitiva é a errada.
 *
 * | Fase | O que | Onde |
 * |---|---|---|
 * | 1 | destruir a credencial, registrar a escolha, soltar as contas | **dentro** da transação |
 * | 2 | pedir ao provider que encerre o acesso, com prazo duro | depois do commit |
 * | 3 | o volume: payload bruto, cache | assíncrono |
 *
 * **A Fase 2 nunca acontece dentro da transação.** I/O de rede sob transação
 * aberta prende conexão de pool e lock por segundos — e, o que decide a
 * questão, um timeout faria `ROLLBACK`, deixando a credencial **viva** depois
 * que o titular pediu para destruí-la. O pior resultado possível, produzido
 * pela ordem mais natural de escrever o código.
 *
 * Por isso a Fase 1 é incondicional: ela não pergunta ao provider se pode. O
 * que a Mavia guarda, a Mavia destrói, aconteça o que acontecer lá fora.
 */

/** O prazo da tentativa síncrona. Acima disto, o titular espera o job. */
const PRAZO_DA_FASE_2_MS = 3_000

/**
 * Era uma interface própria, com a mesma forma de `ContextoDoTenant` — e por
 * isso intercambiável com ele por estrutura. Passou a ser o mesmo tipo: duas
 * definições que se aceitam mutuamente não são dois tipos, são um com dois
 * nomes, e o segundo nome só serve para esconder que a marca não vale ali.
 */
export type Contexto = ContextoDoTenant

export interface Dependencias {
  readonly pool: Pool
  readonly guardiao: ClienteDoGuardiao
  readonly adapter: (nome: string) => BankSyncProvider | null
}

export interface DesfechoDaRevogacao {
  readonly jaEstavaRevogada: boolean
  readonly revogacaoNoProvedor: 'pendente' | 'confirmada' | 'falhou' | 'nao_aplicavel'
  readonly lancamentosMantidos: number
  readonly detalhe: string | null
}

export class ConexaoInexistente extends Error {}

export async function revogarConexao(
  deps: Dependencias,
  ctx: Contexto,
  conexaoId: string,
  motivo: MotivoDaRevogacao,
): Promise<DesfechoDaRevogacao> {
  // ---------------------------------------------------------------------
  // Fase 1 — síncrona, transacional, incondicional
  // ---------------------------------------------------------------------
  const fase1 = await comTenant(deps.pool, ctx, async (c) => {
    const linha = await c.query<{
      provider: string
      external_id: string | null
      status: string
      credenciais_cifradas: Buffer | null
      dek_cifrada: Buffer | null
      kek_versao: number | null
    }>(
      `SELECT provider, external_id, status, credenciais_cifradas, dek_cifrada, kek_versao
         FROM conexoes
        WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
      [conexaoId],
    )

    const atual = linha.rows[0]
    if (!atual) throw new ConexaoInexistente(conexaoId)

    const adapter = deps.adapter(atual.provider)
    if (!adapter) {
      // Um provider gravado sem adapter correspondente é defeito de migração de
      // dados, e a revogação não pode ser onde ele aparece: a Fase 1 acontece
      // de todo modo, e o lado de lá fica pendente para investigação humana.
      // Silenciar seria pior — "revogada" sem ninguém para encerrar o acesso.
      return {
        ...(await destruir(c, conexaoId, ctx, motivo, 'pendente')),
        adapter: null as BankSyncProvider | null,
        atual,
        segredo: undefined as Buffer | undefined,
      }
    }

    const remotaInicial = adapter.revogacaoRemota === 'nao-aplicavel' ? 'nao_aplicavel' : 'pendente'

    // O segredo é decifrado **aqui dentro**, na única janela em que ele existe:
    // a Fase 1 vai apagá-lo do banco no statement seguinte. Depois desta
    // transação não há de onde relê-lo — é isso que torna a Fase 2 possível e
    // não repetível.
    const segredo = await decifrarSeHouver(deps, ctx, conexaoId, adapter, atual)

    const destruicao = await destruir(c, conexaoId, ctx, motivo, remotaInicial)
    return { ...destruicao, adapter: adapter, atual, segredo }
  })

  if (fase1.jaEstavaRevogada) {
    // Idempotência (§D4): o botão recebe dois cliques, e o segundo não é erro.
    return {
      jaEstavaRevogada: true,
      revogacaoNoProvedor: fase1.remota,
      lancamentosMantidos: fase1.lancamentos,
      detalhe: null,
    }
  }

  // ---------------------------------------------------------------------
  // Fase 2 — tentativa síncrona, prazo duro, **fora** da transação
  // ---------------------------------------------------------------------
  if (!fase1.adapter || fase1.adapter.revogacaoRemota === 'nao-aplicavel') {
    return {
      jaEstavaRevogada: false,
      revogacaoNoProvedor: fase1.remota,
      lancamentosMantidos: fase1.lancamentos,
      detalhe: null,
    }
  }

  const resultado = await tentarNoProvedor(fase1.adapter, {
    tenantId: ctx.tenantId,
    conexaoId,
    provider: fase1.atual.provider,
    externalId: fase1.atual.external_id,
    motivo,
    chaveIdempotencia: `revogacao:${conexaoId}`,
    tentativa: 1,
    ...(fase1.segredo ? { segredo: fase1.segredo } : {}),
  })

  if (fase1.segredo) zerar(fase1.segredo)

  const { remota, detalhe } = traduzir(resultado)

  await comTenant(deps.pool, ctx, (c) =>
    c.query(
      `UPDATE conexoes
          SET revogacao_remota = $2,
              revogacao_detalhe = $3,
              revogacao_tentativas = revogacao_tentativas + 1
        WHERE id = $1`,
      [conexaoId, remota, detalhe],
    ),
  )

  return {
    jaEstavaRevogada: false,
    revogacaoNoProvedor: remota,
    lancamentosMantidos: fase1.lancamentos,
    detalhe,
  }
}

/**
 * A Fase 1 propriamente dita, e a Fase 3 junto — **por enquanto**.
 *
 * O ADR manda a limpeza do `payload` para fora da transação porque ela pode ser
 * dezenas de milhares de linhas, e transação longa é pior que quinze minutos de
 * atraso. Hoje ela é **zero linhas**: nenhum adapter registrado escreve
 * `payload`, porque nenhum agregador está ligado.
 *
 * Fazê-la aqui é, hoje, um `UPDATE` que não toca em nada — e ganha a
 * atomicidade de graça. **No dia em que um adapter passar a escrever `payload`,
 * isto precisa sair daqui** e virar o job disparado por `consentimento.revogado`
 * (pendência P-16), junto com o `outbox` e o job de retentativa. É a mesma
 * condição, e por isso a suíte de contrato tem um alarme que dispara quando o
 * primeiro adapter com revogação remota for registrado.
 */
async function destruir(
  c: PoolClient,
  conexaoId: string,
  ctx: Contexto,
  motivo: MotivoDaRevogacao,
  remota: 'pendente' | 'nao_aplicavel',
) {
  const r = await c.query<{
    ja_estava_revogada: boolean
    lancamentos_mantidos: string
    revogacao_atual: DesfechoDaRevogacao['revogacaoNoProvedor'] | null
  }>('SELECT * FROM revogar_conexao($1, $2, $3, $4)', [
    conexaoId,
    ctx.usuarioId,
    motivo,
    remota,
  ])

  const linha = r.rows[0]!

  if (!linha.ja_estava_revogada) {
    await c.query(
      `UPDATE lancamentos_brutos SET payload = NULL
        WHERE conexao_id = $1 AND payload IS NOT NULL`,
      [conexaoId],
    )
  }

  return {
    jaEstavaRevogada: linha.ja_estava_revogada,
    lancamentos: Number(linha.lancamentos_mantidos),
    // Na segunda revogação vale o que está gravado: a primeira já decidiu.
    remota: linha.revogacao_atual ?? remota,
  }
}

/**
 * O segredo, quando existe.
 *
 * Só para adapter que declarou `credencial-por-conexao` (ADR 0018 §D0). Nenhum
 * adapter registrado hoje declara isso, e o caminho existe porque a alternativa
 * — escrevê-lo junto com o primeiro agregador — é escrevê-lo com pressa, no dia
 * em que já há credencial de gente de verdade no banco.
 */
async function decifrarSeHouver(
  deps: Dependencias,
  ctx: Contexto,
  conexaoId: string,
  adapter: BankSyncProvider,
  linha: {
    credenciais_cifradas: Buffer | null
    dek_cifrada: Buffer | null
    kek_versao: number | null
  },
): Promise<Buffer | undefined> {
  if (adapter.modeloDeCredencial !== 'credencial-por-conexao') return undefined
  if (!linha.credenciais_cifradas || !linha.dek_cifrada || linha.kek_versao === null) {
    return undefined
  }

  try {
    return await deps.guardiao.usarSegredo(
      {
        proposito: 'conexao.credenciais',
        tenantId: ctx.tenantId,
        recursoId: conexaoId,
        kekVersao: linha.kek_versao,
      },
      linha.dek_cifrada,
      linha.credenciais_cifradas,
      // A cópia sai do callback de propósito: ela precisa sobreviver até a Fase
      // 2, que acontece depois do commit. É a **única** cópia que existirá, e é
      // zerada assim que o provider responde.
      (claro) => Buffer.from(claro),
    )
  } catch {
    // O guardião selado não pode impedir a destruição da credencial. Sem o
    // segredo a Fase 2 não acontece e a conexão fica `pendente` — que é a
    // verdade, e é melhor do que manter a credencial viva esperando o cofre.
    return undefined
  }
}

/**
 * A defesa da regra 1 do §D1: `revogar` não lança.
 *
 * Ela existe para o incidente, não para ser o caminho normal — o adapter que a
 * aciona reprova a suíte de contrato. Uma exceção que escape vira
 * `falha_temporaria`, e não `falhou`: não sabemos o que aconteceu lá fora, e
 * declarar fracasso definitivo com base em não saber prenderia o titular.
 */
async function tentarNoProvedor(
  adapter: BankSyncProvider,
  alvo: Parameters<BankSyncProvider['revogar']>[0],
): Promise<ResultadoRevogacao> {
  const controle = new AbortController()
  const relogio = setTimeout(() => controle.abort(), PRAZO_DA_FASE_2_MS)

  try {
    return await adapter.revogar(alvo, {
      sinal: controle.signal,
      prazoMs: PRAZO_DA_FASE_2_MS,
    })
  } catch {
    return { estado: 'falha_temporaria', codigo: 'rede' }
  } finally {
    clearTimeout(relogio)
  }
}

function traduzir(r: ResultadoRevogacao): {
  remota: DesfechoDaRevogacao['revogacaoNoProvedor']
  detalhe: string | null
} {
  switch (r.estado) {
    case 'revogado':
    case 'ja_revogado':
      // `ja_revogado` é **sucesso**: não há acesso a encerrar. Tratá-lo como
      // pendência deixaria a conexão pendurada para sempre por algo já
      // resolvido, e o titular lendo "pendente" concluiria que o banco ainda
      // tem acesso.
      return { remota: 'confirmada', detalhe: null }
    case 'nao_aplicavel':
      return { remota: 'nao_aplicavel', detalhe: r.motivo }
    case 'falha_temporaria':
      return { remota: 'pendente', detalhe: r.codigo }
    case 'falha_permanente':
      return { remota: 'falhou', detalhe: `${r.codigo}: ${r.detalhe}` }
  }
}
