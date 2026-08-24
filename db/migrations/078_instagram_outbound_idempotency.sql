CREATE UNIQUE INDEX IF NOT EXISTS uniq_conversation_messages_portal_idempotency
  ON conversation_messages ("conversationId", (raw->>'portalIdempotencyKey'))
  WHERE direction = 'outbound'
    AND NULLIF(raw->>'portalIdempotencyKey', '') IS NOT NULL;
