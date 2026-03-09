param(
  [string]$PhoneNumberId,
  [string]$WaId,
  [string]$DebugKey
)

$base = "http://localhost:3001"

if (-not $PhoneNumberId) {
  throw "PhoneNumberId is required"
}

if (-not $WaId) {
  throw "WaId is required"
}

function Send-Test {
  param([string]$Text)

  $json = Get-Content "scripts/tests/sample-inbound.json" -Raw
  $json = $json.Replace("{{PHONE_NUMBER_ID}}", $PhoneNumberId)
  $json = $json.Replace("{{WA_ID}}", $WaId)
  $json = $json.Replace("{{TEXT}}", $Text)

  Invoke-RestMethod `
    -Method POST `
    -Uri "$base/webhook" `
    -ContentType "application/json" `
    -Body $json | Out-Null
}

Write-Host "TEST 1 lead"
Send-Test "Hola necesito turno"
Start-Sleep 2

Write-Host "TEST 2 confirm"
Send-Test "1"
Start-Sleep 2

Write-Host "TEST 3 cancel"
Send-Test "cancelar turno"
Start-Sleep 2

Write-Host "TEST 4 pricing"
Send-Test "precio consulta"
Start-Sleep 2

Write-Host "TEST 5 handoff"
Send-Test "quiero hablar con una persona"
Start-Sleep 2

if ($DebugKey) {
  Write-Host "DEBUG leads"
  curl.exe -sS -H "x-debug-key: $DebugKey" "$base/debug/phase2/leads"

  Write-Host "DEBUG appointments"
  curl.exe -sS -H "x-debug-key: $DebugKey" "$base/debug/phase2/appointments"
}

Write-Host "DONE"
