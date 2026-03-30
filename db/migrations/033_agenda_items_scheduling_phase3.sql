ALTER TABLE agenda_items
DROP CONSTRAINT IF EXISTS chk_agenda_items_type;

ALTER TABLE agenda_items
ADD CONSTRAINT chk_agenda_items_type
CHECK (type IN ('note', 'follow_up', 'task', 'appointment', 'blocked', 'availability'));
