import { useRouter } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { enfileirar, lerFila, retirar } from '../src/nucleo/deposito'
import { precisamDeAtencao, tentarDeNovo, type Mutacao } from '../src/nucleo/fila'
import { sincronizar } from '../src/nucleo/sincronizador'
import { cor, espaco } from '../src/componentes/tema'

/**
 * A fila, visível.
 *
 * Existe porque a alternativa é pior: um app que engole silenciosamente o
 * lançamento que o servidor recusou faz a pessoa descobrir a falta de R$ 80 no
 * fim do mês, sem saber onde procurar. Aqui ela vê a intenção, o motivo, e tem
 * dois caminhos honestos — tentar de novo, ou descartar sabendo o que descarta.
 *
 * **Descartar exige um segundo toque** justamente porque é a única ação deste
 * app que apaga dinheiro registrado.
 */
export default function Pendencias() {
  const router = useRouter()
  const [fila, setFila] = useState<readonly Mutacao[]>([])
  const [confirmando, setConfirmando] = useState<string | null>(null)

  const recarregar = useCallback(async () => setFila(await lerFila()), [])

  useEffect(() => {
    void recarregar()
  }, [recarregar])

  const travadas = precisamDeAtencao(fila)
  const esperando = fila.filter((m) => m.estado === 'pendente')

  return (
    <ScrollView style={{ flex: 1, backgroundColor: cor.fundo }} contentContainerStyle={{ padding: espaco.x5 }}>
      <Pressable accessibilityRole="button" onPress={() => router.back()}>
        <Text style={{ color: cor.tinta3 }}>← voltar</Text>
      </Pressable>

      <Text style={{ color: cor.tinta0, fontSize: 22, fontWeight: '700', marginTop: espaco.x4 }}>
        Esperando para subir
      </Text>

      {esperando.length === 0 && travadas.length === 0 && (
        <Text style={{ color: cor.tinta3, marginTop: espaco.x4 }}>
          Nada pendente. Tudo o que você lançou já chegou ao servidor.
        </Text>
      )}

      {esperando.map((m) => (
        <View key={m.id} style={cartao}>
          <Text style={{ color: cor.tinta1 }}>{descricaoDe(m)}</Text>
          <Text style={{ color: cor.tinta3, marginTop: espaco.x1, fontSize: 13 }}>
            {m.tentativas === 0
              ? 'Aguardando conexão'
              : `${m.tentativas} tentativa(s) — a próxima é automática`}
          </Text>
        </View>
      ))}

      {travadas.length > 0 && (
        <>
          <Text style={{ color: cor.despesa, fontSize: 18, fontWeight: '700', marginTop: espaco.x6 }}>
            Precisam de atenção
          </Text>
          <Text style={{ color: cor.tinta3, marginTop: espaco.x2, fontSize: 13, lineHeight: 19 }}>
            Estes não subiram, e não vão subir sozinhos. Nada foi perdido — eles
            continuam guardados aqui até você decidir.
          </Text>
        </>
      )}

      {travadas.map((m) => (
        <View key={m.id} style={{ ...cartao, borderColor: cor.despesa }}>
          <Text style={{ color: cor.tinta1 }}>{descricaoDe(m)}</Text>
          <Text style={{ color: cor.despesa, marginTop: espaco.x1, fontSize: 13 }}>{m.motivo}</Text>

          <View style={{ flexDirection: 'row', marginTop: espaco.x3 }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void (async () => {
                  await enfileirar(tentarDeNovo(m))
                  await sincronizar()
                  await recarregar()
                })()
              }}
              style={{ marginRight: espaco.x5 }}
            >
              <Text style={{ color: cor.tinta0 }}>tentar de novo</Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (confirmando === m.id) {
                  void (async () => {
                    await retirar(m.id)
                    setConfirmando(null)
                    await recarregar()
                  })()
                } else {
                  setConfirmando(m.id)
                }
              }}
            >
              <Text style={{ color: cor.despesa }}>
                {confirmando === m.id ? 'confirmar: apagar de vez' : 'descartar'}
              </Text>
            </Pressable>
          </View>
        </View>
      ))}
    </ScrollView>
  )
}

const cartao = {
  marginTop: espaco.x3,
  borderWidth: 1,
  borderColor: cor.linha,
  borderRadius: 12,
  padding: espaco.x4,
  backgroundColor: cor.superficie,
} as const

/** O que a pessoa reconhece: a descrição e o valor que ela digitou. */
function descricaoDe(m: Mutacao): string {
  const corpo = m.corpo as { descricao?: string; valorCentavos?: string } | null
  if (!corpo?.descricao) return m.caminho
  const centavos = BigInt(corpo.valorCentavos ?? '0')
  const abs = centavos < 0n ? -centavos : centavos
  return `${corpo.descricao} — R$ ${(abs / 100n).toString()},${(abs % 100n)
    .toString()
    .padStart(2, '0')}`
}
