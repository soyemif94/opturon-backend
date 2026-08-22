Param()

$ErrorActionPreference = "Stop"

$token = [string]$Env:WHATSAPP_ACCESS_TOKEN
$phoneNumberId = [string]$Env:WHATSAPP_PHONE_NUMBER_ID
$wabaId = [string]$Env:WHATSAPP_WABA_ID
$apiVersion = [string]$Env:WHATSAPP_API_VERSION

if ([string]::IsNullOrWhiteSpace($apiVersion)) {
  $apiVersion = "v22.0"
}

if ([string]::IsNullOrWhiteSpace($token)) {
  Write-Error "WHATSAPP_ACCESS_TOKEN is required."
  exit 1
}

if ([string]::IsNullOrWhiteSpace($phoneNumberId)) {
  Write-Error "WHATSAPP_PHONE_NUMBER_ID is required."
  exit 1
}

if ([string]::IsNullOrWhiteSpace($wabaId)) {
  Write-Error "WHATSAPP_WABA_ID is required because the phone number object does not expose whatsapp_business_account in this Graph API call."
  exit 1
}

$baseUrl = "https://graph.facebook.com/$apiVersion"
$headers = @{
  Authorization = "Bearer $token"
  "Content-Type" = "application/json"
}

function Invoke-GraphRequest {
  Param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Url
  )

  Write-Host ("URL => " + $Url)

  try {
    return Invoke-RestMethod -Method $Method -Uri $Url -Headers $headers -ErrorAction Stop
  } catch {
    $rawResponse = $_.Exception.Response
    if ($null -ne $rawResponse) {
      $reader = New-Object System.IO.StreamReader($rawResponse.GetResponseStream())
      $body = $reader.ReadToEnd()
      if (-not [string]::IsNullOrWhiteSpace($body)) {
        Write-Host $body
      }
    }
    throw
  }
}

$phoneLookupUrl = "{0}/{1}?fields=id,display_phone_number,verified_name" -f $baseUrl, $phoneNumberId
$phone = Invoke-GraphRequest -Method "GET" -Url $phoneLookupUrl

$subscribedApps = Invoke-GraphRequest -Method "GET" -Url "$baseUrl/$wabaId/subscribed_apps"
$appItems = @()
if ($subscribedApps -and $subscribedApps.data) {
  $appItems = @($subscribedApps.data)
}

$appId = [string]$Env:WHATSAPP_APP_ID
if ([string]::IsNullOrWhiteSpace($appId)) {
  Write-Error "WHATSAPP_APP_ID is required to verify the WABA subscription."
  exit 1
}

$isSubscribed = $false
if ($appItems.Count -eq 0) {
  $isSubscribed = $false
} else {
  foreach ($app in $appItems) {
    $candidateAppId = $null
    if ($app.whatsapp_business_api_data -and $app.whatsapp_business_api_data.id) {
      $candidateAppId = [string]$app.whatsapp_business_api_data.id
    } else {
      Write-Error "Unexpected subscribed_apps response shape. Refusing to infer subscription state."
      exit 1
    }

    if (-not [string]::IsNullOrWhiteSpace($candidateAppId) -and $candidateAppId -eq $appId) {
      $isSubscribed = $true
      break
    }
  }
}

Write-Host ("Phone Number ID: " + [string]$phone.id)
Write-Host ("Phone Number: " + [string]$phone.display_phone_number)
Write-Host ("Verified Name: " + [string]$phone.verified_name)
Write-Host ("WABA ID: " + $wabaId)
Write-Host "Subscribed Apps:"
if ($appItems.Count -gt 0) {
  $appItems | ConvertTo-Json -Depth 10
} else {
  Write-Host "[]"
}

if (-not $isSubscribed) {
  Write-Host "App is NOT subscribed to WABA"
  Write-Error "Read-only diagnostic failed: expected app is not subscribed. No changes were made."
  exit 2
}

Write-Host "App is subscribed to WABA"
