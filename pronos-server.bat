@echo off
chcp 65001 >nul
title Pronos Server - Titanium (Tout-en-un)
cd /d "%~dp0"

echo                  __
echo                 /  \
echo                ^|    ^
echo                 \__/
echo                  ##      .-.
echo                  ##     (   )
echo                  ##      \ /
echo               .--'##'--.  V
echo              /   ##   \ / \
echo             ^|    ##    V   ^
echo              \   ##   / \  /
echo               '--'##'--'  V
echo           K A R K A D A N  (Rhinoceros)
echo =====================================================
echo   PRONOS SERVER - TITANIUM (Tout-en-un)
echo   API: http://localhost:3001   UI: http://localhost:5173
echo   Scraper + ML + Command Center : http://localhost:8501
echo =====================================================

REM --- Ouvre le dashboard une fois l'API pret (~12s) ---
start "" cmd /c "timeout /t 12 /nobreak >nul & start http://localhost:5173"

REM --- Lance tout : kill propre + API(3001) + UI + Scraper + ML + Command Center + Redis + Alertes ---
call start.bat
