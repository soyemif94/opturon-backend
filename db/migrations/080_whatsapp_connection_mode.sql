ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS "connectionMode" TEXT NOT NULL DEFAULT 'API_ONLY'
  CHECK ("connectionMode" IN ('API_ONLY', 'COEXISTENCE'));

ALTER TABLE channel_onboarding_sessions
  ADD COLUMN IF NOT EXISTS "requestedConnectionMode" TEXT NOT NULL DEFAULT 'API_ONLY'
  CHECK ("requestedConnectionMode" IN ('API_ONLY', 'COEXISTENCE'));
