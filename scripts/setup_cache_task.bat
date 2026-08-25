@echo off
REM Cree/remplace la tache planifiee "SofaScoreCache" -> toutes les 1 heure.
REM Execution en tant qu'utilisateur courant, meme s'il n'est pas connecte.
setlocal
set STITCH=C:\Users\HAMDI\Desktop\HamdiProno\stitch
set BAT=%STITCH%\scripts\run_cache_sofascore.bat

schtasks /Delete /TN "SofaScoreCache" /F >nul 2>&1
schtasks /Create /TN "SofaScoreCache" /TR "\"%BAT%\"" /SC HOURLY /MO 1 /ST 00:00 /RU "%USERNAME%" /RL HIGHEST /F

if %ERRORLEVEL%==0 (
  echo [OK] Tache "SofaScoreCache" creee : toutes les 1 heure.
  schtasks /Query /TN "SofaScoreCache"
) else (
  echo [ERREUR] Creation impossible (droits admin requis ?). Lancez en tant qu'administrateur.
)
endlocal
pause
