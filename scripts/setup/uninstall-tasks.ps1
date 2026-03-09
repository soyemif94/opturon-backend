$ErrorActionPreference = 'Stop'

$taskNames = @(
  'Odontology API - Server',
  'Odontology API - Worker',
  'Odontology API - Tunnel'
)

foreach ($taskName in $taskNames) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -ne $existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed task: $taskName"
  } else {
    Write-Host "Task not found: $taskName"
  }
}
