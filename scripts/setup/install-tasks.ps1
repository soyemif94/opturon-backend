$ErrorActionPreference = 'Stop'

$taskNames = @(
  'Odontology API - Server',
  'Odontology API - Worker',
  'Odontology API - Tunnel'
)

function Get-SchtasksPath {
  $fromPath = Get-Command schtasks.exe -ErrorAction SilentlyContinue
  if ($fromPath -and $fromPath.Source) {
    return $fromPath.Source
  }

  $systemPath = Join-Path $env:WINDIR 'System32\schtasks.exe'
  if (Test-Path -LiteralPath $systemPath) {
    return $systemPath
  }

  throw 'schtasks.exe not found. Ensure Task Scheduler tools are available on this Windows host.'
}

function Test-IsAdmin {
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    return $false
  }
}

function Ensure-LogsDirectory {
  param([string]$RootPath)
  $logsDir = Join-Path $RootPath 'logs'
  if (-not (Test-Path -LiteralPath $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir | Out-Null
  }
}

function Remove-TaskIfExists {
  param([string]$TaskName)
  try {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
      return
    }
  } catch {
  }

  # Fallback for user-level tasks and environments with restricted ScheduledTask cmdlets.
  try {
    $schtasks = Get-SchtasksPath
    $null = & $schtasks /Delete /TN $TaskName /F 2>$null
  } catch {
    # Ignore delete fallback errors; task may not exist in current scope.
  }
}

function Register-OdontologyTaskUserFallback {
  param(
    [string]$TaskName,
    [string]$Role,
    [string]$RootPath
  )

  $scriptPath = Join-Path $RootPath 'scripts\setup\task-entrypoint.ps1'
  $taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command `$p='$scriptPath'; & `$p -Role $Role"
  $arguments = @(
    '/Create',
    '/F',
    '/SC', 'ONLOGON',
    '/TN', $TaskName,
    '/TR', $taskCommand
  )
  $schtasks = Get-SchtasksPath
  try {
    $null = & $schtasks @arguments
    if ($LASTEXITCODE -ne 0) {
      throw "schtasks failed for '$TaskName' with exit code $LASTEXITCODE"
    }
    return $true
  } catch {
    Write-Warning "schtasks fallback failed for '$TaskName'. Trying Register-ScheduledTask user-level fallback."
  }

  $currentUser = "$env:USERDOMAIN\$env:USERNAME"
  $cmdArguments = "/c powershell -NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Role $Role"
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmdArguments -WorkingDirectory $RootPath
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -RunLevel Limited -LogonType Interactive
  $task = New-ScheduledTask -Action $action -Trigger @($trigger) -Settings $settings -Principal $principal
  try {
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
    return $true
  } catch {
    Write-Warning "User-level fallback failed for '$TaskName': $($_.Exception.Message)"
    return $false
  }
}

function New-CompatiblePrincipal {
  param([string]$CurrentUser)
  # Some legacy LogonType enum values are not supported in many PowerShell versions.
  # Using Interactive with fallback ensures compatibility.
  try {
    return New-ScheduledTaskPrincipal -UserId $CurrentUser -RunLevel Highest -LogonType Interactive
  } catch {
    Write-Warning "Fallback: creating principal without explicit LogonType"
    return New-ScheduledTaskPrincipal -UserId $CurrentUser -RunLevel Highest
  }
}

function Register-OdontologyTask {
  param(
    [string]$TaskName,
    [string]$Role,
    [string]$RootPath
  )

  $currentUser = "$env:USERDOMAIN\$env:USERNAME"
  $scriptPath = Join-Path $RootPath 'scripts\setup\task-entrypoint.ps1'
  $arguments = "/c powershell -NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Role $Role"

  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $arguments -WorkingDirectory $RootPath
  $triggers = @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -AtLogOn)
  )
  $settings = New-ScheduledTaskSettingsSet `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

  $principal = New-CompatiblePrincipal -CurrentUser $currentUser
  $task = New-ScheduledTask -Action $action -Trigger $triggers -Settings $settings -Principal $principal
  Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
}

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$rootPath = $root.Path
Ensure-LogsDirectory -RootPath $rootPath

Remove-TaskIfExists -TaskName 'Odontology API - Server'
Remove-TaskIfExists -TaskName 'Odontology API - Worker'
Remove-TaskIfExists -TaskName 'Odontology API - Tunnel'

if (Test-IsAdmin) {
  Register-OdontologyTask -TaskName 'Odontology API - Server' -Role 'server' -RootPath $rootPath
  Register-OdontologyTask -TaskName 'Odontology API - Worker' -Role 'worker' -RootPath $rootPath
  Register-OdontologyTask -TaskName 'Odontology API - Tunnel' -Role 'tunnel' -RootPath $rootPath
} else {
  Write-Warning 'No admin: creating user-level tasks without Highest privileges'
  $userModeFailedTasks = @()
  if (-not (Register-OdontologyTaskUserFallback -TaskName 'Odontology API - Server' -Role 'server' -RootPath $rootPath)) {
    $userModeFailedTasks += 'Odontology API - Server'
  }
  if (-not (Register-OdontologyTaskUserFallback -TaskName 'Odontology API - Worker' -Role 'worker' -RootPath $rootPath)) {
    $userModeFailedTasks += 'Odontology API - Worker'
  }
  if (-not (Register-OdontologyTaskUserFallback -TaskName 'Odontology API - Tunnel' -Role 'tunnel' -RootPath $rootPath)) {
    $userModeFailedTasks += 'Odontology API - Tunnel'
  }
  if ($userModeFailedTasks.Count -gt 0) {
    Write-Warning "Some user-level tasks could not be created in current session: $($userModeFailedTasks -join ', ')"
    Write-Warning 'Try running npm run prod:install-tasks in an elevated PowerShell (Run as Administrator).'
  }
}

Write-Host 'Scheduled tasks installed/updated:'
$taskNames | ForEach-Object { Write-Host " - $_" }
Write-Host 'Logs directory:'
Write-Host " - $rootPath\logs"
Write-Host 'Note: admin mode creates AtStartup+AtLogOn tasks with Highest privileges.'
Write-Host 'Note: non-admin fallback creates user-level ONLOGON tasks via schtasks.exe.'
Write-Host 'Note: non-admin schtasks fallback does not set an explicit execution time limit.'
