'use client'

import type { LinhaDoRegistro } from '@mavia/contracts'
import { useQuery } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { painel } from '../../../painel/api'
import { dataEHoraNaTela } from '../../../painel/formatos'
import { MOTIVOS } from '../../../painel/hipotese'
import { CabecalhoDeLeitura, Estado } from '../../../painel/pecas'

/**
 * O registro de auditoria.
 *
 * ## Ler esta tela é um evento
 *
 * A leitura do registro **notifica os outros operadores**, por um destino fora
 * do painel. Um log que ninguém lê descobre o incidente quando o cliente
 * reclama; um log cuja leitura é silenciosa descobre na mesma hora. A tela diz
 * isso antes de a lista aparecer, porque quem abre precisa saber que abriu.
 *
 * ## O que não está aqui, e não está por construção
 *
 * `ip_hash` e `user_agent_hash` **não têm como** sair: eles não estão no tipo de
 * retorno de `admin.ler_registro`. Não é uma lista de campos que alguém precisa
 * lembrar de manter fora do serializador — acrescentá-los exigiria mudar a
 * assinatura da função.
 *
 * ## As duas linhas de uma escrita
 *
 * Uma escrita de contrato produz **duas** linhas com a mesma `correlacao`: a de
 * intenção, gravada antes de o valor novo existir, com `de` e `para` nulos; e a
 * de efeito, com o `de → para`. São duas porque `auditoria` não aceita `UPDATE`
 * de ninguém — a linha da intenção nunca pode ser completada depois. Uma
 * intenção sem efeito é uma escrita que falhou ou foi desfeita, e as duas juntas
 * contam a história inteira.
 */

export default function Registro() {
  const [tenantId, setTenantId] = useState('')
  const [desde, setDesde] = useState('')
  const [filtro, setFiltro] = useState<{ tenantId?: string; desde?: string }>({})

  const registro = useQuery({
    queryKey: ['painel', 'registro', filtro],
    queryFn: () => painel.registro({ ...filtro, limite: 200 }),
    // O registro não é dado que se pode reusar velho: cada leitura é um evento
    // deliberado, e reaproveitar cache faria a tela mostrar um passado que já
    // mudou sem que a notificação aos pares tivesse acontecido.
    staleTime: 0,
  })

  const itens = registro.data ?? []

  function aplicar(e: FormEvent) {
    e.preventDefault()
    setFiltro({
      ...(tenantId.trim() ? { tenantId: tenantId.trim() } : {}),
      ...(desde ? { desde: new Date(desde).toISOString() } : {}),
    })
  }

  return (
    <>
      <CabecalhoDeLeitura
        secao="registro"
        numero={registro.isPending ? '—' : itens.length}
        denominador="linhas lidas. Esta leitura avisou os outros operadores, por um destino fora do painel — um log cuja leitura é silenciosa só descobre o problema quando o cliente reclama."
      />

      <form className="mt-24 flex flex-wrap items-end gap-12" onSubmit={aplicar}>
        <label className="flex flex-col gap-6">
          <span className="rotulo">Espaço</span>
          <input
            className="campo identificador w-[340px]"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            placeholder="identificador do espaço"
            autoComplete="off"
          />
        </label>
        <label className="flex flex-col gap-6">
          <span className="rotulo">Desde</span>
          <input
            className="campo valor"
            type="datetime-local"
            value={desde}
            onChange={(e) => setDesde(e.target.value)}
          />
        </label>
        <button className="botao botao--discreto" type="submit">
          filtrar
        </button>
      </form>

      <div className="mt-24">
        <Estado
          carregando={registro.isPending}
          erro={registro.error}
          vazio={itens.length === 0}
          textoDoVazio={
            <>
              Nenhuma linha no recorte. Se você filtrou por espaço, confira o identificador — o
              filtro é por igualdade, não por trecho.
            </>
          }
        >
          <table className="tabela">
            <caption className="sr-only">
              Linhas do registro de auditoria, da mais recente para a mais antiga
            </caption>
            <thead>
              <tr>
                <th scope="col" className="numero">
                  Quando
                </th>
                <th scope="col">Ação</th>
                <th scope="col">Motivo</th>
                <th scope="col">Referência</th>
                <th scope="col">Rota</th>
                <th scope="col" className="numero">
                  Registros
                </th>
                <th scope="col">De → para</th>
              </tr>
            </thead>
            <tbody>
              {/*
                **A chave inclui a posição, e é o único jeito correto aqui.**

                As duas linhas de uma escrita de contrato — a intenção e o
                efeito — compartilham `correlacao`, `acao` **e** `ocorrido_em`:
                elas são gravadas na mesma transação, e `now()` no Postgres é o
                instante do início da transação, igual para as duas. Não existe
                campo que as distinga, porque `auditoria` não tem chave primária
                na projeção de `ler_registro`.

                A posição é chave legítima porque esta lista é um retrato
                ordenado pelo servidor: nada aqui reordena, filtra no cliente,
                nem guarda estado por linha.
              */}
              {itens.map((l, posicao) => (
                <tr key={`${l.correlacao ?? l.ocorrido_em}-${posicao}`}>
                  <td className="numero text-ink-2">{dataEHoraNaTela(l.ocorrido_em)}</td>
                  <td className="curta text-ink-1">{l.acao.replace(/_/g, ' ')}</td>
                  <td className="curta text-ink-2">
                    {l.motivo ? (MOTIVOS.find(([v]) => v === l.motivo)?.[1] ?? l.motivo) : '—'}
                  </td>
                  <td className="curta identificador">{l.referencia ?? '—'}</td>
                  <td className="text-ink-3">{l.rota ?? '—'}</td>
                  <td className="numero text-ink-2">{l.registros ?? '—'}</td>
                  <td>
                    <DeParaAoLado linha={l} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Estado>
      </div>
    </>
  )
}

/**
 * O `de → para` de uma escrita de contrato.
 *
 * A linha de **intenção** tem os dois nulos, e isso não é falta de dado: ela foi
 * gravada antes de o valor novo existir. Escrever "—" nela e o par na linha de
 * efeito é o que torna as duas legíveis como um par, e não como uma linha
 * incompleta seguida de outra.
 */
function DeParaAoLado({ linha }: { readonly linha: LinhaDoRegistro }) {
  if (linha.de === null && linha.para === null) {
    return <span className="text-sm text-ink-3">intenção declarada</span>
  }

  return (
    <div className="de-para">
      <p>
        <span className="rotulo">de</span> {emUmaLinha(linha.de)}
      </p>
      <p>
        <span className="rotulo">para</span> {emUmaLinha(linha.para)}
      </p>
    </div>
  )
}

/**
 * O JSONB numa linha legível.
 *
 * `JSON.stringify` não põe espaço depois da vírgula, e uma string sem espaço
 * **não tem onde quebrar**: numa coluna estreita o navegador parte no meio de
 * `"em_atraso"` e o valor vira uma escada de duas letras por linha. O espaço
 * depois da vírgula é a oportunidade de quebra, e ele custa um `replace`.
 */
function emUmaLinha(valor: unknown): string {
  if (valor === null || valor === undefined) return '—'
  return JSON.stringify(valor).replace(/,"/g, ', "')
}
