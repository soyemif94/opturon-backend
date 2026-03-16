CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_id_clinic_id
  ON contacts(id, "clinicId");

CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_id_clinic_id
  ON conversations(id, "clinicId");

CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_id_clinic_id
  ON orders(id, "clinicId");

CREATE INDEX IF NOT EXISTS idx_contacts_clinic_email_lower
  ON contacts("clinicId", LOWER(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_clinic_tax_id_lower
  ON contacts("clinicId", LOWER("taxId"))
  WHERE "taxId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_clinic_phone
  ON contacts("clinicId", phone)
  WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_clinic_whatsapp_phone
  ON contacts("clinicId", "whatsappPhone")
  WHERE "whatsappPhone" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_orders_contact_scope'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT fk_orders_contact_scope
      FOREIGN KEY ("contactId", "clinicId")
      REFERENCES contacts(id, "clinicId")
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_orders_conversation_scope'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT fk_orders_conversation_scope
      FOREIGN KEY ("conversationId", "clinicId")
      REFERENCES conversations(id, "clinicId")
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_contact_scope'
  ) THEN
    ALTER TABLE invoices
      ADD CONSTRAINT fk_invoices_contact_scope
      FOREIGN KEY ("contactId", "clinicId")
      REFERENCES contacts(id, "clinicId")
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_order_scope'
  ) THEN
    ALTER TABLE invoices
      ADD CONSTRAINT fk_invoices_order_scope
      FOREIGN KEY ("orderId", "clinicId")
      REFERENCES orders(id, "clinicId")
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION sync_products_billing_fields()
RETURNS trigger AS $$
BEGIN
  IF NEW."unitPrice" IS NULL THEN
    NEW."unitPrice" := COALESCE(NEW.price, 0);
  END IF;

  NEW."unitPrice" := ROUND(NEW."unitPrice"::numeric, 2);
  NEW.price := NEW."unitPrice";
  NEW."vatRate" := ROUND(COALESCE(NEW."vatRate", 0)::numeric, 2);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_products_billing_fields ON products;
CREATE TRIGGER trg_sync_products_billing_fields
BEFORE INSERT OR UPDATE ON products
FOR EACH ROW
EXECUTE FUNCTION sync_products_billing_fields();

UPDATE products
SET
  "unitPrice" = ROUND(COALESCE(NULLIF("unitPrice", 0), price, 0)::numeric, 2),
  price = ROUND(COALESCE(NULLIF("unitPrice", 0), price, 0)::numeric, 2),
  "vatRate" = ROUND(COALESCE("vatRate", 0)::numeric, 2);

CREATE OR REPLACE FUNCTION sync_orders_billing_fields()
RETURNS trigger AS $$
BEGIN
  NEW.status := CASE
    WHEN LOWER(COALESCE(NEW.status, NEW."orderStatus", '')) IN ('confirmed', 'paid', 'preparing', 'ready', 'delivered')
      THEN 'confirmed'
    WHEN LOWER(COALESCE(NEW.status, NEW."orderStatus", '')) = 'cancelled'
      THEN 'cancelled'
    ELSE 'draft'
  END;

  IF NEW."subtotalAmount" IS NULL THEN
    NEW."subtotalAmount" := COALESCE(NEW.subtotal, 0);
  END IF;

  IF NEW."totalAmount" IS NULL THEN
    NEW."totalAmount" := COALESCE(NEW.total, NEW."subtotalAmount", 0);
  END IF;

  NEW."subtotalAmount" := ROUND(COALESCE(NEW."subtotalAmount", 0)::numeric, 2);
  NEW."totalAmount" := ROUND(COALESCE(NEW."totalAmount", 0)::numeric, 2);

  IF NEW."taxAmount" IS NULL THEN
    NEW."taxAmount" := NEW."totalAmount" - NEW."subtotalAmount";
  END IF;

  NEW."taxAmount" := ROUND(COALESCE(NEW."taxAmount", 0)::numeric, 2);
  NEW.subtotal := NEW."subtotalAmount";
  NEW.total := NEW."totalAmount";
  NEW."orderStatus" := CASE
    WHEN NEW.status = 'confirmed' THEN 'paid'
    WHEN NEW.status = 'cancelled' THEN 'cancelled'
    ELSE 'new'
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_orders_billing_fields ON orders;
CREATE TRIGGER trg_sync_orders_billing_fields
BEFORE INSERT OR UPDATE ON orders
FOR EACH ROW
EXECUTE FUNCTION sync_orders_billing_fields();

UPDATE orders
SET
  status = CASE
    WHEN LOWER(COALESCE(status, "orderStatus", '')) IN ('confirmed', 'paid', 'preparing', 'ready', 'delivered') THEN 'confirmed'
    WHEN LOWER(COALESCE(status, "orderStatus", '')) = 'cancelled' THEN 'cancelled'
    ELSE 'draft'
  END,
  "subtotalAmount" = ROUND(
    CASE
      WHEN COALESCE("subtotalAmount", 0) = 0 AND COALESCE(subtotal, 0) <> 0 THEN subtotal
      ELSE COALESCE("subtotalAmount", subtotal, 0)
    END::numeric,
    2
  ),
  "totalAmount" = ROUND(
    CASE
      WHEN COALESCE("totalAmount", 0) = 0 AND COALESCE(total, 0) <> 0 THEN total
      ELSE COALESCE("totalAmount", total, 0)
    END::numeric,
    2
  );

UPDATE orders
SET
  "taxAmount" = ROUND(("totalAmount" - "subtotalAmount")::numeric, 2),
  subtotal = "subtotalAmount",
  total = "totalAmount",
  "orderStatus" = CASE
    WHEN status = 'confirmed' THEN 'paid'
    WHEN status = 'cancelled' THEN 'cancelled'
    ELSE 'new'
  END;

CREATE OR REPLACE FUNCTION sync_order_items_billing_fields()
RETURNS trigger AS $$
BEGIN
  NEW."descriptionSnapshot" := COALESCE(NULLIF(NEW."descriptionSnapshot", ''), NEW."nameSnapshot");
  NEW."nameSnapshot" := COALESCE(NULLIF(NEW."nameSnapshot", ''), NEW."descriptionSnapshot");
  NEW."unitPrice" := ROUND(COALESCE(NEW."unitPrice", NEW."priceSnapshot", 0)::numeric, 2);
  NEW."priceSnapshot" := NEW."unitPrice";
  NEW."taxRate" := ROUND(COALESCE(NEW."taxRate", 0)::numeric, 2);
  NEW."subtotalAmount" := ROUND(COALESCE(NEW."subtotalAmount", NEW."unitPrice" * NEW.quantity, 0)::numeric, 2);
  NEW."totalAmount" := ROUND(COALESCE(NEW."totalAmount", NEW."subtotalAmount" + ROUND(NEW."subtotalAmount" * NEW."taxRate" / 100.0, 2), 0)::numeric, 2);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_order_items_billing_fields ON order_items;
CREATE TRIGGER trg_sync_order_items_billing_fields
BEFORE INSERT OR UPDATE ON order_items
FOR EACH ROW
EXECUTE FUNCTION sync_order_items_billing_fields();

UPDATE order_items
SET
  "descriptionSnapshot" = COALESCE(NULLIF("descriptionSnapshot", ''), "nameSnapshot"),
  "nameSnapshot" = COALESCE(NULLIF("nameSnapshot", ''), "descriptionSnapshot"),
  "unitPrice" = ROUND(COALESCE(NULLIF("unitPrice", 0), "priceSnapshot", 0)::numeric, 2),
  "priceSnapshot" = ROUND(COALESCE(NULLIF("unitPrice", 0), "priceSnapshot", 0)::numeric, 2),
  "taxRate" = ROUND(COALESCE("taxRate", 0)::numeric, 2),
  "subtotalAmount" = ROUND((COALESCE(NULLIF("unitPrice", 0), "priceSnapshot", 0) * quantity)::numeric, 2);

UPDATE order_items
SET
  "totalAmount" = ROUND(("subtotalAmount" + ROUND("subtotalAmount" * "taxRate" / 100.0, 2))::numeric, 2);

CREATE OR REPLACE FUNCTION sync_invoices_billing_fields()
RETURNS trigger AS $$
BEGIN
  NEW."subtotalAmount" := ROUND(COALESCE(NEW."subtotalAmount", 0)::numeric, 2);
  NEW."taxAmount" := ROUND(COALESCE(NEW."taxAmount", COALESCE(NEW."totalAmount", 0) - COALESCE(NEW."subtotalAmount", 0))::numeric, 2);
  NEW."totalAmount" := ROUND(COALESCE(NEW."totalAmount", NEW."subtotalAmount" + NEW."taxAmount", 0)::numeric, 2);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_invoices_billing_fields ON invoices;
CREATE TRIGGER trg_sync_invoices_billing_fields
BEFORE INSERT OR UPDATE ON invoices
FOR EACH ROW
EXECUTE FUNCTION sync_invoices_billing_fields();

UPDATE invoices
SET
  "subtotalAmount" = ROUND(COALESCE("subtotalAmount", 0)::numeric, 2),
  "totalAmount" = ROUND(COALESCE("totalAmount", "subtotalAmount" + COALESCE("taxAmount", 0), 0)::numeric, 2);

UPDATE invoices
SET
  "taxAmount" = ROUND(("totalAmount" - "subtotalAmount")::numeric, 2);

CREATE OR REPLACE FUNCTION sync_invoice_items_billing_fields()
RETURNS trigger AS $$
BEGIN
  NEW."unitPrice" := ROUND(COALESCE(NEW."unitPrice", 0)::numeric, 2);
  NEW."taxRate" := ROUND(COALESCE(NEW."taxRate", 0)::numeric, 2);
  NEW."subtotalAmount" := ROUND(COALESCE(NEW."subtotalAmount", NEW."unitPrice" * NEW.quantity, 0)::numeric, 2);
  NEW."totalAmount" := ROUND(COALESCE(NEW."totalAmount", NEW."subtotalAmount" + ROUND(NEW."subtotalAmount" * NEW."taxRate" / 100.0, 2), 0)::numeric, 2);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_invoice_items_billing_fields ON invoice_items;
CREATE TRIGGER trg_sync_invoice_items_billing_fields
BEFORE INSERT OR UPDATE ON invoice_items
FOR EACH ROW
EXECUTE FUNCTION sync_invoice_items_billing_fields();

UPDATE invoice_items
SET
  "unitPrice" = ROUND(COALESCE("unitPrice", 0)::numeric, 2),
  "taxRate" = ROUND(COALESCE("taxRate", 0)::numeric, 2),
  "subtotalAmount" = ROUND(("unitPrice" * quantity)::numeric, 2);

UPDATE invoice_items
SET
  "totalAmount" = ROUND(("subtotalAmount" + ROUND("subtotalAmount" * "taxRate" / 100.0, 2))::numeric, 2);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_products_billing_precision') THEN
    ALTER TABLE products DROP CONSTRAINT chk_products_billing_precision;
  END IF;
END $$;

ALTER TABLE products
  ADD CONSTRAINT chk_products_billing_precision
  CHECK (
    "unitPrice" >= 0
    AND "vatRate" >= 0
    AND price = "unitPrice"
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_orders_billing_amounts') THEN
    ALTER TABLE orders DROP CONSTRAINT chk_orders_billing_amounts;
  END IF;
END $$;

ALTER TABLE orders
  ADD CONSTRAINT chk_orders_billing_amounts
  CHECK (
    "subtotalAmount" >= 0
    AND "taxAmount" >= 0
    AND "totalAmount" = "subtotalAmount" + "taxAmount"
    AND subtotal = "subtotalAmount"
    AND total = "totalAmount"
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_order_items_billing_amounts') THEN
    ALTER TABLE order_items DROP CONSTRAINT chk_order_items_billing_amounts;
  END IF;
END $$;

ALTER TABLE order_items
  ADD CONSTRAINT chk_order_items_billing_amounts
  CHECK (
    "unitPrice" >= 0
    AND "taxRate" >= 0
    AND "subtotalAmount" = ROUND(("unitPrice" * quantity)::numeric, 2)
    AND "totalAmount" = ROUND(("subtotalAmount" + ROUND("subtotalAmount" * "taxRate" / 100.0, 2))::numeric, 2)
    AND "priceSnapshot" = "unitPrice"
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_billing_amounts') THEN
    ALTER TABLE invoices DROP CONSTRAINT chk_invoices_billing_amounts;
  END IF;
END $$;

ALTER TABLE invoices
  ADD CONSTRAINT chk_invoices_billing_amounts
  CHECK (
    "subtotalAmount" >= 0
    AND "taxAmount" >= 0
    AND "totalAmount" = "subtotalAmount" + "taxAmount"
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoice_items_billing_amounts') THEN
    ALTER TABLE invoice_items DROP CONSTRAINT chk_invoice_items_billing_amounts;
  END IF;
END $$;

ALTER TABLE invoice_items
  ADD CONSTRAINT chk_invoice_items_billing_amounts
  CHECK (
    "unitPrice" >= 0
    AND "taxRate" >= 0
    AND "subtotalAmount" = ROUND(("unitPrice" * quantity)::numeric, 2)
    AND "totalAmount" = ROUND(("subtotalAmount" + ROUND("subtotalAmount" * "taxRate" / 100.0, 2))::numeric, 2)
  );
