ALTER TABLE loyalty_rewards
  ADD COLUMN IF NOT EXISTS "stockQty" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS image JSONB NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_loyalty_rewards_stock_qty_nonnegative'
  ) THEN
    ALTER TABLE loyalty_rewards
      ADD CONSTRAINT chk_loyalty_rewards_stock_qty_nonnegative CHECK ("stockQty" >= 0);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION sync_loyalty_reward_fields()
RETURNS trigger AS $$
BEGIN
  NEW.name := BTRIM(COALESCE(NEW.name, ''));
  NEW.description := NULLIF(BTRIM(COALESCE(NEW.description, '')), '');
  NEW."pointsCost" := COALESCE(NEW."pointsCost", 0);
  NEW."stockQty" := COALESCE(NEW."stockQty", 0);
  NEW.active := COALESCE(NEW.active, TRUE);

  IF NEW.image IS NOT NULL AND jsonb_typeof(NEW.image) <> 'object' THEN
    NEW.image := NULL;
  END IF;

  NEW."updatedAt" := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
