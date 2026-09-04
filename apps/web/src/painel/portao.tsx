'use client'

import type { MotivoDeAcesso } from '@mavia/contracts'
import { useId, useState, type FormEvent } from 'react'
import {
  hipoteseDe,
  MOTIVOS,
  O_QUE_FICA_REGISTRADO,
  REFERENCIA_MAXIMA,
  referenciaValida,
  type Hipotese,
} from './hipotese'

/**
 * O portão — a hipótese declarada **antes** de o espaço abrir.
 *
 * Não é um aviso que aparece depois de a página carregar: é a página, enquanto a
 * hipótese não existir. Nenhuma consulta é disparada atrás dele, porque a
 * primeira consulta **é** a abertura do espaço — `admin.abrir_espaco` grava a
 * linha de auditoria e define `app.tenant_id` na mesma instrução.
 *
 * Ele vale também para quem chega por URL direta. Um portão que só aparece no
 * caminho que passa pelo botão é um portão com uma porta lateral aberta.
 *
 * O cabeçalho fica com quem chama: numa página, ele é o nome do cliente em
 * corpo grande; num diálogo, o título do diálogo já existe e um segundo seria
 * ruído.
 */

export function Portao({
  aoDeclarar,
  rotuloDaAcao = 'abrir o espaço',
}: {
  aoDeclarar(h: Hipotese): void
  readonly rotuloDaAcao?: string
}) {
  const idDaReferencia = useId()
  const [motivo, setMotivo] = useState<MotivoDeAcesso>('chamado')
  const [referencia, setReferencia] = useState('')

  const pronta = referenciaValida(referencia)

  function enviar(e: FormEvent) {
    e.preventDefault()
    const h = hipoteseDe(motivo, referencia)
    if (h) aoDeclarar(h)
  }

  return (
    <form className="max-w-[56ch]" onSubmit={enviar}>
      <p className="max-w-[60ch] text-corpo text-ink-2">{O_QUE_FICA_REGISTRADO}</p>

      <div className="mt-24 flex flex-col gap-20">
        <fieldset className="flex flex-col">
          <legend className="rotulo mb-8">Motivo</legend>
          {/* Rádio e não `select`: são quatro opções fechadas, e vê-las todas é
              o que impede o operador de aceitar a primeira por inércia. A lista
              é fechada na API também — um valor fora dela não entra no `INSERT`,
              e "curiosidade" não tem valor de enum. */}
          {MOTIVOS.map(([valor, rotulo, quando]) => (
            <label
              key={valor}
              className="flex cursor-pointer items-baseline gap-8 border-b border-line py-8 last:border-b-0"
            >
              <input
                type="radio"
                name="motivo"
                value={valor}
                checked={motivo === valor}
                onChange={() => setMotivo(valor)}
              />
              <span>
                <span className="block text-1 text-ink-1">{rotulo}</span>
                <span className="block text-sm text-ink-3">{quando}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="flex flex-col gap-6" htmlFor={idDaReferencia}>
          <span className="rotulo">Referência</span>
          <input
            id={idDaReferencia}
            className="campo"
            value={referencia}
            onChange={(e) => setReferencia(e.target.value)}
            maxLength={REFERENCIA_MAXIMA}
            autoComplete="off"
            aria-describedby={`${idDaReferencia}-ajuda`}
            required
          />
          {/* A referência é **identificador, nunca narrativa**. Um campo de
              motivo que vira diário de atendimento recria dentro do log de
              acesso o mesmo texto livre que a política passou o documento
              inteiro tirando de todo lugar. */}
          <span id={`${idDaReferencia}-ajuda`} className="text-sm text-ink-3">
            O número do chamado, do incidente ou do processo. Um identificador, não a descrição do
            problema: o que o cliente contou por e-mail não entra aqui.
          </span>
        </label>
      </div>

      <div className="mt-24 flex items-center gap-16 border-t border-line pt-16">
        <button className="botao botao--primario" type="submit" disabled={!pronta}>
          {rotuloDaAcao}
        </button>
        {/* `aria-live`: quem usa leitor de tela precisa saber por que o botão
            está desabilitado sem sair do campo para procurar. */}
        <span className="text-sm text-ink-3" aria-live="polite">
          {pronta
            ? 'a partir daqui, tudo fica registrado'
            : 'a referência tem de 3 a 80 caracteres'}
        </span>
      </div>
    </form>
  )
}
