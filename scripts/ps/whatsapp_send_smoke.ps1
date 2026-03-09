Param(
  [Parameter(Mandatory = $false)][string]$ApiVersion = $Env:WHATSAPP_API_VERSION,
  [Parameter(Mandatory = $false)][string]$PhoneNumberId = $Env:WHATSAPP_PHONE_NUMBER_ID,
  [Parameter(Mandatory = $true)][string]$To,
  [Parameter(Mandatory = $true)][string]$Text
)

$ErrorActionPreference = "Stop"

$token = [string]$Env:WHATSAPP_ACCESS_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
  Write-Error "WHATSAPP_ACCESS_TOKEN is required."
  exit 1
}

if ([string]::IsNullOrWhiteSpace($PhoneNumberId)) {
  Write-Error "WHATSAPP_PHONE_NUMBER_ID is required (param or env)."
  exit 1
}

if ([string]::IsNullOrWhiteSpace($ApiVersion)) {
  $ApiVersion = "v22.0"
}

$toSanitized = ($To -replace "\s", "") -replace "^\+", ""
if ($toSanitized -notmatch "^\d{8,15}$") {
  Write-Error "To must be E164 digits without plus (8-15 digits)."
  exit 1
}

$url = "https://graph.facebook.com/" + $ApiVersion + "/" + $PhoneNumberId + "/messages"
$payload = @{
  messaging_product = "whatsapp"
  to = $toSanitized
  type = "text"
  text = @{
    body = $Text
  }
} | ConvertTo-Json -Depth 6

Write-Host ("URL => " + $url)
Write-Host "POST"
Write-Host $payload

try {
  $resp = Invoke-WebRequest -Method Post -Uri $url -Headers @{
    Authorization = "Bearer $token"
    "Content-Type" = "application/json"
  } -Body $payload -ErrorAction Stop
  Write-Host ("STATUS => " + [int]$resp.StatusCode)
  Write-Host ("BODY => " + $resp.Content)
} catch {
  $response = $_.Exception.Response
  if ($null -ne $response) {
    $status = [int]$response.StatusCode
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    $body = $reader.ReadToEnd()
    Write-Host ("STATUS => " + $status)
    Write-Host ("BODY => " + $body)
    exit 1
  }

  Write-Host "STATUS => EXCEPTION"
  Write-Host ("BODY => " + $_.Exception.Message)
  exit 1
}
