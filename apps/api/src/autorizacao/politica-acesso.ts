/**
 * A matriz de acesso, em código.
 *
 * Fonte: `docs/seguranca/matriz-de-acesso.md`. O gate de risco reprovou o spec
 * justamente porque essa matriz não existia em documento nenhum, e uma função
 * `pode()` nasceria vazia sobre cerca de noventa rotas.
 *
 * Duas propriedades, e as duas importam mais que a tabela:
 *
 * 1. **Nega por padrão.** Rota sem entrada na matriz é rota negada. Esquecer
 *    de declarar não vira porta aberta.
 * 2. **Falha no boot, não em runtime.** Uma rota registrada sem entrada na
 *    matriz derruba a aplicação na inicialização. O erro aparece no deploy,
 *    não no dia em que alguém a acessa.
 */

export type Papel = 'proprietario' | 'membro' | 'visualizador'

export interface Rota {
  readonly metodo: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  readonly caminho: string
}

export interface RegraDeAcesso {
  readonly papeis: readonly Papel[]
  /** Operação que move dinheiro para fora ou muda o acesso exige reautenticação. */
  readonly exigeReautenticacao?: true
}

const TODOS: readonly Papel[] = ['proprietario', 'membro', 'visualizador']
const QUEM_ESCREVE: readonly Papel[] = ['proprietario', 'membro']
const SO_DONO: readonly Papel[] = ['proprietario']

/**
 * A chave é `MÉTODO caminho`, com o caminho no formato do roteador.
 * Acrescentar rota sem acrescentar aqui **derruba o boot** — de propósito.
 */
export const MATRIZ: ReadonlyMap<string, RegraDeAcesso> = new Map<string, RegraDeAcesso>([
  ['GET /v1/contas', { papeis: TODOS }],
  ['POST /v1/contas', { papeis: QUEM_ESCREVE }],
  ['GET /v1/contas/:id', { papeis: TODOS }],
  ['PATCH /v1/contas/:id', { papeis: QUEM_ESCREVE }],
  // Excluir conta é do proprietário: some com o histórico da vista de todo o
  // espaço, e `membro` não decide isso pelos outros.
  ['DELETE /v1/contas/:id', { papeis: SO_DONO }],

  ['GET /v1/lancamentos', { papeis: TODOS }],
  ['GET /v1/lancamentos/resumo', { papeis: TODOS }],
  ['GET /v1/lancamentos/:id', { papeis: TODOS }],
  ['POST /v1/lancamentos', { papeis: QUEM_ESCREVE }],
  ['POST /v1/lancamentos/transferencias', { papeis: QUEM_ESCREVE }],
  // Estornar é operação de escrita comum: desfaz sem apagar, e fica no log.
  // Ver a decisão DP-4 — o dado é do espaço, e a correção é rastreável.
  ['POST /v1/lancamentos/:id/estornos', { papeis: QUEM_ESCREVE }],
])

export function chaveDaRota(rota: Rota): string {
  return `${rota.metodo} ${rota.caminho}`
}

export function pode(rota: Rota, papel: Papel): boolean {
  const regra = MATRIZ.get(chaveDaRota(rota))
  // Ausência é negação. Nunca `?? { papeis: TODOS }`.
  if (regra === undefined) return false
  return regra.papeis.includes(papel)
}

export function exigeReautenticacao(rota: Rota): boolean {
  return MATRIZ.get(chaveDaRota(rota))?.exigeReautenticacao === true
}

export class RotaSemRegra extends Error {
  constructor(faltantes: readonly string[]) {
    super(
      `Rotas registradas sem entrada na matriz de acesso: ${faltantes.join(', ')}. ` +
        'A aplicação não sobe. Declare a regra em politica-acesso.ts — negar por ' +
        'omissão protege, mas silenciar a omissão esconde o buraco.',
    )
    this.name = 'RotaSemRegra'
  }
}

/**
 * Chamado na inicialização com as rotas que o roteador realmente registrou.
 * É o que transforma "negado por padrão" em "impossível esquecer".
 */
export function verificarCoberturaDaMatriz(rotasRegistradas: readonly Rota[]): void {
  const faltantes = rotasRegistradas
    .map(chaveDaRota)
    .filter((chave) => !MATRIZ.has(chave))
  if (faltantes.length > 0) throw new RotaSemRegra(faltantes)
}
