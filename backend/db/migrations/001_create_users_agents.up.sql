-- Tenant boundary: every agent belongs to exactly one user.
CREATE TABLE users (
  id uuid PRIMARY KEY,
  telegram_user_id bigint NOT NULL,
  first_name text,
  last_name text,
  username text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_telegram_user_id_nonnegative CHECK (telegram_user_id >= 0)
);

CREATE UNIQUE INDEX users_telegram_user_id_idx ON users (telegram_user_id);

CREATE TABLE agents (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (btrim(name) <> ''),
  goal text NOT NULL CHECK (btrim(goal) <> ''),
  language text NOT NULL CHECK (btrim(language) <> ''),
  working_style text NOT NULL CHECK (btrim(working_style) <> ''),
  sources text[] NOT NULL DEFAULT '{}'::text[],
  prohibited_actions text[] NOT NULL DEFAULT '{}'::text[],
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agents_status_check CHECK (status IN ('draft', 'active', 'paused', 'archived'))
);

CREATE INDEX agents_user_id_idx ON agents (user_id);

CREATE OR REPLACE FUNCTION aura_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION aura_set_updated_at();

CREATE TRIGGER agents_set_updated_at
BEFORE UPDATE ON agents
FOR EACH ROW
EXECUTE FUNCTION aura_set_updated_at();
