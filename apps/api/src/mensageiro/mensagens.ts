import type { Mensagem } from './mensageiro.js'

/**
 * As três mensagens do produto.
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
