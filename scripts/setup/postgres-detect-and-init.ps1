$ErrorActionPreference = 'Stop'

$script:CheckedLocations = New-Object System.Collections.Generic.List[string]

function Add-CheckedLocation {
  param([string]$Location)
  if ($Location) {
    [void]$script:CheckedLocations.Add($Location)
  }
}

function Get-ParsedVersion {
  param([string]$PathValue)

  if (-not $PathValue) {
    return [version]'0.0'
  }

  $patterns = @(
    'PostgreSQL\\(?<ver>\d+(?:\.\d+)*)\\bin\\psql\.exe$',
    'PostgreSQL(?<ver>\d+(?:\.\d+)*)\\bin\\psql\.exe$'
  )

  foreach ($pattern in $patterns) {
    $match = [regex]::Match($PathValue, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($match.Success) {
      try {
        return [version]$match.Groups['ver'].Value
      } catch {
        return [version]'0.0'
      }
    }
  }

  return [version]'0.0'
}

function Add-Candidate {
  param(
    [System.Collections.Generic.List[object]]$Candidates,
    [string]$PathValue,
    [string]$Source
  )

  if (-not $PathValue) {
    return
  }

  if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) {
    return
  }

  $resolved = (Resolve-Path -LiteralPath $PathValue).Path
  if ($Candidates | Where-Object { $_.Path -eq $resolved }) {
    return
  }

  $version = Get-ParsedVersion -PathValue $resolved
  $Candidates.Add([pscustomobject]@{
      Path = $resolved
      Source = $Source
      Version = $version
    }) | Out-Null
}

function Get-CandidatesFromGlobs {
  param([System.Collections.Generic.List[object]]$Candidates)

  $patterns = @(
    'C:\Program Files\PostgreSQL*\bin\psql.exe',
    'C:\Program Files (x86)\PostgreSQL*\bin\psql.exe',
    'C:\PostgreSQL*\bin\psql.exe',
    'C:\tools\PostgreSQL*\bin\psql.exe'
  )

  foreach ($pattern in $patterns) {
    Add-CheckedLocation "glob:$pattern"
    $matches = Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue
    foreach ($item in $matches) {
      Add-Candidate -Candidates $Candidates -PathValue $item.FullName -Source "glob:$pattern"
    }
  }
}

function Get-CandidatesFromRegistry {
  param([System.Collections.Generic.List[object]]$Candidates)

  $registryRoots = @(
    'HKLM:\SOFTWARE\PostgreSQL\Installations',
    'HKLM:\SOFTWARE\WOW6432Node\PostgreSQL\Installations'
  )

  foreach ($root in $registryRoots) {
    Add-CheckedLocation "registry:$root"

    if (-not (Test-Path -LiteralPath $root)) {
      continue
    }

    $installations = Get-ChildItem -Path $root -ErrorAction SilentlyContinue
    foreach ($installation in $installations) {
      try {
        $props = Get-ItemProperty -Path $installation.PSPath -ErrorAction Stop
      } catch {
        continue
      }

      $baseDirectory = $null
      if ($props.PSObject.Properties.Name -contains 'Base Directory') {
        $baseDirectory = $props.'Base Directory'
      }
      if (-not $baseDirectory -and ($props.PSObject.Properties.Name -contains 'BaseDirectory')) {
        $baseDirectory = $props.BaseDirectory
      }

      if (-not $baseDirectory) {
        continue
      }

      $candidatePath = Join-Path -Path $baseDirectory -ChildPath 'bin\psql.exe'
      Add-Candidate -Candidates $Candidates -PathValue $candidatePath -Source "registry:$($installation.PSChildName)"
    }
  }
}

function Get-CandidatesFromPath {
  param([System.Collections.Generic.List[object]]$Candidates)

  Add-CheckedLocation 'path:Get-Command psql.exe'
  $command = Get-Command psql.exe -ErrorAction SilentlyContinue
  if ($command -and $command.Source) {
    Add-Candidate -Candidates $Candidates -PathValue $command.Source -Source 'path'
  }
}

function Get-CandidatesFromFallbackSearch {
  param([System.Collections.Generic.List[object]]$Candidates)

  $roots = @(
    'C:\Program Files\',
    'C:\Program Files (x86)\',
    'D:\'
  )

  foreach ($root in $roots) {
    Add-CheckedLocation "fallback:$root"

    if (-not (Test-Path -LiteralPath $root)) {
      continue
    }

    $hits = Get-ChildItem -Path $root -Filter 'psql.exe' -File -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match 'PostgreSQL' -and $_.FullName -match '\\bin\\psql\.exe$' } |
      Select-Object -First 50

    foreach ($hit in $hits) {
      Add-Candidate -Candidates $Candidates -PathValue $hit.FullName -Source "fallback:$root"
    }
  }
}

function Find-PsqlPath {
  $candidates = New-Object System.Collections.Generic.List[object]

  Get-CandidatesFromGlobs -Candidates $candidates
  Get-CandidatesFromRegistry -Candidates $candidates
  Get-CandidatesFromPath -Candidates $candidates

  if ($candidates.Count -eq 0) {
    Get-CandidatesFromFallbackSearch -Candidates $candidates
  }

  if ($candidates.Count -eq 0) {
    $checked = ($script:CheckedLocations | Select-Object -Unique) -join '; '
    throw "No se encontró psql.exe. Revisado: $checked. Reinstalá PostgreSQL habilitando 'Command Line Tools' en el installer (Installation Directory -> Components -> Command Line Tools)."
  }

  $selected = $candidates |
    Sort-Object -Property @{ Expression = { $_.Version }; Descending = $true },
                          @{ Expression = { $_.Path }; Descending = $true } |
    Select-Object -First 1

  return $selected.Path
}

function Invoke-Psql {
  param(
    [string]$PsqlPath,
    [string]$Database,
    [string]$Sql
  )

  $arguments = @('-U', 'postgres', '-h', 'localhost', '-p', '5434', '-d', $Database, '-c', $Sql)
  $output = & "$PsqlPath" @arguments 2>&1
  $exitCode = $LASTEXITCODE

  return [pscustomobject]@{
    ExitCode = $exitCode
    Output = ($output -join "`n")
  }
}

function Get-DbExists {
  param([string]$PsqlPath)

  $result = Invoke-Psql -PsqlPath $PsqlPath -Database 'postgres' -Sql "SELECT 1 FROM pg_database WHERE datname='clinicai';"
  if ($result.ExitCode -ne 0) {
    throw "Error verificando existencia de DB clinicai: $($result.Output)"
  }

  return ($result.Output -match '\b1\b')
}

try {
  $psqlPath = Find-PsqlPath
  Write-Output "FOUND_PSQL: $psqlPath"

  $versionCheck = Invoke-Psql -PsqlPath $psqlPath -Database 'postgres' -Sql 'SELECT version();'
  if ($versionCheck.ExitCode -ne 0) {
    throw "No se pudo conectar a PostgreSQL en localhost:5434: $($versionCheck.Output)"
  }
  Write-Output 'CONNECTED_OK'

  $alreadyExists = Get-DbExists -PsqlPath $psqlPath
  if ($alreadyExists) {
    Write-Output 'DB_ALREADY_EXISTS'
  } else {
    $createDb = Invoke-Psql -PsqlPath $psqlPath -Database 'postgres' -Sql 'CREATE DATABASE clinicai;'
    if ($createDb.ExitCode -ne 0) {
      throw "No se pudo crear database clinicai: $($createDb.Output)"
    }
    Write-Output 'DB_CREATED'
  }

  $verifyDb = Invoke-Psql -PsqlPath $psqlPath -Database 'clinicai' -Sql 'SELECT current_database();'
  if ($verifyDb.ExitCode -ne 0) {
    throw "No se pudo verificar database clinicai: $($verifyDb.Output)"
  }

  Write-Output 'DB_VERIFIED'
  Write-Output 'DB_READY'
  Write-Output 'DONE'
} catch {
  $checked = ($script:CheckedLocations | Select-Object -Unique) -join '; '
  Write-Error "ERROR: $($_.Exception.ToString())"
  if ($checked) {
    Write-Error "CHECKED_LOCATIONS: $checked"
  }
  exit 1
}
