$ErrorActionPreference = 'Stop'

function Get-ParsedVersion {
  param([string]$PathValue)

  $match = [regex]::Match($PathValue, 'PostgreSQL\\(?<ver>\d+(?:\.\d+)*)\\bin\\psql\.exe$', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if ($match.Success) {
    try {
      return [version]$match.Groups['ver'].Value
    } catch {
      return [version]'0.0'
    }
  }

  return [version]'0.0'
}

function Find-PsqlPath {
  $patterns = @(
    'C:\Program Files\PostgreSQL\*\bin\psql.exe',
    'C:\Program Files (x86)\PostgreSQL\*\bin\psql.exe'
  )

  $candidates = foreach ($pattern in $patterns) {
    Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue
  }

  if (-not $candidates -or $candidates.Count -eq 0) {
    throw 'No se encontró psql.exe en rutas comunes de PostgreSQL para Windows.'
  }

  $selected = $candidates |
    Sort-Object -Property @{ Expression = { Get-ParsedVersion -PathValue $_.FullName }; Descending = $true },
                          @{ Expression = { $_.FullName }; Descending = $true } |
    Select-Object -First 1

  return $selected.FullName
}

function Get-DatabaseNameFromEnv {
  param([string]$EnvPath)

  if (-not (Test-Path -LiteralPath $EnvPath)) {
    throw ".env no encontrado en: $EnvPath"
  }

  $line = Get-Content -LiteralPath $EnvPath | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1
  if (-not $line) {
    throw 'DATABASE_URL no está definido en .env'
  }

  $databaseUrl = ($line -replace '^\s*DATABASE_URL\s*=\s*', '').Trim().Trim('"').Trim("'")
  if (-not $databaseUrl) {
    throw 'DATABASE_URL está vacío en .env'
  }

  $cleanUrl = $databaseUrl
  $atIndex = $cleanUrl.LastIndexOf('@')
  if ($atIndex -ge 0) {
    $schemeSep = $cleanUrl.IndexOf('://')
    if ($schemeSep -ge 0 -and $atIndex -gt ($schemeSep + 2)) {
      $cleanUrl = $cleanUrl.Substring(0, $schemeSep + 3) + $cleanUrl.Substring($atIndex + 1)
    }
  }

  try {
    $uri = [System.Uri]$cleanUrl
  } catch {
    throw "DATABASE_URL inválido en .env: $databaseUrl"
  }

  $dbName = $uri.AbsolutePath.Trim('/')
  if (-not $dbName) {
    throw 'No se pudo extraer nombre de base de datos desde DATABASE_URL'
  }

  if ($dbName.Contains('?')) {
    $dbName = $dbName.Split('?')[0]
  }

  return [System.Uri]::UnescapeDataString($dbName)
}

function Invoke-Psql {
  param(
    [string]$PsqlPath,
    [string]$Database,
    [string]$Sql
  )

  $argsList = @('-U', 'postgres', '-h', 'localhost', '-p', '5434', '-d', $Database, '-c', $Sql)
  $output = & "$PsqlPath" @argsList 2>&1
  $exitCode = $LASTEXITCODE

  return [pscustomobject]@{
    ExitCode = $exitCode
    Output = ($output -join "`n")
  }
}

function Escape-PgIdentifier {
  param([string]$Identifier)
  return '"' + $Identifier.Replace('"', '""') + '"'
}

try {
  $repoRoot = (Get-Location).Path
  $envPath = Join-Path -Path $repoRoot -ChildPath '.env'

  $psqlPath = Find-PsqlPath
  Write-Host "FOUND_PSQL: $psqlPath"

  $dbName = Get-DatabaseNameFromEnv -EnvPath $envPath
  Write-Host "TARGET_DB: $dbName"

  $connect = Invoke-Psql -PsqlPath $psqlPath -Database 'postgres' -Sql 'SELECT 1;'
  if ($connect.ExitCode -ne 0) {
    throw "Error conectando a postgres en localhost:5434: $($connect.Output)"
  }
  Write-Host 'CONNECTED_OK'

  $existsQuery = "SELECT 1 FROM pg_database WHERE datname = '$($dbName.Replace("'", "''"))';"
  $exists = Invoke-Psql -PsqlPath $psqlPath -Database 'postgres' -Sql $existsQuery
  if ($exists.ExitCode -ne 0) {
    throw "Error verificando existencia de DB '$dbName': $($exists.Output)"
  }

  if ($exists.Output -match '\b1\b') {
    Write-Host "DB_ALREADY_EXISTS: $dbName"
  } else {
    $escapedDbName = Escape-PgIdentifier -Identifier $dbName
    $create = Invoke-Psql -PsqlPath $psqlPath -Database 'postgres' -Sql "CREATE DATABASE $escapedDbName;"
    if ($create.ExitCode -ne 0) {
      throw "Error creando DB '$dbName': $($create.Output)"
    }
    Write-Host "DB_CREATED: $dbName"
  }

  $verify = Invoke-Psql -PsqlPath $psqlPath -Database $dbName -Sql 'SELECT current_database();'
  if ($verify.ExitCode -ne 0) {
    throw "Error verificando DB '$dbName': $($verify.Output)"
  }

  Write-Host "DB_VERIFIED: $dbName"
  exit 0
} catch {
  Write-Error "ERROR: $($_.Exception.ToString())"
  exit 1
}
