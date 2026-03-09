param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('server', 'worker', 'tunnel')]
  [string]$Role
)

# Smoke test: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup\task-entrypoint.ps1 -Role server

$ErrorActionPreference = 'Stop'

function Rotate-LogIfNeeded {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LogPath,
    [int64]$MaxBytes = 10485760
  )

  if (Test-Path -LiteralPath $LogPath) {
    try {
      $file = Get-Item -LiteralPath $LogPath
      if ($file.Length -gt $MaxBytes) {
        $rotated = "$LogPath.1"
        if (Test-Path -LiteralPath $rotated) {
          Remove-Item -LiteralPath $rotated -Force -ErrorAction SilentlyContinue
        }
        Move-Item -LiteralPath $LogPath -Destination $rotated -Force
      }
    } catch {
      # Ignore rotation failures when another process currently owns the log file handle.
    }
  }
}

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$rootPath = $root.Path
$logsDir = Join-Path $rootPath 'logs'
if (-not (Test-Path -LiteralPath $logsDir)) {
  New-Item -ItemType Directory -Path $logsDir | Out-Null
}

$logFile = if ($Role -eq 'server') {
  'server.log'
} elseif ($Role -eq 'worker') {
  'worker.log'
} else {
  'tunnel.log'
}
$logPath = Join-Path $logsDir $logFile
Rotate-LogIfNeeded -LogPath $logPath

function Write-LogLine {
  param([Parameter(Mandatory = $true)][string]$Message)
  try {
    [System.IO.File]::AppendAllText($logPath, "$Message`r`n", [System.Text.Encoding]::UTF8)
  } catch {
    # Best effort: avoid failing entrypoint if log file is locked by another running instance.
  }
}

function Try-GetVersion {
  param([string]$Command, [string]$Argument)
  try {
    $value = & $Command $Argument 2>$null
    if ($LASTEXITCODE -eq 0 -and $value) {
      return (String($value)).Trim()
    }
  } catch {
  }
  return 'unknown'
}

function Test-PortInUse {
  param([int]$Port)

  $hasGetNetTcp = Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue
  if ($hasGetNetTcp) {
    try {
      $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
      if ($listeners) {
        return $true
      }
    } catch {
    }
  }

  try {
    $lines = netstat -ano 2>$null
    if ($lines) {
      $matches = $lines | Where-Object { $_ -match "[:\.]$Port\s" -and $_ -match '(?i)LISTENING|ESCUCHANDO' }
      return ($matches.Count -gt 0)
    }
  } catch {
  }

  return $false
}

function Find-ProcessByCommandLine {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Needles,
    [string]$ProcessName = ''
  )

  $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
  if (-not $processes) {
    return @()
  }

  $filtered = $processes | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.CommandLine -and
    ($ProcessName -eq '' -or $_.Name -ieq $ProcessName)
  }

  foreach ($needle in $Needles) {
    $filtered = $filtered | Where-Object { $_.CommandLine -like "*$needle*" }
  }

  return @($filtered)
}

$timestamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
$cwd = $rootPath
$nodeVersion = Try-GetVersion -Command 'node' -Argument '--version'
$npmVersion = Try-GetVersion -Command 'npm' -Argument '--version'
$cloudflaredVersion = Try-GetVersion -Command 'cloudflared' -Argument '--version'
$tunnelName = if ($env:CLOUDFLARED_TUNNEL_NAME) { [string]$env:CLOUDFLARED_TUNNEL_NAME } else { 'clinicai-api' }
$nodeEnv = if ($env:NODE_ENV) { [string]$env:NODE_ENV } else { 'unknown' }
$port = if ($env:PORT) { [string]$env:PORT } else { '3001' }

Write-LogLine -Message '-----'
Write-LogLine -Message "[$timestamp] task_entrypoint_start role=$Role cwd=$cwd node=$nodeVersion npm=$npmVersion cloudflared=$cloudflaredVersion tunnelName=$tunnelName NODE_ENV=$nodeEnv PORT=$port"

Push-Location $rootPath
try {
  if ($Role -eq 'server') {
    $serverPort = 3001
    if ($port -match '^\d+$') {
      $serverPort = [int]$port
    }
    if (Test-PortInUse -Port $serverPort) {
      Write-LogLine -Message "[$timestamp] Guard: port $serverPort already in use, assuming server already running; exiting 0"
      exit 0
    }
    $commandLine = "npm run start:prod >> `"$logPath`" 2>&1"
  } elseif ($Role -eq 'worker') {
    $existingWorkers = Find-ProcessByCommandLine -Needles @('src\worker.js')
    if (-not $existingWorkers -or $existingWorkers.Count -eq 0) {
      $existingWorkers = Find-ProcessByCommandLine -Needles @('src/worker.js')
    }
    if ($existingWorkers -and $existingWorkers.Count -gt 0) {
      $workerPids = ($existingWorkers | Select-Object -ExpandProperty ProcessId) -join ','
      Write-LogLine -Message "[$timestamp] Guard: worker process already running (pid=$workerPids); exiting 0"
      exit 0
    }
    $commandLine = "npm run worker:prod >> `"$logPath`" 2>&1"
  } else {
    $existingTunnels = Find-ProcessByCommandLine -Needles @('tunnel run', $tunnelName) -ProcessName 'cloudflared.exe'
    if (-not $existingTunnels -or $existingTunnels.Count -eq 0) {
      $existingTunnels = Find-ProcessByCommandLine -Needles @('tunnel run', $tunnelName) -ProcessName 'cloudflared'
    }
    if ($existingTunnels -and $existingTunnels.Count -gt 0) {
      $tunnelPids = ($existingTunnels | Select-Object -ExpandProperty ProcessId) -join ','
      Write-LogLine -Message "[$timestamp] Guard: cloudflared tunnel '$tunnelName' already running (pid=$tunnelPids); exiting 0"
      exit 0
    }

    $cloudflaredCommand = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($null -eq $cloudflaredCommand) {
      Write-LogLine -Message "[$timestamp] ERROR cloudflared_not_found. Install cloudflared or add it to PATH."
      exit 2
    }

    Write-LogLine -Message "[$timestamp] starting cloudflared tunnel run $tunnelName"

    try {
      $commandLine = "cloudflared tunnel run $tunnelName >> `"$logPath`" 2>&1"
      $tunnelRunner = Start-Process `
        -FilePath 'cmd.exe' `
        -ArgumentList @('/c', $commandLine) `
        -WorkingDirectory $rootPath `
        -WindowStyle Hidden `
        -PassThru

      Start-Sleep -Milliseconds 400
      $startedTunnelProcesses = Find-ProcessByCommandLine -Needles @('tunnel run', $tunnelName) -ProcessName 'cloudflared.exe'
      if (-not $startedTunnelProcesses -or $startedTunnelProcesses.Count -eq 0) {
        $startedTunnelProcesses = Find-ProcessByCommandLine -Needles @('tunnel run', $tunnelName) -ProcessName 'cloudflared'
      }
      $startedTunnelPid = if ($startedTunnelProcesses -and $startedTunnelProcesses.Count -gt 0) {
        ($startedTunnelProcesses | Select-Object -ExpandProperty ProcessId | Sort-Object -Descending | Select-Object -First 1)
      } else {
        'unknown'
      }

      Write-LogLine -Message "[$timestamp] cloudflared process started pid=$startedTunnelPid runnerPid=$($tunnelRunner.Id)"
      $tunnelRunner.WaitForExit()
      $exitCode = $tunnelRunner.ExitCode
      $endTimestamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
      $reason = if ($exitCode -eq 0) { 'normal_exit' } else { 'non_zero_exit_or_terminated' }
      Write-LogLine -Message "[$endTimestamp] cloudflared runner ended runnerPid=$($tunnelRunner.Id) exitCode=$exitCode reason=$reason"
      exit $exitCode
    } catch {
      $endTimestamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
      Write-LogLine -Message "[$endTimestamp] ERROR cloudflared_start_failed message=$($_.Exception.Message)"
      exit 1
    }
  }
  cmd.exe /c $commandLine
} finally {
  Pop-Location
}
