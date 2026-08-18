param()

# ensure_redis.ps1 - Slot REDIS pour le launcher concurrently.
# 1. Teste le ping sur 127.0.0.1:6379.
# 2. Si un redis répond (ex: service Windows Redis) -> ne fait RIEN et tient le slot.
# 3. Sinon, démarre le redis du dossier (bin\redis\redis-server.exe) et tient le slot.
# Le slot reste vivant jusqu'a Ctrl+C / kill de concurrently (empeche --kill-others de tout abattre).

$ErrorActionPreference = 'SilentlyContinue'

$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$cli = Join-Path $ProjectDir 'bin\redis\redis-cli.exe'
$server = Join-Path $ProjectDir 'bin\redis\redis-server.exe'
$conf = Join-Path $ProjectDir 'bin\redis\redis.windows.conf'

function Test-Redis {
    $out = & $cli -h 127.0.0.1 -p 6379 ping 2>$null
    return ($LASTEXITCODE -eq 0) -and ($out -match '^(PONG|LOADING)$')
}

if (Test-Redis) {
    Write-Host '[REDIS] Service Redis up on 127.0.0.1:6379 (PONG). Slot held (no duplicate start).'
    while ($true) { Start-Sleep -Seconds 3600 }
    return
}

# Le service n'existe pas / n'ecoute pas : on demarre le redis du projet.
Write-Host '[REDIS] No listener on 6379. Starting project redis-server...'
if (-not (Test-Path $server)) {
    Write-Host '[REDIS] ERROR: redis-server.exe introuvable. Slot held, app falls back to in-memory Redis.' -ForegroundColor Yellow
    while ($true) { Start-Sleep -Seconds 3600 }
    return
}

$proc = Start-Process -FilePath $server -ArgumentList "`"$conf`"" -WorkingDirectory (Split-Path $server) -WindowStyle Hidden -PassThru

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Redis) { $ready = $true; break }
}
if ($ready) {
    Write-Host "[REDIS] Project redis started (PID $($proc.Id)). Slot held."
} else {
    Write-Host "[REDIS] WARN: started redis (PID $($proc.Id)) mais pas de PONG; slot held." -ForegroundColor Yellow
}
while ($true) { Start-Sleep -Seconds 3600 }