'use client'

import { useQuery } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { Valor } from '../../../../../componentes/valor'
import { painel } from '../../../../../painel/api'
import { usePainel } from '../../../../../painel/contexto'
import { CabecalhoDeLeitura, Estado } from '../../../../../painel/pecas'

/**
 * As contas do cliente.
 *
 * ## O número desta tela é o **saldo inicial**, e ele não é o saldo
 *
 * A rota devolve `saldo_inicial_centavos`, que é o que havia na conta no dia em
 * que o cliente começou a usar a Mavia. O **saldo** é derivado da soma dos
 * lançamentos efetivados (regra 5, `CONTEXT.md`), e nenhuma rota do painel o
 * calcula: `mavia_admin` não tem `SELECT` para somar o razão por conta, e
 * inventar a soma no navegador a partir dos 200 lançamentos mais recentes daria
 * um número **errado** com cara de certo.
 *
 * Por isso a coluna se chama "saldo inicial" e a tela diz o que ela não é. O
 * ticket chama esta tela de "contas e saldos"; o que a API entrega hoje são
 * contas e saldos **iniciais**, e nomear a diferença é mais barato que um
 * operador afirmando ao cliente um saldo que não existe.
 *
 * O painel **não escreve** em `contas`: nenhum `GRANT` de escrita sobre o razão,
 * para nenhum dos quatro papéis. Corrigir lançamento de cliente é pedido ao
 * cliente, nunca feito por cima dele.
 */

const TIPOS: Readonly<Record<string, string>> = {
  corrente: 'conta corrente',
  poupanca: 'poupança',
  dinheiro: 'dinheiro em espécie',
  digital: 'conta digital',
  investimento: 'investimento',
  outra: 'outra',
}

export default function ContasDoCliente() {
  const { tenantId } = useParams<{ tenantId: string }>()
  const { hipoteseDe } = usePainel()
  const hipotese = hipoteseDe(tenantId)

  const contas = useQuery({
    queryKey: ['painel', 'contas', tenantId],
    queryFn: () => painel.contas(tenantId, hipotese!),
    enabled: hipotese !== null,
  })

  const itens = contas.data ?? []

  return (
    <>
      <CabecalhoDeLeitura
        secao="contas"
        numero={contas.isPending ? '—' : itens.length}
        denominador="contas não excluídas deste espaço. Abrir esta tela virou uma linha do registro, com o motivo, a referência e a rota."
      />

      <div className="mt-24">
        <Estado
          carregando={contas.isPending}
          erro={contas.error}
          vazio={itens.length === 0}
          textoDoVazio={
            <>
              Este espaço não tem nenhuma conta. É o estado de quem se cadastrou e não voltou: o
              espaço nasce com as categorias de sistema e mais nada, e todo lançamento precisa de
              uma conta.
            </>
          }
        >
          <table className="tabela">
            <caption className="sr-only">Contas do cliente com tipo e saldo inicial</caption>
            <thead>
              <tr>
                <th scope="col">Conta</th>
                <th scope="col">Tipo</th>
                <th scope="col">No saldo geral</th>
                <th scope="col" className="numero">
                  Saldo inicial
                </th>
              </tr>
            </thead>
            <tbody>
              {itens.map((c) => (
                <tr key={c.id}>
                  <td className="text-ink-1">{c.nome}</td>
                  <td className="text-ink-2">{TIPOS[c.tipo] ?? c.tipo}</td>
                  {/* Palavra, e não um ícone de check: "sim" e "não" são lidos
                      igual por todo mundo e sobrevivem a escala de cinza. */}
                  <td className="text-ink-2">{c.incluir_no_saldo_geral ? 'sim' : 'não'}</td>
                  <td className="numero">
                    {/* O componente do produto: o formatador é um só em toda a
                        Mavia. Valor formatado de dois jeitos em duas telas
                        destrói a confiança mais rápido que um erro de cálculo. */}
                    <Valor centavos={c.saldo_inicial_centavos} moeda={c.moeda} saldo />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Estado>
      </div>

      <p className="mt-24 max-w-[70ch] text-sm text-ink-3">
        A coluna é o <strong>saldo inicial</strong>, e não o saldo. O saldo é derivado da soma dos
        lançamentos efetivados, e o painel não o calcula — somá-lo aqui, a partir das 200 linhas mais
        recentes, daria um número errado com cara de certo. Se o cliente perguntar quanto tem na
        conta, a resposta está na tela dele.
      </p>
    </>
  )
}
