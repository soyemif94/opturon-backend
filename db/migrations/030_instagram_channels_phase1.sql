ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS type TEXT NULL,
  ADD COLUMN IF NOT EXISTS "externalId" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "externalPageId" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "externalPageName" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "instagramUserId" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "instagramUsername" TEXT NULL;

UPDATE channels
SET type = CASE
  WHEN LOWER(COALESCE(provider, '')) = 'instagram_graph' THEN 'instagram'
  ELSE 'whatsapp'
END
WHERE type IS NULL;

ALTER TABLE channels
  ALTER COLUMN type SET DEFAULT 'whatsapp';

ALTER TABLE channels
  ALTER COLUMN type SET NOT NULL;

ALTER TABLE channels
  ALTER COLUMN "phoneNumberId" DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_channels_clinic_type
  ON channels("clinicId", type);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_channels_instagram_external_id
  ON channels(type, "externalId")
  WHERE "externalId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_channels_instagram_page_id
  ON channels(type, "externalPageId")
  WHERE "externalPageId" IS NOT NULL;
