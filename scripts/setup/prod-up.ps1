$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$rootPath = $root.Path

Write-Host "Starting production processes from: $rootPath"

$serverCmd = "Set-Location -LiteralPath '$rootPath'; npm run start:prod"
$workerCmd = "Set-Location -LiteralPath '$rootPath'; npm run worker:prod"

Start-Process -FilePath "powershell" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $serverCmd) | Out-Null
Start-Process -FilePath "powershell" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $workerCmd) | Out-Null

Write-Host "Launched start:prod and worker:prod in separate PowerShell windows."
