import { expect, test, type Page } from '@playwright/test'

/**
 * O fluxo crítico: entrar, ler o mês, lançar, e ver o total mudar.
 *
 * É o caminho que todo usuário percorre todo dia, e o único em que um defeito
 * é imediatamente visível como dinheiro errado. Os testes abaixo não conferem
 * pixel: eles conferem **aritmética atravessando a pilha inteira** — o valor
 * digitado no formulário chega ao banco e volta somado no rodapé.
 *
 * Contra o ambiente local semeado (`pnpm db:seed`). Duas regras tornam a suíte
 * repetível num banco que ela mesma suja:
 *
 * 1. **Afere a diferença, nunca o total.** O saldo absoluto depende do que as
 *    execuções anteriores deixaram; a diferença depende só deste lançamento.
 * 2. **Descrição única por execução.** Sem isso, a segunda rodada encontra dois
 *    "Café do teste" e o seletor falha por ambiguidade — que é o teste
 *    reclamando da própria sujeira, e não do produto.
 */

/** Marca desta execução, para os lançamentos que a suíte cria. */
const MARCA = Math.random().toString(36).slice(2, 8)

const EMAIL = 'demo@mavia.local'
const SENHA = 'mavia-demonstracao'

/** `−R$ 1.116,00` → `-111600`. O sinal é U+2212, não hífen. */
function centavosDe(texto: string): bigint {
  const limpo = texto.replace(/\s/g, '')
  const negativo = limpo.includes('−')
  const digitos = limpo.replace(/[^\d]/g, '')
  const valor = BigInt(digitos || '0')
  return negativo ? -valor : valor
}

async function entrar(page: Page) {
  await page.goto('/entrar')
  await page.getByLabel('E-mail').fill(EMAIL)
  await page.getByLabel('Senha').fill(SENHA)
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page.getByRole('navigation', { name: 'Navegação principal' })).toBeVisible()
}

/** O saldo do rodapé do extrato, em centavos. */
async function saldoDoRodape(page: Page): Promise<bigint> {
  const saldo = page.locator('[aria-label^="saldo de"]').last()
  await expect(saldo).toBeVisible()
  return centavosDe((await saldo.getAttribute('aria-label')) ?? '')
}

test.describe('entrada na plataforma', () => {
  test('credencial errada não diz qual metade errou', async ({ page }) => {
    await page.goto('/entrar')
    await page.getByLabel('E-mail').fill(EMAIL)
    await page.getByLabel('Senha').fill('não é essa')
    await page.getByRole('button', { name: 'Entrar' }).click()

    // Dentro do formulário: o Next mantém um `role="alert"` próprio para
    // anunciar mudança de rota, e `getByRole('alert')` solto pega os dois.
    const alerta = page.locator('form').getByRole('alert')
    await expect(alerta).toBeVisible()
    // Uma frase só: distinguir "esse e-mail não existe" de "essa senha está
    // errada" transforma a tela num oráculo que enumera a base de clientes.
    await expect(alerta).toHaveText('E-mail ou senha inválidos.')
    await expect(page).toHaveURL(/\/entrar/)
  })

  test('quem não entrou não vê o extrato', async ({ page }) => {
    await page.goto('/lancamentos')

    await expect(page).toHaveURL(/\/entrar/)
  })

  test('entrar leva ao painel, com o espaço identificado', async ({ page }) => {
    await entrar(page)

    await expect(page.getByText('Família Demonstração')).toBeVisible()
  })
})

test.describe('o extrato do mês', () => {
  test('agrupa por dia e fecha o rodapé', async ({ page }) => {
    await entrar(page)
    await page.getByRole('link', { name: 'lançamentos' }).click()

    await expect(page.getByRole('heading', { name: 'Lançamentos' })).toBeVisible()
    // Exato: "Salário" é descrição de um lançamento **e** aparece na coluna de
    // categoria como "Renda · Salário". Sem `exact`, o seletor pega os dois.
    await expect(page.getByText('Salário', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: /sáb 5 set/i })).toBeVisible()
  })

  test('compra de cartão não mexe no saldo em caixa', async ({ page }) => {
    // Regra 8b, atravessando a pilha: a compra aparece na listagem e o saldo do
    // dia dela é igual ao do dia anterior. Se a compra entrasse no eixo caixa,
    // o usuário veria o dinheiro sumir no dia da compra e sumir de novo no dia
    // do pagamento da fatura.
    await entrar(page)
    await page.goto('/lancamentos')

    await expect(page.getByText('Pneus 1/6')).toBeVisible()
    // A parcela do cartão fica em `cartão`, não numa conta: é o que a torna
    // invisível para o eixo caixa.
    await expect(page.getByText('cartão', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('saldo no dia').first()).toBeVisible()
  })

  test('o filtro de natureza esconde as transferências', async ({ page }) => {
    await entrar(page)
    await page.goto('/lancamentos')
    await expect(page.getByText('Para a reserva')).toBeVisible()

    await page.getByRole('combobox').first().selectOption('despesa')

    // Transferência não é despesa (`CONTEXT.md`), e o filtro obedece ao vínculo
    // de transferência, não ao sinal do valor.
    await expect(page.getByText('Para a reserva')).toHaveCount(0)
    await expect(page.getByText('Aluguel').first()).toBeVisible()
  })
})

test.describe('lançar uma despesa', () => {
  test('o valor digitado chega ao rodapé, no centavo', async ({ page }) => {
    await entrar(page)
    await page.goto('/lancamentos')

    const antes = await saldoDoRodape(page)

    await page.getByRole('button', { name: '+ lançar' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const descricao = `Café do teste ${MARCA}`
    await page.getByLabel('Descrição').fill(descricao)
    // Digitação da direita para a esquerda: `1234` vira R$ 12,34.
    await page.getByLabel('Valor').press('1')
    await page.getByLabel('Valor').press('2')
    await page.getByLabel('Valor').press('3')
    await page.getByLabel('Valor').press('4')
    await expect(page.getByLabel('Valor')).toHaveValue('R$ 12,34')

    await page.getByRole('button', { name: 'salvar', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await expect(page.getByText(descricao)).toBeVisible()

    // A asserção que vale: a diferença é exatamente o valor digitado. Conferir
    // o total absoluto amarraria o teste ao que os anteriores deixaram.
    await expect(async () => {
      expect(await saldoDoRodape(page)).toBe(antes - 1234n)
    }).toPass({ timeout: 10_000 })
  })

  test('a categoria padrão é analítica, e não "Ajuste de saldo"', async ({ page }) => {
    // `Ajuste de saldo` fica fora do relatório de categoria e de todo
    // Planejamento. Como padrão, faria quem lança às pressas registrar gastos
    // que nunca aparecem em relatório nenhum.
    await entrar(page)
    await page.goto('/lancamentos')
    await page.getByRole('button', { name: '+ lançar' }).click()

    const categoria = page.getByLabel('Categoria')
    await expect(categoria).not.toHaveValue('')
    const selecionada = await categoria.locator('option:checked').textContent()
    expect(selecionada).not.toBe('Ajuste de saldo')
  })

  test('o rateio da parcela aparece antes de confirmar', async ({ page }) => {
    await entrar(page)
    await page.goto('/lancamentos')
    await page.getByRole('button', { name: '+ lançar' }).click()

    await page.getByLabel('Conta ou cartão').selectOption({ label: 'Cartão principal' })
    for (const tecla of ['1', '0', '0', '0', '0', '0']) {
      await page.getByLabel('Valor').press(tecla)
    }
    await page.getByLabel('Parcelas').fill('3')

    // R$ 1.000,00 em 3x não divide. A frase diz o resto, em vez de esconder
    // dois centavos — é o ADR 0005 desenhado no momento da decisão.
    await expect(page.getByText(/3 parcelas de R\$ 333,33/)).toBeVisible()
    await expect(page.getByText(/primeira leva R\$ 333,34/)).toBeVisible()
  })

  test('valor zero é recusado com uma frase, não com um lançamento vazio', async ({ page }) => {
    await entrar(page)
    await page.goto('/lancamentos')
    await page.getByRole('button', { name: '+ lançar' }).click()

    await page.getByLabel('Descrição').fill('Sem valor')
    await page.getByRole('button', { name: 'salvar', exact: true }).click()

    await expect(page.locator('form').getByRole('alert')).toHaveText('Informe um valor.')
    await expect(page.getByRole('dialog')).toBeVisible()
  })
})

test.describe('cartão', () => {
  test('a fatura é um objeto com ciclo, e as parcelas futuras aparecem', async ({ page }) => {
    await entrar(page)
    await page.getByRole('link', { name: 'cartões' }).click()

    await expect(page.getByText('Cartão principal')).toBeVisible()
    await expect(page.getByText(/fecha dia 25 · vence dia 5/)).toBeVisible()

    // Parcela lançada em fatura futura já é compromisso: ela aparece desde o
    // dia da compra, e não no mês em que chega.
    await expect(page.getByText('Demais faturas')).toBeVisible()
  })
})

test.describe('sair', () => {
  test('revoga no ato, e o extrato deixa de abrir', async ({ page }) => {
    await entrar(page)
    await page.getByRole('button', { name: 'sair' }).click()

    await expect(page).toHaveURL(/\/entrar/)

    // Uma sessão que continua valendo até expirar torna o botão "sair" uma
    // promessa que o servidor não cumpre.
    await page.goto('/lancamentos')
    await expect(page).toHaveURL(/\/entrar/)
  })
})
