# D4.1 Suppliers Master 070 Runbook

## Scope

- PostgreSQL server version expected: `18.x`
- Backend base expected: `2d5c5f13077057ca1e8f995bb58a06546e38a8bf`
- Frontend base expected: `abe6cba0534d43ac7e243cf29c7a738fe8f8cd75`
- Migration file: `db/migrations/070_suppliers_master_phase1.sql`
- This runbook does **not** execute the global migrator.
- This runbook does **not** apply `061_whatsapp_chat_imports_phase1.sql`.

## Why The Previous Runbook Was Wrong

Running:

```powershell
psql -c "BEGIN;"
psql -f migration.sql
psql -c "INSERT INTO schema_migrations ..."
psql -c "COMMIT;"
```

is incorrect because each `psql` call opens a different session. That means:

- `BEGIN` and `COMMIT` do not wrap the migration file or tracking insert.
- the migration can succeed while tracking fails, or vice versa.
- there is no real single transaction around DDL + tracking + validation.

The corrected flow below uses **one `psql` session** and **one transaction**.

## Tooling Check

Run this first from a Windows PowerShell terminal that has PostgreSQL 18 client tools installed:

```powershell
$ErrorActionPreference = "Stop"

Get-Command pg_dump
Get-Command pg_restore
Get-Command psql
Get-Command createdb
Get-Command dropdb

pg_dump --version
pg_restore --version
psql --version
```

Approval criteria:

- `pg_dump`, `pg_restore`, `psql`, `createdb`, and `dropdb` resolve correctly.
- prefer PostgreSQL `18.x` client tools.
- do not continue if the backup toolchain is older than the production server in a way that raises compatibility risk.

## Backup Script

Use placeholders only:

- `<DATABASE_URL>`
- `<BACKUP_DIR>`

```powershell
$ErrorActionPreference = "Stop"

$DatabaseUrl = "<DATABASE_URL>"
$BackupDir = "<BACKUP_DIR>"
$UtcStamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$BackupPath = Join-Path $BackupDir "opturon-production-pre-d4-1-$UtcStamp.dump"
$ListPath = "$BackupPath.list.txt"

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

pg_dump `
  --format=custom `
  --no-owner `
  --no-privileges `
  --dbname="$DatabaseUrl" `
  --file="$BackupPath"

if ($LASTEXITCODE -ne 0) {
  throw "pg_dump_failed_exit_$LASTEXITCODE"
}

$BackupFile = Get-Item -LiteralPath $BackupPath

if ($BackupFile.Length -le 0) {
  throw "backup_file_empty"
}

$Hash = Get-FileHash -LiteralPath $BackupPath -Algorithm SHA256

pg_restore --list "$BackupPath" |
  Set-Content -LiteralPath $ListPath -Encoding UTF8

if ($LASTEXITCODE -ne 0) {
  throw "pg_restore_list_failed_exit_$LASTEXITCODE"
}

$ListFile = Get-Item -LiteralPath $ListPath

[PSCustomObject]@{
  BackupPath = $BackupFile.FullName
  SizeBytes = $BackupFile.Length
  SizeMB = [Math]::Round($BackupFile.Length / 1MB, 2)
  SHA256 = $Hash.Hash
  ListPath = $ListFile.FullName
  CreatedUtc = (Get-Date).ToUniversalTime().ToString("o")
}
```

## Isolated Restore Verification

Use placeholders:

- `<LOCAL_ADMIN_DATABASE_URL>`
- `<BACKUP_PATH>`

Important:

- never restore over production.
- if there is no local PostgreSQL instance available for isolated restore, stop here and keep the status blocked.

```powershell
$ErrorActionPreference = "Stop"

$LocalAdminUrl = "<LOCAL_ADMIN_DATABASE_URL>"
$BackupPath = "<BACKUP_PATH>"
$ScratchDb = "opturon_restore_check_" + (Get-Date).ToUniversalTime().ToString("yyyyMMdd_HHmmss")

createdb --maintenance-db="$LocalAdminUrl" "$ScratchDb"

if ($LASTEXITCODE -ne 0) {
  throw "createdb_failed_exit_$LASTEXITCODE"
}

$ScratchDatabaseUrl = "<BUILD_SCRATCH_DATABASE_URL_FOR_$ScratchDb>"

try {
  pg_restore `
    --no-owner `
    --no-privileges `
    --exit-on-error `
    --dbname="$ScratchDatabaseUrl" `
    "$BackupPath"

  if ($LASTEXITCODE -ne 0) {
    throw "pg_restore_failed_exit_$LASTEXITCODE"
  }

  psql --dbname="$ScratchDatabaseUrl" -v ON_ERROR_STOP=1 -c "SELECT COUNT(*) AS products FROM products;"
  psql --dbname="$ScratchDatabaseUrl" -v ON_ERROR_STOP=1 -c "SELECT COUNT(*) AS migrations FROM schema_migrations;"
  psql --dbname="$ScratchDatabaseUrl" -v ON_ERROR_STOP=1 -c "SELECT COUNT(*) AS inventory_lots FROM inventory_lots;"
}
finally {
  dropdb --maintenance-db="$LocalAdminUrl" --if-exists "$ScratchDb"
}
```

## Preflight SQL

From the backend repo root:

```powershell
$DatabaseUrl = "<DATABASE_URL>"

psql `
  --dbname="$DatabaseUrl" `
  -v ON_ERROR_STOP=1 `
  -f ".\\preflight-070.sql"
```

## One-Session Transactional Apply Script

Do **not** version this file. Generate it locally outside the repo, for example:

- `%USERPROFILE%\Desktop\apply-070-suppliers.sql`
- `%TEMP%\apply-070-suppliers.sql`

Suggested content:

```sql
\set ON_ERROR_STOP on

BEGIN;

\i 'db/migrations/070_suppliers_master_phase1.sql'

INSERT INTO schema_migrations(name)
SELECT '070_suppliers_master_phase1.sql'
WHERE NOT EXISTS (
  SELECT 1
  FROM schema_migrations
  WHERE name = '070_suppliers_master_phase1.sql'
);

DO $$
BEGIN
  IF to_regclass('public.suppliers') IS NULL THEN
    RAISE EXCEPTION 'suppliers_table_missing_after_070';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'products'
      AND column_name = 'defaultSupplierId'
  ) THEN
    RAISE EXCEPTION 'products_defaultSupplierId_missing_after_070';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM schema_migrations
    WHERE name = '070_suppliers_master_phase1.sql'
  ) THEN
    RAISE EXCEPTION 'migration_070_tracking_missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM schema_migrations
    WHERE name = '061_whatsapp_chat_imports_phase1.sql'
  ) THEN
    RAISE EXCEPTION 'migration_061_was_applied_unexpectedly';
  END IF;
END
$$;

COMMIT;
```

Execute it with a **single** `psql` invocation from the backend repo root:

```powershell
$DatabaseUrl = "<DATABASE_URL>"
$ApplyScriptPath = "<PATH_TO_APPLY_070_SUPPLIERS_SQL>"

psql `
  --dbname="$DatabaseUrl" `
  -v ON_ERROR_STOP=1 `
  -f "$ApplyScriptPath"
```

## Postflight SQL

From the backend repo root:

```powershell
$DatabaseUrl = "<DATABASE_URL>"

psql `
  --dbname="$DatabaseUrl" `
  -v ON_ERROR_STOP=1 `
  -f ".\\postflight-070.sql"
```

## Transaction Decision

- `070_suppliers_master_phase1.sql` does **not** contain top-level `BEGIN`, `COMMIT`, or `ROLLBACK`.
- The `BEGIN` tokens inside `070` belong only to `DO $$ BEGIN ... END $$` blocks.
- Therefore the correct design is:
  - migration file without top-level transaction wrapper;
  - one external `psql` session;
  - one explicit outer `BEGIN/COMMIT`;
  - tracking insert inside the same transaction.

## Tracking Shape

From `src/db/migrate.js`:

- table: `schema_migrations`
- columns:
  - `id BIGSERIAL PRIMARY KEY`
  - `name TEXT UNIQUE NOT NULL`
  - `applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

The manual tracking statement therefore only needs:

```sql
INSERT INTO schema_migrations(name) VALUES ('070_suppliers_master_phase1.sql');
```

In this runbook it is guarded with `WHERE NOT EXISTS (...)` and executed inside the same transaction.

## Temporary Files

- Suggested location: Desktop, `%TEMP%`, or another operator-controlled directory outside the repo.
- Do not commit them.
- Do not embed credentials or raw production URLs inside the file contents stored in git.
