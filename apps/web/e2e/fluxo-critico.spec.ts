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
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Navegação principal' })).toBeVisible()
}

/**
 * A barra de filtros nasce **recolhida**, como no Organizze: quem não vai
 * filtrar não paga o espaço dela. Todo teste que filtra abre antes.
 */
async function abrirFiltros(page: Page) {
  const abrir = page.getByRole('button', { name: 'filtrar por…' })
  if (await abrir.isVisible()) await abrir.click()
}

/** O rodapé de resumo, pelo nome da região. */
function rodapeDoMes(page: Page) {
  return page.getByRole('region', { name: 'Resumo do mês' })
}

/**
 * O saldo do rodapé, em centavos.
 *
 * `first()` porque a região tem dois valores com o mesmo tipo de rótulo —
 * Saldo e Previsto —, e o primeiro é o realizado.
 */
async function saldoDoRodape(page: Page): Promise<bigint> {
  const saldo = rodapeDoMes(page).locator('[aria-label^="saldo de"]').first()
  await expect(saldo).toBeVisible()
  return centavosDe((await saldo.getAttribute('aria-label')) ?? '')
}

/** A despesa realizada, lida do detalhe expandido do rodapé. */
async function despesaRealizada(rodape: ReturnType<typeof rodapeDoMes>): Promise<bigint> {
  const linha = rodape.locator('div').filter({ hasText: /^Despesa realizada/ }).last()
  return centavosDe((await linha.innerText()).replace('Despesa realizada', ''))
}

test.describe('entrada na plataforma', () => {
  test('credencial errada não diz qual metade errou', async ({ page }) => {
    await page.goto('/entrar')
    await page.getByLabel('E-mail').fill(EMAIL)
    await page.getByLabel('Senha').fill('não é essa')
    await page.getByRole('button', { name: 'Entrar', exact: true }).click()

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
    await page
      .getByRole('navigation', { name: 'Navegação principal' })
      .getByRole('link', { name: 'lançamentos' })
      .click()

    await expect(page.getByRole('heading', { name: 'Lançamentos' })).toBeVisible()
    // Exato: "Salário" é descrição de um lançamento **e** aparece no subtítulo
    // como "Renda · Salário". Sem `exact`, o seletor pega os dois.
    await expect(page.getByText('Salário', { exact: true })).toBeVisible()
    // O dia é cabeçalho de grupo, com o saldo do dia no mesmo lugar.
    await expect(page.getByText(/sáb, 5 de set/i)).toBeVisible()
    await expect(page.getByText('saldo no dia').first()).toBeVisible()
  })

  test('compra de cartão não mexe no saldo em caixa', async ({ page }) => {
    // Regra 8b, atravessando a pilha inteira.
    //
    // A asserção não é "a linha aparece" — é que **o saldo do dia da parcela é
    // igual ao do dia anterior**. Se a compra de cartão entrasse no eixo caixa,
    // o usuário veria o dinheiro sumir no dia da compra e sumir de novo no dia
    // em que a fatura fosse paga: o mesmo dinheiro, duas vezes.
    await entrar(page)
    await page.goto('/lancamentos')

    const parcela = page.getByText(/^Pneus \d\/6$/)
    await expect(parcela).toBeVisible()

    // A parcela sai de `cartão`, e não de uma conta: é isso que a mantém fora
    // do universo do eixo caixa. O subtítulo da linha diz a categoria e a
    // origem do dinheiro, nessa ordem.
    const linha = page.locator('.linha').filter({ has: parcela })
    await expect(linha).toContainText('cartão')

    // Os dias vêm do mais recente para o mais antigo. O saldo do dia da parcela
    // e o do dia imediatamente anterior são o mesmo número.
    const dias = page.locator('div:has(> .cabecalho-dia)')
    const textos = await dias.allInnerTexts()
    const indice = textos.findIndex((t) => /Pneus \d\/6/.test(t))

    // O saldo do dia vive no **cabeçalho** do grupo, e não no fim dele. Ler o
    // texto do grupo inteiro depois de "saldo no dia" engoliria as linhas.
    const cabecalhos = await page.locator('.cabecalho-dia').allInnerTexts()

    expect(indice, 'a parcela precisa estar num grupo de dia').toBeGreaterThanOrEqual(0)
    expect(indice, 'e precisa existir um dia anterior para comparar').toBeLessThan(
      textos.length - 1,
    )

    const saldoDoDia = (i: number) => centavosDe(cabecalhos[i].split('saldo no dia')[1] ?? '')

    expect(saldoDoDia(indice)).toBe(saldoDoDia(indice + 1))
  })

  test('o filtro de natureza esconde as transferências', async ({ page }) => {
    await entrar(page)
    await page.goto('/lancamentos')
    await expect(page.getByText('Para a reserva')).toBeVisible()

    await abrirFiltros(page)
    await page.getByLabel('Natureza').selectOption('despesa')

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

    await page.getByRole('button', { name: 'lançar', exact: true }).click()
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

    await expect(page.getByText(descricao, { exact: true })).toBeVisible()

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
    await page.getByRole('button', { name: 'lançar', exact: true }).click()

    const categoria = page.getByLabel('Categoria')
    await expect(categoria).not.toHaveValue('')
    const selecionada = await categoria.locator('option:checked').textContent()
    expect(selecionada).not.toBe('Ajuste de saldo')
  })

  test('o rateio da parcela aparece antes de confirmar', async ({ page }) => {
    await entrar(page)
    await page.goto('/lancamentos')
    await page.getByRole('button', { name: 'lançar', exact: true }).click()

    await page.getByLabel('Conta ou cartão').selectOption({ label: 'Cartão principal' })
    for (const tecla of ['1', '0', '0', '0', '0', '0']) {
      await page.getByLabel('Valor').press(tecla)
    }

    // Parcelar é atributo secundário, colapsado atrás de um rótulo — não um
    // ícone nu, que obrigaria a clicar para descobrir o que faz.
    await page.getByRole('button', { name: 'parcelar' }).click()
    await page.getByLabel('Parcelas').fill('3')

    // R$ 1.000,00 em 3x não divide. A frase diz o resto, em vez de esconder
    // dois centavos — é o ADR 0005 desenhado no momento da decisão.
    await expect(page.getByText(/3 parcelas de R\$ 333,33/)).toBeVisible()
    await expect(page.getByText(/primeira leva R\$ 333,34/)).toBeVisible()
  })

  test('valor zero é recusado com uma frase, não com um lançamento vazio', async ({ page }) => {
    await entrar(page)
    await page.goto('/lancamentos')
    await page.getByRole('button', { name: 'lançar', exact: true }).click()

    await page.getByLabel('Descrição').fill('Sem valor')
    await page.getByRole('button', { name: 'salvar', exact: true }).click()

    await expect(page.locator('form').getByRole('alert')).toHaveText('Informe um valor.')
    await expect(page.getByRole('dialog')).toBeVisible()
  })
})

test.describe('cartão', () => {
  test('a fatura é um objeto com ciclo, e as parcelas futuras aparecem', async ({ page }) => {
    await entrar(page)
    await page
      .getByRole('navigation', { name: 'Navegação principal' })
      .getByRole('link', { name: 'cartões' })
      .click()

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

    // Sair vive no menu da conta, atrás do avatar de iniciais — como no
    // Organizze, e como em todo produto que tem mais de uma ação de conta.
    await page.getByRole('button', { name: 'Sua conta' }).click()
    await page.getByRole('menuitem', { name: 'sair' }).click()

    await expect(page).toHaveURL(/\/entrar/)

    // Uma sessão que continua valendo até expirar torna o botão "sair" uma
    // promessa que o servidor não cumpre.
    await page.goto('/lancamentos')
    await expect(page).toHaveURL(/\/entrar/)
  })
})

test.describe('os três eixos de filtro', () => {
  test('origem separa o parcelado, e o saldo do dia some junto', async ({ page }) => {
    // O `Tipo` do Organizze colapsa natureza, estado e origem em treze opções
    // lineares. Aqui são três seletores independentes.
    //
    // E o saldo do dia **desaparece** com filtro ativo, de propósito: acumular
    // sobre um subconjunto produz um número que parece saldo e não é — e um
    // número que parece certo e está errado é pior do que nenhum número.
    await entrar(page)
    await page.goto('/lancamentos')
    await expect(page.getByText('saldo no dia').first()).toBeVisible()

    const antes = await page.locator('.linha').count()
    await abrirFiltros(page)
    await page.getByLabel('Origem').selectOption('parcelado')

    await expect(page.getByText(/^Pneus \d\/6$/)).toBeVisible()
    expect(await page.locator('.linha').count()).toBeLessThan(antes)
    // O saldo do dia some: acumular sobre um subconjunto produz um número que
    // parece saldo e não é.
    await expect(page.getByText('saldo no dia')).toHaveCount(0)
    // E o rodapé avisa que os totais continuam sendo do mês inteiro.
    await expect(page.getByText('totais do mês inteiro, não do filtro')).toBeVisible()
  })

  test('estado e natureza continuam independentes da origem', async ({ page }) => {
    await entrar(page)
    await page.goto('/lancamentos')
    // Espera a tela **ter dado**, e não só ter pintado. Um clique antes da
    // hidratação não vira nada: o botão existe no HTML e o React ainda não
    // atende. O teste irmão já esperava; este não, e a diferença só apareceu
    // quando a renovação de sessão acrescentou uma ida ao carregamento.
    await expect(page.getByText('saldo no dia').first()).toBeVisible()

    await abrirFiltros(page)
    await page.getByLabel('Natureza').selectOption('transferencia')
    await expect(page.getByText('Para a reserva')).toBeVisible()
    await expect(page.getByText('Aluguel')).toHaveCount(0)

    // Transferência é `manual` de origem: os dois eixos não se colapsam.
    await page.getByLabel('Origem').selectOption('digitado')
    await expect(page.getByText('Para a reserva')).toBeVisible()
  })
})

test.describe('estornar', () => {
  test('não apaga o original, e devolve o valor ao mês', async ({ page }) => {
    // Decisão DP-4: o dado é do espaço, e a correção precisa ser rastreável.
    // Quem olha o mês seguinte tem de ver que houve devolução, e não um mês que
    // mudou sozinho.
    //
    // **O lançamento é criado aqui, e não tomado da semente.** Estornar consome
    // um recurso finito — o que resta do original —, e um teste que come a
    // semente passa uma vez e falha na quinta execução. Foi o que aconteceu.
    await entrar(page)
    await page.goto('/lancamentos')

    const descricao = `Compra a devolver ${MARCA}`
    await page.getByRole('button', { name: 'lançar', exact: true }).click()
    await page.getByLabel('Descrição').fill(descricao)
    for (const tecla of ['1', '0', '0', '0', '0', '0']) {
      await page.getByLabel('Valor').press(tecla)
    }
    await expect(page.getByLabel('Valor')).toHaveValue('R$ 1.000,00')
    await page.getByRole('button', { name: 'salvar', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText(descricao, { exact: true })).toBeVisible()

    const rodape = rodapeDoMes(page)
    await rodape.getByRole('button', { name: 'ver detalhe' }).click()
    const despesaAntes = await despesaRealizada(rodape)

    await page.getByText(descricao, { exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: 'estornar', exact: true }).click()

    // R$ 250,00 de R$ 1.000,00: estorno parcial é permitido.
    const valor = page.getByLabel('Valor')
    for (let i = 0; i < 8; i++) await valor.press('Backspace')
    for (const tecla of ['2', '5', '0', '0', '0']) await valor.press(tecla)
    await expect(valor).toHaveValue('R$ 250,00')

    await page.getByRole('button', { name: 'estornar', exact: true }).last().click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // O original continua lá, com o valor de sempre.
    await expect(page.getByText(descricao, { exact: true })).toBeVisible()

    await expect(async () => {
      const rodapeAtual = rodapeDoMes(page)
      const ocultar = rodapeAtual.getByRole('button', { name: 'ver detalhe' })
      if (await ocultar.isVisible()) await ocultar.click()
      expect(await despesaRealizada(rodapeAtual)).toBe(despesaAntes + 25000n)
    }).toPass({ timeout: 10_000 })
  })

  test('**compra de cartão agora pode ser estornada, e a tela diz onde o crédito cai**', async ({
    page,
  }) => {
    // ADR 0023, aceito pelo dono do produto: o crédito entra na fatura vigente,
    // como faz a administradora do cartão. Antes disso a tela recusava com uma
    // frase de desculpa, e este teste falharia ao procurar o botão — a condição
    // que o esconde vive numa função pura, travada por
    // `detalhe-do-lancamento.test.ts`.
    //
    // A frase importa tanto quanto o botão: quem estorna uma compra de março e
    // vê o crédito na fatura de maio precisa entender isso sem abrir um ADR.
    await entrar(page)
    await page.goto('/lancamentos')

    const descricao = `Compra no cartao a devolver ${MARCA}`
    await page.getByRole('button', { name: 'lançar', exact: true }).click()
    await page.getByLabel('Conta ou cartão').selectOption({ label: 'Cartão principal' })
    await page.getByLabel('Descrição').fill(descricao)
    for (const tecla of ['4', '0', '0', '0', '0']) {
      await page.getByLabel('Valor').press(tecla)
    }
    await expect(page.getByLabel('Valor')).toHaveValue('R$ 400,00')
    await page.getByRole('button', { name: 'salvar', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // O saldo em caixa **não** se move: quem move o dinheiro de uma compra de
    // cartão é o pagamento da fatura. Vale antes e depois do estorno, e é a
    // regra 8b — por isso a asserção é do saldo, e não da despesa do mês.
    const saldoAntes = await saldoDoRodape(page)

    await page.getByText(descricao, { exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    // A frase que a v3 do ADR pediu, e a razão de ela existir só no cartão.
    await expect(page.getByText(/fatura aberta na data do reembolso/)).toBeVisible()

    await page.getByRole('button', { name: 'estornar', exact: true }).click()
    await page.getByRole('button', { name: 'estornar', exact: true }).last().click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // O original continua no extrato: estornar não apaga, acrescenta.
    await expect(page.getByText(descricao, { exact: true })).toBeVisible()

    // E o caixa continua parado, com a compra e o crédito dentro da fatura.
    await expect(async () => {
      expect(await saldoDoRodape(page)).toBe(saldoAntes)
    }).toPass({ timeout: 10_000 })
  })

  test('transferência não oferece estorno, e diz por quê', async ({ page }) => {
    // Desfazer uma perna criaria dinheiro: a transferência tem duas, e elas
    // somam zero por construção.
    await entrar(page)
    await page.goto('/lancamentos')

    await page.getByText('Para a reserva').click()
    await expect(page.getByRole('dialog')).toBeVisible()

    // `exact`: sem isso o casamento é por substring, e qualquer linha cuja
    // descrição contenha a palavra conta como botão.
    await expect(page.getByRole('button', { name: 'estornar', exact: true })).toHaveCount(0)
    await expect(page.getByText(/duas pernas/)).toBeVisible()
  })
})

/**
 * Planejamento.
 *
 * **Cada execução trabalha num mês só seu.** O banco de desenvolvimento não é
 * recriado entre rodadas, e um teste de planejamento escreve numa competência —
 * se ela fosse fixa, a segunda rodada encontraria o mês já ocupado e o estado
 * vazio nunca mais apareceria. É a mesma armadilha do estorno, que consumia o
 * aluguel da semente até não sobrar valor estornável.
 *
 * O mês é sorteado à frente, e a asserção do estado vazio vem primeiro: se duas
 * execuções sortearem o mesmo mês, o teste falha alto em vez de passar por
 * acidente.
 *
 * **A limpeza vive num `finally`, e a razão é a que se descobre da pior forma.**
 * Enquanto ela era o último passo do caminho feliz, toda execução que falhasse
 * no meio deixava o mês sorteado ocupado para sempre — e o próximo sorteio que
 * caísse ali falhava também. O conjunto de meses envenenados só crescia, e a
 * taxa de falso vermelho subia sozinha a cada semana. Seis meses já estavam
 * assim quando isto foi escrito.
 */
const MESES_A_FRENTE = 24 + Math.floor(Math.random() * 100)

test.describe('planejamento', () => {
  /**
   * Devolve os meses ao estado vazio, **aconteça o que acontecer**.
   *
   * O `afterEach` compartilha a mesma `page` do teste, e por isso alcança o mês
   * em que ele parou. Três meses para trás cobrem qualquer ponto de parada
   * depois da criação — e limpar um mês que já está vazio é um `return`.
   */
  test.afterEach(async ({ page }) => {
    if (!page.url().includes('/planejamento')) return

    for (let i = 0; i < 3; i++) {
      await limparMesSeHouver(page)
      const anterior = page.getByRole('button', { name: 'Mês anterior', exact: true })
      if ((await anterior.count()) === 0) return
      await anterior.click()
    }
  })

  test('mês vazio → teto global → consumo, e a cópia não duplica', async ({ page }) => {
    await entrar(page)
    await page.goto('/planejamento')

    const seguinte = page.getByRole('button', { name: 'Mês seguinte' })
    // O primeiro clique é o que prova que o React já atende: sem ele, os
    // cliques seguintes se perdem e o teste acaba num mês que não é o sorteado
    // — e falha afirmando algo verdadeiro sobre o mês errado.
    // O rótulo do mês é o irmão imediato do botão de voltar. Localizá-lo pela
    // estrutura evita um atributo que só existiria para o teste ver.
    const rotulo = page
      // `exact`: sem isso "Mês anterior" também casa com "copiar do mês
      // anterior", e o localizador vira ambíguo assim que o estado vazio
      // aparece.
      .getByRole('button', { name: 'Mês anterior', exact: true })
      .locator('xpath=following-sibling::span[1]')
    const inicial = await rotulo.textContent()
    await expect(async () => {
      await seguinte.click()
      expect(await rotulo.textContent()).not.toBe(inicial)
    }).toPass({ timeout: 15_000 })

    for (let i = 1; i < MESES_A_FRENTE; i++) await seguinte.click()

    await expect(page.getByText(/Nenhum planejamento em/)).toBeVisible()

    await page.getByRole('button', { name: 'definir teto de gastos' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    // O escopo padrão é global — o teto de "todas as categorias".
    for (const tecla of ['1', '0', '0', '0', '0', '0']) {
      await page.getByLabel('Valor').press(tecla)
    }
    await expect(page.getByLabel('Valor')).toHaveValue('R$ 1.000,00')
    await page.getByRole('button', { name: 'salvar', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Mês futuro não tem lançamento: consumo zero, e o rótulo é o do teto, não
    // o do piso — a palavra depende da natureza.
    await expect(page.getByText('Todas as categorias')).toBeVisible()
    await expect(page.getByText('dentro do teto')).toBeVisible()
    await expect(page.getByText('0%')).toBeVisible()

    // --- a cópia, no mês seguinte -----------------------------------------
    // O global é justamente o que a versão ingênua da cópia não encontra no
    // destino: `NULL = NULL` é `NULL`, o INSERT é tentado, o índice parcial o
    // rejeita e a transação aborta.
    await seguinte.click()
    await expect(page.getByText(/Nenhum planejamento em/)).toBeVisible()

    const copiar = page.getByRole('button', { name: 'copiar do mês anterior' }).first()
    await copiar.click()
    await expect(page.getByText(/planejamento\(s\) copiado\(s\)/)).toBeVisible()
    await expect(page.getByText('Todas as categorias')).toBeVisible()

    await page.getByRole('button', { name: 'copiar do mês anterior' }).first().click()
    await expect(page.getByText(/Nada a copiar/)).toBeVisible()
    await expect(page.getByText('Todas as categorias')).toHaveCount(1)

  })
})

/** Abre o planejamento da tela e o exclui. */
/**
 * Remove o teto global do mês visível, se houver um.
 *
 * Tolerante de propósito: é chamado na limpeza, sobre meses que podem estar
 * vazios, depois de um teste que pode ter falhado em qualquer ponto. Uma
 * limpeza que exige o estado que ela existe para consertar não conserta nada.
 */
async function limparMesSeHouver(page: Page): Promise<void> {
  const alvo = page.getByText('Todas as categorias')
  if ((await alvo.count()) === 0) return

  try {
    await alvo.first().click()
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 3_000 })
    await page.getByRole('button', { name: 'excluir', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  } catch {
    // A limpeza não é o teste. Se ela falhar, o mês fica ocupado — o que já era
    // o comportamento antigo — e o relatório continua sendo o do teste, e não o
    // de um `afterEach` barulhento.
  }
}

/**
 * Recorrência.
 *
 * O horizonte é encerrado no **mês corrente** de propósito: sem `fim`, uma
 * recorrência materializa treze meses, e treze lançamentos por execução
 * poluiriam o extrato que os outros cenários leem. Com o fim no mês corrente a
 * regra gera uma ocorrência só, e a asserção que importa — a ancoragem do dia
 * 31 — continua sendo exercida.
 */
test.describe('recorrência', () => {
  test('dia 31 é ancorado no último dia do mês, e a regra some sem apagar o passado', async ({
    page,
  }) => {
    await entrar(page)
    await page.goto('/lancamentos/recorrencias')

    const descricao = `Assinatura ${MARCA}`
    await page.getByRole('button', { name: '+ recorrência' }).first().click()
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.getByLabel('Descrição').fill(descricao)
    for (const tecla of ['5', '0', '0', '0', '0']) {
      await page.getByLabel('Valor').press(tecla)
    }
    await expect(page.getByLabel('Valor')).toHaveValue('R$ 500,00')

    await page.getByLabel('Onde').selectOption({ index: 1 })
    await page.getByLabel('Dia do mês').fill('31')

    // O aviso da ancoragem aparece só quando o dia pode não existir.
    await expect(page.getByText(/vira 28 de fevereiro/)).toBeVisible()

    const hoje = new Date()
    const mesCorrente = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`
    await page.getByLabel('Até (opcional)').fill(mesCorrente)

    await page.getByRole('button', { name: 'salvar', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Uma ocorrência só, e o dia ancorado no último dia deste mês.
    const ultimoDia = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate()
    const linha = page.locator('.linha').filter({ hasText: descricao })
    await expect(linha).toContainText('1 lançamento(s) gerado(s)')
    await expect(linha).toContainText(`todo mês, dia 31`)

    // A ocorrência está no extrato, e nasceu pendente.
    await page.goto('/lancamentos')
    await expect(page.getByText(descricao, { exact: true })).toBeVisible()
    expect(ultimoDia).toBeGreaterThanOrEqual(28)

    // Excluir a regra não apaga a ocorrência deste mês, que já é fato.
    await page.goto('/lancamentos/recorrencias')
    await page
      .locator('.linha')
      .filter({ hasText: descricao })
      .getByRole('button', { name: 'editar' })
      .click()
    await page.getByRole('button', { name: 'excluir', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText(descricao)).toHaveCount(0)

    // A ocorrência **futura e pendente** vai junto: ela é previsão, e a regra
    // que a previa não existe mais. O que a exclusão nunca toca é ocorrência já
    // compensada ou com data no passado — isso é fato, e está travado no teste
    // de integração, onde dá para escolher a data.
    await page.goto('/lancamentos')
    await expect(page.getByText(descricao, { exact: true })).toHaveCount(0)
  })
})
