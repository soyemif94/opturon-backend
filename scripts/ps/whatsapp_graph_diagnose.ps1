Param(
  [string]$ApiVersion = $Env:WHATSAPP_API_VERSION,
  [string]$PhoneNumberId = $Env:WHATSAPP_PHONE_NUMBER_ID
)

$ErrorActionPreference = "Stop"

$token = [string]$Env:WHATSAPP_ACCESS_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
  Write-Error "WHATSAPP_ACCESS_TOKEN is required."
  exit 1
}

if ([string]::IsNullOrWhiteSpace($ApiVersion)) {
  $ApiVersion = "v22.0"
}

$baseUrl = "https://graph.facebook.com/" + $ApiVersion

function Invoke-GraphGet {
  Param([string]$Url)

  Write-Host ""
  Write-Host ("URL => " + $Url)
  Write-Host "GET"

  try {
    $resp = Invoke-WebRequest -Method Get -Uri $Url -Headers @{ Authorization = "Bearer $token" } -ErrorAction Stop
    Write-Host ("HTTP => " + [int]$resp.StatusCode)
    Write-Host ("BODY => " + $resp.Content)
    return @{
      status = [int]$resp.StatusCode
      body = $resp.Content
    }
  } catch {
    $response = $_.Exception.Response
    if ($null -ne $response) {
      $status = [int]$response.StatusCode
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
      $body = $reader.ReadToEnd()
      Write-Host ("HTTP => " + $status)
      Write-Host ("BODY => " + $body)
      return @{
        status = $status
        body = $body
      }
    }

    Write-Host "HTTP => EXCEPTION"
    Write-Host ("BODY => " + $_.Exception.Message)
    return @{
      status = -1
      body = $_.Exception.Message
    }
  }
}

function Get-ItemsFromPagedResponse {
  Param([string]$Url)

  $items = @()
  $next = $Url
  while (-not [string]::IsNullOrWhiteSpace($next)) {
    $result = Invoke-GraphGet -Url $next
    if ($result.status -lt 200 -or $result.status -ge 300) {
      break
    }

    $json = $null
    try {
      $json = $result.body | ConvertFrom-Json
    } catch {
      break
    }

    if ($json.data) {
      $items += @($json.data)
    }

    if ($json.paging -and $json.paging.next) {
      $next = [string]$json.paging.next
    } else {
      $next = $null
    }
  }

  return $items
}

if (-not [string]::IsNullOrWhiteSpace($PhoneNumberId)) {
  $idUrl = $baseUrl + "/" + $PhoneNumberId + "?fields=id,display_phone_number,verified_name"
  [void](Invoke-GraphGet -Url $idUrl)
}

$businessesUrl = $baseUrl + "/me/businesses?fields=id,name"
$businesses = Get-ItemsFromPagedResponse -Url $businessesUrl

Write-Host ""
Write-Host "Businesses discovered: $($businesses.Count)"
if ($businesses.Count -gt 0) {
  $businesses | ConvertTo-Json -Depth 6
}

$allWabas = @()
foreach ($business in $businesses) {
  if (-not $business.id) { continue }
  $wabaUrl = $baseUrl + "/" + $business.id + "/owned_whatsapp_business_accounts?fields=id,name"
  $wabas = Get-ItemsFromPagedResponse -Url $wabaUrl
  foreach ($w in $wabas) {
    $allWabas += [PSCustomObject]@{
      id = $w.id
      name = $w.name
      businessId = $business.id
    }
  }
}

Write-Host ""
Write-Host "WABAs discovered: $($allWabas.Count)"
if ($allWabas.Count -gt 0) {
  $allWabas | ConvertTo-Json -Depth 6
}

$allPhoneNumbers = @()
foreach ($waba in $allWabas) {
  if (-not $waba.id) { continue }
  $phonesUrl = $baseUrl + "/" + $waba.id + "/phone_numbers?fields=id,display_phone_number,verified_name"
  $phones = Get-ItemsFromPagedResponse -Url $phonesUrl
  foreach ($p in $phones) {
    $allPhoneNumbers += [PSCustomObject]@{
      id = $p.id
      display_phone_number = $p.display_phone_number
      verified_name = $p.verified_name
      wabaId = $waba.id
    }
  }
}

Write-Host ""
Write-Host "Phone numbers discovered: $($allPhoneNumbers.Count)"
if ($allPhoneNumbers.Count -gt 0) {
  $allPhoneNumbers | ConvertTo-Json -Depth 6
  Write-Host ""
  Write-Host ("Recommended WHATSAPP_PHONE_NUMBER_ID => " + [string]$allPhoneNumbers[0].id)
} else {
  Write-Host ""
  Write-Host "Recommended WHATSAPP_PHONE_NUMBER_ID => (none)"
}
