import { expect, test, type Page } from '@playwright/test'

/**
 * O cadastro, do formulário à conta — pela caixa de entrada de verdade.
 *
 * Este é o único fluxo do produto que **atravessa um sistema que não é nosso**:
 * o link nasce na API, sai por SMTP, chega no Mailpit, e o navegador o abre. Um
 * E2E que pulasse o e-mail — lendo o token do banco, por exemplo — provaria
 * tudo menos a parte que quebra: a codificação do corpo, a quebra de linha do
 * assunto, o link cortado ao meio pelo cliente de e-mail.
 *
 * **Pré-requisito:** o Mailpit do `infra/docker-compose.yml` no ar (`mavia`), e
 * a API com `SMTP_HOST=127.0.0.1` e `SMTP_PORTA=4726`. Sem SMTP configurado a
 * rota **recusa** com 503, que é o comportamento certo e faz este teste falhar
 * dizendo exatamente isso.
 */

const MAILPIT = 'http://127.0.0.1:4725'

interface Recebida {
  readonly ID: string
  readonly To: readonly { readonly Address: string }[]
}

/**
 * O link do último e-mail para aquele endereço.
 *
 * Com espera: o envio é síncrono na rota, mas o Mailpit indexa a mensagem um
 * instante depois de aceitá-la, e sem a espera o teste falha uma vez a cada
 * tantas execuções — que é a pior forma de falhar.
 */
async function linkPara(email: string, caminho: string): Promise<string> {
  for (let tentativa = 0; tentativa < 40; tentativa++) {
    const r = await fetch(`${MAILPIT}/api/v1/messages?limit=200`)
    const { messages } = (await r.json()) as { messages: Recebida[] }
    const nossa = messages.find((m) => m.To.some((t) => t.Address === email))

    if (nossa) {
      const detalhe = await fetch(`${MAILPIT}/api/v1/message/${nossa.ID}`)
      const { Text } = (await detalhe.json()) as { Text: string }
      // `[?]` e não `\?`: a interrogação escapada tem de sobreviver ao literal
      // de string **e** à `RegExp`, e no primeiro descuido vira `confirmar?` —
      // com o "r" opcional —, que não casa com nada e falha dizendo que o
      // e-mail não chegou. Uma classe de caractere não tem esse problema.
      const casou = new RegExp('/' + caminho + '[?]t=[0-9a-f]{64}').exec(Text)
      if (casou) return casou[0]
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`nenhum link de /${caminho} chegou para ${email}`)
}

/** Um endereço novo por execução: o banco local não é recriado entre rodadas. */
const marca = Date.now()
const EMAIL = `e2e-${marca}@exemplo.test`
const SENHA = 'uma senha bem comprida'

test.describe('cadastro por e-mail', () => {
  test('do formulário ao espaço, pelo link que chegou na caixa', async ({ page }) => {
    await page.goto('/cadastrar')

    // `exact`: sem isso "Nome" casa também com "Nome do espaço" — o
    // localizador do Playwright é por substring, e a violação de modo estrito
    // só aparece quando o segundo campo existe.
    await page.getByLabel('Nome', { exact: true }).fill('Ana do E2E')
    await page.getByLabel('E-mail').fill(EMAIL)
    await page.getByLabel('Senha').fill(SENHA)
    await page.getByLabel('Nome do espaço').fill(`Casa ${marca}`)
    await page.getByRole('button', { name: 'Criar conta' }).click()

    // A tela não promete uma conta: promete um e-mail. A conta ainda não
    // existe, e dizer o contrário produz a pessoa que fecha a aba e tenta
    // entrar cinco minutos depois.
    await expect(page.getByRole('heading', { name: 'Abra seu e-mail' })).toBeVisible()

    const link = await linkPara(EMAIL, 'confirmar')
    await page.goto(link)

    // O clique no link cria usuário, espaço e vínculo, e já autentica: quem
    // acabou de provar o endereço não digita de novo a senha que escolheu há
    // dois minutos.
    // O nome do espaço no cabeçalho é a prova de que a sessão vale: ele só
    // aparece quando o provedor tem `eu` e o espaço escolhido.
    await expect(page.getByText(`Casa ${marca}`)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('link', { name: 'lançamentos' })).toBeVisible()
  })

  test('**o mesmo link não serve duas vezes**', async ({ page }) => {
    const link = await linkPara(EMAIL, 'confirmar')

    await sair(page)
    await page.goto(link)

    await expect(page.getByRole('heading', { name: 'Este link não vale mais' })).toBeVisible()
  })
})

test.describe('recuperação de senha', () => {
  test('o link troca a senha, e a senha nova entra', async ({ page }) => {
    await page.goto('/recuperar')
    await page.getByLabel('E-mail').fill(EMAIL)
    await page.getByRole('button', { name: 'Mandar o link' }).click()
    await expect(page.getByRole('heading', { name: 'Abra seu e-mail' })).toBeVisible()

    const link = await linkPara(EMAIL, 'redefinir')
    await page.goto(link)

    // A consequência é dita **antes** de enviar: se a conta foi invadida, é o
    // que a pessoa precisa saber sobre os outros aparelhos.
    await expect(page.getByText(/encerra todas as sessões abertas/)).toBeVisible()

    await page.getByLabel('Senha').fill('a segunda senha bem comprida')
    await page.getByRole('button', { name: 'Trocar a senha' }).click()

    await expect(page.getByRole('heading', { name: 'Senha trocada' })).toBeVisible()

    // E a senha nova entra pela porta da frente. Emitir sessão na tela de
    // redefinição daria ao link de recuperação o poder de logar sozinho — que é
    // exatamente o poder que um link vazado teria.
    await page.goto('/entrar')
    await page.getByLabel('E-mail').fill(EMAIL)
    await page.getByLabel('Senha').fill('a segunda senha bem comprida')
    await page.getByRole('button', { name: 'Entrar', exact: true }).click()

    await expect(page.getByRole('link', { name: 'lançamentos' })).toBeVisible({
      timeout: 15_000,
    })
  })

  test('**endereço que não existe responde igual**', async ({ page }) => {
    // A tela não sabe se o endereço existe, e não deve saber: ser mais
    // prestativa aqui é entregar a lista de clientes.
    await page.goto('/recuperar')
    await page.getByLabel('E-mail').fill('nao-existe-mesmo@exemplo.test')
    await page.getByRole('button', { name: 'Mandar o link' }).click()

    await expect(page.getByRole('heading', { name: 'Abra seu e-mail' })).toBeVisible()
  })
})

/** Sai da sessão pelo menu, como um humano sai. */
async function sair(page: Page): Promise<void> {
  await page.goto('/')
  const conta = page.getByRole('button', { name: 'Sua conta' })
  if (await conta.isVisible().catch(() => false)) {
    await conta.click()
    const sairBotao = page.getByRole('button', { name: 'Sair', exact: true })
    if (await sairBotao.isVisible().catch(() => false)) await sairBotao.click()
  }
  await page.context().clearCookies()
}
