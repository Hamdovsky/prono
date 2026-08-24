# server_window.ps1 - Option 2 audit P1-V1 : fenetres planifiees Windows
# ---------------------------------------------------------------------------
# Demarre node server.js pendant N minutes (settlements + auto-backtest),
# arrete proprement, puis lance le fit isotonic GARDE V1 incluse
# (python core/calibration_iso.py --fit).
#
# Planificateur : tache "Pronos-Fenetres-P1" (triggers 07:10 et 22:45 local).
# 07:10 = juste apres Pronos-DataPipeline (07:00) -> resultats frais regles.
# 22:45 = fin des matchs du soir.
#
# Usage : powershell -NoProfile -ExecutionPolicy Bypass -File scripts\server_window.ps1 -Minutes 25
param([int]$Minutes = 25)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$WinLog = Join-Path $Root 'logs\scheduled_windows.log'

function Log($msg) {
  $line = ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $msg)
  Add-Content -Path $WinLog -Value $line
  Write-Output $line
}

function Get-ServerPid {
  $p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*server.js*' }
  return $p
}

Log ("=== FENETRE DEMARREE (" + $Minutes + " min) ===")

$existing = Get-ServerPid
if ($existing) {
  Log ("Serveur deja actif (PID " + ($existing.ProcessId -join ',') + ") - fenetre ignoree.")
  exit 0
}

$outLog = Join-Path $Root ('logs\server_boot_' + (Get-Date -Format 'yyyyMMdd_HHmmss') + '.out.log')
$errLog = Join-Path $Root ('logs\server_boot_' + (Get-Date -Format 'yyyyMMdd_HHmmss') + '.err.log')

$env:PORT = '3001'
$proc = Start-Process -FilePath 'node' `
  -ArgumentList '--max-old-space-size=512', 'server.js' `
  -WorkingDirectory $Root -WindowStyle Hidden `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog `
  -PassThru

if (-not $proc) { Log 'ERREUR: demarrage node impossible.'; exit 1 }
Log ("Serveur demarre (PID " + $proc.Id + "), fenetre de " + $Minutes + " minutes.")

Start-Sleep -Seconds ($Minutes * 60)

$still = Get-ServerPid | Where-Object { $_.ProcessId -eq $proc.Id }
if ($still) {
  Stop-Process -Id $proc.Id -Force
  Log ("Serveur arrete (PID " + $proc.Id + ").")
} else {
  Log 'Serveur deja termine avant la fin de la fenetre.'
}

# Fit isotonic APRES l'arret (accuracy_log flush) - garde anti-contamination
# active dans core/calibration_iso.py depuis l'audit V1.
Log '--- Fit isotonic (garde V1) ---'
$fitOut = & python (Join-Path $Root 'core\calibration_iso.py') --fit 2>&1
$fitOut | Select-Object -Last 12 | ForEach-Object { Log ("ISO: " + $_) }

Log "=== FENETRE TERMINEE ==="
