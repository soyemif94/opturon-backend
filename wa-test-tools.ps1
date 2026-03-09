[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('Test-PhoneNumberAccess', 'Send-TestMessage', 'Show-SetupInstructions')]
    [string]$Command,

    [Parameter(Mandatory = $false)]
    [string]$To,

    [Parameter(Mandatory = $false)]
    [string]$Text,

    [Parameter(Mandatory = $false)]
    [string]$GraphVersion = 'v22.0'
)

$ErrorActionPreference = 'Stop'

function Read-EnvFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw ".env not found at: $Path"
    }

    $map = @{}
    $lines = Get-Content -LiteralPath $Path

    foreach ($line in $lines) {
        if ($null -eq $line) { continue }
        $trimmed = $line.Trim()
        if ($trimmed -eq '') { continue }
        if ($trimmed.StartsWith('#')) { continue }

        $idx = $trimmed.IndexOf('=')
        if ($idx -lt 1) { continue }

        $key = $trimmed.Substring(0, $idx).Trim()
        $value = $trimmed.Substring($idx + 1).Trim()

        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        $map[$key] = $value
    }

    return $map
}

function Parse-GraphError {
    param([Parameter(Mandatory = $true)]$ErrorRecord)

    $raw = $null

    try {
        if ($ErrorRecord.Exception.Response -and $ErrorRecord.Exception.Response.GetResponseStream) {
            $stream = $ErrorRecord.Exception.Response.GetResponseStream()
            if ($stream) {
                $reader = New-Object System.IO.StreamReader($stream)
                $raw = $reader.ReadToEnd()
            }
        }
    }
    catch {}

    if (-not $raw -and $ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
        $raw = $ErrorRecord.ErrorDetails.Message
    }

    if (-not $raw) {
        $raw = $ErrorRecord.Exception.Message
    }

    $json = $null
    try { $json = $raw | ConvertFrom-Json } catch {}

    $statusCode = $null
    try {
        if ($ErrorRecord.Exception.Response -and $ErrorRecord.Exception.Response.StatusCode) {
            $statusCode = [int]$ErrorRecord.Exception.Response.StatusCode
        }
    }
    catch {}

    return [pscustomobject]@{
        StatusCode = $statusCode
        Raw        = $raw
        Json       = $json
    }
}

function Invoke-GraphJson {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('GET','POST')][string]$Method,
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Token,
        [Parameter(Mandatory = $false)]$BodyObject
    )

    $headers = @{ Authorization = "Bearer $Token" }

    $splat = @{
        Method  = $Method
        Uri     = $Url
        Headers = $headers
    }

    if ($PSVersionTable.PSVersion.Major -lt 6) {
        $splat['UseBasicParsing'] = $true
    }

    if ($Method -eq 'POST') {
        $splat['ContentType'] = 'application/json'
        if ($null -ne $BodyObject) {
            $splat['Body'] = ($BodyObject | ConvertTo-Json -Depth 10)
        }
    }

    try {
        $result = Invoke-RestMethod @splat
        return [pscustomobject]@{
            Ok    = $true
            Data  = $result
            Error = $null
        }
    }
    catch {
        $parsed = Parse-GraphError -ErrorRecord $_
        return [pscustomobject]@{
            Ok    = $false
            Data  = $null
            Error = $parsed
        }
    }
}

function Show-GraphError {
    param([Parameter(Mandatory = $true)]$ErrorObj)

    $err = $null
    if ($ErrorObj.Json -and $ErrorObj.Json.error) {
        $err = $ErrorObj.Json.error
    }

    if ($err) {
        $code = $err.code
        $subcode = $err.error_subcode
        $message = $err.message
        $details = $null

        if ($err.error_data -and $err.error_data.details) {
            $details = $err.error_data.details
        }

        if ($code -eq 131030) {
            Write-Host 'ERROR 131030: Recipient not authorized. Add number in WhatsApp Cloud API -> API Setup -> Add recipient' -ForegroundColor Red
        }
        elseif ($code) {
            Write-Host ("ERROR {0}: {1}" -f $code, $message) -ForegroundColor Red
        }
        else {
            Write-Host ("ERROR: {0}" -f $message) -ForegroundColor Red
        }

        Write-Host ("code: {0}" -f $code)
        Write-Host ("error_subcode: {0}" -f $subcode)
        Write-Host ("details: {0}" -f $details)
    }
    else {
        Write-Host 'ERROR: Graph request failed' -ForegroundColor Red
        if ($ErrorObj.StatusCode) {
            Write-Host ("http_status: {0}" -f $ErrorObj.StatusCode)
        }
        Write-Host ("details: {0}" -f $ErrorObj.Raw)
    }
}

function Normalize-ToNumber {
    param([Parameter(Mandatory = $true)][string]$Value)
    return ($Value.Trim() -replace '\s+', '' -replace '^\+', '')
}

function Show-SetupInstructions {
    Write-Host 'WhatsApp Cloud API TEST NUMBER setup:' -ForegroundColor Cyan
    Write-Host '1) Ir a developers.facebook.com/apps'
    Write-Host '2) Abrir tu App -> WhatsApp -> API Setup'
    Write-Host '3) En Test Numbers, hacer click en Add recipient'
    Write-Host '4) Verificar el número (código por WhatsApp/SMS)'
    Write-Host '5) Reintentar envio con Send-TestMessage'
}

# Load .env from script directory (project root expected)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath = Join-Path -Path $scriptDir -ChildPath '.env'
$envMap = Read-EnvFile -Path $envPath

$accessToken = $envMap['WHATSAPP_ACCESS_TOKEN']
$phoneNumberId = $envMap['WHATSAPP_PHONE_NUMBER_ID']

if ([string]::IsNullOrWhiteSpace($accessToken)) {
    throw 'WHATSAPP_ACCESS_TOKEN not found in .env'
}
if ([string]::IsNullOrWhiteSpace($phoneNumberId)) {
    throw 'WHATSAPP_PHONE_NUMBER_ID not found in .env'
}

$baseUrl = "https://graph.facebook.com/$GraphVersion"

switch ($Command) {
    'Show-SetupInstructions' {
        Show-SetupInstructions
        break
    }

    'Test-PhoneNumberAccess' {
        $url = "$baseUrl/$phoneNumberId?fields=id,display_phone_number,verified_name"
        $resp = Invoke-GraphJson -Method 'GET' -Url $url -Token $accessToken

        if ($resp.Ok) {
            Write-Host 'SUCCESS: Phone number access OK' -ForegroundColor Green
            Write-Host ("id: {0}" -f $resp.Data.id)
            Write-Host ("display_phone_number: {0}" -f $resp.Data.display_phone_number)
            Write-Host ("verified_name: {0}" -f $resp.Data.verified_name)
            exit 0
        }

        Show-GraphError -ErrorObj $resp.Error
        exit 1
    }

    'Send-TestMessage' {
        if ([string]::IsNullOrWhiteSpace($To)) {
            throw 'Send-TestMessage requires -To "549XXXXXXXXX"'
        }
        if ([string]::IsNullOrWhiteSpace($Text)) {
            throw 'Send-TestMessage requires -Text "mensaje"'
        }

        $toNormalized = Normalize-ToNumber -Value $To
        $url = "$baseUrl/$phoneNumberId/messages"

        $body = @{
            messaging_product = 'whatsapp'
            to = $toNormalized
            type = 'text'
            text = @{ body = $Text }
        }

        $resp = Invoke-GraphJson -Method 'POST' -Url $url -Token $accessToken -BodyObject $body

        if ($resp.Ok) {
            $messageId = $null
            if ($resp.Data.messages -and $resp.Data.messages.Count -gt 0) {
                $messageId = $resp.Data.messages[0].id
            }

            Write-Host 'SUCCESS: Message sent' -ForegroundColor Green
            if ($messageId) {
                Write-Host ("message_id: {0}" -f $messageId)
            }
            exit 0
        }

        Show-GraphError -ErrorObj $resp.Error
        exit 1
    }

    default {
        throw "Unknown command: $Command"
    }
}
