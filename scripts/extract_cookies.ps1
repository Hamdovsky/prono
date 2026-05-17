# AFRICANOBET CHROME COOKIE EXTRACTOR — PowerShell Native DPAPI
# Lit et déchiffre les cookies directement avec le contexte utilisateur courant

Add-Type -AssemblyName System.Security

$ChromeData = "$env:LOCALAPPDATA\Google\Chrome\User Data"
$LocalState = "$ChromeData\Local State"
$OutputFile = "$PSScriptRoot\..\data\africanobet_cookies.json"
$TmpDb      = "$env:TEMP\africanobet_cookies_tmp.db"
$Target     = "africanobet.com"

# ── Get AES Key ──────────────────────────────────────────────────────────────
$aesKey = $null
try {
    $state      = Get-Content $LocalState -Raw | ConvertFrom-Json
    $encKeyB64  = $state.os_crypt.encrypted_key
    $encKeyFull = [System.Convert]::FromBase64String($encKeyB64)
    $encKey     = $encKeyFull[5..($encKeyFull.Length-1)]  # strip "DPAPI" prefix
    $aesKey     = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $encKey, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    Write-Host "✅ Clé AES récupérée ($($aesKey.Length) bytes)" -ForegroundColor Green
} catch {
    Write-Host "⚠️  Clé AES indisponible: $_" -ForegroundColor Yellow
}

# ── AES-256-GCM decrypt ───────────────────────────────────────────────────────
function Decrypt-CookieValue {
    param([byte[]]$encrypted, [byte[]]$key)
    
    if (-not $encrypted -or $encrypted.Length -eq 0) { return "" }
    
    # Check v10/v11 prefix
    $prefix = [System.Text.Encoding]::ASCII.GetString($encrypted[0..2])
    
    if ($prefix -eq "v10" -or $prefix -eq "v11") {
        if (-not $key) { return "[AES-LOCKED]" }
        try {
            $nonce      = $encrypted[3..14]
            $tag        = $encrypted[($encrypted.Length-16)..($encrypted.Length-1)]
            $ciphertext = $encrypted[15..($encrypted.Length-17)]
            
            $aes = [System.Security.Cryptography.AesGcm]::new([byte[]]$key)
            $plaintext = New-Object byte[] $ciphertext.Length
            $aes.Decrypt([byte[]]$nonce, [byte[]]$ciphertext, [byte[]]$tag, $plaintext)
            $aes.Dispose()
            return [System.Text.Encoding]::UTF8.GetString($plaintext)
        } catch {
            return ""
        }
    } else {
        # Old DPAPI
        try {
            $dec = [System.Security.Cryptography.ProtectedData]::Unprotect(
                $encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
            )
            return [System.Text.Encoding]::UTF8.GetString($dec)
        } catch {
            return ""
        }
    }
}

# ── Scan all profiles ─────────────────────────────────────────────────────────
$profiles  = @("Default","Profile 3","Profile 4","Profile 5","Profile 7",
               "Profile 8","Profile 9","Profile 10","Profile 11","Profile 12")
$allCookies = @()

Add-Type -Path "$PSScriptRoot\..\..\..\..\AppData\Roaming\npm\node_modules\better-sqlite3\build\Release\better_sqlite3.node" -ErrorAction SilentlyContinue

# Use System.Data.SQLite if available, otherwise copy and use sqlite3.exe
$sqlite3 = Get-Command sqlite3 -ErrorAction SilentlyContinue

foreach ($p in $profiles) {
    $dbPaths = @(
        "$ChromeData\$p\Network\Cookies",
        "$ChromeData\$p\Cookies"
    )
    $dbPath = $dbPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $dbPath) { continue }

    $sizeKB = [math]::Round((Get-Item $dbPath).Length / 1024, 1)

    try {
        Copy-Item $dbPath $TmpDb -Force
        
        if ($sqlite3) {
            # Use sqlite3 CLI
            $query  = "SELECT host_key, name, hex(encrypted_value), path, expires_utc, is_secure, is_httponly, samesite FROM cookies WHERE host_key LIKE '%$Target%';"
            $rows   = & sqlite3 $TmpDb $query 2>$null
            
            foreach ($row in $rows) {
                $cols  = $row -split '\|'
                if ($cols.Count -lt 4) { continue }
                
                $encHex = $cols[2]
                $encBytes = if ($encHex) {
                    [byte[]] ($encHex -split '(..)' | Where-Object { $_ } | ForEach-Object { [Convert]::ToByte($_, 16) })
                } else { @() }
                
                $value   = Decrypt-CookieValue $encBytes $aesKey
                $expires = if ($cols[4]) { [math]::Floor(([long]$cols[4] - 11644473600000000) / 1000000) } else { 0 }
                
                $allCookies += [PSCustomObject]@{
                    name     = $cols[1]
                    value    = $value
                    domain   = $cols[0]
                    path     = if ($cols[3]) { $cols[3] } else { "/" }
                    expires  = $expires
                    httpOnly = ($cols[6] -eq "1")
                    secure   = ($cols[5] -eq "1")
                    sameSite = @("Strict","Lax","None")[[int]($cols[7] -replace '[^0-9]','0')]
                }
                
                $preview = if ($value) { $value.Substring(0, [Math]::Min(30, $value.Length)) } else { "[vide]" }
                Write-Host "   [$p] $($cols[1]) = $preview" -ForegroundColor $(if($value){"Green"}else{"Yellow"})
            }
            
            if ($rows) {
                Write-Host "📁 $p | $sizeKB KB | $($rows.Count) cookies africanobet" -ForegroundColor Cyan
            }
        }
        
        Remove-Item $TmpDb -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Host "  ❌ $p : $_" -ForegroundColor Red
        Remove-Item $TmpDb -Force -ErrorAction SilentlyContinue
    }
}

# ── Save JSON ─────────────────────────────────────────────────────────────────
$valid = $allCookies | Where-Object { $_.value -and $_.value.Length -gt 0 }

if ($allCookies.Count -eq 0) {
    Write-Host "`n⚠️  Aucun cookie africanobet trouvé." -ForegroundColor Red
    exit 1
}

$toSave = if ($valid.Count -gt 0) { $valid } else { $allCookies }
$outDir = Split-Path $OutputFile -Parent
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory $outDir -Force | Out-Null }

$toSave | ConvertTo-Json -Depth 3 | Set-Content $OutputFile -Encoding UTF8
Write-Host "`n✅ $($toSave.Count) cookies → $OutputFile" -ForegroundColor Green
Write-Host "🚀 Lance: node scripts/africanobet_scraper.js`n" -ForegroundColor Cyan
