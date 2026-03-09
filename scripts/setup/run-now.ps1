$ErrorActionPreference = 'Stop'

$taskNames = @(
  'Odontology API - Server',
  'Odontology API - Worker',
  'Odontology API - Tunnel'
)

foreach ($taskName in $taskNames) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    Write-Warning "Task not found: $taskName"
    continue
  }
  Start-ScheduledTask -TaskName $taskName
  Write-Host "Started task: $taskName"
}

Start-Sleep -Seconds 2

Write-Host 'Current state:'
foreach ($taskName in $taskNames) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    continue
  }
  $info = Get-ScheduledTaskInfo -TaskName $taskName
  Write-Host (" - {0}: State={1}, LastRunTime={2}, LastTaskResult={3}" -f $taskName, $task.State, $info.LastRunTime, $info.LastTaskResult)
}
