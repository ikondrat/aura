-- Provider-neutral subscription state. Provider adapters record ordered,
-- owner-scoped transitions in subscription_transitions and update this row.
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  status text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  grace_until timestamptz,
  external_reference text,
  revision bigint NOT NULL DEFAULT 0,
  last_transition_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_status_check CHECK (status IN ('active', 'grace_period', 'cancelled')),
  CONSTRAINT subscriptions_period_check CHECK (period_start < period_end),
  CONSTRAINT subscriptions_grace_check CHECK (
    (status = 'grace_period' AND grace_until IS NOT NULL AND grace_until >= period_end)
    OR (status IN ('active', 'cancelled') AND grace_until IS NULL)
  ),
  CONSTRAINT subscriptions_external_reference_check CHECK (
    external_reference IS NULL
    OR (btrim(external_reference) <> '' AND char_length(external_reference) <= 500)
  ),
  CONSTRAINT subscriptions_revision_check CHECK (revision >= 0),
  CONSTRAINT subscriptions_last_transition_id_check CHECK (
    btrim(last_transition_id) <> '' AND char_length(last_transition_id) <= 255
  )
);

CREATE INDEX subscriptions_user_id_idx ON subscriptions (user_id);

CREATE TABLE subscription_transitions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  transition_id text NOT NULL,
  revision bigint NOT NULL,
  status text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  grace_until timestamptz,
  external_reference text,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_transitions_user_event_unique UNIQUE (user_id, transition_id),
  CONSTRAINT subscription_transitions_transition_id_check CHECK (
    btrim(transition_id) <> '' AND char_length(transition_id) <= 255
  ),
  CONSTRAINT subscription_transitions_status_check CHECK (status IN ('active', 'grace_period', 'cancelled')),
  CONSTRAINT subscription_transitions_period_check CHECK (period_start < period_end),
  CONSTRAINT subscription_transitions_grace_check CHECK (
    (status = 'grace_period' AND grace_until IS NOT NULL AND grace_until >= period_end)
    OR (status IN ('active', 'cancelled') AND grace_until IS NULL)
  ),
  CONSTRAINT subscription_transitions_external_reference_check CHECK (
    external_reference IS NULL
    OR (btrim(external_reference) <> '' AND char_length(external_reference) <= 500)
  ),
  CONSTRAINT subscription_transitions_revision_check CHECK (revision >= 0)
);

CREATE INDEX subscription_transitions_user_revision_idx
  ON subscription_transitions (user_id, revision DESC);

CREATE TRIGGER subscriptions_set_updated_at
BEFORE UPDATE ON subscriptions
FOR EACH ROW
EXECUTE FUNCTION aura_set_updated_at();
