'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useState, type FormEvent } from 'react'
import { Modal } from '../../componentes/modal'
import { painel } from '../../painel/api'
import { dataNaTela } from '../../painel/formatos'
import type { Hipotese } from '../../painel/hipotese'
import { CabecalhoDeLeitura, Estado, mensagemDoErro } from '../../painel/pecas'
import { Portao } from '../../painel/portao'

/**
 * A lista de clientes.
 *
 * É a única leitura do painel que **não** abre o espaço de ninguém: ela devolve
 * nome, titular, plano e estado, que é o mínimo para achar o cliente sobre o
 * qual a hipótese vai ser declarada. Entrar no espaço é o passo seguinte, e ele
 * passa pelo portão.
 *
 * A busca em si é registrada, com o termo hasheado e a contagem de resultados —
 * e é por isso que a tela não dispara consulta a cada tecla: cada requisição é
 * uma linha do log, e um campo com busca instantânea encheria o registro de
 * ruído que ninguém consegue ler depois.
 */

export default function ListaDeClientes() {
  const [rascunho, setRascunho] = useState('')
  const [termo, setTermo] = useState('')
  const [cadastrando, setCadastrando] = useState(false)

  const clientes = useQuery({
    queryKey: ['painel', 'clientes', termo],
    queryFn: () => painel.clientes(termo),
  })

  const itens = clientes.data ?? []

  function buscar(e: FormEvent) {
    e.preventDefault()
    setTermo(rascunho)
  }

  return (
    <>
      <CabecalhoDeLeitura
        secao="clientes"
        numero={clientes.isPending ? '—' : itens.length}
        denominador={
          termo
            ? `espaços encontrados para “${termo}”. Esta busca virou uma linha do registro, com o termo hasheado e esta contagem.`
            : 'espaços na base, do mais recente ao mais antigo. Esta busca virou uma linha do registro, com esta contagem.'
        }
        acoes={
          <button className="botao botao--primario" onClick={() => setCadastrando(true)}>
            cadastrar cliente
          </button>
        }
      />

      <form className="mt-24 flex items-end gap-12" onSubmit={buscar}>
        <label className="flex max-w-[420px] flex-1 flex-col gap-6">
          <span className="rotulo">Buscar por nome do espaço ou e-mail do titular</span>
          <input
            className="campo"
            value={rascunho}
            onChange={(e) => setRascunho(e.target.value)}
            maxLength={140}
            autoComplete="off"
          />
        </label>
        <button className="botao botao--discreto" type="submit">
          buscar
        </button>
        {termo && (
          <button
            className="botao text-sm"
            type="button"
            onClick={() => {
              setRascunho('')
              setTermo('')
            }}
          >
            limpar
          </button>
        )}
      </form>

      <div className="mt-24">
        <Estado
          carregando={clientes.isPending}
          erro={clientes.error}
          vazio={itens.length === 0}
          textoDoVazio={
            termo ? (
              <>
                Nenhum espaço com <strong>{termo}</strong> no nome ou no e-mail do titular. A busca
                é por trecho, não por identificador — se você tem o UUID do espaço, ele não entra
                aqui.
              </>
            ) : (
              <>
                A base não tem nenhum espaço ainda. O primeiro nasce quando alguém se cadastra pelo
                produto, ou aqui, pelo botão de cadastrar cliente.
              </>
            )
          }
        >
          <table className="tabela">
            <caption className="sr-only">
              Espaços encontrados, com titular, plano, estado e data de criação
            </caption>
            <thead>
              <tr>
                <th scope="col">Espaço</th>
                <th scope="col">Titular</th>
                <th scope="col">Plano</th>
                <th scope="col">Estado</th>
                <th scope="col" className="numero">
                  Criado em
                </th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {itens.map((c) => (
                <tr key={c.tenant_id}>
                  <td className="text-ink-1">{c.nome}</td>
                  <td className="text-ink-2">{c.titular ?? <span className="text-ink-3">sem titular ativo</span>}</td>
                  <td className="text-ink-2">{c.plano ?? '—'}</td>
                  <td>
                    <EstadoDaAssinatura estado={c.estado} />
                  </td>
                  <td className="numero text-ink-2">{dataNaTela(c.criado_em)}</td>
                  <td className="numero">
                    {/*
                      O nome viaja na URL **só para o portão poder dizer de quem
                      é o espaço** antes de qualquer consulta. Ele é texto de
                      tela: nenhuma decisão o lê, e o que a API recebe é o
                      identificador do caminho.
                    */}
                    <Link
                      className="botao botao--discreto text-sm"
                      href={`/admin/clientes/${c.tenant_id}?nome=${encodeURIComponent(c.nome)}`}
                    >
                      abrir
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Estado>
      </div>

      {cadastrando && <CadastroDeCliente aoFechar={() => setCadastrando(false)} />}
    </>
  )
}

/**
 * O estado da assinatura, e **nunca só a cor**.
 *
 * A palavra carrega o significado; a cor é reforço, e só aparece nos dois
 * estados que custam dinheiro ou acesso. Parte relevante das pessoas não
 * distingue verde de vermelho, e um painel de operação lido errado é uma baixa
 * dada no cliente errado.
 */
function EstadoDaAssinatura({ estado }: { readonly estado: string | null }) {
  if (!estado) return <span className="text-ink-3">sem assinatura</span>

  const cor =
    estado === 'em_atraso' || estado === 'expirada'
      ? 'text-despesa'
      : estado === 'teste'
        ? 'text-atencao'
        : 'text-ink-2'

  return <span className={cor}>{estado.replace('_', ' ')}</span>
}

/**
 * O cadastro de cliente novo.
 *
 * Passa pelo portão como qualquer escrita: a API grava a linha de intenção
 * contra o UUID nulo, porque o espaço ainda não tem identificador — ele nasce
 * dentro da própria transação.
 *
 * **O `aviso` da resposta é mostrado**, e ele é a metade que impede o operador
 * de procurar um botão que não existe: o espaço fica em teste e só vira ativo
 * quando o cliente assinar. Não há caminho no painel para forçar isso, e a
 * ausência é deliberada — o painel não é o terceiro escritor de `estado`.
 */
function CadastroDeCliente({ aoFechar }: { aoFechar(): void }) {
  const fila = useQueryClient()
  const [hipotese, setHipotese] = useState<Hipotese | null>(null)
  const [titularId, setTitularId] = useState('')
  const [nome, setNome] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  const cadastrar = useMutation({
    mutationFn: () => painel.cadastrar(hipotese!, titularId.trim(), nome.trim()),
    onSuccess: () => void fila.invalidateQueries({ queryKey: ['painel', 'clientes'] }),
  })

  async function enviar(e: FormEvent) {
    e.preventDefault()
    setErro(null)
    try {
      await cadastrar.mutateAsync()
    } catch (erro) {
      setErro(mensagemDoErro(erro))
    }
  }

  if (!hipotese) {
    return (
      <Modal titulo="Cadastrar cliente" aoFechar={aoFechar}>
        <div className="mt-16">
          <Portao aoDeclarar={setHipotese} />
        </div>
      </Modal>
    )
  }

  if (cadastrar.data) {
    return (
      <Modal titulo="Espaço criado" aoFechar={aoFechar}>
        <div className="mt-16 flex flex-col gap-16">
          <p className="consequencia consequencia--muda-acesso text-corpo text-ink-1">
            {cadastrar.data.aviso}
          </p>
          <p className="text-sm text-ink-3">
            Identificador do espaço: <span className="identificador">{cadastrar.data.id}</span>
          </p>
          {/*
            DP-40: não existe tela de trocar plano no painel, e a ausência é
            decisão escrita. Dizer para onde o cliente vai é mais barato que
            deixar o operador procurar.
          */}
          <p className="text-sm text-ink-3">
            Para sair do teste, o cliente assina pela própria tela de plano. O painel não troca
            plano nem intervalo.
          </p>
          <div className="flex justify-end border-t border-line pt-16">
            <button className="botao botao--primario" onClick={aoFechar}>
              fechar
            </button>
          </div>
        </div>
      </Modal>
    )
  }

  const pronto = nome.trim().length >= 2 && titularId.trim().length > 0

  return (
    <Modal
      titulo="Cadastrar cliente"
      subtitulo="O titular precisa já ter conta na Mavia. Este formulário vincula alguém que existe; ele não cria login para ninguém."
      aoFechar={aoFechar}
    >
      <form className="mt-24 flex flex-col gap-20" onSubmit={(e) => void enviar(e)}>
        <label className="flex flex-col gap-6">
          <span className="rotulo">Identificador do titular</span>
          <input
            className="campo identificador"
            value={titularId}
            onChange={(e) => setTitularId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
            autoComplete="off"
            required
            autoFocus
          />
          <span className="text-sm text-ink-3">
            É o identificador da conta dele, não o e-mail. Se ele ainda não tem conta, peça que se
            cadastre primeiro — criar credencial para outra pessoa é um operador que conhece a senha
            de um cliente.
          </span>
        </label>

        <label className="flex flex-col gap-6">
          <span className="rotulo">Nome do espaço</span>
          <input
            className="campo"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            maxLength={120}
            required
          />
        </label>

        <p className="consequencia text-corpo text-ink-2">
          Este espaço vai ficar em teste até o cliente assinar.
        </p>

        {erro && (
          <p role="alert" className="text-corpo text-despesa">
            {erro}
          </p>
        )}

        <div className="flex items-center justify-end gap-12 border-t border-line pt-16">
          <button className="botao botao--discreto" type="button" onClick={aoFechar}>
            cancelar
          </button>
          <button
            className="botao botao--primario"
            type="submit"
            disabled={!pronto || cadastrar.isPending}
          >
            {cadastrar.isPending ? 'criando…' : 'criar espaço'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
