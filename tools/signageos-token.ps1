# Zet het signageOS API-token in config.local.json (blijft lokaal, gaat niet naar GitHub).
# Gebruik: powershell -ExecutionPolicy Bypass -File tools\signageos-token.ps1
$root = Split-Path -Parent $PSScriptRoot
$file = Join-Path $root 'config.local.json'

$cfg = if (Test-Path $file) { Get-Content $file -Raw | ConvertFrom-Json } else { New-Object PSObject }

$id = (Read-Host 'signageOS token ID').Trim()
$secretSecure = Read-Host 'signageOS token secret' -AsSecureString
$secret = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secretSecure)).Trim()
if (-not $id -or -not $secret) { Write-Host 'Token ID en secret zijn allebei nodig; niets gewijzigd.' -ForegroundColor Red; exit 1 }

$sos = New-Object PSObject -Property @{ tokenId = $id; tokenSecret = $secret }
if ($cfg.PSObject.Properties['signageos']) { $cfg.signageos = $sos } else { $cfg | Add-Member -NotePropertyName signageos -NotePropertyValue $sos }

# UTF-8 zonder BOM, zodat Node het bestand kan lezen.
[IO.File]::WriteAllText($file, ($cfg | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
Write-Host "Opgeslagen in $file. Herstart de tool om signageOS te gebruiken." -ForegroundColor Green
