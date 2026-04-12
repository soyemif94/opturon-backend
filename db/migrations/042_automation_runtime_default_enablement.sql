UPDATE automation_templates
SET
  "defaultEnabled" = TRUE,
  "updatedAt" = NOW()
WHERE key IN ('agenda_booking', 'appointment_reminders')
  AND "defaultEnabled" = FALSE;
