import * as LocalAuthentication from 'expo-local-authentication'
import { useEffect, useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import { renovar, temSessaoGuardada } from '../src/nucleo/api'
import { useSessao } from './_layout'
import { cor, espaco } from '../src/componentes/tema'

/**
 * A entrada.
 *
 * **Biometria é conveniência, nunca fator.** Ela destrava a leitura local do
 * refresh que já está no Keychain; ela não autentica contra o servidor e nunca
 * substitui senha ou segundo fator. É a regra que apps financeiros mais mentem
 * para si mesmos — "entrar com Face ID" costuma significar "guardamos a senha e
 * a mandamos por você", que é outra coisa.
 *
 * Aqui o que acontece é literal: o refresh já existe no aparelho, o desbloqueio
 * biométrico autoriza **lê-lo**, e o servidor recebe o mesmo refresh de sempre.
 */
export default function Entrar() {
  const { entrar } = useSessao()
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)
  const [temGuardada, setTemGuardada] = useState(false)

  useEffect(() => {
    void (async () => {
      const guardada = await temSessaoGuardada()
      const suportaBiometria = await LocalAuthentication.hasHardwareAsync()
      const cadastrada = await LocalAuthentication.isEnrolledAsync()
      setTemGuardada(guardada && suportaBiometria && cadastrada)
    })()
  }, [])

  async function destravar() {
    setErro(null)
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Destravar a Mavia',
      // Sem alternativa por senha do aparelho: a senha do telefone não é a
      // credencial desta conta, e oferecê-la aqui confundiria as duas.
      disableDeviceFallback: false,
      cancelLabel: 'Usar e-mail e senha',
    })
    if (!r.success) return

    if (!(await renovar())) {
      setErro('O acesso salvo expirou. Entre com e-mail e senha.')
      setTemGuardada(false)
    }
  }

  async function enviar() {
    setErro(null)
    setEnviando(true)
    try {
      await entrar(email.trim(), senha)
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível entrar agora.')
    } finally {
      setEnviando(false)
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: cor.fundo, justifyContent: 'center', padding: espaco.x6 }}>
      <Text style={{ color: cor.tinta3, fontSize: 12, letterSpacing: 1.5 }}>MAVIA</Text>
      <Text style={{ color: cor.tinta0, fontSize: 28, fontWeight: '700', marginTop: espaco.x2 }}>
        Entre na sua conta
      </Text>

      {temGuardada && (
        <Pressable
          onPress={() => void destravar()}
          accessibilityRole="button"
          style={{
            marginTop: espaco.x6,
            backgroundColor: cor.marca,
            padding: espaco.x4,
            borderRadius: 10,
          }}
        >
          <Text style={{ color: cor.tinta0, textAlign: 'center', fontWeight: '600' }}>
            Destravar com biometria
          </Text>
        </Pressable>
      )}

      <Text style={{ color: cor.tinta3, marginTop: espaco.x6, fontSize: 12, letterSpacing: 1 }}>
        E-MAIL
      </Text>
      <TextInput
        accessibilityLabel="E-mail"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        style={campo}
      />

      <Text style={{ color: cor.tinta3, marginTop: espaco.x4, fontSize: 12, letterSpacing: 1 }}>
        SENHA
      </Text>
      <TextInput
        accessibilityLabel="Senha"
        value={senha}
        onChangeText={setSenha}
        secureTextEntry
        style={campo}
      />

      {erro && (
        <Text accessibilityRole="alert" style={{ color: cor.despesa, marginTop: espaco.x4 }}>
          {erro}
        </Text>
      )}

      <Pressable
        accessibilityRole="button"
        onPress={() => void enviar()}
        disabled={enviando}
        style={{
          marginTop: espaco.x5,
          backgroundColor: cor.marca,
          padding: espaco.x4,
          borderRadius: 10,
          opacity: enviando ? 0.6 : 1,
        }}
      >
        <Text style={{ color: cor.tinta0, textAlign: 'center', fontWeight: '600' }}>
          {enviando ? 'Entrando…' : 'Entrar'}
        </Text>
      </Pressable>
    </View>
  )
}

const campo = {
  marginTop: espaco.x2,
  borderWidth: 1,
  borderColor: cor.linha,
  borderRadius: 10,
  padding: espaco.x3,
  color: cor.tinta0,
  backgroundColor: cor.superficie,
} as const
