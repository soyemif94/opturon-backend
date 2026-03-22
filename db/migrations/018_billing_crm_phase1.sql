ALTER TABLE contacts
  ALTER COLUMN "waId" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS email TEXT NULL,
  ADD COLUMN IF NOT EXISTS "whatsappPhone" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "taxId" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "taxCondition" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "companyName" TEXT NULL,
  ADD COLUMN IF NOT EXISTS notes TEXT NULL,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

UPDATE contacts
SET
  "whatsappPhone" = COALESCE(NULLIF("whatsappPhone", ''), phone),
  status = CASE
    WHEN LOWER(COALESCE(status, '')) = 'archived' THEN 'archived'
    ELSE 'active'
  END,
  metadata = COALESCE(metadata, '{}'::jsonb)
WHERE
  "whatsappPhone" IS NULL
  OR status IS NULL
  OR metadata IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_contacts_status'
  ) THEN
    ALTER TABLE contacts DROP CONSTRAINT chk_contacts_status;
  END IF;
END $$;

ALTER TABLE contacts
  ADD CONSTRAINT chk_contacts_status
  CHECK (status IN ('active', 'archived'));

CREATE INDEX IF NOT EXISTS idx_contacts_clinic_status
  ON contacts("clinicId", status);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS "unitPrice" NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "vatRate" NUMERIC(5, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE products
SET
  "unitPrice" = COALESCE(NULLIF("unitPrice", 0), price),
  "vatRate" = COALESCE("vatRate", 0),
  metadata = COALESCE(metadata, '{}'::jsonb),
  status = CASE
    WHEN LOWER(COALESCE(status, '')) IN ('inactive', 'archived') THEN 'archived'
    ELSE 'active'
  END;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_products_status'
  ) THEN
    ALTER TABLE products DROP CONSTRAINT chk_products_status;
  END IF;
END $$;

ALTER TABLE products
  ADD CONSTRAINT chk_products_status
  CHECK (status IN ('active', 'archived'));

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS source TEXT NULL,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS "subtotalAmount" NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "taxAmount" NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalAmount" NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "conversationId" UUID NULL;

UPDATE orders
SET
  status = CASE
    WHEN LOWER(COALESCE("orderStatus", '')) IN ('paid', 'preparing', 'ready', 'delivered', 'confirmed') THEN 'confirmed'
    WHEN LOWER(COALESCE("orderStatus", '')) = 'cancelled' THEN 'cancelled'
    ELSE 'draft'
  END,
  "subtotalAmount" = COALESCE("subtotalAmount", subtotal, 0),
  "taxAmount" = COALESCE("taxAmount", GREATEST(total - subtotal, 0), 0),
  "totalAmount" = COALESCE("totalAmount", total, 0);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_orders_status'
  ) THEN
    ALTER TABLE orders DROP CONSTRAINT chk_orders_status;
  END IF;
END $$;

ALTER TABLE orders
  ADD CONSTRAINT chk_orders_status
  CHECK (status IN ('draft', 'confirmed', 'cancelled'));

CREATE INDEX IF NOT EXISTS idx_orders_clinic_status_v2
  ON orders("clinicId", status);

CREATE INDEX IF NOT EXISTS idx_orders_clinic_conversation
  ON orders("clinicId", "conversationId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_orders_conversation_id'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT fk_orders_conversation_id
      FOREIGN KEY ("conversationId")
      REFERENCES conversations(id)
      ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS "descriptionSnapshot" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "unitPrice" NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "taxRate" NUMERIC(5, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "subtotalAmount" NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalAmount" NUMERIC(12, 2) NOT NULL DEFAULT 0;

UPDATE order_items
SET
  "descriptionSnapshot" = COALESCE(NULLIF("descriptionSnapshot", ''), "nameSnapshot"),
  "unitPrice" = COALESCE(NULLIF("unitPrice", 0), "priceSnapshot"),
  "taxRate" = COALESCE("taxRate", 0),
  "subtotalAmount" = COALESCE("subtotalAmount", ROUND(("priceSnapshot" * quantity)::numeric, 2), 0),
  "totalAmount" = COALESCE("totalAmount", ROUND(("priceSnapshot" * quantity)::numeric, 2), 0);

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "contactId" UUID NULL REFERENCES contacts(id) ON DELETE SET NULL,
  "orderId" UUID NULL REFERENCES orders(id) ON DELETE SET NULL,
  "invoiceNumber" TEXT NULL,
  type TEXT NOT NULL DEFAULT 'invoice',
  status TEXT NOT NULL DEFAULT 'draft',
  currency TEXT NOT NULL DEFAULT 'ARS',
  "subtotalAmount" NUMERIC(12, 2) NOT NULL DEFAULT 0,
  "taxAmount" NUMERIC(12, 2) NOT NULL DEFAULT 0,
  "totalAmount" NUMERIC(12, 2) NOT NULL DEFAULT 0,
  "issuedAt" TIMESTAMPTZ NULL,
  "dueAt" TIMESTAMPTZ NULL,
  "externalProvider" TEXT NULL,
  "externalReference" TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_invoices_type CHECK (type IN ('invoice', 'credit_note')),
  CONSTRAINT chk_invoices_status CHECK (status IN ('draft', 'issued', 'void'))
);

CREATE INDEX IF NOT EXISTS idx_invoices_clinic_created_at
  ON invoices("clinicId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_clinic_status
  ON invoices("clinicId", status);

CREATE INDEX IF NOT EXISTS idx_invoices_clinic_contact
  ON invoices("clinicId", "contactId");

CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoices_clinic_invoice_number
  ON invoices("clinicId", "invoiceNumber")
  WHERE "invoiceNumber" IS NOT NULL;

CREATE TABLE IF NOT EXISTS invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "invoiceId" UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  "productId" UUID NULL REFERENCES products(id) ON DELETE SET NULL,
  "descriptionSnapshot" TEXT NOT NULL,
  quantity NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  "unitPrice" NUMERIC(12, 2) NOT NULL DEFAULT 0,
  "taxRate" NUMERIC(5, 2) NOT NULL DEFAULT 0,
  "subtotalAmount" NUMERIC(12, 2) NOT NULL DEFAULT 0,
  "totalAmount" NUMERIC(12, 2) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_created
  ON invoice_items("invoiceId", "createdAt");
