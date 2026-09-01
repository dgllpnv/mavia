@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul

REM ---------------------------------------------------------------------------
REM  Mavia - ambiente local de desenvolvimento
REM
REM  Uso:
REM    mavia            sobe o ambiente e espera ficar saudavel
REM    mavia down       derruba, preservando os dados
REM    mavia reset      derruba e APAGA os volumes (banco zerado)
REM    mavia status     mostra o estado dos servicos
REM    mavia logs       acompanha os logs em tempo real
REM    mavia psql       abre um shell psql no banco local
REM
REM  Portas: bloco 47xx, deliberadamente longe de 80 e 8080.
REM  Ver infra/README.md.
REM ---------------------------------------------------------------------------

set "RAIZ=%~dp0"
set "COMPOSE=%RAIZ%infra\docker-compose.yml"
set "PORTA_PG=4732"
set "PORTA_REDIS=4779"

REM Sem argumento, o padrao e subir o ambiente.
set "ACAO=%~1"
if "%ACAO%"=="" set "ACAO=up"

REM --- o daemon precisa estar rodando antes de qualquer coisa ---
docker info >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [ERRO] O Docker nao esta respondendo.
  echo   Abra o Docker Desktop, espere ele iniciar, e rode este script de novo.
  echo.
  exit /b 1
)

if /i "%ACAO%"=="up"     goto :subir
if /i "%ACAO%"=="down"   goto :derrubar
if /i "%ACAO%"=="reset"  goto :resetar
if /i "%ACAO%"=="status" goto :status
if /i "%ACAO%"=="logs"   goto :logs
if /i "%ACAO%"=="psql"   goto :psql

echo.
echo   Comando desconhecido: %ACAO%
echo   Use: mavia [up^|down^|reset^|status^|logs^|psql]
echo.
exit /b 1

REM ---------------------------------------------------------------------------
:subir
echo.
echo   Subindo o ambiente local da Mavia...
echo.
docker compose -f "%COMPOSE%" up -d
if errorlevel 1 (
  echo.
  echo   [ERRO] Falha ao subir os containers.
  exit /b 1
)

echo.
echo   Esperando o Postgres aceitar conexao...

REM O healthcheck do compose ja existe, mas esperar por ele aqui e o que
REM garante que o script so devolve o prompt com o banco pronto de verdade.
set /a TENTATIVA=0
:esperar_pg
set /a TENTATIVA+=1
docker exec mavia-postgres pg_isready -U mavia -d mavia >nul 2>&1
if not errorlevel 1 goto :pg_pronto
if %TENTATIVA% geq 40 (
  echo.
  echo   [ERRO] O Postgres nao ficou pronto em 40 tentativas.
  echo   Rode "mavia logs" para ver o que aconteceu.
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
if %TENTATIVA% geq 40 (
  echo   [ERRO] O Redis nao ficou pronto.
  exit /b 1
)
ping -n 2 127.0.0.1 >nul
goto :esperar_redis

:redis_pronto
echo.
echo   ------------------------------------------------------------------
echo    Ambiente no ar
echo   ------------------------------------------------------------------
echo.
echo    Postgres   127.0.0.1:%PORTA_PG%    usuario: mavia   senha: mavia_local_dev
echo    Redis      127.0.0.1:%PORTA_REDIS%
echo.
echo    DATABASE_URL=postgresql://mavia:mavia_local_dev@127.0.0.1:%PORTA_PG%/mavia
echo    REDIS_URL=redis://127.0.0.1:%PORTA_REDIS%
echo.
echo    Credenciais e senha valem SO neste ambiente local. Nunca reutilize.
echo.
echo    mavia psql    abre o banco       mavia logs     acompanha os logs
echo    mavia down    derruba            mavia reset    zera o banco
echo   ------------------------------------------------------------------
echo.
exit /b 0

REM ---------------------------------------------------------------------------
:derrubar
echo.
echo   Derrubando o ambiente. Os dados sao preservados.
docker compose -f "%COMPOSE%" down
echo.
exit /b 0

REM ---------------------------------------------------------------------------
:resetar
echo.
echo   Isto APAGA o banco local e todos os dados dele.
set /p "CONFIRMA=  Digite ZERAR para confirmar: "
if /i not "%CONFIRMA%"=="ZERAR" (
  echo.
  echo   Cancelado. Nada foi apagado.
  echo.
  exit /b 0
)
docker compose -f "%COMPOSE%" down -v
echo.
echo   Volumes removidos. Rode "mavia" para subir um ambiente limpo.
echo.
exit /b 0

REM ---------------------------------------------------------------------------
:status
echo.
docker compose -f "%COMPOSE%" ps
echo.
exit /b 0

REM ---------------------------------------------------------------------------
:logs
docker compose -f "%COMPOSE%" logs -f
exit /b 0

REM ---------------------------------------------------------------------------
:psql
docker exec -it mavia-postgres psql -U mavia -d mavia
exit /b 0
