@echo off
REM Lanceur cache SofaScore pour Windows Task Scheduler (toutes les 1h)
setlocal
set STITCH=C:\Users\HAMDI\Desktop\HamdiProno\stitch
set PY=%STITCH%\.venv\Scripts\python.exe
set LOG=%STITCH%\data\cron_sofascore.log
REM Rotation du log si > 1 Mo
"%PY%" "%STITCH%\scripts\rotate_log.py" "%LOG%"
"%PY%" "%STITCH%\scripts\cacheSofascoreOdds.py" >> "%LOG%" 2>&1
REM Health check : resume de sante du cache (alerte si vide/expire/stale)
"%PY%" "%STITCH%\scripts\monitor_cache.py" --ttl 6 >> "%LOG%" 2>&1
endlocal
