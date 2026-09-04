Status: ready-for-agent
Blocked by: 07

# 11 · `EXPORTADA_EM_PARTE` — o terceiro estado do teste de completude

## Objetivo

Depois deste ticket a classificação de tabelas da exportação deixa de ser binária, e a tabela que sai ao titular **sem uma coluna** tem um lugar declarado para isso — com a asserção de que a coluna omitida **não aparece na saída real**, e não apenas numa lista.

## A seção do spec que governa

- **Modelo de dados, último bloco** — *"Isso cria um terceiro estado que o teste de completude não tem"*. Hoje a classificação é binária e fechada: `TABELAS_EXPORTADAS` (`exportacao.controller.ts:289`), `EXPORTADA_JUNTO` (`:197`) e `FORA_DA_EXPORTACAO` (`:206`); o teste monta um conjunto com as três e falha se sobrar tabela com `tenant_id` não classificada (`apps/api/test/relatorios.test.ts:273-280`). **Não existe "exportada em parte".**
- **§8.2 d (F-4)** — a omissão de `registrado_por` passa a ser **um privilégio que não existe**, e não uma lista no serializador.
- **DA-2** — `registrado_por` é o `usuarios.id` de um funcionário da Mavia; entregá-lo na exportação do titular contraria a decisão do dono **por porta lateral**.

## O que entra, e onde

Sem migration.

- `apps/api/src/exportacao/exportacao.controller.ts` — `export const EXPORTADA_EM_PARTE: ReadonlyMap<string, { colunas_omitidas: readonly string[]; porque: string }>`, com a entrada de `pagamentos_manuais`: `colunas_omitidas: ['registrado_por']`, `porque: 'usuarios.id de um funcionário da Mavia; DA-2'`.
- `apps/api/test/relatorios.test.ts` — o conjunto `classificadas` (hoje `:273-277`) passa a incluir `EXPORTADA_EM_PARTE.keys()`, e ganha a asserção própria descrita abaixo.

## Critérios de aceite

**Integração** (Postgres real, contra a exportação real)

1. O teste de completude reconhece `EXPORTADA_EM_PARTE` como **terceiro estado**: uma tabela com `tenant_id` classificada apenas nele **não** aparece em `esquecidas`. A consulta que enumera as tabelas continua excluindo partições por `NOT pc.relispartition` (`relatorios.test.ts:252-271`) — sem isso ela falharia todo mês, quando a partição seguinte de `auditoria` nascesse.
2. **Para cada entrada de `EXPORTADA_EM_PARTE`, cada nome em `colunas_omitidas` não aparece na saída real da exportação** — asserção sobre o JSON produzido pela rota, não sobre a lista. *Senão a lista vira documentação e o campo sai assim mesmo.*
3. A exportação do titular **não contém** `registrado_por`, e **contém** as outras nove colunas de `pagamentos_manuais`: `id`, `valor_centavos`, `moeda`, `competencia`, `recebido_em`, `meio`, `referencia_externa`, `observacao`, `registrado_em`.
4. A omissão é **um privilégio que não existe**: um teste força o serializador a pedir `registrado_por` explicitamente e a consulta levanta `permission denied` na coluna, porque o `GRANT SELECT` de `mavia_app` é nominal e não a inclui (ticket 07, critério 9).
5. Uma tabela classificada em **dois** estados ao mesmo tempo derruba o teste. *Três listas se sobrepondo é como a quarta nasce ambígua.*

## Armadilhas conhecidas

- **Uma lista de omissão no serializador é documentação, não controle (F-4, §8.2 d).** É a mesma propriedade que a §1.3 compra com o `GRANT` por coluna: *"coluna nova não se estende sozinha"*. O critério 4 é o que separa as duas coisas — sem ele, o `EXPORTADA_EM_PARTE` é uma promessa do código.
- **O teste de completude existe para falhar no futuro.** O comentário em `relatorios.test.ts:247-250` diz por quê: quem criar uma tabela nova precisa **decidir** se ela é dado do titular, e esquecer produziria uma exportação que parece completa e não é — e o titular só descobriria exercendo o direito. **Acrescentar um estado não pode afrouxar isso**, e é o critério 5 que garante.
- **Partição não é tabela nova.** No Postgres cada partição aparece em `information_schema.tables` como `BASE TABLE` e herda as colunas do pai — `auditoria_2026_09` entraria como "tabela com `tenant_id` não classificada". O `NOT relispartition` já está lá (`relatorios.test.ts:252-271`) e **não deve ser removido** ao mexer neste teste: um teste que falha por calendário é um teste que alguém desliga na terceira vez.
- **`auditoria` continua em `FORA_DA_EXPORTACAO`** (`exportacao.controller.ts:213`), com a justificativa *"registro do sistema sobre o titular, não dado do titular; sai por outro fluxo"* — e **esse fluxo não existe**. Ele é o item **7** da tabela de LGPD do spec (art. 18 I e II, com dono e prazo), marcado **Falta**, e o texto de consentimento v2 já o promete ao titular, o que o torna também obrigação contratual. **Não é deste ticket**; está aqui para que ninguém "resolva" o assunto reclassificando `auditoria`.
- **`registrado_por` não sai, e a razão é DA-2, não conveniência.** O cliente descobriria pelo arquivo o que a decisão do dono determinou não contar.

## Decisões pendentes que este ticket toca

Nenhuma. **DA-2** está decidida e mantida.

## O que este ticket não faz

- Não constrói o fluxo do art. 18 I e II (item 7 da tabela de LGPD, **Falta**, bloqueia o deploy como **O-5**).
- Não reclassifica `auditoria`.
- Não toca a `retencao-e-eliminacao.md` — a **R-31** exige que a exportação final entregue ao titular contenha a lista de acessos daquele espaço, sem `ip_hash` nem `user_agent_hash`, e isso é o mesmo fluxo do item 7. **Deploy, não ticket.**
