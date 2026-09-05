import type { Mensagem } from './mensageiro.js'

/**
 * As mensagens do produto.
 *
 * Nenhuma delas é marketing, e o tom é o da coisa que elas são: um passo de
 * segurança. Sem saudação animada, sem emoji — `docs/design.md` proíbe emoji na
 * interface, e o e-mail é interface.
 *
 * **Cada uma diz o prazo e diz o que fazer se não foi você.** Um e-mail de
 * recuperação que não diz "se não foi você, ignore" transforma cada envio
 * legítimo a um endereço errado num susto, e cada envio ilegítimo numa pista
 * que a vítima não sabe ler.
 */

/** A base pública, para montar o link. Sem ela o e-mail não tem para onde ir. */
function base(): string {
  return process.env['MAVIA_URL_PUBLICA'] ?? 'http://127.0.0.1:4710'
}

export function confirmacaoDeCadastro(para: string, nome: string, token: string): Mensagem {
  return {
    para,
    assunto: 'Confirme seu cadastro na Mavia',
    corpo: [
      `${nome},`,
      '',
      'Para terminar seu cadastro na Mavia, abra o endereço abaixo:',
      '',
      `${base()}/confirmar?t=${token}`,
      '',
      'O link vale por 24 horas e só pode ser usado uma vez.',
      '',
      'Se não foi você quem pediu, ignore esta mensagem. Nenhuma conta foi',
      'criada, e nada acontece se você não abrir o link.',
      '',
      '— Mavia',
    ].join('\n'),
  }
}

export function recuperacaoDeSenha(para: string, token: string): Mensagem {
  return {
    para,
    assunto: 'Redefinir sua senha na Mavia',
    corpo: [
      'Alguém pediu para redefinir a senha desta conta na Mavia.',
      '',
      `${base()}/redefinir?t=${token}`,
      '',
      'O link vale por 1 hora e só pode ser usado uma vez.',
      '',
      'Se não foi você, ignore esta mensagem: sua senha continua a mesma e',
      'ninguém entrou na sua conta. Nós não trocamos senha sem que alguém',
      'abra este link.',
      '',
      '— Mavia',
    ].join('\n'),
  }
}

/**
 * O aviso depois da troca.
 *
 * É o que dá à vítima a chance de reagir: se a senha foi trocada por outra
 * pessoa, este e-mail chega na caixa **dela**, e é o único sinal que ela terá.
 * Por isso ele é enviado mesmo quando a troca foi legítima — um aviso que só
 * chega em caso de fraude ensina o atacante a reconhecê-lo.
 */
export function senhaAlterada(para: string): Mensagem {
  return {
    para,
    assunto: 'Sua senha na Mavia foi alterada',
    corpo: [
      'A senha desta conta na Mavia acabou de ser alterada, e todas as sessões',
      'abertas foram encerradas.',
      '',
      'Se foi você, não precisa fazer nada.',
      '',
      'Se não foi você, redefina a senha agora — quem trocou não tem mais',
      'acesso às sessões antigas, mas tem a senha nova:',
      '',
      `${base()}/entrar`,
      '',
      '— Mavia',
    ].join('\n'),
  }
}

/**
 * O aviso de sete dias antes da troca de plano agendada — **P-17**.
 *
 * ## Por que ele existe
 *
 * A troca foi pedida semanas antes. Quem pediu já esqueceu, ou mudou de ideia e
 * não se lembra de ter agendado nada. Sem este aviso, o plano encolhe num
 * sábado qualquer e a pessoa descobre pela cota que recusou um convite.
 *
 * É o mesmo raciocínio dos avisos de renovação anual da spec §6.4, com o sinal
 * trocado: lá o risco é uma cobrança que surpreende; aqui é uma **perda de
 * função** que surpreende. Os dois se corrigem do mesmo jeito — dizendo antes,
 * com data, valor e um caminho de uma ação para desfazer.
 *
 * ## O que ele não faz
 *
 * Não tenta reter. Sem "tem certeza?", sem oferta de desconto, sem lembrar o
 * que ela vai perder. A pessoa decidiu; o aviso serve para ela **confirmar a
 * decisão com informação**, e um aviso que argumenta contra o próprio
 * destinatário é retenção disfarçada de cortesia.
 */
export function trocaDePlanoEmSeteDias(
  para: string,
  dados: {
    readonly deNome: string
    readonly paraNome: string
    readonly precoNovo: string
    readonly quando: string
  },
): Mensagem {
  return {
    para,
    assunto: `Seu plano na Mavia muda em ${dados.quando}`,
    corpo: [
      `Em ${dados.quando}, seu espaço passa de ${dados.deNome} para`,
      `${dados.paraNome}, como você pediu.`,
      '',
      `A partir dessa data, a cobrança passa a ser de ${dados.precoNovo}.`,
      '',
      'Se mudou de ideia, dá para cancelar a troca até a véspera:',
      '',
      `${base()}/plano`,
      '',
      'Se está tudo certo, não precisa fazer nada.',
      '',
      '— Mavia',
    ].join('\n'),
  }
}
