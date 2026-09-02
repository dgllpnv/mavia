import type { Categoria, Conta } from '@mavia/contracts'
import { corDaCategoria } from '@mavia/ui'

/**
 * Identificador → nome, para as colunas do extrato.
 *
 * O servidor devolve o vínculo por identificador, e não o nome desnormalizado
 * em cada linha, porque o nome muda: renomear "Mercado" para "Supermercado"
 * tem de renomear em todo lugar, e uma cópia por lançamento renomearia só as
 * linhas futuras. A junção acontece no cliente, uma vez por página, sobre uma
 * árvore que já está em cache.
 */

export interface Dicionarios {
  nomeDaCategoria(id: string | null): string
  corDaCategoriaPorId(id: string | null): string | null
  nomeDaConta(id: string | null): string
}

export function montarDicionarios(
  categorias: readonly Categoria[],
  contas: readonly Conta[],
): Dicionarios {
  const porCategoria = new Map(categorias.map((c) => [c.id, c]))
  const porConta = new Map(contas.map((c) => [c.id, c.nome]))

  return {
    nomeDaCategoria(id) {
      if (!id) return '—'
      const c = porCategoria.get(id)
      if (!c) return '—'
      // Filha mostra "Mãe · Filha": "Aluguel" sozinho não diz se é despesa de
      // Moradia ou de Escritório, e a coluna tem largura para os dois.
      const mae = c.parentId ? porCategoria.get(c.parentId) : undefined
      return mae ? `${mae.nome} · ${c.nome}` : c.nome
    },
    corDaCategoriaPorId(id) {
      if (!id) return null
      const c = porCategoria.get(id)
      if (!c) return null
      // A cor é da **raiz**: as filhas de Alimentação compartilham a cor de
      // Alimentação, senão o relatório vira seis tons sem parentesco visível.
      return corDaCategoria(c.parentId ?? c.id)
    },
    nomeDaConta(id) {
      if (!id) return 'cartão'
      return porConta.get(id) ?? '—'
    },
  }
}
