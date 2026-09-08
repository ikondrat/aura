-- Usage events are retained for accounting when an agent or conversation is removed.
CREATE TABLE usage_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents (id) ON DELETE RESTRICT,
  -- Kept as a nullable correlation reference until the conversations migration
  -- is applied; usage accounting must not depend on chat-history retention.
  conversation_id uuid,
  provider text,
  model text,
  request_id text,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  total_tokens bigint NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  cost_microusd bigint CHECK (cost_microusd IS NULL OR cost_microusd >= 0),
  status text NOT NULL CHECK (status IN ('succeeded', 'failed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_events_request_id_nonempty
    CHECK (request_id IS NULL OR btrim(request_id) <> ''),
  CONSTRAINT usage_events_provider_nonempty
    CHECK (provider IS NULL OR btrim(provider) <> ''),
  CONSTRAINT usage_events_model_nonempty
    CHECK (model IS NULL OR btrim(model) <> '')
);

CREATE INDEX usage_events_user_created_at_idx
  ON usage_events (user_id, created_at DESC, id DESC);

CREATE INDEX usage_events_user_agent_idx
  ON usage_events (user_id, agent_id)
  WHERE agent_id IS NOT NULL;

CREATE UNIQUE INDEX usage_events_user_request_id_idx
  ON usage_events (user_id, request_id)
  WHERE request_id IS NOT NULL;

-- An agent may only be attached to an event owned by the same user.
CREATE OR REPLACE FUNCTION aura_validate_usage_event_agent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.agent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agents WHERE id = NEW.agent_id AND user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'usage event agent does not belong to its user';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER usage_events_validate_agent
BEFORE INSERT ON usage_events
FOR EACH ROW
EXECUTE FUNCTION aura_validate_usage_event_agent();

-- Repository code never updates an event; keeping this invariant in the schema
-- prevents accounting changes through an accidental UPDATE path.
CREATE OR REPLACE FUNCTION aura_usage_events_are_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'usage_events are immutable';
END;
$$;

CREATE TRIGGER usage_events_immutable
BEFORE UPDATE ON usage_events
FOR EACH ROW
EXECUTE FUNCTION aura_usage_events_are_immutable();
