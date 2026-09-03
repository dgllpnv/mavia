import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AppState, Text, View } from 'react-native'
import { entrar as entrarNaApi, chamar, renovar, sair as sairDaApi, temSessaoGuardada, type Eu } from '../src/nucleo/api'
import { limparTudo } from '../src/nucleo/deposito'
import { sincronizar } from '../src/nucleo/sincronizador'
import { cor } from '../src/componentes/tema'

/**
 * A casca do app.
 *
 * Duas responsabilidades, e nada além: manter quem é o usuário, e **empurrar a
 * fila quando o app volta à frente**. A segunda é o que faz o offline-first
 * funcionar sem o usuário pensar nele — quem lançou no mercado sem rede vê o
 * lançamento subir sozinho quando destrava o telefone em casa.
 */

interface Sessao {
  readonly eu: Eu | null
  readonly carregando: boolean
  readonly tenantId: string | null
  entrar(email: string, senha: string): Promise<void>
  sair(): Promise<void>
}

const ContextoDaSessao = createContext<Sessao | null>(null)

export function useSessao(): Sessao {
  const s = useContext(ContextoDaSessao)
  if (!s) throw new Error('useSessao fora do provedor')
  return s
}

const fila = new QueryClient({
  defaultOptions: {
    queries: {
      // Nada de tentar de novo sozinho numa leitura: offline, a retentativa
      // gasta bateria para chegar ao mesmo lugar. Quem tem cache mostra o
      // cache; quem não tem, mostra o vazio e um botão.
      retry: false,
      staleTime: 60_000,
    },
  },
})

export default function Raiz() {
  return (
    <QueryClientProvider client={fila}>
      <ProvedorDeSessao>
        <StatusBar style="light" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: cor.fundo } }} />
      </ProvedorDeSessao>
    </QueryClientProvider>
  )
}

function ProvedorDeSessao({ children }: { children: ReactNode }) {
  const [eu, setEu] = useState<Eu | null>(null)
  const [carregando, setCarregando] = useState(true)
  const router = useRouter()
  const segmentos = useSegments()

  useEffect(() => {
    let vivo = true
    void (async () => {
      // Renova **antes** de perguntar, como no web: quem não tem sessão
      // guardada descobre isso sem uma ida à rede, e quem tem paga uma só.
      if (!(await temSessaoGuardada())) {
        if (vivo) setCarregando(false)
        return
      }
      const renovou = await renovar()
      if (!renovou) {
        if (vivo) setCarregando(false)
        return
      }
      try {
        const r = await chamar<Eu>('/eu')
        if (vivo) setEu(r)
      } catch {
        // Sem rede e com sessão guardada: o app continua utilizável em modo
        // offline, e `eu` só é preenchido quando a rede voltar.
      } finally {
        if (vivo) setCarregando(false)
      }
    })()
    return () => {
      vivo = false
    }
  }, [])

  /**
   * A fila sobe quando o app volta à frente.
   *
   * É o gatilho que cobre o caso real: a pessoa lança no caixa do mercado com o
   * telefone sem sinal, guarda no bolso, e o app volta à frente em casa. Sem
   * isto, o lançamento só subiria no próximo toque dela.
   */
  useEffect(() => {
    if (!eu) return
    void sincronizar()

    const inscricao = AppState.addEventListener('change', (estado) => {
      if (estado === 'active') void sincronizar()
    })
    return () => inscricao.remove()
  }, [eu])

  useEffect(() => {
    if (carregando) return
    const naEntrada = segmentos[0] === 'entrar'
    if (!eu && !naEntrada) router.replace('/entrar')
    if (eu && naEntrada) router.replace('/')
  }, [eu, carregando, segmentos, router])

  const valor = useMemo<Sessao>(
    () => ({
      eu,
      carregando,
      tenantId: eu?.tenants[0]?.id ?? null,
      async entrar(email, senha) {
        setEu(await entrarNaApi(email, senha))
      },
      async sair() {
        await sairDaApi()
        // O local vai junto: sair é dizer "este aparelho não é mais meu", e
        // deixar intenções não enviadas ali seria deixar o dinheiro de alguém
        // num telefone que ela acabou de entregar.
        await limparTudo()
        setEu(null)
      },
    }),
    [eu, carregando],
  )

  if (carregando) {
    return (
      <View style={{ flex: 1, backgroundColor: cor.fundo, justifyContent: 'center' }}>
        <Text style={{ color: cor.tinta3, textAlign: 'center' }}>Carregando…</Text>
      </View>
    )
  }

  return <ContextoDaSessao.Provider value={valor}>{children}</ContextoDaSessao.Provider>
}
