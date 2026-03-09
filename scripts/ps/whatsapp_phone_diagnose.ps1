Param()

$ErrorActionPreference = "Stop"

function Import-DotEnvFile {
  Param([string]$Path)

  if (-not (Test-Path $Path)) {
    return
  }

  Get-Content $Path | ForEach-Object {
    $line = [string]$_
    if ([string]::IsNullOrWhiteSpace($line)) { return }
    if ($line.TrimStart().StartsWith('#')) { return }
    $eqIndex = $line.IndexOf('=')
    if ($eqIndex -le 0) { return }

    $name = $line.Substring(0, $eqIndex).Trim()
    $value = $line.Substring($eqIndex + 1).Trim()

    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'Process'))) {
      [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
  }
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Import-DotEnvFile -Path (Join-Path $repoRoot '.env')

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
  Write-Error "WHATSAPP_WABA_ID is required."
  exit 1
}

$baseUrl = "https://graph.facebook.com/$apiVersion"
$headers = @{
  Authorization = "Bearer $token"
  "Content-Type" = "application/json"
}

function Read-GraphErrorBody {
  Param($Exception)

  $rawResponse = $Exception.Response
  if ($null -eq $rawResponse) {
    return $null
  }

  $reader = New-Object System.IO.StreamReader($rawResponse.GetResponseStream())
  return $reader.ReadToEnd()
}

function Invoke-GraphRequest {
  Param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Url
  )

  Write-Host ("URL => " + $Url)

  try {
    $response = Invoke-RestMethod -Method $Method -Uri $Url -Headers $headers -ErrorAction Stop
    return @{
      ok = $true
      status = 200
      data = $response
      errorBody = $null
    }
  } catch {
    $statusCode = $null
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $statusCode = [int]$_.Exception.Response.StatusCode
    }

    $errorBody = Read-GraphErrorBody -Exception $_.Exception
    return @{
      ok = $false
      status = $statusCode
      data = $null
      errorBody = $errorBody
      exceptionMessage = $_.Exception.Message
    }
  }
}

function Select-PhoneFields {
  Param($Phone)

  if ($null -eq $Phone) {
    return $null
  }

  return [ordered]@{
    id = $Phone.id
    display_phone_number = $Phone.display_phone_number
    verified_name = $Phone.verified_name
    quality_rating = $Phone.quality_rating
    code_verification_status = $Phone.code_verification_status
    name_status = $Phone.name_status
    account_mode = $Phone.account_mode
    platform_type = $Phone.platform_type
    status = $Phone.status
  }
}

$configuredFields = "id,display_phone_number,verified_name"
$phoneUrl = "{0}/{1}?fields={2}" -f $baseUrl, $phoneNumberId, $configuredFields
$phoneResult = Invoke-GraphRequest -Method "GET" -Url $phoneUrl

$wabaFields = "id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,account_mode,platform_type,status"
$wabaPhonesUrl = "{0}/{1}/phone_numbers?fields={2}" -f $baseUrl, $wabaId, $wabaFields
$wabaPhonesResult = Invoke-GraphRequest -Method "GET" -Url $wabaPhonesUrl

$matchingPhone = $null
$wabaPhones = @()
if ($wabaPhonesResult.ok -and $wabaPhonesResult.data -and $wabaPhonesResult.data.data) {
  $wabaPhones = @($wabaPhonesResult.data.data)
  foreach ($phone in $wabaPhones) {
    if ([string]$phone.id -eq $phoneNumberId) {
      $matchingPhone = $phone
      break
    }
  }
}

Write-Host ""
Write-Host ("Configured Phone Number ID: " + $phoneNumberId)
Write-Host ("Configured WABA ID: " + $wabaId)

Write-Host ""
Write-Host "Configured Phone Number Asset:"
if ($phoneResult.ok) {
  Select-PhoneFields -Phone $phoneResult.data | ConvertTo-Json -Depth 10
} else {
  Write-Host "Graph asset found: NO"
  if ($phoneResult.status) {
    Write-Host ("HTTP Status: " + [string]$phoneResult.status)
  }
  if ($phoneResult.errorBody) {
    Write-Host "Graph Error:"
    Write-Host $phoneResult.errorBody
  } else {
    Write-Host ("Graph Error: " + [string]$phoneResult.exceptionMessage)
  }
}

Write-Host ""
Write-Host "Configured WABA Phone Numbers:"
if ($wabaPhonesResult.ok) {
  if ($wabaPhones.Count -gt 0) {
    $wabaPhones | ForEach-Object { Select-PhoneFields -Phone $_ } | ConvertTo-Json -Depth 10
  } else {
    Write-Host "[]"
  }
} else {
  Write-Host "WABA phone_numbers lookup failed."
  if ($wabaPhonesResult.status) {
    Write-Host ("HTTP Status: " + [string]$wabaPhonesResult.status)
  }
  if ($wabaPhonesResult.errorBody) {
    Write-Host "Graph Error:"
    Write-Host $wabaPhonesResult.errorBody
  } else {
    Write-Host ("Graph Error: " + [string]$wabaPhonesResult.exceptionMessage)
  }
}

Write-Host ""
Write-Host ("Phone Number appears under configured WABA: " + ($(if ($matchingPhone) { "YES" } else { "NO" })))

Write-Host ""
Write-Host "Likely conclusion:"
if (-not $phoneResult.ok) {
  Write-Host "- Graph could not fetch the configured phone number asset with the current token."
  Write-Host "- Verify token access, phone number ID, and app/business permissions."
} elseif (-not $wabaPhonesResult.ok) {
  Write-Host "- The phone number asset exists, but the configured WABA phone_numbers lookup failed."
  Write-Host "- Verify WABA ID, token access, and business permissions."
} elseif (-not $matchingPhone) {
  Write-Host "- The configured phone number ID was fetched directly but does NOT appear under the configured WABA phone_numbers list."
  Write-Host "- Verify that the number is attached to WABA $wabaId and that WHATSAPP_WABA_ID is correct."
} else {
  Write-Host "- The configured phone number ID is listed under the configured WABA."
  Write-Host "- If send API still fails with (#133010) Account not registered, the likely blocker is Meta-side registration/onboarding state, not local channel resolution."
}
