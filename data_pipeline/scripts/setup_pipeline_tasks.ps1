# setup_pipeline_tasks.ps1 — Planifie la tâche quotidienne du pipeline de données.
#
# Exécute run_scheduled.py (Football-Data + ClubElo chaque matin, xG/xA tous les
# 3 jours si dû) via le Planificateur de tâches Windows, à 07:00.
#
# Usage :
#     powershell -ExecutionPolicy Bypass -File scripts\setup_pipeline_tasks.ps1
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$PythonExe = Join-Path $ProjectDir ".venv\Scripts\python.exe"
if (-not (Test-Path $PythonExe)) {
    $PythonExe = (Get-Command python).Source
}
$SchedulerScript = Join-Path $ProjectDir "scripts\run_scheduled.py"
$LogDir = Join-Path $ProjectDir "logs"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

$TaskName = "Pronos-DataPipeline"
$Action = New-ScheduledTaskAction -Execute $PythonExe -Argument "`"$SchedulerScript`" --bases" -WorkingDirectory $ProjectDir
$Trigger = New-ScheduledTaskTrigger -Daily -At 07:00
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

try {
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force
    Write-Host "OK: $TaskName (tous les jours a 07:00)" -ForegroundColor Green
    Write-Host "  Script : $SchedulerScript"
    Write-Host "  Python : $PythonExe"
    Write-Host "  Logs   : $LogDir"
} catch {
    Write-Host "ERREUR : $_" -ForegroundColor Red
    exit 1
}
