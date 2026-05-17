$ErrorActionPreference = "Stop"
$pgsqlDir = "C:\Users\HAMDI\Desktop\pgsql"
$dataDir = "$pgsqlDir\data"

if (-not (Test-Path "$pgsqlDir\pw.txt")) {
    "stitch123" | Out-File "$pgsqlDir\pw.txt" -Encoding ascii
}

if (-not (Test-Path $dataDir)) {
    Write-Host "Initializing Database Cluster..."
    & "$pgsqlDir\bin\initdb.exe" -D $dataDir -U postgres --auth=md5 --pwfile="$pgsqlDir\pw.txt"
} else {
    Write-Host "Data directory already exists."
}

Write-Host "Starting Database Server..."
& "$pgsqlDir\bin\pg_ctl.exe" -D $dataDir -l "$pgsqlDir\logfile.txt" start
