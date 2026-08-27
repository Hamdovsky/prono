# manage_service.ps1 - Demarre/Arrete un service unique de la stack Titanium
# Usage : powershell -NoProfile -ExecutionPolicy Bypass -File manage_service.ps1 -Action start|stop -Key <cle>
param(
    [Parameter(Mandatory=$true)] [string]$Action,
    [Parameter(Mandatory=$true)] [string]$Key
)

$ProjectDir = "C:\Users\HAMDI\Desktop\HamdiProno\stitch"
$ErrorActionPreference = 'SilentlyContinue'

# Commandes de lancement (alignees sur start.bat / concurrently)
$Defs = @{
    redis       = @{ Cmd = "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ensure_redis.ps1"; Marker = 'redis.windows.conf' }
    scraper     = @{ Cmd = "npm run scraper";                                                        Marker = 'SofascoreScraping' }
    command     = @{ Cmd = "streamlit run core/command_center.py";                                   Marker = 'command_center.py' }
    api_core    = @{ Cmd = "node --max-old-space-size=512 server.js";                                 Marker = 'server.js' }
    learn       = @{ Cmd = "npm run learn";                                                          Marker = 'adaptive_learning_sync' }
    ui_dash     = @{ Cmd = "npx vite";                                                               Marker = 'vite' }
    live_alerts = @{ Cmd = "node scripts/live_value_alerts.js";                                       Marker = 'live_value_alerts.js' }
    ml_core     = @{ Cmd = ".venv\Scripts\python.exe -m uvicorn core.fastapi_server:app --host 127.0.0.1 --port 8000 --workers 1"; Marker = 'fastapi_server' }
}

if (-not $Defs.ContainsKey($Key)) { Write-Host "Cle inconnue: $Key"; exit 1 }

if ($Action -eq 'start') {
    $d = $Defs[$Key]
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c $($d.Cmd)" -WorkingDirectory $ProjectDir -WindowStyle Normal
    Write-Host "START $Key -> $($d.Cmd)"
} elseif ($Action -eq 'stop') {
    $marker = $Defs[$Key].Marker
    $targets = @()
    Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='python.exe' OR Name='streamlit.exe' OR Name='redis-server.exe'" | ForEach-Object {
        if ($_.CommandLine -and ($_.CommandLine -like "*$marker*")) { $targets += $_.ProcessId }
    }
    # Inclure aussi les parents npm.exe qui lancent ce service (meme arborescence)
    Get-CimInstance Win32_Process -Filter "Name='npm.exe' OR Name='cmd.exe'" | ForEach-Object {
        if ($_.CommandLine -and ($_.CommandLine -like "*$($Defs[$Key].Cmd)*")) { $targets += $_.ProcessId }
    }
    # Ajouter tous les enfants (arbres) des PIDs cibles
    $all = New-Object System.Collections.Generic.HashSet[int]
    foreach ($pidx in $targets) { [void]$all.Add($pidx) }
    $changed = $true
    while ($changed) {
        $changed = $false
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.ParentProcessId -and $all.Contains($_.ParentProcessId) -and -not $all.Contains($_.ProcessId)) {
                [void]$all.Add($_.ProcessId); $changed = $true
            }
        }
    }
    foreach ($pidx in $all) {
        Stop-Process -Id $pidx -Force -ErrorAction SilentlyContinue
        Write-Host "STOP PID $pidx ($Key)"
    }
} else {
    Write-Host "Action inconnue: $Action"
}
