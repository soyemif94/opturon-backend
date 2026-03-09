$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ICON_OK = [char]0x2705
$ICON_WARN = [char]0x26A0
$ICON_FAIL = [char]0x274C

function Write-Check {
  param(
    [string]$Status,
    [string]$Message
  )
  $tag = switch ($Status) {
    $ICON_OK { '[OK]' }
    $ICON_WARN { '[WARN]' }
    $ICON_FAIL { '[FAIL]' }
    default { '[INFO]' }
  }
  Write-Host ("{0} {1} {2}" -f $Status, $tag, $Message)
}

function Invoke-HealthCheck {
  param([string]$Url)
  try {
    $response = Invoke-WebRequest -Uri $Url -Method Get -UseBasicParsing -TimeoutSec 10
    $statusCode = [int]$response.StatusCode
    $content = [string]($response.Content)
    $bodyLooksOk = $true
    if ($content) {
      $bodyLooksOk = $content -match '(?i)ok|healthy'
    }
    return [PSCustomObject]@{
      Ok = ($statusCode -eq 200 -and $bodyLooksOk)
      StatusCode = $statusCode
      Content = $content
      Error = $null
    }
  } catch {
    return [PSCustomObject]@{
      Ok = $false
      StatusCode = $null
      Content = $null
      Error = $_.Exception.Message
    }
  }
}

function Get-TaskSnapshot {
  param([string]$TaskName)
  try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
    return [PSCustomObject]@{
      Exists = $true
      Enabled = [bool]$task.Settings.Enabled
      State = [string]$task.State
      LastTaskResult = $info.LastTaskResult
      LastRunTime = $info.LastRunTime
      NextRunTime = $info.NextRunTime
      Error = $null
    }
  } catch {
    return [PSCustomObject]@{
      Exists = $false
      Enabled = $false
      State = 'Unknown'
      LastTaskResult = $null
      LastRunTime = $null
      NextRunTime = $null
      Error = $_.Exception.Message
    }
  }
}

function Show-LogInfo {
  param(
    [string]$Path,
    [int]$Lines = 30
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    Write-Check $ICON_WARN ("Log not found: {0}" -f $Path)
    return
  }

  $item = Get-Item -LiteralPath $Path
  Write-Check $ICON_OK ("Log: {0}" -f $Path)
  Write-Host ("   Size: {0} bytes | LastWrite: {1}" -f $item.Length, $item.LastWriteTime)
  Write-Host ("   Last {0} lines:" -f $Lines)
  try {
    Get-Content -LiteralPath $Path -Tail $Lines | ForEach-Object { Write-Host ("   " + $_) }
  } catch {
    Write-Check $ICON_WARN ("Unable to read log tail: {0}" -f $_.Exception.Message)
  }
}

function Resolve-HostSafe {
  param([string]$HostName)
  if (-not $HostName) {
    return [PSCustomObject]@{ Resolved = $false; Detail = 'empty host' }
  }

  $resolveCmd = Get-Command Resolve-DnsName -ErrorAction SilentlyContinue
  if ($resolveCmd) {
    try {
      $records = Resolve-DnsName -Name $HostName -ErrorAction Stop
      $ips = $records | Where-Object { $_.IPAddress } | Select-Object -ExpandProperty IPAddress
      return [PSCustomObject]@{
        Resolved = $true
        Detail = (($ips -join ', ') -replace '^\s+$','')
      }
    } catch {
      return [PSCustomObject]@{ Resolved = $false; Detail = $_.Exception.Message }
    }
  }

  try {
    $ns = nslookup $HostName 2>&1
    $text = ($ns | Out-String)
    if ($text -match '(?i)address:\s*([0-9a-f\.:]+)') {
      return [PSCustomObject]@{ Resolved = $true; Detail = $Matches[1] }
    }
    return [PSCustomObject]@{ Resolved = $false; Detail = $text.Trim() }
  } catch {
    return [PSCustomObject]@{ Resolved = $false; Detail = $_.Exception.Message }
  }
}

$criticalFailed = $false
$timestamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$rootPath = $root.Path
$logsDir = Join-Path $rootPath 'logs'
$publicHost = if ($env:PROD_PUBLIC_HOST) { [string]$env:PROD_PUBLIC_HOST } else { 'api.opturon.com' }

Write-Host "=== Production Verify ==="
Write-Host ("Timestamp: {0}" -f $timestamp)
Write-Host ("Root: {0}" -f $rootPath)
Write-Host ""

Write-Host "[1] Health local (CRITICAL)"
$health = Invoke-HealthCheck -Url 'http://localhost:3001/health'
if ($health.Ok) {
  Write-Check $ICON_OK ("Health OK (status={0})" -f $health.StatusCode)
} else {
  Write-Check $ICON_FAIL ("Health FAIL (status={0}) {1}" -f $health.StatusCode, $health.Error)
  $criticalFailed = $true
}
Write-Host ""

Write-Host "[2] Task Scheduler (CRITICAL)"
$tasks = @(
  'Odontology API - Server',
  'Odontology API - Worker',
  'Odontology API - Tunnel'
)
$taskStates = @{}
foreach ($taskName in $tasks) {
  $t = Get-TaskSnapshot -TaskName $taskName
  $taskStates[$taskName] = $t
  if (-not $t.Exists) {
    Write-Check $ICON_FAIL ("Task missing: {0}" -f $taskName)
    $criticalFailed = $true
    continue
  }
  if (-not $t.Enabled) {
    Write-Check $ICON_FAIL ("Task disabled: {0}" -f $taskName)
    $criticalFailed = $true
  } elseif ($t.State -eq 'Running') {
    Write-Check $ICON_OK ("{0} | State={1} LastTaskResult={2}" -f $taskName, $t.State, $t.LastTaskResult)
  } else {
    Write-Check $ICON_WARN ("{0} | State={1} LastTaskResult={2}" -f $taskName, $t.State, $t.LastTaskResult)
  }
  Write-Host ("   LastRun={0} | NextRun={1}" -f $t.LastRunTime, $t.NextRunTime)
}
Write-Host ""

Write-Host "[3] Logs (NON-CRITICAL)"
if (-not (Test-Path -LiteralPath $logsDir)) {
  Write-Check $ICON_WARN ("Logs directory not found: {0}" -f $logsDir)
} else {
  Show-LogInfo -Path (Join-Path $logsDir 'server.log') -Lines 30
  Show-LogInfo -Path (Join-Path $logsDir 'worker.log') -Lines 30
  Show-LogInfo -Path (Join-Path $logsDir 'tunnel.log') -Lines 30
}
Write-Host ""

Write-Host "[4] DNS public (NON-CRITICAL)"
$dns = Resolve-HostSafe -HostName $publicHost
if ($dns.Resolved) {
  Write-Check $ICON_OK ("{0} resolves: {1}" -f $publicHost, $dns.Detail)
} else {
  Write-Check $ICON_WARN ("{0} not resolved: {1}" -f $publicHost, $dns.Detail)
}
Write-Host ""

Write-Host "[5] cloudflared process (NON-CRITICAL)"
try {
  $processes = Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue
  $tunnelTaskRunning = $false
  if ($taskStates.ContainsKey('Odontology API - Tunnel')) {
    $tunnelTaskRunning = ($taskStates['Odontology API - Tunnel'].State -eq 'Running')
  }

  if ($processes) {
    $ids = ($processes | Select-Object -ExpandProperty Id) -join ', '
    Write-Check $ICON_OK ("cloudflared running (PID: {0})" -f $ids)
  } elseif ($tunnelTaskRunning) {
    Write-Check $ICON_OK 'Tunnel task is Running (process visibility may be restricted by permissions)'
  } else {
    Write-Check $ICON_WARN 'cloudflared process not found'
  }
} catch {
  Write-Check $ICON_WARN ("Unable to inspect cloudflared: {0}" -f $_.Exception.Message)
}
Write-Host ""

if ($criticalFailed) {
  Write-Host 'RESULT: FAIL'
  exit 1
}

Write-Host 'RESULT: OK'
exit 0

