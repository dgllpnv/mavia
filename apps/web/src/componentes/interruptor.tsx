'use client'

/**
 * O interruptor de "lançamento pago".
 *
 * É a peça que os clientes do Organizze mais usam: ela é o que decide entre
 * **realizado** e **previsto**, e fica entre o valor e a categoria no
 * formulário — em posição de destaque, não escondida.
 *
 * `role="switch"` de verdade, e não um `div` com `onClick`: o leitor de tela
 * anuncia ligado/desligado, a barra de espaço alterna, e o `Tab` chega nele.
 * Um interruptor que só funciona com o mouse é um interruptor que metade das
 * pessoas não alcança.
 *
 * **Nota de modelo:** o `CONTEXT.md` tem **três** estados — `previsto`,
 * `pendente` e `efetivado` —, e um interruptor representa dois. Não é
 * simplificação: `pendente` é derivado, não escolhido. Ele é o que a data já
 * passou e o dinheiro não se moveu, e quem decide isso é o servidor a partir de
 * `posted_at`. O que o usuário informa é só se o dinheiro **saiu**.
 */

export interface InterruptorProps {
  readonly ligado: boolean
  readonly rotulo: string
  aoMudar(ligado: boolean): void
  readonly desabilitado?: boolean
  /**
   * Nome acessível quando o rótulo visível não basta sozinho.
   *
   * Numa lista, "ativa" repetido em cada linha é claro para quem enxerga a
   * linha inteira e ambíguo para quem navega pelos controles — o leitor de tela
   * anuncia dez interruptores idênticos. O texto visível fica curto; o nome
   * acessível diz de quem é.
   */
  readonly rotuloAcessivel?: string
}

export function Interruptor({
  ligado,
  rotulo,
  aoMudar,
  desabilitado = false,
  rotuloAcessivel,
}: InterruptorProps) {
  return (
    <label
      className={`flex items-center gap-12 ${desabilitado ? 'opacity-60' : 'cursor-pointer'}`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={ligado}
        aria-label={rotuloAcessivel ?? rotulo}
        disabled={desabilitado}
        onClick={() => aoMudar(!ligado)}
        className="interruptor"
      />
      <span className="text-corpo">{rotulo}</span>
    </label>
  )
}
