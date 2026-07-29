\echo '=== postflight-070.sql ==='

SELECT to_regclass('public.suppliers') AS suppliers_table;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'products'
  AND column_name = 'defaultSupplierId';

SELECT constraint_name, constraint_type
FROM information_schema.table_constraints
WHERE table_schema = 'public'
  AND table_name IN ('suppliers', 'products')
  AND constraint_name IN (
    'uq_suppliers_id_tenant',
    'fk_products_default_supplier_tenant',
    'chk_suppliers_legal_name_non_empty',
    'chk_suppliers_status',
    'chk_suppliers_normalized_tax_id_non_empty',
    'chk_suppliers_email_format',
    'chk_suppliers_notes_length'
  )
ORDER BY table_name, constraint_name;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND (
    (tablename = 'suppliers' AND indexname IN (
      'idx_suppliers_tenant_status',
      'idx_suppliers_tenant_updated_at',
      'idx_suppliers_tenant_name',
      'uniq_suppliers_tenant_normalized_tax_id'
    ))
    OR
    (tablename = 'products' AND indexname = 'idx_products_clinic_default_supplier')
  )
ORDER BY tablename, indexname;

SELECT COUNT(*) AS suppliers_total FROM suppliers;
SELECT COUNT(*) AS products_with_default_supplier FROM products WHERE "defaultSupplierId" IS NOT NULL;
SELECT COUNT(*) AS products_total FROM products;
SELECT COUNT(*) AS products_active FROM products WHERE "deletedAt" IS NULL;
SELECT COUNT(*) AS products_tombstoned FROM products WHERE "deletedAt" IS NOT NULL;
SELECT COUNT(*) AS inventory_lots_total FROM inventory_lots;
SELECT COUNT(*) AS inventory_movements_total FROM inventory_movements;
SELECT COUNT(*) AS inventory_balances_total FROM inventory_balances;

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
