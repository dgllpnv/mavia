import { useQuery } from '@tanstack/react-query'
import { randomUUID } from 'expo-crypto'
import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { chamar } from '../src/nucleo/api'
import { enfileirar, guardar, lerCache, lerFila } from '../src/nucleo/deposito'
import { criarMutacao, pendentes, precisamDeAtencao, type Mutacao } from '../src/nucleo/fila'
import { sincronizar } from '../src/nucleo/sincronizador'
import { cor, espaco } from '../src/componentes/tema'
import { useSessao } from './_layout'

/**
 * A tela inicial: saldo, e o caminho de três toques até uma despesa.
 *
 * **Os três toques.** "despesa" → dígitos do valor → "salvar". Categoria e
 * conta usam o último que a pessoa usou, e a tela diz qual. Um seletor
 * obrigatório de categoria antes do valor é o que faz quem está na fila do
 * caixa desistir e anotar no papel.
 *
 * **O saldo aparece offline.** Ele vem do cache local, e o cabeçalho diz de
 * quando é. Esconder um número que a própria pessoa produziu, porque a rede
 * caiu, é protegê-la de nada.
 */

interface Conta {
  readonly id: string
  readonly nome: string
  readonly saldoCentavos: string
}

interface Categoria {
  readonly id: string
  readonly nome: string
  readonly natureza: 'receita' | 'despesa'
  readonly analitica: boolean
  readonly arquivada: boolean
}

export default function Inicio() {
  const { eu, tenantId, sair } = useSessao()
  const router = useRouter()
  const [fila, setFila] = useState<readonly Mutacao[]>([])

  useEffect(() => {
    void lerFila().then(setFila)
  }, [])

  const contas = useQuery({
    queryKey: ['contas', tenantId],
    enabled: tenantId !== null,
    async queryFn() {
      const chave = 'contas'
      try {
        const r = await chamar<{ itens: Conta[] }>('/contas', { tenantId: tenantId! })
        await guardar(tenantId!, chave, r)
        return { dados: r, guardadoEm: Date.now(), doCache: false }
      } catch (erro) {
        const guardado = await lerCache<{ itens: Conta[] }>(tenantId!, chave)
        if (!guardado) throw erro
        return { dados: guardado.conteudo, guardadoEm: guardado.guardadoEm, doCache: true }
      }
    },
  })

  const total = (contas.data?.dados.itens ?? []).reduce(
    (s, c) => s + BigInt(c.saldoCentavos),
    0n,
  )

  const naFila = pendentes(fila)
  const travadas = precisamDeAtencao(fila)

  return (
    <ScrollView style={{ flex: 1, backgroundColor: cor.fundo }} contentContainerStyle={{ padding: espaco.x5 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={{ color: cor.tinta0, fontSize: 20, fontWeight: '700', flex: 1 }}>
          {eu?.usuario.nome ?? 'Mavia'}
        </Text>
        <Pressable accessibilityRole="button" onPress={() => void sair()}>
          <Text style={{ color: cor.tinta3 }}>sair</Text>
        </Pressable>
      </View>

      <View
        style={{
          marginTop: espaco.x5,
          backgroundColor: cor.superficie,
          borderRadius: 14,
          padding: espaco.x5,
        }}
      >
        <Text style={{ color: cor.tinta3, fontSize: 12, letterSpacing: 1 }}>SALDO GERAL</Text>
        <Text
          accessibilityLabel={`Saldo geral: ${formatar(total)}`}
          style={{ color: cor.tinta0, fontSize: 34, fontWeight: '700', marginTop: espaco.x2 }}
        >
          {formatar(total)}
        </Text>

        {contas.data?.doCache && (
          <Text style={{ color: cor.atencao, marginTop: espaco.x2, fontSize: 12 }}>
            Sem conexão — mostrando o que foi guardado{' '}
            {quandoFoi(contas.data.guardadoEm)}.
          </Text>
        )}
      </View>

      {(naFila > 0 || travadas.length > 0) && (
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push('/pendencias')}
          style={{
            marginTop: espaco.x4,
            borderRadius: 12,
            padding: espaco.x4,
            backgroundColor: travadas.length > 0 ? '#3A1F1B' : cor.superficie2,
          }}
        >
          <Text style={{ color: travadas.length > 0 ? cor.despesa : cor.tinta2 }}>
            {travadas.length > 0
              ? `${travadas.length} lançamento(s) precisam de atenção`
              : `${naFila} lançamento(s) esperando conexão`}
          </Text>
        </Pressable>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Lançar despesa"
        onPress={() => router.push('/lancar')}
        style={{
          marginTop: espaco.x6,
          backgroundColor: cor.marca,
          borderRadius: 14,
          padding: espaco.x6,
        }}
      >
        <Text style={{ color: cor.tinta0, fontSize: 18, fontWeight: '700', textAlign: 'center' }}>
          despesa
        </Text>
      </Pressable>

      <Text style={{ color: cor.tinta3, marginTop: espaco.x5, fontSize: 13, lineHeight: 19 }}>
        Lançar funciona sem internet. O que você registrar fica guardado no
        aparelho e sobe sozinho quando a conexão voltar — uma vez só, mesmo que o
        envio tenha sido interrompido no meio.
      </Text>
    </ScrollView>
  )
}

/**
 * Enfileira uma despesa. Exportada porque a tela de lançar a usa, e porque é o
 * ponto em que a identidade da intenção nasce.
 */
export async function enfileirarDespesa(
  tenantId: string,
  dados: { contaId: string; categoriaId: string; centavos: string; descricao: string },
): Promise<void> {
  const mutacao = criarMutacao(
    {
      // A chave nasce **aqui**, com a intenção. Gerá-la no envio faria cada
      // retentativa ter uma chave nova, que é o mesmo que não ter chave.
      id: randomUUID(),
      metodo: 'POST',
      caminho: '/lancamentos',
      tenantId,
      corpo: {
        contaId: dados.contaId,
        categoriaId: dados.categoriaId,
        valorCentavos: `-${dados.centavos}`,
        postedAt: new Date().toISOString(),
        compensado: true,
        descricao: dados.descricao,
      },
    },
    Date.now(),
  )

  await enfileirar(mutacao)
  // Tenta subir na hora; se não der, o laço do `AppState` pega depois.
  void sincronizar()
}

export type { Conta, Categoria }

function formatar(centavos: bigint): string {
  const negativo = centavos < 0n
  const abs = negativo ? -centavos : centavos
  const reais = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const resto = (abs % 100n).toString().padStart(2, '0')
  return `${negativo ? '−' : ''}R$ ${reais},${resto}`
}

function quandoFoi(instante: number): string {
  const minutos = Math.floor((Date.now() - instante) / 60_000)
  if (minutos < 1) return 'agora'
  if (minutos < 60) return `há ${minutos} min`
  const horas = Math.floor(minutos / 60)
  if (horas < 24) return `há ${horas} h`
  return `há ${Math.floor(horas / 24)} d`
}
