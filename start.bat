@echo off
TITLE TITANIUM ULTRA V50 - MISSION CONTROL

echo =====================================================
echo   [%time%]  TITANIUM V50 ULTRA - Initializing...
echo =====================================================

REM --- 1. Kill previous instances & Cleanup ---
echo [%time%] Purging legacy processes and Clearing Memory...
taskkill /F /IM node.exe /T >nul 2>&1
taskkill /F /IM python.exe /T >nul 2>&1
taskkill /F /IM streamlit.exe /T >nul 2>&1

REM --- 2. Check Python Environment (.venv) ---
echo [%time%] Verifying Python Strategic Core...
if not exist ".venv" (
    echo [INFO] Creating Python Virtual Environment...
    python -m venv .venv
    echo [INFO] Installing Python dependencies...
    .venv\Scripts\python.exe -m pip install --upgrade pip
    .venv\Scripts\python.exe -m pip install -r requirements.txt
)

REM --- 3. Check Node dependencies ---
echo [%time%] Verifying Node system core...
if not exist "node_modules" (
    echo [%time%] Installing Node dependencies...
    call npm install
)

REM --- 4. Launch TITANIUM ENGINES (Staggered Mode) ---
echo [%time%] Deploying Titanium Engines via Concurrently...
echo =====================================================================
echo   Command Center : http://localhost:8501
echo   Dashboard UI   : http://localhost:5173
echo   API Core       : http://localhost:3001
echo =====================================================================
echo.

cd /d %~dp0
call npx concurrently "node --max-old-space-size=4096 tools\start-redis.js" "npm run scraper" "streamlit run core/command_center.py" "node --max-old-space-size=4096 server.js" "npm run learn" "npx vite" "node scripts/live_value_alerts.js" ".venv\Scripts\python.exe -m uvicorn core.fastapi_server:app --host 127.0.0.1 --port 8000 --workers 1" --names "REDIS,SCRAPER,COMMAND,API_CORE,LEARN,UI_DASH,LIVE_ALERTS,ML_CORE" --prefix-colors "blue.bold,yellow.bold,red.bold,green.bold,magenta.bold,cyan.bold,yellow.dim,white.bold" --kill-others --restart-tries 3 --restart-after 10000

echo.
echo [%time%] Titanium Services have been gracefully shut down.
pause

