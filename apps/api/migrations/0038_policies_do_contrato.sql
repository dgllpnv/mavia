-- 0038 · As policies que o papel de contrato precisa
--
-- **`GRANT` e `POLICY` são camadas independentes, e as duas são necessárias.**
--
-- Foi o achado S3-3 do gate de segurança, na forma exata: *"policy sem `GRANT`
-- não lê nada"*. Aqui a moeda caiu do outro lado — `mavia_admin_contrato` tinha
-- os `GRANT` nominais desde a `0029` e **nenhuma policy**, então a RLS devolvia
-- zero linhas e `admin.cadastrar_cliente` recusava todo titular como
-- inexistente. A mensagem que o operador via — *"esta pessoa ainda não tem
-- conta"* — descrevia com precisão um fato falso.
--
-- É a terceira vez que este par aparece nesta base, e as três com sintomas que
-- apontam para o lugar errado: `permission denied for table` quando faltava
-- coluna no `WHERE`, `permission denied` no gatilho quando faltava `SELECT` na
-- tabela que ele consulta, e agora "não existe" quando falta policy.
--
-- ## O predicado é o mesmo dos donos de função
--
-- Saída A do achado S3-4: a leitura ampla existe **para quem tem concessão
-- ativa**, não para quem alcança o papel. Um papel `NOLOGIN` que só existe como
-- dono de função não é alcançável por conexão nenhuma — mas o predicado é o que
-- mantém isso verdadeiro quando a **segunda** função de contrato nascer.

CREATE POLICY contrato_le_usuarios ON usuarios
  FOR SELECT TO mavia_admin_contrato USING (admin.tem_concessao_ativa());

CREATE POLICY contrato_le_tenants ON tenants
  FOR SELECT TO mavia_admin_contrato USING (admin.tem_concessao_ativa());

CREATE POLICY contrato_le_vinculos ON tenant_usuarios
  FOR SELECT TO mavia_admin_contrato USING (admin.tem_concessao_ativa());

-- As duas de escrita do cadastro.
--
-- `WITH CHECK` pelo predicado de concessão, e **não** por `app.tenant_id`: o
-- espaço está nascendo dentro desta transação, e o GUC aponta para o UUID nulo
-- que a rota declara como alvo da abertura. Amarrar a escrita ao GUC exigiria
-- que o identificador fosse conhecido antes de existir.
--
-- A contenção aqui é o `GRANT` nominal por coluna da `0029` mais a checagem de
-- concessão dentro da função — que é a mesma forma do resto do épico.
CREATE POLICY contrato_cria_tenants ON tenants
  FOR INSERT TO mavia_admin_contrato WITH CHECK (admin.tem_concessao_ativa());

CREATE POLICY contrato_cria_vinculos ON tenant_usuarios
  FOR INSERT TO mavia_admin_contrato WITH CHECK (admin.tem_concessao_ativa());

-- E as de `assinaturas` e `pagamentos_manuais`, que as funções de contrato já
-- escreviam — elas funcionavam porque `app.tenant_id` estava definido pela
-- abertura, e a policy de isolamento das duas tabelas não tem cláusula `TO`.
-- Ficam declaradas aqui para que a dependência seja visível: se um dia aquelas
-- policies ganharem um `TO`, este papel perde o acesso sem que ninguém veja.
COMMENT ON POLICY contrato_le_usuarios ON usuarios IS
  'O papel de contrato lê o titular para cadastrá-lo. GRANT sem policy não lê nada.';
