# ADR 0002 — React Native com Expo para Android e iOS

- **Status:** Aceita
- **Data:** 2026-09-01

## Contexto

O produto exige apps nativos nas duas lojas. O momento de maior valor do app é o instante do gasto — fila do caixa, estacionamento, metrô — o que torna funcionamento offline um requisito, não um refinamento. O time é pequeno e a stack do restante do projeto é TypeScript (ADR 0001).

## Decisão

Expo (React Native) com expo-router, SQLite para persistência local offline-first, `expo-secure-store` para segredos, `expo-local-authentication` para biometria. Build e publicação por EAS Build e EAS Submit, com canais separados para desenvolvimento, preview e produção.

A lógica de domínio **não** é reimplementada no app: vem de `packages/domain`, a mesma que a API usa.

## Consequências

**Positivas.** Uma base de código para as duas plataformas. As regras monetárias são literalmente as mesmas do servidor, eliminando divergência de cálculo entre app e web. EAS resolve assinatura e distribuição sem exigir infraestrutura de build própria nem máquina macOS dedicada. Atualização OTA para correções de camada JS encurta o ciclo sem passar pela revisão das lojas.

**Negativas.** Módulo nativo fora do ecossistema Expo exige development build e mais trabalho. Desempenho de listas muito longas exige atenção deliberada — o extrato precisa de virtualização desde o primeiro dia. Dependência do EAS como serviço; existe caminho de saída via prebuild, mas com custo.

## Alternativas rejeitadas

**Flutter.** UI consistente e performática, ótimo tooling. Rejeitado porque Dart isola o mobile do resto da stack: modelos, validações e regras monetárias seriam duplicados, e o time precisaria de mais um especialista. O custo do fatiamento supera o ganho de UI.

**Nativo (Kotlin + Swift).** Melhor desempenho e acesso pleno à plataforma. Custo dobrado em bases de código, especialistas e ciclos de release — inviável para o tamanho do time.

**PWA com wrapper.** Mais rápido e barato de lançar, mas limitações reais em push no iOS, biometria e uso offline. Inadequado para um produto financeiro que precisa funcionar sem rede e transmitir confiança.
