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
$configuredWabaId = [string]$Env:WHATSAPP_WABA_ID
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

$baseUrl = "https://graph.facebook.com/$apiVersion"
$headers = @{
  Authorization = "Bearer $token"
  "Content-Type" = "application/json"
}

function Invoke-GraphGet {
  Param([string]$Url)

  Write-Host ("URL => " + $Url)

  try {
    $response = Invoke-RestMethod -Method Get -Uri $Url -Headers $headers -ErrorAction Stop
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

    $errorBody = $null
    if ($_.Exception.Response) {
      $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      $errorBody = $reader.ReadToEnd()
    }

    return @{
      ok = $false
      status = $statusCode
      data = $null
      errorBody = $errorBody
      exceptionMessage = $_.Exception.Message
    }
  }
}

function Get-PagedItems {
  Param([string]$Url)

  $items = @()
  $nextUrl = $Url
  while (-not [string]::IsNullOrWhiteSpace($nextUrl)) {
    $result = Invoke-GraphGet -Url $nextUrl
    if (-not $result.ok) {
      return @{
        ok = $false
        items = @()
        status = $result.status
        errorBody = $result.errorBody
        exceptionMessage = $result.exceptionMessage
      }
    }

    $data = $result.data
    if ($data -and $data.data) {
      $items += @($data.data)
    }

    if ($data -and $data.paging -and $data.paging.next) {
      $nextUrl = [string]$data.paging.next
    } else {
      $nextUrl = $null
    }
  }

  return @{
    ok = $true
    items = $items
    status = 200
    errorBody = $null
    exceptionMessage = $null
  }
}

function Select-PhoneFields {
  Param($Phone, [string]$WabaId = $null, [string]$BusinessId = $null, [string]$BusinessName = $null, [string]$WabaName = $null)

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
    wabaId = $WabaId
    wabaName = $WabaName
    businessId = $BusinessId
    businessName = $BusinessName
  }
}

$phoneLookup = Invoke-GraphGet -Url ("{0}/{1}?fields=id,display_phone_number,verified_name" -f $baseUrl, $phoneNumberId)
$businesses = Get-PagedItems -Url ("{0}/me/businesses?fields=id,name" -f $baseUrl)

$wabas = @()
$phonesUnderAccessibleWabas = @()

if ($businesses.ok) {
  foreach ($business in $businesses.items) {
    $businessId = [string]$business.id
    if ([string]::IsNullOrWhiteSpace($businessId)) { continue }

    $wabaResult = Get-PagedItems -Url ("{0}/{1}/owned_whatsapp_business_accounts?fields=id,name" -f $baseUrl, $businessId)
    if (-not $wabaResult.ok) { continue }

    foreach ($waba in $wabaResult.items) {
      $wabaId = [string]$waba.id
      if ([string]::IsNullOrWhiteSpace($wabaId)) { continue }

      $wabas += [PSCustomObject]@{
        id = $wabaId
        name = $waba.name
        businessId = $business.id
        businessName = $business.name
      }

      $phoneResult = Get-PagedItems -Url ("{0}/{1}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,account_mode,platform_type,status" -f $baseUrl, $wabaId)
      if (-not $phoneResult.ok) { continue }

      foreach ($phone in $phoneResult.items) {
        $phonesUnderAccessibleWabas += [PSCustomObject](Select-PhoneFields -Phone $phone -WabaId $wabaId -BusinessId $business.id -BusinessName $business.name -WabaName $waba.name)
      }
    }
  }
}

$matchingPhoneRows = @($phonesUnderAccessibleWabas | Where-Object { [string]$_.id -eq $phoneNumberId })
$configuredWabaRows = @($phonesUnderAccessibleWabas | Where-Object { [string]$_.wabaId -eq $configuredWabaId })

Write-Host ""
Write-Host ("Configured Phone Number ID: " + $phoneNumberId)
Write-Host ("Configured WABA ID: " + $configuredWabaId)

Write-Host ""
Write-Host "Direct phone asset lookup:"
if ($phoneLookup.ok) {
  Select-PhoneFields -Phone $phoneLookup.data | ConvertTo-Json -Depth 10
} else {
  Write-Host "Graph Error:"
  if ($phoneLookup.errorBody) { Write-Host $phoneLookup.errorBody } else { Write-Host $phoneLookup.exceptionMessage }
}

Write-Host ""
Write-Host "Accessible WABAs discovered:"
if ($wabas.Count -gt 0) {
  $wabas | ConvertTo-Json -Depth 10
} else {
  Write-Host "[]"
}

Write-Host ""
Write-Host "Phone numbers under accessible WABAs:"
if ($phonesUnderAccessibleWabas.Count -gt 0) {
  $phonesUnderAccessibleWabas | ConvertTo-Json -Depth 10
} else {
  Write-Host "[]"
}

Write-Host ""
Write-Host "Matching configured phone under accessible WABAs:"
if ($matchingPhoneRows.Count -gt 0) {
  $matchingPhoneRows | ConvertTo-Json -Depth 10
} else {
  Write-Host "[]"
}

Write-Host ""
Write-Host "Numbers under configured WABA:"
if ($configuredWabaRows.Count -gt 0) {
  $configuredWabaRows | ConvertTo-Json -Depth 10
} else {
  Write-Host "[]"
}

Write-Host ""
Write-Host "Likely conclusion:"
if (-not $phoneLookup.ok) {
  Write-Host "- The configured phone number ID could not be fetched directly with this token."
  Write-Host "- Do not change .env yet. First verify token access and the phone number ID."
} elseif ($matchingPhoneRows.Count -gt 0) {
  $matchedWabaId = [string]$matchingPhoneRows[0].wabaId
  if (-not [string]::IsNullOrWhiteSpace($configuredWabaId) -and $matchedWabaId -ne $configuredWabaId) {
    Write-Host "- The configured phone number appears under an accessible WABA different from WHATSAPP_WABA_ID."
    Write-Host "- This would prove the current WHATSAPP_WABA_ID is wrong."
  } else {
    Write-Host "- The configured phone number appears under the configured WABA."
    Write-Host "- If send still fails, the likely issue is registration/onboarding state in Meta."
  }
} elseif ($phonesUnderAccessibleWabas.Count -gt 0) {
  Write-Host "- The phone number exists as a direct asset but does NOT appear under any accessible WABA phone_numbers list."
  Write-Host "- This supports that the number is not properly attached to an accessible/operational WABA or is not fully registered."
} else {
  Write-Host "- No accessible WABAs/phone numbers were discovered with the current token."
  Write-Host "- Do not change .env yet. First verify token scope and business access."
}
