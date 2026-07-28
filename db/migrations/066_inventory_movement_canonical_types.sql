DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_inventory_movements_type'
  ) THEN
    ALTER TABLE inventory_movements
      DROP CONSTRAINT chk_inventory_movements_type;
  END IF;
END $$;

ALTER TABLE inventory_movements
  ADD CONSTRAINT chk_inventory_movements_type
  CHECK ("movementType" IN (
    'initial_stock',
    'manual_adjustment_in',
    'manual_adjustment_out',
    'expired_writeoff',
    'cancellation',
    'purchase_receipt',
    'sale',
    'opening_balance',
    'manual_increase',
    'manual_decrease',
    'correction',
    'return_in',
    'return_out'
  ));
