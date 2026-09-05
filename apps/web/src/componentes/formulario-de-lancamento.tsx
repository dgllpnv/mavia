'use client'

import type { Categoria, Conta } from '@mavia/contracts'
import { dataCivilDe, fimDoDiaCivil, formatarDataCivil } from '@mavia/domain'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { chamar, ErroDaApi } from '../api/cliente'
import { CampoDeValor } from './campo-de-valor'
import { Interruptor } from './interruptor'
import { MolduraEmSobreposicao, type MolduraDeLancamento } from './moldura-de-lancamento'
import { PrevisaoDoRateio } from './previsao-do-rateio'

/**
 * O formulário de lançamento.
 *
 * É a peça mais bem resolvida do Organizze, e o teardown (§4) diz por quê: cinco
 * campos primários visíveis, quatro atributos escondidos atrás de rótulos, e
 * `salvar e novo` como ação de primeira classe — quem lança em lote não fecha o
 * modal. A ordem dos campos é a deles, na íntegra (DP-31):
 *
 * ```
 * Descrição                       (foco inicial, largura total)
 * Valor        |  Data            (lado a lado)
 * [interruptor] Lançamento pago   (ligado por padrão)
 * Conta/Cartão |  Categoria       (lado a lado)
 * ```
 *
 * **O interruptor representa dois estados e o modelo tem três** — e isso não é
 * simplificação. `pendente` é derivado, não escolhido: é o que a data já passou
 * e o dinheiro não se moveu, e quem decide isso é o servidor a partir de
 * `posted_at`. O que o usuário informa é só se o dinheiro **saiu**.
 *
 * Onde nos afastamos: nada de ícones nus (🔁 💬 📎 🏷). O `docs/design.md`
 * proíbe emoji na interface de produto, e um ícone sem rótulo obriga a pessoa a
 * clicar para descobrir o que ele faz.
 */

export interface FormularioDeLancamentoProps {
  readonly tenantId: string
  readonly contas: readonly Conta[]
  readonly cartoes: readonly { id: string; nome: string }[]
  readonly categorias: readonly Categoria[]
  readonly naturezaInicial?: Natureza
  /**
   * A moldura que envolve os campos.
   *
   * `MolduraEmSobreposicao` (o padrão) é o diálogo do computador;
   * `MolduraEmTelaCheia` é a rota do celular. Trocar a moldura **não** troca o
   * formulário: quem monta decide a caixa, nunca o conteúdo dela.
   */
  readonly moldura?: MolduraDeLancamento
  /**
   * Um aviso de quem montou o formulário, acima dos campos.
   *
   * Existe porque quem carrega contas e categorias é a tela de fora, e numa
   * moldura de tela cheia não sobra lugar visível para ela dizer que a carga
   * falhou: a rota cobre a página inteira.
   */
  readonly aviso?: ReactNode
  /**
   * Avisa que a natureza mudou, para quem precisa refletir isso fora do
   * formulário — a rota `/lancar` reescreve o `?tipo=` para que recarregar a
   * página no meio do preenchimento não caia de volta em `despesa`.
   */
  aoMudarNatureza?(natureza: Natureza): void
  aoFechar(): void
}

export type Natureza = 'despesa' | 'receita' | 'transferencia'

const NATUREZAS = ['despesa', 'receita', 'transferencia'] as const

/**
 * Lê a natureza vinda do endereço, com `despesa` como queda.
 *
 * O endereço é entrada de fora — alguém digita, alguém guarda nos favoritos —
 * e nada que não esteja na lista entra no formulário.
 */
export function naturezaDe(valor: string | null | undefined): Natureza {
  return NATUREZAS.find((n) => n === valor) ?? 'despesa'
}

const TITULOS: Record<Natureza, string> = {
  despesa: 'Nova despesa',
  receita: 'Nova receita',
  transferencia: 'Nova transferência',
}

function hojeCivil(): string {
  return formatarDataCivil(dataCivilDe(new Date()))
}

export function FormularioDeLancamento({
  tenantId,
  contas,
  cartoes,
  categorias,
  naturezaInicial = 'despesa',
  moldura: Moldura = MolduraEmSobreposicao,
  aviso,
  aoMudarNatureza,
  aoFechar,
}: FormularioDeLancamentoProps) {
  const fila = useQueryClient()
  // O `<form>` precisa de `id` porque o `salvar` da moldura vive fora dele.
  const formId = useId()

  const [natureza, setNatureza] = useState<Natureza>(naturezaInicial)
  const [descricao, setDescricao] = useState('')
  const [centavos, setCentavos] = useState('0')
  const [dia, setDia] = useState(hojeCivil)
  const [pago, setPago] = useState(true)
  const [origem, setOrigem] = useState(() => contas[0]?.id ?? '')
  const [destino, setDestino] = useState(() => contas[1]?.id ?? contas[0]?.id ?? '')
  const [categoriaId, setCategoriaId] = useState('')
  const [repetindo, setRepetindo] = useState(false)
  const [parcelas, setParcelas] = useState(2)
  const [observacao, setObservacao] = useState('')
  const [mostrarObservacao, setMostrarObservacao] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const avisoDeErro = useRef<HTMLParagraphElement>(null)

  /**
   * O erro de salvamento vai para dentro do campo de visão.
   *
   * Ele fica no fim do formulário, e na moldura de tela cheia o `salvar` está
   * na barra do topo: quem toca em salvar com o teclado aberto pode receber
   * "Informe um valor" a duas rolagens de distância e concluir que o botão não
   * funciona. `block: 'nearest'` é rolagem mínima — não faz nada quando o aviso
   * já está visível, que é o caso do diálogo do computador.
   *
   * Sem `behavior: 'smooth'`: o movimento aqui não explica nada, só atrasa a
   * leitura de uma mensagem de erro.
   */
  useEffect(() => {
    if (erro) avisoDeErro.current?.scrollIntoView({ block: 'nearest' })
  }, [erro])

  const ehCartao = cartoes.some((c) => c.id === origem)
  const ehTransferencia = natureza === 'transferencia'

  /**
   * As categorias que cabem nesta natureza, com as de sistema por último.
   *
   * A ordem importa porque a primeira é o padrão do seletor, e `Ajuste de
   * saldo` é **não-analítica**: como padrão, faria quem lança às pressas
   * registrar gastos que nunca apareceriam em relatório nenhum.
   */
  const disponiveis = useMemo(
    () =>
      [...categorias]
        .filter((c) => c.natureza === (ehTransferencia ? 'despesa' : natureza) && !c.arquivada)
        .sort((a, b) => {
          if (a.analitica !== b.analitica) return a.analitica ? -1 : 1
          if (a.sistema !== b.sistema) return a.sistema ? 1 : -1
          return a.nome.localeCompare(b.nome, 'pt-BR')
        }),
    [categorias, natureza, ehTransferencia],
  )

  /**
   * A categoria escolhida acompanha a lista quando ela muda.
   *
   * As dependências eram `[natureza, categorias]`, e **faltava
   * `ehTransferencia`** — que também decide a lista. Trocar para transferência
   * filtrava as categorias para `despesa` e deixava a escolhida intacta: o
   * seletor passava a apontar para uma categoria que não estava mais na lista,
   * e o lançamento saía com a natureza errada. Foi o `exhaustive-deps` que
   * encontrou, e é o defeito de React mais caro que existe — ele não quebra,
   * mostra o número de ontem.
   *
   * O `useMemo` acima é o que permite depender da lista em vez de tentar
   * enumerar de novo o que a produz: um array novo a cada render faria o efeito
   * rodar sempre.
   */
  useEffect(() => {
    if (!disponiveis.some((c) => c.id === categoriaId)) {
      setCategoriaId(disponiveis[0]?.id ?? '')
    }
  }, [disponiveis, categoriaId])

  /**
   * A conta escolhida acompanha a lista quando ela chega.
   *
   * O estado inicial é `contas[0]`, e por muito tempo isso bastou porque as
   * listas já estavam em cache quando o formulário abria. Com a renovação de
   * sessão o primeiro carregamento ganhou uma ida a mais, o formulário passou a
   * abrir antes das contas, e o `POST` saía com `contaId` vazio — a API
   * respondia "Invalid uuid" e o modal ficava aberto sem que a pessoa
   * entendesse o quê.
   *
   * Corrigir aqui, e não adiar a abertura do formulário: quem clicou em
   * "lançar" quer digitar o valor agora, e a conta pode chegar enquanto ele
   * digita.
   */
  useEffect(() => {
    const disponiveisParaOrigem = [...contas, ...cartoes]
    if (!disponiveisParaOrigem.some((c) => c.id === origem)) {
      setOrigem(disponiveisParaOrigem[0]?.id ?? '')
    }
  }, [contas, cartoes, origem])

  useEffect(() => {
    // Origem e destino iguais não é transferência: é um lançamento que cria e
    // destrói o mesmo dinheiro. O banco recusa, e o formulário não deve chegar
    // lá com o botão habilitado.
    if (ehTransferencia && destino === origem) {
      setDestino(contas.find((c) => c.id !== origem)?.id ?? '')
    }
  }, [ehTransferencia, origem, destino, contas])

  const salvar = useMutation({
    async mutationFn(): Promise<void> {
      const magnitude = BigInt(centavos)
      if (magnitude === 0n) throw new ErroDaApi(400, 'Informe um valor.')
      if (!ehTransferencia && !categoriaId) throw new ErroDaApi(400, 'Escolha uma categoria.')
      if (ehTransferencia && (!destino || destino === origem)) {
        throw new ErroDaApi(400, 'Escolha duas contas diferentes.')
      }

      // O instante é a meia-noite do dia civil **em São Paulo** quando a data é
      // futura ou passada, e o agora quando é hoje. `new Date(dia)` daria
      // meia-noite UTC, que aqui é 21h do dia anterior — e o lançamento cairia
      // no dia errado, às vezes no mês errado.
      const [ano, mes, d] = dia.split('-').map(Number)
      const postedAt =
        dia === hojeCivil()
          ? new Date().toISOString()
          : fimDoDiaCivil({ ano: ano!, mes: mes!, dia: d! }).toISOString()

      if (ehTransferencia) {
        // A transferência nasce **inteira**, com as duas pernas, numa requisição
        // só. O valor vai como magnitude positiva — o sinal de cada perna é
        // derivado pelo servidor.
        await chamar('/lancamentos/transferencias', {
          metodo: 'POST',
          tenantId,
          corpo: {
            deContaId: origem,
            paraContaId: destino,
            valorCentavos: magnitude.toString(),
            postedAt,
            compensado: pago,
            descricao,
          },
        })
        return
      }

      // O sinal vem da natureza, e o banco confere contra a natureza da
      // categoria. Duas guardas para a mesma regra, porque errar o sinal
      // inverte o mês inteiro.
      const valorCentavos = (natureza === 'despesa' ? -magnitude : magnitude).toString()

      if (ehCartao) {
        await chamar(`/cartoes/${origem}/compras`, {
          metodo: 'POST',
          tenantId,
          corpo: {
            categoriaId,
            valorCentavos,
            postedAt,
            parcelas: repetindo ? parcelas : 1,
            descricao,
            ...(observacao ? { observacao } : {}),
          },
        })
        return
      }

      await chamar('/lancamentos', {
        metodo: 'POST',
        tenantId,
        corpo: {
          contaId: origem,
          categoriaId,
          valorCentavos,
          postedAt,
          compensado: pago,
          descricao,
          ...(observacao ? { observacao } : {}),
        },
      })
    },
    onSuccess() {
      // Invalida tudo que depende de dinheiro. Invalidar só a listagem deixaria
      // o painel e o rodapé mostrando o total de antes do lançamento.
      for (const chave of ['lancamentos', 'resumo', 'resumo-conta', 'faturas']) {
        void fila.invalidateQueries({ queryKey: [chave] })
      }
    },
  })

  /**
   * O único caminho de envio do formulário, chamado pelas três ações — e por
   * `Enter` num campo, que o navegador transforma em `submit`.
   *
   * Ele não recebe mais o evento: `salvar` e `salvar e novo` agora vivem na
   * moldura, e um `<button form="…">` não tem um evento de formulário para
   * cancelar. O `preventDefault` ficou onde ele de fato pertence, no `onSubmit`.
   */
  async function enviar(criarOutro: boolean) {
    setErro(null)
    try {
      await salvar.mutateAsync()
      if (!criarOutro) {
        aoFechar()
        return
      }
      // `salvar e novo` limpa descrição e valor e **preserva** data, origem e
      // categoria: quem lança em lote lança do mesmo lugar.
      setDescricao('')
      setCentavos('0')
      setRepetindo(false)
      setParcelas(2)
      setObservacao('')
    } catch (e) {
      setErro(e instanceof ErroDaApi ? e.message : 'Não foi possível salvar.')
    }
  }

  return (
    <Moldura
      titulo={TITULOS[natureza]}
      formId={formId}
      salvando={salvar.isPending}
      aoCancelar={aoFechar}
      aoSalvarENovo={() => void enviar(true)}
    >
      {aviso}

      {/*
        `role="radiogroup"` **é obrigatório aqui**, e a razão mudou de peso neste
        épico. `role="radio"` fora de um grupo é ARIA inválida: o leitor de tela
        anuncia "botão de opção, não marcado" sem grupo, sem "1 de 3" e sem
        navegação por seta.

        O defeito é anterior a este trabalho; a **severidade** não é. Com a ação
        de lançar fora do cabeçalho no celular, a barra de abas abre sempre em
        `?tipo=despesa` — e estes três botões passaram a ser o **único** caminho
        para lançar receita ou transferência num telefone. Achado do
        `revisor-codigo`.
      */}
      <div role="radiogroup" aria-label="Tipo de lançamento" className="mt-16 flex flex-wrap gap-2">
        {NATUREZAS.map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={v === natureza}
            onClick={() => {
              setNatureza(v)
              aoMudarNatureza?.(v)
            }}
            className={
              v === natureza
                ? 'rounded-2 border border-primaria bg-primaria-sutil px-12 py-6 text-sm font-medium text-primaria'
                : 'rounded-2 border border-line-forte px-12 py-6 text-sm text-ink-2 hover:bg-surface-2'
            }
          >
            {v === 'transferencia' ? 'transferência' : v}
          </button>
        ))}
      </div>

      <form
        id={formId}
        className="mt-20 flex flex-col gap-16"
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          void enviar(false)
        }}
      >
        <label className="flex flex-col gap-6">
          <span className="rotulo">Descrição</span>
          <input
            className="campo"
            value={descricao}
            onChange={(e) => setDescricao(e.target.value)}
            maxLength={140}
            required
            autoFocus
          />
        </label>

        <div className="grid grid-cols-[3fr_2fr] gap-12">
          <CampoDeValor centavos={centavos} aoMudar={setCentavos} />
          <label className="flex flex-col gap-6">
            <span className="rotulo">Data</span>
            <input
              className="campo"
              type="date"
              value={dia}
              onChange={(e) => setDia(e.target.value)}
              required
            />
          </label>
        </div>

        {/* O interruptor entre valor e categoria, como no Organizze: é ele que
            decide entre realizado e previsto, e é o controle mais usado. */}
        <Interruptor
          ligado={ehCartao ? false : pago}
          rotulo={ehTransferencia ? 'Transferência realizada' : 'Lançamento pago'}
          aoMudar={setPago}
          desabilitado={ehCartao}
        />
        {ehCartao && (
          <p className="-mt-8 text-sm text-ink-3">
            Compra no cartão não move dinheiro: quem move é o pagamento da fatura.
          </p>
        )}

        {ehTransferencia ? (
          <div className="grid grid-cols-1 gap-12 md:grid-cols-2">
            <label className="flex flex-col gap-6">
              <span className="rotulo">De</span>
              <select className="campo" value={origem} onChange={(e) => setOrigem(e.target.value)}>
                {contas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nome}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-6">
              <span className="rotulo">Para</span>
              <select className="campo" value={destino} onChange={(e) => setDestino(e.target.value)}>
                {contas
                  .filter((c) => c.id !== origem)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nome}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-12 md:grid-cols-2">
            <label className="flex flex-col gap-6">
              <span className="rotulo">Conta ou cartão</span>
              <select className="campo" value={origem} onChange={(e) => setOrigem(e.target.value)}>
                <optgroup label="Contas">
                  {contas.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nome}
                    </option>
                  ))}
                </optgroup>
                {cartoes.length > 0 && (
                  <optgroup label="Cartões">
                    {cartoes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nome}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            <label className="flex flex-col gap-6">
              <span className="rotulo">Categoria</span>
              <select
                className="campo"
                value={categoriaId}
                onChange={(e) => setCategoriaId(e.target.value)}
                required
              >
                {disponiveis.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nome}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {ehTransferencia && (
          <p className="text-sm text-ink-3">
            Transferência não é receita nem despesa: ela sai de um total e entra
            noutro, e fica fora da soma do mês nos dois lados.
          </p>
        )}

        {/* ---------------------------------------------------------------
            Atributos colapsados — rótulo em texto, e não ícone nu
            --------------------------------------------------------------- */}
        <div className="flex flex-wrap gap-8 border-t border-line pt-16">
          {ehCartao && natureza === 'despesa' && (
            <button
              type="button"
              className={repetindo ? 'botao botao--discreto text-primaria' : 'botao botao--discreto'}
              aria-pressed={repetindo}
              onClick={() => setRepetindo((v) => !v)}
            >
              parcelar
            </button>
          )}
          <button
            type="button"
            className={
              mostrarObservacao ? 'botao botao--discreto text-primaria' : 'botao botao--discreto'
            }
            aria-pressed={mostrarObservacao}
            onClick={() => setMostrarObservacao((v) => !v)}
          >
            observação
          </button>
        </div>

        {repetindo && ehCartao && (
          <div className="flex flex-col gap-12">
            <label className="flex items-center gap-12">
              <span className="rotulo">Parcelas</span>
              <input
                className="campo w-[88px] text-right"
                type="number"
                min={2}
                max={72}
                value={parcelas}
                onChange={(e) => setParcelas(Math.max(2, Number(e.target.value) || 2))}
              />
            </label>
            <PrevisaoDoRateio
              centavos={centavos}
              parcelas={parcelas}
              dataDaCompra={`${dia}T15:00:00Z`}
            />
          </div>
        )}

        {mostrarObservacao && (
          <label className="flex flex-col gap-6">
            <span className="rotulo">Observação</span>
            <textarea
              className="campo"
              rows={2}
              maxLength={1000}
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)}
            />
          </label>
        )}

        {erro && (
          <p ref={avisoDeErro} role="alert" className="text-corpo text-despesa">
            {erro}
          </p>
        )}
      </form>
    </Moldura>
  )
}
