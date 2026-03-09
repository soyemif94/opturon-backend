param(
  [string]$PublicHost = ''
)

$ErrorActionPreference = 'Stop'

if (-not $PublicHost) {
  $PublicHost = if ($env:PROD_PUBLIC_HOST) { [string]$env:PROD_PUBLIC_HOST } else { 'api.opturon.com' }
}
$PublicHost = $PublicHost.Trim().TrimEnd('.')
$queryHost = "$PublicHost."

Write-Host "Verifying DNS using 1.1.1.1 for host: $PublicHost"

try {
  $outputLines = cmd.exe /c "nslookup $queryHost 1.1.1.1 2>&1"
  $outputText = ($outputLines | Out-String)
  Write-Host $outputText
} catch {
  Write-Error "nslookup failed: $($_.Exception.Message)"
  exit 1
}

$unexpectedSuffixDetected = $false
$escapedHost = [Regex]::Escape($PublicHost)
$queryWasFqdn = $queryHost.EndsWith('.')
if ($outputText -match "$escapedHost\.com\.ar") {
  $unexpectedSuffixDetected = $true
}
if (-not $queryWasFqdn -and $outputText -match '\.com\.ar\b' -and $PublicHost -notmatch '\.com\.ar$') {
  $unexpectedSuffixDetected = $true
}

if ($unexpectedSuffixDetected) {
  Write-Host "FAIL: unexpected suffix detected in DNS resolution (possible ISP/appended search suffix)."
  Write-Host "Suggestion: run npm run tunnel:route"
  exit 1
}

$hasCfArgoTarget = $outputText -match '(?i)cfargotunnel\.com'
$hasAnyAddress = $outputText -match '(?im)^\s*Address(?:es)?:\s+' -or $outputText -match '(?im)^\s*Address:\s+'
$hasName = $outputText -match "(?im)^\s*(Name|Nombre):\s*$escapedHost\.?\s*$"

if ($hasCfArgoTarget -or ($hasName -and $hasAnyAddress)) {
  Write-Host "DNS verification OK for $PublicHost"
  exit 0
}

Write-Host "FAIL: DNS verification could not confirm expected resolution for $PublicHost"
Write-Host "Suggestion: run npm run tunnel:route"
exit 1
