# `@mavia/mobile`

O app Android e iOS, em Expo com `expo-router`.

## O que está verificado, e o que não está

**Verificado por teste automatizado:** a fila durável (`src/nucleo/fila.ts`), com
17 casos incluindo três propriedades. É onde mora toda decisão que custa
dinheiro — o que sobe, em que ordem, e o que acontece quando falha — e por isso
ela é pura: roda em Node, sem dispositivo.

**Não verificado:** tudo o que precisa de um aparelho. As telas, o SQLite, o
Keychain, a biometria e o fluxo do Maestro **não foram executados** — o ambiente
onde este código foi escrito não tem emulador nem dispositivo. O que existe é
código que compila com `strict` e um fluxo de fumaça escrito para ser rodado.

Isto é dívida declarada, não descuido: `docs/pendencias.md`, P-10.

## Como rodar

```bash
pnpm --filter @mavia/mobile dev     # Metro
pnpm --filter @mavia/mobile android # emulador Android
pnpm --filter @mavia/mobile test    # o núcleo, sem dispositivo
maestro test maestro/fumaca.yaml    # fumaça, com dispositivo
```

A API é apontada por `EXPO_PUBLIC_API`. Em desenvolvimento, num emulador
Android, `127.0.0.1` é o próprio emulador — use o IP da máquina:

```bash
EXPO_PUBLIC_API=http://192.168.0.10:4711/v1 pnpm --filter @mavia/mobile android
```

## A divisão que importa

```
src/nucleo/     puro, testado, sem React e sem I/O de plataforma
  fila.ts         o que sobe, em que ordem, e o que fazer quando falha
  sincronizador.ts o laço — fino de propósito, só I/O
  deposito.ts     SQLite: a fila (única cópia) e o cache (descartável)
  api.ts          HTTP, access em memória, refresh no Keychain
app/            as telas
```

A fila é gravada **antes** de qualquer tentativa de rede. Um app offline-first
que grava depois de tentar a rede não é offline-first: é um app online com uma
tela de erro melhor.
