-- 0041 · O definer lê `auditoria` **por coluna**, e não a tabela
--
-- A `0040` concedeu `SELECT` de tabela ao dono da função de projeção. Isso
-- funciona e é frouxo demais: `SELECT` de tabela inclui `ip_hash` e
-- `user_agent_hash`, que a matriz de acesso veta para **todo** papel.
--
-- Dois testes reprovaram — o que afirma que nenhum papel do painel lê
-- `auditoria`, e o que percorre os nove campos vetados. Os dois estavam certos,
-- e a correção é a mesma disciplina do resto do épico.
--
-- ## A projeção sozinha não bastava, e é bom que não bastasse
--
-- `admin.ler_registro` não devolve os dois campos: eles não estão no tipo de
-- retorno. Mas *poder ler* e *devolver* são coisas diferentes, e a distância
-- entre elas é o espaço onde a próxima versão da função os inclui sem que
-- nenhuma trava reclame.
--
-- Com `GRANT` por coluna, incluir os dois exige **duas** mudanças em lugares
-- diferentes — a assinatura e a migration —, e a segunda derruba o teste de
-- esquema. É a mesma propriedade que o `GRANT` nominal compra em toda parte
-- desta base: **coluna nova não se estende sozinha**.
REVOKE SELECT ON auditoria FROM mavia_admin_definer;

GRANT SELECT (ocorrido_em, tenant_id, usuario_id, ator_tipo, entidade, entidade_id,
              acao, classe, rota, registros, motivo, referencia, correlacao, de, para)
  ON auditoria TO mavia_admin_definer;
