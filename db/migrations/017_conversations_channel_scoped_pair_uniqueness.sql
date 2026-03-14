DROP INDEX IF EXISTS uniq_conversations_wa_from_wa_to;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_conversations_channel_wa_from_wa_to
  ON conversations("channelId", "waFrom", "waTo");
