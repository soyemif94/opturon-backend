-- Fail closed before changing identity: no legacy scope is inferred or repaired here.
DO $migration$
DECLARE
  issues JSONB := '{}'::jsonb;
  issue_count BIGINT;
  issue_sample TEXT;
  multi_language_count BIGINT;
  multi_language_sample TEXT;
BEGIN
  SELECT COALESCE(MAX(total_count), 0), COALESCE(string_agg(sample, '; '), 'none')
  INTO issue_count, issue_sample
  FROM (
    SELECT concat(
      'id=', left(id::text, 8),
      ',clinic=', left("clinicId"::text, 8),
      ',template=', left("templateKey", 40),
      ',language=', left(language, 16)
    ) AS sample,
    COUNT(*) OVER () AS total_count
    FROM whatsapp_templates
    WHERE "channelId" IS NULL
    ORDER BY id
    LIMIT 10
  ) samples;
  IF issue_count > 0 THEN
    issues := issues || jsonb_build_object(
      'missing_channel_scope', jsonb_build_object('count', issue_count, 'sample', issue_sample)
    );
  END IF;

  SELECT COALESCE(MAX(total_count), 0), COALESCE(string_agg(sample, '; '), 'none')
  INTO issue_count, issue_sample
  FROM (
    SELECT concat(
      'id=', left(id::text, 8),
      ',clinic=', left("clinicId"::text, 8),
      ',channel=', left(COALESCE("channelId"::text, 'none'), 8),
      ',template=', left("templateKey", 40)
    ) AS sample,
    COUNT(*) OVER () AS total_count
    FROM whatsapp_templates
    WHERE "wabaId" IS NULL OR length(trim("wabaId")) = 0
    ORDER BY id
    LIMIT 10
  ) samples;
  IF issue_count > 0 THEN
    issues := issues || jsonb_build_object(
      'missing_waba_scope', jsonb_build_object('count', issue_count, 'sample', issue_sample)
    );
  END IF;

  SELECT COALESCE(MAX(total_count), 0), COALESCE(string_agg(sample, '; '), 'none')
  INTO issue_count, issue_sample
  FROM (
    SELECT concat(
      'id=', left(template.id::text, 8),
      ',clinic=', left(template."clinicId"::text, 8),
      ',channel=', left(template."channelId"::text, 8)
    ) AS sample,
    COUNT(*) OVER () AS total_count
    FROM whatsapp_templates template
    LEFT JOIN channels channel ON channel.id = template."channelId"
    WHERE template."channelId" IS NOT NULL
      AND channel.id IS NULL
    ORDER BY template.id
    LIMIT 10
  ) samples;
  IF issue_count > 0 THEN
    issues := issues || jsonb_build_object(
      'orphan_channel_scope', jsonb_build_object('count', issue_count, 'sample', issue_sample)
    );
  END IF;

  SELECT COALESCE(MAX(total_count), 0), COALESCE(string_agg(sample, '; '), 'none')
  INTO issue_count, issue_sample
  FROM (
    SELECT concat(
      'id=', left(template.id::text, 8),
      ',template_clinic=', left(template."clinicId"::text, 8),
      ',channel=', left(template."channelId"::text, 8),
      ',channel_clinic=', left(channel."clinicId"::text, 8)
    ) AS sample,
    COUNT(*) OVER () AS total_count
    FROM whatsapp_templates template
    JOIN channels channel ON channel.id = template."channelId"
    WHERE channel."clinicId" <> template."clinicId"
    ORDER BY template.id
    LIMIT 10
  ) samples;
  IF issue_count > 0 THEN
    issues := issues || jsonb_build_object(
      'cross_tenant_channel_scope', jsonb_build_object('count', issue_count, 'sample', issue_sample)
    );
  END IF;

  SELECT COALESCE(MAX(total_count), 0), COALESCE(string_agg(sample, '; '), 'none')
  INTO issue_count, issue_sample
  FROM (
    SELECT concat(
      'id=', left(id::text, 8),
      ',clinic=', left("clinicId"::text, 8),
      ',channel=', left(COALESCE("channelId"::text, 'none'), 8)
    ) AS sample,
    COUNT(*) OVER () AS total_count
    FROM whatsapp_templates
    WHERE length(trim("templateKey")) = 0
      OR length(trim("metaTemplateName")) = 0
      OR length(trim(language)) = 0
    ORDER BY id
    LIMIT 10
  ) samples;
  IF issue_count > 0 THEN
    issues := issues || jsonb_build_object(
      'incomplete_template_identity', jsonb_build_object('count', issue_count, 'sample', issue_sample)
    );
  END IF;

  SELECT COALESCE(MAX(total_count), 0), COALESCE(string_agg(sample, '; '), 'none')
  INTO issue_count, issue_sample
  FROM (
    SELECT concat(
      'clinic=', left("clinicId"::text, 8),
      ',channel=', left("channelId"::text, 8),
      ',waba=', left("wabaId", 6),
      ',template=', left("templateKey", 40),
      ',language=', left(language, 16),
      ',rows=', COUNT(*),
      ',ids=', left(string_agg(left(id::text, 8), ',' ORDER BY id), 90)
    ) AS sample,
    COUNT(*) OVER () AS total_count
    FROM whatsapp_templates
    GROUP BY "clinicId", "channelId", "wabaId", "templateKey", language
    HAVING COUNT(*) > 1
    ORDER BY "clinicId", "channelId", "wabaId", "templateKey", language
    LIMIT 10
  ) samples;
  IF issue_count > 0 THEN
    issues := issues || jsonb_build_object(
      'duplicate_canonical_identity', jsonb_build_object('count', issue_count, 'sample', issue_sample)
    );
  END IF;

  SELECT COALESCE(MAX(total_count), 0), COALESCE(string_agg(sample, '; '), 'none')
  INTO issue_count, issue_sample
  FROM (
    SELECT concat(
      'clinic=', left("clinicId"::text, 8),
      ',channel=', left("channelId"::text, 8),
      ',waba=', left("wabaId", 6),
      ',name=', left("metaTemplateName", 40),
      ',language=', left(language, 16),
      ',rows=', COUNT(*),
      ',ids=', left(string_agg(left(id::text, 8), ',' ORDER BY id), 90)
    ) AS sample,
    COUNT(*) OVER () AS total_count
    FROM whatsapp_templates
    GROUP BY "clinicId", "channelId", "wabaId", "metaTemplateName", language
    HAVING COUNT(*) > 1
    ORDER BY "clinicId", "channelId", "wabaId", "metaTemplateName", language
    LIMIT 10
  ) samples;
  IF issue_count > 0 THEN
    issues := issues || jsonb_build_object(
      'duplicate_provider_identity', jsonb_build_object('count', issue_count, 'sample', issue_sample)
    );
  END IF;

  -- Future multi-language provider names are valid, but legacy rows require review first.
  SELECT COALESCE(MAX(total_count), 0), COALESCE(string_agg(sample, '; '), 'none')
  INTO multi_language_count, multi_language_sample
  FROM (
    SELECT concat(
      'clinic=', left("clinicId"::text, 8),
      ',channel=', left("channelId"::text, 8),
      ',waba=', left("wabaId", 6),
      ',name=', left("metaTemplateName", 40),
      ',languages=', COUNT(DISTINCT language)
    ) AS sample,
    COUNT(*) OVER () AS total_count
    FROM whatsapp_templates
    WHERE "channelId" IS NOT NULL
    GROUP BY "clinicId", "channelId", "wabaId", "metaTemplateName"
    HAVING COUNT(DISTINCT language) > 1
    ORDER BY "clinicId", "channelId", "wabaId", "metaTemplateName"
    LIMIT 10
  ) samples;

  IF multi_language_count > 0 THEN
    issues := issues || jsonb_build_object(
      'legacy_multi_language_provider_name',
      jsonb_build_object('count', multi_language_count, 'sample', multi_language_sample)
    );
  END IF;

  IF issues <> '{}'::jsonb THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = concat('migration_075_precheck_failed: ', issues::text);
  END IF;

  RAISE NOTICE 'migration_075_precheck_ok';
END
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_channels_id_clinic_id
  ON channels(id, "clinicId");

CREATE UNIQUE INDEX uq_whatsapp_templates_scope_key_language
  ON whatsapp_templates("clinicId", "channelId", "wabaId", "templateKey", language);

CREATE UNIQUE INDEX uq_whatsapp_templates_scope_provider_language
  ON whatsapp_templates("clinicId", "channelId", "wabaId", "metaTemplateName", language);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'whatsapp_templates'::regclass
      AND conname = 'chk_whatsapp_templates_channel_scope'
  ) THEN
    ALTER TABLE whatsapp_templates
      ADD CONSTRAINT chk_whatsapp_templates_channel_scope
      CHECK ("channelId" IS NOT NULL) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'whatsapp_templates'::regclass
      AND conname = 'chk_whatsapp_templates_waba_scope'
  ) THEN
    ALTER TABLE whatsapp_templates
      ADD CONSTRAINT chk_whatsapp_templates_waba_scope
      CHECK (length(trim("wabaId")) > 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'whatsapp_templates'::regclass
      AND conname = 'chk_whatsapp_templates_identity_non_empty'
  ) THEN
    ALTER TABLE whatsapp_templates
      ADD CONSTRAINT chk_whatsapp_templates_identity_non_empty
      CHECK (
        length(trim("templateKey")) > 0
        AND length(trim("metaTemplateName")) > 0
        AND length(trim(language)) > 0
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'whatsapp_templates'::regclass
      AND conname = 'fk_whatsapp_templates_channel_tenant'
  ) THEN
    ALTER TABLE whatsapp_templates
      ADD CONSTRAINT fk_whatsapp_templates_channel_tenant
      FOREIGN KEY ("channelId", "clinicId")
      REFERENCES channels(id, "clinicId")
      ON DELETE NO ACTION
      NOT VALID;
  END IF;
END
$migration$;

ALTER TABLE whatsapp_templates
  VALIDATE CONSTRAINT chk_whatsapp_templates_channel_scope;

ALTER TABLE whatsapp_templates
  VALIDATE CONSTRAINT chk_whatsapp_templates_waba_scope;

ALTER TABLE whatsapp_templates
  VALIDATE CONSTRAINT chk_whatsapp_templates_identity_non_empty;

ALTER TABLE whatsapp_templates
  VALIDATE CONSTRAINT fk_whatsapp_templates_channel_tenant;

ALTER TABLE whatsapp_templates
  ALTER COLUMN "channelId" SET NOT NULL;

-- The legacy single-column FK uses ON DELETE SET NULL, which contradicts required scope.
ALTER TABLE whatsapp_templates
  DROP CONSTRAINT IF EXISTS "whatsapp_templates_channelId_fkey";

-- These two legacy indexes prevent valid channel/WABA/language identities.
DROP INDEX IF EXISTS idx_whatsapp_templates_clinic_key_language;
DROP INDEX IF EXISTS idx_whatsapp_templates_clinic_meta_name;
