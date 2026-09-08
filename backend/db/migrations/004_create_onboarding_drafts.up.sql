-- A draft is the durable, owner-scoped state for the five-step onboarding flow.
CREATE OR REPLACE FUNCTION aura_text_array_has_no_blank(items text[])
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  value text;
BEGIN
  FOREACH value IN ARRAY items LOOP
    IF value IS NULL OR btrim(value) = '' THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE TABLE onboarding_drafts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  goal text,
  language text,
  working_style text,
  sources text[] NOT NULL DEFAULT '{}'::text[],
  prohibited_actions text[] NOT NULL DEFAULT '{}'::text[],
  current_step text NOT NULL DEFAULT 'goal',
  status text NOT NULL DEFAULT 'in_progress',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_drafts_current_step_check CHECK (
    current_step IN ('goal', 'language', 'working_style', 'sources', 'prohibited_actions', 'preview')
  ),
  CONSTRAINT onboarding_drafts_status_check CHECK (
    status IN ('in_progress', 'paused', 'ready_for_preview', 'completed', 'cancelled')
  ),
  CONSTRAINT onboarding_drafts_goal_check CHECK (goal IS NULL OR btrim(goal) <> ''),
  CONSTRAINT onboarding_drafts_language_check CHECK (language IS NULL OR btrim(language) <> ''),
  CONSTRAINT onboarding_drafts_working_style_check CHECK (
    working_style IS NULL OR btrim(working_style) <> ''
  ),
  CONSTRAINT onboarding_drafts_sources_check CHECK (aura_text_array_has_no_blank(sources)),
  CONSTRAINT onboarding_drafts_prohibited_actions_check CHECK (
    aura_text_array_has_no_blank(prohibited_actions)
  )
);

CREATE UNIQUE INDEX onboarding_drafts_one_active_per_user_idx
  ON onboarding_drafts (user_id)
  WHERE status IN ('in_progress', 'paused', 'ready_for_preview');

CREATE INDEX onboarding_drafts_user_updated_at_idx
  ON onboarding_drafts (user_id, updated_at DESC, id DESC);

CREATE TRIGGER onboarding_drafts_set_updated_at
BEFORE UPDATE ON onboarding_drafts
FOR EACH ROW
EXECUTE FUNCTION aura_set_updated_at();
