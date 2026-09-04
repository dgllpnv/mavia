/**
 * Os campos que **nunca** saem — R-5 da `docs/seguranca/matriz-de-acesso.md`.
 *
 * Uma constante só, com dois consumidores obrigatórios: o teste de esquema, que
 * afirma que nenhum papel do painel os tem em `GRANT`, e a varredura do OpenAPI
 * (AB-07), que afirma que nenhum schema de resposta os declara. **Um campo que
 * sai de uma lista sai da outra**, e é por isso que a lista é uma só.
 *
 * ## Por que esta constante existe, com nome próprio e arquivo próprio
 *
 * A v3 do spec do painel de administração chamou de *"os sete campos da R-5"*
 * um conjunto que **não era o da R-5**: trocou `ip_hash`/`user_agent_hash` por
 * `dados_fiscais.documento`. O teste que ela especificava, escrito contra a
 * lista errada, **passaria** com `auditoria.ip_hash` concedido ao painel — verde
 * sobre exatamente o campo que a matriz veta.
 *
 * O erro só é possível quando a lista é reescrita a cada uso. Escrita uma vez,
 * a aritmética some.
 *
 * ## `ip_hash` e `user_agent_hash` ficam fora, e é decisão, não omissão
 *
 * A `auditoria` do painel guarda os dois, e o operador que investiga um
 * incidente é plausivelmente o leitor previsto. Ainda assim eles ficam fora do
 * `GRANT`, por três razões: a minimização decide sozinha (as perguntas do painel
 * — quem leu, quando, sob qual hipótese, qual rota, quantos registros — não
 * precisam do campo); inverter obrigaria a refazer **duas** LIAs, não uma; e o
 * valor probatório deles já decai por desenho, porque o pepper rotaciona a cada
 * doze meses. Investigação de incidente segue pelo caminho caro, e ele **deve**
 * ser caro.
 */

export interface CampoVetado {
  /**
   * O nome da coluna. Sem tabela nos dois últimos, de propósito: `ip_hash` e
   * `user_agent_hash` aparecem em mais de uma tabela, e vetar por nome de
   * coluna é o que faz a proteção alcançar a tabela que ainda não existe.
   */
  readonly coluna: string
  readonly onde: string
  readonly porque: string
}

export const CAMPOS_VETADOS: readonly CampoVetado[] = [
  {
    coluna: 'senha_hash',
    onde: 'usuarios',
    porque:
      'material para quebra offline de toda a base. A leitura completa que a DA-1 autorizou é dos dados financeiros — nunca do hash de senha de todo mundo.',
  },
  {
    coluna: 'refresh_hash',
    onde: 'sessoes',
    porque: 'quem o tem assume a sessão sem passar pelo login.',
  },
  {
    coluna: 'mfa_segredo_cifrado',
    onde: 'usuarios',
    porque: 'o segundo fator deixa de ser segundo se um primeiro caminho o entrega.',
  },
  {
    coluna: 'credenciais_cifradas',
    onde: 'conexoes',
    porque:
      'credencial de banco do titular. Inútil sem a KEK (ADR 0018), e mesmo assim não sai — cifra não é autorização.',
  },
  {
    coluna: 'dek_cifrada',
    onde: 'conexoes',
    porque: 'a chave que abre a linha acima.',
  },
  {
    coluna: 'payload',
    onde: 'lancamentos_brutos',
    porque:
      'dado cru de terceiro, com chave Pix, agência e conta antes da redação. Sai da normalização, nunca da leitura.',
  },
  {
    coluna: 'documento',
    onde: 'dados_fiscais',
    porque:
      'CPF ou CNPJ. Coletado só para emissão fiscal futura, com quatro vetos escritos — nunca identificador, nunca antifraude.',
  },
  {
    coluna: 'ip_hash',
    onde: 'auditoria, e qualquer tabela futura',
    porque:
      'existe para investigação de incidente, não para exibição — A-26 da matriz é categórica: não sai para papel nenhum.',
  },
  {
    coluna: 'user_agent_hash',
    onde: 'auditoria, e qualquer tabela futura',
    porque: 'irmão do anterior, e vetado pela mesma linha da matriz.',
  },
]
