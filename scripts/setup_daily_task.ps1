"""
setup_daily_task.ps1 — Planifie la tâche quotidienne de prédictions
avec le moteur de fusion de cotes (OddsFusionEngine).
Tourne chaque jour à 08:00.
"""

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$PythonExe = (Get-Command python).Source
$PipelineScript = Join-Path $ProjectDir "scripts\daily_predictions.py"
$LogDir = Join-Path $ProjectDir "logs"

# Créer le dossier logs si besoin
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

$TaskName = "TitaniumDailyPredictions"
$Action = New-ScheduledTaskAction -Execute $PythonExe -Argument "`"$PipelineScript`"" -WorkingDirectory $ProjectDir
$Trigger = New-ScheduledTaskTrigger -Daily -At 08:00
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

try {
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force
    Write-Host "✅ Tâche planifiée: $TaskName (tous les jours à 08:00)" -ForegroundColor Green
    Write-Host "   Script: $PipelineScript"
    Write-Host "   Python: $PythonExe"
    Write-Host "   Logs: $LogDir"
} catch {
    Write-Host "❌ Erreur: $_" -ForegroundColor Red
}
