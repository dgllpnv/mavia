/**
 * A matriz de vinculação de identidade federada.
 *
 * Implementa `docs/produto/spec-autenticacao.md` §2.4. É função pura de
 * propósito: este é o ponto onde produtos entregam a conta de uma pessoa a
 * outra, e a decisão inteira cabe numa tabela de seis casos — que se testa
 * exaustivamente, sem banco e sem rede.
 *
 * A regra que governa tudo: **a posse do e-mail nunca é prova suficiente para
 * vincular.** Vincular por e-mail verificado é o desenho que permite registrar
 * o endereço da vítima com senha antes de ela chegar, e depois dividir com ela
 * o mesmo espaço financeiro.
 */

/**
 * Os fatos que a aplicação apura antes de decidir. Vêm de
 * `auth.resolver_identidade_federada` e `auth.buscar_credencial`.
 */
export interface FatosDaEntrada {
  /** O par (issuer, subject) já existe em `identidades_federadas`. */
  readonly subConhecido: boolean
  /** `email_verified` do token. Ausente conta como `false`. */
  readonly emailVerificadoNoProvedor: boolean
  readonly existeUsuarioComEsseEmail: boolean
  /** A conta tem credencial própria: senha ou MFA. */
  readonly usuarioTemSenhaOuMfa: boolean
  /** O endereço já pertence a outro `subject` do mesmo provedor. */
  readonly emailPertenceAOutroSubject: boolean
}

/**
 * O motivo é para auditoria e alerta. **Nunca vai para a resposta** — é por
 * isso que ele mora num campo separado da mensagem, e não dentro dela.
 */
export type MotivoDeRecusa =
  | 'email-nao-verificado'
  | 'reatribuicao-de-endereco'
  | 'estado-impossivel'

export type DecisaoDeEntrada =
  | { readonly acao: 'entrar' }
  | { readonly acao: 'cadastrar' }
  /** Só C4. O sinalizador é explícito para que revelar seja decisão, não descuido. */
  | { readonly acao: 'exigir-prova'; readonly podeRevelarQueContaExiste: true }
  | {
      readonly acao: 'recusar'
      /** O que o usuário lê. Uma só, sempre a mesma, em toda recusa. */
      readonly mensagem: 'generica'
      readonly motivoInterno: MotivoDeRecusa
      readonly alertarOperador?: true
    }

export function decidirEntradaFederada(fatos: FatosDaEntrada): DecisaoDeEntrada {
  // C1 — a identidade não depende do e-mail. Nem de estar verificado, nem de
  // haver conflito com outro subject: quem já é conhecido, entra.
  if (fatos.subConhecido) {
    return { acao: 'entrar' }
  }

  // C2 — e-mail não verificado é tratado como e-mail AUSENTE, não como
  // suspeito. Não consultamos `usuarios` por aquele endereço, nem para dizer
  // que existe, nem para dizer que não.
  if (!fatos.emailVerificadoNoProvedor) {
    return { acao: 'recusar', mensagem: 'generica', motivoInterno: 'email-nao-verificado' }
  }

  // C3 — ninguém usa o endereço: cadastro.
  if (!fatos.existeUsuarioComEsseEmail) {
    return { acao: 'cadastrar' }
  }

  // C4 — a conta tem credencial própria. Exige prova daquilo que ela já possui.
  // Revelar que a conta existe é aceitável aqui, e só aqui: quem está do outro
  // lado acabou de provar ao Google que controla aquele endereço, então
  // enumeração em massa exigiria controlar cada caixa postal testada.
  if (fatos.usuarioTemSenhaOuMfa) {
    return { acao: 'exigir-prova', podeRevelarQueContaExiste: true }
  }

  // C5 — o endereço mudou de dono. Duas contas do mesmo provedor não podem ter
  // o mesmo endereço ao mesmo tempo, então um subject novo com um endereço já
  // nosso significa reatribuição, nunca "a mesma pessoa com outra conta".
  //
  // Mensagem genérica, indistinguível de C2: quem está no teclado controla a
  // caixa hoje e não controlava quando a conta foi criada. Confirmar que existe
  // conta entregaria a existência da vítima, e a partir daí o alvo.
  if (fatos.emailPertenceAOutroSubject) {
    return { acao: 'recusar', mensagem: 'generica', motivoInterno: 'reatribuicao-de-endereco' }
  }

  // C6 — impossível por construção: todo usuário nasce com ao menos uma
  // credencial. Chegar aqui é corrupção de dado. Recusar e alertar, porque
  // seguir em frente adivinhando é pior que parar.
  return {
    acao: 'recusar',
    mensagem: 'generica',
    motivoInterno: 'estado-impossivel',
    alertarOperador: true,
  }
}
