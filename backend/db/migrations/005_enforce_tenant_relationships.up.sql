-- Enforce ownership on relationships that carry a tenant id alongside a
-- referenced record. Composite foreign keys close the race between an
-- application ownership check and the subsequent write.
ALTER TABLE agents
  ADD CONSTRAINT agents_id_user_id_key UNIQUE (id, user_id);

ALTER TABLE conversations
  ADD CONSTRAINT conversations_id_user_id_key UNIQUE (id, user_id);

ALTER TABLE conversations
  DROP CONSTRAINT conversations_agent_id_fkey,
  ADD CONSTRAINT conversations_agent_owner_fkey
    FOREIGN KEY (agent_id, user_id)
    REFERENCES agents (id, user_id)
    ON DELETE SET NULL (agent_id);

ALTER TABLE usage_events
  DROP CONSTRAINT usage_events_agent_id_fkey,
  ADD CONSTRAINT usage_events_agent_owner_fkey
    FOREIGN KEY (agent_id, user_id)
    REFERENCES agents (id, user_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT usage_events_conversation_owner_fkey
    FOREIGN KEY (conversation_id, user_id)
    REFERENCES conversations (id, user_id)
    ON DELETE SET NULL (conversation_id);
