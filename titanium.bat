@echo off
REM ================================================================
REM  TITANIUM AI — Script de Gestion Docker (Windows)
REM  Usage: titanium.bat [commande]
REM ================================================================

setlocal EnableDelayedExpansion

set "CMD=%~1"
if "%CMD%"=="" set "CMD=help"

REM Couleurs via PowerShell
set "PS=powershell -Command"

if /I "%CMD%"=="up" goto :UP
if /I "%CMD%"=="down" goto :DOWN
if /I "%CMD%"=="restart" goto :RESTART
if /I "%CMD%"=="rebuild" goto :REBUILD
if /I "%CMD%"=="logs" goto :LOGS
if /I "%CMD%"=="status" goto :STATUS
if /I "%CMD%"=="db" goto :DB
if /I "%CMD%"=="redis" goto :REDIS
if /I "%CMD%"=="clean" goto :CLEAN
if /I "%CMD%"=="backup" goto :BACKUP
if /I "%CMD%"=="help" goto :HELP
goto :HELP

:UP
echo.
echo [TITANIUM] Demarrage de la stack...
docker compose up -d --remove-orphans
echo.
echo [TITANIUM] Stack demarree ! Acces:
echo   - Dashboard  : http://localhost:3001
echo   - API ML     : http://localhost:8000
echo   - Prometheus : http://localhost:9090
echo   - DB Port    : localhost:5432
echo.
goto :END

:DOWN
echo [TITANIUM] Arret de la stack...
docker compose down
goto :END

:RESTART
echo [TITANIUM] Redemarrage de la stack...
docker compose restart
goto :END

:REBUILD
echo [TITANIUM] Reconstruction et redemarrage...
docker compose down
docker compose build --no-cache
docker compose up -d --remove-orphans
goto :END

:LOGS
set "SVC=%~2"
if "%SVC%"=="" (
    docker compose logs -f --tail=100
) else (
    docker compose logs -f --tail=200 %SVC%
)
goto :END

:STATUS
echo.
echo [TITANIUM] Etat des services:
docker compose ps
echo.
echo [TITANIUM] Utilisation des ressources:
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}"
goto :END

:DB
echo [TITANIUM] Connexion a TimescaleDB...
docker exec -it titanium_db psql -U postgres -d titanium_quant
goto :END

:REDIS
echo [TITANIUM] Connexion a Redis CLI...
docker exec -it titanium_redis redis-cli -a titanium_redis
goto :END

:CLEAN
echo [TITANIUM] Nettoyage complet (ATTENTION: supprime les volumes!)
set /P CONFIRM="Continuer? (oui/non): "
if /I "!CONFIRM!"=="oui" (
    docker compose down -v --remove-orphans
    docker system prune -f
    echo [TITANIUM] Nettoyage termine.
) else (
    echo [TITANIUM] Annule.
)
goto :END

:BACKUP
echo [TITANIUM] Sauvegarde de la base de donnees...
for /f "tokens=1-4 delims=/ " %%a in ('date /t') do set "DATE=%%d-%%b-%%c"
docker exec titanium_db pg_dump -U postgres titanium_quant > "backups\titanium_db_%DATE%.sql"
echo [TITANIUM] Backup sauvegarde dans backups\
goto :END

:HELP
echo.
echo  ████████╗██╗████████╗ █████╗ ███╗   ██╗██╗██╗   ██╗███╗   ███╗
echo  ╚══██╔══╝██║╚══██╔══╝██╔══██╗████╗  ██║██║██║   ██║████╗ ████║
echo     ██║   ██║   ██║   ███████║██╔██╗ ██║██║██║   ██║██╔████╔██║
echo     ██║   ██║   ██║   ██╔══██║██║╚██╗██║██║██║   ██║██║╚██╔╝██║
echo     ██║   ██║   ██║   ██║  ██║██║ ╚████║██║╚██████╔╝██║ ╚═╝ ██║
echo     ╚═╝   ╚═╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝ ╚═════╝ ╚═╝     ╚═╝
echo.
echo  COMMANDES DISPONIBLES:
echo.
echo    titanium.bat up          Demarrer tous les services
echo    titanium.bat down        Arreter tous les services
echo    titanium.bat restart     Redemarrer tous les services
echo    titanium.bat rebuild     Reconstruire et redemarrer
echo    titanium.bat logs        Voir tous les logs (Ctrl+C pour quitter)
echo    titanium.bat logs [svc]  Voir les logs d'un service (node-api, fastapi-ml, redis, postgres-timescale)
echo    titanium.bat status      Etat + utilisation ressources
echo    titanium.bat db          Ouvrir psql (TimescaleDB)
echo    titanium.bat redis       Ouvrir redis-cli
echo    titanium.bat backup      Sauvegarder la base de donnees
echo    titanium.bat clean       Tout nettoyer (supprime les donnees!)
echo.

:END
endlocal
