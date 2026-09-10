@echo off
chcp 65001 >nul
title Pronos Pipeline - Test
cd /d "%~dp0data_pipeline"

echo ============================================================
echo   PRONOS DATA PIPELINE - RACCOURCI DE TEST (Desktop)
echo ============================================================
echo.
echo   1. Vérifier la qualité du master (rapide)
echo   2. Lancer le pipeline complet (Football-Data + ClubElo + xG)
echo   3. Lancer le pipeline + boutiques (--bases)
echo   4. Voir les dernières prédictions de fixtures
echo   5. Quitter
echo.
set /p choix="Choix (1-5) : "

if "%choix%"=="1" goto check
if "%choix%"=="2" goto run
if "%choix%"=="3" goto bases
if "%choix%"=="4" goto fixtures
if "%choix%"=="5" exit /b
goto end

:check
echo.
echo [CHECK QUALITE MASTER]...
".venv\Scripts\python.exe" pipeline.py --task check
pause
exit /b

:run
echo.
echo [PIPELINE COMPLET]...
".venv\Scripts\python.exe" scripts\run_scheduled.py
pause
exit /b

:bases
echo.
echo [PIPELINE + BOUTIQUES]...
".venv\Scripts\python.exe" scripts\run_scheduled.py --bases
pause
exit /b

:fixtures
echo.
echo [PREDICTIONS FIXTURES - date du jour]...
".venv\Scripts\python.exe" scripts\predict_fixtures.py --date %date:~10,4%-%date:~4,2%-%date:~7,2%
pause
exit /b

:end
echo Fin.
pause
