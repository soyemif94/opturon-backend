CREATE TABLE IF NOT EXISTS staff_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staff_users_clinic_id ON staff_users("clinicId");

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "channelId" UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  "conversationId" UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  "contactId" UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'new',
  source TEXT NOT NULL DEFAULT 'whatsapp',
  "primaryIntent" TEXT NULL,
  notes TEXT NULL,
  "assignedTo" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE("clinicId", "conversationId")
);
CREATE INDEX IF NOT EXISTS idx_leads_clinic_id ON leads("clinicId");
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

CREATE TABLE IF NOT EXISTS calendar_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL UNIQUE REFERENCES clinics(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  "slotMinutes" INT NOT NULL DEFAULT 30,
  "leadTimeMinutes" INT NOT NULL DEFAULT 60,
  "workDays" JSONB NOT NULL DEFAULT '[1,2,3,4,5]'::jsonb,
  "workHours" JSONB NOT NULL DEFAULT '{"start":"09:00","end":"18:00"}'::jsonb,
  "breakHours" JSONB NOT NULL DEFAULT '{"start":"13:00","end":"14:00"}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS calendar_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "startsAt" TIMESTAMPTZ NOT NULL,
  "endsAt" TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  "heldUntil" TIMESTAMPTZ NULL,
  "heldByConversationId" UUID NULL REFERENCES conversations(id) ON DELETE SET NULL,
  "bookedByLeadId" UUID NULL REFERENCES leads(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE("clinicId", "startsAt", "endsAt")
);
CREATE INDEX IF NOT EXISTS idx_calendar_slots_clinic_id ON calendar_slots("clinicId");
CREATE INDEX IF NOT EXISTS idx_calendar_slots_status_starts_at ON calendar_slots(status, "startsAt");

CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "leadId" UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  "conversationId" UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  "contactId" UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  "slotId" UUID NOT NULL REFERENCES calendar_slots(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'booked',
  reason TEXT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_appointments_booked_slot
  ON appointments("clinicId", "slotId")
  WHERE status = 'booked';
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_id ON appointments("clinicId");
CREATE INDEX IF NOT EXISTS idx_appointments_contact_id ON appointments("contactId");
CREATE INDEX IF NOT EXISTS idx_appointments_lead_id ON appointments("leadId");

CREATE TABLE IF NOT EXISTS handoff_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "conversationId" UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  "contactId" UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  "leadId" UUID NULL REFERENCES leads(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',
  "assignedTo" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_handoff_open_or_assigned
  ON handoff_requests("clinicId", "conversationId")
  WHERE status IN ('open', 'assigned');
CREATE INDEX IF NOT EXISTS idx_handoff_clinic_id ON handoff_requests("clinicId");

CREATE TABLE IF NOT EXISTS conversation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "conversationId" UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversation_events_clinic_id ON conversation_events("clinicId");
CREATE INDEX IF NOT EXISTS idx_conversation_events_conversation_id ON conversation_events("conversationId");
CREATE INDEX IF NOT EXISTS idx_conversation_events_type ON conversation_events(type);
