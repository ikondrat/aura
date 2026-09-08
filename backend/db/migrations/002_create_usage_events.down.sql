DROP TRIGGER IF EXISTS usage_events_immutable ON usage_events;
DROP TRIGGER IF EXISTS usage_events_validate_agent ON usage_events;
DROP FUNCTION IF EXISTS aura_usage_events_are_immutable();
DROP FUNCTION IF EXISTS aura_validate_usage_event_agent();
DROP TABLE IF EXISTS usage_events;
