import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { chamar } from '../src/nucleo/api'
import { guardar, lerCache } from '../src/nucleo/deposito'
import { cor, espaco } from '../src/componentes/tema'
import { enfileirarDespesa, type Categoria, type Conta } from './index'
import { useSessao } from './_layout'

/**
 * Lançar uma despesa — o segundo e o terceiro toque.
 *
 * **Teclado próprio, e não o do sistema.** O teclado numérico do telefone tem
 * vírgula, ponto e às vezes letras; num campo de dinheiro isso vira um valor
 * que o servidor recusa depois de a pessoa já ter guardado o telefone. Aqui os
 * dígitos entram pela direita, em centavos, e não existe estado inválido a
 * recusar — é o mesmo `CampoDeValor` do web, com as teclas desenhadas.
 *
 * **Conta e categoria têm padrão e ficam visíveis.** Escondê-las faria o app
 * decidir por baixo do pano; exigi-las antes do valor faria quem está na fila
 * do caixa desistir. Elas aparecem embaixo, tocáveis, já preenchidas.
 */
export default function Lancar() {
  const { tenantId } = useSessao()
  const router = useRouter()

  const [centavos, setCentavos] = useState('0')
  const [descricao, setDescricao] = useState('')
  const [contaId, setContaId] = useState<string | null>(null)
  const [categoriaId, setCategoriaId] = useState<string | null>(null)
  const [salvando, setSalvando] = useState(false)

  const contas = useQuery({
    queryKey: ['contas', tenantId],
    enabled: tenantId !== null,
    queryFn: () => comCache<{ itens: Conta[] }>(tenantId!, 'contas', '/contas'),
  })

  const categorias = useQuery({
    queryKey: ['categorias', tenantId],
    enabled: tenantId !== null,
    queryFn: () => comCache<{ itens: Categoria[] }>(tenantId!, 'categorias', '/categorias'),
  })

  const contasDisponiveis = contas.data?.itens ?? []
  // Analítica primeiro: `Ajuste de saldo` como padrão faria quem lança às
  // pressas registrar gastos que nunca apareceriam em relatório nenhum.
  const categoriasDisponiveis = (categorias.data?.itens ?? [])
    .filter((c) => c.natureza === 'despesa' && !c.arquivada)
    .sort((a, b) => (a.analitica === b.analitica ? 0 : a.analitica ? -1 : 1))

  const conta = contasDisponiveis.find((c) => c.id === contaId) ?? contasDisponiveis[0]
  const categoria =
    categoriasDisponiveis.find((c) => c.id === categoriaId) ?? categoriasDisponiveis[0]

  const podeSalvar = BigInt(centavos) > 0n && conta !== undefined && categoria !== undefined

  async function salvar() {
    if (!podeSalvar || !tenantId) return
    setSalvando(true)
    try {
      await enfileirarDespesa(tenantId, {
        contaId: conta.id,
        categoriaId: categoria.id,
        centavos,
        descricao: descricao.trim() || categoria.nome,
      })
      router.back()
    } finally {
      setSalvando(false)
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: cor.fundo }} contentContainerStyle={{ padding: espaco.x5 }}>
      <Pressable accessibilityRole="button" onPress={() => router.back()}>
        <Text style={{ color: cor.tinta3 }}>← voltar</Text>
      </Pressable>

      <Text
        accessibilityLabel={`Valor: ${emReais(centavos)}`}
        style={{
          color: cor.despesa,
          fontSize: 40,
          fontWeight: '700',
          textAlign: 'right',
          marginTop: espaco.x6,
        }}
      >
        {emReais(centavos)}
      </Text>

      <Teclado
        aoDigitar={(d) => setCentavos((v) => (v === '0' ? d : `${v}${d}`).slice(0, 15))}
        aoApagar={() => setCentavos((v) => (v.length <= 1 ? '0' : v.slice(0, -1)))}
      />

      <Escolha
        rotulo="Conta"
        atual={conta?.nome ?? '—'}
        opcoes={contasDisponiveis.map((c) => ({ id: c.id, nome: c.nome }))}
        aoEscolher={setContaId}
      />

      <Escolha
        rotulo="Categoria"
        atual={categoria?.nome ?? '—'}
        opcoes={categoriasDisponiveis.map((c) => ({ id: c.id, nome: c.nome }))}
        aoEscolher={(id) => {
          setCategoriaId(id)
          setDescricao('')
        }}
      />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Salvar"
        onPress={() => void salvar()}
        disabled={!podeSalvar || salvando}
        style={{
          marginTop: espaco.x6,
          backgroundColor: podeSalvar ? cor.marca : cor.superficie2,
          borderRadius: 14,
          padding: espaco.x5,
          opacity: salvando ? 0.6 : 1,
        }}
      >
        <Text style={{ color: cor.tinta0, fontSize: 17, fontWeight: '700', textAlign: 'center' }}>
          salvar
        </Text>
      </Pressable>

      <Text style={{ color: cor.tinta3, marginTop: espaco.x4, fontSize: 13, lineHeight: 19 }}>
        Salvar guarda no aparelho na hora. Se estiver sem internet, sobe depois —
        e uma vez só.
      </Text>
    </ScrollView>
  )
}

function Teclado({
  aoDigitar,
  aoApagar,
}: {
  aoDigitar(digito: string): void
  aoApagar(): void
}) {
  const teclas = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫']

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: espaco.x5 }}>
      {teclas.map((t, i) => (
        <Pressable
          key={`${t}-${i}`}
          accessibilityRole="button"
          accessibilityLabel={t === '⌫' ? 'Apagar' : t || undefined}
          disabled={t === ''}
          onPress={() => (t === '⌫' ? aoApagar() : t !== '' && aoDigitar(t))}
          style={{
            width: '33.33%',
            paddingVertical: espaco.x5,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: t === '' ? 'transparent' : cor.tinta0, fontSize: 26 }}>{t}</Text>
        </Pressable>
      ))}
    </View>
  )
}

function Escolha({
  rotulo,
  atual,
  opcoes,
  aoEscolher,
}: {
  rotulo: string
  atual: string
  opcoes: readonly { id: string; nome: string }[]
  aoEscolher(id: string): void
}) {
  const [aberto, setAberto] = useState(false)

  return (
    <View style={{ marginTop: espaco.x4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${rotulo}: ${atual}`}
        onPress={() => setAberto((v) => !v)}
        style={{
          flexDirection: 'row',
          borderWidth: 1,
          borderColor: cor.linha,
          borderRadius: 10,
          padding: espaco.x3,
        }}
      >
        <Text style={{ color: cor.tinta3, flex: 1 }}>{rotulo}</Text>
        <Text style={{ color: cor.tinta0 }}>{atual}</Text>
      </Pressable>

      {aberto && (
        <View style={{ borderWidth: 1, borderColor: cor.linha, borderRadius: 10, marginTop: espaco.x2 }}>
          {opcoes.map((o) => (
            <Pressable
              key={o.id}
              accessibilityRole="button"
              onPress={() => {
                aoEscolher(o.id)
                setAberto(false)
              }}
              style={{ padding: espaco.x3, borderBottomWidth: 1, borderBottomColor: cor.linha }}
            >
              <Text style={{ color: cor.tinta1 }}>{o.nome}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )
}

/** Rede primeiro, cache como rede de segurança. Nunca o contrário. */
async function comCache<T>(tenantId: string, chave: string, caminho: string): Promise<T> {
  try {
    const r = await chamar<T>(caminho, { tenantId })
    await guardar(tenantId, chave, r)
    return r
  } catch (erro) {
    const guardado = await lerCache<T>(tenantId, chave)
    if (!guardado) throw erro
    return guardado.conteudo
  }
}

function emReais(centavos: string): string {
  const v = BigInt(centavos)
  const reais = (v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `R$ ${reais},${(v % 100n).toString().padStart(2, '0')}`
}
