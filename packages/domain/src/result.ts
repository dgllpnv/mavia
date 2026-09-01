/**
 * Erro é valor no domínio; exceção só na borda.
 *
 * `packages/domain` nunca lança para sinalizar falha de negócio — devolve
 * `Result`, e a camada HTTP traduz para status. Ver `CLAUDE.md` §6.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly valor: T }
  | { readonly ok: false; readonly erro: E }

export function ok<T>(valor: T): Result<T, never> {
  return { ok: true, valor }
}

export function falha<E>(erro: E): Result<never, E> {
  return { ok: false, erro }
}
