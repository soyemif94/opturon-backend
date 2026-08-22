[CmdletBinding()]
param(
  [string]$TenantId = 'tenant_cliente_demo_02_20260312',
  [string]$AdminTenantId = 'tenant_1772601586508_w1e4fs',
  [string]$ChannelId = '7f86db7a-0b3f-4aeb-9546-d0f2f921456a',
  [string]$ClinicId = 'a335961a-75c3-443b-a35f-5cc8dd243b1d',
  [string]$LegacyChannelId = 'b3ef8ab5-4610-4571-a91b-e34d10b98dfa',
  [string]$WabaId = '27184268844495361',
  [string]$PhoneNumberId = '1070249406167861',
  [string]$BackendBaseUrl = 'https://opturon-api.onrender.com',
  [string]$GraphVersion = 'v22.0',
  [string]$RenderPostgresId = 'dpg-d6n741q4d50c73dan0eg-a',
  [string]$RenderServiceId = 'srv-d6n7i5vgi27c73c954t0',
  [switch]$SelfTest,
  [switch]$HttpErrorSelfTest
)

$ErrorActionPreference = 'Stop'
$ConfirmationLiteral = 'ROTATE_WHATSAPP_SYSTEM_USER_TOKEN'

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
    return [BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant()
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
  if ($PSBoundParameters.ContainsKey('Body')) { $parameters.Body = $Body }
  try {
    $result = Invoke-WebRequest @parameters
    return [pscustomobject]@{ StatusCode = [int]$result.StatusCode; Content = [string]$result.Content }
  } catch {
    $errorRecord = $_
    $exception = $errorRecord.Exception
    $response = $null
    while ($exception -and -not $response) {
      $property = $exception.PSObject.Properties['Response']
      if ($property -and $property.Value) { $response = $property.Value }
      $exception = $exception.InnerException
    }
    if (-not $response) { throw 'HTTP request failed before receiving a response.' }
    $statusCode = $null
    if ($response.PSObject.Properties['StatusCode']) { $statusCode = [int]$response.StatusCode }
    $content = [string]$errorRecord.ErrorDetails.Message
    if (-not $content -and $response.PSObject.Methods['GetResponseStream']) {
      $stream = $null
      $reader = $null
      try {
        $stream = $response.GetResponseStream()
        if ($stream) {
          $reader = New-Object IO.StreamReader($stream)
          $content = $reader.ReadToEnd()
        }
      } finally {
        if ($reader) { $reader.Dispose() }
        if ($stream) { $stream.Dispose() }
      }
    }
    if (-not $content -and $response.PSObject.Properties['Content'] -and $response.Content) {
      $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    }
    return [pscustomobject]@{ StatusCode = $statusCode; Content = [string]$content }
  } finally {
    $parameters.Headers = $null
    $parameters.Body = $null
  }
}

function Invoke-JsonRequest {
  param(
    [string]$Name,
    [string]$Uri,
    [string]$Method = 'GET',
    [hashtable]$Headers = @{},
    [string]$Body = $null,
    [int[]]$ExpectedStatus = @(200)
  )
  $response = if ($PSBoundParameters.ContainsKey('Body')) {
    Invoke-CompatibleWebRequest -Uri $Uri -Method $Method -Headers $Headers -Body $Body
  } else {
    Invoke-CompatibleWebRequest -Uri $Uri -Method $Method -Headers $Headers
  }
  $json = $null
  try { $json = $response.Content | ConvertFrom-Json }
  catch { throw "$Name returned an invalid JSON response (HTTP $($response.StatusCode))." }
  if ($ExpectedStatus -notcontains [int]$response.StatusCode) {
    $safeError = if ($json.error) { [string]$json.error } else { 'unexpected_http_status' }
    throw "$Name failed: HTTP $($response.StatusCode); error=$safeError"
  }
  return [pscustomobject]@{ StatusCode = [int]$response.StatusCode; Json = $json }
}

function Invoke-MetaRead([string]$RequestName, [string]$Path, [string]$Token) {
  $headers = @{ Authorization = "Bearer $Token" }
  try {
    return Invoke-JsonRequest -Name $RequestName -Uri "https://graph.facebook.com/$GraphVersion/$Path" -Headers $headers
  } finally {
    $headers.Authorization = $null
  }
}

function Invoke-LocalRotationHelper {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('PREFLIGHT', 'ROTATE', 'VERIFY')][string]$Mode,
    [string]$Payload = $null
  )
  $node = (Get-Command node -ErrorAction Stop).Source
  $helperPath = Join-Path $PSScriptRoot 'whatsapp-production-system-user-token-rotate.js'
  if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) { throw 'Local rotation helper was not found.' }
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $node
  $startInfo.Arguments = "`"$helperPath`" --mode=$Mode"
  $startInfo.WorkingDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  if (-not $script:OperationalDatabaseUrl -or -not $script:OperationalEncryptionKey) {
    throw 'Operational database credentials are not loaded.'
  }
  $startInfo.EnvironmentVariables['DATABASE_URL'] = $script:OperationalDatabaseUrl
  $startInfo.EnvironmentVariables['TOKENS_ENCRYPTION_KEY'] = $script:OperationalEncryptionKey
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw 'Local rotation helper could not start.' }
    if ($PSBoundParameters.ContainsKey('Payload')) { $process.StandardInput.Write($Payload) }
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "Local rotation helper failed with exit code $($process.ExitCode)." }
    $resultLine = @($stdout -split "`r?`n") | Where-Object { $_ -like 'ROTATION_RESULT_JSON=*' } | Select-Object -Last 1
    if (-not $resultLine) { throw 'Local rotation helper did not return a result.' }
    return ($resultLine.Substring('ROTATION_RESULT_JSON='.Length) | ConvertFrom-Json)
  } finally {
    $Payload = $null
    $stdout = $null
    $stderr = $null
    if ($process) { $process.Dispose() }
    $startInfo = $null
  }
}

function Get-RenderOperationalSecrets {
  $configPath = Join-Path $env:USERPROFILE '.render\cli.yaml'
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw 'Render CLI authentication is not configured.'
  }
  $config = Get-Content -Raw -LiteralPath $configPath
  $keyMatch = [regex]::Match($config, '(?m)^\s*key:\s*([^\r\n]+)\s*$')
  if (-not $keyMatch.Success) { throw 'Render CLI API credential is missing.' }
  $renderApiKey = $keyMatch.Groups[1].Value.Trim()
  $renderHeaders = @{ Authorization = "Bearer $renderApiKey"; Accept = 'application/json' }
  try {
    $connectionInfo = Invoke-RestMethod `
      -Uri "https://api.render.com/v1/postgres/$([Uri]::EscapeDataString($RenderPostgresId))/connection-info" `
      -Headers $renderHeaders -Method GET -ErrorAction Stop
    $environment = Invoke-RestMethod `
      -Uri "https://api.render.com/v1/services/$([Uri]::EscapeDataString($RenderServiceId))/env-vars" `
      -Headers $renderHeaders -Method GET -ErrorAction Stop
    $encryptionEntry = @($environment) | Where-Object { [string]$_.envVar.key -eq 'TOKENS_ENCRYPTION_KEY' } | Select-Object -First 1
    $databaseBuilder = New-Object UriBuilder([string]$connectionInfo.externalConnectionString)
    $queryParts = @{}
    foreach ($part in $databaseBuilder.Query.TrimStart('?').Split('&', [StringSplitOptions]::RemoveEmptyEntries)) {
      $pair = $part.Split('=', 2)
      $queryParts[$pair[0]] = if ($pair.Count -gt 1) { $pair[1] } else { '' }
    }
    $queryParts['sslmode'] = 'no-verify'
    $databaseBuilder.Query = (($queryParts.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join '&')
    $databaseUrl = $databaseBuilder.Uri.AbsoluteUri
    $encryptionKey = if ($encryptionEntry) { [string]$encryptionEntry.envVar.value } else { $null }
    if (-not $databaseUrl -or -not $encryptionKey) { throw 'Required Render operational secrets are unavailable.' }
    return [pscustomobject]@{ DatabaseUrl = $databaseUrl; EncryptionKey = $encryptionKey }
  } finally {
    $config = $null
    $renderApiKey = $null
    if ($renderHeaders) { $renderHeaders.Authorization = $null }
    $renderHeaders = $null
    $connectionInfo = $null
    $environment = $null
    $encryptionEntry = $null
    $databaseBuilder = $null
    $queryParts = $null
    $databaseUrl = $null
    $encryptionKey = $null
  }
}

function Assert-Equal([string]$Name, $Actual, $Expected) {
  if ([string]$Actual -cne [string]$Expected) {
    throw "$Name precondition failed."
  }
}

if ($SelfTest) {
  $fingerprint = Get-SafeFingerprint 'opturon-system-user-token-rotation-self-test'
  if ($fingerprint -notmatch '^[0-9a-f]{64}$') { throw 'Fingerprint compatibility self-test failed.' }
  if (-not (Get-Command Invoke-WebRequest).Parameters.ContainsKey('UseBasicParsing')) {
    throw 'Invoke-WebRequest compatibility self-test failed.'
  }
  if ($HttpErrorSelfTest) {
    $httpResponse = Invoke-CompatibleWebRequest -Uri 'https://graph.facebook.com' -Method GET
    if ([int]$httpResponse.StatusCode -lt 400) { throw 'HTTP error compatibility self-test failed.' }
    $httpJson = $httpResponse.Content | ConvertFrom-Json
    if (-not $httpJson.error) { throw 'Graph error-body compatibility self-test failed.' }
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
$securePortalKey = Read-Host 'PORTAL_INTERNAL_KEY productiva (entrada oculta)' -AsSecureString
$token = ConvertTo-PlainText $secureToken
$portalKey = ConvertTo-PlainText $securePortalKey
$body = $null
$headers = $null
$script:OperationalDatabaseUrl = $null
$script:OperationalEncryptionKey = $null

try {
  if (-not $token -or -not $portalKey) { throw 'Token y PORTAL_INTERNAL_KEY son obligatorios.' }
  $renderSecrets = Get-RenderOperationalSecrets
  $script:OperationalDatabaseUrl = $renderSecrets.DatabaseUrl
  $script:OperationalEncryptionKey = $renderSecrets.EncryptionKey
  $renderSecrets = $null
  $tokenFingerprint = Get-SafeFingerprint $token
  [pscustomobject]@{
    tokenPresent = $true
    tokenLength = $token.Length
    tokenFingerprint = $tokenFingerprint
  } | Format-List

  $headers = @{ 'x-portal-key' = $portalKey; 'content-type' = 'application/json' }
  $base = $BackendBaseUrl.TrimEnd('/')
  $tenantEscaped = [Uri]::EscapeDataString($TenantId)
  $preflight = Invoke-LocalRotationHelper -Mode PREFLIGHT
  if (-not $preflight.ok -or -not $preflight.ownershipConfirmed) {
    throw 'Production ownership preflight did not pass.'
  }
  $pre = $preflight
  Assert-Equal 'channelId' $pre.canonical.id $ChannelId
  Assert-Equal 'clinicId' $pre.canonical.clinicId $ClinicId
  Assert-Equal 'provider' $pre.canonical.provider 'whatsapp_cloud'
  Assert-Equal 'WABA' $pre.canonical.wabaId $WabaId
  Assert-Equal 'Phone Number ID' $pre.canonical.phoneNumberId $PhoneNumberId
  Assert-Equal 'canonical status' $pre.canonical.status 'active'
  Assert-Equal 'legacy channel' $pre.legacy.id $LegacyChannelId
  Assert-Equal 'legacy status' $pre.legacy.status 'inactive'
  if (@($pre.activeOwners).Count -ne 1 -or [string]$pre.activeOwners[0].id -ne $ChannelId) {
    throw 'Phone Number ID active ownership precondition failed.'
  }
  if ([string]$pre.credentialFingerprint -eq $tokenFingerprint) {
    throw 'El credential nuevo tiene el mismo fingerprint que el persistido.'
  }
  [pscustomobject]@{
    productionPreflight = 'PASS'
    channelId = $pre.canonical.id
    clinicId = $pre.canonical.clinicId
    wabaId = $pre.canonical.wabaId
    phoneNumberId = $pre.canonical.phoneNumberId
    activeOwnerCount = @($pre.activeOwners).Count
    legacyStatus = $pre.legacy.status
    preCredentialFingerprint = $pre.credentialFingerprint
  } | Format-List

  $waba = Invoke-MetaRead -RequestName 'GET WABA pre-rotation' -Path "$WabaId`?fields=id,name" -Token $token
  Assert-Equal 'Meta WABA' $waba.Json.id $WabaId
  $phones = Invoke-MetaRead -RequestName 'GET phone_numbers pre-rotation' `
    -Path "$WabaId/phone_numbers?fields=id,display_phone_number,verified_name,status,quality_rating&limit=100" `
    -Token $token
  $phone = @($phones.Json.data) | Where-Object { [string]$_.id -eq $PhoneNumberId } | Select-Object -First 1
  if (-not $phone) { throw 'El Phone Number ID esperado no fue devuelto por Meta.' }
  $templates = Invoke-MetaRead -RequestName 'GET templates pre-rotation' `
    -Path "$WabaId/message_templates?fields=id,name,language,status,category&limit=100" `
    -Token $token
  [pscustomobject]@{
    wabaHttp = $waba.StatusCode
    phoneNumbersHttp = $phones.StatusCode
    matchedPhoneNumberId = [string]$phone.id
    templatesHttp = $templates.StatusCode
    templateCount = @($templates.Json.data).Count
  } | Format-List
  @($templates.Json.data) | Select-Object name, language, status, category | Format-Table -AutoSize

  if ((Read-Host "Escriba $ConfirmationLiteral para rotar exclusivamente el credential") -cne $ConfirmationLiteral) {
    throw 'Rotación cancelada por el operador.'
  }

  $body = @{ confirmation = $ConfirmationLiteral; accessToken = $token } | ConvertTo-Json -Compress
  $rotation = Invoke-LocalRotationHelper -Mode ROTATE -Payload $body
  if (-not $rotation.ok) { throw 'Credential rotation was not confirmed.' }
  $rotated = $rotation
  Assert-Equal 'WABA POST' $rotated.target.wabaId $WabaId
  Assert-Equal 'Phone Number ID POST' $rotated.target.phoneNumberId $PhoneNumberId
  Assert-Equal 'clinicId POST' $rotated.target.clinicId $ClinicId
  Assert-Equal 'channelId POST' $rotated.target.channelId $ChannelId
  Assert-Equal 'credential fingerprint POST' $rotated.postCredentialFingerprint $tokenFingerprint
  if ([string]$rotated.preCredentialFingerprint -eq [string]$rotated.postCredentialFingerprint) {
    throw 'Credential fingerprint did not change.'
  }
  if (-not $rotated.immutableIdentityPreserved -or -not $rotated.ownershipConfirmed) {
    throw 'Post-rotation immutable identity assertion failed.'
  }
  $body = $null

  $adminEscaped = [Uri]::EscapeDataString($AdminTenantId)
  $adminActor = Invoke-JsonRequest -Name 'Opturon admin actor lookup' `
    -Uri "$base/portal/auth/admin-actor?tenantId=$adminEscaped" -Headers $headers
  $actorId = [string]$adminActor.Json.data.id
  if (-not $actorId) { throw 'No admin actor is available for template sync.' }
  $syncHeaders = @{
    'x-portal-key' = $portalKey
    'x-portal-actor-id' = $actorId
    'x-active-tenant-id' = $TenantId
    'content-type' = 'application/json'
  }
  try {
    $sync = Invoke-JsonRequest -Name 'Canonical template sync' `
      -Uri "$base/portal/tenants/$adminEscaped/whatsapp/templates/sync" `
      -Method POST -Headers $syncHeaders -Body '{}'
  } finally {
    $syncHeaders['x-portal-key'] = $null
  }
  if (-not $sync.Json.success -or [string]$sync.Json.data.channelId -ne $ChannelId) {
    throw 'Template sync did not resolve the canonical channel.'
  }
  $expectedTemplate = @($sync.Json.data.templates) | Where-Object {
    [string]$_.metaTemplateName -eq 'inventory_lot_expiring_v1' -and
    [string]$_.language -eq 'es_AR' -and
    [string]$_.status -ieq 'APPROVED' -and
    [string]$_.category -ieq 'UTILITY'
  } | Select-Object -First 1
  if (-not $expectedTemplate) { throw 'Expected approved inventory template was not found after sync.' }

  $status = Invoke-JsonRequest -Name 'WhatsApp status regression' `
    -Uri "$base/portal/tenants/$tenantEscaped/whatsapp/status" -Headers $headers
  $templateDb = Invoke-JsonRequest -Name 'WhatsApp templates DB regression' `
    -Uri "$base/portal/tenants/$tenantEscaped/whatsapp/templates" -Headers $headers
  $inbox = Invoke-JsonRequest -Name 'Inbox regression' `
    -Uri "$base/portal/tenants/$tenantEscaped/conversations?limit=1" -Headers $headers
  $sourceInbox = Invoke-JsonRequest -Name 'Source tenant isolation regression' `
    -Uri "$base/portal/tenants/$adminEscaped/conversations?limit=1" -Headers $headers
  $canaryHeaders = @{
    'x-portal-key' = $portalKey
    'x-portal-actor-id' = $actorId
    'x-active-tenant-id' = $TenantId
  }
  try {
    $canary = Invoke-JsonRequest -Name 'Canary read-only regression' `
      -Uri "$base/portal/tenants/$adminEscaped/whatsapp/templates/canary" -Headers $canaryHeaders
  } finally {
    $canaryHeaders['x-portal-key'] = $null
  }

  [pscustomobject]@{
    rotation = 'PASS'
    channelId = $rotated.target.channelId
    wabaPre = $WabaId
    wabaPost = $rotated.target.wabaId
    phoneNumberIdPre = $PhoneNumberId
    phoneNumberIdPost = $rotated.target.phoneNumberId
    credentialFingerprintPre = $rotated.preCredentialFingerprint
    credentialFingerprintPost = $rotated.postCredentialFingerprint
    postWabaHttp = $rotated.postMeta.wabaHttp
    postPhoneNumbersHttp = $rotated.postMeta.phoneNumbersHttp
    postTemplatesHttp = $rotated.postMeta.templatesHttp
    templateSyncCount = $sync.Json.data.syncedCount
    expectedTemplateFound = $true
    whatsappStatusHttp = $status.StatusCode
    templatesDbHttp = $templateDb.StatusCode
    inboxHttp = $inbox.StatusCode
    sourceInboxHttp = $sourceInbox.StatusCode
    canaryReadOnlyHttp = $canary.StatusCode
    readyForRealCanary = $true
  } | Format-List
} finally {
  $token = $null
  $portalKey = $null
  $body = $null
  if ($headers) { $headers['x-portal-key'] = $null }
  $headers = $null
  $secureToken = $null
  $securePortalKey = $null
  $script:OperationalDatabaseUrl = $null
  $script:OperationalEncryptionKey = $null
  [Net.ServicePointManager]::SecurityProtocol = $originalSecurityProtocol
  [GC]::Collect()
}
