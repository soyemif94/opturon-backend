ALTER TABLE channels
  ALTER COLUMN "connectionMode" DROP DEFAULT,
  ALTER COLUMN "connectionMode" DROP NOT NULL;

UPDATE channels
SET "connectionMode" = NULL
WHERE provider <> 'whatsapp_cloud'
  AND "connectionMode" IS NOT NULL;

ALTER TABLE channels
  DROP CONSTRAINT IF EXISTS "channels_connectionMode_check";

ALTER TABLE channels
  DROP CONSTRAINT IF EXISTS channels_connection_mode_provider_check;

ALTER TABLE channels
  ADD CONSTRAINT channels_connection_mode_provider_check
  CHECK (
    (provider = 'whatsapp_cloud' AND "connectionMode" IS NOT NULL AND "connectionMode" IN ('API_ONLY', 'COEXISTENCE'))
    OR
    (provider <> 'whatsapp_cloud' AND "connectionMode" IS NULL)
  );
