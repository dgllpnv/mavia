import type { FullConfig } from '@playwright/test'
import { dispensaDe, rotasDoDisco } from './rotas'

/**
 * A guarda: **o servidor na porta é o deste worktree, ou a suíte não roda.**
 *
 * ## O defeito que ela existe para tornar impossível
 *
 * `webServer.reuseExistingServer` é verdadeiro, e é assim que a suíte não sobe
 * um Next a cada execução. O efeito colateral é caro: se **qualquer outro**
 * processo já estiver escutando em `127.0.0.1:4710` — um `pnpm dev` do
 * diretório principal, um worktree irmão, um servidor esquecido de ontem —, o
 * Playwright se pendura nele e mede um código que não é o que está sendo
 * revisado.
 *
 * Isso aconteceu de verdade, em 2026-09-05, durante o épico do mobile web: a
 * primeira execução desta própria suíte rodou oito minutos contra o servidor do
 * diretório principal. `/mais` e `/lancar` — as duas rotas que os tickets 01 e
 * 03 tinham acabado de criar — respondiam **404**, e `/` respondia **500**.
 * Nenhuma linha do trabalho do épico foi medida.
 *
 * O que torna esse defeito diferente de um teste que falha é a direção do erro:
 * ele produz **verde**. E um verde falso não é a ausência de evidência, é
 * evidência falsa — alguém escreve "está provado" e a frase circula. Por isso a
 * guarda aborta a suíte inteira em vez de marcar um teste como falho.
 *
 * ## Por que a sonda é a tabela de rotas, e não uma marca inventada
 *
 * Um cabeçalho `X-Worktree`, uma variável de ambiente ou um endpoint `/__quem`
 * seriam código de produção existindo só para o teste ler — e código assim se
 * quebra sem ninguém notar, justamente porque nada de verdade depende dele.
 *
 * Uma rota **existe ou não existe**, e isso é um fato do servidor. A sonda aqui
 * é: *toda rota estática que este worktree tem em `src/app` precisa responder
 * algo diferente de 404*. Ela não depende de escolher um nome a dedo — `/mais`
 * hoje, e a rota que o próximo ticket criar amanhã —, e fica **mais forte** a
 * cada tela nova, sem ninguém manter nada. É a mesma propriedade que
 * `rotas.ts` persegue, aplicada ao servidor em vez de ao disco.
 *
 * Efeito colateral desejado: em `next dev` a rota compila sob demanda, e esta
 * varredura **aquece** todas elas. Sem isso, o primeiro teste de cada rota paga
 * a compilação dentro do próprio prazo e reprova por lentidão de compilador —
 * vermelho que não é defeito de produto ensina o time a ignorar vermelho.
 */

/** Quantas rotas sondar ao mesmo tempo. Compilação sob demanda é o gargalo. */
const EM_PARALELO = 6

/** Prazo por rota. A primeira compilação de uma tela grande não é rápida. */
const PRAZO_POR_ROTA = 90_000

/** Quanto esperar o servidor começar a atender, antes de desistir. */
const PRAZO_ATE_ATENDER = 120_000

interface Resposta {
  readonly rota: string
  readonly status: number
}

async function status(base: string, rota: string): Promise<Resposta> {
  const r = await fetch(new URL(rota, base), {
    redirect: 'manual',
    signal: AbortSignal.timeout(PRAZO_POR_ROTA),
  })
  return { rota, status: r.status }
}

/** Espera o servidor atender qualquer coisa — ele pode estar subindo. */
async function esperarAtender(base: string): Promise<void> {
  const limite = Date.now() + PRAZO_ATE_ATENDER
  let ultimo = 'sem resposta'

  while (Date.now() < limite) {
    try {
      await fetch(new URL('/entrar', base), { signal: AbortSignal.timeout(15_000) })
      return
    } catch (e) {
      ultimo = e instanceof Error ? e.message : String(e)
      await new Promise((pronto) => setTimeout(pronto, 1_000))
    }
  }

  throw new Error(
    `ninguém atende em ${base} (${ultimo}).\n` +
      'Suba o ambiente: `mavia`, `pnpm db:migrate`, `pnpm db:seed`, e a API em 127.0.0.1:4711.',
  )
}

export default async function guardarOServidor(config: FullConfig): Promise<void> {
  const base = config.projects[0]?.use.baseURL
  if (typeof base !== 'string') {
    throw new Error('nenhum `baseURL` configurado — a guarda não sabe o que sondar.')
  }

  await esperarAtender(base)

  const alvos = rotasDoDisco()
    .filter((r) => !r.dinamica)
    .filter((r) => dispensaDe(r) === undefined)
    .map((r) => r.padrao)

  const desconhecidas: Resposta[] = []
  const fila = [...alvos]

  await Promise.all(
    Array.from({ length: Math.min(EM_PARALELO, fila.length) }, async () => {
      for (let rota = fila.shift(); rota !== undefined; rota = fila.shift()) {
        // Rota autenticada responde 200 com o HTML do cliente — o desvio para
        // `/entrar` acontece no navegador, não aqui. O que interessa é só o
        // 404: ele significa "esta tela não existe neste servidor".
        const r = await status(base, rota)
        if (r.status === 404) desconhecidas.push(r)
      }
    }),
  )

  if (desconhecidas.length > 0) {
    const lista = desconhecidas
      .map((d) => `  ${d.rota} → 404`)
      .sort((a, b) => a.localeCompare(b))
      .join('\n')

    throw new Error(
      `\nO servidor em ${base} NÃO serve este worktree.\n\n` +
        `${desconhecidas.length} rota(s) que existem em src/app deste worktree ` +
        `não existem lá:\n${lista}\n\n` +
        'Quase sempre é um `pnpm dev` de outro diretório (o principal, ou um ' +
        'worktree irmão) ocupando a porta. Ache e pare o processo:\n\n' +
        '  netstat -ano | findstr :4710\n' +
        '  taskkill /PID <pid> /F\n\n' +
        'Depois rode `pnpm dev` a partir DESTE worktree e repita a suíte.\n\n' +
        'A suíte parou aqui de propósito. Rodar assim mediria o código de ' +
        'outra pessoa e passaria em verde — e verde falso é pior do que ' +
        'vermelho, porque vira a frase "está provado".\n',
    )
  }
}
