\echo '=== preflight-070.sql ==='

SELECT current_setting('server_version') AS server_version;
SELECT current_user AS current_user, session_user AS session_user, current_database() AS database_name;

SELECT name, applied_at
FROM schema_migrations
WHERE name IN (
  '061_whatsapp_chat_imports_phase1.sql',
  '067_inventory_lot_location_and_uniqueness.sql',
  '068_inventory_lot_operational_state.sql',
  '069_inventory_lot_operation_idempotency.sql',
  '070_suppliers_master_phase1.sql'
)
ORDER BY name;

SELECT COUNT(*) AS products_total FROM products;
SELECT COUNT(*) AS products_active FROM products WHERE "deletedAt" IS NULL;
SELECT COUNT(*) AS products_tombstoned FROM products WHERE "deletedAt" IS NOT NULL;

SELECT to_regclass('public.suppliers') AS suppliers_table;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'products'
  AND column_name = 'defaultSupplierId';

SELECT COUNT(*) AS inventory_lots_total FROM inventory_lots;
SELECT COUNT(*) AS inventory_movements_total FROM inventory_movements;
SELECT COUNT(*) AS inventory_balances_total FROM inventory_balances;
