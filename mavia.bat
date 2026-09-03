@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul

REM ---------------------------------------------------------------------------
REM  Mavia - ambiente local de desenvolvimento
REM
REM  Uso:
REM    mavia            sobe TUDO e deixa a aplicacao rodando com os logs a vista
REM    mavia infra      so os containers (banco, Redis, Mailpit) - para os testes
REM    mavia down       derruba, preservando os dados
REM    mavia reset      derruba e APAGA os volumes (banco zerado)
REM    mavia status     mostra o estado dos servicos
REM    mavia logs       acompanha os logs dos containers
REM    mavia psql       abre um shell psql no banco local
REM
REM  Portas: bloco 47xx, deliberadamente longe de 80 e 8080.
REM  Ver infra/README.md.
REM
REM  ---------------------------------------------------------------------------
REM  A JANELA NAO FECHA MAIS SOZINHA.
REM
REM  A versao anterior terminava em `exit /b`, e no duplo clique isso fecha o
REM  console antes de qualquer mensagem ser lida - inclusive as de erro. Agora
REM  todo caminho passa por `:fim`, que da `pause` quando o script foi aberto
REM  pelo Explorador em vez de por um terminal.
REM
REM  E o `up` nao devolve o prompt: ele termina rodando a API e o web em primeiro
REM  plano, com os logs dos dois na tela. Ctrl+C encerra.
REM ---------------------------------------------------------------------------

REM Aberto por duplo clique? Quando o Explorador abre um .bat, a linha de
REM comando do console contem o nome do arquivo; num terminal ja aberto, nao.
set "DUPLO=0"
echo(%cmdcmdline%| findstr /i /c:"%~nx0" >nul && set "DUPLO=1"

set "RAIZ=%~dp0"
set "COMPOSE=%RAIZ%infra\docker-compose.yml"
set "PORTA_PG=4732"
set "PORTA_REDIS=4779"
set "PORTA_API=4711"
set "PORTA_WEB=4710"
set "PORTA_MAILPIT=4725"
set "PORTA_MAILPIT_SMTP=4726"
set "CODIGO=0"

REM Sem argumento, o padrao e subir tudo.
set "ACAO=%~1"
if "%ACAO%"=="" set "ACAO=up"

REM --- o daemon precisa estar rodando antes de qualquer coisa ---
docker info >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [ERRO] O Docker nao esta respondendo.
  echo   Abra o Docker Desktop, espere ele iniciar, e rode este script de novo.
  echo.
  set "CODIGO=1"
  goto :fim
)

if /i "%ACAO%"=="up"     goto :subir
if /i "%ACAO%"=="infra"  goto :infra
if /i "%ACAO%"=="down"   goto :derrubar
if /i "%ACAO%"=="reset"  goto :resetar
if /i "%ACAO%"=="status" goto :status
if /i "%ACAO%"=="logs"   goto :logs
if /i "%ACAO%"=="psql"   goto :psql

echo.
echo   Comando desconhecido: %ACAO%
echo   Use: mavia [up^|infra^|down^|reset^|status^|logs^|psql]
echo.
set "CODIGO=1"
goto :fim

REM ---------------------------------------------------------------------------
:subir
call :containers
if errorlevel 1 goto :fim

echo.
echo   Aplicando migrations...
call pnpm --silent db:migrate
if errorlevel 1 (
  echo.
  echo   [ERRO] As migrations falharam. Nada foi iniciado.
  echo   Rode "mavia logs" para ver o banco.
  set "CODIGO=1"
  goto :fim
)

REM A semente ja checa se o espaco de demonstracao existe e sai sem fazer nada
REM quando existe - entao chamar sempre e seguro.
echo.
echo   Semeando o espaco de demonstracao...
call pnpm --silent db:seed
if errorlevel 1 (
  echo.
  echo   [ERRO] A semente falhou.
  set "CODIGO=1"
  goto :fim
)

call :painel

REM --- o ambiente que a API espera -------------------------------------------
REM O Mailpit e o que faz cadastro e recuperacao funcionarem aqui. Sem as tres
REM SMTP_, as duas rotas RECUSAM com 503 em vez de fingir que mandaram e-mail.
set "SMTP_HOST=127.0.0.1"
set "SMTP_PORTA=%PORTA_MAILPIT_SMTP%"
set "SMTP_REMETENTE=Mavia <ola@mavia.local>"
set "MAVIA_URL_PUBLICA=http://127.0.0.1:%PORTA_WEB%"

echo   Subindo API e web. Os logs dos dois aparecem abaixo.
echo   Ctrl+C encerra os dois e devolve o prompt.
echo.

REM Em primeiro plano, de proposito: e o que mantem os logs a vista e faz a
REM janela nao fechar. Sem o mobile - ele pede Expo, e nao entra no teste do
REM navegador.
call pnpm exec turbo run dev --filter=@mavia/api --filter=@mavia/web

echo.
echo   Aplicacao encerrada. Os containers continuam no ar.
echo   Use "mavia down" para derruba-los.
goto :fim

REM ---------------------------------------------------------------------------
:infra
call :containers
if errorlevel 1 goto :fim
call :painel
echo   Só os containers, como pedido. A aplicacao nao foi iniciada.
echo.
goto :fim

REM ---------------------------------------------------------------------------
REM  Sobe os containers e espera cada um responder de verdade.
REM ---------------------------------------------------------------------------
:containers
echo.
echo   Subindo os containers da Mavia...
echo.
docker compose -f "%COMPOSE%" up -d
if errorlevel 1 (
  echo.
  echo   [ERRO] Falha ao subir os containers.
  set "CODIGO=1"
  exit /b 1
)

echo.
echo   Esperando o Postgres aceitar conexao...

REM O healthcheck do compose ja existe, mas esperar por ele aqui e o que
REM garante que o script so segue com o banco pronto de verdade.
set /a TENTATIVA=0
:esperar_pg
set /a TENTATIVA+=1
docker exec mavia-postgres pg_isready -U mavia -d mavia >nul 2>&1
if not errorlevel 1 goto :pg_pronto
if !TENTATIVA! geq 40 (
  echo.
  echo   [ERRO] O Postgres nao ficou pronto em 40 tentativas.
  echo   Rode "mavia logs" para ver o que aconteceu.
  set "CODIGO=1"
  exit /b 1
)
REM ping em vez de timeout: timeout falha quando a saida esta redirecionada.
ping -n 2 127.0.0.1 >nul
goto :esperar_pg

:pg_pronto
set /a TENTATIVA=0
:esperar_redis
set /a TENTATIVA+=1
docker exec mavia-redis redis-cli ping >nul 2>&1
if not errorlevel 1 goto :redis_pronto
if !TENTATIVA! geq 40 (
  echo   [ERRO] O Redis nao ficou pronto.
  set "CODIGO=1"
  exit /b 1
)
ping -n 2 127.0.0.1 >nul
goto :esperar_redis

:redis_pronto
exit /b 0

REM ---------------------------------------------------------------------------
:painel
echo.
echo   ------------------------------------------------------------------
echo    Ambiente no ar
echo   ------------------------------------------------------------------
echo.
echo    Aplicacao   http://127.0.0.1:%PORTA_WEB%
echo    API         http://127.0.0.1:%PORTA_API%
echo    Mailpit     http://127.0.0.1:%PORTA_MAILPIT%   (a caixa de entrada local)
echo    Postgres    127.0.0.1:%PORTA_PG%    usuario: mavia   senha: mavia_local_dev
echo    Redis       127.0.0.1:%PORTA_REDIS%
echo.
echo    Entre com:  demo@mavia.local
echo    Senha:      mavia-demonstracao
echo.
echo    Credenciais valem SO neste ambiente local. Nunca reutilize.
echo.
echo    mavia psql    abre o banco       mavia logs     logs dos containers
echo    mavia down    derruba            mavia reset    zera o banco
echo   ------------------------------------------------------------------
echo.
exit /b 0

REM ---------------------------------------------------------------------------
:derrubar
echo.
echo   Derrubando os containers. Os dados sao preservados.
docker compose -f "%COMPOSE%" down
echo.
goto :fim

REM ---------------------------------------------------------------------------
:resetar
echo.
echo   Isto APAGA o banco local e todos os dados dele.
set /p "CONFIRMA=  Digite ZERAR para confirmar: "
if /i not "%CONFIRMA%"=="ZERAR" (
  echo.
  echo   Cancelado. Nada foi apagado.
  echo.
  goto :fim
)
docker compose -f "%COMPOSE%" down -v
echo.
echo   Volumes removidos. Rode "mavia" para subir um ambiente limpo.
echo.
goto :fim

REM ---------------------------------------------------------------------------
:status
echo.
docker compose -f "%COMPOSE%" ps
echo.
goto :fim

REM ---------------------------------------------------------------------------
:logs
docker compose -f "%COMPOSE%" logs -f
goto :fim

REM ---------------------------------------------------------------------------
:psql
docker exec -it mavia-postgres psql -U mavia -d mavia
goto :fim

REM ---------------------------------------------------------------------------
REM  Todo caminho termina aqui. O `pause` so acontece no duplo clique - num
REM  terminal ele seria uma pergunta a mais para quem ja esta vendo a saida.
REM ---------------------------------------------------------------------------
:fim
if "%DUPLO%"=="1" (
  echo.
  pause
)
exit /b %CODIGO%
