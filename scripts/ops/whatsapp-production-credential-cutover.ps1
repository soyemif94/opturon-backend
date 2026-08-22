[CmdletBinding()]
param(
  [string]$TenantId = 'tenant_cliente_demo_02_20260312',
  [string]$WabaId = '27184268844495361',
  [string]$PhoneNumberId = '1070249406167861',
  [string]$BackendBaseUrl = 'https://opturon-api.onrender.com',
  [string]$GraphVersion = 'v22.0',
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

function ConvertTo-PlainText([Security.SecureString]$SecureValue) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Get-SafeFingerprint([string]$Value) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  $hash = $null
  try {
    $hash = $algorithm.ComputeHash($bytes)
    return ([BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant()).Substring(0, 12)
  } finally {
    if ($hash) { [Array]::Clear($hash, 0, $hash.Length) }
    [Array]::Clear($bytes, 0, $bytes.Length)
    $algorithm.Dispose()
  }
}

function Invoke-CompatibleWebRequest {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$Method,
    [hashtable]$Headers = @{},
    [string]$Body = $null
  )

  $parameters = @{
    Uri = $Uri
    Method = $Method
    Headers = $Headers
    UseBasicParsing = $true
    ErrorAction = 'Stop'
  }
  if ($null -ne $Body) { $parameters.Body = $Body }

  try {
    return Invoke-WebRequest @parameters
  } catch {
    $statusCode = $null
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $statusCode = [int]$_.Exception.Response.StatusCode
    }
    if ($statusCode) { throw "HTTP request failed with status $statusCode." }
    throw 'HTTP request failed before receiving a response.'
  } finally {
    $parameters.Headers = $null
    $parameters.Body = $null
  }
}

function Invoke-MetaRead([string]$Path, [string]$Token) {
  $headers = @{ Authorization = "Bearer $Token" }
  try {
    $response = Invoke-CompatibleWebRequest -Uri "https://graph.facebook.com/$GraphVersion/$Path" -Headers $headers -Method GET
    $json = $response.Content | ConvertFrom-Json
    if ([int]$response.StatusCode -ne 200) {
      throw "Meta HTTP $([int]$response.StatusCode): code=$($json.error.code) subcode=$($json.error.error_subcode) type=$($json.error.type)"
    }
    return $json
  } finally {
    $headers.Authorization = $null
  }
}

if ($SelfTest) {
  $fingerprint = Get-SafeFingerprint 'opturon-powershell-compat-self-test'
  if ($fingerprint -notmatch '^[0-9a-f]{12}$') { throw 'Fingerprint compatibility self-test failed.' }
  if (-not (Get-Command Invoke-WebRequest).Parameters.ContainsKey('UseBasicParsing')) {
    throw 'Invoke-WebRequest compatibility self-test failed.'
  }
  [pscustomobject]@{
    compatibilitySelfTest = 'PASS'
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    edition = if ($PSVersionTable.PSEdition) { $PSVersionTable.PSEdition } else { 'Desktop' }
  } | Format-List
  return
}

$originalSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol
if (($originalSecurityProtocol -band [Net.SecurityProtocolType]::Tls12) -eq 0) {
  [Net.ServicePointManager]::SecurityProtocol = $originalSecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

$secureToken = Read-Host 'Nuevo System User token (entrada oculta)' -AsSecureString
$token = ConvertTo-PlainText $secureToken
$portalKey = [string]$env:PORTAL_INTERNAL_KEY
if (-not $portalKey) {
  $securePortalKey = Read-Host 'PORTAL_INTERNAL_KEY productiva (entrada oculta)' -AsSecureString
  $portalKey = ConvertTo-PlainText $securePortalKey
}

try {
  if (-not $token -or -not $portalKey) { throw 'Token y PORTAL_INTERNAL_KEY son obligatorios.' }
  [pscustomobject]@{
    tokenPresent = $true
    tokenLength = $token.Length
    tokenFingerprint = Get-SafeFingerprint $token
  } | Format-List

  $waba = Invoke-MetaRead -Path "$WabaId`?fields=id,name" -Token $token
  if ([string]$waba.id -ne $WabaId) { throw 'Meta devolvió un WABA distinto.' }

  $phones = Invoke-MetaRead -Path "$WabaId/phone_numbers?fields=id,display_phone_number,verified_name,status,quality_rating&limit=100" -Token $token
  $phone = @($phones.data) | Where-Object { [string]$_.id -eq $PhoneNumberId } | Select-Object -First 1
  if (-not $phone) { throw 'El Phone Number ID no pertenece al WABA indicado. Cutover bloqueado.' }

  $templates = Invoke-MetaRead -Path "$WabaId/message_templates?fields=id,name,language,status,category,components&limit=100" -Token $token
  [pscustomobject]@{
    wabaHttp = 200
    phoneNumbersHttp = 200
    matchedPhoneNumberId = [string]$phone.id
    displayPhoneMasked = if ($phone.display_phone_number) { '***' + (([string]$phone.display_phone_number -replace '\D', '').Substring(([string]$phone.display_phone_number -replace '\D', '').Length - 4)) } else { $null }
    templatesHttp = 200
    templateCount = @($templates.data).Count
  } | Format-List
  @($templates.data) | Select-Object name, language, status, category | Format-Table -AutoSize

  if ((Read-Host 'Escriba CUTOVER para actualizar el channel existente') -cne 'CUTOVER') {
    throw 'Cutover cancelado por el operador.'
  }

  $body = @{
    wabaId = $WabaId
    phoneNumberId = $PhoneNumberId
    accessToken = $token
    channelName = [string]$phone.verified_name
  } | ConvertTo-Json -Compress
  $requestHeaders = @{ 'x-portal-key' = $portalKey; 'content-type' = 'application/json' }
  $response = Invoke-CompatibleWebRequest `
    -Uri "$($BackendBaseUrl.TrimEnd('/'))/portal/tenants/$([Uri]::EscapeDataString($TenantId))/whatsapp/manual-connect" `
    -Method POST `
    -Headers $requestHeaders `
    -Body $body
  $result = $response.Content | ConvertFrom-Json
  if ([int]$response.StatusCode -ne 200 -or -not $result.success) {
    throw "Opturon HTTP $([int]$response.StatusCode): $($result.error) $($result.detail)"
  }
  [pscustomobject]@{
    opturonHttp = [int]$response.StatusCode
    channelAction = $result.data.channelAction
    channelId = $result.data.channel.id
    wabaId = $result.data.channel.wabaId
    phoneNumberId = $result.data.channel.phoneNumberId
    status = $result.data.channel.status
  } | Format-List
} finally {
  $token = $null
  $portalKey = $null
  $body = $null
  $requestHeaders = $null
  $secureToken = $null
  $securePortalKey = $null
  [Net.ServicePointManager]::SecurityProtocol = $originalSecurityProtocol
  [GC]::Collect()
}
