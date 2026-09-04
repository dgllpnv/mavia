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

  ['GET /v1/planejamentos', { papeis: TODOS }],
  ['POST /v1/planejamentos', { papeis: QUEM_ESCREVE }],
  ['PATCH /v1/planejamentos/:id', { papeis: QUEM_ESCREVE }],
  // Excluir um planejamento não apaga dinheiro nenhum: o que se perde é a
  // referência do mês. Por isso é de quem escreve, e não só do dono.
  ['DELETE /v1/planejamentos/:id', { papeis: QUEM_ESCREVE }],
  // Copiar não destrói nada: só cria o que falta no destino.
  ['POST /v1/planejamentos/copiar', { papeis: QUEM_ESCREVE }],

  ['GET /v1/objetivos', { papeis: TODOS }],
  ['POST /v1/objetivos', { papeis: QUEM_ESCREVE }],
  ['PATCH /v1/objetivos/:id', { papeis: QUEM_ESCREVE }],
  // Excluir um objetivo é de quem escreve, e não só do dono: ao contrário da
  // Conta, ele não guarda dinheiro — os lançamentos ficam intactos, e o que se
  // perde é o acompanhamento.
  ['DELETE /v1/objetivos/:id', { papeis: QUEM_ESCREVE }],
  // Vincular aporte não altera o lançamento, só o vínculo.
  ['POST /v1/objetivos/:id/aportes', { papeis: QUEM_ESCREVE }],
  ['DELETE /v1/objetivos/:id/aportes/:lancamentoId', { papeis: QUEM_ESCREVE }],

  ['GET /v1/recorrencias', { papeis: TODOS }],
  ['POST /v1/recorrencias', { papeis: QUEM_ESCREVE }],
  ['PATCH /v1/recorrencias/:id', { papeis: QUEM_ESCREVE }],
  ['DELETE /v1/recorrencias/:id', { papeis: QUEM_ESCREVE }],
  // Materializar não decide nada: só realiza o que a regra já dizia, e é
  // idempotente pela identidade da ocorrência.
  ['POST /v1/recorrencias/materializar', { papeis: QUEM_ESCREVE }],

  ['GET /v1/conexoes', { papeis: TODOS }],
  ['POST /v1/conexoes', { papeis: QUEM_ESCREVE }],
  // Revogar é encerrar o acesso de um terceiro aos dados de **todo** o espaço,
  // e destruir a credencial de forma irreversível. É do dono, e exige
  // reautenticação pelo mesmo motivo que trocar o papel de um membro exige:
  // uma sessão roubada não decide isso sozinha.
  ['DELETE /v1/conexoes/:id', { papeis: SO_DONO, exigeReautenticacao: true }],

  ['GET /v1/importacoes', { papeis: TODOS }],
  // Importar cria lançamento; desfazer apaga o que ela criou. As duas são de
  // quem escreve, e nenhuma é só do dono: importar extrato é rotina de membro.
  ['POST /v1/importacoes', { papeis: QUEM_ESCREVE }],
  ['POST /v1/importacoes/:id/desfazer', { papeis: QUEM_ESCREVE }],

  ['GET /v1/conciliacoes', { papeis: TODOS }],
  // Decidir uma conciliação é decidir sobre o registro de outra pessoa do
  // espaço. Continua sendo escrita, e não exclusividade do dono: o veto de
  // "jamais apagar o registro do usuário sozinho" já é do sistema, não do papel.
  ['POST /v1/conciliacoes/:id/confirmar', { papeis: QUEM_ESCREVE }],
  ['POST /v1/conciliacoes/:id/descartar', { papeis: QUEM_ESCREVE }],

  ['GET /v1/regras', { papeis: TODOS }],
  ['POST /v1/regras', { papeis: QUEM_ESCREVE }],
  ['DELETE /v1/regras/:id', { papeis: QUEM_ESCREVE }],
  // Aplicar não decide nada de novo: realiza o que as regras já diziam, e só
  // sobre o que ainda não foi classificado por um humano.
  ['POST /v1/regras/aplicar', { papeis: QUEM_ESCREVE }],

  // Alterar um lançamento faltava por completo: a importação criava linhas em
  // `A classificar` e não havia caminho nenhum para movê-las.
  ['PATCH /v1/lancamentos/:id', { papeis: QUEM_ESCREVE }],

  ['GET /v1/relatorios/por-categoria', { papeis: TODOS }],
  ['GET /v1/relatorios/evolucao', { papeis: TODOS }],
  ['GET /v1/relatorios/comparacao', { papeis: TODOS }],

  // Exportar é o direito de portabilidade da LGPD, e ele é **do titular**.
  // Um visualizador convidado não leva o espaço inteiro embora num arquivo.
  ['GET /v1/exportacao', { papeis: SO_DONO }],

  // Matriz §2.3: nome e papel são de todos; o e-mail dos outros, só do dono —
  // e essa parte é projeção, não rota.
  ['GET /v1/membros', { papeis: TODOS }],
  ['POST /v1/membros/convites', { papeis: SO_DONO }],
  ['GET /v1/membros/convites', { papeis: SO_DONO }],
  ['DELETE /v1/membros/convites/:id', { papeis: SO_DONO }],
  // Escalada de privilégio (R-4). A matriz é a trava 1; as outras três estão
  // no controlador e no banco.
  ['PATCH /v1/membros/:usuarioId', { papeis: SO_DONO, exigeReautenticacao: true }],
  // **`TODOS`, e não `SO_DONO`**: a matriz dá a membro e visualizador o direito
  // de saírem do espaço. Quem sai é só a si mesmo, e essa distinção é do
  // controlador — a matriz não tem como expressar "só sobre o próprio id".
  ['DELETE /v1/membros/:usuarioId', { papeis: TODOS }],

  // **`TODOS` para ler.** Um membro que esbarra numa cota precisa entender por
  // que o botão recusou, e a mensagem nomeia a cota e a contagem. O que ele
  // nunca vê é preço pago, meio de pagamento e documento fiscal — e nenhum dos
  // três está na resposta.
  ['GET /v1/cobranca', { papeis: TODOS }],
  // Trocar de plano é `billing`, e billing é do dono (matriz §2.3).
  ['POST /v1/cobranca/plano', { papeis: SO_DONO }],

  ['GET /v1/alertas', { papeis: TODOS }],

  ['GET /v1/categorias', { papeis: TODOS }],
  ['POST /v1/categorias', { papeis: QUEM_ESCREVE }],
  ['PATCH /v1/categorias/:id', { papeis: QUEM_ESCREVE }],
  // Arquivar é de quem escreve, e não só do dono: não apaga nada, e a categoria
  // continua dando nome ao histórico. Reverter é reabrir.
  ['DELETE /v1/categorias/:id', { papeis: QUEM_ESCREVE }],

  ['GET /v1/lancamentos', { papeis: TODOS }],
  ['GET /v1/lancamentos/resumo', { papeis: TODOS }],
  ['GET /v1/lancamentos/:id', { papeis: TODOS }],
  ['POST /v1/lancamentos', { papeis: QUEM_ESCREVE }],
  ['POST /v1/lancamentos/transferencias', { papeis: QUEM_ESCREVE }],
  // Estornar é operação de escrita comum: desfaz sem apagar, e fica no log.
  // Ver a decisão DP-4 — o dado é do espaço, e a correção é rastreável.
  ['POST /v1/lancamentos/:id/estornos', { papeis: QUEM_ESCREVE }],

  ['GET /v1/cartoes', { papeis: TODOS }],
  ['POST /v1/cartoes', { papeis: QUEM_ESCREVE }],
  ['GET /v1/cartoes/:id/faturas', { papeis: TODOS }],
  ['POST /v1/cartoes/:id/faturas', { papeis: QUEM_ESCREVE }],
  ['POST /v1/cartoes/:id/compras', { papeis: QUEM_ESCREVE }],
  // Fechar trava o total que o usuário vai pagar, e não tem desfazer simples.
  ['POST /v1/cartoes/faturas/:faturaId/fechar', { papeis: QUEM_ESCREVE }],
  // Pagar move dinheiro para fora da conta.
  ['POST /v1/cartoes/faturas/:faturaId/pagamentos', { papeis: QUEM_ESCREVE }],
])

/**
 * Rotas que **não** são de um espaço.
 *
 * Papel é propriedade do vínculo com um tenant; perguntar "seu papel permite?"
 * numa rota sem tenant não tem resposta. Por isso elas não entram na matriz —
 * entram aqui, numa lista fechada e curta que se lê de uma vez.
 *
 * `POST /v1/sessoes` é a única pública: é a rota pela qual a sessão nasce.
 * As outras duas exigem sessão, e o `SessaoGuard` cuida disso.
 */
export const ROTAS_SEM_TENANT: ReadonlySet<string> = new Set([
  'POST /v1/sessoes',
  // Quem aceita o convite ainda não pertence ao espaço: exigir o cabeçalho
  // seria pedir a resposta como pergunta. Quem escolhe o espaço é o token.
  'POST /v1/convites/aceitar',
  'POST /v1/cobranca/webhook',
  // Renovar é pública **pela sessão**: quem chega aqui é justamente quem já não
  // tem access token válido. A credencial que ela exige é o refresh, e a
  // própria rota o valida.
  'POST /v1/sessoes/renovar',
  'GET /v1/eu',
  'DELETE /v1/sessoes/atual',
  'POST /v1/sessoes/revogar-outras',
  // O cadastro e a recuperação acontecem **antes** de existir espaço. Quem
  // confirma o cadastro ganha o espaço na mesma transação; quem redefine a
  // senha pode ter três espaços ou nenhum, e a rota não precisa saber qual.
  'POST /v1/cadastro',
  'POST /v1/cadastro/confirmar',
  'POST /v1/senha/recuperar',
  'POST /v1/senha/redefinir',
  // A entrada pelo Google. Quem começa não tem sessão, e quem volta ainda
  // não tem: o espaço só é escolhido depois de a identidade existir.
  'POST /v1/auth/google',
  'POST /v1/auth/google/retorno',
])

/** Dispensa até a sessão. Uma entrada a mais aqui é uma porta a mais. */
export const ROTAS_PUBLICAS: ReadonlySet<string> = new Set([
  'POST /v1/sessoes',
  'POST /v1/sessoes/renovar',
  // A Stripe não tem conta na Mavia. A autenticação dela é o HMAC do corpo,
  // verificado em tempo constante na própria rota — sem segredo configurado,
  // nenhuma assinatura confere, e a rota recusa tudo.
  'POST /v1/cobranca/webhook',
  // As quatro rotas de credencial. Quem cadastra não tem conta; quem recupera
  // não tem senha. Exigir sessão em qualquer uma delas seria exigir o que elas
  // existem para produzir.
  //
  // A defesa aqui não é sessão: é o contador por endereço e por origem — o
  // mesmo do login —, a resposta idêntica para endereço existente e
  // inexistente, e o token de 256 bits com prazo e uso único.
  'POST /v1/cadastro',
  'POST /v1/cadastro/confirmar',
  'POST /v1/senha/recuperar',
  'POST /v1/senha/redefinir',
  // A credencial destas duas é o `state` de uso único e o `id_token`
  // assinado pelo Google, verificados na própria rota. Sessão aqui seria
  // exigir o que elas existem para produzir.
  'POST /v1/auth/google',
  'POST /v1/auth/google/retorno',
])

/**
 * As rotas do painel de administração — ADR 0024 D1 e D2.
 *
 * **Conjunto de chaves exatas, como as duas irmãs acima**, e não um prefixo.
 * A tentação de escrever `caminho.startsWith('/v1/admin/')` é real e é o
 * caminho pelo qual a próxima rota entra sem ninguém decidir. Aqui, uma rota
 * nova exige uma linha nova — e essa linha é onde alguém para e pensa.
 *
 * O literal do prefixo aparece **uma vez**, na asserção de boot, que confere as
 * duas direções: toda rota sob `/v1/admin/` está nesta lista, e nenhuma chave
 * desta lista aponta para fora do prefixo.
 *
 * O que esta lista dispensa: a matriz de papéis, porque o operador não tem
 * papel no espaço do cliente. O que ela **não** dispensa: a sessão. E o que ela
 * garante: `req.autenticado` permanece **nulo** nestas rotas, o que impede os
 * controladores do cliente de servi-las.
 *
 * Nasce vazia. Cada ticket de rota acrescenta a sua.
 */
export const ROTAS_DE_ADMIN: ReadonlySet<string> = new Set([])

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
    // Uma rota está coberta se tem papel declarado, OU é declaradamente sem
    // espaço, OU é do painel de administração. As três listas juntas são a
    // política inteira; nenhuma rota pode faltar nas três.
    .filter(
      (chave) => !MATRIZ.has(chave) && !ROTAS_SEM_TENANT.has(chave) && !ROTAS_DE_ADMIN.has(chave),
    )
  if (faltantes.length > 0) throw new RotaSemRegra(faltantes)

  // O prefixo, nas duas direções, e o literal aparece **só aqui**.
  //
  // Ida: uma rota registrada sob `/v1/admin/` que ninguém pôs na lista cairia
  // no ramo padrão do guard, que exige `req.autenticado` — e como o caminho de
  // admin nunca o produz, ela responderia 401 para sempre, sem que ninguém
  // entendesse por quê.
  //
  // Volta: uma chave na lista apontando para fora do prefixo dispensaria da
  // matriz uma rota comum, que é o buraco na direção perigosa.
  const semDeclaracao = rotasRegistradas
    .map(chaveDaRota)
    .filter((chave) => chave.includes(' /v1/admin/') && !ROTAS_DE_ADMIN.has(chave))
  if (semDeclaracao.length > 0) throw new RotaSemRegra(semDeclaracao)

  const foraDoPrefixo = [...ROTAS_DE_ADMIN].filter((chave) => !chave.includes(' /v1/admin/'))
  if (foraDoPrefixo.length > 0) throw new RotaSemRegra(foraDoPrefixo)
}
