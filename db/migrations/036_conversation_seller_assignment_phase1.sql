ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS "assignedSellerUserId" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_assigned_seller_user_id
  ON conversations("assignedSellerUserId");

UPDATE conversations c
SET "assignedSellerUserId" = su.id
FROM staff_users su
WHERE c."assignedSellerUserId" IS NULL
  AND NULLIF(c.context->>'portalAssignedToUserId', '') IS NOT NULL
  AND su.id::text = c.context->>'portalAssignedToUserId'
  AND su."clinicId" = c."clinicId";
