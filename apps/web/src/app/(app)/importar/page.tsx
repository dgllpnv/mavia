'use client'

import type { Conta } from '@mavia/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { api, chamar, ErroDaApi } from '../../../api/cliente'
import { Cartao, Vazio } from '../../../componentes/cartao'
import { useEspaco } from '../../../componentes/provedores'
import { Valor } from '../../../componentes/valor'

/**
 * Importar extrato.
 *
 * A tela é deliberadamente **franca sobre o que aconteceu**: quantos entraram,
 * quantos já existiam, quantas linhas não deram para ler e por quê. A
 * alternativa — "importação concluída" — esconde justamente o que o usuário
 * precisa conferir, e o custo do engano aqui é um extrato errado que ele só
 * descobre no fim do mês.
 *
 * O arquivo é lido **no navegador** e enviado como texto. O servidor nunca
 * recebe um upload binário, o que elimina uma classe inteira de problema — não
 * há arquivo em disco, não há nome de arquivo virando caminho, não há tipo MIME
 * a confiar.
 */
export default function Importar() {
  const espaco = useEspaco()
  const fila = useQueryClient()
  const entrada = useRef<HTMLInputElement>(null)

  const [contaId, setContaId] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  const contas = useQuery({
    queryKey: ['contas', espaco.id],
    queryFn: () => api.contas(espaco.id),
  })

  const importacoes = useQuery({
    queryKey: ['importacoes', espaco.id],
    queryFn: () => chamar<{ itens: Importacao[] }>('/importacoes', { tenantId: espaco.id }),
  })

  const conciliacoes = useQuery({
    queryKey: ['conciliacoes', espaco.id],
    queryFn: () => chamar<{ itens: Sugestao[] }>('/conciliacoes', { tenantId: espaco.id }),
  })

  const escolhida = contaId || contas.data?.itens[0]?.id || ''

  const importar = useMutation({
    async mutationFn(arquivo: File) {
      if (!escolhida) throw new ErroDaApi(400, 'Escolha a conta do extrato.')
      const conteudo = await arquivo.text()
      return chamar<Importacao>('/importacoes', {
        metodo: 'POST',
        tenantId: espaco.id,
        corpo: { contaId: escolhida, conteudo, nomeDoArquivo: arquivo.name },
      })
    },
    onSuccess() {
      void fila.invalidateQueries({ queryKey: ['importacoes'] })
      void fila.invalidateQueries({ queryKey: ['conciliacoes'] })
      void fila.invalidateQueries({ queryKey: ['lancamentos'] })
    },
    onError: (e) =>
      setErro(e instanceof ErroDaApi ? e.message : 'Não foi possível ler este arquivo.'),
  })

  const desfazer = useMutation({
    mutationFn: (id: string) =>
      chamar(`/importacoes/${id}/desfazer`, { metodo: 'POST', tenantId: espaco.id }),
    onSuccess() {
      void fila.invalidateQueries({ queryKey: ['importacoes'] })
      void fila.invalidateQueries({ queryKey: ['conciliacoes'] })
      void fila.invalidateQueries({ queryKey: ['lancamentos'] })
    },
  })

  const decidir = useMutation({
    mutationFn: ({ id, decisao }: { id: string; decisao: 'confirmar' | 'descartar' }) =>
      chamar(`/conciliacoes/${id}/${decisao}`, { metodo: 'POST', tenantId: espaco.id }),
    onSuccess() {
      void fila.invalidateQueries({ queryKey: ['conciliacoes'] })
      void fila.invalidateQueries({ queryKey: ['lancamentos'] })
    },
  })

  const ultima = importacoes.data?.itens[0]
  const sugestoes = conciliacoes.data?.itens ?? []

  return (
    <>
      <h1 className="text-2 font-semibold">Importar extrato</h1>

      <div className="mt-24 grid gap-24 lg:grid-cols-2">
        <Cartao titulo="Trazer um arquivo">
          <label className="flex flex-col gap-6">
            <span className="rotulo">Conta do extrato</span>
            <select className="campo" value={escolhida} onChange={(e) => setContaId(e.target.value)}>
              {(contas.data?.itens ?? []).map((c: Conta) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </label>

          <input
            ref={entrada}
            type="file"
            accept=".ofx,.qfx,.csv,.txt,text/plain,text/csv"
            className="hidden"
            onChange={(e) => {
              const arquivo = e.target.files?.[0]
              setErro(null)
              if (arquivo) importar.mutate(arquivo)
              e.target.value = ''
            }}
          />

          <button
            className="botao botao--primario mt-20"
            onClick={() => entrada.current?.click()}
            disabled={importar.isPending}
          >
            {importar.isPending ? 'lendo…' : 'escolher arquivo'}
          </button>

          <p className="mt-16 max-w-[52ch] text-sm text-ink-3">
            OFX ou CSV, do jeito que o banco entrega. O formato é reconhecido
            pelo conteúdo, e não pela extensão. Importar o mesmo arquivo duas
            vezes <strong>não duplica</strong> nada.
          </p>

          {erro && (
            <p role="alert" className="mt-16 text-corpo text-despesa">
              {erro}
            </p>
          )}

          {importar.data && <Resultado importacao={importar.data} />}
        </Cartao>

        <Cartao
          titulo="Parecem ser a mesma coisa"
          rodape={
            sugestoes.length > 0 ? (
              <span className="text-sm text-ink-3">
                Nada é apagado sem você dizer. Confirmar mantém o seu lançamento
                e marca como pago; descartar cria o do extrato como um lançamento
                à parte.
              </span>
            ) : undefined
          }
        >
          {sugestoes.length === 0 ? (
            <Vazio>
              Quando um lançamento do extrato parecer com um que você digitou, a
              proposta de casar os dois aparece aqui. O sistema nunca decide
              sozinho.
            </Vazio>
          ) : (
            <ul className="flex flex-col gap-16">
              {sugestoes.map((s) => (
                <li key={s.id} className="border-b border-line pb-16 last:border-0">
                  <p className="flex items-baseline justify-between gap-12">
                    <span className="text-1">{s.descricaoManual}</span>
                    <Valor centavos={s.valorCentavos} />
                  </p>
                  <p className="mt-4 text-sm text-ink-3">
                    do extrato: <strong className="text-ink-2">{s.descricaoDoExtrato}</strong> ·{' '}
                    {s.motivo} · {s.confianca}% de confiança
                  </p>
                  <p className="mt-12 flex gap-12">
                    <button
                      className="botao botao--primario"
                      onClick={() => decidir.mutate({ id: s.id, decisao: 'confirmar' })}
                    >
                      é a mesma
                    </button>
                    <button
                      className="botao"
                      onClick={() => decidir.mutate({ id: s.id, decisao: 'descartar' })}
                    >
                      são diferentes
                    </button>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Cartao>
      </div>

      <Cartao titulo="Importações" className="mt-24" semPadding>
        {(importacoes.data?.itens.length ?? 0) === 0 ? (
          <div className="px-20 py-16">
            <Vazio>Nenhum extrato importado ainda.</Vazio>
          </div>
        ) : (
          importacoes.data!.itens.map((i) => (
            <div key={i.id} className="linha grid-cols-[1fr_auto] items-center">
              <span className="min-w-0">
                <span className="block truncate text-1">
                  {i.nomeDoArquivo ?? 'extrato'}{' '}
                  <span className="text-sm text-ink-3">({i.provider})</span>
                </span>
                <span className="mt-2 block text-sm text-ink-3">
                  {i.criados} criado(s) · {i.repetidos} já existia(m) ·{' '}
                  {i.problemas.length} não lido(s) ·{' '}
                  {new Date(i.criadoEm).toLocaleString('pt-BR')}
                  {i.desfeitaEm && ' · desfeita'}
                </span>
              </span>

              {!i.desfeitaEm && (
                <button
                  className="botao botao--discreto"
                  onClick={() => desfazer.mutate(i.id)}
                  disabled={desfazer.isPending}
                >
                  desfazer
                </button>
              )}
            </div>
          ))
        )}
      </Cartao>

      {ultima && ultima.problemas.length > 0 && (
        <Cartao titulo="Linhas que não deram para ler" className="mt-24">
          <p className="max-w-[70ch] text-sm text-ink-3">
            Estas ficaram de fora. Nada foi adivinhado — um valor com três casas
            decimais ou uma data impossível vira uma linha aqui, e não um
            lançamento plausível e errado.
          </p>
          <ul className="mt-16 flex flex-col gap-8">
            {ultima.problemas.map((p, i) => (
              <li key={i} className="text-sm">
                <span className="text-ink-2">linha {p.linha}</span> — {p.motivo}
                <span className="ml-8 font-numero text-ink-3">{p.bruto.slice(0, 60)}</span>
              </li>
            ))}
          </ul>
        </Cartao>
      )}
    </>
  )
}

function Resultado({ importacao }: { importacao: Importacao }) {
  return (
    <div className="mt-20 rounded-2 border border-line p-16">
      <p className="text-1">
        {importacao.criados} lançamento(s) criado(s)
        {importacao.repetidos > 0 && `, ${importacao.repetidos} já existia(m)`}
        {importacao.sugestoes > 0 && `, ${importacao.sugestoes} para conferir ao lado`}.
      </p>
      {importacao.criados === 0 && importacao.repetidos > 0 && (
        <p className="mt-8 text-sm text-ink-3">
          Este extrato já tinha sido importado. Nada foi duplicado.
        </p>
      )}
    </div>
  )
}

interface Importacao {
  readonly id: string
  readonly provider: string
  readonly nomeDoArquivo: string | null
  readonly registros: number
  readonly criados: number
  readonly repetidos: number
  readonly sugestoes: number
  readonly problemas: readonly { linha: number; motivo: string; bruto: string }[]
  readonly criadoEm: string
  readonly desfeitaEm: string | null
}

interface Sugestao {
  readonly id: string
  readonly confianca: number
  readonly motivo: string
  readonly descricaoDoExtrato: string
  readonly descricaoManual: string
  readonly valorCentavos: string
}
