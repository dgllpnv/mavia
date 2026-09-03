# `mavia-guardiao`

O processo que guarda a KEK — ADR 0018.

## O ativo

A KEK é o único ativo do sistema cujo comprometimento **não é proporcional ao
acesso obtido**. Todo o resto vaza um tenant por vez: uma sessão roubada entrega
um espaço; uma falha de RLS entregaria um tenant. A KEK destrava as credenciais
bancárias de *todos* os tenants, a partir de qualquer cópia do banco ou de
qualquer backup, para sempre e sem deixar rastro no sistema.

## Operar

```bash
# provisionamento, uma vez: guarde a saída FORA deste host
pnpm --filter @mavia/guardiao-processo exec tsx src/main.ts --gerar-kek

# no boot da VPS, desselamento manual
MAVIA_GUARDIAO_SOCKET=/run/mavia/guardiao.sock \
MAVIA_GUARDIAO_DIARIO=/var/log/mavia/guardiao.jsonl \
  pnpm --filter @mavia/guardiao-processo exec tsx src/main.ts
# cole: 1 <kek em base64>
```

**Todo reboot exige desselamento.** Enquanto o guardião estiver selado, a
sincronização bancária não funciona — e o resto do produto sim. A falha é
silenciosa para o usuário: os lançamentos simplesmente param de chegar. Por isso
ela precisa de alerta, e não só de runbook.

## O que este processo nunca faz

Não lê `.env`, não abre porta TCP, não fala com o Postgres e não interpreta
arquivo de usuário. A KEK entra pela entrada padrão, uma vez, e **não toca o
disco**.

Não existe `exportarKek()`. A API desembrulha enquanto vive; não leva a chave
embora. Os campos internos usam `#` e não `private` — o `private` do TypeScript
é apagado na compilação, e os métodos ficariam alcançáveis no protótipo.

## O teto que sela

Quinhentos desembrulhos por hora. Uma conexão sincroniza no máximo seis vezes
por dia; um pedido de desembrulho em massa é o padrão de quem comprometeu a API
e quer levar tudo. Estourar o teto **sela** o cofre e alarma — não recusa a
operação e segue, porque continuar atendendo os quinhentos seguintes seria
entregar o resto enquanto o alarme toca.

Depois de selado por abuso, desselar de novo não reabre: o processo precisa ser
reiniciado, para que a investigação aconteça antes.
