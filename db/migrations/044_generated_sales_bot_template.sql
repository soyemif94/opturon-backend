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
VALUES (
  'generated_sales_bot',
  'Bot comercial generado',
  'Runtime comercial generado desde onboarding. Solo se ejecuta si esta registrado para este tenant.',
  'sales',
  ARRAY['retail_products', 'services_general', 'beauty_salon'],
  ARRAY['whatsapp'],
  FALSE,
  'active',
  '{"type":"object"}'::jsonb,
  '{"runtimeConfigKey":"bot.runtimeConfig"}'::jsonb
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
