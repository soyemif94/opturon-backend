CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS order_amendments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "channelId" UUID NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  "conversationId" UUID NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  "contactId" UUID NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  "orderId" UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  "baseVersion" INTEGER NOT NULL CHECK ("baseVersion" > 0),
  "targetVersion" INTEGER NOT NULL CHECK ("targetVersion" = "baseVersion" + 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'candidate', 'blocked', 'cancelled', 'confirmed')),
  baseline JSONB NOT NULL CHECK (jsonb_typeof(baseline) = 'object'),
  proposed JSONB NOT NULL CHECK (jsonb_typeof(proposed) = 'object'),
  delta JSONB NOT NULL CHECK (jsonb_typeof(delta) = 'object'),
  "sourceMessageIds" UUID[] NOT NULL DEFAULT '{}',
  "lastSourceMessageId" UUID NOT NULL REFERENCES conversation_messages(id) ON DELETE RESTRICT,
  "baseOrderUpdatedAt" TIMESTAMPTZ NOT NULL,
  "candidateSourceMessageId" UUID NULL REFERENCES conversation_messages(id) ON DELETE SET NULL,
  "candidateRevision" INTEGER NULL,
  "candidateConversationRevision" UUID NULL REFERENCES conversation_messages(id) ON DELETE SET NULL,
  "candidateFingerprint" TEXT NULL,
  "executeAfter" TIMESTAMPTZ NULL,
  "confirmedSnapshot" JSONB NULL CHECK ("confirmedSnapshot" IS NULL OR jsonb_typeof("confirmedSnapshot") = 'object'),
  reason TEXT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "confirmedAt" TIMESTAMPTZ NULL,
  CONSTRAINT fk_order_amendments_order_tenant
    FOREIGN KEY ("orderId", "tenantId") REFERENCES orders(id, "clinicId"),
  CONSTRAINT fk_order_amendments_contact_tenant
    FOREIGN KEY ("contactId", "tenantId") REFERENCES contacts(id, "clinicId"),
  CONSTRAINT fk_order_amendments_conversation_tenant
    FOREIGN KEY ("conversationId", "tenantId") REFERENCES conversations(id, "clinicId"),
  CONSTRAINT fk_order_amendments_channel_tenant
    FOREIGN KEY ("channelId", "tenantId") REFERENCES channels(id, "clinicId")
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_order_amendments_id_tenant
  ON order_amendments (id, "tenantId");
CREATE UNIQUE INDEX IF NOT EXISTS uniq_order_amendments_version
  ON order_amendments ("tenantId", "orderId", "baseVersion") WHERE status = 'confirmed';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_order_amendments_active
  ON order_amendments ("tenantId", "orderId")
  WHERE status IN ('in_progress', 'candidate', 'blocked');
CREATE INDEX IF NOT EXISTS idx_order_amendments_conversation
  ON order_amendments ("tenantId", "conversationId", status);

CREATE TABLE IF NOT EXISTS order_amendment_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "amendmentId" UUID NOT NULL REFERENCES order_amendments(id) ON DELETE CASCADE,
  "productId" UUID NOT NULL,
  quantity NUMERIC(14, 3) NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released', 'committed')),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_order_amendment_reservations_product_tenant
    FOREIGN KEY ("productId", "tenantId") REFERENCES products(id, "clinicId"),
  CONSTRAINT fk_order_amendment_reservations_amendment_tenant
    FOREIGN KEY ("amendmentId", "tenantId") REFERENCES order_amendments(id, "tenantId")
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_order_amendment_reservations_active_product
  ON order_amendment_reservations ("amendmentId", "productId") WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_order_amendment_reservations_product_active
  ON order_amendment_reservations ("tenantId", "productId", status);
