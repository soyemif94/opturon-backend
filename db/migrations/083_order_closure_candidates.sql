CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS order_closure_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "channelId" UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  "conversationId" UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  "orderId" UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  "sourceMessageId" UUID NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  "orderRevision" TIMESTAMPTZ NOT NULL,
  "conversationRevision" UUID NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  "orderFingerprint" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'stale', 'blocked', 'confirmed')),
  "executeAfter" TIMESTAMPTZ NOT NULL,
  reason TEXT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "consumedAt" TIMESTAMPTZ NULL,
  UNIQUE ("tenantId", "orderId", "sourceMessageId")
);

CREATE INDEX IF NOT EXISTS idx_order_closure_candidates_pending
  ON order_closure_candidates ("executeAfter") WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_order_closure_candidates_conversation
  ON order_closure_candidates ("tenantId", "conversationId", status);
