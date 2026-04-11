CREATE TABLE IF NOT EXISTS automation_templates (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NULL,
  category TEXT NOT NULL,
  "businessTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "requiredCapabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "defaultEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active',
  "configSchema" JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenant_automation_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "externalTenantId" TEXT NULL,
  "templateKey" TEXT NOT NULL REFERENCES automation_templates(key) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("clinicId", "templateKey")
);

CREATE INDEX IF NOT EXISTS idx_tenant_automation_templates_clinic
  ON tenant_automation_templates ("clinicId");

INSERT INTO automation_templates (
  key,
  name,
  description,
  category,
  "businessTypes",
  "requiredCapabilities",
  "defaultEnabled",
  status,
  "configSchema",
  metadata
)
VALUES
  (
    'conversation_welcome',
    'Bienvenida conversacional',
    'Recibe al contacto y ordena el inicio de la conversacion por WhatsApp.',
    'conversation',
    ARRAY['dental_clinic', 'medical_clinic', 'retail_products', 'services_general', 'beauty_salon'],
    ARRAY['whatsapp', 'contacts'],
    TRUE,
    'active',
    '{"type":"object"}'::jsonb,
    '{"runtimeAutomationNames":["Conversational Welcome Menu"]}'::jsonb
  ),
  (
    'conversation_products_menu',
    'Menu de productos',
    'Responde catalogo o productos cuando el negocio trabaja con oferta comercial visible.',
    'catalog',
    ARRAY['retail_products'],
    ARRAY['whatsapp', 'catalog'],
    FALSE,
    'active',
    '{"type":"object"}'::jsonb,
    '{"runtimeAutomationNames":["Conversational Menu Products"]}'::jsonb
  ),
  (
    'conversation_pricing_menu',
    'Consulta de precios',
    'Guia consultas de precios y primeros mensajes comerciales por WhatsApp.',
    'sales',
    ARRAY['dental_clinic', 'medical_clinic', 'retail_products', 'services_general', 'beauty_salon'],
    ARRAY['whatsapp'],
    TRUE,
    'active',
    '{"type":"object"}'::jsonb,
    '{"runtimeAutomationNames":["Conversational Menu Pricing"]}'::jsonb
  ),
  (
    'conversation_human_handoff',
    'Derivacion a humano',
    'Escala conversaciones a una persona cuando hace falta intervencion humana.',
    'conversation',
    ARRAY['dental_clinic', 'medical_clinic', 'retail_products', 'services_general', 'beauty_salon'],
    ARRAY['whatsapp', 'contacts'],
    TRUE,
    'active',
    '{"type":"object"}'::jsonb,
    '{"runtimeAutomationNames":["Conversational Menu Human"]}'::jsonb
  ),
  (
    'conversation_fallback',
    'Fallback conversacional',
    'Reordena la conversacion cuando el mensaje no encaja en una opcion conocida.',
    'conversation',
    ARRAY['dental_clinic', 'medical_clinic', 'retail_products', 'services_general', 'beauty_salon'],
    ARRAY['whatsapp'],
    TRUE,
    'active',
    '{"type":"object"}'::jsonb,
    '{"runtimeAutomationNames":["Conversational Menu Fallback"]}'::jsonb
  ),
  (
    'agenda_booking',
    'Agenda de turnos o reservas',
    'Permite ofrecer y gestionar reservas o turnos para negocios que trabajan con agenda.',
    'agenda',
    ARRAY['dental_clinic', 'medical_clinic', 'services_general', 'beauty_salon'],
    ARRAY['whatsapp', 'agenda', 'contacts'],
    FALSE,
    'active',
    '{"type":"object"}'::jsonb,
    '{}'::jsonb
  ),
  (
    'appointment_reminders',
    'Recordatorios de turnos',
    'Envia recordatorios automaticos antes de un turno confirmado.',
    'agenda',
    ARRAY['dental_clinic', 'medical_clinic', 'services_general', 'beauty_salon'],
    ARRAY['whatsapp', 'agenda', 'contacts'],
    FALSE,
    'active',
    '{"type":"object"}'::jsonb,
    '{}'::jsonb
  ),
  (
    'catalog_risk_discount',
    'Descuento por stock en riesgo',
    'Ayuda a mover stock proximo a vencer o critico desde el catalogo.',
    'catalog',
    ARRAY['retail_products'],
    ARRAY['catalog'],
    FALSE,
    'active',
    '{"type":"object"}'::jsonb,
    '{}'::jsonb
  )
ON CONFLICT (key) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  "businessTypes" = EXCLUDED."businessTypes",
  "requiredCapabilities" = EXCLUDED."requiredCapabilities",
  "defaultEnabled" = EXCLUDED."defaultEnabled",
  status = EXCLUDED.status,
  "configSchema" = EXCLUDED."configSchema",
  metadata = EXCLUDED.metadata,
  "updatedAt" = NOW();
