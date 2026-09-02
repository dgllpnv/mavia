-- 0014 — O usuário enxerga os espaços a que pertence.
--
-- `GET /v1/eu` é a rota que responde "quais espaços eu tenho", e é ela que o
-- cliente chama **antes** de saber qual `X-Mavia-Tenant` enviar. A policy
-- `tenant_proprio` da 0001 torna `tenants` legível apenas dentro do contexto de
-- um tenant já escolhido — o que é certo para tudo o mais e circular aqui: para
-- ler o nome do espaço seria preciso já ter escolhido o espaço.
--
-- A saída **não** é afrouxar `tenant_proprio`, e não é uma função
-- `SECURITY DEFINER` — que resolveria o mesmo problema abrindo uma superfície
-- de escalada por `search_path` para o que é uma leitura simples.
--
-- Policies permissivas se combinam por OU. Esta acrescenta exatamente um caso:
-- a linha do tenant é visível para quem tem vínculo com ele. Não é ampliação de
-- acesso — quem tem vínculo já pode entrar no espaço e ler tudo lá dentro
-- mandando o cabeçalho. O que muda é poder ler o **nome** para escolher.
--
-- O que continua fora: um usuário sem vínculo não vê a linha, e nenhum usuário
-- ganha escrita. `tenants` não tem policy de INSERT, UPDATE ou DELETE, e
-- `mavia_app` não tem esses privilégios — quem cria tenant é `auth.criar_tenant`.
CREATE POLICY tenant_do_usuario ON tenants
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tenant_usuarios tu
       WHERE tu.tenant_id = tenants.id
         AND tu.usuario_id = nullif(current_setting('app.usuario_id', true), '')::uuid
    )
  );
