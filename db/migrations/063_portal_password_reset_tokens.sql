CREATE TABLE IF NOT EXISTS portal_password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "consumedAt" TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_portal_password_reset_tokens_token_hash
  ON portal_password_reset_tokens ("tokenHash");

CREATE INDEX IF NOT EXISTS idx_portal_password_reset_tokens_user_created
  ON portal_password_reset_tokens ("userId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_portal_password_reset_tokens_active_user
  ON portal_password_reset_tokens ("userId", "expiresAt" DESC)
  WHERE "consumedAt" IS NULL;
