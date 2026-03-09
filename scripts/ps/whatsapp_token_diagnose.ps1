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
$apiVersion = [string]$Env:WHATSAPP_API_VERSION

if ([string]::IsNullOrWhiteSpace($apiVersion)) {
  $apiVersion = "v22.0"
}

if ([string]::IsNullOrWhiteSpace($token)) {
  Write-Error "WHATSAPP_ACCESS_TOKEN is required."
  exit 1
}

$baseUrl = "https://graph.facebook.com/$apiVersion"
$headers = @{
  Authorization = "Bearer $token"
  "Content-Type" = "application/json"
}

function Invoke-GraphGet {
  Param(
    [Parameter(Mandatory = $true)][string]$Url,
    [hashtable]$Headers = $null
  )

  Write-Host ("URL => " + $Url)
  $effectiveHeaders = if ($Headers) { $Headers } else { $headers }

  try {
    $response = Invoke-RestMethod -Method Get -Uri $Url -Headers $effectiveHeaders -ErrorAction Stop
    return @{
      ok = $true
      status = 200
      data = $response
      errorBody = $null
      exceptionMessage = $null
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

    if ($result.data -and $result.data.data) {
      $items += @($result.data.data)
    }

    if ($result.data -and $result.data.paging -and $result.data.paging.next) {
      $nextUrl = [string]$result.data.paging.next
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

$meResult = Invoke-GraphGet -Url ("{0}/me?fields=id,name" -f $baseUrl)
$permissionsResult = Invoke-GraphGet -Url ("{0}/me/permissions" -f $baseUrl)
$businessesResult = Get-PagedItems -Url ("{0}/me/businesses?fields=id,name" -f $baseUrl)
$debugTokenUrl = "{0}/debug_token?input_token={1}&access_token={1}" -f $baseUrl, [System.Uri]::EscapeDataString($token)
$debugTokenResult = Invoke-GraphGet -Url $debugTokenUrl -Headers @{}

$wabas = @()
if ($businessesResult.ok) {
  foreach ($business in $businessesResult.items) {
    $businessId = [string]$business.id
    if ([string]::IsNullOrWhiteSpace($businessId)) { continue }
    $wabaResult = Get-PagedItems -Url ("{0}/{1}/owned_whatsapp_business_accounts?fields=id,name" -f $baseUrl, $businessId)
    if (-not $wabaResult.ok) { continue }

    foreach ($waba in $wabaResult.items) {
      $wabas += [PSCustomObject]@{
        id = $waba.id
        name = $waba.name
        businessId = $business.id
        businessName = $business.name
      }
    }
  }
}

Write-Host ""
Write-Host ("Token valid: " + ($(if ($meResult.ok) { "YES" } else { "UNKNOWN/NO" })))

Write-Host ""
Write-Host "Token /me:"
if ($meResult.ok) {
  $meResult.data | ConvertTo-Json -Depth 10
} else {
  if ($meResult.errorBody) { Write-Host $meResult.errorBody } else { Write-Host $meResult.exceptionMessage }
}

Write-Host ""
Write-Host "Token debug_token:"
if ($debugTokenResult.ok) {
  $debugTokenResult.data | ConvertTo-Json -Depth 20
} else {
  Write-Host "debug_token unavailable with current token/context."
  if ($debugTokenResult.status) { Write-Host ("HTTP Status: " + [string]$debugTokenResult.status) }
  if ($debugTokenResult.errorBody) { Write-Host $debugTokenResult.errorBody } else { Write-Host $debugTokenResult.exceptionMessage }
}

Write-Host ""
Write-Host "Token permissions:"
if ($permissionsResult.ok) {
  $permissionsResult.data | ConvertTo-Json -Depth 20
} else {
  Write-Host "permissions lookup unavailable with current token/context."
  if ($permissionsResult.status) { Write-Host ("HTTP Status: " + [string]$permissionsResult.status) }
  if ($permissionsResult.errorBody) { Write-Host $permissionsResult.errorBody } else { Write-Host $permissionsResult.exceptionMessage }
}

Write-Host ""
Write-Host "Businesses visible:"
if ($businessesResult.ok) {
  if ($businessesResult.items.Count -gt 0) {
    $businessesResult.items | ConvertTo-Json -Depth 10
  } else {
    Write-Host "[]"
  }
} else {
  Write-Host "businesses lookup failed."
  if ($businessesResult.status) { Write-Host ("HTTP Status: " + [string]$businessesResult.status) }
  if ($businessesResult.errorBody) { Write-Host $businessesResult.errorBody } else { Write-Host $businessesResult.exceptionMessage }
}

Write-Host ""
Write-Host "WABAs visible:"
if ($wabas.Count -gt 0) {
  $wabas | ConvertTo-Json -Depth 10
} else {
  Write-Host "[]"
}

Write-Host ""
Write-Host "Likely conclusion:"
if (-not $meResult.ok) {
  Write-Host "- The token could not complete a basic /me query."
  Write-Host "- Verify token validity first."
} elseif ($businessesResult.ok -and $businessesResult.items.Count -eq 0) {
  Write-Host "- The token appears valid enough for direct Graph use, but no businesses are visible."
  Write-Host "- This supports limited asset visibility or wrong token/business linkage."
} elseif ($businessesResult.ok -and $businessesResult.items.Count -gt 0 -and $wabas.Count -eq 0) {
  Write-Host "- The token can see businesses but no owned WhatsApp Business Accounts."
  Write-Host "- This supports missing WhatsApp asset visibility for the current token/system user."
} elseif ($wabas.Count -gt 0) {
  Write-Host "- The token can see at least one WABA."
  Write-Host "- Cross-check those WABAs against the configured WHATSAPP_WABA_ID and the phone number diagnostics."
} else {
  Write-Host "- Graph token introspection is limited in this context."
  Write-Host "- Use this output together with diag:wa:phone and diag:wa:asset-link."
}
