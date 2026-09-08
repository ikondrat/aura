ALTER TABLE usage_events
  DROP CONSTRAINT usage_events_conversation_owner_fkey,
  DROP CONSTRAINT usage_events_agent_owner_fkey,
  ADD CONSTRAINT usage_events_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE RESTRICT;

ALTER TABLE conversations
  DROP CONSTRAINT conversations_agent_owner_fkey,
  ADD CONSTRAINT conversations_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE SET NULL;

ALTER TABLE conversations
  DROP CONSTRAINT conversations_id_user_id_key;

ALTER TABLE agents
  DROP CONSTRAINT agents_id_user_id_key;
