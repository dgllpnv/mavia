'use client'

import type { NivelDeAdmin } from '@mavia/contracts'
import { useQuery } from '@tanstack/react-query'
import { painel } from './api'

/**
 * O meu nível no painel, lido uma vez e compartilhado.
 *
 * Uma chave só (`['painel', 'eu']`) para o cromo e para a tela de operadores:
 * as duas perguntam a mesma coisa, e sem o cache compartilhado o TanStack faria
 * duas requisições para responder à mesma pergunta em cada navegação.
 *
 * **Não é controle de acesso.** A função no banco exige `super` de qualquer
 * jeito, e a policy `concessao_propria` da migration `0031` garante que esta
 * leitura só fala de quem pergunta. O que ela decide é se a interface **mostra**
 * um caminho — e mostrar um botão que sempre recusa é uma interface que mente.
 */
export function useNivel(
  /**
   * Falso enquanto não há sessão. Sem isto, o cromo do painel consultaria
   * `/admin/eu` na tela de quem ainda vai ser redirecionado para a entrada — um
   * 401, uma tentativa de renovação e um erro no console antes de a página
   * existir.
   */
  habilitado = true,
): { readonly nivel: NivelDeAdmin | null; readonly carregando: boolean } {
  const eu = useQuery({
    queryKey: ['painel', 'eu'],
    queryFn: () => painel.eu(),
    enabled: habilitado,
    // O nível muda por um ato deliberado de outra pessoa, e não sozinho. Cinco
    // minutos evita uma requisição por navegação sem esconder uma revogação por
    // muito tempo — e, revogado, o próximo ato recebe a recusa do banco.
    staleTime: 5 * 60_000,
  })

  return { nivel: eu.data?.nivel ?? null, carregando: eu.isPending }
}
