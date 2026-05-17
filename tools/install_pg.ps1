$ErrorActionPreference = "Stop"

$installerUrl = "https://sbp.enterprisedb.com/getfile.jsp?fileid=1259020" # This is PostgreSQL 16.2.1 Windows x64 (or similar direct link from EDB, actually EDB links often redirect or expire).
# A safer URL that doesn't expire easily is the direct installer from EnterpriseDB latest:
$installerUrl = "https://get.enterprisedb.com/postgresql/postgresql-16.2-1-windows-x64.exe"

$installerPath = "$env:TEMP\postgresql-16-setup.exe"
$installDir = "C:\PostgreSQL\16"
$password = "stitch123"

Write-Host "Downloading PostgreSQL 16 installer..."
Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath

Write-Host "Installing PostgreSQL silently... (This may take a few minutes)"
$installArgs = @(
    "--mode", "unattended",
    "--superpassword", $password,
    "--serverport", "5432",
    "--prefix", $installDir,
    "--datadir", "$installDir\data"
)

$processOptions = @{
    FilePath = $installerPath
    ArgumentList = $installArgs
    Wait = $true
    NoNewWindow = $true
}

$process = Start-Process @processOptions -PassThru
if ($process.ExitCode -eq 0) {
    Write-Host "PostgreSQL installed successfully!"
} else {
    Write-Host "Installation failed with exit code: $($process.ExitCode)"
}
