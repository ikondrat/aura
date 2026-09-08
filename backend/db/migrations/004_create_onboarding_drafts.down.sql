DROP TRIGGER IF EXISTS onboarding_drafts_set_updated_at ON onboarding_drafts;
DROP TABLE IF EXISTS onboarding_drafts;
DROP FUNCTION IF EXISTS aura_text_array_has_no_blank(text[]);
