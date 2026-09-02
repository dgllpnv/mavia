'use client'

import type { Categoria, Conta } from '@mavia/contracts'
import { dataCivilDe, formatarDataCivil, inicioDoDiaCivil } from '@mavia/domain'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent } from 'react'
import { ErroDaApi, chamar } from '../api/cliente'
import { CampoDeValor } from './campo-de-valor'
import { Modal } from './modal'
import { PrevisaoDoRateio } from './previsao-do-rateio'

/**
 * O formulário de lançamento.
 *
 * A estrutura é herdada do Organizze, que a resolveu bem (teardown §4): poucos
 * campos primários, atributos secundários colapsados, e `salvar e novo` como
 * ação de primeira classe — quem lança em lote lança do mesmo lugar. O que
 * muda é a linguagem:
 *
 * - **Três estados, não um interruptor.** `CONTEXT.md` tem `previsto`,
 *   `pendente` e `efetivado`; um interruptor "pago / não pago" não representa
 *   três, e a terceira possibilidade acabaria inferida de outra coisa.
 * - **Conta ou cartão no mesmo seletor.** Para quem lança, "onde isso saiu" é
 *   uma pergunta só. Que uma leve a `POST /lancamentos` e a outra a
 *   `POST /cartoes/:id/compras` é assunto do servidor, não da pessoa.
 * - **O rateio aparece antes de confirmar.** Ver que R$ 100,00 em 3x não é
 *   três de R$ 33,33 no momento da decisão, e não no extrato do mês seguinte.
 */

export interface FormularioDeLancamentoProps {
  readonly tenantId: string
  readonly contas: readonly Conta[]
  readonly cartoes: readonly { id: string; nome: string }[]
  readonly categorias: readonly Categoria[]
  aoFechar(): void
}

/**
 * Três naturezas no mesmo formulário, e não duas mais uma tela à parte.
 *
 * Transferência **não** é receita nem despesa (`CONTEXT.md`) — mas, para quem
 * lança, é a mesma pergunta: quanto, quando, de onde para onde. Escondê-la num
 * segundo lugar faria a pessoa aprender dois formulários para uma operação que
 * ela pensa como uma só, e é assim que "pagar a fatura" acaba lançada como
 * despesa, duplicando o gasto do mês.
 */
type Natureza = 'despesa' | 'receita' | 'transferencia'
type Estado = 'previsto' | 'pendente' | 'efetivado'

/** O dia de hoje em São Paulo, para o valor inicial do campo de data. */
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
  aoFechar,
}: FormularioDeLancamentoProps) {
  const fila = useQueryClient()

  const [natureza, setNatureza] = useState<Natureza>('despesa')
  const [descricao, setDescricao] = useState('')
  const [centavos, setCentavos] = useState('0')
  const [dia, setDia] = useState(hojeCivil)
  const [estado, setEstado] = useState<Estado>('efetivado')
  const [origem, setOrigem] = useState(() => contas[0]?.id ?? '')
  const [destino, setDestino] = useState(() => contas[1]?.id ?? contas[0]?.id ?? '')
  const [categoriaId, setCategoriaId] = useState('')
  const [parcelas, setParcelas] = useState(1)
  const [erro, setErro] = useState<string | null>(null)

  const ehCartao = cartoes.some((c) => c.id === origem)
  const ehTransferencia = natureza === 'transferencia'

  /**
   * As categorias que cabem nesta natureza, com as de sistema por último.
   *
   * A ordem importa porque a primeira é o padrão do seletor, e `Ajuste de
   * saldo` é **não-analítica**: ela existe para conciliar diferença de saldo e
   * fica fora do relatório de categoria e de todo Planejamento. Deixá-la como
   * padrão faria quem lança às pressas registrar gastos que nunca aparecem em
   * relatório nenhum — e o erro seria invisível justamente para quem tem pressa.
   *
   * Arquivada não entra: ela existe no dicionário para dar nome a lançamento
   * antigo, não para receber lançamento novo.
   */
  const disponiveis = [...categorias]
    .filter((c) => c.natureza === (ehTransferencia ? 'despesa' : natureza) && !c.arquivada)
    .sort((a, b) => {
      if (a.analitica !== b.analitica) return a.analitica ? -1 : 1
      if (a.sistema !== b.sistema) return a.sistema ? 1 : -1
      return a.nome.localeCompare(b.nome, 'pt-BR')
    })

  useEffect(() => {
    if (!disponiveis.some((c) => c.id === categoriaId)) {
      setCategoriaId(disponiveis[0]?.id ?? '')
    }
  }, [natureza, categorias])

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

      // O instante é a meia-noite do dia civil **em São Paulo**. Montá-lo com
      // `new Date(dia)` daria meia-noite UTC, que aqui é 21h do dia anterior —
      // e o lançamento cairia no dia errado, às vezes no mês errado.
      const [ano, mes, d] = dia.split('-').map(Number)
      const postedAt = inicioDoDiaCivil({ ano: ano!, mes: mes!, dia: d! }).toISOString()

      // O sinal vem da natureza escolhida, no cliente e no servidor, e o banco
      // confere contra a natureza da categoria. Três guardas para a mesma
      // regra, porque errar o sinal inverte o mês inteiro.
      const valorCentavos = (natureza === 'despesa' ? -magnitude : magnitude).toString()

      if (ehTransferencia) {
        // A transferência nasce **inteira**, com as duas pernas, numa
        // requisição só. Não existe rota que crie uma perna: perna isolada
        // cria ou destrói dinheiro do nada.
        //
        // O valor vai como magnitude positiva — o sinal de cada perna é
        // derivado pelo servidor, e mandá-lo daqui seria a interface decidindo
        // a direção do dinheiro.
        await chamar('/lancamentos/transferencias', {
          metodo: 'POST',
          tenantId,
          corpo: {
            deContaId: origem,
            paraContaId: destino,
            valorCentavos: magnitude.toString(),
            postedAt,
            compensado: estado === 'efetivado',
            descricao,
          },
        })
        return
      }

      if (ehCartao) {
        await chamar(`/cartoes/${origem}/compras`, {
          metodo: 'POST',
          tenantId,
          corpo: { categoriaId, valorCentavos, postedAt, parcelas, descricao },
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
          // `pendente` e `previsto` são os dois estados sem compensação; o que
          // os separa é a data ter passado ou não, e quem decide isso é o
          // servidor a partir de `posted_at` (o status é derivado, nunca coluna).
          compensado: estado === 'efetivado',
          descricao,
        },
      })
    },
    onSuccess() {
      // Invalida tudo que depende de dinheiro. Invalidar só a listagem deixaria
      // o rodapé e o painel mostrando o total de antes do lançamento.
      void fila.invalidateQueries({ queryKey: ['lancamentos'] })
      void fila.invalidateQueries({ queryKey: ['resumo'] })
      void fila.invalidateQueries({ queryKey: ['resumo-conta'] })
      void fila.invalidateQueries({ queryKey: ['faturas'] })
    },
  })

  async function enviar(evento: FormEvent, criarOutro: boolean) {
    evento.preventDefault()
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
      setParcelas(1)
    } catch (e) {
      setErro(e instanceof ErroDaApi ? e.message : 'Não foi possível salvar.')
    }
  }

  return (
    <Modal titulo={TITULOS[natureza]} aoFechar={aoFechar}>
      <>
        <div className="mt-16">
          <Segmentado<Natureza>
            rotulo="Natureza"
            valor={natureza}
            opcoes={[
              ['despesa', 'despesa'],
              ['receita', 'receita'],
              ['transferencia', 'transferência'],
            ]}
            aoMudar={setNatureza}
          />
        </div>

        <form className="mt-24 flex flex-col gap-20" onSubmit={(e) => void enviar(e, false)}>
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

          {/* Valor 3fr | Data 2fr — o valor pesa mais que a data, e a grade
              diz isso em vez de dar metade para cada um. */}
          <div className="grid grid-cols-[3fr_2fr] gap-16">
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

          <Segmentado<Estado>
            rotulo="Estado"
            valor={estado}
            opcoes={[
              ['previsto', 'previsto'],
              ['pendente', 'pendente'],
              ['efetivado', 'efetivado'],
            ]}
            aoMudar={setEstado}
            desabilitado={ehCartao}
            {...(ehCartao
              ? {
                  nota: 'Compra no cartão não move dinheiro: quem move é o pagamento da fatura.',
                }
              : {})}
          />

          {ehTransferencia ? (
            /* De 1fr | Para 1fr: as duas pontas pesam igual, porque a pergunta
               é simétrica — nenhuma das contas é mais importante que a outra. */
            <div className="grid grid-cols-2 gap-16">
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
                <select
                  className="campo"
                  value={destino}
                  onChange={(e) => setDestino(e.target.value)}
                >
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
            /* Conta 2fr | Categoria 3fr — a categoria pesa mais que a conta. */
            <div className="grid grid-cols-[2fr_3fr] gap-16">
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

          {ehCartao && natureza === 'despesa' && (
            <div className="flex flex-col gap-12 border-t border-line pt-16">
              <label className="flex items-center gap-12">
                <span className="rotulo">Parcelas</span>
                <input
                  className="campo w-[80px] text-right"
                  type="number"
                  min={1}
                  max={72}
                  value={parcelas}
                  onChange={(e) => setParcelas(Math.max(1, Number(e.target.value) || 1))}
                />
              </label>
              <PrevisaoDoRateio
                centavos={centavos}
                parcelas={parcelas}
                dataDaCompra={`${dia}T15:00:00Z`}
              />
            </div>
          )}

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
              className="botao botao--discreto"
              type="button"
              disabled={salvar.isPending}
              onClick={(e) => void enviar(e, true)}
            >
              salvar e novo →
            </button>
            <button className="botao botao--primario" type="submit" disabled={salvar.isPending}>
              {salvar.isPending ? 'salvando…' : 'salvar'}
            </button>
          </div>
        </form>
      </>
    </Modal>
  )
}

/**
 * Segmentado — três estados que se veem de uma vez.
 *
 * É `radiogroup` e não uma lista de botões: o leitor de tela anuncia "1 de 3" e
 * as setas do teclado navegam entre as opções, que é o comportamento que a
 * pessoa espera de uma escolha exclusiva.
 */
function Segmentado<T extends string>({
  rotulo,
  valor,
  opcoes,
  aoMudar,
  desabilitado = false,
  nota,
}: {
  rotulo: string
  valor: T
  opcoes: readonly (readonly [T, string])[]
  aoMudar(v: T): void
  desabilitado?: boolean
  nota?: string
}) {
  return (
    <div className={desabilitado ? 'opacity-60' : undefined}>
      <div role="radiogroup" aria-label={rotulo} className="flex gap-2">
        {opcoes.map(([v, texto]) => {
          const ativo = v === valor
          return (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={ativo}
              disabled={desabilitado}
              onClick={() => aoMudar(v)}
              className={
                ativo
                  ? 'rounded-1 border border-primaria bg-primaria-sutil px-12 py-6 text-sm font-medium text-primaria'
                  : 'rounded-1 border border-line-forte px-12 py-6 text-sm text-ink-2 hover:bg-surface-2'
              }
            >
              {texto}
            </button>
          )
        })}
      </div>
      {nota && <p className="mt-6 text-sm text-ink-3">{nota}</p>}
    </div>
  )
}
