'use client'

import { useQuery } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { Valor } from '../../../../../componentes/valor'
import { painel } from '../../../../../painel/api'
import { usePainel } from '../../../../../painel/contexto'
import { CabecalhoDeLeitura, Estado, Instante } from '../../../../../painel/pecas'

/**
 * Os lançamentos do cliente.
 *
 * ## Duas datas, e elas não são a mesma coisa
 *
 * `posted_at` é **competência**: quando o fato econômico aconteceu.
 * `settled_at` é **compensação**: quando o dinheiro de fato se moveu, e é nulo
 * enquanto não aconteceu. Uma compra de cartão acontece num dia e afeta o caixa
 * noutro — quem move o dinheiro é o pagamento da fatura. Colapsar as duas numa
 * coluna "data" é o erro que faz toda compra de cartão nascer efetivada.
 *
 * A tela mostra as duas, lado a lado, e o vazio de `settled_at` é um traço e não
 * um espaço em branco: "ainda não se moveu" é informação.
 *
 * ## O que esta tela não é
 *
 * Não é o extrato do cliente. São as **200 linhas mais recentes por
 * `posted_at`**, sem filtro de período, sem categoria, sem saldo e sem rodapé de
 * baldes. Um rodapé aqui seria uma segunda apuração do mês do cliente,
 * calculada sobre uma amostra — e duas apurações discordando sobre o mesmo mês é
 * o defeito que o produto inteiro trabalha para não ter.
 *
 * O painel **não escreve** em `lancamentos`. Nenhum `GRANT`, para nenhum dos
 * quatro papéis.
 */

export default function LancamentosDoCliente() {
  const { tenantId } = useParams<{ tenantId: string }>()
  const { hipoteseDe } = usePainel()
  const hipotese = hipoteseDe(tenantId)

  const lancamentos = useQuery({
    queryKey: ['painel', 'lancamentos', tenantId],
    queryFn: () => painel.lancamentos(tenantId, hipotese!),
    enabled: hipotese !== null,
  })

  const itens = lancamentos.data ?? []

  return (
    <>
      <CabecalhoDeLeitura
        secao="lançamentos"
        numero={lancamentos.isPending ? '—' : itens.length}
        denominador="linhas lidas do razão deste cliente — as mais recentes por competência, no teto de 200. Abrir esta tela virou uma linha do registro, com o motivo, a referência e a rota."
      />

      <div className="mt-24">
        <Estado
          carregando={lancamentos.isPending}
          erro={lancamentos.error}
          vazio={itens.length === 0}
          textoDoVazio={
            <>
              Este espaço não tem nenhum lançamento. Ou o cliente nunca lançou nada, ou tudo o que
              havia foi excluído — a consulta ignora linhas com <code>deleted_at</code> preenchido.
            </>
          }
        >
          <table className="tabela">
            <caption className="sr-only">
              Lançamentos do cliente, com competência, compensação e valor
            </caption>
            <thead>
              <tr>
                <th scope="col">Descrição</th>
                <th scope="col">Origem</th>
                <th scope="col" className="numero">
                  Competência
                </th>
                <th scope="col" className="numero">
                  Compensação
                </th>
                <th scope="col" className="numero">
                  Valor
                </th>
              </tr>
            </thead>
            <tbody>
              {itens.map((l) => (
                <tr key={l.id}>
                  <td className="text-ink-1">
                    {l.descricao || <span className="text-ink-3">sem descrição</span>}
                  </td>
                  <td className="text-ink-3">{l.origem ?? '—'}</td>
                  <td className="numero text-ink-2">
                    <Instante iso={l.posted_at} />
                  </td>
                  <td className="numero text-ink-2">
                    <Instante iso={l.settled_at} />
                  </td>
                  <td className="numero">
                    {/*
                      Sinal, peso e cor — três canais, e dois deles funcionam em
                      escala de cinza. `previsto` quando o dinheiro ainda não se
                      moveu: peso 400 contra 600 separa a certeza sem gastar cor.
                    */}
                    <Valor
                      centavos={l.valor_centavos}
                      moeda={l.moeda}
                      previsto={l.settled_at === null}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Estado>
      </div>

      <p className="mt-24 max-w-[70ch] text-sm text-ink-3">
        Sem total e sem saldo, de propósito. Somar uma amostra de 200 linhas produziria um número
        que discorda do que o cliente vê na tela dele, e dois números discordando sobre o mesmo mês
        é pior que nenhum. <strong>Competência</strong> é quando o fato aconteceu;{' '}
        <strong>compensação</strong> é quando o dinheiro se moveu, e o traço quer dizer que ainda
        não se moveu.
      </p>
    </>
  )
}
