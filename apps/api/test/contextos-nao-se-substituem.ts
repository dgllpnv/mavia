/**
 * O teste dos contextos marcados — e ele **não roda**.
 *
 * Este arquivo é verificado por `tsc --noEmit`, no `pnpm typecheck`. Cada
 * `@ts-expect-error` abaixo falha o build **se o erro deixar de acontecer** —
 * isto é, se alguém remover uma marca e os contextos voltarem a ser
 * intercambiáveis por estrutura.
 *
 * ## Por que aqui, e não num `.test.ts`
 *
 * Propriedade de tipo não é observável em tempo de execução: a marca é apagada
 * na compilação. Um teste de integração contra Postgres provaria que a rota de
 * hoje usa o contexto certo — e não provaria nada sobre a que alguém escrever
 * amanhã. O ticket 01 classificava estas asserções como "integração"; é o nível
 * errado, e a correção está registrada nos comentários dele.
 *
 * ## O que a marca é, e o que ela não é
 *
 * Ela **não** é trava de segurança: `as unknown as ContextoDoTenant` compila, e
 * o `CLAUDE.md` §6 permite `as` com justificativa. Quem impede o vazamento é a
 * topologia — pool próprio, papel próprio, sem parentesco com `mavia_app`,
 * provado em `papeis-do-painel.test.ts`.
 *
 * A marca impede o **engano**; o privilégio impede o **ato**. Este arquivo
 * cobre o primeiro, e é honesto sobre isso.
 */
import {
  comAdmin,
  comTenant,
  comTenantDeAdmin,
  comTenantDeAdminEscrita,
  comUsuario,
  contextoDeAdmin,
  contextoDeAdminEscrita,
  contextoDeOperador,
  contextoDeUsuario,
  contextoDoTenant,
} from '../src/tenancy/tenancy.js'
import type { Pool } from 'pg'

declare const pool: Pool
declare const nada: (c: unknown) => Promise<void>

const doTenant = contextoDoTenant('u', 't')
const deUsuario = contextoDeUsuario('u')
const deOperador = contextoDeOperador('u')
const deAdmin = contextoDeAdmin('u', 't')
const deAdminEscrita = contextoDeAdminEscrita('u', 't')

// ---------------------------------------------------------------------------
// O caminho feliz continua compilando. Sem isto, um erro de digitação nas
// asserções abaixo passaria por "trava funcionando".
// ---------------------------------------------------------------------------
void comTenant(pool, doTenant, nada)
void comUsuario(pool, deUsuario, nada)
void comAdmin(pool, deOperador, nada)
void comTenantDeAdmin(pool, deAdmin, nada)
void comTenantDeAdminEscrita(pool, deAdminEscrita, nada)

// ---------------------------------------------------------------------------
// **O objeto literal não serve.** É o que obriga toda construção a passar por
// uma fábrica — e a fábrica é onde o `as` mora, uma vez, sob comentário.
// ---------------------------------------------------------------------------
// @ts-expect-error literal não é `ContextoDoTenant`
void comTenant(pool, { usuarioId: 'u', tenantId: 't' }, nada)

// @ts-expect-error literal não é `ContextoDeUsuario`
void comUsuario(pool, { usuarioId: 'u' }, nada)

// ---------------------------------------------------------------------------
// **O contexto de administração não entra no caminho do cliente.**
//
// Esta é a asserção que carrega o épico. Sem a marca, `deAdmin` tem a forma de
// `ContextoDoTenant` e o compilador aceita: a rota do painel rodaria como
// `mavia_app`, com DML completo sobre o razão do cliente cujo `app.tenant_id`
// ela acabou de assumir. É o defeito que a v2 do spec não impedia.
// ---------------------------------------------------------------------------
// @ts-expect-error contexto de administração jamais vai a `comTenant`
void comTenant(pool, deAdmin, nada)

// @ts-expect-error nem o de escrita
void comTenant(pool, deAdminEscrita, nada)

// ---------------------------------------------------------------------------
// **E o caminho do cliente não entra no do painel.** A simetria importa: sem
// ela, uma rota de cliente poderia abrir uma transação no pool do painel, e o
// `SET LOCAL ROLE` só reclamaria em tempo de execução.
// ---------------------------------------------------------------------------
// @ts-expect-error contexto de cliente não abre espaço como administrador
void comTenantDeAdmin(pool, doTenant, nada)

// @ts-expect-error nem o de usuário sem espaço
void comAdmin(pool, deUsuario, nada)

// ---------------------------------------------------------------------------
// **Leitura e escrita de administração são marcas distintas**, e este é o par
// que o ticket 01 chamou de decisivo: se compartilhassem a marca, o caminho de
// leitura habilitaria uma escrita em compilação, e o `permission denied` só
// apareceria em tempo de execução — na madrugada, no meio de um atendimento.
// ---------------------------------------------------------------------------
// @ts-expect-error abrir para ler não autoriza escrever
void comTenantDeAdminEscrita(pool, deAdmin, nada)

// @ts-expect-error e abrir para escrever não é o contexto de leitura
void comTenantDeAdmin(pool, deAdminEscrita, nada)

// ---------------------------------------------------------------------------
// O operador sem espaço não tem espaço. É o que impede a listagem de virar,
// por descuido, uma leitura dentro de um tenant.
// ---------------------------------------------------------------------------
// @ts-expect-error `comAdmin` não recebe contexto com tenant
void comAdmin(pool, deAdmin, nada)
