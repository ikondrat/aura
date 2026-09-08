-- Chat history is owned by a user. An agent may be detached when it is deleted,
-- while deleting the user removes the user's conversations and messages.
CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_status_check CHECK (status IN ('active', 'archived'))
);

CREATE INDEX conversations_user_updated_at_idx
  ON conversations (user_id, updated_at DESC, id DESC);

-- A normal foreign key cannot enforce that agent_id belongs to the same user.
CREATE OR REPLACE FUNCTION aura_validate_conversation_agent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.agent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agents WHERE id = NEW.agent_id AND user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'conversation agent does not belong to its user';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER conversations_validate_agent
BEFORE INSERT OR UPDATE OF user_id, agent_id ON conversations
FOR EACH ROW
EXECUTE FUNCTION aura_validate_conversation_agent();

CREATE TRIGGER conversations_set_updated_at
BEFORE UPDATE ON conversations
FOR EACH ROW
EXECUTE FUNCTION aura_set_updated_at();

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  provider_metadata jsonb,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_role_check CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  CONSTRAINT messages_content_check CHECK (btrim(content) <> '' AND char_length(content) <= 10000),
  CONSTRAINT messages_idempotency_key_check
    CHECK (idempotency_key IS NULL OR (btrim(idempotency_key) <> '' AND char_length(idempotency_key) <= 255))
);

CREATE INDEX messages_conversation_created_at_idx
  ON messages (conversation_id, created_at ASC, id ASC);

CREATE UNIQUE INDEX messages_conversation_idempotency_key_idx
  ON messages (conversation_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Conversation recency reflects the latest appended message.
CREATE OR REPLACE FUNCTION aura_touch_conversation_on_message()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE conversations SET updated_at = now() WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER messages_touch_conversation
AFTER INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION aura_touch_conversation_on_message();
