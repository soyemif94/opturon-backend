[CmdletBinding()]
param(
    [string]$Token,
    [string]$GraphVersion = 'v22.0'
)

$ErrorActionPreference = 'Stop'

function Convert-SecureStringToPlain {
    param([Parameter(Mandatory = $true)][System.Security.SecureString]$Secure)
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Ensure-DiagDir {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -Path $Path -ItemType Directory -Force | Out-Null
    }
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Object
    )
    $json = $Object | ConvertTo-Json -Depth 50
    [System.IO.File]::WriteAllText((Resolve-Path -LiteralPath (Split-Path -Parent $Path)).Path + '\\' + (Split-Path -Leaf $Path), $json, [System.Text.Encoding]::UTF8)
}

function Parse-GraphErrorBody {
    param([Parameter(Mandatory = $true)]$ErrorRecord)

    $rawBody = $null

    try {
        if ($ErrorRecord.Exception.Response -and $ErrorRecord.Exception.Response.GetResponseStream) {
            $stream = $ErrorRecord.Exception.Response.GetResponseStream()
            if ($stream) {
                $reader = New-Object System.IO.StreamReader($stream)
                $rawBody = $reader.ReadToEnd()
            }
        }
    }
    catch {}

    if (-not $rawBody -and $ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
        $rawBody = $ErrorRecord.ErrorDetails.Message
    }

    if (-not $rawBody) {
        $rawBody = $ErrorRecord.Exception.Message
    }

    $jsonBody = $null
    try { $jsonBody = $rawBody | ConvertFrom-Json } catch {}

    return [pscustomobject]@{
        Raw  = $rawBody
        Json = $jsonBody
    }
}

function Get-StatusCodeFromError {
    param([Parameter(Mandatory = $true)]$ErrorRecord)

    try {
        if ($ErrorRecord.Exception.Response -and $ErrorRecord.Exception.Response.StatusCode) {
            return [int]$ErrorRecord.Exception.Response.StatusCode
        }
    }
    catch {}

    return $null
}

function Invoke-GraphJson {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$AccessToken
    )

    $headers = @{ Authorization = "Bearer $AccessToken" }

    try {
        $response = Invoke-RestMethod -Method GET -Uri $Url -Headers $headers
        return [pscustomobject]@{
            Ok     = $true
            Url    = $Url
            Status = 200
            Data   = $response
            Error  = $null
        }
    }
    catch {
        $status = Get-StatusCodeFromError -ErrorRecord $_
        $parsedErr = Parse-GraphErrorBody -ErrorRecord $_

        Write-Host "" 
        Write-Host "[Graph ERROR] $Url" -ForegroundColor Yellow
        if ($status) {
            Write-Host "HTTP Status: $status" -ForegroundColor Yellow
        }

        if ($parsedErr.Json -and $parsedErr.Json.error) {
            $e = $parsedErr.Json.error
            Write-Host ("message: {0}" -f $e.message)
            Write-Host ("type: {0}" -f $e.type)
            Write-Host ("code: {0}" -f $e.code)
            Write-Host ("error_subcode: {0}" -f $e.error_subcode)
            Write-Host ("fbtrace_id: {0}" -f $e.fbtrace_id)
        }
        else {
            Write-Host "raw_error_body:"
            Write-Host $parsedErr.Raw
        }

        return [pscustomobject]@{
            Ok     = $false
            Url    = $Url
            Status = $status
            Data   = $null
            Error  = [pscustomobject]@{
                Raw = $parsedErr.Raw
                Json = $parsedErr.Json
            }
        }
    }
}

function Get-GraphPagedData {
    param(
        [Parameter(Mandatory = $true)][string]$InitialUrl,
        [Parameter(Mandatory = $true)][string]$AccessToken
    )

    $items = @()
    $errors = @()
    $nextUrl = $InitialUrl

    while ($nextUrl) {
        $call = Invoke-GraphJson -Url $nextUrl -AccessToken $AccessToken
        if (-not $call.Ok) {
            $errors += [pscustomobject]@{
                url = $call.Url
                status = $call.Status
                error = $call.Error
            }
            break
        }

        if ($call.Data -and $call.Data.data) {
            $items += @($call.Data.data)
        }

        if ($call.Data -and $call.Data.paging -and $call.Data.paging.next) {
            $nextUrl = [string]$call.Data.paging.next
        }
        else {
            $nextUrl = $null
        }
    }

    return [pscustomobject]@{
        Items  = $items
        Errors = $errors
    }
}

# Token input (no impresión)
if ([string]::IsNullOrWhiteSpace($Token)) {
    Write-Host "Ingresá tu SYSTEM USER permanent access token (no se mostrará):" -ForegroundColor Cyan
    $secure = Read-Host -AsSecureString
    $Token = Convert-SecureStringToPlain -Secure $secure
}

if ([string]::IsNullOrWhiteSpace($Token)) {
    Write-Error 'Token vacío. Abortando.'
    exit 1
}

$base = "https://graph.facebook.com/$GraphVersion"
$diagDir = Join-Path (Get-Location).Path 'diag'
Ensure-DiagDir -Path $diagDir

Write-Host "" 
Write-Host "=== WhatsApp Cloud API Diagnostics (Graph $GraphVersion) ===" -ForegroundColor Green
Write-Host "Generando archivos en: $diagDir" -ForegroundColor Gray

# 1) Businesses
$businessesUrl = "$base/me/businesses?fields=id,name"
$bizResult = Get-GraphPagedData -InitialUrl $businessesUrl -AccessToken $Token
$businesses = @($bizResult.Items)

# 2) WABAs owned + client por business
$wabas = @()
$wabaErrors = @()

foreach ($biz in $businesses) {
    if (-not $biz.id) { continue }

    $ownedUrl = "$base/$($biz.id)/owned_whatsapp_business_accounts?fields=id,name"
    $ownedResult = Get-GraphPagedData -InitialUrl $ownedUrl -AccessToken $Token
    foreach ($w in @($ownedResult.Items)) {
        $wabas += [pscustomobject]@{
            business_id = $biz.id
            business_name = $biz.name
            relation = 'owned'
            id = $w.id
            name = $w.name
        }
    }
    $wabaErrors += @($ownedResult.Errors)

    $clientUrl = "$base/$($biz.id)/client_whatsapp_business_accounts?fields=id,name"
    $clientResult = Get-GraphPagedData -InitialUrl $clientUrl -AccessToken $Token
    foreach ($w in @($clientResult.Items)) {
        $wabas += [pscustomobject]@{
            business_id = $biz.id
            business_name = $biz.name
            relation = 'client'
            id = $w.id
            name = $w.name
        }
    }
    $wabaErrors += @($clientResult.Errors)
}

$wabas = $wabas | Sort-Object id,business_id,relation -Unique

# 3) Phone numbers por WABA
$phoneNumbers = @()
$phoneErrors = @()

foreach ($w in $wabas) {
    if (-not $w.id) { continue }

    $phoneUrl = "$base/$($w.id)/phone_numbers?fields=id,display_phone_number,verified_name,code_verification_status,quality_rating"
    $phoneResult = Get-GraphPagedData -InitialUrl $phoneUrl -AccessToken $Token

    if ($phoneResult.Items.Count -gt 0) {
        foreach ($p in @($phoneResult.Items)) {
            $phoneNumbers += [pscustomobject]@{
                business_id = $w.business_id
                business_name = $w.business_name
                waba_id = $w.id
                waba_name = $w.name
                relation = $w.relation
                source_endpoint = 'phone_numbers'
                id = $p.id
                display_phone_number = $p.display_phone_number
                verified_name = $p.verified_name
                code_verification_status = $p.code_verification_status
                quality_rating = $p.quality_rating
            }
        }
        $phoneErrors += @($phoneResult.Errors)
        continue
    }

    $phoneErrors += @($phoneResult.Errors)

    $fallbackUrl = "$base/$($w.id)/owned_phone_numbers?fields=id,display_phone_number"
    $fallbackResult = Get-GraphPagedData -InitialUrl $fallbackUrl -AccessToken $Token
    foreach ($p in @($fallbackResult.Items)) {
        $phoneNumbers += [pscustomobject]@{
            business_id = $w.business_id
            business_name = $w.business_name
            waba_id = $w.id
            waba_name = $w.name
            relation = $w.relation
            source_endpoint = 'owned_phone_numbers'
            id = $p.id
            display_phone_number = $p.display_phone_number
            verified_name = $null
            code_verification_status = $null
            quality_rating = $null
        }
    }
    $phoneErrors += @($fallbackResult.Errors)
}

$phoneNumbers = $phoneNumbers | Sort-Object id,waba_id -Unique

# Guardar JSONs (sin token)
Write-JsonFile -Path (Join-Path $diagDir 'businesses.json') -Object @{
    generated_at = (Get-Date).ToString('s')
    graph_version = $GraphVersion
    count = $businesses.Count
    errors = $bizResult.Errors
    data = $businesses
}

Write-JsonFile -Path (Join-Path $diagDir 'wabas.json') -Object @{
    generated_at = (Get-Date).ToString('s')
    graph_version = $GraphVersion
    count = $wabas.Count
    errors = $wabaErrors
    data = $wabas
}

Write-JsonFile -Path (Join-Path $diagDir 'phone_numbers.json') -Object @{
    generated_at = (Get-Date).ToString('s')
    graph_version = $GraphVersion
    count = $phoneNumbers.Count
    errors = $phoneErrors
    data = $phoneNumbers
}

# 5) Resumen final
Write-Host ""
Write-Host "========== SUMMARY ==========" -ForegroundColor Green

Write-Host "Businesses (id + name):" -ForegroundColor Cyan
if ($businesses.Count -eq 0) {
    Write-Host "  (none)" -ForegroundColor Yellow
} else {
    foreach ($b in $businesses) {
        Write-Host ("  - {0} | {1}" -f $b.id, $b.name)
    }
}

Write-Host ""
Write-Host "WABAs (id + name):" -ForegroundColor Cyan
if ($wabas.Count -eq 0) {
    Write-Host "  (none)" -ForegroundColor Yellow
} else {
    foreach ($w in $wabas) {
        Write-Host ("  - {0} | {1} | relation={2} | business={3}" -f $w.id, $w.name, $w.relation, $w.business_id)
    }
}

Write-Host ""
Write-Host "Phone numbers (display_phone_number -> id):" -ForegroundColor Cyan
if ($phoneNumbers.Count -eq 0) {
    Write-Host "  (none)" -ForegroundColor Yellow
} else {
    foreach ($p in $phoneNumbers) {
        $display = if ($p.display_phone_number) { $p.display_phone_number } else { '(no display_phone_number)' }
        Write-Host ("  - {0} -> {1} | waba={2}" -f $display, $p.id, $p.waba_id)
    }
}

$recommended = $null
if ($phoneNumbers.Count -gt 0) {
    $recommended = ($phoneNumbers | Select-Object -First 1).id
}

Write-Host ""
if ($recommended) {
    Write-Host ("Set WHATSAPP_PHONE_NUMBER_ID={0}" -f $recommended) -ForegroundColor Green
    Write-Host ("WHATSAPP_PHONE_NUMBER_ID={0}" -f $recommended)
} else {
    Write-Host 'Set WHATSAPP_PHONE_NUMBER_ID=<not_found>' -ForegroundColor Red
    Write-Host 'WHATSAPP_PHONE_NUMBER_ID=<not_found>'
}

Write-Host ""
Write-Host "DONE" -ForegroundColor Green

# Limpieza token en memoria
$Token = $null
