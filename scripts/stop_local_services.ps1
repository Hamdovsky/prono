# stop_local_services.ps1 - Arrête uniquement les services de CE projet
# (évite taskkill /IM node.exe qui tue tous les node/python du systeme),
# puis archive les logs racine > 1 Mo dans logs\archive\.
#
# Usage : powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop_local_services.ps1

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir

$processNames = @('node.exe', 'python.exe', 'streamlit.exe', 'redis-server.exe')
$markers = @(
    'stitch',
    'server.js',
    'command_center.py',
    'streamlit',
    'uvicorn',
    'fastapi_server',
    'live_value_alerts',
    'SofascoreScraping',
    'redis.windows.conf',
    'redis-server',
    'adaptive_learning_sync',
    'live_value_alerts.js',
    'concurrently'
)

$killed = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='python.exe' OR Name='streamlit.exe' OR Name='redis-server.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    $cmd = $_.CommandLine
    $isRedis = $_.Name -ieq 'redis-server.exe'
    if ($isRedis) {
        # On ne tue QUE le redis lié à ce dossier (bin\redis du projet). Le
        # redis fourni par le service Windows (PID 5776 sur 6379) doit rester:
        # l'application s'y connecte (PONG). Le tuer = conflit de bind à chaque boot.
        $localBin = Join-Path $ProjectDir "bin\redis"
        if ($cmd -and (($cmd -like "*$localBin*") -or ($cmd -like "*redis.windows.conf*"))) {
            Write-Host "Kill PID $($_.ProcessId) $($_.Name): $($cmd.Trim())"
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            $killed++
        }
        return
    }
    if (-not $cmd) { return }
    $matched = $markers | Where-Object { $cmd -like "*$_*" }
    if (-not $matched) { return }
    Write-Host "Kill PID $($_.ProcessId) $($_.Name): $($cmd.Trim())"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $killed++
}
Write-Host "Stopped $killed process(es)."

$archive = Join-Path $ProjectDir 'logs\archive'
New-Item -ItemType Directory -Path $archive -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$rootLogs = @('server-console.log', 'server-console.err.log', 'fastapi-server.log', 'forecast-collateral.log', 'collateral.log')
foreach ($f in $rootLogs) {
    $p = Join-Path $ProjectDir $f
    if (-not (Test-Path $p)) { continue }
    $size = (Get-Item $p).Length
    if ($size -le 1MB) { continue }
    $base = [IO.Path]::GetFileNameWithoutExtension($f)
    $dest = Join-Path $archive "$base.$stamp.log"
    try {
        Copy-Item -LiteralPath $p -Destination $dest -Force
        [IO.File]::WriteAllText($p, '')
        Write-Host "Archived $f -> archives\$base.$stamp.log"
    } catch {
        Write-Host "WARN: $f still locked, skipped rotation: $_" -ForegroundColor Yellow
    }
}