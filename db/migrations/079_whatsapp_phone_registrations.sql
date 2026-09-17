-- Server-only registration secrets, intentionally separate from channel and
-- onboarding metadata that can be included in API responses.
CREATE TABLE IF NOT EXISTS whatsapp_phone_registrations (
  "phoneNumberId" TEXT PRIMARY KEY,
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "encryptedPin" TEXT NOT NULL CHECK ("encryptedPin" LIKE 'enc:v1:gcm:%'),
  "registeredAt" TIMESTAMPTZ NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_phone_registrations_clinic_id
  ON whatsapp_phone_registrations("clinicId");
