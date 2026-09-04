import {
  zBaixaRegistrada,
  zClienteCadastrado,
  zListaDeBaixas,
  zListaDeClientes,
  zListaDeContasDoCliente,
  zListaDeLancamentosDoCliente,
  zListaDePerfis,
  zListaDoRegistro,
  zTempoConcedido,
  type BaixaAnterior,
  type ClienteNaLista,
  type ContaDoCliente,
  type LancamentoDoCliente,
  type LinhaDoRegistro,
  type MeioDePagamento,
  type PerfilDoCliente,
} from '@mavia/contracts'
import { chamar } from '../api/cliente'
import { cabecalhosDaHipotese, type Hipotese } from './hipotese'

/**
 * As chamadas do painel — separadas das do produto, de propósito.
 *
 * O painel **não fala com nenhuma rota do cliente**, e o produto não fala com
 * nenhuma rota de `/v1/admin`. Manter os dois conjuntos em arquivos distintos é
 * o que torna essa propriedade visível numa busca, em vez de depender da
 * disciplina de quem escrever a próxima tela.
 *
 * ## Toda resposta é analisada por um schema de `@mavia/contracts`
 *
 * As rotas do painel devolvem a linha do Postgres crua — a projeção fixa das
 * funções de `admin` é o que impede `ip_hash` e `user_agent_hash` de vazarem, e
 * remapear cada linha na camada HTTP reintroduziria a lista que alguém precisa
 * lembrar de manter. Analisar na borda troca "a tela ficou em branco e o console
 * mostra `undefined`" por uma mensagem que nomeia o campo que mudou de formato.
 *
 * ## O que este módulo não tem
 *
 * Não há chamada para trocar plano ou intervalo — DP-40: *"a rota não existe.
 * Não é 403 nem 404 de controle: é ação que este épico não tem."* Nem para
 * editar preço ou cota: preço, cota e desconto vivem no catálogo em código,
 * nunca em tabela. Nem caminho para as telas `⊙` do cliente (alertas,
 * preferências, sessões) — a §1.7 as declara **não visíveis** pelo painel, e a
 * ausência de rota é a forma dessa decisão.
 */

/**
 * O contrato estrutural de um schema de `@mavia/contracts`.
 *
 * `apps/web` **não depende de `zod`**, e essa ausência é o que impede uma tela
 * de escrever validação própria. O tipo abaixo descreve só o que este módulo
 * usa de um schema, e qualquer `ZodType` o satisfaz.
 */
interface Esquema<T> {
  safeParse(
    bruto: unknown,
  ):
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: { readonly issues: readonly { readonly message: string }[] } }
}

/**
 * Uma resposta que não bate com o contrato.
 *
 * Erro próprio, e não `ErroDaApi`: o servidor respondeu 200 e o problema é de
 * formato. Confundir os dois faria a tela dizer "não foi possível concluir"
 * sobre uma requisição que concluiu.
 */
export class RespostaInesperada extends Error {
  constructor(rota: string, detalhe: string) {
    super(`A resposta de ${rota} não tem o formato esperado: ${detalhe}`)
    this.name = 'RespostaInesperada'
  }
}

function analisar<T>(rota: string, esquema: Esquema<T>, bruto: unknown): T {
  const analise = esquema.safeParse(bruto)
  if (!analise.success) {
    throw new RespostaInesperada(rota, analise.error.issues[0]?.message ?? 'campo desconhecido')
  }
  return analise.data
}

/** As leituras do espaço de um cliente. Todas carregam a hipótese. */
function comHipotese(h: Hipotese) {
  return { cabecalhos: cabecalhosDaHipotese(h) } as const
}

export const painel = {
  /**
   * A busca.
   *
   * **Não abre o espaço de ninguém** — é a única leitura do painel que não pede
   * hipótese, porque ela não entra em espaço nenhum: devolve nome, titular,
   * plano e estado, que é o mínimo para achar o cliente sobre o qual a hipótese
   * vai ser declarada. A busca em si é registrada, com o termo hasheado e a
   * contagem.
   */
  async clientes(termo: string, limite = 50): Promise<ClienteNaLista[]> {
    const busca = new URLSearchParams({ limite: String(limite) })
    if (termo.trim()) busca.set('q', termo.trim())
    const rota = `/admin/clientes?${busca.toString()}`
    return analisar('/admin/clientes', zListaDeClientes, await chamar<unknown>(rota)).itens
  },

  /**
   * O perfil — e é aqui que `fim_efetivo` e `periodo_fim` chegam juntos.
   *
   * A rota devolve `{ itens: [...] }` com no máximo uma linha; um identificador
   * que não existe devolve lista vazia, e a tela distingue isso de erro.
   */
  async perfil(tenantId: string, h: Hipotese): Promise<PerfilDoCliente | null> {
    const r = analisar(
      '/admin/clientes/:tenantId',
      zListaDePerfis,
      await chamar<unknown>(`/admin/clientes/${tenantId}`, comHipotese(h)),
    )
    return r.itens[0] ?? null
  },

  async contas(tenantId: string, h: Hipotese): Promise<ContaDoCliente[]> {
    return analisar(
      '/admin/clientes/:tenantId/contas',
      zListaDeContasDoCliente,
      await chamar<unknown>(`/admin/clientes/${tenantId}/contas`, comHipotese(h)),
    ).itens
  },

  async lancamentos(tenantId: string, h: Hipotese): Promise<LancamentoDoCliente[]> {
    return analisar(
      '/admin/clientes/:tenantId/lancamentos',
      zListaDeLancamentosDoCliente,
      await chamar<unknown>(`/admin/clientes/${tenantId}/lancamentos`, comHipotese(h)),
    ).itens
  },

  async pagamentos(tenantId: string, h: Hipotese): Promise<BaixaAnterior[]> {
    return analisar(
      '/admin/clientes/:tenantId/pagamentos',
      zListaDeBaixas,
      await chamar<unknown>(`/admin/clientes/${tenantId}/pagamentos`, comHipotese(h)),
    ).itens
  },

  async registro(filtro: {
    desde?: string
    tenantId?: string
    limite?: number
  }): Promise<LinhaDoRegistro[]> {
    const busca = new URLSearchParams({ limite: String(filtro.limite ?? 100) })
    if (filtro.desde) busca.set('desde', filtro.desde)
    if (filtro.tenantId) busca.set('tenantId', filtro.tenantId)
    return analisar(
      '/admin/registro',
      zListaDoRegistro,
      await chamar<unknown>(`/admin/registro?${busca.toString()}`),
    ).itens
  },

  /**
   * A baixa. `valorCentavos` vai como **string de dígitos positivos** — a regra
   * 1 atravessa a rede inteira, e em nenhum ponto do caminho há um `number`.
   */
  async darBaixa(
    tenantId: string,
    h: Hipotese,
    corpo: {
      valorCentavos: string
      meio: MeioDePagamento
      referenciaExterna: string
      recebidoEm: string
      observacao?: string
    },
  ) {
    return analisar(
      '/admin/clientes/:tenantId/pagamentos',
      zBaixaRegistrada,
      await chamar<unknown>(`/admin/clientes/${tenantId}/pagamentos`, {
        metodo: 'POST',
        corpo,
        ...comHipotese(h),
      }),
    )
  },

  async concederCortesia(tenantId: string, h: Hipotese, dias: number, razao: string) {
    return analisar(
      '/admin/clientes/:tenantId/cortesia',
      zTempoConcedido,
      await chamar<unknown>(`/admin/clientes/${tenantId}/cortesia`, {
        metodo: 'POST',
        corpo: { dias, razao },
        ...comHipotese(h),
      }),
    )
  },

  async prorrogarTeste(tenantId: string, h: Hipotese, dias: number, razao: string) {
    return analisar(
      '/admin/clientes/:tenantId/teste/prorrogar',
      zTempoConcedido,
      await chamar<unknown>(`/admin/clientes/${tenantId}/teste/prorrogar`, {
        metodo: 'POST',
        corpo: { dias, razao },
        ...comHipotese(h),
      }),
    )
  },

  /**
   * O cadastro. `titularId` e **não** e-mail e senha: a função não cria
   * identidade — ela vincula alguém que já tem conta. Um operador criando login
   * para terceiro é um operador que conhece a senha de um cliente.
   */
  async cadastrar(h: Hipotese, titularId: string, nome: string) {
    return analisar(
      '/admin/clientes',
      zClienteCadastrado,
      await chamar<unknown>('/admin/clientes', {
        metodo: 'POST',
        corpo: { titularId, nome },
        ...comHipotese(h),
      }),
    )
  },
}
