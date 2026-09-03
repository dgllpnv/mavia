import * as SQLite from 'expo-sqlite'
import type { Mutacao } from './fila.js'

/**
 * O depósito local — SQLite no dispositivo.
 *
 * Guarda duas coisas, e a diferença entre elas é a coisa mais importante deste
 * arquivo:
 *
 * - **o cache**, que é uma cópia descartável do que o servidor já sabe. Perdê-lo
 *   custa uma sincronização;
 * - **a fila**, que é a única cópia de intenções que o servidor **ainda não
 *   sabe**. Perdê-la custa o dinheiro que a pessoa registrou.
 *
 * Por isso a fila é gravada de forma síncrona no momento do toque, antes de
 * qualquer tentativa de rede, e o cache pode ser reconstruído a qualquer
 * momento. Um app offline-first que grava a intenção depois de tentar a rede
 * não é offline-first: é um app online com uma tela de erro melhor.
 */

const ESQUEMA = `
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS fila (
    id          TEXT PRIMARY KEY,
    metodo      TEXT NOT NULL,
    caminho     TEXT NOT NULL,
    corpo       TEXT NOT NULL,
    tenant_id   TEXT NOT NULL,
    criada_em   INTEGER NOT NULL,
    tentativas  INTEGER NOT NULL,
    estado      TEXT NOT NULL,
    motivo      TEXT,
    tentar_apos INTEGER NOT NULL
  );

  -- O cache é por espaço e por chave: a mesma consulta de dois espaços não
  -- pode se sobrescrever. Foi assim que apps multi-conta mostraram o saldo do
  -- outro perfil.
  CREATE TABLE IF NOT EXISTS cache (
    tenant_id  TEXT NOT NULL,
    chave      TEXT NOT NULL,
    conteudo   TEXT NOT NULL,
    guardado_em INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, chave)
  );
`

let banco: SQLite.SQLiteDatabase | null = null

export async function abrir(): Promise<SQLite.SQLiteDatabase> {
  if (banco) return banco
  banco = await SQLite.openDatabaseAsync('mavia.db')
  await banco.execAsync(ESQUEMA)
  return banco
}

// ---------------------------------------------------------------------------
// Fila
// ---------------------------------------------------------------------------

export async function enfileirar(m: Mutacao): Promise<void> {
  const db = await abrir()
  await db.runAsync(
    `INSERT OR REPLACE INTO fila
       (id, metodo, caminho, corpo, tenant_id, criada_em, tentativas, estado, motivo, tentar_apos)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      m.id,
      m.metodo,
      m.caminho,
      JSON.stringify(m.corpo),
      m.tenantId,
      m.criadaEm,
      m.tentativas,
      m.estado,
      m.motivo ?? null,
      m.tentarApos,
    ],
  )
}

export async function lerFila(): Promise<Mutacao[]> {
  const db = await abrir()
  const linhas = await db.getAllAsync<{
    id: string
    metodo: string
    caminho: string
    corpo: string
    tenant_id: string
    criada_em: number
    tentativas: number
    estado: string
    motivo: string | null
    tentar_apos: number
  }>('SELECT * FROM fila ORDER BY criada_em')

  return linhas.map((l) => ({
    id: l.id,
    metodo: l.metodo as Mutacao['metodo'],
    caminho: l.caminho,
    corpo: JSON.parse(l.corpo) as unknown,
    tenantId: l.tenant_id,
    criadaEm: l.criada_em,
    tentativas: l.tentativas,
    estado: l.estado as Mutacao['estado'],
    ...(l.motivo === null ? {} : { motivo: l.motivo }),
    tentarApos: l.tentar_apos,
  }))
}

export async function retirar(id: string): Promise<void> {
  const db = await abrir()
  await db.runAsync('DELETE FROM fila WHERE id = ?', [id])
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export async function guardar(tenantId: string, chave: string, conteudo: unknown): Promise<void> {
  const db = await abrir()
  await db.runAsync(
    `INSERT OR REPLACE INTO cache (tenant_id, chave, conteudo, guardado_em) VALUES (?,?,?,?)`,
    [tenantId, chave, JSON.stringify(conteudo), Date.now()],
  )
}

/**
 * Lê do cache **sem prazo de validade**.
 *
 * Um dado velho é melhor do que uma tela vazia: quem está no metrô quer ver o
 * próprio saldo, mesmo que seja o de ontem. A tela é que diz "atualizado há
 * tanto tempo" — esconder o número seria proteger a pessoa de uma informação
 * que ela mesma produziu.
 */
export async function lerCache<T>(
  tenantId: string,
  chave: string,
): Promise<{ conteudo: T; guardadoEm: number } | null> {
  const db = await abrir()
  const l = await db.getFirstAsync<{ conteudo: string; guardado_em: number }>(
    'SELECT conteudo, guardado_em FROM cache WHERE tenant_id = ? AND chave = ?',
    [tenantId, chave],
  )
  if (!l) return null
  return { conteudo: JSON.parse(l.conteudo) as T, guardadoEm: l.guardado_em }
}

/**
 * Apaga tudo o que é do usuário: chamado ao sair.
 *
 * A fila vai junto, e a decisão é dura mas é a certa: sair é dizer "este
 * dispositivo não é mais meu". Deixar intenções não enviadas ali seria deixar o
 * dinheiro de alguém num aparelho que ela acabou de entregar.
 */
export async function limparTudo(): Promise<void> {
  const db = await abrir()
  await db.execAsync('DELETE FROM fila; DELETE FROM cache;')
}
